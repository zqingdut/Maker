"""In-memory item store + append-only request log.

Deliberately not persistent: a mock should come up clean every time. The request
log *is* persisted (JSONL) because "what exactly did my client send?" is the
question a mock exists to answer.
"""

from __future__ import annotations

import json
import pathlib
import threading
import time
from collections import OrderedDict, deque

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_LOG_PATH = ROOT / "capture" / "requests.jsonl"

MAX_ITEMS = 500
MAX_RECENT = 500
MAX_LOG_BYTES = 32 * 1024 * 1024


class Store:
    def __init__(self, log_path: pathlib.Path | None = None, log_enabled: bool = True):
        self._items: OrderedDict[str, dict] = OrderedDict()
        self._recent: deque[dict] = deque(maxlen=MAX_RECENT)
        self._lock = threading.Lock()
        self._log_path = pathlib.Path(log_path) if log_path else DEFAULT_LOG_PATH
        self._log_enabled = log_enabled
        self._log_rotated = False
        self.counters: dict[str, int] = {}

    # --- items ---------------------------------------------------------
    def put(self, item_id: str, payload: dict) -> None:
        with self._lock:
            self._items[item_id] = payload
            self._items.move_to_end(item_id)
            while len(self._items) > MAX_ITEMS:
                self._items.popitem(last=False)

    def get(self, item_id: str) -> dict | None:
        with self._lock:
            return self._items.get(item_id)

    def list(self, limit: int = 50) -> list[dict]:
        with self._lock:
            items = list(self._items.values())[-limit:]
        return list(reversed(items))

    # --- counters ------------------------------------------------------
    def bump(self, key: str, amount: int = 1) -> None:
        with self._lock:
            self.counters[key] = self.counters.get(key, 0) + amount

    # --- request log ---------------------------------------------------
    @property
    def log_path(self) -> pathlib.Path:
        return self._log_path

    @property
    def log_enabled(self) -> bool:
        return self._log_enabled

    def recent(self, limit: int = 20) -> list[dict]:
        """The in-memory ring buffer.

        The control plane reads this rather than the file, so "what did my client
        send?" still works when file logging is off or the file is unwritable.
        """
        with self._lock:
            records = list(self._recent)
        return records[-limit:]

    def read_log_file(self, limit: int = 20) -> list[dict]:
        """Tail the JSONL file. Survives restarts; empty if file logging is off."""
        if not self._log_path.exists():
            return []
        tail: deque[str] = deque(maxlen=max(1, min(limit, 1000)))
        with self._log_path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                tail.append(line)
        records = []
        for line in tail:
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return records

    def log_request(self, record: dict) -> None:
        with self._lock:
            self._recent.append(record)

        if not self._log_enabled:
            return
        try:
            self._log_path.parent.mkdir(parents=True, exist_ok=True)
            if not self._log_rotated and self._log_path.exists():
                if self._log_path.stat().st_size > MAX_LOG_BYTES:
                    stamp = time.strftime("%Y%m%d-%H%M%S")
                    self._log_path.rename(self._log_path.with_suffix(f".{stamp}.jsonl"))
            self._log_rotated = True
            line = json.dumps(record, ensure_ascii=False, default=str)
            with self._lock, self._log_path.open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except OSError:
            # A mock must never fail because its log file is unwritable.
            pass

    def reset(self) -> None:
        with self._lock:
            self._items.clear()
            self._recent.clear()
            self.counters.clear()
