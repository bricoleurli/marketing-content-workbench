#!/usr/bin/env python3
"""3D 旋转木马：多张截图围成一圈绕竖直轴持续公转。

转到正面的卡片最大最清楚，转到背面的自动压暗。
导出透明 webm / mov，适合盖在口播上当「立体相册」。
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from overlay_fx import (
    PERSPECTIVE,
    add_common_args,
    apply_orientation,
    backness,
    card_quad,
    dim_sprite,
    paste_perspective,
    pick_paths,
    render_all,
    report,
)
from stack_cards import prepare_card


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="生成 3D 旋转木马透明叠加件")
    add_common_args(parser)
    parser.add_argument("--card-count", type=int, default=6)
    parser.add_argument("--card-width", type=int, default=360)
    parser.add_argument("--radius", type=int, default=18)
    parser.add_argument("--ring-radius", type=int, default=440)
    parser.add_argument("--spin-speed", type=float, default=30.0, help="转速，度/秒")
    parser.add_argument("--center-y", type=int, default=660)
    parser.add_argument("--stagger", type=float, default=0.14)
    parser.add_argument("--anim", type=float, default=0.40)
    parser.add_argument("--hold", type=float, default=2.4)
    parser.add_argument("--back-dim", type=float, default=62.0, help="背面压暗百分比 0-90")
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
            "half_w": cw / 2 + pad_x, "half_h": ch / 2 + pad_y,
            "angle": index * 2 * math.pi / n,
            "start": index * args.stagger,
        })
    duration = (n - 1) * args.stagger + args.anim + args.hold
    total_frames = int(round(duration * args.fps))
    print(f"旋转木马 {n} 张 | {args.width}x{args.height} | {total_frames} 帧 | {duration:.2f}s")
    center = (args.width / 2, args.center_y)
    dim_frac = min(max(args.back_dim, 0), 90) / 100.0

    def render_frame(t: float):
        from PIL import Image

        canvas = Image.new("RGBA", (args.width, args.height), (0, 0, 0, 0))
        phi = math.radians(args.spin_speed * t)
        painted = []
        for card in cards:
            progress = 0.0 if t <= card["start"] else min(1.0, (t - card["start"]) / args.anim)
            alpha = min(1.0, progress / 0.8)
            if alpha <= 0.01:
                continue
            radius = args.ring_radius * (0.55 + 0.45 * progress)
            theta = card["angle"] - phi
            quad, depth = card_quad(
                theta, radius, center, card["half_w"], card["half_h"], PERSPECTIVE
            )
            sprite = dim_sprite(card["sprite"], 0.75 * dim_frac * backness(theta))
            painted.append((depth, quad, sprite, alpha))
        painted.sort(key=lambda item: item[0])
        for depth, quad, sprite, alpha in painted:
            if alpha < 0.999:
                mask_alpha = sprite.split()[-1].point(lambda p: int(p * alpha))
                sprite = sprite.copy()
                sprite.putalpha(mask_alpha)
            paste_perspective(canvas, sprite, quad)
        return canvas

    outputs = render_all(args, duration, render_frame)
    report(outputs)


if __name__ == "__main__":
    main()
