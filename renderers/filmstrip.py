#!/usr/bin/env python3
"""胶片横滚：一排截图像胶片一样匀速滚过画面，适合当不抢戏的背景层。

导出透明 webm / mov。卡片在画布两侧渐隐渐现，循环无缝。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from overlay_fx import add_common_args, apply_orientation, pick_paths, render_all, report
from stack_cards import paste_scaled, prepare_card


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="生成胶片横滚透明叠加件")
    add_common_args(parser)
    parser.add_argument("--card-count", type=int, default=8)
    parser.add_argument("--card-width", type=int, default=320)
    parser.add_argument("--radius", type=int, default=16)
    parser.add_argument("--speed", type=float, default=240.0, help="滚动速度，像素/秒")
    parser.add_argument("--direction", type=int, default=-1, choices=(-1, 1), help="-1 向左滚")
    parser.add_argument("--strip-y", type=int, default=640, help="横带中心高度")
    parser.add_argument("--gap", type=int, default=40)
    parser.add_argument("--hold", type=float, default=3.0, help="总时长，秒")
    parser.add_argument("--fade-in", type=float, default=0.35)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    apply_orientation(args)
    args.out.mkdir(parents=True, exist_ok=True)
    n = max(4, int(args.card_count))
    paths = pick_paths(args, n)
    cards = []
    for index, path in enumerate(paths):
        sprite, pad_x, pad_y, cw, ch = prepare_card(
            path, args.card_width, args.top, args.aspect, args.radius,
            keep_original=args.keep_original,
        )
        cards.append({
            "sprite": sprite, "pad_x": pad_x, "pad_y": pad_y,
            "w": cw, "h": ch, "slot": index,
        })
    duration = max(0.8, args.hold)
    total_frames = int(round(duration * args.fps))
    print(f"胶片 {n} 张 | {args.width}x{args.height} | {total_frames} 帧 | {duration:.2f}s")
    slot_w = args.card_width + args.gap
    loop_w = n * slot_w
    if loop_w < args.width + slot_w:
        print(
            f"提示：{n} 张 × 间距 {slot_w}px = {loop_w}px，建议 ≥ 画布宽+间距（{args.width + slot_w}px），"
            "否则首尾衔接处会看到卡片跳变",
        )
    fade_zone = 140.0

    def render_frame(t: float):
        from PIL import Image

        canvas = Image.new("RGBA", (args.width, args.height), (0, 0, 0, 0))
        global_alpha = 1.0 if args.fade_in <= 0 else min(1.0, t / max(0.05, args.fade_in))
        for card in cards:
            raw = card["slot"] * slot_w + args.direction * args.speed * t
            x = (raw % loop_w + loop_w) % loop_w - args.card_width
            if x > args.width or x < -args.card_width - 1:
                continue
            y = args.strip_y - card["h"] / 2
            alpha = global_alpha
            edge = min((x + card["w"]) / fade_zone, (args.width - x) / fade_zone, 1.0)
            alpha *= max(0.0, min(1.0, edge))
            if alpha <= 0.01:
                continue
            paste_scaled(canvas, card["sprite"], x - card["pad_x"], y - card["pad_y"], 1.0, alpha)
        return canvas

    outputs = render_all(args, duration, render_frame)
    report(outputs)


if __name__ == "__main__":
    main()
