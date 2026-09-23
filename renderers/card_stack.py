#!/usr/bin/env python3
"""牌堆滑走：一摞卡压在一起，最上面那张甩走，露出下一张，循环往复。

导出透明 webm / mov，适合「一个接一个的证据」：订单、私信、粉丝数连着来。
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


def ease_in_quad(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return t * t


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="生成牌堆滑走透明叠加件")
    add_common_args(parser)
    parser.add_argument("--card-count", type=int, default=5)
    parser.add_argument("--card-width", type=int, default=420)
    parser.add_argument("--radius", type=int, default=18)
    parser.add_argument("--interval", type=float, default=1.1, help="每张间隔，秒")
    parser.add_argument("--anim", type=float, default=0.5, help="甩出时长，秒")
    parser.add_argument("--throw-rot", type=float, default=16.0, help="甩出时附加旋转，度")
    parser.add_argument("--spread", type=int, default=14, help="堆叠时相邻错位，像素")
    parser.add_argument("--center-y", type=int, default=720)
    parser.add_argument("--hold", type=float, default=1.6)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    apply_orientation(args)
    args.out.mkdir(parents=True, exist_ok=True)
    n = max(3, int(args.card_count))
    paths = pick_paths(args, n)
    lead = 0.35
    cards = []
    for index, path in enumerate(paths):
        sprite, pad_x, pad_y, cw, ch = prepare_card(
            path, args.card_width, args.top, args.aspect, args.radius,
            keep_original=args.keep_original,
        )
        base_rot = (((index * 37) % 9) - 4) * 1.6  # 每张一点固定小角度，像随手放的
        cards.append({
            "sprite": sprite, "pad_x": pad_x, "pad_y": pad_y,
            "w": cw, "h": ch, "base_rot": base_rot,
            "throw_at": lead + index * args.interval if index < n - 1 else None,
        })
    duration = lead + (n - 1) * args.interval + args.anim + args.hold
    total_frames = int(round(duration * args.fps))
    print(f"牌堆 {n} 张 | {args.width}x{args.height} | {total_frames} 帧 | {duration:.2f}s")
    center_x = args.width / 2

    def render_frame(t: float):
        from PIL import Image

        canvas = Image.new("RGBA", (args.width, args.height), (0, 0, 0, 0))
        thrown = 0.0
        for card in cards:
            if card["throw_at"] is None:
                continue
            thrown += max(0.0, min(1.0, (t - card["throw_at"]) / args.anim))
        painted = []
        for index, card in enumerate(cards):
            slot = index - thrown  # 0 = 堆顶
            if slot <= -0.999:
                continue
            scale = 1.0 - 0.045 * max(0.0, slot)
            x = center_x - card["w"] / 2
            y = args.center_y - card["h"] / 2 + max(0.0, slot) * args.spread
            rot = card["base_rot"]
            alpha = 1.0
            if slot < 0:
                f = -slot  # 甩出进度 0→1
                ease = ease_in_quad(f)
                x += ease * 190
                y -= ease * 430
                rot = card["base_rot"] + args.throw_rot * ease
                alpha = 1.0 - ease_in_quad(f)
                if alpha <= 0.01:
                    continue
            painted.append((slot, x, y, rot, scale, alpha, card))
        painted.sort(key=lambda item: -item[0])  # 堆底的先画
        for slot, x, y, rot, scale, alpha, card in painted:
            sprite = card["sprite"]
            if abs(rot) > 0.05:
                sprite = sprite.rotate(rot, resample=Image.BICUBIC, expand=True)
                grow_w = sprite.width - card["sprite"].width
                grow_h = sprite.height - card["sprite"].height
                x -= grow_w / 2
                y -= grow_h / 2
            paste_scaled(canvas, sprite, x, y, scale, alpha)
        return canvas

    outputs = render_all(args, duration, render_frame)
    report(outputs)


if __name__ == "__main__":
    main()
