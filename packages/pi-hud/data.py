import glob
import json
import math
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


def iter_jsonl(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            yield from f
    except OSError:
        return


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


SUBAGENT_TOOL_NAMES = frozenset({
    "agent",
    "get_subagent_result",
    "steer_subagent",
    "subagent",
    "subagentworkflow",
})


def _cost_number(value):
    try:
        value = float(value)
    except (TypeError, ValueError):
        return 0.0
    return value if math.isfinite(value) and value > 0 else 0.0


def _cost_value(value):
    if isinstance(value, dict):
        for key in ("total", "totalCost", "costUsd", "cost"):
            if key in value:
                amount = _cost_value(value[key])
                if amount:
                    return amount
        return 0.0
    return _cost_number(value)


def _usage_cost(usage):
    if not isinstance(usage, dict):
        return 0.0
    for key in ("cost", "costUsd", "totalCost"):
        if key in usage:
            amount = _cost_value(usage[key])
            if amount:
                return amount
    return 0.0


def _run_id(details):
    if not isinstance(details, dict):
        return None
    for key in ("runId", "run_id", "asyncId", "async_id", "agentId", "id", "taskId"):
        value = details.get(key)
        if value is not None and value != "":
            return str(value)
    return None


_DETAIL_CHILD_KEYS = ("results", "others", "children", "steps", "nestedChildren", "workflowChildren")
_ASYNC_PATH_KEYS = ("asyncDir", "async_dir", "asyncPath", "async_path")


def _async_detail_keys(details):
    keys = set()

    def visit(value):
        if isinstance(value, dict):
            direct = []
            identity = _run_id(value)
            for key in _ASYNC_PATH_KEYS:
                path = value.get(key)
                if isinstance(path, str) and path:
                    source = os.path.abspath(os.path.expanduser(path))
                    direct.append((source, identity or source, source))
            if direct:
                # A parent async result is already an aggregate of its nested
                # steps; do not also bill their child artifact directories.
                keys.update(direct)
                return
            for key in _DETAIL_CHILD_KEYS:
                child = value.get(key)
                if isinstance(child, list):
                    for item in child:
                        visit(item)
                elif isinstance(child, dict):
                    visit(child)
        elif isinstance(value, list):
            for item in value:
                visit(item)

    visit(details)
    return keys


def _details_cost(details):
    """Read one aggregate cost, or recursively sum child result shapes."""
    if isinstance(details, list):
        return sum(_details_cost(item) for item in details)
    if not isinstance(details, dict):
        return 0.0
    for key in ("totalCost", "total_cost", "cost", "costUsd"):
        if key in details:
            amount = _cost_value(details[key])
            if amount:
                return amount

    children = []
    for key in _DETAIL_CHILD_KEYS:
        value = details.get(key)
        if isinstance(value, list):
            children.extend(value)
        elif isinstance(value, dict):
            children.append(value)
    if children:
        # A SingleResult's usage is its own cost and its children are additional
        # cost. A Details object with `results` already aggregates those usages.
        own = 0.0 if "results" in details else _usage_cost(details.get("usage"))
        return own + sum(_details_cost(item) for item in children)
    return _usage_cost(details.get("usage"))


def _path_is_descendant(path, parent):
    try:
        path = os.path.normcase(os.path.abspath(path))
        parent = os.path.normcase(os.path.abspath(parent))
        return path != parent and os.path.commonpath([path, parent]) == parent
    except ValueError:
        return False


def _artifact_cost(path):
    if not isinstance(path, str) or not path:
        return 0.0
    path = os.path.expanduser(path)
    status_path = path if os.path.basename(path).lower() == "status.json" else os.path.join(path, "status.json")
    status = load_json(status_path)
    if isinstance(status, dict):
        for key in ("totalCost", "total_cost", "cost"):
            amount = _cost_value(status.get(key))
            if amount:
                return amount
        # nicobailon keeps live costs on completed steps and promotes the
        # aggregate to totalCost only when the run settles.
        for key in ("steps", "results"):
            values = status.get(key)
            if isinstance(values, list):
                amount = sum(_details_cost(item) for item in values)
                if amount:
                    return amount
        amount = _details_cost(status)
        if amount:
            return amount

    # A final event can win a status-file write race, so use it as a last
    # fallback. It is an aggregate event, not a sum of child events.
    events_path = os.path.join(os.path.dirname(status_path), "events.jsonl")
    for line in reversed(tail_jsonl(events_path, 100)):
        try:
            event = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(event, dict) and event.get("type") == "subagent.run.completed":
            return _details_cost(event)
    return 0.0


def _agent_is_active(lines):
    for line in reversed(lines):
        try:
            event = json.loads(line)
            event_type = event.get("type")
        except (json.JSONDecodeError, AttributeError):
            continue
        if event_type == "agent_start":
            return True
        if event_type == "agent_settled":
            return False
        if event_type == "custom" and event.get("customType") == "pi-hud:agent-state":
            state = event.get("data")
            if isinstance(state, dict) and "active" in state:
                return bool(state["active"])
    return False


_TINTIN_USAGE_TOOLS = frozenset({"agent", "get_subagent_result", "steer_subagent", "subagentworkflow"})


def _tool_call_target(message, call_targets):
    call_id = message.get("toolCallId") or message.get("tool_call_id")
    if call_id is None:
        return None
    return call_targets.get(str(call_id))


def _subagent_costs(lines):
    lifecycle_costs = {}
    tintin_known_costs = {}
    tintin_unmatched_known = {}
    tintin_unmatched_total = 0.0
    tintin_pending_usage = 0.0
    tintin_usage_ids = set()
    tintin_usage_amounts = []
    external_unkeyed = 0.0
    external_reports = {}
    async_sources = set()
    reported_sources = {}
    async_by_identity = {}

    def mark_reported(keys, amount):
        for source, identity, _ in keys:
            key = (source, identity)
            reported_sources[key] = max(reported_sources.get(key, 0.0), amount)

    def add_tintin_known(run_id, amount):
        nonlocal tintin_pending_usage, tintin_unmatched_total
        if not run_id or amount <= 0:
            return
        previous = tintin_known_costs.get(run_id, 0.0)
        if amount <= previous:
            return
        tintin_known_costs[run_id] = amount
        delta = amount - previous
        covered = min(tintin_pending_usage, delta)
        tintin_pending_usage -= covered
        delta -= covered
        if delta:
            tintin_unmatched_known[run_id] = tintin_unmatched_known.get(run_id, 0.0) + delta
            tintin_unmatched_total += delta

    def add_tintin_usage(run_id, amount):
        nonlocal tintin_pending_usage, tintin_unmatched_total
        if amount <= 0:
            return
        if run_id:
            tintin_usage_ids.add(run_id)
        remaining = amount
        own = 0.0
        if run_id:
            own = min(remaining, tintin_unmatched_known.get(run_id, 0.0))
            if own:
                tintin_unmatched_known[run_id] -= own
                tintin_unmatched_total -= own
                remaining -= own
        # A large keyed drain may include settled work from another run; a
        # small drain for an unrelated target is more likely concurrent work.
        # ponytail: ownerless pools stay heuristic; source attribution would
        # remove this amount-based ceiling.
        if remaining and tintin_unmatched_total and (
            own or not run_id or remaining >= tintin_unmatched_total
        ):
            for known_id, available in list(tintin_unmatched_known.items()):
                if not available:
                    continue
                covered = min(remaining, available)
                tintin_unmatched_known[known_id] -= covered
                tintin_unmatched_total -= covered
                remaining -= covered
                if not remaining:
                    break
        tintin_pending_usage += remaining

    fallbacks = {}
    notification_groups = []
    call_targets = {}

    for line_no, line in enumerate(lines):
        try:
            event = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(event, dict):
            continue
        message = event.get("message")

        if isinstance(message, dict) and message.get("role") == "assistant":
            for call in message.get("content") or []:
                if not isinstance(call, dict) or call.get("type") != "toolCall":
                    continue
                name = str(call.get("name") or "").lower()
                if name not in SUBAGENT_TOOL_NAMES:
                    continue
                args = call.get("arguments")
                if not isinstance(args, dict):
                    continue
                target = next(
                    (args.get(key) for key in ("agent_id", "agentId", "runId", "run_id", "asyncId", "async_id", "id")
                     if args.get(key) not in (None, "")),
                    None,
                )
                call_id = call.get("id") or call.get("toolCallId") or call.get("tool_call_id")
                if call_id is not None and target is not None:
                    call_targets[str(call_id)] = str(target)

        if event.get("type") == "custom" and event.get("customType") == "pi-hud:subagent-cost":
            data = event.get("data")
            run_id = _run_id(data)
            if run_id:
                amount = _details_cost(data)
                lifecycle_costs[run_id] = max(lifecycle_costs.get(run_id, 0.0), amount)
                add_tintin_known(run_id, amount)
            continue

        tool_name = ""
        details = None
        if isinstance(message, dict) and message.get("role") == "toolResult":
            tool_name = str(message.get("toolName") or "").lower()
            details = message.get("details")
        if tool_name in SUBAGENT_TOOL_NAMES:
            run_id = _run_id(details) or _tool_call_target(message, call_targets)
            usage_cost = _usage_cost(message.get("usage"))
            detail_cost = _details_cost(details)
            async_keys = set(_async_detail_keys(details))
            async_keys.update(async_by_identity.get(run_id, ()))
            for async_key in async_keys:
                async_sources.add(async_key)
                async_by_identity.setdefault(async_key[1], set()).add(async_key)
                async_by_identity.setdefault(os.path.basename(async_key[0]), set()).add(async_key)

            if usage_cost:
                if tool_name in _TINTIN_USAGE_TOOLS:
                    # Tintin's usage is a global PendingUsagePool drain (a
                    # delta), while details.cost is the agent's lifetime
                    # total. Match only the part known to belong to a run;
                    # the rest remains global until a later lifecycle record
                    # can reconcile it.
                    tintin_usage_amounts.append(usage_cost)
                    if run_id:
                        add_tintin_known(run_id, detail_cost)
                    add_tintin_usage(run_id, usage_cost)
                elif run_id:
                    # Nicobailon's `usage` omits nested child costs while its
                    # `details.totalCost` includes them; one result must use
                    # the larger aggregate, never add both representations.
                    reported_cost = max(usage_cost, detail_cost)
                    previous = external_reports.get(run_id)
                    keys = set(async_keys)
                    if previous is not None:
                        reported_cost = max(reported_cost, previous[0])
                        keys.update(previous[1])
                    external_reports[run_id] = (reported_cost, keys)
                else:
                    external_unkeyed += max(usage_cost, detail_cost)
            elif detail_cost:
                if tool_name in _TINTIN_USAGE_TOOLS:
                    if run_id:
                        add_tintin_known(run_id, detail_cost)
                    else:
                        key = ("line", line_no)
                        fallbacks[key] = (detail_cost, "tool", run_id, tuple(async_keys), line_no)
                elif run_id:
                    previous = external_reports.get(run_id)
                    keys = set(async_keys)
                    if previous is not None:
                        detail_cost = max(detail_cost, previous[0])
                        keys.update(previous[1])
                    external_reports[run_id] = (detail_cost, keys)
                else:
                    key = ("line", line_no)
                    previous = fallbacks.get(key)
                    if previous is None or detail_cost > previous[0]:
                        fallbacks[key] = (detail_cost, "tool", run_id, tuple(async_keys), line_no)
            continue

        if event.get("type") != "custom_message" or event.get("customType") != "subagent-notification":
            continue
        notification_details = [event.get("details")]
        if isinstance(event.get("details"), dict):
            others = event["details"].get("others")
            if isinstance(others, list):
                notification_details.extend(others)
        group_cost = 0.0
        group_keys = []
        for item_no, item in enumerate(notification_details):
            fallback_cost = _details_cost(item)
            if not fallback_cost:
                continue
            group_cost += fallback_cost
            run_id = _run_id(item)
            async_keys = set(_async_detail_keys(item))
            # Tintin notifications do not carry asyncDir, while the initial
            # tool result does. Link them by run id before adding artifact cost.
            async_keys.update(async_by_identity.get(run_id, ()))
            key = ("id", run_id) if run_id else ("notification", line_no, item_no)
            group_keys.append(key)
            previous = fallbacks.get(key)
            if previous is None or fallback_cost > previous[0]:
                fallbacks[key] = (fallback_cost, "notification", run_id, tuple(async_keys), line_no)
        if group_keys:
            notification_groups.append((group_cost, tuple(group_keys)))

    lifecycle_ids = {run_id for run_id, amount in lifecycle_costs.items() if amount > 0}
    for source, identity, _ in async_sources:
        if identity in lifecycle_ids or os.path.basename(source) in lifecycle_ids:
            amount = lifecycle_costs.get(identity) or lifecycle_costs.get(os.path.basename(source), 0.0)
            if amount:
                mark_reported(((source, identity, source),), amount)

    # A grouped notification lists child IDs, while one Tintin pool drain can
    # carry the group's aggregate under another ID. Match that aggregate once.
    # ponytail: equal-cost concurrent runs remain ambiguous; an owner-aware pool
    # would remove this heuristic.
    suppressed_fallbacks = set()
    available_usage = list(tintin_usage_amounts)
    for group_cost, group_keys in notification_groups:
        for index, usage_amount in enumerate(available_usage):
            if math.isclose(group_cost, usage_amount, rel_tol=1e-9, abs_tol=1e-9):
                suppressed_fallbacks.update(group_keys)
                available_usage.pop(index)
                break

    fallback_total = 0.0
    for fallback_key, (fallback_cost, _kind, run_id, async_keys, _fallback_line) in fallbacks.items():
        if fallback_key in suppressed_fallbacks:
            continue
        if run_id and run_id in lifecycle_costs:
            add_tintin_known(run_id, fallback_cost)
            continue
        if run_id and run_id in external_reports:
            amount, keys = external_reports[run_id]
            external_reports[run_id] = (max(amount, fallback_cost), keys | set(async_keys))
            continue
        if run_id and (run_id in tintin_known_costs or run_id in tintin_usage_ids):
            add_tintin_known(run_id, fallback_cost)
            continue
        fallback_total += fallback_cost
        mark_reported(async_keys, fallback_cost)

    external_total = external_unkeyed
    for run_id, (amount, keys) in external_reports.items():
        if run_id not in lifecycle_ids:
            external_total += amount
        mark_reported(keys, amount)

    for run_id, amount in tintin_known_costs.items():
        mark_reported(async_by_identity.get(run_id, ()), amount)

    # The pool has no owner. Reconcile known lifetime totals against each
    # global drain, and retain only usage that cannot yet be matched to a
    # known run. This preserves concurrent costs without adding a settled run
    # twice when its drain lands on another run's tool result.
    tintin_total = sum(tintin_known_costs.values()) + tintin_pending_usage
    return tintin_total + external_total + fallback_total, async_sources, reported_sources


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
        self._subagents_cost = 0.0
        self._async_sources = set()
        self._reported_async_sources = {}
        self._agent_active = False
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
                self._subagents_cost = 0.0
                self._async_sources = set()
                self._reported_async_sources = {}
                self._agent_active = False
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
            self._subagents_cost = 0.0
            self._async_sources = set()
            self._reported_async_sources = {}
            self._agent_active = False
            if self._on_change:
                self._on_change()
            return
        mtime = os.path.getmtime(filepath)
        if filepath != self._file or mtime != self._mtime:
            self._file = filepath
            self._mtime = mtime
            self._lines = tail_jsonl(filepath, 2000)
            self._cost = 0.0
            for line in iter_jsonl(filepath):
                try:
                    entry = json.loads(line)
                    if not isinstance(entry, dict):
                        continue
                    if entry.get("type") in ("compaction", "branch_summary"):
                        self._cost += _usage_cost(entry.get("usage"))
                        continue
                    message = entry.get("message", {})
                    usage = message.get("usage") or {}
                    role = message.get("role")
                    if usage and (
                        role == "assistant"
                        or role == "toolResult"
                    ):
                        self._cost += _usage_cost(usage)
                except (json.JSONDecodeError, AttributeError, TypeError, ValueError):
                    continue
            (
                self._subagents_cost,
                self._async_sources,
                self._reported_async_sources,
            ) = _subagent_costs(iter_jsonl(filepath))
            self._agent_active = _agent_is_active(self._lines)
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
            self._subagents_cost = 0.0
            self._async_sources = set()
            self._reported_async_sources = {}
            self._agent_active = False
            self._ctx_win = 0
            if self._on_change:
                self._on_change()

    def auto_follow(self):
        self._follow_latest = True
        self._file = None
        self._mtime = 0
        self._lines = []
        self._cost = 0.0
        self._subagents_cost = 0.0
        self._async_sources = set()
        self._reported_async_sources = {}
        self._agent_active = False
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
    def subagents_cost(self):
        self._refresh()
        total = self._subagents_cost
        reported_paths = sorted({source for source, _identity in self._reported_async_sources})
        counted_paths = []
        for source, identity, path in sorted(self._async_sources):
            key = (source, identity)
            if source in counted_paths:
                continue
            if any(
                source != parent and _path_is_descendant(source, parent)
                for parent in reported_paths
            ):
                continue
            if any(
                source == parent or _path_is_descendant(source, parent)
                for parent in counted_paths
            ):
                continue
            if key in self._reported_async_sources:
                amount = _artifact_cost(path)
                total += max(0.0, amount - self._reported_async_sources[key])
                counted_paths.append(source)
                continue
            amount = _artifact_cost(path)
            if amount:
                total += amount
                counted_paths.append(source)
        return total

    @property
    def agent_active(self):
        self._refresh()
        return self._agent_active

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
        tokens = {"in": 0, "out": 0, "cache_read": 0, "cache_write": 0, "reasoning": 0, "total": 0, "cost": self._cache.cost, "subagents_cost": self._cache.subagents_cost, "ctx_pct": 0.0, "hit_rate": 0.0}
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
        return {"command": cmd, "tool": tool, "cmd_ts": cmd_ts, "last_act_ts": last_act, "agent_active": self._cache.agent_active, "tokens": tokens, "thinking": thinking, "provider": self._provider, "model": self._model, "auth_ok": auth_ok, "time": now.strftime("%H:%M:%S")}
