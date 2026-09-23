#!/usr/bin/env python3
"""Coverflow 涌流：中间正面、两边斜靠，隔几秒换一张顶到前面来。

滑动时侧面的卡片边滑边翻正。导出透明 webm / mov。
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
    card_quad,
    dim_sprite,
    paste_perspective,
    pick_paths,
    render_all,
    report,
)
from stack_cards import ease_out_cubic, prepare_card


def ease_out_quad(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return 1.0 - (1.0 - t) ** 2


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="生成 Coverflow 透明叠加件")
    add_common_args(parser)
    parser.add_argument("--card-count", type=int, default=6)
    parser.add_argument("--card-width", type=int, default=380)
    parser.add_argument("--radius", type=int, default=18)
    parser.add_argument("--gap", type=int, default=250, help="前卡与侧卡的水平距离")
    parser.add_argument("--tilt", type=float, default=42.0, help="侧卡旋转角，度")
    parser.add_argument("--step", type=float, default=1.6, help="切换间隔，秒")
    parser.add_argument("--anim", type=float, default=0.7, help="单次切换时长，秒")
    parser.add_argument("--hold", type=float, default=1.6)
    parser.add_argument("--center-y", type=int, default=660)
    return parser.parse_args()


def front_position(t: float, n: int, step: float, anim: float) -> float:
    """u(t)：连续的「前卡位置」。u=i 表示第 i 张在正前。"""
    slot = min(int(t // step), n - 1)
    into = t - slot * step
    if into >= anim or slot >= n - 1:
        return float(slot)
    return slot + ease_out_cubic(into / anim)


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
            "enter": index * 0.06,
        })
    duration = (n - 1) * args.step + args.anim + args.hold
    total_frames = int(round(duration * args.fps))
    print(f"Coverflow {n} 张 | {args.width}x{args.height} | {total_frames} 帧 | {duration:.2f}s")
    center_x = args.width / 2
    tilt_rad = math.radians(args.tilt)

    def state_of(d: float):
        """卡片相对前卡位置的偏移 d -> (x偏移, 旋转弧度, 缩放, 亮度, 透明度)。"""
        a = abs(d)
        s = 1.0 if d > 0 else -1.0
        if a < 1e-4:
            return 0.0, 0.0, 1.0, 1.0, 1.0
        off = s * args.gap * (a ** 0.85)
        rot = s * tilt_rad * min(1.0, a)
        scale = 1.0 - 0.24 * min(a, 2.4)
        bright = 1.0 - 0.38 * min(a, 2.0)
        alpha = max(0.0, min(1.0, 2.6 - a))
        return off, rot, scale, bright, alpha

    def render_frame(t: float):
        from PIL import Image

        canvas = Image.new("RGBA", (args.width, args.height), (0, 0, 0, 0))
        u = front_position(t, n, args.step, args.anim)
        painted = []
        for index, card in enumerate(cards):
            enter = 0.0 if t <= card["enter"] else min(1.0, (t - card["enter"]) / 0.3)
            alpha_in = ease_out_quad(enter)
            if alpha_in <= 0.01:
                continue
            off, rot, scale, bright, alpha = state_of(index - u)
            alpha *= alpha_in
            if alpha <= 0.01:
                continue
            half_w = card["half_w"] * scale
            half_h = card["half_h"] * scale
            quad, _depth = card_quad(
                rot, 0.0, (center_x + off, args.center_y), half_w, half_h, PERSPECTIVE
            )
            sprite = card["sprite"] if bright > 0.99 else dim_sprite(card["sprite"], 1.0 - bright)
            painted.append((abs(index - u), quad, sprite, alpha))
        painted.sort(key=lambda item: -item[0])  # 偏离前卡越远越先画
        for _a, quad, sprite, alpha in painted:
            if alpha < 0.999:
                mask = sprite.split()[-1].point(lambda p: int(p * alpha))
                sprite = sprite.copy()
                sprite.putalpha(mask)
            paste_perspective(canvas, sprite, quad)
        return canvas

    outputs = render_all(args, duration, render_frame)
    report(outputs)


if __name__ == "__main__":
    main()
