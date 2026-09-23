#!/usr/bin/env python3
"""透视/3D 类叠加件共用的投影、贴图和参数工具。

新的叠加组件脚本从这里拿 3D 数学、透视贴图和公共命令行参数，
从 stack_cards 拿 prepare_card / encode_outputs / collect_images。
"""

from __future__ import annotations

import argparse
import math
import shutil
import tempfile
from pathlib import Path

from PIL import Image, ImageEnhance

# 预览端（overlay-components.js）用的同一套透视距离，保证两边观感一致
PERSPECTIVE = 2600.0


def find_coeffs(dst_points, src_points) -> list[float]:
    """解 PIL PERSPECTIVE 系数：把输出坐标 dst_points 映射到输入坐标 src_points。"""
    rows: list[list[float]] = []
    rhs: list[float] = []
    for (dx, dy), (sx, sy) in zip(dst_points, src_points):
        rows.append([dx, dy, 1, 0, 0, 0, -sx * dx, -sx * dy])
        rhs.append(sx)
        rows.append([0, 0, 0, dx, dy, 1, -sy * dx, -sy * dy])
        rhs.append(sy)
    size = 8
    m = [row[:] + [rhs[i]] for i, row in enumerate(rows)]
    for col in range(size):
        pivot = max(range(col, size), key=lambda r: abs(m[r][col]))
        if abs(m[pivot][col]) < 1e-10:
            raise ValueError("透视退化（卡片接近侧对观众）")
        m[col], m[pivot] = m[pivot], m[col]
        pivot_value = m[col][col]
        m[col] = [v / pivot_value for v in m[col]]
        for r in range(size):
            if r == col:
                continue
            factor = m[r][col]
            if factor:
                m[r] = [v - factor * w for v, w in zip(m[r], m[col])]
    return [m[i][8] for i in range(size)]


def paste_perspective(canvas: Image.Image, sprite: Image.Image, quad) -> None:
    """把带透明通道的 sprite 透视贴到 canvas 上的四边形 quad（TL,TR,BR,BL，画布坐标）。"""
    xs = [p[0] for p in quad]
    ys = [p[1] for p in quad]
    x0 = max(0, math.floor(min(xs)))
    y0 = max(0, math.floor(min(ys)))
    x1 = min(canvas.width, math.ceil(max(xs)))
    y1 = min(canvas.height, math.ceil(max(ys)))
    if x1 - x0 < 2 or y1 - y0 < 2:
        return
    w, h = sprite.size
    src_pts = [(0, 0), (w, 0), (w, h), (0, h)]
    dst_pts = [(qx - x0, qy - y0) for qx, qy in quad]
    try:
        coeffs = find_coeffs(dst_pts, src_pts)
    except ValueError:
        return
    piece = sprite.transform(
        (x1 - x0, y1 - y0), Image.PERSPECTIVE, coeffs, resample=Image.BILINEAR
    )
    canvas.alpha_composite(piece, (x0, y0))


def card_quad(
    theta: float,
    ring_radius: float,
    center: tuple[float, float],
    half_w: float,
    half_h: float,
    perspective: float = PERSPECTIVE,
):
    """竖直轴旋转的卡片四角投影。theta=0 是正前方，ring_radius 是卡片中心离轴距离。

    返回 (四角 TL,TR,BR,BL, 深度 z)。z 越大越靠近观众。
    """
    cx, cy = center
    sin_t, cos_t = math.sin(theta), math.cos(theta)

    def project(x: float, y: float, z: float) -> tuple[float, float]:
        k = perspective / (perspective - z)
        return (cx + x * k, cy + y * k)

    corners = []
    for lx, ly in ((-half_w, -half_h), (half_w, -half_h), (half_w, half_h), (-half_w, half_h)):
        world_x = ring_radius * sin_t + lx * cos_t
        world_z = ring_radius * cos_t - lx * sin_t
        corners.append(project(world_x, ly, world_z))
    return corners, ring_radius * cos_t


def angle_degrees(theta: float) -> float:
    """把弧度规范到 (-180, 180]。"""
    deg = math.degrees(theta) % 360
    if deg > 180:
        deg -= 360
    return deg


def backness(theta: float) -> float:
    """卡片转到背面的程度：0 = 正面朝前，1 = 完全背对。65° 开始渐变，150° 全暗。"""
    return max(0.0, min(1.0, (abs(angle_degrees(theta)) - 65.0) / 85.0))


def dim_sprite(sprite: Image.Image, darkness: float) -> Image.Image:
    """把 sprite 压暗（模拟背面遮罩），darkness 0~1。"""
    if darkness <= 0.01:
        return sprite
    darkness = min(darkness, 0.85)
    r, g, b, a = sprite.split()
    rgb = Image.merge("RGB", (r, g, b))
    rgb = ImageEnhance.Brightness(rgb).enhance(1.0 - darkness)
    return Image.merge("RGBA", (*rgb.split(), a))


def add_common_args(parser: argparse.ArgumentParser) -> None:
    here = Path(__file__).resolve().parent
    parser.add_argument("--images", nargs="+", help="按出现顺序传入图片路径")
    parser.add_argument("--input-dir", type=Path, default=here / "inputs")
    parser.add_argument("--out", type=Path, default=here / "output")
    parser.add_argument("--stem", default="overlay")
    parser.add_argument("--width", type=int, default=1080)
    parser.add_argument("--height", type=int, default=1920)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument(
        "--formats", default="webm,mov,webp,preview", help="逗号分隔：webm,mov,webp,preview"
    )
    parser.add_argument("--keep-frames", action="store_true")
    parser.add_argument("--skip-keyframes", action="store_true")
    parser.add_argument(
        "--landscape",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="横版 16:9 输出（1920×1080）；默认竖版 9:16（1080×1920）",
    )
    parser.add_argument(
        "--keep-original",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="按原图比例入卡，不裁切",
    )
    parser.add_argument("--top", type=int, default=0, help="非原图模式裁掉顶部的像素")
    parser.add_argument("--aspect", type=float, default=0, help="卡片宽/高；0 表示按原图比例")


def apply_orientation(args: argparse.Namespace) -> None:
    """按 --landscape 交换宽高：竖版 1080×1920，横版 1920×1080。"""
    if getattr(args, "landscape", False) and args.width < args.height:
        args.width, args.height = args.height, args.width


def render_all(args: argparse.Namespace, duration: float, render_frame) -> dict:
    """逐帧渲染并编码成四种导出格式，返回 {格式: 路径}。"""
    from stack_cards import encode_outputs

    total = int(round(duration * args.fps))
    wanted = {item.strip() for item in str(args.formats).split(",") if item.strip()}
    frame_root = Path(tempfile.mkdtemp(prefix="fx-frames-"))
    try:
        for i in range(total):
            t = i / args.fps
            frame = render_frame(t)
            frame.save(frame_root / f"frame_{i + 1:04d}.png", compress_level=1)
            if i == 0 or (i + 1) % 15 == 0 or i == total - 1:
                print(f"  渲染 {i + 1}/{total}")
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
        return outputs
    finally:
        shutil.rmtree(frame_root, ignore_errors=True)


def pick_paths(args: argparse.Namespace, count: int) -> list[Path]:
    from stack_cards import collect_images

    paths = collect_images(args)
    if count > len(paths):
        raise SystemExit(f"需要 {count} 张图，只拿到 {len(paths)} 张")
    return paths[:count]


def report(outputs: dict) -> None:
    print("完成：")
    for kind, path in outputs.items():
        print(f"  {kind}: {path}  ({path.stat().st_size / 1024 / 1024:.1f} MB)")
