"""Overlay component catalog.

Add a new overlay type here, then add matching preview/drag behavior in
static/overlay-components.js. Do not clone overlays.html for each effect.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from common import clamp_number


def camel_to_flag(key: str) -> str:
    return "--" + re.sub(r"([A-Z])", r"-\1", key).lower()


def _as_list(raw):
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return []
    return raw if isinstance(raw, list) else []


def sanitize_positions(raw) -> list[dict]:
    positions = []
    for item in _as_list(raw)[:8]:
        if not isinstance(item, dict) or "x" not in item or "y" not in item:
            positions.append({})
            continue
        positions.append(
            {
                "x": clamp_number(item.get("x"), 0, 1040, 80, True),
                "y": clamp_number(item.get("y"), 0, 1840, 200, True),
            }
        )
    return positions


def sanitize_focuses(raw) -> list[dict]:
    focuses = []
    for item in _as_list(raw)[:14]:
        if not isinstance(item, dict) or ("x" not in item and "y" not in item):
            focuses.append({})
            continue
        focuses.append(
            {
                "x": clamp_number(item.get("x"), 0, 100, 50, False),
                "y": clamp_number(item.get("y"), 0, 100, 50, False),
            }
        )
    return focuses


@dataclass(frozen=True)
class ParamSpec:
    key: str
    label: str
    minimum: float = 0
    maximum: float = 0
    default: float | bool | list | int = 0
    step: float = 1
    unit: str = ""
    integer: bool = False
    knob: bool = True
    cli: bool = True
    kind: str = "number"
    choices: tuple = ()
    labels: tuple = ()


@dataclass(frozen=True)
class OverlayComponent:
    id: str
    title: str
    hint: str
    default_title: str
    slot_count: int
    min_images: int
    script_name: str
    params: tuple[ParamSpec, ...]
    has_background: bool = False
    has_music: bool = False
    count_key: str | None = None

    def defaults(self) -> dict:
        return {item.key: item.default for item in self.params}

    def sanitize(self, raw) -> dict:
        source = raw if isinstance(raw, dict) else {}
        values = {}
        for item in self.params:
            if item.kind == "bool":
                if item.key in source:
                    values[item.key] = bool(source.get(item.key))
                else:
                    values[item.key] = bool(item.default)
                continue
            if item.kind == "json":
                values[item.key] = sanitize_positions(source.get(item.key, item.default) or [])
                continue
            if item.kind == "focus":
                values[item.key] = sanitize_focuses(source.get(item.key, item.default) or [])
                continue
            if item.kind == "choice":
                try:
                    number = int(float(source.get(item.key, item.default)))
                except (TypeError, ValueError):
                    number = int(item.default)
                values[item.key] = number if number in item.choices else int(item.default)
                continue
            values[item.key] = clamp_number(
                source.get(item.key),
                item.minimum,
                item.maximum,
                item.default,
                integer=item.integer,
            )
        return values

    def active_slot_count(self, params: dict | None = None) -> int:
        values = self.sanitize(params or {})
        if self.count_key and self.count_key in values:
            return int(values[self.count_key])
        return self.slot_count

    def knobs(self) -> list[dict]:
        knobs = []
        for item in self.params:
            if not item.knob:
                continue
            knobs.append(
                {
                    "key": item.key,
                    "label": item.label,
                    "min": item.minimum,
                    "max": item.maximum,
                    "step": item.step,
                    "unit": item.unit,
                    "kind": item.kind,
                    "choices": list(item.choices),
                    "labels": list(item.labels),
                }
            )
        return knobs

    def public(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "hint": self.hint,
            "defaultTitle": self.default_title,
            "slotCount": self.slot_count,
            "minImages": self.min_images,
            "hasBackground": self.has_background,
            "hasMusic": self.has_music,
            "countKey": self.count_key,
            "defaults": self.defaults(),
            "knobs": self.knobs(),
        }

    def render_args(self, params: dict, formats: list[str]) -> list[str]:
        args: list[str] = []
        values = self.sanitize(params)
        for item in self.params:
            if not item.cli:
                continue
            flag = camel_to_flag(item.key)
            if item.kind == "bool":
                args.append(flag if values[item.key] else f"--no-{flag[2:]}")
                continue
            if item.kind in {"json", "focus"}:
                args.extend([flag, json.dumps(values[item.key], ensure_ascii=False)])
                continue
            args.extend([flag, str(values[item.key])])
        args.extend(["--formats", ",".join(formats), "--skip-keyframes"])
        return args


CASCADE_STACK = OverlayComponent(
    id="cascade_stack",
    title="斜向叠卡",
    hint="默认保留原图比例，不裁切。拖第 1 张改位置，参数里的卡片宽度只负责等比缩放",
    default_title="未命名叠卡",
    slot_count=4,
    min_images=2,
    script_name="stack_cards.py",
    params=(
        ParamSpec("landscape", "横版 16:9", 0, 1, 0, 1, "", True, kind="bool"),
        ParamSpec("cardWidth", "卡片宽度", 160, 900, 440, 4, "px", True),
        ParamSpec("radius", "圆角", 0, 48, 0, 1, "px", True),
        ParamSpec("dx", "水平错位", 0, 180, 42, 1, "px", True),
        ParamSpec("dy", "垂直错位", 0, 220, 52, 1, "px", True),
        ParamSpec("originX", "起点 X", 0, 600, 0, 1, "px", True, knob=False),
        ParamSpec("originY", "起点 Y", 24, 700, 96, 1, "px", True, knob=False),
        ParamSpec("stagger", "出现间隔", 0.08, 1.2, 0.32, 0.02, "s"),
        ParamSpec("anim", "单张入场", 0.12, 1.2, 0.40, 0.02, "s"),
        ParamSpec("hold", "定格", 0.4, 6.0, 1.8, 0.1, "s"),
        ParamSpec("top", "裁顶", 0, 240, 0, 1, "px", True, knob=False),
        ParamSpec("aspect", "宽高比", 0, 0.95, 0, 0.01, "", knob=False),
        ParamSpec("keepOriginal", "原图比例", default=True, knob=False, kind="bool"),
        ParamSpec("fps", "帧率", 24, 30, 30, 1, "", True, knob=False, cli=False),
    ),
)

TILE_SPREAD = OverlayComponent(
    id="tile_spread",
    title="平铺展开",
    hint="图片默认保留原图比例。背景会铺满画布并允许裁切，卡片宽度只负责等比缩放",
    default_title="未命名平铺",
    slot_count=8,
    min_images=1,
    script_name="tile_spread.py",
    has_background=True,
    count_key="cardCount",
    params=(
        ParamSpec("landscape", "横版 16:9", 0, 1, 0, 1, "", True, kind="bool"),
        ParamSpec("cardCount", "张数", 4, 8, 4, 2, "张", True, kind="choice", choices=(4, 6, 8)),
        ParamSpec("bgScale", "背景缩放", 50, 250, 100, 1, "%", True),
        ParamSpec("bgX", "背景左右", -1200, 1200, 0, 1, "px", True, knob=False),
        ParamSpec("bgY", "背景上下", -1600, 1600, 0, 1, "px", True, knob=False),
        ParamSpec("cardWidth", "卡片宽度", 140, 480, 280, 4, "px", True),
        ParamSpec("radius", "圆角", 0, 48, 18, 1, "px", True),
        ParamSpec("originY", "网格起点", 80, 700, 220, 1, "px", True, knob=False),
        ParamSpec("stagger", "出现间隔", 0.08, 1.2, 0.28, 0.02, "s"),
        ParamSpec("anim", "单张入场", 0.12, 1.2, 0.36, 0.02, "s"),
        ParamSpec("hold", "定格", 0.4, 6.0, 1.8, 0.1, "s"),
        ParamSpec("positions", "位置", default=(), knob=False, kind="json"),
        ParamSpec("keepOriginal", "原图比例", default=True, knob=False, kind="bool"),
        ParamSpec("fps", "帧率", 24, 30, 30, 1, "", True, knob=False, cli=False),
    ),
)

RAPID_MONTAGE = OverlayComponent(
    id="rapid_montage",
    title="快切蒙太奇",
    hint="前两张慢、后面加快。点一张作刹车定格，入场带水平水波纹。切镜音不是每张都打。",
    default_title="未命名快切",
    slot_count=14,
    min_images=1,
    script_name="rapid_montage.py",
    has_music=True,
    count_key="cardCount",
    params=(
        ParamSpec("landscape", "横版 16:9", 0, 1, 0, 1, "", True, kind="bool"),
        ParamSpec("cardCount", "张数", 1, 14, 13, 1, "张", True),
        ParamSpec("hold", "前两张停留", 0.06, 1.0, 0.20, 0.02, "s"),
        ParamSpec("rush", "后面停留", 0.06, 1.0, 0.13, 0.01, "s"),
        ParamSpec("landSlot", "刹车定格", 0, 14, 0, 1, "张", True),
        ParamSpec("landHold", "定格时长", 0.3, 6.0, 1.2, 0.1, "s"),
        ParamSpec("landAnim", "水波纹入场", 0.0, 0.8, 0.28, 0.02, "s"),
        ParamSpec("ripple", "水波纹", 0, 48, 18, 1, "px", True),
        ParamSpec("hitVolume", "切镜音", 0, 100, 35, 1, "%", True),
        ParamSpec("musicVolume", "配乐音量", 0, 100, 40, 1, "%", True),
        ParamSpec("focuses", "取景", default=(), knob=False, kind="focus"),
        ParamSpec("keepOriginal", "原图比例", default=True, knob=False, kind="bool"),
        ParamSpec("fps", "帧率", 24, 30, 30, 1, "", True, knob=False, cli=False),
    ),
)

RING_CAROUSEL = OverlayComponent(
    id="ring_carousel",
    title="3D 旋转木马",
    hint="一圈截图绕竖直轴持续公转，正面最大最清楚，背面自动压暗。拖动卡片调整高度",
    default_title="未命名旋转木马",
    slot_count=8,
    min_images=3,
    script_name="ring_carousel.py",
    count_key="cardCount",
    params=(
        ParamSpec("landscape", "横版 16:9", 0, 1, 0, 1, "", True, kind="bool"),
        ParamSpec("cardCount", "张数", 3, 8, 6, 1, "张", True),
        ParamSpec("cardWidth", "卡片宽度", 240, 560, 360, 4, "px", True),
        ParamSpec("radius", "圆角", 0, 48, 18, 1, "px", True),
        ParamSpec("ringRadius", "圈半径", 280, 680, 440, 4, "px", True),
        ParamSpec("spinSpeed", "转速", 6, 90, 30, 1, "°/s", True),
        ParamSpec("centerY", "中心高度", 360, 1200, 660, 1, "px", True, knob=False),
        ParamSpec("stagger", "出现间隔", 0.04, 0.5, 0.14, 0.02, "s"),
        ParamSpec("anim", "单张入场", 0.1, 0.9, 0.40, 0.02, "s"),
        ParamSpec("hold", "定格", 0.5, 5.0, 2.4, 0.1, "s"),
        ParamSpec("backDim", "背面压暗", 0, 90, 62, 1, "%", True),
        ParamSpec("keepOriginal", "原图比例", default=True, knob=False, kind="bool"),
        ParamSpec("fps", "帧率", 24, 30, 30, 1, "", True, knob=False, cli=False),
    ),
)

COVERFLOW = OverlayComponent(
    id="coverflow",
    title="Coverflow 涌流",
    hint="中间正面、两边斜靠，隔几秒换一张顶到前面。拖动卡片改间距和高度",
    default_title="未命名涌流",
    slot_count=8,
    min_images=3,
    script_name="coverflow.py",
    count_key="cardCount",
    params=(
        ParamSpec("landscape", "横版 16:9", 0, 1, 0, 1, "", True, kind="bool"),
        ParamSpec("cardCount", "张数", 3, 8, 6, 1, "张", True),
        ParamSpec("cardWidth", "卡片宽度", 260, 520, 380, 4, "px", True),
        ParamSpec("radius", "圆角", 0, 48, 18, 1, "px", True),
        ParamSpec("gap", "前后间距", 140, 420, 250, 2, "px", True),
        ParamSpec("tilt", "侧卡角度", 10, 70, 42, 1, "°", True),
        ParamSpec("step", "切换间隔", 0.6, 3.0, 1.6, 0.05, "s"),
        ParamSpec("anim", "切换时长", 0.25, 1.2, 0.7, 0.02, "s"),
        ParamSpec("hold", "定格", 0.5, 5.0, 1.6, 0.1, "s"),
        ParamSpec("centerY", "中心高度", 360, 1200, 660, 1, "px", True, knob=False),
        ParamSpec("keepOriginal", "原图比例", default=True, knob=False, kind="bool"),
        ParamSpec("fps", "帧率", 24, 30, 30, 1, "", True, knob=False, cli=False),
    ),
)

CARD_STACK = OverlayComponent(
    id="card_stack",
    title="牌堆滑走",
    hint="一摞卡压在一起，最上面那张甩走露出下一张。拖动卡片调整高度",
    default_title="未命名牌堆",
    slot_count=8,
    min_images=3,
    script_name="card_stack.py",
    count_key="cardCount",
    params=(
        ParamSpec("landscape", "横版 16:9", 0, 1, 0, 1, "", True, kind="bool"),
        ParamSpec("cardCount", "张数", 3, 8, 5, 1, "张", True),
        ParamSpec("cardWidth", "卡片宽度", 300, 560, 420, 4, "px", True),
        ParamSpec("radius", "圆角", 0, 48, 18, 1, "px", True),
        ParamSpec("interval", "每张间隔", 0.5, 2.5, 1.1, 0.05, "s"),
        ParamSpec("anim", "甩出时长", 0.25, 1.0, 0.5, 0.02, "s"),
        ParamSpec("throwRot", "甩出旋转", 0, 40, 16, 1, "°", True),
        ParamSpec("spread", "堆叠错位", 0, 44, 14, 1, "px", True),
        ParamSpec("centerY", "中心高度", 480, 1200, 720, 1, "px", True, knob=False),
        ParamSpec("hold", "定格", 0.5, 5.0, 1.6, 0.1, "s"),
        ParamSpec("keepOriginal", "原图比例", default=True, knob=False, kind="bool"),
        ParamSpec("fps", "帧率", 24, 30, 30, 1, "", True, knob=False, cli=False),
    ),
)

FILMSTRIP = OverlayComponent(
    id="filmstrip",
    title="胶片横滚",
    hint="一排截图匀速滚过画面，两侧渐隐渐现，适合当不抢戏的背景层。拖动调高度",
    default_title="未命名胶片",
    slot_count=12,
    min_images=4,
    script_name="filmstrip.py",
    count_key="cardCount",
    params=(
        ParamSpec("landscape", "横版 16:9", 0, 1, 0, 1, "", True, kind="bool"),
        ParamSpec("cardCount", "张数", 4, 12, 8, 1, "张", True),
        ParamSpec("cardWidth", "卡片宽度", 200, 480, 320, 4, "px", True),
        ParamSpec("radius", "圆角", 0, 48, 16, 1, "px", True),
        ParamSpec("speed", "速度", 60, 600, 240, 10, "px/s", True),
        ParamSpec("direction", "方向", -1, 1, -1, 2, "", True, kind="choice", choices=(-1, 1), labels=("向左", "向右")),
        ParamSpec("stripY", "横带高度", 300, 1300, 640, 1, "px", True, knob=False),
        ParamSpec("gap", "间距", 12, 90, 40, 1, "px", True),
        ParamSpec("hold", "总时长", 0.8, 6.0, 3.0, 0.1, "s"),
        ParamSpec("fadeIn", "淡入", 0.1, 1.0, 0.35, 0.05, "s"),
        ParamSpec("keepOriginal", "原图比例", default=True, knob=False, kind="bool"),
        ParamSpec("fps", "帧率", 24, 30, 30, 1, "", True, knob=False, cli=False),
    ),
)

FAN_SPREAD = OverlayComponent(
    id="fan_spread",
    title="扇形展开",
    hint="一摞图从中间扇开、停一下、再收回。拖动卡片调整高度",
    default_title="未命名扇形",
    slot_count=7,
    min_images=3,
    script_name="fan_spread.py",
    count_key="cardCount",
    params=(
        ParamSpec("landscape", "横版 16:9", 0, 1, 0, 1, "", True, kind="bool"),
        ParamSpec("cardCount", "张数", 3, 7, 5, 1, "张", True),
        ParamSpec("cardWidth", "卡片宽度", 300, 560, 420, 4, "px", True),
        ParamSpec("radius", "圆角", 0, 48, 18, 1, "px", True),
        ParamSpec("fanAngle", "总展开角", 30, 150, 96, 2, "°", True),
        ParamSpec("arm", "轴臂长度", 220, 700, 430, 4, "px", True),
        ParamSpec("anim", "展开时长", 0.3, 1.5, 0.7, 0.02, "s"),
        ParamSpec("hold", "停留", 0.3, 4.0, 1.4, 0.1, "s"),
        ParamSpec("fold", "收回时长", 0.3, 1.5, 0.6, 0.02, "s"),
        ParamSpec("centerY", "中心高度", 480, 1200, 780, 1, "px", True, knob=False),
        ParamSpec("keepOriginal", "原图比例", default=True, knob=False, kind="bool"),
        ParamSpec("fps", "帧率", 24, 30, 30, 1, "", True, knob=False, cli=False),
    ),
)

CARD_WALL = OverlayComponent(
    id="card_wall",
    title="斜漂卡片墙",
    hint="截图铺成倾斜照片墙并匀速漂移，可整体压暗当文字背景墙。拖动改倾斜角",
    default_title="未命名卡片墙",
    slot_count=16,
    min_images=3,
    script_name="card_wall.py",
    count_key="cardCount",
    params=(
        ParamSpec("landscape", "横版 16:9", 0, 1, 0, 1, "", True, kind="bool"),
        ParamSpec("cardCount", "张数", 4, 16, 12, 1, "张", True),
        ParamSpec("cardWidth", "卡片宽度", 160, 480, 300, 4, "px", True),
        ParamSpec("radius", "圆角", 0, 48, 16, 1, "px", True),
        ParamSpec("gap", "间隙", 6, 60, 14, 1, "px", True),
        ParamSpec("angle", "倾斜角", 0, 30, 8, 1, "°", True),
        ParamSpec("speed", "漂移速度", 0, 400, 75, 5, "px/s", True),
        ParamSpec("direction", "方向", -1, 1, -1, 2, "", True, kind="choice", choices=(-1, 1), labels=("向左下", "向右上")),
        ParamSpec("cardMode", "卡片比例", 0, 2, 1, 1, "", True, kind="choice", choices=(0, 1, 2), labels=("原图", "3:4", "16:9")),
        ParamSpec("scrim", "压暗", 0, 90, 55, 1, "%", True),
        ParamSpec("hold", "总时长", 0.8, 8.0, 4.0, 0.1, "s"),
        ParamSpec("keepOriginal", "原图比例", default=True, knob=False, kind="bool"),
        ParamSpec("fps", "帧率", 24, 30, 30, 1, "", True, knob=False, cli=False),
    ),
)

COMPONENTS = {
    CASCADE_STACK.id: CASCADE_STACK,
    TILE_SPREAD.id: TILE_SPREAD,
    RAPID_MONTAGE.id: RAPID_MONTAGE,
    RING_CAROUSEL.id: RING_CAROUSEL,
    COVERFLOW.id: COVERFLOW,
    CARD_STACK.id: CARD_STACK,
    FILMSTRIP.id: FILMSTRIP,
    FAN_SPREAD.id: FAN_SPREAD,
    CARD_WALL.id: CARD_WALL,
}
DEFAULT_COMPONENT_ID = CASCADE_STACK.id


def get_component(component_id: str | None) -> OverlayComponent:
    return COMPONENTS.get(str(component_id or ""), CASCADE_STACK)


def public_catalog() -> list[dict]:
    return [item.public() for item in COMPONENTS.values()]
