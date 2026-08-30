import glob
import json
import os
from collections import deque
from datetime import datetime, timezone


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def tail_jsonl(path, n=200):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return list(deque(f, maxlen=n))
    except OSError:
        return []


def ts_to_dt(ts_str):
    if not ts_str:
        return None
    try:
        return datetime.fromisoformat(str(ts_str).replace("Z", "+00:00"))
    except ValueError:
        return None


def fmt_tokens(n):
    if n < 1000:
        return str(n)
    if n < 1_000_000:
        return f"{n / 1000:.0f}k"
    return f"{n / 1_000_000:.1f}M"


def fmt_money(n):
    return f"${n:.2f}"


class SessionCache:
    def __init__(self, sessions_dir=None, models_json=None):
        home = os.path.expanduser("~")
        agent_dir = os.getenv("PI_AGENT_DIR", os.path.join(home, ".pi", "agent"))
        self.sessions_dir = sessions_dir or os.path.join(agent_dir, "sessions")
        self.models_json = models_json or os.path.join(agent_dir, "models.json")
        self.models_store_json = os.path.join(
            os.path.dirname(self.models_json), "models-store.json"
        )
        self._file = None
        self._follow_latest = True
        self._mtime = 0
        self._lines = []
        self._cost = 0.0
        self._ctx_win = 0
        self._on_change = None

    def _files(self):
        patterns = (
            os.path.join(self.sessions_dir, "*", "*.jsonl"),
            os.path.join(self.sessions_dir, "*.jsonl"),
        )
        files = []
        for pattern in patterns:
            files.extend(glob.glob(pattern))
        return files

    def _refresh(self):
        files = self._files()
        if not files:
            if self._file is not None:
                self._file = None
                self._lines = []
                self._mtime = 0
                self._cost = 0.0
                if self._on_change:
                    self._on_change()
            return
        if self._follow_latest:
            filepath = max(files, key=os.path.getmtime)
        elif self._file and os.path.exists(self._file):
            filepath = self._file
        elif self._file:
            self._file = None
            self._lines = []
            self._mtime = 0
            self._cost = 0.0
            if self._on_change:
                self._on_change()
            return
        mtime = os.path.getmtime(filepath)
        if filepath != self._file or mtime != self._mtime:
            self._file = filepath
            self._mtime = mtime
            self._lines = tail_jsonl(filepath, 2000)
            self._cost = 0.0
            for line in self._lines:
                try:
                    message = json.loads(line).get("message", {})
                    usage = message.get("usage") or {}
                    if message.get("role") == "assistant" and usage:
                        self._cost += float((usage.get("cost") or {}).get("total", 0))
                except (json.JSONDecodeError, KeyError, TypeError, ValueError):
                    continue
            if self._on_change:
                self._on_change()

    @property
    def all_sessions(self):
        files = self._files()
        files.sort(key=os.path.getmtime, reverse=True)
        return files

    def switch_to(self, filepath):
        self._follow_latest = False
        if self._file != filepath:
            self._file = filepath
            self._mtime = 0
            self._lines = []
            self._cost = 0.0
            self._ctx_win = 0
            if self._on_change:
                self._on_change()

    def auto_follow(self):
        self._follow_latest = True
        self._file = None
        self._mtime = 0
        self._lines = []
        self._cost = 0.0
        self._ctx_win = 0
        if self._on_change:
            self._on_change()

    def get_lines(self):
        self._refresh()
        return self._lines

    @staticmethod
    def _context_window_in(catalog, provider, model):
        if not isinstance(catalog, dict):
            return 0
        providers = catalog.get("providers")
        providers = providers if isinstance(providers, dict) else catalog
        config = providers.get(provider, {})
        if not isinstance(config, dict):
            return 0
        for entry in config.get("models", []):
            if not isinstance(entry, dict):
                continue
            if entry.get("id") == model or entry.get("name") == model:
                return entry.get("contextWindow", 128000) or 128000
        override = config.get("modelOverrides", {}).get(model, {})
        return override.get("contextWindow", 0) if isinstance(override, dict) else 0

    def ctx_win_for(self, provider, model):
        key = (provider, model)
        if self._ctx_win and getattr(self, "_cached_key", None) == key:
            return self._ctx_win
        self._ctx_win = 0
        for path in (self.models_json, self.models_store_json):
            self._ctx_win = self._context_window_in(load_json(path), provider, model)
            if self._ctx_win:
                break
        if not self._ctx_win:
            from model_config import KNOWN_CONTEXT_WINDOWS
            self._ctx_win = KNOWN_CONTEXT_WINDOWS.get(key, 0)
        self._cached_key = key
        return self._ctx_win

    @property
    def cost(self):
        self._refresh()
        return self._cost

    @property
    def file(self):
        self._refresh()
        return self._file


