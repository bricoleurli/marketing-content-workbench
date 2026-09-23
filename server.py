#!/usr/bin/env python3
"""Small localhost-only Fish Audio TTS workbench."""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from common import read_json, safe_leaf, write_private_json
from overlay_components import DEFAULT_COMPONENT_ID, get_component, public_catalog
from overlay_store import OverlayStore, overlay_id_ok


APP_DIR = Path(__file__).resolve().parent
# Keep the public code repository free of private media. Deployments can point
# these directories at a persistent volume (for example /data on Render).
DATA_ROOT = Path(os.getenv("WORKBENCH_DATA_DIR", str(APP_DIR))).expanduser()
STATIC_DIR = APP_DIR / "static"
OUTPUT_DIR = DATA_ROOT / "outputs"
POSTER_DIR = DATA_ROOT / ".clip-posters"
EVENT_LIBRARY = Path(
    os.getenv(
        "WORKBENCH_EVENT_LIBRARY",
        str(DATA_ROOT / "event-library"),
    )
).expanduser()
OVERLAYS = OverlayStore(
    Path(
        os.getenv(
            "WORKBENCH_OVERLAYS_DIR",
            str(DATA_ROOT / "overlays"),
        )
    ).expanduser()
)
CONFIG_DIR = Path(os.getenv("WORKBENCH_CONFIG_DIR", str(DATA_ROOT / "config")))
SETTINGS_FILE = CONFIG_DIR / "settings.json"
HISTORY_FILE = CONFIG_DIR / "history.json"
API_URL = "https://api.fish.audio/v1/tts"
TTS_RETRY_DELAYS = (0.6, 1.2)
MAX_REQUEST_BYTES = 128 * 1024
MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_BATCH_IMAGES_BYTES = 80 * 1024 * 1024
FFPROBE = "ffprobe"
FFMPEG = "ffmpeg"
MAX_CLIP_MEDIA_BYTES = 1024 * 1024 * 1024

# Media indexes involve one ffprobe call per asset. Keep them warm while the
# user moves between workbench pages, and clear them before any write request.
DATA_CACHE_TTL = 60.0
_DATA_CACHE: dict[str, tuple[float, object]] = {}
_DATA_CACHE_LOCK = threading.Lock()


def clear_data_cache() -> None:
    with _DATA_CACHE_LOCK:
        _DATA_CACHE.clear()


def cached_data(key: str, builder):
    now = time.monotonic()
    with _DATA_CACHE_LOCK:
        cached = _DATA_CACHE.get(key)
        if cached and now - cached[0] < DATA_CACHE_TTL:
            return cached[1]

    value = builder()
    with _DATA_CACHE_LOCK:
        _DATA_CACHE[key] = (time.monotonic(), value)
    return value

EVENT_LABELS = {
    "expose-site": "网站曝光",
    "enter-workbench": "进入工作台",
    "template-pattern": "玩法/模板",
    "input-topic": "输入选题",
    "save-draft": "存入草稿箱",
    "multi-topic": "批量生成",
    "one-click-generate": "一键生成",
    "watch-progress": "等待生成",
    "review-generated-set-1": "生成结果展示1",
    "review-generated-set": "生成结果展示",
    "weekly-pack": "发布素材",
    "download-all": "一键下载全部图片",
    "copy-to-publish": "复制粘贴即可发布",
    "stacked-accounts": "账号叠卡",
    "open-history": "历史记录",
    "enter-studio": "进入自由创作",
    "upload-reverse": "从图片反推提示词",
    "open-drafts": "草稿箱",
    "browse-marketplace": "玩法商店",
    "play-showcase": "玩法展示",
    "result-proof": "结果证明",
    "model-china": "国内能用",
    "save-for-later": "先码住",
}

DEFAULT_VOICES = [
    {
        "name": "皇上",
        "id": "3c1e318f49144d96a8be1c6436ef8244",
        "description": "清晰、有活力的中文男声",
        "avatar": "https://public-platform.r2.fish.audio/coverimage/3c1e318f49144d96a8be1c6436ef8244",
        "builtin": True,
    },
    {
        "name": "猴哥",
        "id": "978fdc76881c4b6199faeb1c8b8cc0d7",
        "description": "短视频风格的中文角色声",
        "avatar": "https://public-platform.r2.fish.audio/coverimage/978fdc76881c4b6199faeb1c8b8cc0d7",
        "builtin": True,
    },
]


def load_settings() -> dict:
    settings = read_json(SETTINGS_FILE, {})
    voices = settings.get("voices")
    if not isinstance(voices, list) or not voices:
        voices = DEFAULT_VOICES
    return {"api_key": settings.get("api_key", ""), "voices": voices}


def get_api_key() -> str:
    return os.getenv("FISH_API_KEY", "").strip() or load_settings()["api_key"].strip()


def normalize_voice_id(raw_value: object) -> str:
    """Accept a Fish Audio ID, modelId query value, or public voice URL."""
    raw = str(raw_value or "").strip()
    if not raw:
        return ""
    if re.fullmatch(r"[A-Za-z0-9_-]{8,128}", raw):
        return raw

    parsed = urlparse(raw if "://" in raw else f"https://fish.audio/{raw.lstrip('/')}")
    query_id = parse_qs(parsed.query).get("modelId", [""])[0].strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{8,128}", query_id):
        return query_id

    path_parts = [part for part in parsed.path.split("/") if part]
    for index, part in enumerate(path_parts):
        if part == "m" and index + 1 < len(path_parts):
            candidate = path_parts[index + 1].strip()
            if re.fullmatch(r"[A-Za-z0-9_-]{8,128}", candidate):
                return candidate
    return ""


