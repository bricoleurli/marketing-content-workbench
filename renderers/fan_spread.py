#!/usr/bin/env python3
"""扇形展开：一摞图从中间扇开、停一下、再收回，像手牌摊开。

比斜向叠卡更「展示」，散开时每张都看得见。导出透明 webm / mov。
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from overlay_fx import add_common_args, apply_orientation, pick_paths, render_all, report
from stack_cards import paste_scaled, prepare_card


def ease_in_out_cubic(t: float) -> float:
    t = max(0.0, min(1.0, t))
    if t < 0.5:
        return 4 * t * t * t
    return 1 - (-2 * t + 2) ** 3 / 2


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="生成扇形展开透明叠加件")
    add_common_args(parser)
    parser.add_argument("--card-count", type=int, default=5)
    parser.add_argument("--card-width", type=int, default=420)
    parser.add_argument("--radius", type=int, default=18)
    parser.add_argument("--fan-angle", type=float, default=96.0, help="总展开角，度")
    parser.add_argument("--arm", type=int, default=430, help="轴心到卡片中心的距离，像素")
    parser.add_argument("--anim", type=float, default=0.7, help="展开时长，秒")
    parser.add_argument("--hold", type=float, default=1.4, help="展开停留，秒")
    parser.add_argument("--fold", type=float, default=0.6, help="收回时长，秒")
    parser.add_argument("--center-y", type=int, default=780, help="展开中心高度")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    apply_orientation(args)
    args.out.mkdir(parents=True, exist_ok=True)
    n = max(3, int(args.card_count))
    paths = pick_paths(args, n)
    cards = []
    for index, path in enumerate(paths):
        sprite, pad_x, pad_y, cw, ch = prepare_card(
            path, args.card_width, args.top, args.aspect, args.radius,
            keep_original=args.keep_original,
        )
        cards.append({
            "sprite": sprite, "pad_x": pad_x, "pad_y": pad_y,
            "w": cw, "h": ch,
            "spread": (index - (n - 1) / 2) * (args.fan_angle / max(1, n - 1)),
        })
    duration = args.anim + args.hold + args.fold
    total_frames = int(round(duration * args.fps))
    print(f"扇形 {n} 张 | {args.width}x{args.height} | {total_frames} 帧 | {duration:.2f}s")
    center_x = args.width / 2

    def open_amount(t: float) -> float:
        if t <= 0:
            return 0.0
        if t < args.anim:
            return 1 - (1 - t / args.anim) ** 3
        if t < args.anim + args.hold:
            return 1.0
        return 1.0 - ease_in_out_cubic((t - args.anim - args.hold) / max(0.05, args.fold))

    def render_frame(t: float):
        from PIL import Image

        canvas = Image.new("RGBA", (args.width, args.height), (0, 0, 0, 0))
        amount = open_amount(t)
        if amount <= 0.001:
            return canvas
        pivot_y = args.center_y + args.arm
        painted = []
        for index, card in enumerate(cards):
            angle = math.radians(card["spread"] * amount)
            # 屏幕坐标 y 向下，正角顺时针；卡片中心绕轴心转
            cx = center_x + args.arm * math.sin(angle)
            cy = args.center_y + args.arm * (1 - math.cos(angle))
            pil_angle = -card["spread"] * amount  # PIL 的正角是逆时针
            sprite = card["sprite"]
            x = cx - card["w"] / 2 - card["pad_x"]
            y = cy - card["h"] / 2 - card["pad_y"]
            if abs(pil_angle) > 0.05:
                rotated = card["sprite"].rotate(
                    pil_angle, resample=Image.BICUBIC, expand=True
                )
                x -= (rotated.width - card["sprite"].width) / 2
                y -= (rotated.height - card["sprite"].height) / 2
                sprite = rotated
            depth = abs(index - (n - 1) / 2)  # 中间的卡最上层
            painted.append((depth, x, y, sprite))
        painted.sort(key=lambda item: -item[0])  # 外侧先画
        for _depth, x, y, sprite in painted:
            paste_scaled(canvas, sprite, x, y, 1.0, 1.0)
        return canvas

    outputs = render_all(args, duration, render_frame)
    report(outputs)


if __name__ == "__main__":
    main()
