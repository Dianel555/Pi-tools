"""Present Pillow RGBA on a Windows Tk window without a color-key matte."""

import ctypes
import sys
from ctypes import wintypes


def premultiplied_bgra(image):
    """UpdateLayeredWindow requires premultiplied, top-down 32-bit BGRA."""
    return image.convert("RGBA").convert("RGBa").tobytes("raw", "BGRa")


if sys.platform == "win32":
    _user = ctypes.WinDLL("user32", use_last_error=True)
    _gdi = ctypes.WinDLL("gdi32", use_last_error=True)

    class _BitmapHeader(ctypes.Structure):
        _fields_ = [
            ("size", wintypes.DWORD), ("width", wintypes.LONG), ("height", wintypes.LONG),
            ("planes", wintypes.WORD), ("bits", wintypes.WORD), ("compression", wintypes.DWORD),
            ("image_size", wintypes.DWORD), ("xppm", wintypes.LONG), ("yppm", wintypes.LONG),
            ("used", wintypes.DWORD), ("important", wintypes.DWORD),
        ]

    class _Blend(ctypes.Structure):
        _fields_ = [("op", wintypes.BYTE), ("flags", wintypes.BYTE),
                    ("alpha", wintypes.BYTE), ("format", wintypes.BYTE)]

    def _bind(library, name, args, result):
        function = getattr(library, name)
        function.argtypes, function.restype = args, result
        return function

    _ancestor = _bind(_user, "GetAncestor", [wintypes.HWND, wintypes.UINT], wintypes.HWND)
    _is_window = _bind(_user, "IsWindow", [wintypes.HWND], wintypes.BOOL)
    suffix = "PtrW" if ctypes.sizeof(ctypes.c_void_p) == 8 else "W"
    _get_style = _bind(_user, "GetWindowLong" + suffix,
                       [wintypes.HWND, ctypes.c_int], ctypes.c_ssize_t)
    _set_style = _bind(_user, "SetWindowLong" + suffix,
                       [wintypes.HWND, ctypes.c_int, ctypes.c_ssize_t], ctypes.c_ssize_t)
    _create_dc = _bind(_gdi, "CreateCompatibleDC", [wintypes.HDC], wintypes.HDC)
    _delete_dc = _bind(_gdi, "DeleteDC", [wintypes.HDC], wintypes.BOOL)
    _create_dib = _bind(_gdi, "CreateDIBSection", [
        wintypes.HDC, ctypes.POINTER(_BitmapHeader), wintypes.UINT,
        ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD,
    ], wintypes.HBITMAP)
    _select = _bind(_gdi, "SelectObject", [wintypes.HDC, wintypes.HANDLE], wintypes.HANDLE)
    _delete_object = _bind(_gdi, "DeleteObject", [wintypes.HANDLE], wintypes.BOOL)
    _update = _bind(_user, "UpdateLayeredWindow", [
        wintypes.HWND, wintypes.HDC, ctypes.POINTER(wintypes.POINT),
        ctypes.POINTER(wintypes.SIZE), wintypes.HDC, ctypes.POINTER(wintypes.POINT),
        wintypes.DWORD, ctypes.POINTER(_Blend), wintypes.DWORD,
    ], wintypes.BOOL)


def _checked_style(hwnd, style):
    ctypes.set_last_error(0)
    result = _set_style(hwnd, -20, style)
    if not result and ctypes.get_last_error():
        raise ctypes.WinError(ctypes.get_last_error())


class LayeredWindow:
    """Tk owns geometry/input; the compositor owns only the window's pixels.

    Do not set Tk -alpha/-transparentcolor while this presenter is active:
    SetLayeredWindowAttributes disables UpdateLayeredWindow until the layered
    bit is reset. Tk may recreate its wrapper HWND on minimize/restore, so
    resolve it on each presentation rather than holding a stale native handle.
    """

    def __init__(self, window):
        if sys.platform != "win32":
            raise OSError("Per-pixel HUD transparency requires Windows")
        self.window = window
        self.hwnd = None

    def present(self, image, opacity=1.0):
        hwnd = _ancestor(self.window.winfo_id(), 2)  # GA_ROOT, not the Tk client HWND.
        if not hwnd:
            raise ctypes.WinError(ctypes.get_last_error())
        if hwnd != self.hwnd:
            style = _get_style(hwnd, -20)
            _checked_style(hwnd, style & ~0x80000)
            _checked_style(hwnd, style | 0x80000)
            self.hwnd = hwnd
        width, height = image.size
        payload = premultiplied_bgra(image)
        dc = _create_dc(None)
        if not dc:
            raise ctypes.WinError(ctypes.get_last_error())
        bitmap = previous = None
        try:
            header = _BitmapHeader(ctypes.sizeof(_BitmapHeader), width, -height, 1, 32)
            bits = ctypes.c_void_p()
            bitmap = _create_dib(dc, ctypes.byref(header), 0, ctypes.byref(bits), None, 0)
            if not bitmap or not bits.value:
                raise ctypes.WinError(ctypes.get_last_error())
            previous = _select(dc, bitmap)
            if not previous or previous == ctypes.c_void_p(-1).value:
                previous = None
                raise ctypes.WinError(ctypes.get_last_error())
            ctypes.memmove(bits, payload, len(payload))
            blend = _Blend(0, 0, round(max(0.0, min(1.0, opacity)) * 255), 1)
            size, source = wintypes.SIZE(width, height), wintypes.POINT(0, 0)
            if not _update(hwnd, None, None, ctypes.byref(size), dc,
                           ctypes.byref(source), 0, ctypes.byref(blend), 2):
                raise ctypes.WinError(ctypes.get_last_error())
        finally:
            if previous:
                _select(dc, previous)
            if bitmap:
                _delete_object(bitmap)
            _delete_dc(dc)

    def close(self):
        if self.hwnd and _is_window(self.hwnd):
            _checked_style(self.hwnd, _get_style(self.hwnd, -20) & ~0x80000)
        self.hwnd = None