def sanitize_voices(raw_voices) -> list[dict]:
    if not isinstance(raw_voices, list):
        raise ValueError("音色列表格式不正确")
    voices: list[dict] = []
    seen: set[str] = set()
    for item in raw_voices[:30]:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).strip()[:40]
        voice_id = normalize_voice_id(item.get("id", ""))
        if not name or not voice_id:
            continue
        if voice_id in seen:
            continue
        seen.add(voice_id)
        voices.append(
            {
                "name": name,
                "id": voice_id,
                "description": str(item.get("description", "")).strip()[:80],
                "avatar": str(item.get("avatar", "")).strip()[:500],
                "builtin": bool(item.get("builtin", False)),
            }
        )
    if not voices:
        raise ValueError("至少保留一个有效音色")
    return voices


def recent_history() -> list[dict]:
    history = read_json(HISTORY_FILE, [])
    if not isinstance(history, list):
        return []
    return [item for item in history if (OUTPUT_DIR / item.get("file", "")).is_file()][
        :20
    ]


def record_history(item: dict) -> None:
    history = [item, *recent_history()]
    write_private_json(HISTORY_FILE, history[:20])


def read_event_title(event_dir: Path, event_id: str) -> str:
    if event_id in EVENT_LABELS:
        return EVENT_LABELS[event_id]
    note = event_dir / "event.md"
    try:
        first = note.read_text(encoding="utf-8").splitlines()[0].strip()
    except OSError:
        first = ""
    if first.startswith("#"):
        title = first.lstrip("#").strip()
        if "·" in title:
            title = title.split("·", 1)[1].strip()
        if title:
            return title
    return event_id


def read_event_description(event_dir: Path) -> str:
    """Return the short description below an event note heading."""
    note = event_dir / "event.md"
    try:
        lines = note.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    paragraphs: list[str] = []
    for line in lines[1:]:
        value = line.strip()
        if not value:
            if paragraphs:
                break
            continue
        if value.startswith("#"):
            continue
        paragraphs.append(value)
    return " ".join(paragraphs)[:180]


def clip_metadata_path(clip: Path) -> Path:
    return clip.with_suffix(".json")


def read_clip_metadata(clip: Path) -> dict:
    data = read_json(clip_metadata_path(clip), {})
    return data if isinstance(data, dict) else {}


