#!/usr/bin/env python3
"""全屏快切蒙太奇叠加件。

1～14 张图按设定时长硬切，再突然停在指定的一张上。
可混入切镜音效和背景音乐。预览 mp4 带声音，透明 webm 保持无声方便再盖一层。
"""

from __future__ import annotations

import argparse
import json
import math
import random
import shutil
import struct
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

from PIL import Image, ImageFilter, ImageOps

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from stack_cards import encode_outputs, write_checkerboard

CANVAS = (1080, 1920)
AUDIO_RATE = 44100
AUDIO_EXTS = {".mp3", ".m4a", ".wav", ".aac", ".ogg"}


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def parse_focuses(raw) -> list[dict]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return []
    if not isinstance(raw, list):
        return []
    return [item if isinstance(item, dict) else {} for item in raw]


def focus_value(focus: dict | None, key: str) -> float:
    if not isinstance(focus, dict):
        return 50.0
    try:
        return clamp(float(focus.get(key, 50)), 0.0, 100.0)
    except (TypeError, ValueError):
        return 50.0


def cover_canvas(path: Path, size: tuple[int, int] = CANVAS, focus: dict | None = None) -> Image.Image:
    src = ImageOps.exif_transpose(Image.open(path)).convert("RGBA")
    width, height = size
    scale = max(width / src.width, height / src.height)
    resized = src.resize(
        (max(1, int(round(src.width * scale))), max(1, int(round(src.height * scale)))),
        Image.Resampling.LANCZOS,
    )
    overflow_x = max(0, resized.width - width)
    overflow_y = max(0, resized.height - height)
    left = int(round(overflow_x * focus_value(focus, "x") / 100.0))
    top = int(round(overflow_y * focus_value(focus, "y") / 100.0))
    left = max(0, min(overflow_x, left))
    top = max(0, min(overflow_y, top))
    return resized.crop((left, top, left + width, top + height))


def ease_out_cubic(t: float) -> float:
    t = clamp(t, 0.0, 1.0)
    return 1.0 - (1.0 - t) ** 3


def ease_out_quad(t: float) -> float:
    t = clamp(t, 0.0, 1.0)
    return 1.0 - (1.0 - t) ** 2


def hold_for_cut(index: int, hold: float, rush: float) -> float:
    if index <= 2:
        return hold
    return min(hold, rush)


def paste_scaled_center(canvas: Image.Image, sprite: Image.Image, scale: float) -> None:
    if abs(scale - 1.0) <= 0.001:
        canvas.alpha_composite(sprite, (0, 0))
        return
    width = max(1, int(round(sprite.width * scale)))
    height = max(1, int(round(sprite.height * scale)))
    resized = sprite.resize((width, height), Image.Resampling.BILINEAR)
    x = (canvas.width - width) // 2
    y = (canvas.height - height) // 2
    src_x = max(0, -x)
    src_y = max(0, -y)
    dst_x = max(0, x)
    dst_y = max(0, y)
    copy_w = min(resized.width - src_x, canvas.width - dst_x)
    copy_h = min(resized.height - src_y, canvas.height - dst_y)
    if copy_w <= 0 or copy_h <= 0:
        return
    piece = resized.crop((src_x, src_y, src_x + copy_w, src_y + copy_h))
    canvas.alpha_composite(piece, (dst_x, dst_y))


def plan_events(
    count: int,
    hold: float,
    rush: float,
    land_slot: int,
    land_hold: float,
) -> list[dict]:
    land = count if land_slot <= 0 or land_slot > count else land_slot
    events: list[dict] = []
    t = 0.0
    cut_index = 0
    for index in range(1, count + 1):
        if index == land:
            continue
        cut_index += 1
        duration = hold_for_cut(cut_index, hold, rush)
        events.append(
            {
                "index": index,
                "start": t,
                "end": t + duration,
                "kind": "cut",
                "cutIndex": cut_index,
            }
        )
        t += duration
    events.append({"index": land, "start": t, "end": t + land_hold, "kind": "land", "cutIndex": 0})
    return events


