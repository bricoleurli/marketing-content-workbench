"""Overlay instance storage, upload, and render."""

from __future__ import annotations

import json
import hashlib
import tempfile
import re
import shutil
import subprocess
import sys
import threading
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageOps

from common import read_json, safe_leaf
from overlay_components import get_component

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
AUDIO_EXTS = {".mp3", ".m4a", ".wav", ".aac", ".ogg"}
OUTPUT_NAMES = {
    "preview": "overlay-preview.mp4",
    "webm": "overlay.webm",
    "mov": "overlay.mov",
    "webp": "overlay.webp",
}
ALLOWED_FORMATS = set(OUTPUT_NAMES)
_RENDER_LOCK = threading.Lock()
MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_AUDIO_BYTES = 20 * 1024 * 1024


def overlay_id_ok(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9_\u4e00-\u9fff-]{2,64}", value))


def probe_image_size(path: Path) -> tuple[int, int] | None:
    try:
        with Image.open(path) as image:
            image = ImageOps.exif_transpose(image)
            return image.size
    except OSError:
        return None


def describe_image(folder: Path, path: Path | None, url: str | None) -> dict:
    size = probe_image_size(path) if path else None
    return {
        "file": path.name if path else None,
        "url": url if path else None,
        "width": size[0] if size else None,
        "height": size[1] if size else None,
    }


