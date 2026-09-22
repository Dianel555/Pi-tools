import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..", "..", "packages", "pi-hud");
const pythonSource = readFileSync(join(packageDir, "pi_hud.py"), "utf8");
const extensionSource = readFileSync(join(packageDir, "index.mjs"), "utf8");
const dataSource = readFileSync(join(packageDir, "data.py"), "utf8");
const themeSource = readFileSync(join(packageDir, "theme.py"), "utf8");
const viewSource = readFileSync(join(packageDir, "view.py"), "utf8");
const readmeSource = readFileSync(join(packageDir, "README.md"), "utf8");

function runPython(code: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.env.PYTHON || "python", ["-c", code], {
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("manual session selection remains stable while another session changes", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-"));
  const sessions = join(root, "sessions");
  const agent = join(root, "agent");
  const script = `
import os, sys, time
sys.path.insert(0, ${JSON.stringify(packageDir)})
os.environ["PI_AGENT_DIR"] = ${JSON.stringify(agent)}
os.environ["PI_CTX_DIR"] = ${JSON.stringify(root)}
import pi_hud
os.makedirs(${JSON.stringify(sessions)}, exist_ok=True)
pi_hud.SESSIONS_DIR = ${JSON.stringify(sessions)}
a = os.path.join(${JSON.stringify(sessions)}, "a.jsonl")
b = os.path.join(${JSON.stringify(sessions)}, "b.jsonl")
open(a, "w", encoding="utf-8").write('{"session":"A"}\\n')
open(b, "w", encoding="utf-8").write('{"session":"B"}\\n')
now = time.time()
os.utime(a, (now - 10, now - 10))
os.utime(b, (now, now))
cache = pi_hud._SessionCache()
assert cache.file == b
assert cache.get_lines() == ['{"session":"B"}\\n']
cache.switch_to(a)
os.utime(b, (now + 10, now + 10))
assert cache.file == a, cache.file
assert cache.get_lines() == ['{"session":"A"}\\n'], cache.get_lines()
`;
  runPython(script, {
    ...process.env,
    PI_AGENT_DIR: agent,
    PI_CTX_DIR: root,
  });
});

test("provider-scoped model mapping prefers models.json and supports runtime aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-model-map-"));
  const models = join(root, "models.json");
  const modelsStore = join(root, "models-store.json");
  writeFileSync(models, JSON.stringify({
    providers: {
      "provider-a": { models: [{ id: "gpt-5.6-luna", name: "Luna" }] },
      other: { models: [{ id: "gpt-5.6-luna-max" }] },
    },
  }));
  writeFileSync(modelsStore, JSON.stringify({
    "provider-a": { models: [{ id: "gpt-5.6-terra" }] },
  }));
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
from data import SessionCache
cache = SessionCache(${JSON.stringify(root)}, ${JSON.stringify(models)})
assert cache.model_for("provider-a", "Luna") == "gpt-5.6-luna"
assert cache.model_for("provider-a", "gpt-5.6-luna-max") == "gpt-5.6-luna"
assert cache.model_for("provider-a", "gpt-5.6-terra") == "gpt-5.6-terra"
assert cache.model_for("other", "gpt-5.6-luna-max") == "gpt-5.6-luna-max"
assert cache.model_for("provider-a", "unknown-model") == "unknown-model"
`;
  runPython(script, process.env);
});

test("saved HUD geometry keeps visible positions and recenters only invisible windows", () => {
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
import pi_hud

class FakeWindow:
    def winfo_vrootx(self): return -1920
    def winfo_vrooty(self): return 0
    def winfo_vrootwidth(self): return 3840
    def winfo_vrootheight(self): return 1080

pi_hud._user32 = None
window = FakeWindow()
assert pi_hud._safe_window_position(window, 680, 100, 2500, 80) == (-340, 490)
assert pi_hud._safe_window_position(window, 680, 100, -2500, 80) == (-2500, 80)
assert pi_hud._safe_window_position(window, 680, 100, -2600, 80) == (-340, 490)
assert pi_hud._safe_window_position(window, 680, 100, -1500, 80) == (-1500, 80)
assert pi_hud._safe_window_position(window, 680, 100, 100, 100) == (100, 100)
`;
  runPython(script, process.env);
  assert.match(pythonSource, /def _virtual_screen_bounds\(window\):/);
  assert.match(pythonSource, /def _screen_rectangles\(window\):/);
  assert.match(pythonSource, /EnumDisplayMonitors/);
  assert.match(pythonSource, /def _safe_window_position\(window, width, height, x, y\):/);
  assert.match(pythonSource, /self\._ensure_on_screen\(\)/);
});

