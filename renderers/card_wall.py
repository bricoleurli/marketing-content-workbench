#!/usr/bin/env python3
"""斜漂卡片墙：截图铺成倾斜的照片墙，整面墙沿行方向匀速漂移，可整体压暗。

参考「缩略图墙」类片头：黑色底、圆角卡片、约 8° 斜向网格、无缝循环漂移，
适合垫在一句大字标语下面当背景墙。导出透明 webm / mov（压暗时缝隙为半透明黑）。
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
    add_common_args,
    apply_orientation,
    dim_sprite,
    render_all,
    report,
)
from stack_cards import paste_scaled, prepare_card
from PIL import Image

CARD_ASPECTS = {0: None, 1: 0.75, 2: 16 / 9}  # 原图 / 3:4 / 16:9（宽/高）


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="生成斜向漂移卡片墙透明叠加件")
    add_common_args(parser)
    parser.add_argument("--card-count", type=int, default=12)
    parser.add_argument("--card-width", type=int, default=300)
    parser.add_argument("--radius", type=int, default=16)
    parser.add_argument("--gap", type=int, default=14)
    parser.add_argument("--angle", type=float, default=8.0, help="网格倾斜角，度")
    parser.add_argument("--speed", type=float, default=75.0, help="漂移速度，像素/秒")
    parser.add_argument("--direction", type=int, default=-1, choices=(-1, 1), help="-1 向左下漂")
    parser.add_argument("--card-mode", type=int, default=1, choices=(0, 1, 2), help="0 原图 1 3:4 2 16:9")
    parser.add_argument("--scrim", type=float, default=55.0, help="整墙压暗百分比 0-90")
    parser.add_argument("--hold", type=float, default=4.0, help="总时长，秒")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    apply_orientation(args)
    args.out.mkdir(parents=True, exist_ok=True)
    from stack_cards import collect_images

    paths = collect_images(args)
    n = min(len(paths), max(3, int(args.card_count)))
    if n < 1:
        raise SystemExit("至少需要 1 张图")
    paths = paths[:n]

    aspect = CARD_ASPECTS.get(int(args.card_mode), 0.75)
    cards = []
    for index, path in enumerate(paths):
        if aspect is None:
            sprite, pad_x, pad_y, cw, ch = prepare_card(
                path, args.card_width, args.top, 0, args.radius, keep_original=True
            )
        else:
            sprite, pad_x, pad_y, cw, ch = prepare_card(
                path, args.card_width, args.top, aspect, args.radius, keep_original=False
            )
        cards.append({
            "sprite": sprite, "pad_x": pad_x, "pad_y": pad_y,
            "w": cw, "h": ch, "index": index,
        })

    card_w = max(card["w"] for card in cards)
    card_h = max(card["h"] for card in cards)
    cell_w = card_w + args.gap
    cell_h = card_h + args.gap

    theta = math.radians(max(0.0, min(30.0, args.angle)))
    ux, uy = math.cos(theta), -math.sin(theta)   # 行方向：右上加
    vx, vy = math.sin(theta), math.cos(theta)    # 列方向：右下
    extent_u = args.width * abs(ux) + args.height * abs(uy)
    extent_v = args.width * abs(vx) + args.height * abs(vy)
    cols_needed = int(math.ceil(extent_u / cell_w)) + 1
    # 回绕周期取 cycle 的整数倍：回绕瞬间每张卡都落在同图卡的格位上，画面无缝
    period_cols = n * int(math.ceil(max(n, cols_needed) / n))
    period_w = period_cols * cell_w
    rows_needed = int(math.ceil(extent_v / cell_h)) + 1

    duration = max(0.8, args.hold)
    total_frames = int(round(duration * args.fps))
    print(
        f"卡片墙 {n} 种 × 周期 {period_cols} 格 × {rows_needed} 行 | {args.width}x{args.height} | "
        f"{total_frames} 帧 | {duration:.2f}s"
    )

    scrim = max(0.0, min(90.0, args.scrim)) / 100.0
    scrim_alpha = int(round(255 * scrim))
    darkness = scrim * 0.85  # 卡片本身随压暗变暗，缝隙由半透明黑垫底
    base_cx = args.width / 2
    base_cy = args.height / 2
    row0 = -(rows_needed - 1) / 2

    # 预处理：压暗 + 旋转，每个 sprite 只做一次（PIL 正角 = 逆时针，行右端上翘）
    for card in cards:
        dimmed = dim_sprite(card["sprite"], darkness)
        card["rotated"] = dimmed.rotate(
            max(0.0, min(30.0, args.angle)), resample=Image.BICUBIC, expand=True
        )

    def render_frame(t: float):
        canvas = Image.new("RGBA", (args.width, args.height), (0, 0, 0, 0))
        if scrim_alpha > 0:
            canvas.alpha_composite(Image.new("RGBA", (args.width, args.height), (0, 0, 0, scrim_alpha)))
        for r in range(rows_needed):
            # 奇偶行反向漂移；奇数行错开半格
            dir_r = args.direction * (1 if r % 2 == 0 else -1)
            stagger = (cell_w / 2.0) if r % 2 else 0.0
            row_off = (row0 + r) * cell_h
            drift = dir_r * args.speed * t
            for c in range(period_cols):
                card = cards[c % n]  # 每行都从第 1 张开始循环
                u = (c * cell_w + stagger - drift) % period_w
                du = u - period_w / 2
                cx = base_cx + du * ux + row_off * vx
                cy = base_cy + du * uy + row_off * vy
                sprite = card["rotated"]
                x = cx - sprite.width / 2
                y = cy - sprite.height / 2
                if x > args.width or y > args.height or x + sprite.width < 0 or y + sprite.height < 0:
                    continue
                paste_scaled(canvas, sprite, x, y, 1.0, 1.0)
        return canvas

    outputs = render_all(args, duration, render_frame)
    report(outputs)


if __name__ == "__main__":
    main()