def event_at(events: list[dict], t: float) -> dict:
    if t >= events[-1]["end"]:
        return events[-1]
    for event in events:
        if event["start"] <= t < event["end"]:
            return event
    return events[0]


def ripple_displace(progress: float, width: int, y: int, height: int, amplitude: float) -> int:
    wave = math.sin((y / max(1, height)) * math.pi * 3.2 + progress * 4.8)
    envelope = math.sin(clamp(progress, 0.0, 1.0) * math.pi)
    return int(round(wave * amplitude * envelope))


def apply_ripple(sprite: Image.Image, progress: float, amplitude: float) -> Image.Image:
    if progress >= 0.999 or amplitude <= 0.5:
        return sprite
    src = sprite.convert("RGBA")
    width, height = src.size
    dst = Image.new("RGBA", src.size, (0, 0, 0, 0))
    band = 2
    for y in range(0, height, band):
        shift = ripple_displace(progress, width, y, height, amplitude)
        strip_h = min(band, height - y)
        strip = src.crop((0, y, width, y + strip_h))
        dst.paste(strip, (shift, y))
        if shift > 0:
            edge = src.crop((0, y, 1, y + strip_h)).resize((shift, strip_h))
            dst.paste(edge, (0, y))
        elif shift < 0:
            fill = -shift
            edge = src.crop((width - 1, y, width, y + strip_h)).resize((fill, strip_h))
            dst.paste(edge, (width - fill, y))
    return dst


def render_frame(
    t: float,
    events: list[dict],
    sprites: dict[int, Image.Image],
    land_anim: float,
    ripple_amp: float,
) -> Image.Image:
    canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    event = event_at(events, t)
    sprite = sprites[event["index"]]
    if event["kind"] == "land" and land_anim > 0:
        local = t - event["start"]
        progress = ease_out_quad(local / land_anim)
        if local < land_anim:
            amplitude = ripple_amp * (1.0 - progress)
            rippled = apply_ripple(sprite, progress, amplitude)
            blurred = rippled.filter(ImageFilter.GaussianBlur(radius=max(0.0, 1.6 * (1.0 - progress))))
            paste_scaled_center(canvas, blurred, 1.0)
            return canvas
    paste_scaled_center(canvas, sprite, 1.0)
    return canvas


def add_burst(
    left: list[float],
    right: list[float],
    start: float,
    rate: int,
    duration: float,
    gain: float,
    thump: bool,
) -> None:
    n = len(left)
    begin = int(start * rate)
    length = int(duration * rate)
    rng = random.Random(int(start * 1000) + 17)
    for i in range(length):
        index = begin + i
        if index >= n or index < 0:
            break
        fade = math.exp(-5.5 * i / max(1, length))
        noise = (rng.random() * 2.0 - 1.0) * 0.55
        if thump:
            tone = math.sin(2 * math.pi * 68 * (i / rate)) * 0.7
            sample = (noise * 0.35 + tone) * fade * gain
        else:
            sample = noise * fade * gain
        left[index] = max(-1.0, min(1.0, left[index] + sample))
        right[index] = max(-1.0, min(1.0, right[index] + sample * 0.92))


def decode_music(path: Path, duration: float, dest: Path) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(path),
            "-ac",
            "2",
            "-ar",
            str(AUDIO_RATE),
            "-t",
            f"{duration:.3f}",
            "-f",
            "s16le",
            str(dest),
        ],
        check=True,
        capture_output=True,
    )


def read_pcm16_stereo(path: Path) -> tuple[list[float], list[float]]:
    payload = path.read_bytes()
    count = len(payload) // 4
    left: list[float] = []
    right: list[float] = []
    for index in range(count):
        l_raw, r_raw = struct.unpack_from("<hh", payload, index * 4)
        left.append(l_raw / 32768.0)
        right.append(r_raw / 32768.0)
    return left, right


def write_wav(path: Path, left: list[float], right: list[float]) -> None:
    with wave.open(str(path), "wb") as out:
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(AUDIO_RATE)
        frames = bytearray()
        for l_val, r_val in zip(left, right):
            frames += struct.pack(
                "<hh",
                int(clamp(l_val, -1.0, 1.0) * 32767),
                int(clamp(r_val, -1.0, 1.0) * 32767),
            )
        out.writeframes(frames)


