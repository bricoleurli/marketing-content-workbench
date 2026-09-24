"""Append-only user topics, kept separately from the original topic library."""
import hashlib
import json
import threading
from pathlib import Path

from common import write_private_json

_LOCK = threading.Lock()


class TopicStore:
    def __init__(self, path: Path):
        self.path = path

    def read(self):
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"categories": []}

    def add(self, payload):
        def name(key, default):
            value = payload.get(key, default)
            if not isinstance(value, str) or not value.strip() or len(value.strip()) > 60:
                raise ValueError("分类和分组名称需为 1–60 个字")
            return value.strip()

        category_name = name("category", "自建选题")
        group_name = name("group", "默认分组")
        topics = payload.get("topics")
        if not isinstance(topics, list) or not 1 <= len(topics) <= 200:
            raise ValueError("每次请添加 1–200 条选题")
        if any(not isinstance(t, str) or not t.strip() or len(t.strip()) > 500 for t in topics):
            raise ValueError("每条选题需为 1–500 个字")
        with _LOCK:
            data = self.read()
            total = sum(len(g["topics"]) for c in data["categories"] for g in c["groups"])
            category = next((c for c in data["categories"] if c["name"] == category_name), None)
            if category is None:
                category = {"id": "custom-" + hashlib.sha256(category_name.encode()).hexdigest()[:16],
                            "name": category_name, "numeral": str(len(data["categories"]) + 1),
                            "note": "自己收集的选题", "groups": []}
                data["categories"].append(category)
            group = next((g for g in category["groups"] if g["name"] == group_name), None)
            if group is None:
                group = {"name": group_name, "topics": []}
                category["groups"].append(group)
            known = set(group["topics"])
            added = 0
            for text in topics:
                text = text.strip()
                if text not in known:
                    group["topics"].append(text)
                    known.add(text)
                    added += 1
            if total + added > 10000:
                raise ValueError("自建选题已达 10000 条上限")
            write_private_json(self.path, data)
            return {"added": added, "skipped": len(topics) - added, **data}
