import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";

// index.mjs resolves its HUD directory at import time, so isolate it before importing.
const hudDir = mkdtempSync(join(tmpdir(), "pi-hud-lifecycle-"));
mkdirSync(hudDir, { recursive: true });
// A live lock PID makes startHUD() treat the HUD as running, so the test never spawns Python.
writeFileSync(join(hudDir, "pi-hud.lock"), String(process.pid));
process.env.PI_HUD_DIR = hudDir;
after(() => rmSync(hudDir, { recursive: true, force: true }));

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = join(here, "..", "..", "packages", "pi-hud", "index.mjs");

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    api: {
      events: { on() {} },
      on(name: string, handler: Handler) {
        handlers.set(name, handler);
      },
      appendEntry() {},
    },
  };
}

test("factory starts no timers or exit listeners; session_start owns startup across reloads", async () => {
  // Pi imports extensions with moduleCache:false, so /reload evaluates a fresh module instance.
  const { default: firstHUD } = await import(`${pathToFileURL(extensionPath).href}?reload=1`);
  const { default: secondHUD } = await import(`${pathToFileURL(extensionPath).href}?reload=2`);
  assert.notEqual(firstHUD, secondHUD, "each import must be a separate module instance");
  const exitListenersBefore = process.listenerCount("exit");
  const originalSetTimeout = globalThis.setTimeout;
  let timersStarted = 0;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    timersStarted += 1;
    return originalSetTimeout(...args);
  }) as typeof setTimeout;
  const first = fakePi();
  const second = fakePi();
  try {
    firstHUD(first.api);
    secondHUD(second.api);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.equal(timersStarted, 0, "factory must not schedule HUD startup");
  assert.equal(process.listenerCount("exit"), exitListenersBefore, "factory must not add exit listeners");

  await first.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, {});
  await second.handlers.get("session_start")!({ type: "session_start", reason: "reload" }, {});
  assert.ok(process.listenerCount("exit") <= exitListenersBefore + 1, "reloads must not accumulate exit listeners");

  const registration = join(hudDir, "pi-hud-pids", `${process.pid}.json`);
  const record = JSON.parse(readFileSync(registration, "utf8"));
  assert.equal(record.pid, process.pid, "session_start registers this terminal");

  // The single exit hook must run the reloaded instance's cleanup, which owns the reused token.
  const exitState = (globalThis as Record<symbol, { cleanup: (() => void) | null }>)[
    Symbol.for("@dianel/pi-hud/exit")
  ];
  exitState.cleanup?.();
  assert.equal(existsSync(registration), false, "exit cleanup removes this terminal's registration");
});

test("HUD diagnostics go to the log file instead of the fullscreen TUI", () => {
  const source = readFileSync(extensionPath, "utf8");
  assert.doesNotMatch(source, /console\.(log|error|warn)\(/);
});
