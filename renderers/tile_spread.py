#!/usr/bin/env python3
"""把多张图平铺展开成透明叠加件。

卡片互不强制叠加，可带一张铺满画布的背景，按顺序一张一张出现。
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageOps

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from stack_cards import (
    card_progress,
    ease_out_quad,
    encode_outputs,
    paste_scaled,
    prepare_card,
    write_checkerboard,
)


CANVAS = (1080, 1920)
GAP = 22


def parse_positions(raw: str) -> list[dict]:
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    positions = []
    for item in data[:8]:
        if not isinstance(item, dict) or "x" not in item or "y" not in item:
            positions.append(None)
            continue
        try:
            positions.append({"x": int(item.get("x", 0)), "y": int(item.get("y", 0))})
        except (TypeError, ValueError):
            positions.append(None)
    return positions


def grid_shape(count: int) -> tuple[int, int]:
    if count == 6:
        return 3, 2
    if count == 8:
        return 4, 2
    return 2, 2


def default_positions(count: int, card_width: int, origin_y: int, heights: list[int]) -> list[dict]:
    cols, _rows = grid_shape(count)
    grid_w = cols * card_width + (cols - 1) * GAP
    origin_x = max(24, (CANVAS[0] - grid_w) // 2)
    cell_h = max(heights) if heights else int(round(card_width * 16 / 9))
    positions = []
    for index in range(count):
        col = index % cols
        row = index // cols
        positions.append(
            {
                "x": origin_x + col * (card_width + GAP),
                "y": origin_y + row * (cell_h + GAP),
            }
        )
    return positions


def place_background(
    path: Path,
    size: tuple[int, int] = CANVAS,
    scale_pct: float = 100,
    offset_x: int = 0,
    offset_y: int = 0,
) -> Image.Image:
    src = ImageOps.exif_transpose(Image.open(path)).convert("RGBA")
    width, height = size
    cover = max(width / src.width, height / src.height)
    scale = cover * max(0.5, min(2.5, float(scale_pct) / 100.0))
    resized = src.resize(
        (max(1, int(round(src.width * scale))), max(1, int(round(src.height * scale)))),
        Image.Resampling.LANCZOS,
    )
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    x = int(round((width - resized.width) / 2 + offset_x))
    y = int(round((height - resized.height) / 2 + offset_y))
    src_x = max(0, -x)
    src_y = max(0, -y)
    dst_x = max(0, x)
    dst_y = max(0, y)
    copy_w = min(resized.width - src_x, width - dst_x)
    copy_h = min(resized.height - src_y, height - dst_y)
    if copy_w > 0 and copy_h > 0:
        piece = resized.crop((src_x, src_y, src_x + copy_w, src_y + copy_h))
        canvas.alpha_composite(piece, (dst_x, dst_y))
    return canvas


def render_frame(
    t: float,
    cards: list[dict],
    background: Image.Image | None,
    anim_duration: float,
) -> Image.Image:
    canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    if background is not None:
        canvas.alpha_composite(background)
    for card in cards:
        progress = card_progress(t, card["start"], anim_duration)
        if progress <= 0:
            continue
        opacity = ease_out_quad(min(1.0, progress / 0.85)) if progress < 0.85 else 1.0
        scale = 0.92 + 0.08 * progress
        dy = (1.0 - progress) * 18
        paste_scaled(
            canvas,
            card["sprite"],
            card["x"],
            card["y"] + dy,
            scale,
            opacity,
        )
    return canvas


def parse_args() -> argparse.Namespace:
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="生成平铺展开的透明叠加件")
    parser.add_argument("--images", nargs="+", required=True)
    parser.add_argument("--background", type=Path)
    parser.add_argument("--out", type=Path, default=here / "output")
    parser.add_argument("--stem", default="overlay")
    parser.add_argument("--card-count", type=int, default=4)
    parser.add_argument("--card-width", type=int, default=280)
    parser.add_argument("--radius", type=int, default=18)
    parser.add_argument("--origin-y", type=int, default=220)
    parser.add_argument("--stagger", type=float, default=0.28)
    parser.add_argument("--anim", type=float, default=0.36)
    parser.add_argument("--hold", type=float, default=1.8)
    parser.add_argument("--bg-scale", type=float, default=100)
    parser.add_argument("--bg-x", type=int, default=0)
    parser.add_argument("--bg-y", type=int, default=0)
    parser.add_argument("--positions", default="[]")
    parser.add_argument(
        "--keep-original",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument("--formats", default="preview,webm")
    parser.add_argument("--skip-keyframes", action="store_true")
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument(
        "--landscape",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="横版 16:9 输出（1920×1080）；默认竖版 9:16",
    )
    return parser.parse_args()


def main() -> None:
    global CANVAS
    args = parse_args()
    if args.landscape:
        CANVAS = (CANVAS[1], CANVAS[0])
    paths = [Path(item).expanduser().resolve() for item in args.images]
    missing = [str(path) for path in paths if not path.exists()]
    if missing:
        raise SystemExit("找不到图片: " + ", ".join(missing))
    count = max(1, min(8, int(args.card_count or len(paths))))
    paths = paths[:count]
    if not paths:
        raise SystemExit("至少需要 1 张图")

    prepared = [
        prepare_card(
            path,
            args.card_width,
            top=0,
            aspect=0,
            radius=args.radius,
            keep_original=args.keep_original,
        )
        for path in paths
    ]
    heights = [item[4] for item in prepared]
    defaults = default_positions(len(paths), args.card_width, args.origin_y, heights)
    custom = parse_positions(args.positions)
    cards = []
    for index, (sprite, pad_x, pad_y, _width, _height) in enumerate(prepared):
        pos = custom[index] if index < len(custom) and custom[index] else defaults[index]
        cards.append(
            {
                "sprite": sprite,
                "x": pos["x"] - pad_x,
                "y": pos["y"] - pad_y,
                "start": index * args.stagger,
            }
        )

    background = None
    if args.background:
        bg_path = args.background.expanduser().resolve()
        if not bg_path.exists():
            raise SystemExit(f"找不到背景: {bg_path}")
        background = place_background(
            bg_path,
            CANVAS,
            args.bg_scale,
            args.bg_x,
            args.bg_y,
        )

    duration = cards[-1]["start"] + args.anim + args.hold
    total_frames = int(round(duration * args.fps))
    wanted = {item.strip() for item in str(args.formats).split(",") if item.strip()}
    args.out.mkdir(parents=True, exist_ok=True)
    print(f"平铺 {len(paths)} 张 | {CANVAS[0]}x{CANVAS[1]} | {total_frames} 帧 | {duration:.2f}s")

    frame_root = Path(tempfile.mkdtemp(prefix="tile-frames-"))
    try:
        if not args.skip_keyframes:
            preview_dir = args.out / "keyframes"
            preview_dir.mkdir(parents=True, exist_ok=True)
            checker = write_checkerboard(CANVAS)
            for t in [0.01, cards[-1]["start"] + args.anim, duration - 0.01]:
                frame = render_frame(t, cards, background, args.anim)
                frame.save(preview_dir / f"t{t:05.2f}_alpha.png")
                composed = checker.copy()
                composed.paste(frame, (0, 0), frame)
                composed.save(preview_dir / f"t{t:05.2f}_preview.jpg", quality=90)
        for index in range(total_frames):
            t = index / args.fps
            frame = render_frame(t, cards, background, args.anim)
            frame.save(frame_root / f"frame_{index + 1:04d}.png", compress_level=1)
        outputs = encode_outputs(
            frame_root,
            args.fps,
            args.out,
            args.stem,
            duration,
            CANVAS,
            wanted,
        )
    finally:
        shutil.rmtree(frame_root, ignore_errors=True)

    print("完成：")
    for kind, path in outputs.items():
        print(f"  {kind}: {path}  ({path.stat().st_size / 1024 / 1024:.1f} MB)")


if __name__ == "__main__":
    main()
