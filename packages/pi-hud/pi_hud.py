#!/usr/bin/env python3
# Pi HUD v1.0 — 紧凑通知条幅，全方向拖拽/缩放，实时数据
# ponytail: simplified from 500+ lines, single data source, no FontManager, no JSON hacks

import ctypes
import json
import os
import queue
import re
import sys
import threading
import time
import tkinter as tk
import tkinter.font as tkfont
from contextlib import suppress
from datetime import datetime, timezone

from data import Collector, SessionCache
from i18n import LANGUAGES, LANGUAGE_NAMES, translate
from orb import OrbMotion, dock_edge, docked_geometry, physical_size
from theme import C, THEMES

# ── Windows API: 检查进程存活 ──
if sys.platform == "win32":
    _kernel32 = ctypes.windll.kernel32
    _user32 = ctypes.windll.user32
    from ctypes import wintypes

    _MONITOR_ENUM_PROC = ctypes.WINFUNCTYPE(
        wintypes.BOOL,
        wintypes.HANDLE,
        wintypes.HDC,
        ctypes.POINTER(wintypes.RECT),
        wintypes.LPARAM,
    )
    _user32.EnumDisplayMonitors.argtypes = (
        wintypes.HDC,
        ctypes.POINTER(wintypes.RECT),
        _MONITOR_ENUM_PROC,
        wintypes.LPARAM,
    )
    _user32.EnumDisplayMonitors.restype = wintypes.BOOL
else:
    _kernel32 = None
    _user32 = None
    _MONITOR_ENUM_PROC = None


def _is_pid_alive(pid: int) -> bool:
    if _kernel32 is not None:
        SYNCHRONIZE = 0x00100000
        handle = _kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if not handle:
            return False
        _kernel32.CloseHandle(handle)
        return True
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError, OSError):
        return False


def _virtual_screen_bounds(window):
    """Return the current virtual desktop bounds, including all monitors."""
    if _user32 is not None:
        # SM_X/YVIRTUALSCREEN and SM_CXVIRTUALSCREEN/CY... are 76..79.
        return tuple(int(_user32.GetSystemMetrics(index)) for index in range(76, 80))
    try:
        return (
            int(window.winfo_vrootx()),
            int(window.winfo_vrooty()),
            int(window.winfo_vrootwidth()),
            int(window.winfo_vrootheight()),
        )
    except (AttributeError, tk.TclError, TypeError, ValueError):
        return (0, 0, int(window.winfo_screenwidth()), int(window.winfo_screenheight()))


def _screen_rectangles(window):
    """Return physical monitor rectangles, or a virtual-screen fallback."""
    if _user32 is not None and _MONITOR_ENUM_PROC is not None:
        rectangles = []
        try:
            @_MONITOR_ENUM_PROC
            def collect(_monitor, _dc, rect, _data):
                value = rect.contents
                if value.right > value.left and value.bottom > value.top:
                    rectangles.append(
                        (
                            int(value.left),
                            int(value.top),
                            int(value.right),
                            int(value.bottom),
                        )
                    )
                return True

            if not _user32.EnumDisplayMonitors(None, None, collect, 0):
                return []
        except (AttributeError, OSError, TypeError, ValueError, ctypes.ArgumentError):
            return []
        return rectangles

    # Non-Windows Tk exposes only the virtual bounding rectangle, so monitor
    # gaps cannot be distinguished there; it is still the safest fallback.
    left, top, width, height = _virtual_screen_bounds(window)
    if width <= 0 or height <= 0:
        return []
    return [(left, top, left + width, top + height)]


def _safe_window_position(window, width, height, x, y):
    """Recenter only when the window has no visible intersection."""
    rectangles = _screen_rectangles(window)
    if not rectangles or any(
        x < right
        and x + width > left
        and y < bottom
        and y + height > top
        for left, top, right, bottom in rectangles
    ):
        return x, y

    def distance(rectangle):
        left, top, right, bottom = rectangle
        dx = max(left - (x + width), x - right, 0)
        dy = max(top - (y + height), y - bottom, 0)
        return dx * dx + dy * dy

    left, top, right, bottom = min(rectangles, key=distance)
    return left + (right - left - width) // 2, top + (bottom - top - height) // 2


MANAGED_MODE = "--managed" in sys.argv

POLL_INTERVAL = 0.8
UI_REFRESH_MS = 150
DEFAULT_W, DEFAULT_H = 680, 100
MIN_W, MIN_H = 480, 76
TITLE_H = 24
BASE_FONT = 12
RESIZE_BORDER = 12
ALPHA_NORMAL = 0.95
ALPHA_LOW = 0.70

# 可通过环境变量覆盖路径
HOME = os.path.expanduser("~")
AGENT_DIR = os.getenv("PI_AGENT_DIR", os.path.join(HOME, ".pi", "agent"))
CTX_DIR = os.getenv("PI_CTX_DIR", os.path.join(HOME, ".pi", "context-mode", "sessions"))
HUD_DIR = os.getenv("PI_HUD_DIR", os.path.join(HOME, ".pi"))
SETTINGS_JSON = os.path.join(AGENT_DIR, "settings.json")
MODELS_JSON = os.path.join(AGENT_DIR, "models.json")
AUTH_JSON = os.path.join(AGENT_DIR, "auth.json")
SESSIONS_DIR = os.path.join(AGENT_DIR, "sessions")
CFG_FILE = os.path.join(HOME, ".pi", "pi-hud-geom.json")
_LOCK_FILE = os.path.join(HUD_DIR, "pi-hud.lock")
_PID_DIR = os.path.join(HUD_DIR, "pi-hud-pids")


class _SessionCache(SessionCache):
    """保持旧的 pi_hud._SessionCache() 调用兼容性。"""

    def __init__(self):
        super().__init__(SESSIONS_DIR, MODELS_JSON)