class OverlayStore:
    def __init__(self, root: Path):
        self.root = root
        self.instances = root / "instances"

    def script_for(self, component) -> Path:
        return Path(__file__).resolve().parent / "renderers" / component.script_name

    def instance_dir(self, instance_id: str) -> Path:
        instance_id = safe_leaf(instance_id)
        if not overlay_id_ok(instance_id):
            raise ValueError("实例 ID 不合法")
        return self.instances / instance_id

    def find_named_image(self, folder: Path, stem: str) -> Path | None:
        return next(
            (
                path
                for ext in IMAGE_EXTS
                for path in [folder / "images" / f"{stem}{ext}"]
                if path.is_file()
            ),
            None,
        )

    def slot_images(self, folder: Path, slot_count: int) -> list[dict]:
        images = []
        for index in range(1, slot_count + 1):
            match = self.find_named_image(folder, f"{index:02d}")
            item = describe_image(
                folder,
                match,
                f"/api/overlays/{folder.name}/image/{index}" if match else None,
            )
            item["slot"] = index
            images.append(item)
        return images

    def background_image(self, folder: Path) -> dict | None:
        match = self.find_named_image(folder, "bg")
        if not match:
            return None
        item = describe_image(folder, match, f"/api/overlays/{folder.name}/image/0")
        item["slot"] = 0
        return item

    def find_named_audio(self, folder: Path, stem: str = "bgm") -> Path | None:
        audio_dir = folder / "audio"
        return next(
            (
                path
                for ext in AUDIO_EXTS
                for path in [audio_dir / f"{stem}{ext}"]
                if path.is_file()
            ),
            None,
        )

    def music_file(self, folder: Path) -> dict | None:
        match = self.find_named_audio(folder)
        if not match:
            return None
        return {
            "file": match.name,
            "url": f"/api/overlays/{folder.name}/audio/bgm",
            "bytes": match.stat().st_size,
        }

    def render_fingerprint(self, folder: Path) -> str:
        data = read_json(folder / "instance.json", {})
        component = get_component(data.get("component"))
        digest = hashlib.sha256(json.dumps({"component": component.id,
            "params": component.sanitize(data.get("params"))}, sort_keys=True).encode())
        # Titles and timestamps do not affect pixels; all media bytes and renderer
        # sources do. Replacing an image under the same filename invalidates output.
        sources = []
        for subdir in ("images", "audio"):
            sources.extend(sorted((folder / subdir).glob("*")))
        sources.extend(sorted(self.script_for(component).parent.glob("*.py")))
        for source in sources:
            if source.is_file():
                digest.update(str(source.relative_to(folder) if source.is_relative_to(folder) else source.name).encode())
                with source.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(chunk)
        return digest.hexdigest()

    def output_files(self, folder: Path) -> dict:
        out = folder / "output"
        files = {}
        manifest = read_json(out / "manifest.json", {})
        fingerprint = self.render_fingerprint(folder)
        for kind, name in OUTPUT_NAMES.items():
            path = out / name
            if path.is_file() and manifest.get(kind) == fingerprint:
                files[kind] = {
                    "file": name,
                    "url": f"/api/overlays/{folder.name}/file/{name}",
                    "bytes": path.stat().st_size,
                }
        return files

    def public_instance(self, folder: Path) -> dict:
        data = read_json(folder / "instance.json", {})
        component = get_component(data.get("component"))
        title = str(data.get("title") or folder.name)
        params = component.sanitize(data.get("params"))
        slot_count = component.active_slot_count(params)
        images = self.slot_images(folder, slot_count)
        filled = sum(1 for item in images if item["file"])
        background = self.background_image(folder) if component.has_background else None
        music = self.music_file(folder) if component.has_music else None
        return {
            "id": folder.name,
            "title": title,
            "component": component.id,
            "componentTitle": component.title,
            "hint": component.hint,
            "slotCount": slot_count,
            "maxSlots": component.slot_count,
            "minImages": component.min_images,
            "hasBackground": component.has_background,
            "hasMusic": component.has_music,
            "countKey": component.count_key,
            "params": params,
            "images": images,
            "background": background,
            "music": music,
            "filled": filled,
            "outputs": self.output_files(folder),
            "updatedAt": data.get("updatedAt"),
        }

    def write_instance(self, folder: Path, title: str, params: dict, component_id: str) -> dict:
        component = get_component(component_id)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "images").mkdir(exist_ok=True)
        (folder / "audio").mkdir(exist_ok=True)
        (folder / "output").mkdir(exist_ok=True)
        payload = {
            "id": folder.name,
            "title": title.strip()[:40] or folder.name,
            "component": component.id,
            "params": component.sanitize(params),
            "updatedAt": datetime.now().isoformat(timespec="seconds"),
        }
        (folder / "instance.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return self.public_instance(folder)

    def list_instances(self) -> list[dict]:
        self.instances.mkdir(parents=True, exist_ok=True)
        instances = []
        for folder in sorted(
            self.instances.iterdir(), key=lambda path: path.stat().st_mtime, reverse=True
        ):
            if folder.is_dir() and (folder / "instance.json").is_file():
                instances.append(self.public_instance(folder))
        return instances

    def new_instance_id(self) -> str:
        self.instances.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        candidate = stamp
        index = 2
        while (self.instances / candidate).exists():
            candidate = f"{stamp}-{index}"
            index += 1
        return candidate

    def copy_images(self, source: Path, dest: Path) -> None:
        dest.mkdir(parents=True, exist_ok=True)
        for path in dest.glob("*"):
            if path.is_file():
                path.unlink()
        if not source.is_dir():
            return
        allowed = IMAGE_EXTS | AUDIO_EXTS
        for path in sorted(source.glob("*")):
            if path.suffix.lower() in allowed:
                shutil.copy2(path, dest / path.name)

    def clear_named(self, folder: Path, stem: str) -> None:
        for ext in IMAGE_EXTS:
            target = folder / "images" / f"{stem}{ext}"
            if target.is_file():
                target.unlink()

    def save_named_image(self, folder: Path, stem: str, filename: str, payload: bytes) -> None:
        suffix = Path(filename).suffix.lower()
        if suffix not in IMAGE_EXTS:
            raise ValueError("只接受 jpg / png / webp")
        if not payload:
            raise ValueError("图片是空的")
        if len(payload) > MAX_IMAGE_BYTES:
            raise ValueError("图片太大")
        (folder / "images").mkdir(parents=True, exist_ok=True)
        self.clear_named(folder, stem)
        (folder / "images" / f"{stem}{suffix}").write_bytes(payload)

    def create_instance(self, title: str, params, component_id: str, source_id: str = "") -> dict:
        folder = self.instance_dir(self.new_instance_id())
        component = get_component(component_id)
        chosen_title = title.strip()[:40] or component.default_title
        if source_id:
            source = self.instance_dir(source_id)
            if (source / "instance.json").is_file():
                source_data = self.public_instance(source)
                component = get_component(source_data["component"])
                chosen_params = params or source_data["params"]
                self.write_instance(folder, chosen_title, chosen_params, component.id)
                self.copy_images(source / "images", folder / "images")
                self.copy_images(source / "audio", folder / "audio")
                return self.public_instance(folder)
        return self.write_instance(
            folder, chosen_title, params or component.defaults(), component.id
        )

    def require_folder(self, instance_id: str) -> Path:
        folder = self.instance_dir(instance_id)
        if not (folder / "instance.json").is_file():
            raise FileNotFoundError("找不到这条叠加件")
        return folder

    def save_instance(self, instance_id: str, title: str | None, params) -> dict:
        folder = self.require_folder(instance_id)
        current = self.public_instance(folder)
        return self.write_instance(
            folder,
            str(title or current["title"]),
            params or current["params"],
            current["component"],
        )

    def save_image(self, instance_id: str, slot: int, filename: str, payload: bytes) -> dict:
        folder = self.require_folder(instance_id)
        current = self.public_instance(folder)
        component = get_component(current["component"])
        if slot == 0:
            if not component.has_background:
                raise ValueError("这个组件没有背景槽")
            self.save_named_image(folder, "bg", filename, payload)
            return self.write_instance(folder, current["title"], current["params"], current["component"])
        max_slots = current.get("maxSlots") or current["slotCount"]
        if slot not in range(1, max_slots + 1):
            raise ValueError(f"槽位必须是 1 到 {max_slots}")
        self.save_named_image(folder, f"{slot:02d}", filename, payload)
        params = dict(current["params"])
        if component.count_key and slot > int(params.get(component.count_key, 0)):
            params[component.count_key] = slot
        return self.write_instance(folder, current["title"], params, current["component"])

    def reorder_images(self, instance_id: str, new_order: list[int]) -> dict:
        folder = self.require_folder(instance_id)
        current = self.public_instance(folder)
        component = get_component(current["component"])
        max_slots = current.get("maxSlots") or current["slotCount"]
        images_dir = folder / "images"
        if not images_dir.is_dir():
            return current

        # Collect current images by slot
        current_map = {}
        for slot in range(1, max_slots + 1):
            found = self.find_named_image(folder, f"{slot:02d}")
            if found:
                current_map[slot] = found

        if not current_map:
            return current

        # Temporary rename to avoid collision
        temp_renames = []
        for slot, path in current_map.items():
            temp_path = images_dir / f"tmp_{slot:02d}_{path.suffix}"
            path.rename(temp_path)
            temp_renames.append((slot, temp_path))

        # Reassign according to new_order (new_order is 1-based original slot list in new display order)
        temp_dict = dict(temp_renames)
        for target_slot, orig_slot in enumerate(new_order, start=1):
            if target_slot > max_slots:
                break
            if orig_slot in temp_dict:
                source_temp = temp_dict[orig_slot]
                dest_path = images_dir / f"{target_slot:02d}{source_temp.suffix.replace('tmp_', '')}"
                # Clean destination if exists
                self.clear_named(folder, f"{target_slot:02d}")
                source_temp.rename(dest_path)

        # Cleanup leftover temp files if any
        for f in images_dir.glob("tmp_*"):
            try:
                f.unlink()
            except OSError:
                pass

        # Also reorder parameter arrays if present (focuses, positions)
        params = dict(current["params"])
        if "focuses" in component.defaults():
            old_focuses = params.get("focuses") or []
            new_focuses = []
            for orig_slot in new_order:
                idx = orig_slot - 1
                new_focuses.append(old_focuses[idx] if idx < len(old_focuses) else {})
            params["focuses"] = new_focuses

        if "positions" in component.defaults():
            old_positions = params.get("positions") or []
            new_positions = []
            for orig_slot in new_order:
                idx = orig_slot - 1
                new_positions.append(old_positions[idx] if idx < len(old_positions) else {})
            params["positions"] = new_positions

        if component.id == "rapid_montage" and "landSlot" in params:
            old_land = int(params.get("landSlot") or 0)
            if old_land in new_order:
                params["landSlot"] = new_order.index(old_land) + 1

        return self.write_instance(folder, current["title"], params, current["component"])

    def batch_upload_images(self, instance_id: str, files: list[dict], start_slot: int = 1) -> dict:
        folder = self.require_folder(instance_id)
        current = self.public_instance(folder)
        component = get_component(current["component"])
        max_slots = current.get("maxSlots") or current["slotCount"]
        slot = max(1, start_slot)
        for item in files:
            if slot > max_slots:
                break
            filename = str(item.get("filename") or f"card_{slot:02d}.jpg")
            raw = item.get("data")
            if not raw:
                continue
            self.save_named_image(folder, f"{slot:02d}", filename, raw)
            slot += 1

        params = dict(current["params"])
        if component.count_key:
            target_count = max(int(params.get(component.count_key, 0)), slot - 1)
            params[component.count_key] = min(max_slots, max(component.min_images, target_count))

        return self.write_instance(folder, current["title"], params, current["component"])

    def save_music(self, instance_id: str, filename: str, payload: bytes) -> dict:
        folder = self.require_folder(instance_id)
        current = self.public_instance(folder)
        component = get_component(current["component"])
        if not component.has_music:
            raise ValueError("这个组件没有配乐槽")
        suffix = Path(filename).suffix.lower()
        if suffix not in AUDIO_EXTS:
            raise ValueError("配乐只接受 mp3 / m4a / wav / aac / ogg")
        if not payload:
            raise ValueError("音频是空的")
        if len(payload) > MAX_AUDIO_BYTES:
            raise ValueError("音频太大")
        audio_dir = folder / "audio"
        audio_dir.mkdir(parents=True, exist_ok=True)
        for ext in AUDIO_EXTS:
            target = audio_dir / f"bgm{ext}"
            if target.is_file():
                target.unlink()
        (audio_dir / f"bgm{suffix}").write_bytes(payload)
        return self.write_instance(folder, current["title"], current["params"], current["component"])

    def delete_instance(self, instance_id: str) -> None:
        folder = self.instance_dir(instance_id)
        if folder.exists():
            shutil.rmtree(folder)

    def render_instance(self, instance_id: str, formats: list[str] | None = None) -> dict:
        if not _RENDER_LOCK.acquire(blocking=False):
            raise ValueError("已有模板正在导出，请完成后重试")
        try:
            return self._render_instance(instance_id, formats)
        finally:
            _RENDER_LOCK.release()

    def _render_instance(self, instance_id: str, formats: list[str] | None = None) -> dict:
        folder = self.require_folder(instance_id)
        data = self.public_instance(folder)
        component = get_component(data["component"])
        images = [item for item in data["images"] if item["file"]]
        if len(images) < component.min_images:
            raise ValueError(f"至少先放进 {component.min_images} 张图")
        script = self.script_for(component)
        if not script.is_file():
            raise FileNotFoundError(f"找不到 {component.title} 的导出脚本")
        wanted = formats if formats is not None else ["preview"]
        if not isinstance(wanted, list) or len(wanted) != 1 or wanted[0] not in {"preview", "webm"}:
            raise ValueError("每次请选择一种格式：MP4 或 WebM")
        fingerprint = self.render_fingerprint(folder)
        if wanted[0] in data["outputs"]:
            return {**data, "cacheHit": True}
        output_root = folder / "output"
        output_root.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="render-", dir=folder)
        out_dir = Path(temporary.name)
        image_paths = [str(folder / "images" / item["file"]) for item in images]
        params = dict(data["params"])
        if component.count_key:
            params["cardCount"] = len(images)
            if component.id == "rapid_montage":
                land_slot = int(params.get("landSlot") or 0)
                if land_slot:
                    mapped = next(
                        (index + 1 for index, item in enumerate(images) if item["slot"] == land_slot),
                        0,
                    )
                    params["landSlot"] = mapped
            if "positions" in component.defaults():
                stored = params.get("positions") or []
                aligned = []
                for item in images:
                    index = item["slot"] - 1
                    if index < len(stored) and isinstance(stored[index], dict) and stored[index]:
                        aligned.append(stored[index])
                    else:
                        aligned.append(None)
                params["positions"] = aligned
            if "focuses" in component.defaults():
                stored = params.get("focuses") or []
                aligned = []
                for item in images:
                    index = item["slot"] - 1
                    if index < len(stored) and isinstance(stored[index], dict) and stored[index]:
                        aligned.append(stored[index])
                    else:
                        aligned.append({})
                params["focuses"] = aligned
        command = [
            sys.executable,
            str(script),
            "--images",
            *image_paths,
            "--out",
            str(out_dir),
            "--stem",
            "overlay",
            *component.render_args(params, wanted),
        ]
        background = data.get("background")
        if background and background.get("file"):
            command.extend(["--background", str(folder / "images" / background["file"])])
        music = data.get("music")
        if music and music.get("file"):
            command.extend(["--music", str(folder / "audio" / music["file"])])
        try:
            result = subprocess.run(command, capture_output=True, text=True,
                                    timeout=300, cwd=str(self.root))
            if result.returncode != 0:
                detail = (result.stderr or result.stdout or "导出失败").strip()[-800:]
                raise ValueError(detail)
            if fingerprint != self.render_fingerprint(folder):
                raise ValueError("导出期间素材或参数发生变化，请重新导出")
            name = OUTPUT_NAMES[wanted[0]]
            produced = out_dir / name
            if not produced.is_file() or not produced.stat().st_size:
                raise ValueError("导出没有生成有效文件")
            produced.replace(output_root / name)
            manifest = read_json(output_root / "manifest.json", {})
            manifest[wanted[0]] = fingerprint
            (output_root / "manifest.json").write_text(json.dumps(manifest))
            return {**self.public_instance(folder), "cacheHit": False}
        finally:
            temporary.cleanup()