test("window recovery preserves every visible edge and monitor topology", () => {
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
import pi_hud

# A one-pixel intersection is still visible, including all four corners.
screen_rectangles = pi_hud._screen_rectangles
pi_hud._screen_rectangles = lambda _: [(0, 0, 1920, 1080)]
visible = [
    (-679, 0), (1919, 0), (0, -99), (0, 1079),
    (-679, -99), (1919, -99), (-679, 1079), (1919, 1079),
]
for x, y in visible:
    assert pi_hud._safe_window_position(object(), 680, 100, x, y) == (x, y), (x, y)
assert pi_hud._safe_window_position(object(), 680, 100, -680, 0) == (620, 490)
assert pi_hud._safe_window_position(object(), 680, 100, 1920, 0) == (620, 490)
assert pi_hud._safe_window_position(object(), 680, 100, 0, -100) == (620, 490)
assert pi_hud._safe_window_position(object(), 680, 100, 0, 1080) == (620, 490)
# A window larger than the desktop remains where it was if it intersects it.
assert pi_hud._safe_window_position(object(), 3000, 2000, -200, -200) == (-200, -200)

# Gaps in an L-shaped desktop are not visible displays.
pi_hud._screen_rectangles = lambda _: [(0, 0, 1920, 1080), (1920, 1200, 3840, 2280)]
assert pi_hud._safe_window_position(object(), 680, 100, 2000, 100) == (620, 490)
# A topology change makes the old monitor position recover to the remaining one.
pi_hud._screen_rectangles = lambda _: [(0, 0, 1920, 1080), (1920, 0, 3840, 1080)]
assert pi_hud._safe_window_position(object(), 680, 100, 2000, 100) == (2000, 100)
pi_hud._screen_rectangles = lambda _: [(0, 0, 1920, 1080)]
assert pi_hud._safe_window_position(object(), 680, 100, 2000, 100) == (620, 490)
# Negative-coordinate monitors are valid display rectangles.
pi_hud._screen_rectangles = lambda _: [(-1920, -1080, 0, 0), (0, 0, 1920, 1080)]
assert pi_hud._safe_window_position(object(), 680, 100, -1500, -500) == (-1500, -500)
assert pi_hud._safe_window_position(object(), 680, 100, -3000, -500) == (-1300, -590)
# Exercise the Windows callback shape even when the suite runs elsewhere.
import ctypes
from ctypes import wintypes
class WorkingUser32:
    def EnumDisplayMonitors(self, _dc, _clip, callback, _data):
        rect = wintypes.RECT(-1920, -1080, 0, 0)
        callback(None, None, ctypes.pointer(rect), 0)
        return 1
pi_hud._MONITOR_ENUM_PROC = lambda callback: callback
pi_hud._user32 = WorkingUser32()
pi_hud._screen_rectangles = screen_rectangles
assert pi_hud._screen_rectangles(object()) == [(-1920, -1080, 0, 0)]

# If monitor enumeration fails, do not make a false recovery decision.
class FailingUser32:
    def EnumDisplayMonitors(self, *args):
        raise OSError("monitor enumeration failed")
pi_hud._user32 = FailingUser32()
assert pi_hud._screen_rectangles(object()) == []
assert pi_hud._safe_window_position(object(), 680, 100, 9000, 9000) == (9000, 9000)
`;
  runPython(script, process.env);
});

test("moving the HUD skips resize cleanup and remains stable in later polls", () => {
  const script = `
from types import SimpleNamespace
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
import pi_hud

hud = pi_hud.HUD.__new__(pi_hud.HUD)
hud._drag = {"mode": "move"}
hud._geometry_idle = "geometry-idle"
hud._footer_idle = "footer-idle"
hud._pending_geometry = (999, 999, 999, 999)
hud._alpha = 0.95
hud._lw = 680
hud._lh = 100
cancelled = []
hud.after_cancel = lambda timer: cancelled.append(timer)
configure_events = []
hud._sync_wraplength = lambda width=None: configure_events.append(width)
updates = []
def update_idletasks():
    assert hud._drag is not None
    pi_hud.HUD._on_config(
        hud, SimpleNamespace(widget=hud, width=682, height=102)
    )
    updates.append("idletasks")
hud.update_idletasks = update_idletasks
calls = []
hud.attributes = lambda *args: calls.append(("attributes", *args))
def ensure_on_screen():
    assert hud._drag is None
    calls.append("ensure")
hud._ensure_on_screen = ensure_on_screen
hud._save_geom = lambda: calls.append("save")
hud._apply_pending_geometry = lambda: calls.append("apply")
hud._update_scale = lambda *args: (_ for _ in ()).throw(AssertionError("move must not rescale"))
hud._apply_fonts = lambda: (_ for _ in ()).throw(AssertionError("move must not reapply fonts"))
hud._sync_footer_height = lambda *args: (_ for _ in ()).throw(AssertionError("move must not relayout"))
hud._fit_footer_window = lambda: (_ for _ in ()).throw(AssertionError("move must not fit footer"))
pi_hud.HUD._on_release(hud, None)
assert hud._drag is None
assert hud._pending_geometry is None
assert cancelled == ["geometry-idle", "footer-idle"]
assert updates == ["idletasks"]
assert configure_events == [682]
assert calls == [("attributes", "-alpha", 0.95), "ensure", "save"]

# Footer callbacks must also ignore a pure move, including an already queued idle.
footer_hud = pi_hud.HUD.__new__(pi_hud.HUD)
footer_hud._drag = {"mode": "move"}
footer_hud._footer_idle = "queued-footer"
footer_hud._queue_footer_sync = lambda: (_ for _ in ()).throw(AssertionError("move queued footer sync"))
footer_hud._sync_footer_height = lambda *args: (_ for _ in ()).throw(AssertionError("move ran footer resize"))
pi_hud.HUD._on_footer_configure(footer_hud, None)
pi_hud.HUD._sync_footer_after_resize(footer_hud)
assert footer_hud._footer_idle is None

# The actual recovery guard must not write while a move is active, even off-screen.
drag_hud = pi_hud.HUD.__new__(pi_hud.HUD)
drag_hud._drag = {"mode": "move"}
drag_hud.state = lambda: "normal"
drag_hud.winfo_width = lambda: 680
drag_hud.winfo_height = lambda: 100
drag_hud.winfo_x = lambda: 9000
drag_hud.winfo_y = lambda: 9000
drag_hud.geometry_calls = []
drag_hud.geometry = lambda value: drag_hud.geometry_calls.append(value)
drag_hud._save_geom = lambda: drag_hud.geometry_calls.append("save")
pi_hud._screen_rectangles = lambda _: [(0, 0, 1920, 1080)]
pi_hud.HUD._ensure_on_screen(drag_hud)
assert drag_hud.geometry_calls == []

# Repeated polling/configure cycles must not rewrite a still-visible position or size.
poll_hud = pi_hud.HUD.__new__(pi_hud.HUD)
poll_hud._drag = None
poll_hud.state = lambda: "normal"
poll_hud.winfo_width = lambda: 680
poll_hud.winfo_height = lambda: 100
poll_hud.winfo_x = lambda: -1
poll_hud.winfo_y = lambda: 80
poll_hud.geometry_calls = []
poll_hud.geometry = lambda value: poll_hud.geometry_calls.append(value)
poll_hud._save_geom = lambda: poll_hud.geometry_calls.append("save")
pi_hud._screen_rectangles = lambda _: [(0, 0, 1920, 1080)]
for _ in range(3):
    pi_hud.HUD._ensure_on_screen(poll_hud)
assert poll_hud.geometry_calls == []
assert (poll_hud.winfo_width(), poll_hud.winfo_height(), poll_hud.winfo_x()) == (680, 100, -1)
poll_hud._lw = 680
poll_hud._lh = 100
poll_hud._update_scale = lambda *args: (_ for _ in ()).throw(AssertionError("same-size configure must be ignored"))
poll_hud._sync_wraplength = lambda *args: None
pi_hud.HUD._on_config(poll_hud, SimpleNamespace(widget=poll_hud, width=680, height=100))
`;
  runPython(script, process.env);
});

test("negative saved coordinates round-trip and minimized HUD is not repositioned", () => {
  const script = `
import json, sys, tempfile
sys.path.insert(0, ${JSON.stringify(packageDir)})
import pi_hud

pi_hud._user32 = None
pi_hud._screen_rectangles = lambda _: [(0, 0, 1920, 1080)]
with tempfile.TemporaryDirectory() as temp:
    cfg = temp + "/geometry.json"
    geometry = ["680x100+-1+-2"]
    hud = pi_hud.HUD.__new__(pi_hud.HUD)
    hud._theme_name = "dark"
    def geometry_manager(value=None):
        if value is not None:
            geometry[0] = value
        return geometry[0]
    hud.geometry = geometry_manager
    pi_hud.CFG_FILE = cfg
    pi_hud.HUD._save_geom(hud)
    with open(cfg, encoding="utf-8") as f:
        assert json.load(f)["g"] == "680x100+-1+-2"
    geometry[0] = "680x100+120+80"
    pi_hud.HUD._load_geom(hud)
    assert geometry[0] == "680x100+-1+-2", geometry[0]

minimized = pi_hud.HUD.__new__(pi_hud.HUD)
minimized._drag = None
minimized.state = lambda: "iconic"
minimized.winfo_width = lambda: 680
minimized.winfo_height = lambda: 100
minimized.winfo_x = lambda: 2500
minimized.winfo_y = lambda: 80
minimized.geometry_calls = []
minimized.geometry = lambda value: minimized.geometry_calls.append(value)
pi_hud.HUD._ensure_on_screen(minimized)
assert minimized.geometry_calls == []
`;
  runPython(script, process.env);
});

test("manual model config overrides automatic provider mapping", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-manual-model-"));
  const models = join(root, "models.json");
  const manual = join(root, "model_config.json");
  writeFileSync(models, JSON.stringify({
    providers: { "provider-a": { models: [{ id: "configured-model" }] } },
  }));
  writeFileSync(manual, JSON.stringify({
    mappings: { "provider-a": { "runtime-model": "manual-model" } },
    contextWindows: { "provider-a": { "manual-model": 999000 } },
  }));
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
from data import SessionCache
cache = SessionCache(${JSON.stringify(root)}, ${JSON.stringify(models)}, ${JSON.stringify(manual)})
assert cache.model_for("provider-a", "runtime-model") == "manual-model"
assert cache.ctx_win_for("provider-a", "manual-model") == 999000
`;
  runPython(script, process.env);
});

