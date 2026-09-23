#!/usr/bin/env python3
"""把多张截图叠成斜向堆积的透明叠加件。

默认：4 张图依次入场、先出现的不消失、背景透明。
导出 ProRes 4444 MOV、VP9 WebM、动画 WebP，方便盖到口播上。
"""

from __future__ import annotations

import argparse
import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageOps


def ease_out_cubic(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return 1.0 - (1.0 - t) ** 3


def ease_out_quad(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return 1.0 - (1.0 - t) ** 2


def round_corners(im: Image.Image, radius: int) -> Image.Image:
    im = im.convert("RGBA")
    if radius <= 0:
        return im
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, im.width, im.height), radius=radius, fill=255
    )
    out = im.copy()
    out.putalpha(mask)
    return out


def add_edge(im: Image.Image, radius: int, color=(255, 255, 255, 70), width=2) -> Image.Image:
    if radius <= 0:
        return im
    overlay = Image.new("RGBA", im.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    inset = max(0, width - 1)
    draw.rounded_rectangle(
        (inset, inset, im.width - 1 - inset, im.height - 1 - inset),
        radius=max(1, radius - inset),
        outline=color,
        width=width,
    )
    return Image.alpha_composite(im, overlay)


def add_shadow(
    card: Image.Image,
    blur: int = 18,
    offset: tuple[int, int] = (0, 10),
    opacity: int = 88,
) -> tuple[Image.Image, int, int]:
    pad_x = blur * 2 + abs(offset[0]) + 8
    pad_y = blur * 2 + abs(offset[1]) + 8
    canvas = Image.new(
        "RGBA",
        (card.width + pad_x * 2, card.height + pad_y * 2),
        (0, 0, 0, 0),
    )
    alpha = card.split()[-1].point(lambda p: int(p * opacity / 255))
    shadow_src = Image.new("RGBA", card.size, (0, 0, 0, 255))
    shadow_src.putalpha(alpha)
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    shadow.paste(shadow_src, (pad_x + offset[0], pad_y + offset[1]), shadow_src)
    shadow = shadow.filter(ImageFilter.GaussianBlur(blur))
    canvas.alpha_composite(shadow)
    canvas.alpha_composite(card, (pad_x, pad_y))
    return canvas, pad_x, pad_y


def crop_profile(im: Image.Image, top: int, aspect: float) -> Image.Image:
    im = ImageOps.exif_transpose(im).convert("RGB")
    w, h = im.size
    top = max(0, min(top, h - 8))
    crop_h = min(h - top, int(round(w / aspect)))
    return im.crop((0, top, w, top + crop_h))


def prepare_card(
    path: Path,
    width: int,
    top: int,
    aspect: float,
    radius: int,
    keep_original: bool = True,
) -> tuple[Image.Image, int, int, int, int]:
    src = ImageOps.exif_transpose(Image.open(path)).convert("RGBA")
    if keep_original:
        cropped = src
    else:
        cropped = crop_profile(src, top=top, aspect=aspect)
    ratio = width / cropped.width
    height = max(1, int(round(cropped.height * ratio)))
    resized = cropped.resize((width, height), Image.Resampling.LANCZOS).convert("RGBA")
    rounded = round_corners(resized, radius=radius)
    edged = add_edge(rounded, radius=max(0, radius))
    sprite, pad_x, pad_y = add_shadow(edged)
    return sprite, pad_x, pad_y, width, height


def apply_opacity(im: Image.Image, opacity: float) -> Image.Image:
    if opacity >= 0.999:
        return im
    if opacity <= 0:
        return Image.new("RGBA", im.size, (0, 0, 0, 0))
    out = im.copy()
    alpha = out.split()[-1].point(lambda p: int(p * opacity))
    out.putalpha(alpha)
    return out


def paste_scaled(
    canvas: Image.Image,
    sprite: Image.Image,
    x: float,
    y: float,
    scale: float,
    opacity: float,
) -> None:
    if opacity <= 0.01:
        return
    im = sprite
    if abs(scale - 1.0) > 0.001:
        nw = max(1, int(round(sprite.width * scale)))
        nh = max(1, int(round(sprite.height * scale)))
        im = sprite.resize((nw, nh), Image.Resampling.BILINEAR)
        cx = x + sprite.width / 2.0
        cy = y + sprite.height / 2.0
        x = cx - nw / 2.0
        y = cy - nh / 2.0
    im = apply_opacity(im, opacity)
    canvas.alpha_composite(im, (int(round(x)), int(round(y))))


def card_progress(t: float, start: float, duration: float) -> float:
    if t <= start:
        return 0.0
    return ease_out_cubic((t - start) / duration)


def render_frame(
    t: float,
    cards: list[dict],
    canvas_size: tuple[int, int],
    anim_duration: float,
) -> Image.Image:
    canvas = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
    for card in cards:
        p = card_progress(t, card["start"], anim_duration)
        if p <= 0:
            continue
        opacity = ease_out_quad(min(1.0, p / 0.85)) if p < 0.85 else 1.0
        scale = 0.90 + 0.10 * p
        dy = (1.0 - p) * 36
        paste_scaled(
            canvas,
            card["sprite"],
            card["x"],
            card["y"] + dy,
            scale,
            opacity,
        )
    return canvas


def write_checkerboard(size: tuple[int, int], cell: int = 24) -> Image.Image:
    w, h = size
    bg = Image.new("RGB", size, (38, 38, 38))
    draw = ImageDraw.Draw(bg)
    colors = ((38, 38, 38), (52, 52, 52))
    for y in range(0, h, cell):
        for x in range(0, w, cell):
            if ((x // cell) + (y // cell)) % 2 == 0:
                draw.rectangle((x, y, x + cell - 1, y + cell - 1), fill=colors[1])
    return bg


def run_ffmpeg(args: list[str]) -> None:
    print("ffmpeg:", " ".join(args[1:8]), "...")
    subprocess.run(args, check=True)


def encode_outputs(
    frame_dir: Path,
    fps: int,
    out_dir: Path,
    stem: str,
    duration: float,
    canvas_size: tuple[int, int],
    formats: set[str] | None = None,
) -> dict[str, Path]:
    pattern = str(frame_dir / "frame_%04d.png")
    outputs: dict[str, Path] = {}
    duration_s = f"{duration:.3f}"
    w, h = canvas_size
    wanted = formats or {"webm", "mov", "webp", "preview"}

    if "webm" in wanted:
        webm = out_dir / f"{stem}.webm"
        run_ffmpeg(
            [
                "ffmpeg",
                "-y",
                "-framerate",
                str(fps),
                "-i",
                pattern,
                "-c:v",
                "libvpx-vp9",
                "-pix_fmt",
                "yuva420p",
                "-b:v",
                "0",
                "-crf",
                "30",
                "-row-mt",
                "1",
                "-auto-alt-ref",
                "0",
                "-an",
                "-t",
                duration_s,
                str(webm),
            ]
        )
        outputs["webm"] = webm

    if "mov" in wanted:
        mov = out_dir / f"{stem}.mov"
        try:
            run_ffmpeg(
                [
                    "ffmpeg",
                    "-y",
                    "-framerate",
                    str(fps),
                    "-i",
                    pattern,
                    "-c:v",
                    "prores_ks",
                    "-profile:v",
                    "4444",
                    "-pix_fmt",
                    "yuva444p10le",
                    "-an",
                    "-t",
                    duration_s,
                    str(mov),
                ]
            )
            outputs["mov"] = mov
        except subprocess.CalledProcessError:
            qtrle = out_dir / f"{stem}-qtrle.mov"
            run_ffmpeg(
                [
                    "ffmpeg",
                    "-y",
                    "-framerate",
                    str(fps),
                    "-i",
                    pattern,
                    "-c:v",
                    "qtrle",
                    "-pix_fmt",
                    "argb",
                    "-an",
                    "-t",
                    duration_s,
                    str(qtrle),
                ]
            )
            outputs["mov"] = qtrle

    if "webp" in wanted:
        webp = out_dir / f"{stem}.webp"
        run_ffmpeg(
            [
                "ffmpeg",
                "-y",
                "-framerate",
                str(fps),
                "-i",
                pattern,
                "-c:v",
                "libwebp",
                "-lossless",
                "0",
                "-q:v",
                "80",
                "-compression_level",
                "4",
                "-loop",
                "0",
                "-an",
                "-t",
                duration_s,
                str(webp),
            ]
        )
        outputs["webp"] = webp

    if "preview" in wanted:
        preview = out_dir / f"{stem}-preview.mp4"
        run_ffmpeg(
            [
                "ffmpeg",
                "-y",
                "-framerate",
                str(fps),
                "-i",
                pattern,
                "-f",
                "lavfi",
                "-i",
                f"color=c=0x222222:s={w}x{h}:d={duration_s}:r={fps}",
                "-filter_complex",
                "[1:v][0:v]overlay=format=auto:shortest=1,format=yuv420p",
                "-c:v",
                "libx264",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-an",
                "-t",
                duration_s,
                "-movflags",
                "+faststart",
                str(preview),
            ]
        )
        outputs["preview"] = preview
    return outputs


def parse_args() -> argparse.Namespace:
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="生成斜向堆积的透明叠卡视频")
    parser.add_argument("--images", nargs="+", help="按出现顺序传入图片路径")
    parser.add_argument("--input-dir", type=Path, default=here / "inputs")
    parser.add_argument("--out", type=Path, default=here / "output")
    parser.add_argument("--stem", default="stacked_cards")
    parser.add_argument("--width", type=int, default=1080)
    parser.add_argument("--height", type=int, default=1920)
    parser.add_argument("--card-width", type=int, default=440)
    parser.add_argument("--top", type=int, default=0, help="裁掉顶部的像素；原图模式忽略")
    parser.add_argument("--aspect", type=float, default=0, help="卡片宽/高；0 表示按原图比例")
    parser.add_argument("--radius", type=int, default=0)
    parser.add_argument(
        "--keep-original",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="按原图比例入卡，不裁成 3:4",
    )
    parser.add_argument("--dx", type=int, default=42)
    parser.add_argument("--dy", type=int, default=52)
    parser.add_argument("--origin-x", type=int, default=0, help="0 表示水平居中")
    parser.add_argument("--origin-y", type=int, default=96)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--stagger", type=float, default=0.32)
    parser.add_argument("--anim", type=float, default=0.40)
    parser.add_argument("--hold", type=float, default=1.8)
    parser.add_argument(
        "--formats",
        default="webm,mov,webp,preview",
        help="逗号分隔：webm,mov,webp,preview",
    )
    parser.add_argument("--keep-frames", action="store_true")
    parser.add_argument("--skip-keyframes", action="store_true")
    parser.add_argument(
        "--landscape",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="横版 16:9 输出（1920×1080）；默认竖版 9:16",
    )
    return parser.parse_args()


def collect_images(args: argparse.Namespace) -> list[Path]:
    if args.images:
        paths = [Path(p).expanduser().resolve() for p in args.images]
    else:
        paths = sorted(
            p
            for p in args.input_dir.iterdir()
            if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
        )
    missing = [str(p) for p in paths if not p.exists()]
    if missing:
        raise SystemExit("找不到图片: " + ", ".join(missing))
    if len(paths) < 2:
        raise SystemExit("至少需要 2 张图")
    return paths


def layout_cards(args: argparse.Namespace, paths: list[Path]) -> list[dict]:
    n = len(paths)
    cards: list[dict] = []
    prepared = [
        prepare_card(
            path,
            args.card_width,
            args.top,
            args.aspect,
            args.radius,
            keep_original=args.keep_original,
        )
        for path in paths
    ]
    card_w = prepared[0][3]
    card_h = prepared[0][4]
    stack_w = card_w + args.dx * (n - 1)
    origin_x = args.origin_x or max(24, (args.width - stack_w) // 2)
    origin_y = args.origin_y
    for i, (sprite, pad_x, pad_y, cw, ch) in enumerate(prepared):
        cards.append(
            {
                "sprite": sprite,
                "pad_x": pad_x,
                "pad_y": pad_y,
                "card_w": cw,
                "card_h": ch,
                "x": origin_x + i * args.dx - pad_x,
                "y": origin_y + i * args.dy - pad_y,
                "start": i * args.stagger,
                "path": paths[i],
            }
        )
    last_bottom = origin_y + (n - 1) * args.dy + card_h
    if last_bottom > args.height - 40:
        print(
            f"警告：叠卡底部在 {last_bottom}px，画布高度 {args.height}px，可能被裁切",
            file=sys.stderr,
        )
    return cards


def save_keyframes(cards: list[dict], args: argparse.Namespace, out_dir: Path, duration: float) -> None:
    preview_dir = out_dir / "keyframes"
    preview_dir.mkdir(parents=True, exist_ok=True)
    checker = write_checkerboard((args.width, args.height))
    times = [0.01]
    for i, card in enumerate(cards):
        times.append(card["start"] + args.anim)
    times.append(duration - 0.01)
    seen = set()
    for t in times:
        key = round(t, 2)
        if key in seen:
            continue
        seen.add(key)
        frame = render_frame(t, cards, (args.width, args.height), args.anim)
        frame.save(preview_dir / f"t{key:05.2f}_alpha.png")
        composed = checker.copy()
        composed.paste(frame, (0, 0), frame)
        composed.save(preview_dir / f"t{key:05.2f}_preview.jpg", quality=90)


def main() -> None:
    args = parse_args()
    if args.landscape and args.width < args.height:
        args.width, args.height = args.height, args.width
    paths = collect_images(args)
    args.out.mkdir(parents=True, exist_ok=True)
    cards = layout_cards(args, paths)
    duration = cards[-1]["start"] + args.anim + args.hold
    total_frames = int(round(duration * args.fps))
    print(f"图片 {len(paths)} 张 | {args.width}x{args.height} | {total_frames} 帧 | {duration:.2f}s")
    if not args.skip_keyframes:
        save_keyframes(cards, args, args.out, duration)
    wanted = {item.strip() for item in str(args.formats).split(",") if item.strip()}

    frame_root = Path(tempfile.mkdtemp(prefix="stack-frames-"))
    try:
        for i in range(total_frames):
            t = i / args.fps
            frame = render_frame(t, cards, (args.width, args.height), args.anim)
            frame.save(frame_root / f"frame_{i + 1:04d}.png", compress_level=1)
            if i == 0 or (i + 1) % 15 == 0 or i == total_frames - 1:
                print(f"  渲染 {i + 1}/{total_frames}")
        outputs = encode_outputs(
            frame_root,
            args.fps,
            args.out,
            args.stem,
            duration,
            (args.width, args.height),
            wanted,
        )
        if args.keep_frames:
            dest = args.out / "frames"
            if dest.exists():
                shutil.rmtree(dest)
            shutil.copytree(frame_root, dest)
    finally:
        shutil.rmtree(frame_root, ignore_errors=True)

    print("完成：")
    for kind, path in outputs.items():
        print(f"  {kind}: {path}  ({path.stat().st_size / 1024 / 1024:.1f} MB)")


if __name__ == "__main__":
    main()
