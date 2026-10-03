"""Deterministic material/motion tests; run with python test/pi-hud/orb_ui_test.py."""
import math
import queue
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages" / "pi-hud"))

from PIL import Image, ImageChops
import orb
from theme import THEMES


class OrbMaterialTests(unittest.TestCase):
    def render(self, size=133, **kwargs):
        return orb.render_orb("#1a1b26", "#7dcfff", 48, 76, THEMES["dark"], size, **kwargs)

    def test_complete_circular_silhouette_at_different_scales(self):
        self.assertEqual(orb.ORB_SIZE, 50)
        for size in (50, 67, 75, 100):
            image = self.render(size)
            self.assertEqual(image.mode, "RGBA")
            alpha = image.getchannel("A")
            self.assertTrue(any(0 < a < 255 for a in alpha.tobytes()))
            center = (size - 1) / 2
            radii = []
            for y in range(size):
                xs = [x for x in range(size) if alpha.getpixel((x, y)) >= 128]
                if not xs:
                    continue
                self.assertEqual(xs, list(range(xs[0], xs[-1] + 1)))
                self.assertLessEqual(abs(xs[0] + xs[-1] - (size - 1)), 1)
                radii.extend(math.hypot(x - center, y - center) for x in (xs[0], xs[-1]))
            self.assertLess(max(radii) - min(radii), 1.6)
            self.assertGreater(min(radii), size * .46)
            self.assertEqual(image.getpixel((0, 0))[3], 0)
            self.assertLess(image.getpixel((size // 2, 0))[3], 32)
            self.assertGreater(image.getpixel((size // 2, round(size * .04)))[3], 0)
            # Alpha coverage must not darken RGB into a matte at the rim.
            self.assertTrue(all(min(image.getpixel((x, y))[:3]) > 12
                                for y in range(size) for x in range(size)
                                if image.getpixel((x, y))[3] > 128))

    def test_animation_never_recolors_rings_or_changes_outline(self):
        quiet = self.render(tint=0, hover=0, pressed=0, state="running")
        active = self.render(tint=1, hover=1, pressed=1, state="running")
        box = ImageChops.difference(quiet.convert("RGB"), active.convert("RGB")).getbbox()
        self.assertIsNotNone(box)
        self.assertGreater(box[0], 133 * .15)
        self.assertGreater(box[1], 133 * .15)
        self.assertLess(box[2], 133 * .85)
        self.assertLess(box[3], 133 * .85)
        for y in range(133):
            for x in range(133):
                if math.hypot(x - 66, y - 66) > 133 * .285:
                    self.assertEqual(quiet.getpixel((x, y)), active.getpixel((x, y)))

    def test_idle_has_no_colored_light_and_active_glow_is_smooth(self):
        for palette in THEMES.values():
            args = (palette["bg"],)
            idle = orb.render_orb(*args, "#22d6ff", 48, 76, palette, 67, 0, state="idle")
            other = orb.render_orb(*args, "#ad6bff", 48, 76, palette, 67, 1, state="idle")
            self.assertEqual(idle.tobytes(), other.tobytes())
            active = orb.render_orb(*args, "#22d6ff", 48, 76, palette, 67, 1, state="running")
            self.assertNotEqual(idle.tobytes(), active.tobytes())
        glow = orb._masks(133)[0]
        samples = [glow.getpixel((x, 66)) for x in range(66, 97)]
        self.assertEqual(samples, sorted(samples, reverse=True))
        self.assertLessEqual(max(a - b for a, b in zip(samples, samples[1:])), 12)
        self.assertGreater(samples[-1], 0)

    def test_stages_have_long_smooth_handoffs_and_absolute_thresholds(self):
        colors = orb.RING_LAYOUT[0][3]
        self.assertEqual(orb._stage_color(colors, 60), colors[0])
        self.assertEqual(orb._stage_color(colors, 180), colors[1])
        self.assertEqual(orb._stage_color(colors, 300), colors[2])
        for boundary in (120, 240):
            a = orb._rgba(orb._stage_color(colors, boundary - .001))
            b = orb._rgba(orb._stage_color(colors, boundary + .001))
            self.assertLessEqual(max(abs(x-y) for x, y in zip(a, b)), 1)
        self.assertEqual(orb._stage_color(colors, 360), colors[-1])
        for boundary in (120, 240):
            index = int(boundary / 120)
            self.assertNotEqual(orb._stage_color(colors, boundary - 10), colors[index - 1])
            self.assertNotEqual(orb._stage_color(colors, boundary + 10), colors[index])
            self.assertEqual(orb._stage_color(colors, boundary - 14), colors[index - 1])
            self.assertEqual(orb._stage_color(colors, boundary + 14), colors[index])
            left = orb._rgba(orb._stage_color(colors, boundary - 14))
            next_color = orb._rgba(orb._stage_color(colors, boundary - 13.5))
            self.assertLessEqual(max(abs(a - b) for a, b in zip(left, next_color)), 1)

    def test_missing_and_nonfinite_metrics_are_safe(self):
        for value in (None, "bad", float("nan"), float("inf"), -float("inf")):
            self.assertIsNone(orb.clamp_percent(value))
            image = orb.render_orb("#1a1b26", "#7dcfff", value, value, {}, 100)
            self.assertEqual(image.size, (100, 100))
        self.assertEqual(orb.clamp_percent(-3), 0)
        self.assertEqual(orb.clamp_percent(101), 100)

    def test_theme_and_metric_changes_invalidate_only_bounded_static_layers(self):
        dark = self.render()
        light = orb.render_orb("#f5f7fb", "#7dcfff", 48, 76, THEMES["white"], 133)
        self.assertIsNotNone(ImageChops.difference(dark.convert("RGB"), light.convert("RGB")).getbbox())
        for value in range(24):
            orb.render_orb("#1a1b26", "#7dcfff", value, value, THEMES["dark"], 100)
        self.assertLessEqual(orb._ring_layer.cache_info().currsize, 16)
        before = orb._ring_layer.cache_info().misses
        for tint in (0, .2, .4, .7, 1):
            orb.render_orb("#1a1b26", "#7dcfff", 23, 23, THEMES["dark"], 100, tint)
        self.assertEqual(orb._ring_layer.cache_info().misses, before)


    def test_no_extra_rim_or_status_name_and_thicker_close_rings(self):
        outer, inner = orb.RING_LAYOUT
        self.assertEqual(outer[2], "ctx")
        # Half-size dial but 1.5× the previous physical stroke, not a thinner result.
        self.assertGreaterEqual(outer[1] * .5, .032 * 1.5)
        self.assertGreaterEqual(inner[1] * .5, .028 * 1.5)
        self.assertLess(inner[0] - outer[0] - outer[1], .025)
        self.assertLess(outer[0], .04)
        mark = orb._mark_layer(67)
        self.assertFalse(any(mark.getpixel((x, y))[3] for y in range(49, 67) for x in range(67)))

    def test_translucent_summary_has_smooth_alpha_and_opaque_text(self):
        image = orb.render_summary({"provider": "demo", "model": "测试 Pi", "tokens": {}}, 18)
        self.assertEqual(image.mode, "RGBA")
        self.assertEqual(image.getpixel((0, 0))[3], 0)
        alphas = image.getchannel("A")
        self.assertGreater(len(set(alphas.tobytes())), 20)
        self.assertTrue(any(0 < value < 128 for value in alphas.tobytes()))
        self.assertTrue(any(value == 255 for value in alphas.tobytes()))
        self.assertEqual(image.getpixel((image.width // 2, image.height - 3))[3], 180)
        smaller = orb.render_summary({"provider": "demo", "model": "测试 Pi", "tokens": {}}, 16)
        self.assertLess(smaller.width, image.width)
        self.assertLess(smaller.height, image.height)


class OrbMotionTests(unittest.TestCase):
    def test_hover_and_press_ease_then_settle_without_overshoot(self):
        motion = orb.OrbMotion()
        motion.sample(0, "idle", "#778899")
        first = motion.sample(.033, "idle", "#778899", hovered=True, pressed=True)
        self.assertTrue(0 < first.hover < 1 and 0 < first.press < 1)
        settled = motion.sample(2, "idle", "#778899", hovered=True, pressed=True)
        self.assertEqual((settled.hover, settled.press, settled.animate), (1, 1, False))
        motion.sample(2.033, "idle", "#778899")
        settled = motion.sample(4, "idle", "#778899")
        self.assertEqual((settled.hover, settled.press, settled.animate), (0, 0, False))

    def test_interaction_after_long_idle_still_eases(self):
        motion = orb.OrbMotion()
        motion.sample(0, "idle", "#778899")
        frame = motion.sample(600, "idle", "#778899", hovered=True)
        self.assertTrue(0 < frame.hover < 1)
        self.assertTrue(frame.animate)

    def test_motion_is_time_based_and_reduced_mode_is_static(self):
        motion = orb.OrbMotion()
        a = motion.sample(0, "thinking", "#aabbcc")
        b = motion.sample(.9, "thinking", "#aabbcc")
        self.assertNotEqual(a.pulse, b.pulse)
        self.assertTrue(b.animate)
        for now in (1, 2, 10):
            frame = motion.sample(now, "running", "#abcdef", hovered=True, reduced=True)
            self.assertFalse(frame.animate)
            self.assertEqual((frame.pulse, frame.hover, frame.color), (.5, 1, "#abcdef"))


class NativeAlphaTests(unittest.TestCase):
    def test_bgra_is_premultiplied_with_unchanged_alpha(self):
        from layered import premultiplied_bgra
        image = Image.new("RGBA", (3, 1))
        image.putdata([(200, 100, 50, 128), (255, 200, 100, 0), (40, 60, 80, 255)])
        self.assertEqual(premultiplied_bgra(image), bytes([25, 50, 100, 128, 0, 0, 0, 0, 80, 60, 40, 255]))

    @unittest.skipUnless(sys.platform == "win32", "Windows GDI ownership")
    def test_native_frames_and_failed_updates_release_all_gdi_resources(self):
        import ctypes
        from ctypes import wintypes
        import tkinter as tk
        import layered
        root = tk.Tk()
        root.overrideredirect(True)
        root.geometry("67x67+100+100")
        root.update_idletasks()
        presenter = layered.LayeredWindow(root)
        image = orb.render_orb("#1a1b26", "#22d6ff", 48, 76, THEMES["dark"], 67)
        try:
            presenter.present(image)
            kernel = ctypes.WinDLL("kernel32")
            kernel.GetCurrentProcess.restype = wintypes.HANDLE
            resources = layered._user.GetGuiResources
            resources.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            resources.restype = wintypes.DWORD
            process = kernel.GetCurrentProcess()
            before = resources(process, 0)
            for _ in range(80):
                presenter.present(image, .8)
            self.assertEqual(resources(process, 0), before)
            with patch.object(layered, "_update", return_value=False), \
                    patch.object(layered, "_delete_dc", wraps=layered._delete_dc) as delete_dc, \
                    patch.object(layered, "_delete_object", wraps=layered._delete_object) as delete_bitmap:
                with self.assertRaises(OSError):
                    presenter.present(image)
                delete_dc.assert_called_once()
                delete_bitmap.assert_called_once()
            self.assertEqual(resources(process, 0), before)
            with patch.object(layered, "_create_dib", return_value=None), \
                    patch.object(layered, "_delete_dc", wraps=layered._delete_dc) as delete_dc:
                with self.assertRaises(OSError):
                    presenter.present(image)
                delete_dc.assert_called_once()
            self.assertEqual(resources(process, 0), before)
            presenter.close()
            root.attributes("-alpha", .95)
            root.overrideredirect(False)
            root.update_idletasks()
            # Tk wrapper handles can be recreated: resolve the new native root.
            presenter.present(image)
            self.assertIsNotNone(presenter.hwnd)
        finally:
            presenter.close()
            root.destroy()


class OrbLifecycleTests(unittest.TestCase):
    def test_stop_cancels_animation_summary_delay_and_fade(self):
        import pi_hud
        hud = pi_hud.HUD.__new__(pi_hud.HUD)
        hud._orb_after = "frame"
        hud._summary_after = "delay"
        hud._summary_fade_after = "fade"
        hud._pointer_inside = hud._orb_hovered = True
        calls = []
        hud.after_cancel = lambda handle: calls.append(handle)
        hud._summary = SimpleNamespace(destroy=lambda: calls.append("destroy"))
        hud._stop_orb()
        self.assertEqual(calls, ["frame", "delay", "fade", "destroy"])
        self.assertFalse(hud._orb_hovered)
        self.assertIsNone(hud._summary)
        self.assertIsNone(hud._orb_after)

    def test_telemetry_does_not_cancel_pending_popup_hide(self):
        import pi_hud
        hud = pi_hud.HUD.__new__(pi_hud.HUD)
        hud._shape = "orb"
        hud._drag = None
        hud._pointer_inside = False
        hud._summary_after = "hide"
        hud._summary = object()
        hud._request_orb_frame = lambda: None
        cancelled = []
        hud.after_cancel = lambda handle: cancelled.append(handle)
        hud._render({"tokens": {}})
        self.assertEqual(cancelled, [])
        self.assertEqual(hud._summary_after, "hide")

    def test_frame_requests_are_single_flight(self):
        import pi_hud
        hud = pi_hud.HUD.__new__(pi_hud.HUD)
        hud._orb_canvas = object()
        hud._orb_after = None
        calls = []
        hud.after = lambda *args: calls.append(args) or "pending"
        for _ in range(10):
            hud._request_orb_frame()
        self.assertEqual(len(calls), 1)

    @unittest.skipUnless(sys.platform == "win32", "Windows per-pixel alpha integration")
    def test_real_tk_scaling_docking_hover_and_mode_cleanup(self):
        import tkinter as tk
        import pi_hud

        class Collector:
            def __init__(self, *args):
                self.q = queue.Queue()
                self._cache = SimpleNamespace(all_sessions=[])
            def start(self): pass
            def stop(self): pass

        with tempfile.TemporaryDirectory() as temp, patch.object(pi_hud, "Collector", Collector), \
                patch.object(pi_hud, "CFG_FILE", str(Path(temp) / "geometry.json")):
            hud = pi_hud.HUD()
            errors = []
            hud.report_callback_exception = lambda *args: errors.append(args)

            def pump(ms=80):
                done = tk.BooleanVar(master=hud)
                hud.after(ms, lambda: done.set(True))
                hud.wait_variable(done)

            try:
                pump()
                hud._render({"provider": "demo", "model": "Pi", "thinking": "high",
                             "agent_active": True, "tokens": {"ctx_pct": 48, "hit_rate": 76}})
                pump()
                original = hud.geometry()
                hud._toggle_shape()
                pump()
                self.assertIsNone(hud._bell_after)
                self.assertEqual(hud._orb_rendered.width, hud.winfo_width())
                self.assertEqual(hud.winfo_width(), hud.winfo_height())
                self.assertEqual(hud._orb_canvas.winfo_width(), hud._orb_rendered.width)
                self.assertIsNotNone(hud._orb_layer.hwnd)
                self.assertIsNotNone(hud._orb_after)
                hud._toggle_alpha()
                pump()
                self.assertEqual(float(hud.attributes("-alpha")), 1.0)
                self.assertEqual(hud._alpha, pi_hud.ALPHA_LOW)
                hud._toggle_alpha()
                pump()
                # Reduced motion persists and removes the repeating frame loop.
                hud._toggle_orb_motion()
                pump()
                self.assertIsNone(hud._orb_after)
                hud._orb_canvas.event_generate("<Motion>", x=30, y=30)
                pump(220)
                self.assertIsNotNone(hud._summary)
                summary_widget = hud._summary_label
                hud._on_press(SimpleNamespace(widget=summary_widget))
                self.assertIsNone(hud._drag, "summary must not drag the orb")
                popup = hud._summary
                ox, oy, s = hud.winfo_x(), hud.winfo_y(), hud._orb_size
                px, py, pw, ph = popup.winfo_x(), popup.winfo_y(), popup.winfo_width(), popup.winfo_height()
                self.assertTrue(px >= ox+s or px+pw <= ox or py >= oy+s or py+ph <= oy)
                self.assertIsNone(hud._summary_fade_after)
                # Stop destroys a visible popup even if the pointer remains inside.
                hud._leave_orb()
                pump()
                self.assertIsNone(hud._summary)
                self.assertIsNone(hud._orb_after)
                self.assertEqual(hud.geometry(), original)
                self.assertEqual(hud.lbl_status.cget("text"), hud._t("thinking"))
                hud._toggle_shape()
                hud._toggle_orb_motion()
                pump()
                hud._toggle_hide()
                pump()
                self.assertEqual(hud.state(), "iconic")
                self.assertIsNone(hud._orb_after)
                hud.deiconify()
                pump(180)
                self.assertEqual(hud.state(), "normal")
                self.assertIsNotNone(hud._orb_after)
                hud._toggle_shape()
                pump()
                # Exercise real Tk pixel bounds rather than mocking DPI math.
                for scale in (1.0, 1.333333, 1.5, 2.0):
                    hud.tk.call("tk", "scaling", scale)
                    hud._toggle_shape()
                    pump()
                    size = hud._orb_size
                    self.assertEqual(hud._orb_rendered.width, size)
                    self.assertEqual((hud.winfo_width(), hud.winfo_height()), (size, size))
                    hud.geometry(f"{size}x{size}+0+200")
                    pump()
                    hud._park_orb()
                    pump()
                    self.assertEqual(hud.winfo_x(), -(size // 2))
                    hud._toggle_orb_reveal()
                    pump()
                    self.assertEqual(hud.winfo_x(), 0)
                    hud._toggle_shape()
                    pump()
                self.assertFalse(errors, errors)
            finally:
                hud._stop_orb()
                hud._set_bell(False, pi_hud.C["dim"])
                hud.destroy()


if __name__ == "__main__":
    unittest.main()