test("context windows use the active model instead of the provider's first model", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-ctx-"));
  const models = join(root, "models.json");
  const modelsStore = join(root, "models-store.json");
  writeFileSync(
    models,
    JSON.stringify({
      providers: {
        "provider-a": {
          models: [{ id: "claude-opus-5", contextWindow: 372000 }],
        },
        "provider-b": {
          models: [{ id: "gpt-5.6-sol", contextWindow: 372000 }],
        },
        "provider-c": {
          modelOverrides: {
            "gpt-5.6-sol": { contextWindow: 1050000 },
          },
        },
      },
    }),
  );
  writeFileSync(
    modelsStore,
    JSON.stringify({
      "provider-c": {
        models: [
          { id: "gpt-5.6-sol", contextWindow: 272000 },
          { id: "gpt-5.6-terra", contextWindow: 272000 },
        ],
      },
    }),
  );
  writeFileSync(
    join(root, "model_config.json"),
    JSON.stringify({
      mappings: {
        "provider-a": {
          "gpt-5.6-luna-max": "gpt-5.6-luna-max",
          "gpt-5.6-terra-ultra": "gpt-5.6-terra-ultra",
        },
      },
      contextWindows: {
        "provider-a": {
          "gpt-5.6-luna-max": 272000,
          "gpt-5.6-terra-ultra": 272000,
        },
      },
    }),
  );
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
from data import SessionCache
cache = SessionCache(${JSON.stringify(root)}, ${JSON.stringify(models)}, ${JSON.stringify(join(root, "model_config.json"))})
assert cache.ctx_win_for("provider-a", "gpt-5.6-luna-max") == 272000
assert cache.ctx_win_for("provider-a", "gpt-5.6-terra-ultra") == 272000
assert cache.ctx_win_for("provider-c", "gpt-5.6-terra") == 272000
assert cache.ctx_win_for("provider-c", "gpt-5.6-sol") == 1050000
assert cache.ctx_win_for("provider-b", "gpt-5.6-sol") == 372000
assert cache.ctx_win_for("provider-a", "unknown-model") == 0
`;
  runPython(script, { ...process.env, PI_AGENT_DIR: root });
});

test("session cost separates subagent usage and async artifacts without double counting", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-subagents-"));
  const session = join(root, "session.jsonl");
  const asyncDir = join(root, "async-run");
  const events = [
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { cost: { total: 1.25 } },
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "Agent",
        usage: { cost: { total: 0.5 } },
        details: { id: "agent-1" },
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "subagent",
        details: { runId: "async-1", asyncDir },
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "subagent",
        usage: { cost: { total: 0.75 } },
        details: { runId: "async-1", asyncDir },
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "SubagentWorkflow",
        usage: { costUsd: 0.4 },
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "unknown-subagent-tool",
        usage: { cost: { total: 9 } },
      },
    },
  ];
  mkdirSync(asyncDir, { recursive: true });
  writeFileSync(join(asyncDir, "status.json"), JSON.stringify({
    runId: "async-1",
    status: "completed",
    totalCost: { costUsd: 0.75 },
  }));
  writeFileSync(session, events.map((event) => JSON.stringify(event)).join("\n") + "\n");

  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
from data import SessionCache
cache = SessionCache(${JSON.stringify(root)}, ${JSON.stringify(join(root, "models.json"))})
assert round(cache.cost, 2) == 11.9
assert round(cache.subagents_cost, 2) == 1.65, cache.subagents_cost
`;
  runPython(script, process.env);
});

