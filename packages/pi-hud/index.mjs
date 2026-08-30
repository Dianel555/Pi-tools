import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = process.env.HOME || process.env.USERPROFILE || ".";
const PI_DIR = join(HOME, ".pi");
const HUD_DIR = process.env.PI_HUD_DIR || PI_DIR;
const LOCK_FILE = join(HUD_DIR, "pi-hud.lock");
const PID_DIR = join(HUD_DIR, "pi-hud-pids");

let hudProcess = null;
let registrationFile = null;
let registrationToken = null;
let registered = false;
let retryTimer = null;
let shuttingDown = false;

const extDir = dirname(fileURLToPath(import.meta.url));
const hudScript = join(extDir, "pi_hud.py");

function registerTerminal() {
  if (registered) return;
  mkdirSync(PID_DIR, { recursive: true });
  registrationFile = join(PID_DIR, `${process.pid}.json`);
  try {
    const record = JSON.parse(readFileSync(registrationFile, "utf8"));
    if (record.pid === process.pid) {
      registrationToken = record.token;
      registered = true;
      return;
    }
  } catch {
    // Register below when the file is missing or invalid.
  }
  const token = randomUUID();
  registrationToken = token;
  writeFileSync(
    registrationFile,
    JSON.stringify({ pid: process.pid, token }),
    { encoding: "utf8", flag: "w" },
  );
  registered = true;
}

function unregisterTerminal() {
  if (!registrationFile) return;
  try {
    const record = JSON.parse(readFileSync(registrationFile, "utf8"));
    if (record.pid === process.pid && record.token === registrationToken) {
      unlinkSync(registrationFile);
    }
  } catch {
    // The file was already removed or the process is shutting down.
  }
  registrationFile = null;
  registrationToken = null;
  registered = false;
}

function hudIsAlive() {
  try {
    if (!existsSync(LOCK_FILE)) return false;
    const pid = Number.parseInt(readFileSync(LOCK_FILE, "utf8").trim(), 10);
    if (!Number.isInteger(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolvePython() {
  const configured = process.env.PYTHON;
  if (configured) {
    if (process.platform === "win32" && configured.toLowerCase().endsWith("python.exe")) {
      const pythonw = configured.slice(0, -"python.exe".length) + "pythonw.exe";
      try {
        accessSync(pythonw, constants.X_OK);
        return pythonw;
      } catch {
        // Keep the explicitly configured interpreter as a fallback.
      }
    }
    return configured;
  }
  if (process.platform === "win32" && process.env.VIRTUAL_ENV) {
    const pythonw = join(process.env.VIRTUAL_ENV, "Scripts", "pythonw.exe");
    try {
      accessSync(pythonw, constants.X_OK);
      return pythonw;
    } catch {
      // Fall through to a PATH-based interpreter.
    }
  }
  return process.platform === "win32" ? "pythonw" : "python3";
}

function reportStartup(message) {
  try {
    mkdirSync(HUD_DIR, { recursive: true });
    appendFileSync(join(HUD_DIR, "pi-hud.log"), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Diagnostics must never affect the Pi host.
  }
}

function scheduleStart() {
  if (shuttingDown || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    startHUD();
  }, 2000);
  retryTimer.unref?.();
}

function startHUD() {
  if (shuttingDown) return;
  try {
    registerTerminal();
  } catch (err) {
    console.error("[pi-hud] Failed to register terminal:", err);
    reportStartup(`Failed to register terminal: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (hudIsAlive() || hudProcess) return;
  try {
    hudProcess = spawn(resolvePython(), [hudScript, "--managed"], {
      env: { ...process.env, PI_HUD_DIR: HUD_DIR },
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    hudProcess.once("error", (err) => {
      console.error("[pi-hud] HUD process failed:", err.message);
      reportStartup(`HUD process failed: ${err.message}`);
      hudProcess = null;
      scheduleStart();
    });
    hudProcess.once("exit", () => {
      hudProcess = null;
      if (!shuttingDown && registered && !hudIsAlive()) scheduleStart();
    });
    hudProcess.unref();
    console.log("[pi-hud] HUD window started (PID:", hudProcess.pid, ")");
  } catch (err) {
    console.error("[pi-hud] Failed to start:", err);
    reportStartup(`Failed to start: ${err instanceof Error ? err.message : String(err)}`);
    hudProcess = null;
    scheduleStart();
  }
}

function stopHUD() {
  shuttingDown = true;
  if (retryTimer) clearTimeout(retryTimer);
  unregisterTerminal();
  hudProcess = null;
}

export default function piHUD(pi) {
  pi.on("before_agent_start", () => {
    startHUD();
  });

  // session_shutdown is not the lifetime end of a Pi terminal. The shared HUD
  // must remain available for other terminals.
  setTimeout(startHUD, 1000);

  process.on("exit", () => {
    shuttingDown = true;
    unregisterTerminal();
  });

  return {
    activate: startHUD,
    // Keep the registration through extension reload; beforeExit owns cleanup.
    deactivate: () => {},
  };
}