def write_clip_metadata(clip: Path, payload: dict) -> dict:
    current = read_clip_metadata(clip)
    current.update(payload)
    current["updatedAt"] = datetime.now().isoformat(timespec="seconds")
    clip_metadata_path(clip).write_text(
        json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return current


def default_clip_title(clip: Path) -> str:
    return clip.stem.replace("_", " ").replace("-", " ").strip() or clip.stem


def probe_duration(path: Path) -> float | None:
    try:
        result = subprocess.run(
            [
                FFPROBE,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=nw=1:nk=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    try:
        return round(float(result.stdout.strip()), 2)
    except ValueError:
        return None


def probe_media_details(path: Path) -> dict:
    try:
        result = subprocess.run(
            [
                FFPROBE,
                "-v",
                "error",
                "-show_entries",
                "format=duration,format_name:stream=codec_type,width,height",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        data = json.loads(result.stdout or "{}")
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        raise ValueError("读取媒体信息失败") from exc
    duration = data.get("format", {}).get("duration")
    try:
        duration_value = round(float(duration), 3)
    except (TypeError, ValueError) as exc:
        raise ValueError("媒体文件没有可用时长") from exc
    video = next(
        (stream for stream in data.get("streams", []) if stream.get("codec_type") == "video"),
        None,
    )
    return {
        "duration": duration_value,
        "width": video.get("width") if video else None,
        "height": video.get("height") if video else None,
        "hasVideo": bool(video),
        "hasAudio": any(stream.get("codec_type") == "audio" for stream in data.get("streams", [])),
        "mimeType": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
    }


def list_event_clips() -> dict:
    events_root = EVENT_LIBRARY / "events"
    events: list[dict] = []
    if not events_root.is_dir():
        return {"library": str(EVENT_LIBRARY), "clipCount": 0, "events": []}
    for event_dir in sorted(events_root.iterdir()):
        if not event_dir.is_dir():
            continue
        event_title = read_event_title(event_dir, event_dir.name)
        shots = event_dir / "画面"
        clips: list[dict] = []
        if shots.is_dir():
            for clip_index, clip in enumerate(sorted(shots.glob("*.mp4")), start=1):
                metadata = read_clip_metadata(clip)
                source_type = str(metadata.get("sourceType") or "event-library")
                if clip.name.startswith("overlay-") and source_type == "event-library":
                    source_type = "overlay-template"
                fallback_title = default_clip_title(clip)
                generic_match = re.fullmatch(r"named[-_ ]?(\d+)", clip.stem, re.IGNORECASE)
                if generic_match:
                    fallback_title = f"{event_title} · 镜头 {int(generic_match.group(1))}"
                elif clip.name.startswith("overlay-"):
                    fallback_title = f"{event_title} · 叠加素材 {clip_index}"
                clips.append(
                    {
                        "file": clip.name,
                        "url": f"/clips/{event_dir.name}/{clip.name}",
                        "poster": f"/clips/{event_dir.name}/{clip.name}/poster",
                        "bytes": clip.stat().st_size,
                        "duration": probe_duration(clip),
                        "source": metadata.get("source") or clip.stem,
                        "title": metadata.get("title") or fallback_title,
                        "description": metadata.get("description") or "",
                        "tags": metadata.get("tags") if isinstance(metadata.get("tags"), list) else [],
                        "sourceType": source_type,
                        "sourceLabel": "叠加模板" if source_type == "overlay-template" else "事件素材",
                        "updatedAt": metadata.get("updatedAt") or datetime.fromtimestamp(clip.stat().st_mtime).isoformat(timespec="seconds"),
                        "groupId": event_dir.name,
                        "groupTitle": event_title,
                    }
                )
        events.append(
            {
                "id": event_dir.name,
                "title": event_title,
                "description": read_event_description(event_dir),
                "clipCount": len(clips),
                "clips": clips,
            }
        )
    return {
        "library": str(EVENT_LIBRARY),
        "clipCount": sum(item["clipCount"] for item in events),
        "events": events,
    }


def list_voiceovers() -> list[dict]:
    items: list[dict] = []
    voices_root = EVENT_LIBRARY / "voices"
    if voices_root.is_dir():
        for folder in sorted(voices_root.iterdir()):
            audio = folder / "voice.mp3"
            if not folder.is_dir() or not audio.is_file():
                continue
            voice_id = f"lib:{folder.name}"
            items.append(
                {
                    "id": voice_id,
                    "title": folder.name,
                    "url": f"/voice-files/lib/{folder.name}",
                    "duration": probe_duration(audio),
                    "source": "library",
                }
            )
    if OUTPUT_DIR.is_dir():
        for audio in sorted(OUTPUT_DIR.glob("*.mp3"), key=lambda path: path.stat().st_mtime, reverse=True):
            voice_id = f"out:{audio.name}"
            items.append(
                {
                    "id": voice_id,
                    "title": audio.stem,
                    "url": f"/voice-files/out/{audio.name}",
                    "duration": probe_duration(audio),
                    "source": "output",
                }
            )
    return items


def create_library_pack(items: object) -> dict:
    """Bundle selected local assets into a flat, import-friendly zip package."""
    if not isinstance(items, list) or not items:
        raise ValueError("请先选择要导出的素材")
    if len(items) > 80:
        raise ValueError("一次最多打包 80 条素材")

    clips = {
        (event["id"], clip["file"]): {**clip, "eventId": event["id"], "eventTitle": event["title"]}
        for event in list_event_clips()["events"]
        for clip in event.get("clips", [])
    }
    voices = {voice["id"]: voice for voice in list_voiceovers()}
    overlays = {instance["id"]: instance for instance in OVERLAYS.list_instances()}
    used_names: set[str] = set()
    manifest: list[dict] = []
    resolved: list[tuple[Path, str]] = []

    def archive_name(folder: str, title: str, suffix: str) -> str:
        stem = re.sub(r"[^A-Za-z0-9\u4e00-\u9fff._-]+", "-", str(title or "素材")).strip("-._") or "素材"
        candidate = f"{folder}/{stem}{suffix}"
        index = 2
        while candidate in used_names:
            candidate = f"{folder}/{stem}-{index}{suffix}"
            index += 1
        used_names.add(candidate)
        return candidate

    for raw in items:
        if not isinstance(raw, dict):
            continue
        kind = str(raw.get("type") or "").strip()
        if kind == "voice":
            voice_id = str(raw.get("id") or "").strip()
            voice = voices.get(voice_id)
            if not voice:
                continue
            source = resolve_voice(voice_id)
            target_name = archive_name("口播配音", voice["title"], source.suffix or ".mp3")
            manifest.append({"type": kind, "title": voice["title"], "file": target_name, "source": voice_id})
            resolved.append((source, target_name))
        elif kind == "clip":
            event_id = str(raw.get("eventId") or "").strip()
            filename = str(raw.get("file") or "").strip()
            clip = clips.get((event_id, filename))
            if not clip:
                continue
            source = resolve_clip(event_id, filename)
            target_name = archive_name(f"事件镜头/{clip['eventTitle']}", clip["title"], source.suffix or ".mp4")
            manifest.append({"type": kind, "title": clip["title"], "event": clip["eventTitle"], "file": target_name, "source": f"{event_id}/{filename}"})
            resolved.append((source, target_name))
        elif kind == "overlay":
            instance_id = str(raw.get("id") or "").strip()
            instance = overlays.get(instance_id)
            if not instance:
                continue
            output_kind = str(raw.get("output") or "preview")
            output = instance.get("outputs", {}).get(output_kind) or next(iter(instance.get("outputs", {}).values()), None)
            if not output:
                continue
            source = OVERLAYS.instance_dir(instance_id) / "output" / safe_leaf(str(output.get("file") or ""))
            if not source.is_file():
                continue
            target_name = archive_name("叠加模板", instance["title"], source.suffix or ".mp4")
            manifest.append({"type": kind, "title": instance["title"], "file": target_name, "source": instance_id})
            resolved.append((source, target_name))

    if not resolved:
        raise ValueError("选中的素材没有可导出的文件")
    filename = f"素材包-{datetime.now().strftime('%Y%m%d-%H%M%S')}.zip"
    target = OUTPUT_DIR / filename
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("素材清单.json", json.dumps({"createdAt": datetime.now().isoformat(timespec="seconds"), "items": manifest}, ensure_ascii=False, indent=2))
        for source, target_name in resolved:
            archive.write(source, target_name)
    return {"file": filename, "url": f"/outputs/{filename}", "bytes": target.stat().st_size, "count": len(resolved)}


def resolve_voice(voice_id: str) -> Path:
    kind, _, name = voice_id.partition(":")
    name = safe_leaf(name)
    if kind == "lib":
        target = EVENT_LIBRARY / "voices" / name / "voice.mp3"
    elif kind == "out":
        target = OUTPUT_DIR / name
    else:
        raise FileNotFoundError("找不到这条口播")
    if not target.is_file():
        raise FileNotFoundError("找不到这条口播")
    return target


def prune_history_file(filename: str) -> None:
    history = read_json(HISTORY_FILE, [])
    if not isinstance(history, list):
        return
    kept = [item for item in history if item.get("file") != filename]
    if kept != history:
        write_private_json(HISTORY_FILE, kept[:20])


def delete_voiceover(voice_id: str) -> dict:
    kind, _, name = voice_id.partition(":")
    name = safe_leaf(name)
    if kind == "out":
        target = OUTPUT_DIR / name
        if target.suffix.lower() != ".mp3" or not target.is_file():
            raise FileNotFoundError("找不到这条口播")
        target.unlink()
        prune_history_file(name)
    elif kind == "lib":
        folder = EVENT_LIBRARY / "voices" / name
        if not (folder / "voice.mp3").is_file():
            raise FileNotFoundError("找不到这条口播")
        shutil.rmtree(folder)
    else:
        raise ValueError("不支持删除这条口播")
    return {"voiceId": voice_id}


def event_choices() -> list[dict]:
    return [
        {"id": item["id"], "title": item["title"], "clipCount": item["clipCount"]}
        for item in list_event_clips()["events"]
    ]


def slug_event_id(title: str) -> str:
    ascii_part = re.sub(r"[^A-Za-z0-9]+", "-", title).strip("-").lower()
    if re.fullmatch(r"[a-z0-9-]{2,40}", ascii_part or ""):
        return ascii_part
    return datetime.now().strftime("ov-%Y%m%d-%H%M%S")


def append_event_catalog(event_id: str, title: str) -> None:
    catalog = EVENT_LIBRARY / "catalog.md"
    if not catalog.is_file():
        return
    text = catalog.read_text(encoding="utf-8")
    marker = f"| `{event_id}` |"
    if marker in text:
        return
    row = f"| `{event_id}` | {title} | 叠加模板导出的透明/预览镜头 | 不要拿不透明整屏截图冒充 | 2–5s |\n"
    needle = "## 复用规则"
    if needle in text:
        catalog.write_text(text.replace(needle, row + "\n" + needle, 1), encoding="utf-8")
        return
    catalog.write_text(text.rstrip() + "\n" + row, encoding="utf-8")


def publish_overlay_to_event(instance_id: str, event_id: str = "", title: str = "") -> dict:
    folder = OVERLAYS.require_folder(instance_id)
    data = OVERLAYS.public_instance(folder)
    preview = folder / "output" / "overlay-preview.mp4"
    if not preview.is_file():
        raise ValueError("请先导出模板，再加入事件镜头")
    existing = {item["id"]: item for item in event_choices()}
    created = False
    chosen_title = str(title or data["title"]).strip()[:40] or data["title"]
    chosen_id = str(event_id or "").strip()
    if chosen_id:
        chosen_id = safe_leaf(chosen_id)
        if not overlay_id_ok(chosen_id):
            raise ValueError("事件 ID 只能用字母、数字、中文和短横线")
        if chosen_id in existing:
            chosen_title = existing[chosen_id]["title"]
        else:
            created = True
    else:
        chosen_id = slug_event_id(chosen_title)
        if chosen_id in existing:
            chosen_id = datetime.now().strftime("ov-%Y%m%d-%H%M%S")
        created = True
    event_dir = EVENT_LIBRARY / "events" / chosen_id
    shots = event_dir / "画面"
    shots.mkdir(parents=True, exist_ok=True)
    note = event_dir / "event.md"
    if not note.is_file():
        note.write_text(
            f"# {chosen_id} · {chosen_title}\n\n"
            f"来源：叠加模板工作台「{data['title']}」。\n"
            "事件镜头货架里放的是预览 mp4，方便点开看；透明 webm 仍在叠加模板导出目录。\n",
            encoding="utf-8",
        )
    stamp = datetime.now().strftime("%H%M%S")
    dest_name = f"overlay-{folder.name}-{stamp}.mp4"
    dest = shots / dest_name
    shutil.copy2(preview, dest)
    write_clip_metadata(
        dest,
        {
            "title": data["title"],
            "source": instance_id,
            "sourceType": "overlay-template",
            "description": f"来自叠加模板「{data['title']}」的预览镜头。",
            "tags": ["叠加模板", data.get("componentTitle") or data.get("component")],
        },
    )
    if created:
        append_event_catalog(chosen_id, chosen_title)
    return {
        "eventId": chosen_id,
        "eventTitle": chosen_title,
        "file": dest_name,
        "created": created,
        "url": f"/clips/{chosen_id}/{dest_name}",
    }


def resolve_clip(event_id: str, filename: str) -> Path:
    event_id = safe_leaf(event_id)
    filename = safe_leaf(filename)
    if not filename.lower().endswith(".mp4"):
        raise FileNotFoundError("只提供 mp4 切片")
    target = EVENT_LIBRARY / "events" / event_id / "画面" / filename
    if not target.is_file():
        raise FileNotFoundError("找不到这个切片")
    return target


def create_event_group(title: str) -> dict:
    chosen_title = str(title or "").strip()[:40]
    if not chosen_title:
        raise ValueError("分组名称不能为空")
    events_root = EVENT_LIBRARY / "events"
    events_root.mkdir(parents=True, exist_ok=True)
    event_id = slug_event_id(chosen_title)
    if event_id in {item["id"] for item in list_event_clips()["events"]}:
        event_id = f"{event_id}-{datetime.now().strftime('%H%M%S')}"
    event_dir = events_root / safe_leaf(event_id)
    (event_dir / "画面").mkdir(parents=True, exist_ok=True)
    (event_dir / "event.md").write_text(
        f"# {event_id} · {chosen_title}\n\n"
        "这是一个可复用的事件镜头分组。\n",
        encoding="utf-8",
    )
    append_event_catalog(event_id, chosen_title)
    return {"id": event_id, "title": chosen_title, "clipCount": 0, "clips": [], "description": "这是一个可复用的事件镜头分组。"}


def import_event_clip(event_id: str, original_name: str, title: str, body) -> dict:
    """Store one Cap-exported mp4 in an existing local event group."""
    event_id = safe_leaf(event_id)
    original_name = safe_leaf(original_name)
    event_dir = EVENT_LIBRARY / "events" / event_id
    shots = event_dir / "画面"
    if not event_dir.is_dir() or not shots.is_dir():
        raise ValueError("请先选择一个已有的事件分组")
    suffix = Path(original_name).suffix.lower()
    if suffix != ".mp4":
        raise ValueError("Cap 导入目前只支持 mp4 视频")
    try:
        length = int(body.headers.get("Content-Length", "0"))
    except (AttributeError, ValueError) as exc:
        raise ValueError("上传文件长度不正确") from exc
    if length <= 0 or length > MAX_CLIP_MEDIA_BYTES:
        raise ValueError("上传文件为空或超过 1GB")

    temporary = tempfile.NamedTemporaryFile(
        prefix="cap-import-",
        suffix=suffix,
        dir=shots,
        delete=False,
    )
    temporary_path = Path(temporary.name)
    remaining = length
    try:
        with temporary:
            while remaining > 0:
                chunk = body.rfile.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise ValueError("上传文件不完整")
                temporary.write(chunk)
                remaining -= len(chunk)
        details = probe_media_details(temporary_path)
        if not details["hasVideo"]:
            raise ValueError("这个文件里没有可用视频")
        target_name = original_name
        target = shots / target_name
        if target.exists():
            stamp = datetime.now().strftime("%H%M%S")
            target_name = f"{Path(original_name).stem}-{stamp}{suffix}"
            target = shots / target_name
        shutil.move(str(temporary_path), target)
        chosen_title = str(title or Path(original_name).stem).strip()[:80]
        write_clip_metadata(
            target,
            {
                "title": chosen_title or Path(original_name).stem,
                "source": "Cap",
                "sourceType": "event-library",
                "description": "从 Cap 导入的事件镜头。",
                "tags": ["Cap", "事件镜头"],
            },
        )
        return {
            "eventId": event_id,
            "file": target_name,
            "title": chosen_title or Path(original_name).stem,
            "clips": list_event_clips(),
        }
    finally:
        temporary_path.unlink(missing_ok=True)


def update_event_clip(payload: dict) -> dict:
    event_id = safe_leaf(str(payload.get("eventId") or ""))
    filename = safe_leaf(str(payload.get("file") or ""))
    clip = resolve_clip(event_id, filename)
    title = str(payload.get("title") or "").strip()[:80]
    description = str(payload.get("description") or "").strip()[:180]
    raw_tags = payload.get("tags")
    tags = [str(item).strip()[:24] for item in raw_tags if str(item).strip()][:8] if isinstance(raw_tags, list) else None
    patch = {}
    if title:
        patch["title"] = title
    if description or "description" in payload:
        patch["description"] = description
    if tags is not None:
        patch["tags"] = tags
    write_clip_metadata(clip, patch)
    target_event_id = safe_leaf(str(payload.get("targetEventId") or event_id))
    if target_event_id != event_id:
        target_event = EVENT_LIBRARY / "events" / target_event_id
        if not target_event.is_dir():
            raise ValueError("目标分组不存在")
        target_shots = target_event / "画面"
        target_shots.mkdir(parents=True, exist_ok=True)
        target = target_shots / clip.name
        if target.exists():
            target = target_shots / f"{clip.stem}-{datetime.now().strftime('%H%M%S')}{clip.suffix}"
        metadata_path = clip_metadata_path(clip)
        clip.replace(target)
        if metadata_path.is_file():
            metadata_path.replace(clip_metadata_path(target))
        clip = target
        event_id = target_event_id
        filename = target.name
    return {
        "library": list_event_clips(),
        "selected": {"eventId": event_id, "file": filename},
    }


def delete_event_clip(payload: dict) -> dict:
    event_id = safe_leaf(str(payload.get("eventId") or ""))
    filename = safe_leaf(str(payload.get("file") or ""))
    clip = resolve_clip(event_id, filename)
    clip.unlink()
    clip_metadata_path(clip).unlink(missing_ok=True)
    return list_event_clips()


def ensure_poster(clip: Path, event_id: str) -> Path:
    POSTER_DIR.mkdir(parents=True, exist_ok=True)
    poster = POSTER_DIR / event_id / f"{clip.stem}.jpg"
    poster.parent.mkdir(parents=True, exist_ok=True)
    if poster.is_file() and poster.stat().st_mtime >= clip.stat().st_mtime:
        return poster
    subprocess.run(
        [
            FFMPEG,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            "0.35",
            "-i",
            str(clip),
            "-frames:v",
            "1",
            "-vf",
            "scale=720:-2",
            str(poster),
        ],
        check=False,
        timeout=20,
    )
    if not poster.is_file():
        raise FileNotFoundError("封面还没生成")
    return poster


class WorkbenchHandler(SimpleHTTPRequestHandler):
    server_version = "FishAudioWorkbench/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, format: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {format % args}")

    def end_headers(self) -> None:
        # API responses set their own no-store policy. Static assets can be
        # reused during page-to-page navigation, which avoids downloading the
        # same CSS and JavaScript on every workbench switch.
        if not any(b"Cache-Control:" in header for header in self._headers_buffer):
            path = urlparse(self.path).path
            if path.endswith((".css", ".js", ".woff", ".woff2")):
                self.send_header("Cache-Control", "private, max-age=300")
            elif path.endswith(".html"):
                self.send_header("Cache-Control", "private, max-age=30, must-revalidate")
            else:
                self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def send_json(self, payload: dict | list, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self, limit: int = MAX_REQUEST_BYTES) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("请求长度不正确") from exc
        if length <= 0 or length > limit:
            raise ValueError("请求内容为空或过大")
        try:
            value = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("请求内容不是有效 JSON") from exc
        if not isinstance(value, dict):
            raise ValueError("请求内容格式不正确")
        return value

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/topics-data.js" and (DATA_ROOT / "topics-data.js").is_file():
            self.serve_file(DATA_ROOT / "topics-data.js", "text/javascript; charset=utf-8", "no-store")
            return
        if path == "/api/config":
            settings = load_settings()
            self.send_json(
                {
                    "keyConfigured": bool(get_api_key()),
                    "keySource": "environment"
                    if os.getenv("FISH_API_KEY", "").strip()
                    else "local",
                    "voices": settings["voices"],
                    "history": recent_history(),
                }
            )
            return
        if path.startswith("/outputs/"):
            self.serve_output(path)
            return
        if path == "/api/clips":
            self.send_json(cached_data("clips", list_event_clips))
            return
        if path == "/api/voiceovers":
            self.send_json({"items": cached_data("voiceovers", list_voiceovers)})
            return
        if path.startswith("/voice-files/"):
            self.serve_voice_file(path)
            return
        if path == "/api/overlays":
            self.send_json(cached_data(
                "overlays",
                lambda: {
                    "instances": OVERLAYS.list_instances(),
                    "components": public_catalog(),
                    "defaultComponent": DEFAULT_COMPONENT_ID,
                    "defaults": get_component(DEFAULT_COMPONENT_ID).defaults(),
                    "events": event_choices(),
                },
            ))
            return
        if path.startswith("/api/overlays/"):
            self.serve_overlay_get(path)
            return
        if path.startswith("/clips/"):
            self.serve_clip(path)
            return
        if path in {"/", "/library", "/library/"}:
            self.path = "/library.html"
        elif path in {"/voiceover", "/voiceover/", "/voice", "/voice/"}:
            self.path = "/index.html"
        elif path in {"/clips", "/clips/"}:
            self.path = "/clips.html"
        elif path in {"/overlays", "/overlays/"}:
            self.path = "/overlays.html"
        elif path in {"/topics", "/topics/"}:
            self.path = "/topics.html"
        super().do_GET()

    def serve_file(self, target: Path, content_type: str, cache: str) -> None:
        stat = target.stat()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(stat.st_size))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        with target.open("rb") as source:
            while chunk := source.read(64 * 1024):
                self.wfile.write(chunk)

    def serve_output(self, path: str) -> None:
        filename = Path(unquote(path.removeprefix("/outputs/"))).name
        target = OUTPUT_DIR / filename
        if not filename or not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.serve_file(target, content_type, "private, max-age=3600")

    def serve_clip(self, path: str) -> None:
        parts = [part for part in unquote(path).strip("/").split("/") if part]
        # /clips/<event>/<file> or /clips/<event>/<file>/poster
        if len(parts) not in {3, 4}:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        _, event_id, filename, *rest = parts
        try:
            clip = resolve_clip(event_id, filename)
            if rest == ["poster"]:
                poster = ensure_poster(clip, event_id)
                self.serve_file(poster, "image/jpeg", "private, max-age=86400")
                return
            if rest:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self.serve_file(clip, "video/mp4", "private, max-age=3600")
        except (ValueError, FileNotFoundError):
            self.send_error(HTTPStatus.NOT_FOUND)

    def serve_voice_file(self, path: str) -> None:
        parts = [part for part in unquote(path).strip("/").split("/") if part]
        if len(parts) != 3:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            target = resolve_voice(f"{parts[1]}:{parts[2]}")
            self.serve_file(target, "audio/mpeg", "private, max-age=3600")
        except (ValueError, FileNotFoundError):
            self.send_error(HTTPStatus.NOT_FOUND)





    def serve_overlay_get(self, path: str) -> None:
        try:
            self._serve_overlay_get(path)
        except (ValueError, FileNotFoundError):
            self.send_error(HTTPStatus.NOT_FOUND)

    def _serve_overlay_get(self, path: str) -> None:
        parts = [part for part in unquote(path).strip("/").split("/") if part]
        if len(parts) == 3:
            _, instance_id, action = parts
            if action != "json":
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            folder = OVERLAYS.require_folder(instance_id)
            self.send_json(OVERLAYS.public_instance(folder))
            return
        if len(parts) != 5 or parts[0] != "api" or parts[1] != "overlays":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        _, _, instance_id, kind, name = parts
        folder = OVERLAYS.require_folder(instance_id)
        current = OVERLAYS.public_instance(folder)
        if kind == "image":
            try:
                slot = int(name)
            except ValueError:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            if slot == 0:
                match = current.get("background") if current.get("background") and current["background"].get("file") else None
            else:
                match = next((item for item in current["images"] if item["slot"] == slot and item["file"]), None)
            if not match:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            target = folder / "images" / match["file"]
            content_type = mimetypes.guess_type(target.name)[0] or "image/jpeg"
            self.serve_file(target, content_type, "no-store")
            return
        if kind == "audio":
            match = current.get("music") if current.get("hasMusic") else None
            if not match or not match.get("file"):
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            target = folder / "audio" / match["file"]
            content_type = mimetypes.guess_type(target.name)[0] or "audio/mpeg"
            self.serve_file(target, content_type, "no-store")
            return
        if kind == "file":
            filename = safe_leaf(name)
            target = folder / "output" / filename
            if filename not in {item["file"] for item in current["outputs"].values()} or not target.is_file():
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            self.serve_file(target, content_type, "no-store")
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        # Every POST can change one of the indexes above (including generated
        # voiceovers and overlays), so invalidate before processing it.
        clear_data_cache()
        try:
            if path == "/api/clips/import":
                self.handle_clip_import()
                return
            if path.startswith("/api/overlays"):
                self.handle_overlay_write(path)
                return
            payload = self.read_json_body()
            if path == "/api/clips/manage":
                action = str(payload.get("action") or "").strip()
                if action == "create-group":
                    result = create_event_group(str(payload.get("title") or ""))
                    self.send_json({"ok": True, "group": result, "clips": list_event_clips()})
                elif action == "update":
                    result = update_event_clip(payload)
                    self.send_json({"ok": True, "clips": result["library"], "selected": result["selected"]})
                elif action == "delete":
                    self.send_json({"ok": True, "clips": delete_event_clip(payload)})
                else:
                    self.send_json({"error": "素材管理动作不正确"}, HTTPStatus.BAD_REQUEST)
            elif path == "/api/settings":
                self.save_settings(payload)
            elif path == "/api/generate":
                self.generate_audio(payload)
            elif path == "/api/voiceovers/delete":
                voice_id = str(payload.get("voiceId") or "").strip()
                result = delete_voiceover(voice_id)
                self.send_json({"ok": True, **result, "items": list_voiceovers()})
            elif path == "/api/library/export":
                self.send_json({"ok": True, **create_library_pack(payload.get("items"))})
            else:
                self.send_json({"error": "接口不存在"}, HTTPStatus.NOT_FOUND)
        except FileNotFoundError as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.NOT_FOUND)
        except ValueError as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception as exc:  # Keep the local UI usable if an upstream call fails.
            self.send_json({"error": f"本地服务出错：{exc}"}, HTTPStatus.INTERNAL_SERVER_ERROR)


    def handle_clip_import(self) -> None:
        query = parse_qs(urlparse(self.path).query)
        event_id = str(query.get("eventId", [""])[0] or "")
        original_name = str(query.get("filename", [""])[0] or "")
        title = str(query.get("title", [""])[0] or "")
        result = import_event_clip(event_id, original_name, title, self)
        self.send_json({"ok": True, **result}, HTTPStatus.CREATED)


    def handle_overlay_write(self, path: str) -> None:
        parts = [part for part in unquote(path).strip("/").split("/") if part]
        payload = self.read_json_body(MAX_BATCH_IMAGES_BYTES)
        if path == "/api/overlays":
            instance = OVERLAYS.create_instance(
                str(payload.get("title") or ""),
                payload.get("params"),
                str(payload.get("component") or DEFAULT_COMPONENT_ID),
                str(payload.get("from") or "").strip(),
            )
            self.send_json({"ok": True, "instance": instance})
            return
        if len(parts) != 4:
            self.send_json({"error": "接口不存在"}, HTTPStatus.NOT_FOUND)
            return
        instance_id, action = parts[2], parts[3]
        if action == "save":
            instance = OVERLAYS.save_instance(instance_id, payload.get("title"), payload.get("params"))
            self.send_json({"ok": True, "instance": instance})
            return
        if action == "reorder":
            order = payload.get("order")
            if not isinstance(order, list):
                raise ValueError("顺序参数不合法")
            instance = OVERLAYS.reorder_images(instance_id, [int(x) for x in order if str(x).isdigit()])
            self.send_json({"ok": True, "instance": instance})
            return
        if action == "batch-images":
            raw_files = payload.get("files")
            if not isinstance(raw_files, list) or not raw_files:
                raise ValueError("未选择图片")
            files_to_save = []
            for item in raw_files:
                if not isinstance(item, dict):
                    continue
                encoded = str(item.get("data") or "")
                if "," in encoded:
                    encoded = encoded.split(",", 1)[1]
                try:
                    raw = base64.b64decode(encoded)
                except Exception as exc:
                    continue
                files_to_save.append({
                    "filename": str(item.get("filename") or "card.jpg"),
                    "data": raw,
                })
            start_slot = int(payload.get("startSlot") or 1)
            instance = OVERLAYS.batch_upload_images(instance_id, files_to_save, start_slot)
            self.send_json({"ok": True, "instance": instance})
            return
        if action == "image":
            try:
                slot = int(payload.get("slot"))
            except (TypeError, ValueError) as exc:
                raise ValueError("槽位不正确") from exc
            encoded = str(payload.get("data") or "")
            if "," in encoded:
                encoded = encoded.split(",", 1)[1]
            try:
                raw = base64.b64decode(encoded)
            except Exception as exc:
                raise ValueError("图片数据读不出来") from exc
            instance = OVERLAYS.save_image(
                instance_id,
                slot,
                str(payload.get("filename") or "card.jpg"),
                raw,
            )
            self.send_json({"ok": True, "instance": instance})
            return
        if action == "music":
            encoded = str(payload.get("data") or "")
            if "," in encoded:
                encoded = encoded.split(",", 1)[1]
            try:
                raw = base64.b64decode(encoded)
            except Exception as exc:
                raise ValueError("音频数据读不出来") from exc
            instance = OVERLAYS.save_music(
                instance_id,
                str(payload.get("filename") or "bgm.mp3"),
                raw,
            )
            self.send_json({"ok": True, "instance": instance})
            return
        if action == "render":
            if payload.get("params") or payload.get("title"):
                OVERLAYS.save_instance(instance_id, payload.get("title"), payload.get("params"))
            formats = payload.get("formats")
            if not isinstance(formats, list) or not formats:
                formats = ["preview", "webm"]
            instance = OVERLAYS.render_instance(instance_id, formats)
            self.send_json({"ok": True, "instance": instance})
            return
        if action == "delete":
            OVERLAYS.delete_instance(instance_id)
            self.send_json({"ok": True})
            return
        if action == "publish":
            published = publish_overlay_to_event(
                instance_id,
                str(payload.get("eventId") or ""),
                str(payload.get("title") or ""),
            )
            self.send_json({"ok": True, "published": published, "events": event_choices()})
            return
        self.send_json({"error": "接口不存在"}, HTTPStatus.NOT_FOUND)

    def save_settings(self, payload: dict) -> None:
        settings = load_settings()
        if "apiKey" in payload:
            api_key = str(payload.get("apiKey", "")).strip()
            if api_key and len(api_key) < 20:
                raise ValueError("API Key 看起来过短")
            settings["api_key"] = api_key
        if "voices" in payload:
            settings["voices"] = sanitize_voices(payload["voices"])
        write_private_json(SETTINGS_FILE, settings)
        self.send_json({"ok": True, "keyConfigured": bool(get_api_key())})

    def generate_audio(self, payload: dict) -> None:
        api_key = get_api_key()
        if not api_key:
            raise ValueError("请先在设置中保存 Fish Audio API Key")

        text = str(payload.get("text", "")).strip()
        voice_id = normalize_voice_id(payload.get("voiceId", ""))
        voice_name = str(payload.get("voiceName", "音色")).strip()[:40] or "音色"
        model = str(payload.get("model", "s2.1-pro-free")).strip()
        try:
            speed = float(payload.get("speed", 1.0))
        except (TypeError, ValueError) as exc:
            raise ValueError("语速格式不正确") from exc

        allowed_models = {"s2.1-pro-free", "s2.1-pro"}
        if model not in allowed_models:
            raise ValueError("不支持这个生成模型")
        if not text:
            raise ValueError("请输入需要配音的文案")
        limit = 500 if model == "s2.1-pro-free" else 15_000
        if len(text) > limit:
            raise ValueError(f"当前模型单次最多输入 {limit} 个字符")
        if not voice_id:
            raise ValueError("音色 ID 格式不正确")
        if not 0.5 <= speed <= 2.0:
            raise ValueError("语速必须在 0.5 到 2.0 之间")

        request_body = json.dumps(
            {
                "text": text,
                "reference_id": voice_id,
                "format": "mp3",
                "sample_rate": 44100,
                "mp3_bitrate": 128,
                "normalize": True,
                "latency": "normal",
                "prosody": {
                    "speed": speed,
                    "volume": 0,
                    "normalize_loudness": True,
                },
            },
            ensure_ascii=False,
        ).encode("utf-8")
        request = urllib.request.Request(
            API_URL,
            data=request_body,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "model": model,
                "User-Agent": "FishAudioWorkbench/1.0",
            },
            method="POST",
        )

        try:
            for attempt, delay in enumerate((*TTS_RETRY_DELAYS, None)):
                try:
                    with urllib.request.urlopen(request, timeout=120) as response:
                        audio = response.read()
                        content_type = response.headers.get("Content-Type", "")
                    break
                except urllib.error.HTTPError:
                    raise
                except urllib.error.URLError:
                    if delay is None:
                        raise
                    time.sleep(delay)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:1000]
            try:
                message = json.loads(detail).get("message") or detail
            except json.JSONDecodeError:
                message = detail
            if exc.code == 401:
                message = "API Key 无效，或当前账号没有调用权限"
            elif exc.code == 402:
                message = "Fish Audio 账户额度不足"
            elif exc.code == 503:
                message = "免费模型当前繁忙，请稍后再试"
            raise ValueError(message) from exc
        except urllib.error.URLError as exc:
            raise ValueError(f"无法连接 Fish Audio（已重试 3 次）：{exc.reason}") from exc

        if not audio or "json" in content_type:
            detail = audio.decode("utf-8", "replace")[:1000]
            raise ValueError(f"Fish Audio 没有返回有效音频：{detail}")

        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        safe_name = re.sub(r"[^A-Za-z0-9\u4e00-\u9fff]+", "-", voice_name).strip("-")
        filename = f"{timestamp}-{safe_name or 'voice'}.mp3"
        output = OUTPUT_DIR / filename
        output.write_bytes(audio)
        item = {
            "file": filename,
            "url": f"/outputs/{filename}",
            "voice": voice_name,
            "voiceId": voice_id,
            "model": model,
            "speed": speed,
            "bytes": len(audio),
            "characters": len(text),
            "preview": text[:70],
            "createdAt": datetime.now().isoformat(timespec="seconds"),
        }
        record_history(item)
        self.send_json({"ok": True, "result": item})


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Fish Audio workbench")
    parser.add_argument("--host", default=os.getenv("WORKBENCH_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "8765")))
    args = parser.parse_args()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((args.host, args.port), WorkbenchHandler)
    print(f"Fish Audio Workbench: http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
