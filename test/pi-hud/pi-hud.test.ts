import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, utimesSync } from "node:fs";
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
const modelConfigSource = readFileSync(join(packageDir, "model_config.py"), "utf8");
const viewSource = readFileSync(join(packageDir, "view.py"), "utf8");

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

test("context windows use the active model instead of the provider's first model", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-ctx-"));
  const models = join(root, "models.json");
  const modelsStore = join(root, "models-store.json");
  writeFileSync(
    models,
    JSON.stringify({
      providers: {
        duckcode: {
          models: [{ id: "claude-opus-5", contextWindow: 372000 }],
        },
        agentrouter: {
          models: [{ id: "gpt-5.6-sol", contextWindow: 372000 }],
        },
        "openai-codex": {
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
      "openai-codex": {
        models: [
          { id: "gpt-5.6-sol", contextWindow: 272000 },
          { id: "gpt-5.6-terra", contextWindow: 272000 },
        ],
      },
    }),
  );
  const script = `
import os, sys
sys.path.insert(0, ${JSON.stringify(packageDir)})
os.environ["PI_AGENT_DIR"] = ${JSON.stringify(root)}
import pi_hud
pi_hud.MODELS_JSON = ${JSON.stringify(models)}
cache = pi_hud._SessionCache()
assert cache.ctx_win_for("duckcode", "gpt-5.6-luna-max") == 272000
assert cache.ctx_win_for("duckcode", "gpt-5.6-terra-ultra") == 272000
assert cache.ctx_win_for("openai-codex", "gpt-5.6-terra") == 272000
assert cache.ctx_win_for("openai-codex", "gpt-5.6-sol") == 1050000
assert cache.ctx_win_for("agentrouter", "gpt-5.6-sol") == 372000
assert cache.ctx_win_for("duckcode", "unknown-model") == 0
`;
  runPython(script, { ...process.env, PI_AGENT_DIR: root });
});

test("context usage falls back to the latest usage components", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hud-usage-"));
  const session = join(root, "session.jsonl");
  writeFileSync(
    join(root, "models-store.json"),
    JSON.stringify({
      "openai-codex": {
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
          provider: "duckcode",
          model: "old-model",
          usage: { input: 100, output: 100, totalTokens: 200 },
        },
      },
      {
        timestamp: "2026-01-01T00:01:00Z",
        message: {
          role: "assistant",
          provider: "openai-codex",
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
assert result["provider"] == "openai-codex"
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
  assert.match(modelConfigSource, /KNOWN_CONTEXT_WINDOWS/);
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