test("main cost includes Pi compaction and branch-summary usage", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-main-cost-"));
  const session = join(root, "session.jsonl");
  writeFileSync(
    session,
    [
      { type: "message", message: { role: "assistant", usage: { cost: { total: 0.1 } } } },
      { type: "compaction", usage: { cost: { total: 0.2 } } },
      { type: "branch_summary", usage: { cost: { total: 0.3 } } },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
from data import SessionCache
cache = SessionCache(${JSON.stringify(root)}, ${JSON.stringify(join(root, "models.json"))})
assert round(cache.cost, 2) == 0.6, cache.cost
`;
  runPython(script, process.env);
});

test("main cost matches Pi by including usage reported by subagent tools", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-pi-cost-"));
  writeFileSync(
    join(root, "session.jsonl"),
    [
      { type: "message", message: { role: "assistant", usage: { cost: { total: 12.89186324 } } } },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "steer_subagent",
          usage: { cost: { total: 1.11484 } },
        },
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
from data import SessionCache
cache = SessionCache(${JSON.stringify(root)}, ${JSON.stringify(join(root, "models.json"))})
assert abs(cache.cost - 14.00670324) < 1e-9, cache.cost
assert abs(cache.subagents_cost - 1.11484) < 1e-9, cache.subagents_cost
`;
  runPython(script, process.env);
});

test("grouped notifications do not duplicate an aggregate Tintin usage drain", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-group-dedup-"));
  const session = join(root, "session.jsonl");
  writeFileSync(
    session,
    [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "Agent",
          usage: { cost: { total: 0.04483852 } },
          details: { agentId: "group-result" },
        },
      },
      {
        type: "custom_message",
        customType: "subagent-notification",
        details: {
          id: "child-a",
          totalCost: 0.01607804,
          others: [
            { id: "child-b", totalCost: 0.01622604 },
            { id: "child-c", totalCost: 0.01253444 },
          ],
        },
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
from data import SessionCache
cache = SessionCache(${JSON.stringify(root)}, ${JSON.stringify(join(root, "models.json"))})
assert round(cache.subagents_cost, 8) == 0.04483852, cache.subagents_cost
`;
  runPython(script, process.env);
});

test("notification cost is not duplicated when the usage result has another run id", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-mismatched-dedup-"));
  const session = join(root, "session.jsonl");
  writeFileSync(
    session,
    [
      {
        type: "custom_message",
        customType: "subagent-notification",
        details: { id: "notification-run", totalCost: 0.05374 },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "call-result",
            name: "get_subagent_result",
            arguments: { agent_id: "usage-run" },
          }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-result",
          toolName: "get_subagent_result",
          usage: { cost: { total: 0.05374 } },
        },
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
from data import SessionCache
cache = SessionCache(${JSON.stringify(root)}, ${JSON.stringify(join(root, "models.json"))})
assert round(cache.subagents_cost, 8) == 0.05374, cache.subagents_cost
`;
  runPython(script, process.env);
});

test("reported usage supersedes a prior completion notification", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-subagent-dedup-"));
  const session = join(root, "session.jsonl");
  writeFileSync(
    session,
    [
      {
        type: "custom_message",
        customType: "subagent-notification",
        details: { id: "background-1", totalCost: 0.7 },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "call-get-result",
            name: "get_subagent_result",
            arguments: { agent_id: "background-1" },
          }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-get-result",
          toolName: "get_subagent_result",
          usage: { cost: { total: 0.7 } },
        },
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
from data import SessionCache
cache = SessionCache(${JSON.stringify(root)}, ${JSON.stringify(join(root, "models.json"))})
assert round(cache.subagents_cost, 2) == 0.7, cache.subagents_cost
`;
  runPython(script, process.env);
});

test("partial usage does not replace a notification aggregate", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-subagent-partial-"));
  const session = join(root, "session.jsonl");
  writeFileSync(
    session,
    [
      { type: "custom_message", customType: "subagent-notification", details: { id: "run-a", totalCost: 0.7 } },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "subagent",
          details: { runId: "run-a" },
          usage: { cost: { total: 0.2 } },
        },
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
from data import SessionCache
cache = SessionCache(${JSON.stringify(root)}, ${JSON.stringify(join(root, "models.json"))})
assert round(cache.subagents_cost, 2) == 0.7, cache.subagents_cost
`;
  runPython(script, process.env);
});

test("notification fallback is not suppressed by an unrelated concurrent usage report", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-subagent-concurrent-"));
  const session = join(root, "session.jsonl");
  writeFileSync(
    session,
    [
      { type: "custom_message", customType: "subagent-notification", details: { id: "run-a", totalCost: 0.7 } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-b", name: "get_subagent_result", arguments: { agent_id: "run-b" } }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-b",
          toolName: "get_subagent_result",
          usage: { cost: { total: 0.2 } },
        },
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
from data import SessionCache
cache = SessionCache(${JSON.stringify(root)}, ${JSON.stringify(join(root, "models.json"))})
assert round(cache.subagents_cost, 2) == 0.9, cache.subagents_cost
`;
  runPython(script, process.env);
});

test("subagent detail costs work when usage reporting is disabled", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-subagent-details-"));
  const session = join(root, "session.jsonl");
  writeFileSync(
    session,
    [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "Agent",
          details: { agentId: "foreground-1", cost: 0.6 },
        },
      },
      {
        type: "custom_message",
        customType: "subagent-notification",
        details: {
          id: "background-1",
          totalCost: 0.7,
          others: [{ id: "background-2", totalCost: { costUsd: 0.2 } }],
        },
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
from data import SessionCache
cache = SessionCache(${JSON.stringify(root)}, ${JSON.stringify(join(root, "models.json"))})
assert round(cache.subagents_cost, 2) == 1.5, cache.subagents_cost
`;
  runPython(script, process.env);
});

test("lifecycle cost markers survive consumed and unreported subagents", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-subagent-ledger-"));
  const session = join(root, "session.jsonl");
  const asyncDir = join(root, "async-run");
  mkdirSync(asyncDir, { recursive: true });
  writeFileSync(join(asyncDir, "status.json"), JSON.stringify({ totalCost: { costUsd: 0.8 } }));
  writeFileSync(
    session,
    [
      { type: "custom", customType: "pi-hud:subagent-cost", data: { id: "run-a", cost: 0.8 } },
      { type: "custom", customType: "pi-hud:subagent-cost", data: { id: "run-a", cost: 0.6 } },
      { type: "custom", customType: "pi-hud:subagent-cost", data: { id: "run-b", cost: 0.4 } },
      { type: "custom", customType: "pi-hud:subagent-cost", data: { id: "run-zero", cost: 0 } },
      { type: "custom_message", customType: "subagent-notification", details: { id: "run-a", totalCost: 0.8 } },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "Agent",
          usage: { cost: { total: 0.8 } },
          details: { agentId: "run-a", asyncDir },
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "Agent",
          details: { agentId: "run-zero", cost: 0.6 },
        },
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
from data import SessionCache
cache = SessionCache(${JSON.stringify(root)}, ${JSON.stringify(join(root, "models.json"))})
assert round(cache.subagents_cost, 2) == 1.8, cache.subagents_cost
`;
  runPython(script, process.env);
  assert.match(extensionSource, /pi\.events\.on\("subagents:completed"/);
  assert.match(extensionSource, /pi\.events\.on\("subagents:failed"/);
  assert.match(extensionSource, /SUBAGENT_COST_ENTRY/);
});

test("global usage drains do not double count later lifecycle markers", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-subagent-pool-"));
  writeFileSync(
    join(root, "session.jsonl"),
    [
      { type: "custom", customType: "pi-hud:subagent-cost", data: { id: "run-a", cost: 0.8 } },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "Agent",
          usage: { cost: { total: 1.0 } },
          details: { agentId: "run-a" },
        },
      },
      { type: "custom", customType: "pi-hud:subagent-cost", data: { id: "run-b", cost: 0.2 } },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
from data import SessionCache
cache = SessionCache(${JSON.stringify(root)}, ${JSON.stringify(join(root, "models.json"))})
assert round(cache.subagents_cost, 2) == 1.0, cache.subagents_cost
`;
  runPython(script, process.env);
});

test("resumed Tintin usage uses deltas instead of lifetime detail totals", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-subagent-resume-"));
  writeFileSync(
    join(root, "session.jsonl"),
    [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "Agent",
          usage: { cost: { total: 0.8 } },
          details: { agentId: "run-a", cost: 0.8 },
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "Agent",
          usage: { cost: { total: 0.2 } },
          details: { agentId: "run-a", cost: 0.8 },
        },
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
from data import SessionCache
cache = SessionCache(${JSON.stringify(root)}, ${JSON.stringify(join(root, "models.json"))})
assert round(cache.subagents_cost, 2) == 1.0, cache.subagents_cost
`;
  runPython(script, process.env);
});

test("concurrent lifecycle and keyed usage costs are both counted", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-subagent-concurrent-"));
  writeFileSync(
    join(root, "session.jsonl"),
    [
      { type: "custom", customType: "pi-hud:subagent-cost", data: { id: "run-a", cost: 0.8 } },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "Agent",
          usage: { cost: { total: 0.2 } },
          details: { agentId: "run-b" },
        },
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
from data import SessionCache
cache = SessionCache(${JSON.stringify(root)}, ${JSON.stringify(join(root, "models.json"))})
assert round(cache.subagents_cost, 2) == 1.0, cache.subagents_cost
`;
  runPython(script, process.env);
});

test("ownerless pool drains after a run do not hide concurrent spend", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-subagent-ownerless-pool-"));
  writeFileSync(
    join(root, "session.jsonl"),
    [
      { type: "custom", customType: "pi-hud:subagent-cost", data: { id: "run-a", cost: 0.8 } },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "Agent",
          usage: { cost: { total: 0.8 } },
          details: { agentId: "run-a", cost: 0.8 },
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "Agent",
          usage: { cost: { total: 0.2 } },
          details: { agentId: "run-a", cost: 0.8 },
        },
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
from data import SessionCache
cache = SessionCache(${JSON.stringify(root)}, ${JSON.stringify(join(root, "models.json"))})
assert round(cache.subagents_cost, 2) == 1.0, cache.subagents_cost
`;
  runPython(script, process.env);
});

test("a large keyed pool drain reconciles known runs before residual spend", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-subagent-pool-reconcile-"));
  writeFileSync(
    join(root, "session.jsonl"),
    [
      { type: "custom", customType: "pi-hud:subagent-cost", data: { id: "run-a", cost: 0.8 } },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "get_subagent_result",
          usage: { cost: { total: 1.0 } },
          details: { agentId: "run-b" },
        },
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
from data import SessionCache
cache = SessionCache(${JSON.stringify(root)}, ${JSON.stringify(join(root, "models.json"))})
assert round(cache.subagents_cost, 2) == 1.0, cache.subagents_cost
`;
  runPython(script, process.env);
});

test("nested result costs prefer the aggregate and async status files stay live", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-subagent-nested-"));
  const session = join(root, "session.jsonl");
  const asyncDir = join(root, "async-run");
  mkdirSync(asyncDir, { recursive: true });
  writeFileSync(join(asyncDir, "status.json"), JSON.stringify({
    runId: "async-run",
    status: "running",
    steps: [{ usage: { cost: { total: 0.4 } } }],
  }));
  writeFileSync(
    session,
    [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "subagent",
          usage: { cost: { total: 0.4 } },
          details: {
            runId: "aggregate-run",
            cost: 0.4,
            totalCost: { costUsd: 0.9 },
            results: [{ usage: { cost: { total: 0.4 } }, children: [{ totalCost: 0.5 }] }],
          },
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "subagent",
          details: { runId: "async-run", asyncDir },
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "subagent",
          details: {
            runId: "nested-run",
            results: [{ usage: { cost: { total: 0.2 } }, children: [{ cost: 0.3 }] }],
          },
        },
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
from data import SessionCache
root = ${JSON.stringify(root)}
cache = SessionCache(root, ${JSON.stringify(join(root, "models.json"))})
assert round(cache.subagents_cost, 2) == 1.8, cache.subagents_cost
with open(${JSON.stringify(join(asyncDir, "status.json"))}, "w", encoding="utf-8") as f:
    json.dump({"runId": "async-run", "status": "completed", "totalCost": {"costUsd": 1.1}}, f)
assert round(cache.subagents_cost, 2) == 2.5, cache.subagents_cost
`;
  runPython(script, process.env);
});

test("partial async usage is completed by its status artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-subagent-async-partial-"));
  const session = join(root, "session.jsonl");
  const asyncDir = join(root, "async-run");
  mkdirSync(asyncDir, { recursive: true });
  writeFileSync(join(asyncDir, "status.json"), JSON.stringify({ totalCost: { costUsd: 0.75 } }));
  writeFileSync(
    session,
    JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "subagent",
        usage: { cost: { total: 0.2 } },
        details: { runId: "async-run", asyncDir },
      },
    }) + "\n",
  );
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
from data import SessionCache
cache = SessionCache(${JSON.stringify(root)}, ${JSON.stringify(join(root, "models.json"))})
assert round(cache.subagents_cost, 2) == 0.75, cache.subagents_cost
`;
  runPython(script, process.env);
});

test("async result costs link back to the original artifact run", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-subagent-async-link-"));
  const session = join(root, "session.jsonl");
  const asyncDir = join(root, "async-run");
  mkdirSync(asyncDir, { recursive: true });
  writeFileSync(join(asyncDir, "status.json"), JSON.stringify({ totalCost: { costUsd: 0.75 } }));
  writeFileSync(
    session,
    [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "subagent",
          details: { runId: "async-run", asyncDir },
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "subagent",
          details: { runId: "async-run", totalCost: { costUsd: 0.75 } },
        },
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
from data import SessionCache
cache = SessionCache(${JSON.stringify(root)}, ${JSON.stringify(join(root, "models.json"))})
assert round(cache.subagents_cost, 2) == 0.75, cache.subagents_cost
`;
  runPython(script, process.env);
});

test("persisted cost markers remain visible beyond the display tail", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-subagent-history-"));
  const session = join(root, "session.jsonl");
  const events = [
    { type: "custom", customType: "pi-hud:subagent-cost", data: { id: "old-run", cost: 0.85 } },
    ...Array.from({ length: 2100 }, () => ({ type: "message", message: { role: "user", content: "keep" } })),
  ];
  writeFileSync(session, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
from data import SessionCache
cache = SessionCache(${JSON.stringify(root)}, ${JSON.stringify(join(root, "models.json"))})
assert round(cache.subagents_cost, 2) == 0.85, cache.subagents_cost
`;
  runPython(script, process.env);
});

test("lifecycle events determine whether the HUD is active", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-lifecycle-"));
  const session = join(root, "session.jsonl");
  writeFileSync(
    session,
    [
      { type: "custom", customType: "pi-hud:agent-state", data: { active: true } },
      { type: "agent_end", willRetry: true },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
from data import SessionCache
cache = SessionCache(${JSON.stringify(root)}, ${JSON.stringify(join(root, "models.json"))})
assert cache.agent_active is True
with open(${JSON.stringify(session)}, "a", encoding="utf-8") as f:
    f.write('{"type":"custom","customType":"pi-hud:agent-state","data":{"active":false}}\\n')
cache._mtime = 0
assert cache.agent_active is False
`;
  runPython(script, process.env);
  assert.match(viewSource, /agent_active/);
});

test("bell state, subagent cost footer, and visible name have regression guards", () => {
  assert.match(extensionSource, /AGENT_STATE_ENTRY/);
  assert.match(extensionSource, /pi\.appendEntry\(AGENT_STATE_ENTRY, \{ active \}\)/);
  assert.match(pythonSource, /self\.lbl_bell = tk\.Label\(status_group, text="🔔"/);
  assert.match(pythonSource, /BASE_FONT \+ 8/);
  assert.match(pythonSource, /def _shake_bell\(self\):/);
  assert.match(pythonSource, /self\.after\(140, self\._shake_bell\)/);
  assert.match(viewSource, /agent_active/);
  assert.doesNotMatch(viewSource, /60s/);
  assert.match(viewSource, /_fmt_money\(cost\).*_fmt_money\(subagents_cost\)/s);
  assert.match(viewSource, /Pi.*subagents/);
  assert.match(pythonSource, /● Pi Task Monitor/);
  assert.match(readmeSource, /# Pi Task Monitor/);

  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
import pi_hud

class FakeLabel:
    def __init__(self):
        self.values = {}
    def config(self, **kwargs):
        self.values.update(kwargs)

hud = pi_hud.HUD.__new__(pi_hud.HUD)
hud.lbl_bell = FakeLabel()
hud._bell_active = False
hud._bell_frame = 0
hud._bell_after = None
hud.after = lambda delay, callback: (delay, callback)
cancelled = []
hud.after_cancel = lambda timer: cancelled.append(timer)
pi_hud.HUD._set_bell(hud, True, "cyan")
assert hud.lbl_bell.values["fg"] == "cyan"
assert hud._bell_after[0] == 140
pi_hud.HUD._set_bell(hud, False, "dim")
assert cancelled and hud.lbl_bell.values["text"] == "🔔"
`;
  runPython(script, process.env);
});

test("context usage falls back to the latest usage components", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-usage-"));
  const session = join(root, "session.jsonl");
  writeFileSync(
    join(root, "models-store.json"),
    JSON.stringify({
      "provider-c": {
        models: [{ id: "gpt-5.6-terra", contextWindow: 272000 }],
      },
    }),
  );
  writeFileSync(
    session,
    [
      {
        timestamp: "2026-01-01T00:00:00Z",
        message: {
          role: "assistant",
          provider: "provider-a",
          model: "old-model",
          usage: { input: 100, output: 100, totalTokens: 200 },
        },
      },
      {
        timestamp: "2026-01-01T00:01:00Z",
        message: {
          role: "assistant",
          provider: "provider-c",
          model: "gpt-5.6-terra",
          usage: {
            input: 1000,
            output: 100,
            cacheRead: 17100,
            cacheWrite: 0,
            reasoning: 50,
          },
        },
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  const script = `
import os, sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
from data import Collector
root = ${JSON.stringify(root)}
collector = Collector(
    root,
    os.path.join(root, "settings.json"),
    os.path.join(root, "models.json"),
    os.path.join(root, "auth.json"),
)
result = collector.collect()
assert result["provider"] == "provider-c"
assert result["model"] == "gpt-5.6-terra"
assert result["tokens"]["total"] == 18200
assert round(result["tokens"]["ctx_pct"], 1) == 6.7
`;
  runPython(script, process.env);
});

test("HUD themes include dark, white, and paper palettes", () => {
  const script = `
import os, sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
import pi_hud
assert {"dark", "white", "paper"}.issubset(pi_hud.THEMES)
keys = set(pi_hud.C.keys())
for theme in ("dark", "white", "paper"):
    assert set(pi_hud.THEMES[theme]) == keys
assert pi_hud.THEMES["white"]["bg"] != pi_hud.THEMES["dark"]["bg"]
assert pi_hud.THEMES["paper"]["bg"] != pi_hud.THEMES["white"]["bg"]
`;
  runPython(script, process.env);
});

test("resize hit testing and footer layout have regression guards", () => {
  assert.match(pythonSource, /x <= RESIZE_BORDER/);
  assert.match(pythonSource, /x >= w - RESIZE_BORDER/);
  assert.match(pythonSource, /y <= RESIZE_BORDER/);
  assert.match(pythonSource, /y >= h - RESIZE_BORDER/);
  assert.match(pythonSource, /wrap="char"/);
  assert.match(pythonSource, /RESIZE_BORDER = 12/);
  assert.match(pythonSource, /widget\.bindtags\(\(str\(widget\), str\(self\), "all", widget\.winfo_class\(\)\)\)/);
  assert.match(pythonSource, /if "t" in ed:/);
  assert.match(pythonSource, /if "b" in ed:/);
  assert.match(pythonSource, /def _content_min_height\(self\):/);
  assert.match(pythonSource, /min_h = max\(MIN_H, self\._content_min_height\(\)\)/);
});

test("footer is compact and clock is beside the status", () => {
  assert.match(pythonSource, /DEFAULT_W, DEFAULT_H = 680, 100/);
  assert.match(pythonSource, /MIN_W, MIN_H = 480, 76/);
  assert.match(pythonSource, /TITLE_H = 24/);
  assert.match(pythonSource, /status_row = tk\.Frame\(body/);
  assert.match(pythonSource, /self\.lbl_time\.pack\(side="left"/);
  assert.match(pythonSource, /self\._set_cursor\(evt\.widget, "size_nw_se"\)/);
  assert.match(pythonSource, /def _quit\(self\):\r?\n        self\._save_geom\(\)/);
  assert.doesNotMatch(pythonSource, /self\.txt_footer\.configure\(height=2\)/);
  assert.match(pythonSource, /self\._sync_footer_height\(resizing=True\)/);
  assert.match(pythonSource, /self\.attributes\("-alpha", 1\.0\)/);
  assert.match(pythonSource, /def _queue_geometry\(self, width, height, x, y\)/);
});

test("titlebar right-side controls are ordered pin, minimize, close", () => {
  const pin = pythonSource.indexOf('self.btn_pin.pack(side="right"');
  const minimize = pythonSource.indexOf('self.btn_min.pack(side="right"');
  const close = pythonSource.indexOf('self.btn_x.pack(side="right"');
  assert.ok(pin >= 0 && minimize >= 0 && close >= 0);
  assert.ok(close < minimize && minimize < pin);
});


test("HUD startup is idempotent and restart-safe across terminals", () => {
  assert.match(extensionSource, /randomUUID/);
  assert.match(extensionSource, /pi-hud-pids/);
  assert.match(extensionSource, /registerTerminal/);
  assert.match(extensionSource, /PI_HUD_DIR/);
  assert.match(extensionSource, /pythonw/);
  assert.match(extensionSource, /hudProcess\.once\("error"/);
  assert.match(extensionSource, /deactivate: \(\) => \{\}/);
  assert.doesNotMatch(extensionSource, /process\.on\("beforeExit"/);
  assert.doesNotMatch(extensionSource, /process\.kill\(oldPid,\s*["']SIGTERM["']\)/);
  assert.match(pythonSource, /HUD_DIR = os\.getenv\("PI_HUD_DIR"/);
  assert.match(pythonSource, /O_EXCL/);
  assert.match(pythonSource, /MANAGED_MODE/);
  assert.match(themeSource, /THEMES = \{/);
  assert.match(dataSource, /model_config\.json/);
});

test("resize retains named Tk fonts until their sizes are updated", () => {
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
import pi_hud

class FakeFont:
    def __init__(self, size):
        self.size = size
    def configure(self, **kwargs):
        self.size = kwargs.get("size", self.size)

hud = pi_hud.HUD.__new__(pi_hud.HUD)
hud._scale = 1.0
font = FakeFont(12)
hud._font_cache = {(False, 12, "normal"): font}
hud._update_scale(1360, 200)
assert hud._font_cache[(False, 12, "normal")] is font
assert font.size == 24
`;
  runPython(script, process.env);
});

test("queued resize geometry keeps named fonts in sync during drag", () => {
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
import pi_hud

class FakeFont:
    def __init__(self):
        self.sizes = []
    def configure(self, **kwargs):
        self.sizes.append(kwargs["size"])

hud = pi_hud.HUD.__new__(pi_hud.HUD)
hud._scale = 1.0
font = FakeFont()
hud._font_cache = {(False, 12, "normal"): font}
hud._pending_geometry = (1360, 200, 0, 0)
hud.geometry = lambda value: None
hud._geometry_idle = "resize-idle"
hud._drag = object()
pi_hud.HUD._apply_pending_geometry(hud)
assert font.sizes == [24]
hud._geometry_idle = None
hud._footer_idle = None
hud._alpha = 0.95
hud.update_idletasks = lambda: None
hud.winfo_width = lambda: 1360
hud.winfo_height = lambda: 200
hud._apply_fonts = lambda: None
hud._sync_footer_height = lambda: None
hud.attributes = lambda *args: None
hud._save_geom = lambda: None
pi_hud.HUD._on_release(hud, None)
assert font.sizes == [24, 24]
`;
  runPython(script, process.env);
});

test("footer follows one or two display rows without resize reentry", () => {
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
import pi_hud

class FakeText:
    def __init__(self, display_lines):
        self.display_lines = display_lines
        self.heights = []
    def count(self, *args):
        assert args == ("1.0", "end-1c", "update", "displaylines")
        return (self.display_lines,)
    def configure(self, **kwargs):
        self.heights.append(kwargs["height"])

def fail_min_size():
    raise AssertionError("resize must not recalculate the minimum size")

hud = pi_hud.HUD.__new__(pi_hud.HUD)
hud._footer_syncing = False
hud._footer_lines = 2
hud._drag = object()
hud.txt_footer = FakeText(0)
hud._set_min_size = fail_min_size
hud._sync_footer_height(resizing=True)
assert hud._footer_lines == 1
assert hud.txt_footer.heights == [1]
hud.txt_footer.display_lines = 1
hud._sync_footer_height(resizing=True)
assert hud._footer_lines == 2
assert hud.txt_footer.heights == [1, 2]
`;
  runPython(script, process.env);
});

test("titlebar controls keep the hand cursor and never start a drag", () => {
  const script = `
from types import SimpleNamespace
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
import pi_hud

hud = pi_hud.HUD.__new__(pi_hud.HUD)
control = object()
blank = object()
hud._drag = None
hud._title_controls = (control,)
hud.winfo_x = lambda: 0
hud.winfo_y = lambda: 0
hud.winfo_width = lambda: 680
hud.winfo_height = lambda: 100
cursors = []
hud._set_cursor = lambda widget, cursor: cursors.append((widget, cursor))

def motion(x, y, widget):
    pi_hud.HUD._on_motion(hud, SimpleNamespace(x_root=x, y_root=y, widget=widget))

motion(5, 15, control)
motion(100, 15, blank)
motion(1, 15, blank)
assert cursors == [(control, "hand2"), (blank, "fleur"), (blank, "size_we")]
pi_hud.HUD._on_press(hud, SimpleNamespace(x_root=5, y_root=15, widget=control))
assert hud._drag is None
`;
  runPython(script, process.env);
});

test("footer remeasures after the resized geometry is configured", () => {
  const script = `
from types import SimpleNamespace
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
import pi_hud

hud = pi_hud.HUD.__new__(pi_hud.HUD)
hud._footer_idle = None
callbacks = []
hud.after_idle = lambda callback: callbacks.append(callback) or "footer-idle"
called = []
hud._sync_footer_height = lambda resizing=False: called.append(resizing)
pi_hud.HUD._queue_footer_sync(hud)
pi_hud.HUD._queue_footer_sync(hud)
assert len(callbacks) == 1
callbacks.pop()()
assert called == [True]
assert hud._footer_idle is None

hud._drag = object()
hud._lw = 680
hud._lh = 100
wrap_widths = []
queued = []
hud._sync_wraplength = lambda width=None: wrap_widths.append(width)
hud._queue_footer_sync = lambda: queued.append(True)
pi_hud.HUD._on_config(hud, SimpleNamespace(widget=hud, width=900, height=100))
assert wrap_widths == [900]
assert queued == []
pi_hud.HUD._on_footer_configure(hud, SimpleNamespace())
assert queued == [True]
`;
  runPython(script, process.env);
  assert.match(pythonSource, /self\.txt_footer\.bind\("<Configure>", self\._on_footer_configure, add="\+"\)/);
});

test("minimize keeps the HUD hidden until the user restores it", () => {
  const script = `
from types import SimpleNamespace
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
import pi_hud

hud = pi_hud.HUD.__new__(pi_hud.HUD)
hud._restore_borderless = False
hud._topmost = True
calls = []
hud.withdraw = lambda: calls.append(("withdraw",))
hud.overrideredirect = lambda value: calls.append(("borderless", value))
hud.deiconify = lambda: calls.append(("deiconify",))
hud.iconify = lambda: calls.append(("iconify",))
hud.attributes = lambda *args: calls.append(("attributes", *args))
pi_hud.HUD._toggle_hide(hud)
assert calls == [("withdraw",), ("borderless", False), ("deiconify",), ("iconify",)]
assert hud._restore_borderless

idle = []
hud.after_idle = lambda callback: idle.append(callback) or "restore-idle"
hud.state = lambda: "iconic"
pi_hud.HUD._on_map(hud, SimpleNamespace(widget=hud))
assert idle == [] and hud._restore_borderless
hud.state = lambda: "normal"
pi_hud.HUD._on_map(hud, SimpleNamespace(widget=hud))
assert len(idle) == 1 and not hud._restore_borderless
idle.pop()()
assert calls[-4:] == [("withdraw",), ("borderless", True), ("deiconify",), ("attributes", "-topmost", True)]
pi_hud.HUD._on_map(hud, SimpleNamespace(widget=hud))
assert idle == []
`;
  runPython(script, process.env);
  assert.match(pythonSource, /self\.bind\("<Map>", self\._on_map\)/);
  assert.doesNotMatch(pythonSource, /self\.after\(300, show_again\)/);
});

test("horizontal footer reflow keeps the top-level window fitted during drag", () => {
  const script = `
from types import SimpleNamespace
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
import pi_hud

class FakeText:
    def __init__(self, display_lines):
        self.display_lines = display_lines
        self.height = 1
    def count(self, *args):
        assert args == ("1.0", "end-1c", "update", "displaylines")
        return (self.display_lines,)
    def configure(self, **kwargs):
        self.height = kwargs["height"]
    def tag_config(self, *args, **kwargs):
        pass

hud = pi_hud.HUD.__new__(pi_hud.HUD)
hud._footer_syncing = False
hud._footer_lines = 1
hud._scale_height = 100
hud._font_cache = {}
class FakeFont:
    def __init__(self):
        self.size = 0
    def configure(self, **kwargs):
        self.size = kwargs["size"]
hud._font_cache[(False, 12, "normal")] = FakeFont()
hud._update_scale(1000, 124)
assert hud._scale == 1.0
hud._drag = {"mode": "resize-r"}
hud.txt_footer = FakeText(1)
height = [100]
geometry_calls = []
hud.winfo_width = lambda: 800
hud.winfo_height = lambda: height[0]
hud.winfo_x = lambda: 10
hud.winfo_y = lambda: 20
hud._content_min_height = lambda: 124
hud.update_idletasks = lambda: None
hud.minsize = lambda *args: None
def set_geometry(value):
    geometry_calls.append(value)
    height[0] = int(value.split("x", 1)[1].split("+", 1)[0])
hud.geometry = set_geometry
hud._queue_geometry = lambda width, height, x, y: set_geometry(
    f"{width}x{height}+{x}+{y}"
)

# Narrowing to two display rows must grow the root instead of clipping Text.
pi_hud.HUD._sync_footer_height(hud, resizing=True)
assert hud._footer_lines == 2
assert hud.txt_footer.height == 2
assert height[0] == 124

# Widening back to one row must release that extra height.
hud.txt_footer.display_lines = 0
hud._content_min_height = lambda: 108
pi_hud.HUD._sync_footer_height(hud, resizing=True)
assert hud._footer_lines == 1
assert hud.txt_footer.height == 1
assert height[0] == 108

# The next horizontal drag must not restore the stale height captured on press.
hud._drag = {"mode": "resize-r", "x": 0, "y": 0, "wx": 10, "wy": 20, "w": 680, "h": 100}
hud._resize_min_h = 76
queued = []
hud._queue_geometry = lambda *args: queued.append(args)
pi_hud.HUD._on_drag(hud, SimpleNamespace(x_root=900, y_root=0))
assert queued[0][1] == 108, queued

# Release must fit once more if the pending footer callback was cancelled.
height[0] = 124
hud._pending_geometry = None
hud._geometry_idle = None
hud._footer_idle = None
hud._set_min_size = lambda: None
hud._apply_fonts = lambda: None
hud._alpha = 0.95
hud.attributes = lambda *args: None
hud._save_geom = lambda: None
pi_hud.HUD._on_release(hud, None)
assert height[0] == 108
assert geometry_calls == ["800x124+10+20", "800x108+10+20", "800x108+10+20"]
`;
  runPython(script, process.env);
});

test("resize centers the body, bounds command height, restores content-only growth, and aligns footer icons", () => {
  const script = `
from types import SimpleNamespace
import sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
import pi_hud

class FakeFont:
    def __init__(self, size):
        self.size = size
    def configure(self, **kwargs):
        self.size = kwargs["size"]

class FakeFooter:
    def __init__(self):
        self.tags = []
    def tag_config(self, tag, **kwargs):
        self.tags.append((tag, kwargs))

hud = pi_hud.HUD.__new__(pi_hud.HUD)
hud._scale = 1.0
hud._scale_height = 200
font = FakeFont(12)
hud._font_cache = {(False, 12, "normal"): font}
hud.txt_footer = FakeFooter()
pi_hud.HUD._update_scale(hud, 1360, 200)
assert hud._scale == 2.0
assert font.size == 24
assert hud.txt_footer.tags == [
    ("brain", {"offset": 4}),
    ("lock", {"offset": 6}),
]

# Pure horizontal resizing retains the scale that existed when the drag began.
scale_hud = pi_hud.HUD.__new__(pi_hud.HUD)
scale_hud._drag = None
scale_hud._title_controls = ()
scale_hud._scale = 0.7
scale_hud._scale_height = 220
scale_hud._resize_min_h = 76
scale_hud._content_min_height = lambda: 76
scale_hud.winfo_x = lambda: 0
scale_hud.winfo_y = lambda: 0
scale_hud.winfo_width = lambda: 680
scale_hud.winfo_height = lambda: 100
scale_hud.attributes = lambda *args: None
pi_hud.HUD._on_press(
    scale_hud,
    SimpleNamespace(x_root=679, y_root=50, widget=object()),
)
assert scale_hud._drag["mode"] == "resize-r"
assert scale_hud._scale_height == 70
scale_hud._font_cache = {}
pi_hud.HUD._update_scale(scale_hud, 1360, 100)
assert scale_hud._scale == 0.7

# Shrink only a height the HUD itself previously grew for content.
hud._drag = None
hud._last_min_height = 140
hud._content_min_height = lambda: 100
hud.update_idletasks = lambda: None
hud.winfo_width = lambda: 680
hud.winfo_height = lambda: 140
hud.winfo_x = lambda: 10
hud.winfo_y = lambda: 20
geometries = []
hud.geometry = lambda value: geometries.append(value)
hud.minsize = lambda *args: None
pi_hud.HUD._set_min_size(hud)
assert geometries == ["680x100+10+20"]

# A manually enlarged window must remain at the user-selected height.
hud._last_min_height = 140
hud.winfo_height = lambda: 200
pi_hud.HUD._set_min_size(hud)
assert geometries == ["680x100+10+20"]
`;
  runPython(script, process.env);
  assert.match(pythonSource, /body\.pack\(fill="both", expand=True/);
  assert.match(pythonSource, /body\.grid_rowconfigure\(0, weight=1\)/);
  assert.match(pythonSource, /body\.grid_rowconfigure\(3, weight=1\)/);
  assert.match(pythonSource, /self\.lbl_cmd = tk\.Label\([\s\S]*?anchor="center",[\s\S]*?width=1,[\s\S]*?height=1,/);
  assert.doesNotMatch(pythonSource, /self\.lbl_cmd\.configure\(wraplength=/);
  assert.match(viewSource, /"🧠 ", "brain"/);
  assert.match(viewSource, /" 🔒", "lock"/);
});
