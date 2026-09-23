"""Shared helpers for the localhost workbench."""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import unquote


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return fallback


def write_private_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def safe_leaf(value: str) -> str:
    name = Path(unquote(value)).name
    if not name or name in {".", ".."} or "/" in name or "\\" in name:
        raise ValueError("路径不合法")
    return name


def clamp_number(value, minimum, maximum, fallback, integer=False):
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = fallback
    number = max(minimum, min(maximum, number))
    return int(round(number)) if integer else round(number, 3)