def build_audio(
    duration: float,
    events: list[dict],
    hit_volume: float,
    music_path: Path | None,
    music_volume: float,
    dest: Path,
) -> bool:
    n = int(round(duration * AUDIO_RATE))
    if n <= 0:
        return False
    left = [0.0] * n
    right = [0.0] * n
    has_sound = False
    if hit_volume > 0:
        has_sound = True
        gain = clamp(hit_volume / 100.0, 0.0, 1.0) * 0.42
        for event in events:
            if event["kind"] == "cut":
                add_burst(left, right, event["start"], AUDIO_RATE, 0.046, gain * 0.62, False)
            else:
                add_burst(left, right, event["start"], AUDIO_RATE, 0.11, gain, True)
    if music_path and music_path.exists() and music_volume > 0:
        has_sound = True
        raw = dest.with_name("music.pcm")
        try:
            decode_music(music_path, duration, raw)
            music_l, music_r = read_pcm16_stereo(raw)
            gain = clamp(music_volume / 100.0, 0.0, 1.0) * 0.55
            fade_from = max(0, n - int(0.35 * AUDIO_RATE))
            for i, (l_val, r_val) in enumerate(zip(music_l, music_r)):
                if i >= n:
                    break
                fade = 1.0 if i < fade_from else 1.0 - (i - fade_from) / max(1, n - fade_from)
                left[i] = max(-1.0, min(1.0, left[i] + l_val * gain * fade))
                right[i] = max(-1.0, min(1.0, right[i] + r_val * gain * fade))
        finally:
            raw.unlink(missing_ok=True)
    if not has_sound:
        return False
    write_wav(dest, left, right)
    return True