def _acquire_lock():
    """用独占创建保证并发启动时始终只有一个 HUD。"""
    os.makedirs(os.path.dirname(_LOCK_FILE), exist_ok=True)
    while True:
        try:
            fd = os.open(_LOCK_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(str(os.getpid()))
            return
        except FileExistsError:
            try:
                with open(_LOCK_FILE, encoding="utf-8") as f:
                    old_pid = int(f.read().strip())
            except (OSError, ValueError):
                try:
                    if time.time() - os.path.getmtime(_LOCK_FILE) < 2:
                        time.sleep(0.05)
                        continue
                except OSError:
                    continue
                with suppress(OSError):
                    os.unlink(_LOCK_FILE)
                continue
            if _is_pid_alive(old_pid):
                sys.exit(0)
            with suppress(OSError):
                os.unlink(_LOCK_FILE)


def _pid_from_entry(name):
    try:
        if name.endswith(".json"):
            return int(name[:-5].split("-", 1)[0])
        return int(name)
    except ValueError:
        return None


def _alive_pid_count():
    """返回注册表中仍存活的 Pi 终端数量，并清理 stale 条目。"""
    try:
        entries = os.listdir(_PID_DIR)
    except OSError:
        return 0
    count = 0
    for name in entries:
        pid = _pid_from_entry(name)
        if pid is None:
            continue
        path = os.path.join(_PID_DIR, name)
        if _is_pid_alive(pid):
            count += 1
        else:
            with suppress(OSError):
                os.unlink(path)
    return count


def _release_lock():
    try:
        with open(_LOCK_FILE, encoding="utf-8") as f:
            owner = int(f.read().strip())
        if owner == os.getpid():
            os.unlink(_LOCK_FILE)
    except (OSError, ValueError):
        pass


class HUD(tk.Tk):
    def __init__(self):
        super().__init__()
        self._drag = None
        self._topmost = True
        self._alpha = ALPHA_NORMAL
        self.overrideredirect(True)
        self.attributes("-topmost", True)
        self.attributes("-alpha", ALPHA_NORMAL)
        self.configure(bg=C["bg"], bd=0, highlightthickness=0)
        self.geometry(f"{DEFAULT_W}x{DEFAULT_H}+120+80")
        self._scale = 1.0
        # Footer auto-fitting must not feed its extra row back into font scaling.
        self._scale_height = DEFAULT_H
        self._font_cache = {}
        self._sessions = []
        self._session_idx = 0
        self._auto_follow = True
        self._language = self._load_language()
        self._theme_name = self._load_theme_name()
        C.update(THEMES[self._theme_name])
        self.configure(bg=C["bg"], bd=0, highlightthickness=0)
        self._theme_var = None
        self._status_group = None
        self._status_row = None
        self._footer_syncing = False
        self._bell_active = False
        self._bell_frame = 0
        self._bell_after = None
        self._footer_lines = 1
        self._last_min_height = MIN_H
        self._resize_min_h = MIN_H
        self._pending_geometry = None
        self._geometry_idle = None
        self._footer_idle = None
        self._restore_borderless = False
        self._shape = "rect"
        self._rect_geometry = None
        self._dock_edge = None
        self._orb_revealed = False
        self._orb_size = physical_size(self)
        self._orb_motion = OrbMotion()
        self._orb_motion_enabled = True
        self._orb_hovered = False
        self._orb_after = None
        self._orb_canvas = None
        self._orb_layer = None
        self._orb_rendered = None
        self._latest = {}
        self._summary = None
        self._summary_after = None
        self._summary_fade_after = None
        self._summary_layer = None
        self._pointer_inside = False
        self._build()
        self._apply_theme()
        self._load_geom()
        self._apply_language()
        if self.__dict__.get("_shape") == "orb":
            self._enter_orb(save=False)
        self._update_scale(self.winfo_width(), self.winfo_height())
        self._apply_fonts()
        self._set_min_size()
        self.col = Collector(SESSIONS_DIR, SETTINGS_JSON, MODELS_JSON, AUTH_JSON)
        self.q = self.col.q
        self.col.start()
        self._watch_cnt = 0  # 看门狗计数器
        self.after(UI_REFRESH_MS, self._poll)
        self.bind("<Configure>", self._on_config)
        self.bind("<Map>", self._on_map)
        # 全局鼠标绑定
        self.bind_all("<Motion>", self._on_motion)
        # Route pointer events through the window first, including footer and corners.
        self.bind_all("<ButtonPress-1>", self._on_press, add="+")
        self.bind_all("<B1-Motion>", self._on_drag, add="+")
        self.bind_all("<ButtonRelease-1>", self._on_release, add="+")
        self.bind_all("<Button-3>", self._menu, add="+")
        self.bind_all("<Leave>", self._on_pointer_leave, add="+")

    def _build(self):
        # ── Titlebar ──
        tb = tk.Frame(self, bg=C["title"], height=TITLE_H)
        tb.pack(fill="x")
        tb.pack_propagate(False)
        self._tbar = tb

        self.btn_prev = tk.Label(
            tb, text="◀", bg=C["title"], fg=C["sub"], cursor="hand2"
        )
        self.btn_prev.pack(side="left", padx=(4, 1))
        self.btn_prev.bind("<Button-1>", lambda e: self._switch_session(-1))
        self.btn_prev.bind("<Enter>", lambda e: self.btn_prev.config(fg=C["accent"]))
        self.btn_prev.bind("<Leave>", lambda e: self.btn_prev.config(fg=C["sub"]))

        self.btn_next = tk.Label(
            tb, text="▶", bg=C["title"], fg=C["sub"], cursor="hand2"
        )
        self.btn_next.pack(side="left", padx=(1, 4))
        self.btn_next.bind("<Button-1>", lambda e: self._switch_session(1))
        self.btn_next.bind("<Enter>", lambda e: self.btn_next.config(fg=C["accent"]))
        self.btn_next.bind("<Leave>", lambda e: self.btn_next.config(fg=C["sub"]))

        self.lbl_title = tk.Label(tb, text=f"● {self._t('title')}", bg=C["title"], fg=C["accent"])
        self.lbl_title.pack(side="left", padx=10)

        self.lbl_session = tk.Label(
            tb, text="", bg=C["title"], fg=C["dim"], cursor="hand2"
        )
        self.lbl_session.pack(side="left", padx=(4, 0))
        self.lbl_session.bind("<Button-1>", lambda e: self._auto_follow_session())
        self.lbl_session.bind("<Enter>", lambda e: self.lbl_session.config(fg=C["sub"]))
        self.lbl_session.bind("<Leave>", lambda e: self.lbl_session.config(fg=C["dim"]))

        self.btn_pin = tk.Label(
            tb, text="📌", bg=C["title"], fg=C["accent"], cursor="hand2"
        )
        self.btn_pin.bind("<Button-1>", lambda e: self._toggle_topmost())
        self.btn_pin.bind("<Enter>", lambda e: self.btn_pin.config(bg=C["surface"]))
        self.btn_pin.bind("<Leave>", lambda e: self.btn_pin.config(bg=C["title"]))

        self.btn_min = tk.Label(
            tb, text="—", bg=C["title"], fg=C["sub"], cursor="hand2"
        )
        self.btn_min.bind("<Button-1>", lambda e: self._toggle_hide())
        self.btn_min.bind("<Enter>", lambda e: self.btn_min.config(bg=C["surface"]))
        self.btn_min.bind("<Leave>", lambda e: self.btn_min.config(bg=C["title"]))

        self.btn_x = tk.Label(tb, text="✕", bg=C["title"], fg=C["sub"], cursor="hand2")
        self.btn_x.bind("<Button-1>", lambda e: self._quit())
        self.btn_x.bind(
            "<Enter>", lambda e: self.btn_x.config(fg=C["red"], bg=C["surface"])
        )
        self.btn_x.bind(
            "<Leave>", lambda e: self.btn_x.config(fg=C["sub"], bg=C["title"])
        )

        # Pack right controls in reverse order so they render left-to-right as 📌 — ✕.
        self.btn_x.pack(side="right", padx=6)
        self.btn_min.pack(side="right", padx=4)
        self.btn_pin.pack(side="right", padx=6)
        self._title_controls = (
            self.btn_prev,
            self.btn_next,
            self.lbl_session,
            self.btn_pin,
            self.btn_min,
            self.btn_x,
        )

        # ── Body (grid for proper centering) ──
        body = tk.Frame(self, bg=C["bg"])
        body.pack(fill="both", expand=True, padx=14, pady=0)
        self._body = body
        # Equal spacer rows keep the status and command group vertically centered.
        body.grid_rowconfigure(0, weight=1)
        body.grid_rowconfigure(3, weight=1)
        body.grid_columnconfigure(0, weight=1)

        # Center the status title and keep the clock immediately beside it.
        status_row = tk.Frame(body, bg=C["bg"])
        self._status_row = status_row
        status_row.grid(row=1, column=0, sticky="ew")
        status_group = tk.Frame(status_row, bg=C["bg"])
        self._status_group = status_group
        status_group.pack(expand=True)
        self.lbl_bell = tk.Label(status_group, text="🔔", bg=C["bg"], fg=C["dim"])
        self.lbl_bell.pack(side="left", padx=(0, 8))
        self.lbl_status = tk.Label(status_group, text=self._t("offline"), bg=C["bg"], fg=C["dim"])
        self.lbl_status.pack(side="left")
        self.lbl_time = tk.Label(status_group, text="", bg=C["bg"], fg=C["dim"])
        self.lbl_time.pack(side="left", padx=(12, 0))

        # Command line - centered vertically in body
        self.lbl_cmd = tk.Label(
            body,
            text=self._t("idle_command"),
            bg=C["bg"],
            fg=C["text"],
            anchor="center",
            width=1,
            height=1,
        )
        self.lbl_cmd.grid(row=2, column=0, sticky="ew", pady=(3, 0))

        # ── Footer ──
        ft = tk.Frame(self, bg=C["title"], bd=0, highlightthickness=0)
        ft.pack(fill="x", side="bottom")
        ft.pack_propagate(True)
        self._footer = ft

        self.txt_footer = tk.Text(
            ft,
            height=1,
            bg=C["title"],
            fg=C["text"],
            bd=0,
            highlightthickness=0,
            wrap="char",
        )
        self.txt_footer.pack(side="left", fill="both", expand=True, padx=12, pady=2)
        self.txt_footer.bind("<Configure>", self._on_footer_configure, add="+")

        for tag, color in [
            ("brain", "dim"),
            ("prov", "accent"),
            ("lock", "accent"),
            ("model", "cyan"),
            ("think", "purple"),
            ("tokens", "green"),
            ("cache", "orange"),
            ("ctx", "blue"),
            ("cost", "amber"),
            ("sep", "dim"),
        ]:
            self.txt_footer.tag_config(tag, foreground=C[color])
        # 每行下方不额外留固定空白，footer 高度由实际显示行底部决定。
        self.txt_footer.configure(spacing2=0)

        # Route edge events before child widget class bindings. This keeps footer and corners resizable.
        for widget in (
            tb, body, ft, self.txt_footer, status_row, status_group,
            self.lbl_bell, self.lbl_status, self.lbl_time, self.lbl_cmd,
        ):
            widget.bindtags((str(widget), str(self), "all", widget.winfo_class()))
        # 绑定右键菜单、快捷键
        self.bind_all("<Control-t>", lambda e: self._toggle_topmost())
        self.bind_all("<Control-a>", lambda e: self._toggle_alpha())
        self.bind_all("<Control-h>", lambda e: self._toggle_hide())
        self.bind_all("<Control-bracketleft>", lambda e: self._switch_session(-1))
        self.bind_all("<Control-bracketright>", lambda e: self._switch_session(1))
        self.bind_all("<Control-q>", lambda e: self._quit())

    # ── Drag / Resize ──
    def _set_cursor(self, widget, cursor):
        self.config(cursor=cursor)
        try:
            widget.config(cursor=cursor)
        except tk.TclError:
            pass

    def _on_motion(self, evt):
        if self.__dict__.get("_shape") == "orb":
            if evt.widget not in (self, self._orb_canvas):
                return
            self._pointer_inside = True
            if not self._orb_hovered:
                self._orb_hovered = True
                self._request_orb_frame()
            self._set_cursor(evt.widget, "fleur")
            self._schedule_summary()
            return
        if self._drag:
            mode = self._drag["mode"]
            cursor = {
                "resize-lt": "size_nw_se",
                "resize-rt": "size_ne_sw",
                "resize-lb": "size_ne_sw",
                "resize-rb": "size_nw_se",
                "resize-l": "size_we",
                "resize-r": "size_we",
                "resize-t": "size_ns",
                "resize-b": "size_ns",
            }.get(mode)
            if cursor:
                self._set_cursor(evt.widget, cursor)
            return
        rx = evt.x_root - self.winfo_x()
        ry = evt.y_root - self.winfo_y()
        x, y = rx, ry
        w, h = self.winfo_width(), self.winfo_height()
        if evt.widget in self._title_controls:
            self._set_cursor(evt.widget, "hand2")
            return
        nl, nr = x <= RESIZE_BORDER, x >= w - RESIZE_BORDER
        nt, nb = y <= RESIZE_BORDER, y >= h - RESIZE_BORDER
        if nl and nt:
            self._set_cursor(evt.widget, "size_nw_se")
            return
        if nr and nt:
            self._set_cursor(evt.widget, "size_ne_sw")
            return
        if nl and nb:
            self._set_cursor(evt.widget, "size_ne_sw")
            return
        if nr and nb:
            self._set_cursor(evt.widget, "size_nw_se")
            return
        if nl or nr:
            self._set_cursor(evt.widget, "size_we")
            return
        if nt or nb:
            self._set_cursor(evt.widget, "size_ns")
            return
        if y < TITLE_H:
            self._set_cursor(evt.widget, "fleur")
            return
        self._set_cursor(evt.widget, "")

    def _on_press(self, evt):
        if self.__dict__.get("_shape") == "orb":
            if evt.widget not in (self, self._orb_canvas):
                return
            self._hide_summary(force=True)
            self._request_orb_frame()
            self._drag = {
                "mode": "move",
                "x": evt.x_root,
                "y": evt.y_root,
                "wx": self.winfo_x(),
                "wy": self.winfo_y(),
                "moved": False,
            }
            return
        x = evt.x_root - self.winfo_x()
        y = evt.y_root - self.winfo_y()
        w, h = self.winfo_width(), self.winfo_height()
        nl, nr = x <= RESIZE_BORDER, x >= w - RESIZE_BORDER
        nt, nb = y <= RESIZE_BORDER, y >= h - RESIZE_BORDER
        # Controls remain clickable even where their hitbox meets a resize edge.
        if evt.widget in self._title_controls:
            return
        self._resize_min_h = max(MIN_H, self._content_min_height())
        self.attributes("-alpha", 1.0)
        self._drag = {
            "x": evt.x_root,
            "y": evt.y_root,
            "wx": self.winfo_x(),
            "wy": self.winfo_y(),
            "w": w,
            "h": h,
        }
        edges = []
        if nl:
            edges.append("l")
        if nr:
            edges.append("r")
        if nt:
            edges.append("t")
        if nb:
            edges.append("b")
        self._drag["mode"] = "resize-" + "".join(edges) if edges else "move"
        if self._is_horizontal_resize():
            # Widening may reflow the footer, but must not enlarge the UI scale.
            self._scale_height = self._scale * DEFAULT_H

    def _on_drag(self, evt):
        if not self._drag:
            return
        d = self._drag
        dx, dy = evt.x_root - d["x"], evt.y_root - d["y"]
        if d["mode"] == "move":
            if self.__dict__.get("_shape") == "orb" and (abs(dx) > 3 or abs(dy) > 3):
                d["moved"] = True
                self._hide_summary(force=True)
            # pi-lens-ignore: unchecked-throwing-call-python
            self.geometry(f"+{int(d['wx'] + dx)}+{int(d['wy'] + dy)}")
            return
        ed = d["mode"].replace("resize-", "")
        nw, nh = d["w"], d["h"]
        nx, ny = d["wx"], d["wy"]
        if "r" in ed:
            nw = max(MIN_W, d["w"] + dx)
        if "l" in ed:
            nw = max(MIN_W, d["w"] - dx)
            nx = d["wx"] + (d["w"] - nw)
        min_h = self._resize_min_h
        if "b" in ed:
            nh = max(min_h, d["h"] + dy)
        if "t" in ed:
            nh = max(min_h, d["h"] - dy)
            ny = d["wy"] + (d["h"] - nh)
        if "t" in ed or "b" in ed:
            self._scale_height = nh
        elif self._is_horizontal_resize():
            # Footer reflow may have changed the window height since press.
            pending_geometry = self.__dict__.get("_pending_geometry")
            nh = (
                pending_geometry[1]
                if pending_geometry is not None
                else self.winfo_height()
            )
        # Coalesce geometry updates so Tk/Windows repaints once per idle cycle.
        self._queue_geometry(nw, nh, nx, ny)

    def _on_release(self, evt):
        if self._drag is None:
            return
        was_move = self._is_move_drag()
        was_horizontal_resize = self._is_horizontal_resize()
        if self._geometry_idle is not None:
            self.after_cancel(self._geometry_idle)
            self._geometry_idle = None
        if self._footer_idle is not None:
            self.after_cancel(self._footer_idle)
            self._footer_idle = None
        if was_move:
            moved = bool(self._drag.get("moved"))
            # Keep Configure events in the drag-suppressed path and discard any
            # stale resize queued before the move began.
            self._pending_geometry = None
            self.update_idletasks()
            # A Configure callback can queue another idle callback while Tk
            # drains the event queue; cancel those before ending the drag.
            if self._geometry_idle is not None:
                self.after_cancel(self._geometry_idle)
                self._geometry_idle = None
            if self._footer_idle is not None:
                self.after_cancel(self._footer_idle)
                self._footer_idle = None
            self._pending_geometry = None
            self._drag = None
            if self.__dict__.get("_shape") != "orb":
                self.attributes("-alpha", self._alpha)
            if self.__dict__.get("_shape") == "orb":
                self._request_orb_frame()
                if moved:
                    self._pointer_inside = False
                    self._hide_summary(force=True)
                    self._park_orb()
                else:
                    self._toggle_orb_reveal()
            else:
                self._ensure_on_screen()
            self._save_geom()
            return
        self._drag = None
        if self._pending_geometry:
            self._apply_pending_geometry()
        self.update_idletasks()
        self._update_scale(self.winfo_width(), self.winfo_height())
        self._apply_fonts()
        self._sync_footer_height()
        if was_horizontal_resize:
            self._fit_footer_window()
        self.attributes("-alpha", self._alpha)
        self._save_geom()

    def _queue_geometry(self, width, height, x, y):
        self._pending_geometry = (int(width), int(height), int(x), int(y))
        if self._geometry_idle is None:
            self._geometry_idle = self.after_idle(self._apply_pending_geometry)

    def _apply_pending_geometry(self):
        self._geometry_idle = None
        if not self._pending_geometry:
            return
        width, height, x, y = self._pending_geometry
        self._pending_geometry = None
        self.geometry(f"{width}x{height}+{x}+{y}")
        self._update_scale(width, height)

    def _is_move_drag(self):
        drag = self.__dict__.get("_drag")
        return isinstance(drag, dict) and drag.get("mode") == "move"

    def _is_horizontal_resize(self):
        drag = self.__dict__.get("_drag")
        drag = drag if isinstance(drag, dict) else {}
        mode = drag.get("mode", "")
        return mode.startswith("resize-") and "t" not in mode and "b" not in mode

    def _fit_footer_window(self, queued=False):
        height = max(MIN_H, self._content_min_height())
        self._last_min_height = height
        self.minsize(MIN_W, height)
        pending = self.__dict__.get("_pending_geometry")
        if pending is None:
            width, current_height = self.winfo_width(), self.winfo_height()
            x, y = self.winfo_x(), self.winfo_y()
        else:
            width, current_height, x, y = pending
        if current_height == height:
            return
        if queued:
            self._queue_geometry(width, height, x, y)
        else:
            self.geometry(f"{width}x{height}+{x}+{y}")

    def _on_footer_configure(self, _):
        if self._drag and not self._is_move_drag():
            self._queue_footer_sync()

    def _queue_footer_sync(self):
        if self._footer_idle is None:
            self._footer_idle = self.after_idle(self._sync_footer_after_resize)

    def _sync_footer_after_resize(self):
        self._footer_idle = None
        if self._is_move_drag():
            return
        self._sync_footer_height(resizing=True)

    def _update_scale(self, w, h):
        if self.__dict__.get("_shape") == "orb":
            return
        scale_height = self.__dict__.get("_scale_height", h)
        self._scale = max(
            0.55, min(2.2, min(w / DEFAULT_W, scale_height / DEFAULT_H))
        )
        for key, font in self._font_cache.items():
            if len(key) != 3:
                continue
            _, pts, _weight = key
            font.configure(size=max(7, int(pts * self._scale)))
        footer = self.__dict__.get("txt_footer")
        if footer is not None:
            offset = max(0, round(BASE_FONT * (self._scale - 1) / 8))
            footer.tag_config("brain", offset=offset * 2)
            footer.tag_config("lock", offset=offset * 3)

    def _summary_font(self):
        footer = self._font(False, BASE_FONT)
        size = max(7, int(footer.cget("size")) - 2)
        key = ("summary", size)
        if key not in self._font_cache:
            self._font_cache[key] = tkfont.Font(
                family=footer.cget("family"), size=size, weight="bold",
            )
        return self._font_cache[key]

    def _font(self, mono: bool, pts: int, weight: str = "normal"):
        key = (mono, pts, weight)
        if key not in self._font_cache:
            fam = (
                "Cascadia Code"
                if mono
                else (
                    "Microsoft YaHei UI"
                    if "Microsoft YaHei UI" in tkfont.families()
                    else "Segoe UI"
                )
            )
            self._font_cache[key] = tkfont.Font(
                family=fam,
                # pi-lens-ignore: unchecked-throwing-call-python
                size=max(7, int(pts * self._scale)),
                weight=weight,  # type: ignore[arg-type]
            )
        return self._font_cache[key]

    def _apply_fonts(self):
        fm = self._font
        widgets = [
            (self.lbl_title, fm(False, BASE_FONT - 1, "bold")),
            (self.lbl_session, fm(False, BASE_FONT - 1, "bold")),
            (self.btn_pin, fm(False, BASE_FONT - 1, "bold")),
            (self.btn_min, fm(False, BASE_FONT - 1, "bold")),
            (self.btn_x, fm(False, BASE_FONT - 1, "bold")),
            (self.btn_prev, fm(False, BASE_FONT - 1)),
            (self.btn_next, fm(False, BASE_FONT - 1)),
            (self.lbl_bell, fm(False, BASE_FONT + 8, "bold")),
            (self.lbl_status, fm(False, BASE_FONT + 2, "bold")),
            (self.lbl_time, fm(False, BASE_FONT + 2, "bold")),
            (self.lbl_cmd, fm(True, BASE_FONT + 4)),
            (self.txt_footer, fm(False, BASE_FONT)),
        ]
        for w, fn in widgets:
            w.config(font=fn)

    def _set_bell(self, active, color):
        self._bell_active = active
        self.lbl_bell.config(fg=color)
        if active:
            if self._bell_after is None:
                self._shake_bell()
            return
        if self._bell_after is not None:
            self.after_cancel(self._bell_after)
            self._bell_after = None
        self._bell_frame = 0
        self.lbl_bell.config(text="🔔")

    def _shake_bell(self):
        self._bell_after = None
        if not self._bell_active:
            return
        frames = ("🔔", " 🔔", "🔔 ", "🔔")
        self.lbl_bell.config(text=frames[self._bell_frame % len(frames)])
        self._bell_frame += 1
        self._bell_after = self.after(140, self._shake_bell)

    # ── Data Poll ──
    def _poll(self):
        self._ensure_on_screen()
        try:
            while True:
                self._render(self.q.get_nowait())
        except queue.Empty:
            pass
        self._watch_cnt += 1
        if self._watch_cnt >= 20:
            self._watch_cnt = 0
            if MANAGED_MODE and _alive_pid_count() == 0:
                self._quit()
                return
        # 自动追踪最新活跃 session
        if self._auto_follow and self._watch_cnt % 20 == 0:
            self._auto_follow_session()
        self.after(UI_REFRESH_MS, self._poll)

    def _render(self, d):
        self._latest = d
        if self.__dict__.get("_shape") == "orb":
            self._request_orb_frame()
            if self._summary is not None:
                self._show_summary()
            return
        from view import render
        render(self, d)

    # ── Actions ──
    def _toggle_topmost(self):
        self._topmost = not self._topmost
        self.attributes("-topmost", self._topmost)
        self.btn_pin.config(
            text="📌" if self._topmost else "📍",
            fg=C["accent"] if self._topmost else C["dim"],
        )
        if self.__dict__.get("_shape") == "orb":
            self._orb_cache = None
            self._request_orb_frame()
            if self._summary is not None:
                self._summary.attributes("-topmost", self._topmost)
                self._present_summary(self._summary_opacity)

    def _toggle_alpha(self):
        self._alpha = ALPHA_LOW if self._alpha == ALPHA_NORMAL else ALPHA_NORMAL
        if self.__dict__.get("_shape") == "orb":
            self._orb_cache = None
            self._request_orb_frame()
        else:
            self.attributes("-alpha", self._alpha)

    def _toggle_hide(self):
        if self.__dict__.get("_shape") == "orb":
            self._stop_orb()
        self._restore_borderless = True
        # Tk reliably applies override-redirect changes while withdrawn.
        self.withdraw()
        self.overrideredirect(False)
        self.deiconify()
        self.iconify()

    def _on_map(self, e):
        if (
            e.widget is self
            and self._restore_borderless
            and self.state() == "normal"
        ):
            self._restore_borderless = False
            self.after_idle(self._restore_borderless_window)
        elif e.widget is self and self.__dict__.get("_shape") == "orb":
            self._orb_cache = None
            self._request_orb_frame()

    def _restore_borderless_window(self):
        self.withdraw()
        self.overrideredirect(True)
        self.deiconify()
        self.attributes("-topmost", self._topmost)
        if self.__dict__.get("_shape") == "orb":
            self._orb_cache = None
            self._request_orb_frame()

    def _menu(self, e):
        m = tk.Menu(
            self,
            tearoff=0,
            bg=C["surface"],
            fg=C["text"],
            activebackground=C["border"],
            activeforeground=C["accent"],
        )
        m.add_command(label=self._t("topmost"), command=self._toggle_topmost)
        m.add_command(label=self._t("opacity"), command=self._toggle_alpha)
        m.add_command(
            label=self._t("rect" if self.__dict__.get("_shape") == "orb" else "orb"),
            command=self._toggle_shape,
        )
        if self.__dict__.get("_shape") == "orb":
            m.add_command(
                label=self._t("motion_off" if self._orb_motion_enabled else "motion_on"),
                command=self._toggle_orb_motion,
            )
        theme_menu = tk.Menu(m, tearoff=0)
        self._theme_var = tk.StringVar(value=self._theme_name)
        for name in ("dark", "white", "paper"):
            theme_menu.add_radiobutton(
                label=self._t(name), value=name, variable=self._theme_var,
                command=lambda n=name: self._set_theme(n),
            )
        m.add_cascade(label=self._t("theme"), menu=theme_menu)
        language_menu = tk.Menu(m, tearoff=0)
        self._language_var = tk.StringVar(value=self._language)
        for language in LANGUAGES:
            language_menu.add_radiobutton(
                label=LANGUAGE_NAMES[language], value=language,
                variable=self._language_var,
                command=lambda n=language: self._set_language(n),
            )
        m.add_cascade(label=self._t("language"), menu=language_menu)
        m.add_separator()
        m.add_command(label=self._t("minimize"), command=self._toggle_hide)
        m.add_command(label=self._t("reset"), command=self._reset_geom)
        m.add_separator()
        m.add_command(label=self._t("quit"), command=self._quit)
        try:
            m.tk_popup(e.x_root, e.y_root)
        finally:
            m.grab_release()

    def _reset_geom(self):
        if self.__dict__.get("_shape") == "orb":
            self._dock_edge = None
            self._orb_revealed = False
            size = self._orb_size
            self.geometry(f"{size}x{size}+120+80")
            self._hide_summary(force=True)
            self._save_geom()
            return
        self._scale_height = DEFAULT_H
        self.geometry(f"{DEFAULT_W}x{DEFAULT_H}+120+80")
        self._update_scale(DEFAULT_W, DEFAULT_H)
        self._sync_wraplength()
        self._apply_fonts()
        self._set_min_size()
        self._save_geom()

    def _save_geom(self):
        try:
            with open(CFG_FILE, "w") as f:
                json.dump(
                    {
                        "g": self.__dict__.get("_rect_geometry") or self.geometry(),
                        "theme": self._theme_name,
                        "shape": self.__dict__.get("_shape", "rect"),
                        "dock": self.__dict__.get("_dock_edge"),
                        "revealed": self.__dict__.get("_orb_revealed", False),
                        "orb_motion": self.__dict__.get("_orb_motion_enabled", True),
                        "language": self.__dict__.get("_language", "zh"),
                    },
                    f,
                )
        except OSError:
            pass

    def _t(self, key):
        return translate(self.__dict__.get("_language", "zh"), key)

    def _load_language(self):
        try:
            with open(CFG_FILE, encoding="utf-8") as f:
                language = json.load(f).get("language", "zh")
            return language if language in LANGUAGES else "zh"
        except (OSError, json.JSONDecodeError, AttributeError, TypeError):
            return "zh"

    def _set_language(self, language):
        if language not in LANGUAGES or language == self._language:
            return
        self._language = language
        self._apply_language()
        if self.__dict__.get("_shape") == "orb" and self._summary is not None:
            self._show_summary()
        self._save_geom()

    def _apply_language(self):
        self.lbl_title.config(text=f"● {self._t('title')}")
        if self.__dict__.get("_latest"):
            self._render(self._latest)
        else:
            self.lbl_status.config(text=self._t("offline"))
            self.lbl_cmd.config(text=self._t("idle_command"))
        if hasattr(self, "col"):
            self._update_session_label()

    def _load_theme_name(self):
        try:
            with open(CFG_FILE, encoding="utf-8") as f:
                name = json.load(f).get("theme", "dark")
            return name if name in THEMES else "dark"
        except (OSError, json.JSONDecodeError, AttributeError, TypeError):
            return "dark"

    def _set_theme(self, name):
        if name not in THEMES:
            return
        self._theme_name = name
        C.update(THEMES[name])
        if self._theme_var is not None:
            self._theme_var.set(name)
        self._apply_theme()
        if self.__dict__.get("_shape") == "orb":
            self._draw_orb()
            if self._summary is not None:
                self._show_summary()
        self._save_geom()

    def _apply_theme(self):
        widgets = [
            (self._tbar, "bg", C["title"]),
            (self._body, "bg", C["bg"]), (self._footer, "bg", C["title"]),
            (self._status_row, "bg", C["bg"]),
            (self._status_group, "bg", C["bg"]),
            (self.lbl_title, "bg", C["title"]), (self.lbl_title, "fg", C["accent"]),
            (self.lbl_session, "bg", C["title"]), (self.lbl_session, "fg", C["dim"]),
            (self.btn_prev, "bg", C["title"]), (self.btn_prev, "fg", C["sub"]),
            (self.btn_next, "bg", C["title"]), (self.btn_next, "fg", C["sub"]),
            (self.btn_pin, "bg", C["title"]),
            (self.btn_pin, "fg", C["accent"] if self._topmost else C["dim"]),
            (self.btn_min, "bg", C["title"]), (self.btn_min, "fg", C["sub"]),
            (self.btn_x, "bg", C["title"]), (self.btn_x, "fg", C["sub"]),
            (self.lbl_bell, "bg", C["bg"]), (self.lbl_bell, "fg", C["dim"]),
            (self.lbl_status, "bg", C["bg"]), (self.lbl_status, "fg", C["dim"]),
            (self.lbl_cmd, "bg", C["bg"]), (self.lbl_cmd, "fg", C["text"]),
            (self.txt_footer, "bg", C["title"]), (self.txt_footer, "fg", C["text"]),
            (self.lbl_time, "bg", C["bg"]), (self.lbl_time, "fg", C["dim"]),
        ]
        if self.__dict__.get("_shape") != "orb":
            widgets.insert(0, (self, "bg", C["bg"]))
        for widget, option, value in widgets:
            widget.configure(**{option: value})
        for tag, color in (
            ("brain", "dim"), ("prov", "accent"), ("lock", "accent"),
            ("model", "cyan"), ("think", "purple"),
            ("tokens", "green"), ("cache", "orange"), ("ctx", "blue"),
            ("cost", "amber"), ("sep", "dim"),
        ):
            self.txt_footer.tag_config(tag, foreground=C[color])


    def _ensure_on_screen(self):
        if self._drag is not None or self.__dict__.get("_shape") == "orb":
            return
        try:
            if self.state() != "normal":
                return
            width, height = self.winfo_width(), self.winfo_height()
            x, y = self.winfo_x(), self.winfo_y()
            safe_x, safe_y = _safe_window_position(self, width, height, x, y)
            if (safe_x, safe_y) != (x, y):
                # Position-only geometry preserves the user-selected size.
                self.geometry(f"+{safe_x}+{safe_y}")
                self._save_geom()
        except (AttributeError, tk.TclError, TypeError, ValueError):
            pass

    def _load_geom(self):
        try:
            with open(CFG_FILE, encoding="utf-8") as f:
                saved = json.load(f)
            if not isinstance(saved, dict):
                return
            shape = saved.get("shape", "rect")
            self._shape = shape if shape in ("rect", "orb") else "rect"
            self._dock_edge = saved.get("dock") if saved.get("dock") in ("left", "right", "top", "bottom") else None
            self._orb_revealed = bool(saved.get("revealed"))
            self._orb_motion_enabled = saved.get("orb_motion") is not False
            language = saved.get("language", self.__dict__.get("_language", "zh"))
            self._language = language if language in LANGUAGES else "zh"
            value = saved.get("g")
            if not isinstance(value, str):
                return
            match = re.fullmatch(r"(\d+)x(\d+)((?:[+-]-?\d+){0,2})", value)
            if not match:
                return
            width = max(MIN_W, int(match.group(1)))
            height = max(MIN_H, int(match.group(2)))
            position = match.group(3)
            x, y = 120, 80
            if position:
                parts = re.findall(r"[+-]-?\d+", position)
                if len(parts) == 2:
                    x, y = (
                        int(part[1:] if part.startswith("+") else part)
                        for part in parts
                    )
            x, y = _safe_window_position(self, width, height, x, y)
            self._rect_geometry = f"{width}x{height}+{x}+{y}"
            self.geometry(self._rect_geometry)
        except (OSError, json.JSONDecodeError, AttributeError, TypeError, ValueError, tk.TclError):
            pass

    def _toggle_shape(self):
        if self.__dict__.get("_shape") == "orb":
            self._leave_orb()
        else:
            self._rect_geometry = self.geometry()
            self._enter_orb()
        self._save_geom()

    def _enter_orb(self, save=True):
        self._shape = "orb"
        self._rect_geometry = self._rect_geometry or self.geometry()
        for widget in (self._tbar, self._body, self._footer):
            widget.pack_forget()
        self._set_bell(False, C["dim"])
        self._orb_size = physical_size(self)
        self._orb_motion = OrbMotion()
        self._orb_hovered = False
        size = self._orb_size
        self.minsize(1, 1)
        self.maxsize(10000, 10000)
        self.minsize(size, size)
        self.maxsize(size, size)
        self.geometry(f"{size}x{size}+{self.winfo_x()}+{self.winfo_y()}")
        self._build_orb()
        self.update_idletasks()
        self._park_orb(save=save)

    def _leave_orb(self):
        self._shape = "rect"
        self._dock_edge = None
        self._orb_revealed = False
        self._stop_orb()
        if self._orb_canvas is not None:
            self._orb_canvas.destroy()
            self._orb_canvas = None
        self.attributes("-transparentcolor", "")
        self.attributes("-alpha", self._alpha)
        self.minsize(1, 1)
        self.maxsize(10000, 10000)
        self.configure(bg=C["bg"])
        self._tbar.pack(fill="x")
        self._body.pack(fill="both", expand=True, padx=14, pady=0)
        self._footer.pack(fill="x", side="bottom")
        self.geometry(self._rect_geometry or f"{DEFAULT_W}x{DEFAULT_H}+120+80")
        self._rect_geometry = None
        self.update_idletasks()
        self._update_scale(self.winfo_width(), self.winfo_height())
        self._apply_fonts()
        self._set_min_size()
        self._render(self._latest)

    def _build_orb(self):
        if self._orb_canvas is not None:
            return
        from orb import CHROME

        self.configure(bg=CHROME)
        # Native alpha owns pixels in orb mode; Tk -alpha would disable it.
        self.attributes("-alpha", 1.0)
        self.attributes("-transparentcolor", "" if _user32 is not None else CHROME)
        image = tk.Label(self, bg=CHROME, bd=0, highlightthickness=0)
        image.pack(fill="both", expand=True)
        self._orb_canvas = image
        self._orb_photo = None
        self._orb_cache = None

    def _park_orb(self, save=True):
        rectangle = self._current_screen_rectangle()
        if rectangle is None:
            return
        current = (self.winfo_x(), self.winfo_y(), self.winfo_width(), self.winfo_height())
        edge = dock_edge(*current, (rectangle,))
        if edge is None:
            self._dock_edge = None
            self._orb_revealed = False
            x, y = current[:2]
        else:
            self._dock_edge = edge[0]
            x, y, _width, _height = docked_geometry(
                edge[0], rectangle, size=self._orb_size,
                revealed=self._orb_revealed, anchor=current[:2],
            )
        size = self._orb_size
        self.minsize(size, size)
        self.maxsize(size, size)
        self.geometry(f"{size}x{size}+{int(x)}+{int(y)}")
        self._request_orb_frame()
        if save:
            self._save_geom()

    def _toggle_orb_reveal(self):
        if self._dock_edge is None:
            return
        self._orb_revealed = not self._orb_revealed
        self._park_orb()

    def _current_screen_rectangle(self):
        x, y = self.winfo_x(), self.winfo_y()
        rectangles = _screen_rectangles(self)
        for rectangle in rectangles:
            left, top, right, bottom = rectangle
            if left <= x < right and top <= y < bottom:
                return rectangle
        return rectangles[0] if rectangles else None

    def _request_orb_frame(self):
        if self._orb_canvas is not None and self._orb_after is None:
            self._orb_after = self.after(0, self._advance_orb)

    def _draw_orb(self):
        if self._orb_canvas is None or self.state() != "normal":
            return
        from orb import clamp_percent, orb_state, render_orb

        tokens = self._latest.get("tokens")
        tokens = tokens if isinstance(tokens, dict) else {}
        state = orb_state(self._latest)
        color = {"running": "#22d6ff", "thinking": "#ad6bff"}.get(state, C["dim"])
        frame = self._orb_motion.sample(
            time.monotonic(), state, color, self._orb_hovered,
            self._drag is not None, reduced=not self._orb_motion_enabled,
        )
        values = (clamp_percent(tokens.get("ctx_pct")), clamp_percent(tokens.get("hit_rate")))
        motion = (round(frame.pulse, 3), round(frame.hover, 3), round(frame.press, 3))
        key = (C["bg"], frame.color, state, values, self._orb_size, motion, self._alpha)
        if self._orb_cache != key:
            self._orb_rendered = render_orb(C["bg"], frame.color, *values, C, self._orb_size,
                                           tint=motion[0], hover=motion[1], pressed=motion[2], state=state)
            if _user32 is not None:
                from layered import LayeredWindow
                if self._orb_layer is None:
                    self._orb_layer = LayeredWindow(self)
                self._orb_layer.present(self._orb_rendered, self._alpha)
            else:
                from PIL import Image, ImageTk
                from orb import CHROME
                # Non-Windows Tk has no equivalent native per-pixel presenter.
                image = Image.new("RGB", self._orb_rendered.size, CHROME)
                image.paste(self._orb_rendered, mask=self._orb_rendered.getchannel("A").point(lambda a: 255 if a >= 128 else 0))
                self._orb_photo = ImageTk.PhotoImage(image, master=self)
                self._orb_canvas.configure(image=self._orb_photo)
            self._orb_cache = key
        if self._orb_after is None and frame.animate:
            self._orb_after = self.after(33, self._advance_orb)

    def _advance_orb(self):
        self._orb_after = None
        if self.__dict__.get("_shape") == "orb":
            self._draw_orb()

    def _toggle_orb_motion(self):
        self._orb_motion_enabled = not self._orb_motion_enabled
        if self._orb_after is not None:
            self.after_cancel(self._orb_after)
            self._orb_after = None
        if not self._orb_motion_enabled and self._summary is not None:
            if self._summary_fade_after is not None:
                self.after_cancel(self._summary_fade_after)
                self._summary_fade_after = None
            self._present_summary(1.0)
        self._request_orb_frame()
        self._save_geom()

    def _stop_orb(self):
        if self._orb_after is not None:
            self.after_cancel(self._orb_after)
            self._orb_after = None
        self._orb_hovered = self._pointer_inside = False
        if self.__dict__.get("_orb_layer") is not None:
            self._orb_layer.close()
            self._orb_layer = None
        self._orb_cache = None
        self._hide_summary(force=True)

    def _schedule_summary(self):
        if self._summary_after is None and self._summary is None:
            self._summary_after = self.after(180, self._show_summary)

    def _show_summary(self):
        if self.__dict__.get("_shape") != "orb" or self._drag is not None or not self._pointer_inside:
            return
        if self._summary_after is not None:
            self.after_cancel(self._summary_after)
            self._summary_after = None
        from orb import CHROME, popup_geometry, render_summary

        rectangle = self._current_screen_rectangle()
        if rectangle is None:
            return
        pixels = max(10, round(int(self._summary_font().cget("size")) * float(self.tk.call("tk", "scaling"))))
        summary_data = dict(self._latest) if isinstance(self._latest, dict) else {}
        summary_data["language"] = self._language
        self._summary_rendered = render_summary(summary_data, pixels)
        width, height = self._summary_rendered.size
        entering = self._summary is None
        if entering:
            popup = tk.Toplevel(self)
            popup.withdraw()
            popup.overrideredirect(True)
            popup.attributes("-topmost", self._topmost)
            popup.configure(bg=CHROME)
            label = tk.Label(popup, bg=CHROME, bd=0, highlightthickness=0)
            label.pack(fill="both", expand=True)
            popup.bind("<Enter>", lambda _event: self._cancel_summary_hide())
            popup.bind("<Leave>", lambda _event: self._queue_summary_hide())
            self._summary = popup
            self._summary_label = label
            self._summary_opacity = 0.0 if self._orb_motion_enabled else 1.0
        x, y, _width, _height = popup_geometry(
            self._dock_edge,
            (self.winfo_x(), self.winfo_y(), self._orb_size, self._orb_size),
            width, height, rectangle,
        )
        self._summary.geometry(f"{width}x{height}+{x}+{y}")
        self._summary.update_idletasks()
        self._present_summary(self._summary_opacity)
        if entering:
            self._summary.deiconify()
            self._summary_fade_start = time.monotonic()
            self._fade_summary()

    def _present_summary(self, opacity):
        self._summary_opacity = opacity
        if _user32 is not None:
            from layered import LayeredWindow
            if self._summary_layer is None:
                self._summary_layer = LayeredWindow(self._summary)
            self._summary_layer.present(self._summary_rendered, opacity)
        else:
            from PIL import Image, ImageTk
            from orb import CHROME
            image = Image.new("RGB", self._summary_rendered.size, CHROME)
            image.paste(self._summary_rendered, mask=self._summary_rendered.getchannel("A").point(lambda a: 255 if a >= 128 else 0))
            self._summary_photo = ImageTk.PhotoImage(image, master=self)
            self._summary_label.configure(image=self._summary_photo)
            self._summary.attributes("-transparentcolor", CHROME)
            self._summary.attributes("-alpha", .71 * opacity)

    def _fade_summary(self):
        self._summary_fade_after = None
        if self._summary is None:
            return
        progress = min(1.0, (time.monotonic() - self._summary_fade_start) / .16)
        if not self._orb_motion_enabled:
            progress = 1.0
        self._present_summary(1 - (1 - progress) ** 3)
        if progress < 1:
            self._summary_fade_after = self.after(16, self._fade_summary)

    def _queue_summary_hide(self):
        self._pointer_inside = False
        if self._summary_after is not None:
            self.after_cancel(self._summary_after)
            self._summary_after = None
        self._summary_after = self.after(220, self._hide_summary)

    def _cancel_summary_hide(self):
        self._pointer_inside = True
        if self._summary_after is not None:
            self.after_cancel(self._summary_after)
            self._summary_after = None

    def _hide_summary(self, force=False):
        if self._summary_after is not None:
            self.after_cancel(self._summary_after)
            self._summary_after = None
        if self._pointer_inside and not force:
            return
        if self._summary_fade_after is not None:
            self.after_cancel(self._summary_fade_after)
            self._summary_fade_after = None
        if self.__dict__.get("_summary_layer") is not None:
            self._summary_layer.close()
            self._summary_layer = None
        if self._summary is not None:
            self._summary.destroy()
            self._summary = None
            self._summary_label = None

    # ── Session switching ──
    def _get_sessions(self):
        """获取所有 session 文件（按修改时间降序）"""
        return self.col._cache.all_sessions

    def _update_session_label(self):
        self._get_sessions()
        total = self._active_session_count()
        if total == 0:
            self.lbl_session.config(text="")
        elif self._auto_follow:
            self.lbl_session.config(text="● auto", fg=C["green"])
        else:
            idx = min(self._session_idx + 1, total)
            self.lbl_session.config(text=f"{idx}/{total}", fg=C["accent"])

    def _active_session_count(self):
        """存活 Pi 终端数：PID 目录中仍存活的进程"""
        return self._alive_pid_count()

    def _alive_pid_count(self):
        """数 PID 目录中仍在运行的终端。"""
        return _alive_pid_count()


    def _cleanup_stale_pids(self):
        """清理 PID 目录中已死掉的条目。"""
        _alive_pid_count()


    def _auto_follow_session(self):
        sessions = self._get_sessions()
        if not sessions:
            return
        self._auto_follow = True
        self.col.auto_follow()
        self._session_idx = 0
        self._update_session_label()

    def _switch_session(self, direction):
        """手动切换 session（仅限存活的终端）"""
        pid_count = self._alive_pid_count()
        if pid_count == 0:
            return
        sessions = self._get_sessions()
        cutoff = datetime.now(timezone.utc).timestamp() - 5 * 60
        recent = [s for s in sessions if os.path.getmtime(s) > cutoff]
        pool = recent[:pid_count] if recent else sessions[:pid_count]
        if not pool:
            return
        self._auto_follow = False
        self.col._auto_follow = False
        current = self.col._cache.file
        current_idx = pool.index(current) if current in pool else self._session_idx
        self._session_idx = max(0, min(len(pool) - 1, current_idx + direction))
        self.col.switch_to(pool[self._session_idx])
        self._update_session_label()

    def _on_pointer_leave(self, event):
        if self.__dict__.get("_shape") != "orb" or event.widget not in (self, self._orb_canvas):
            return
        self._orb_hovered = False
        self._request_orb_frame()
        self._queue_summary_hide()

    def _on_config(self, e):
        if e.widget is not self or self.__dict__.get("_shape") == "orb":
            return
        w, h = e.width, e.height
        if (
            abs(getattr(self, "_lw", -1) - w) < 2
            and abs(getattr(self, "_lh", -1) - h) < 2
        ):
            return
        self._lw, self._lh = w, h
        if self._drag:
            self._sync_wraplength(w)
            return
        self._update_scale(w, h)
        self._apply_fonts()
        self._sync_wraplength()
        if self._drag is None:
            self._sync_footer_height()

    def _sync_wraplength(self, width=None):
        try:
            bw = self.winfo_width() if width is None else width
            if bw > 40:
                wl = max(80, bw - 28)
                self.lbl_status.configure(wraplength=wl)
                self.lbl_session.configure(wraplength=wl)
        except tk.TclError:
            pass

    def _sync_footer_height(self, resizing=False):
        if self.__dict__.get("_shape") == "orb" or self._footer_syncing or (self._drag is not None and not resizing):
            return
        self._footer_syncing = True
        try:
            display_lines = self.txt_footer.count(
                "1.0", "end-1c", "update", "displaylines"
            )
            if isinstance(display_lines, (tuple, list)):
                display_lines = display_lines[0] if display_lines else 0
            # Tk excludes the display row containing end-1c from its count.
            lines = min(2, max(1, 1 + int(display_lines or 0)))
            if self._footer_lines != lines:
                self._footer_lines = lines
                self.txt_footer.configure(height=lines)
            if resizing and self._is_horizontal_resize():
                self._fit_footer_window(queued=True)
            if not resizing:
                self.update_idletasks()
                self._set_min_size()
        except (IndexError, TypeError, tk.TclError):
            pass
        finally:
            self._footer_syncing = False

    def _content_min_height(self):
        """Return content height without feeding the current window height back into itself."""
        self.update_idletasks()
        body_height = self.lbl_status.winfo_reqheight() + self.lbl_cmd.winfo_reqheight() + 3
        footer_height = self.txt_footer.winfo_reqheight() + 4
        return TITLE_H + body_height + 10 + footer_height

    def _set_min_size(self):
        if self.__dict__.get("_shape") == "orb":
            self.minsize(self._orb_size, self._orb_size)
            self.maxsize(self._orb_size, self._orb_size)
            return
        try:
            self.update_idletasks()
            min_height = max(MIN_H, self._content_min_height())
            previous_min_height = self.__dict__.get("_last_min_height", min_height)
            self._last_min_height = min_height
            width = max(MIN_W, self.winfo_width())
            current_height = self.winfo_height()
            if self._drag is None and (
                current_height < min_height
                or (current_height == previous_min_height and min_height < previous_min_height)
            ):
                self.geometry(f"{width}x{min_height}+{self.winfo_x()}+{self.winfo_y()}")
            self.minsize(MIN_W, min_height)
        except (AttributeError, tk.TclError):
            pass


    def _quit(self):
        self._save_geom()
        self._stop_orb()
        with suppress(Exception):
            self.col.stop()  # type: ignore[union-attr]
        with suppress(Exception):
            _release_lock()
        self.destroy()


if __name__ == "__main__":
    _acquire_lock()
    try:
        HUD().mainloop()
    finally:
        _release_lock()