class Collector:
    def __init__(self, sessions_dir, settings_json, models_json, auth_json):
        import queue
        import threading
        self.q = queue.Queue()
        self._stop = threading.Event()
        self.settings_json = settings_json
        self.auth_json = auth_json
        self._cache = SessionCache(sessions_dir, models_json)
        self._cache._on_change = self._on_file_change
        self._last_thinking = "—"
        self._provider = "—"
        self._model = "—"
        self._auto_follow = True

    def _on_file_change(self):
        self._last_thinking = self._provider = self._model = "—"
        self._cache._ctx_win = 0

    def start(self):
        import threading
        threading.Thread(target=self.loop, daemon=True).start()

    def switch_to(self, filepath):
        self._auto_follow = False
        self._cache.switch_to(filepath)

    def auto_follow(self):
        self._auto_follow = True
        self._cache.auto_follow()
        self._provider = self._model = "—"

    def stop(self):
        self._stop.set()

    def loop(self):
        import time
        while not self._stop.is_set():
            self.q.put(self.collect())
            self._stop.wait(0.8)

    def collect(self):
        now = datetime.now(timezone.utc)
        lines = self._cache.get_lines()
        cmd = tool = cmd_ts = last_act = ""
        thinking = self._last_thinking
        thinking_found = False
        usage_found = False
        tokens = {"in": 0, "out": 0, "cache_read": 0, "cache_write": 0, "reasoning": 0, "total": 0, "cost": self._cache.cost, "ctx_pct": 0.0, "hit_rate": 0.0}
        for line in reversed(lines):
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            message = event.get("message", {})
            if not thinking_found and event.get("type") == "thinking_level_change":
                thinking = event.get("thinkingLevel", "—")
                self._last_thinking = thinking
                thinking_found = True
            usage = message.get("usage")
            if message.get("role") == "assistant" and usage and not usage_found:
                usage_found = True
                in_t = usage.get("input", 0) or 0
                out_t = usage.get("output", 0) or 0
                cache_read = usage.get("cacheRead", 0) or 0
                cache_write = usage.get("cacheWrite", 0) or 0
                total = usage.get("totalTokens", 0) or (
                    in_t + out_t + cache_read + cache_write
                )
                tokens.update({"in": in_t, "out": out_t, "cache_read": cache_read, "cache_write": cache_write, "reasoning": usage.get("reasoning", 0) or 0, "total": total})
                if in_t + cache_read:
                    tokens["hit_rate"] = cache_read / (in_t + cache_read) * 100
                self._provider = message.get("provider") or self._provider
                self._model = message.get("model") or self._model
                cmd_ts = cmd_ts or event.get("timestamp", "")
            if not cmd and message.get("role") == "assistant":
                for call in message.get("content", []):
                    if call.get("type") == "toolCall":
                        name, args = call.get("name", ""), call.get("arguments", {})
                        cmd = (args.get("command", "").strip().split("\n")[0][:300] if name == "bash" else args.get("path", "") if name in ("read", "edit", "write") else name)
                        tool, cmd_ts = name, event.get("timestamp", "")
                        break
            if not last_act and (message.get("role") == "assistant" or event.get("type") == "toolCall"):
                last_act = event.get("timestamp", "")
        if self._provider == "—" or self._model == "—":
            settings = load_json(self.settings_json) or {}
            self._provider = self._provider if self._provider != "—" else settings.get("defaultProvider", "—")
            self._model = self._model if self._model != "—" else settings.get("defaultModel", "—")
        if tokens["total"] and self._provider not in ("—", ""):
            window = self._cache.ctx_win_for(self._provider, self._model)
            if window:
                tokens["ctx_pct"] = min(100, tokens["total"] / window * 100)
        auth_ok = False
        auth = load_json(self.auth_json) or {}
        credential = auth.get(self._provider)
        if isinstance(credential, dict) and credential.get("expires", 0):
            auth_ok = datetime.now(timezone.utc).timestamp() * 1000 < credential["expires"]
        return {"command": cmd, "tool": tool, "cmd_ts": cmd_ts, "last_act_ts": last_act, "tokens": tokens, "thinking": thinking, "provider": self._provider, "model": self._model, "auth_ok": auth_ok, "time": now.strftime("%H:%M:%S")}