def encode_preview_with_audio(
    frame_dir: Path,
    audio_path: Path,
    fps: int,
    duration: float,
    dest: Path,
) -> None:
    pattern = str(frame_dir / "frame_%04d.png")
    w, h = CANVAS
    duration_s = f"{duration:.3f}"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-framerate",
            str(fps),
            "-i",
            pattern,
            "-i",
            str(audio_path),
            "-f",
            "lavfi",
            "-i",
            f"color=c=0x111111:s={w}x{h}:d={duration_s}:r={fps}",
            "-filter_complex",
            "[2:v][0:v]overlay=format=auto:shortest=1,format=yuv420p[v]",
            "-map",
            "[v]",
            "-map",
            "1:a",
            "-c:v",
            "libx264",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-shortest",
            "-t",
            duration_s,
            "-movflags",
            "+faststart",
            str(dest),
        ],
        check=True,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="生成全屏快切蒙太奇叠加件")
    parser.add_argument("--images", nargs="+", required=True)
    parser.add_argument("--out", type=Path, default=HERE / "output")
    parser.add_argument("--stem", default="overlay")
    parser.add_argument("--card-count", type=int, default=0)
    parser.add_argument("--hold", type=float, default=0.20)
    parser.add_argument("--rush", type=float, default=0.13, help="第3张起的快切停留")
    parser.add_argument("--land-slot", type=int, default=0, help="刹车定格第几张，0=最后一张")
    parser.add_argument("--land-hold", type=float, default=1.2)
    parser.add_argument("--land-anim", type=float, default=0.28)
    parser.add_argument("--ripple", type=float, default=18, help="定格水波纹振幅")
    parser.add_argument("--hit-volume", type=float, default=35)
    parser.add_argument("--music-volume", type=float, default=40)
    parser.add_argument("--music", type=Path)
    parser.add_argument("--formats", default="preview,webm")
    parser.add_argument("--skip-keyframes", action="store_true")
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--focuses", default="[]")
    parser.add_argument(
        "--keep-original",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument(
        "--landscape",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="横版 16:9 输出（1920×1080）；默认竖版 9:16",
    )
    return parser.parse_args()


def collect_paths(args: argparse.Namespace) -> list[Path]:
    paths = [Path(item).expanduser().resolve() for item in args.images]
    missing = [str(path) for path in paths if not path.exists()]
    if missing:
        raise SystemExit("找不到图片: " + ", ".join(missing))
    count = int(args.card_count or len(paths))
    count = max(1, min(14, count, len(paths)))
    paths = paths[:count]
    if not paths:
        raise SystemExit("至少需要 1 张图")
    return paths


def main() -> None:
    global CANVAS
    args = parse_args()
    if args.landscape:
        CANVAS = (CANVAS[1], CANVAS[0])
    paths = collect_paths(args)
    hold = clamp(float(args.hold), 0.06, 1.2)
    rush = clamp(float(args.rush), 0.06, hold)
    land_hold = clamp(float(args.land_hold), 0.2, 8.0)
    land_anim = clamp(float(args.land_anim), 0.0, 0.8)
    ripple_amp = clamp(float(args.ripple), 0.0, 48.0)
    events = plan_events(len(paths), hold, rush, int(args.land_slot or 0), land_hold)
    duration = events[-1]["end"]
    fps = max(12, min(30, int(args.fps or 30)))
    total_frames = max(1, int(round(duration * fps)))
    focuses = parse_focuses(args.focuses)
    sprites = {
        index: cover_canvas(path, focus=focuses[index - 1] if index - 1 < len(focuses) else None)
        for index, path in enumerate(paths, start=1)
    }
    wanted = {item.strip() for item in str(args.formats).split(",") if item.strip()}
    args.out.mkdir(parents=True, exist_ok=True)
    print(
        f"快切 {len(paths)} 张 | 前两张 {hold:.2f}s / 后面 {rush:.2f}s | 刹车第 {events[-1]['index']} 张 {land_hold:.2f}s | {duration:.2f}s"
    )

    frame_root = Path(tempfile.mkdtemp(prefix="montage-frames-"))
    audio_path = frame_root / "mix.wav"
    try:
        if not args.skip_keyframes:
            preview_dir = args.out / "keyframes"
            preview_dir.mkdir(parents=True, exist_ok=True)
            checker = write_checkerboard(CANVAS)
            sample_times = [events[0]["start"] + 0.01]
            for event in events:
                sample_times.append(min(event["end"] - 0.01, event["start"] + max(0.05, hold / 2)))
            sample_times.append(max(0.0, duration - 0.01))
            seen: set[float] = set()
            for t in sample_times:
                key = round(t, 2)
                if key in seen:
                    continue
                seen.add(key)
                frame = render_frame(t, events, sprites, land_anim, ripple_amp)
                frame.save(preview_dir / f"t{key:05.2f}_alpha.png")
                composed = checker.copy()
                composed.paste(frame, (0, 0), frame)
                composed.save(preview_dir / f"t{key:05.2f}_preview.jpg", quality=90)

        for index in range(total_frames):
            t = index / fps
            frame = render_frame(t, events, sprites, land_anim, ripple_amp)
            frame.save(frame_root / f"frame_{index + 1:04d}.png", compress_level=1)

        video_wanted = set(wanted)
        has_audio = build_audio(
            duration,
            events,
            float(args.hit_volume),
            args.music.expanduser().resolve() if args.music else None,
            float(args.music_volume),
            audio_path,
        )
        if has_audio and "preview" in video_wanted:
            video_wanted.remove("preview")
        outputs: dict[str, Path] = {}
        if video_wanted:
            outputs = encode_outputs(
                frame_root,
                fps,
                args.out,
                args.stem,
                duration,
                CANVAS,
                video_wanted,
            )
        if has_audio and "preview" in wanted:
            preview = args.out / f"{args.stem}-preview.mp4"
            encode_preview_with_audio(frame_root, audio_path, fps, duration, preview)
            outputs["preview"] = preview
    finally:
        shutil.rmtree(frame_root, ignore_errors=True)

    print("完成：")
    for kind, path in outputs.items():
        print(f"  {kind}: {path}  ({path.stat().st_size / 1024 / 1024:.1f} MB)")


if __name__ == "__main__":
    main()
