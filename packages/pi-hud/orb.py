"""Circular HUD geometry, docking, and summary presentation."""

import math
import os
from dataclasses import dataclass
from functools import lru_cache

from i18n import translate
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ORB_SIZE = 50
RENDER_SCALE = 6
ORB_MARGIN = 10
DOCK_THRESHOLD = 8
POPUP_GAP = 8
CHROME = "#010203"
RING_LAYOUT = (
    (0.020, 0.096, "ctx", ("#44bdda", "#668cf4", "#a58bed")),
    (0.130, 0.084, "cache", ("#82b895", "#ddba75", "#d18a86")),
)


def mix_color(start, end, amount):
    """Blend two #RRGGBB colors. Amount 0 returns start and 1 returns end."""
    amount = max(0.0, min(1.0, float(amount)))
    left = tuple(int(start[index:index + 2], 16) for index in (1, 3, 5))
    right = tuple(int(end[index:index + 2], 16) for index in (1, 3, 5))
    mixed = tuple(round(left[index] + (right[index] - left[index]) * amount) for index in range(3))
    return "#" + "".join(f"{channel:02x}" for channel in mixed)


LOGO_VIEWBOX = 800
LOGO_INK = (165.29, 165.29, 634.72, 634.72)
LOGO_PATHS = (
    ("#F09082", ((165.29, 165.29), (517.36, 165.29), (517.36, 400), (400, 400), (400, 282.65), (165.29, 282.65))),
    ("#4D9ABF", ((165.29, 282.65), (282.65, 282.65), (282.65, 400), (400, 400), (400, 517.36), (282.65, 517.36), (282.65, 634.72), (165.29, 634.72))),
    ("#F1BE58", ((517.36, 400), (634.72, 400), (634.72, 634.72), (517.36, 634.72))),
)


def clamp_percent(value):
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return max(0.0, min(100.0, value)) if math.isfinite(value) else None


def orb_state(data):
    data = data if isinstance(data, dict) else {}
    if data.get("agent_active") and data.get("command"):
        return "running"
    if data.get("agent_active"):
        return "thinking"
    return "idle"


def dock_edge(x, y, width, height, rectangles, threshold=DOCK_THRESHOLD):
    """Return the nearest screen edge within the docking threshold."""
    if not rectangles:
        return None
    candidates = []
    for left, top, right, bottom in rectangles:
        if y >= bottom or y + height <= top or x >= right or x + width <= left:
            continue
        distances = {
            "left": x - left,
            "right": right - (x + width),
            "top": y - top,
            "bottom": bottom - (y + height),
        }
        edge, distance = min(distances.items(), key=lambda item: item[1])
        if distance <= threshold:
            candidates.append((distance, edge, (left, top, right, bottom)))
    if not candidates:
        return None
    return min(candidates, key=lambda item: item[0])[1:]


def docked_geometry(edge, rectangle, size=ORB_SIZE, revealed=False, margin=ORB_MARGIN, anchor=None):
    """Place a circle halfway off the requested edge without recentering it."""
    left, top, right, bottom = rectangle
    anchor_x, anchor_y = anchor or (left, top)
    hidden = 0 if revealed else size // 2
    if edge == "left":
        x, y = left - hidden, anchor_y
    elif edge == "right":
        x, y = right - size + hidden, anchor_y
    elif edge == "top":
        x, y = anchor_x, top - hidden
    else:
        x, y = anchor_x, bottom - size + hidden
    if edge in ("top", "bottom"):
        x = min(max(x, left + margin), right - size - margin)
    else:
        y = min(max(y, top + margin), bottom - size - margin)
    return int(x), int(y), size, size


def popup_geometry(edge, orb, popup_width, popup_height, rectangle):
    """Place the summary beside the orb, never over its visible face."""
    x, y, size, _height = orb
    left, top, right, bottom = rectangle
    gap = POPUP_GAP
    candidates = []
    if edge != "right" and x + size + gap + popup_width <= right - ORB_MARGIN:
        candidates.append((x + size + gap, y + (size - popup_height) // 2))
    if edge != "left" and x - gap - popup_width >= left + ORB_MARGIN:
        candidates.append((x - popup_width - gap, y + (size - popup_height) // 2))
    if edge != "bottom" and y + size + gap + popup_height <= bottom - ORB_MARGIN:
        candidates.append((x + (size - popup_width) // 2, y + size + gap))
    if edge != "top" and y - gap - popup_height >= top + ORB_MARGIN:
        candidates.append((x + (size - popup_width) // 2, y - popup_height - gap))
    if not candidates:
        candidates.append((right - popup_width - ORB_MARGIN, bottom - popup_height - ORB_MARGIN))
    px, py = candidates[0]
    px = min(max(px, left + ORB_MARGIN), right - popup_width - ORB_MARGIN)
    py = min(max(py, top + ORB_MARGIN), bottom - popup_height - ORB_MARGIN)
    return int(px), int(py), int(popup_width), int(popup_height)


def logo_polygons(bounds):
    """Scale the official Pi mark to fill the target bounds exactly."""
    left, top, right, bottom = bounds
    ink_left, ink_top, ink_right, ink_bottom = LOGO_INK
    span = ink_right - ink_left
    width, height = right - left, bottom - top

    def point(x, y):
        return left + (x - ink_left) / span * width, top + (y - ink_top) / span * height

    return tuple(
        (color, tuple(coord for vertex in path for coord in point(*vertex)))
        for color, path in LOGO_PATHS
    )


def summary_segments(data, language="en"):
    """Return one summary line without the current command."""
    data = data if isinstance(data, dict) else {}
    tokens = data.get("tokens") if isinstance(data.get("tokens"), dict) else {}
    provider = data.get("provider") or "—"
    segments = [("🧠 ", "brain"), (provider, "prov")]
    if data.get("auth_ok"):
        segments.append((" 🔒", "lock"))
    segments.extend((
        ("  ·  ", "sep"), (data.get("model") or "—", "model"),
        ("  ·  ", "sep"), (data.get("thinking") or "—", "think"),
        ("  │  ", "sep"), (f"{translate(language, 'input')} {_compact(tokens.get('in'))}  {translate(language, 'output')} {_compact(tokens.get('out'))}", "tokens"),
        ("  │  ", "sep"), (f"{translate(language, 'cache')} {_percent(tokens.get('hit_rate'))}", "cache"),
        ("  │  ", "sep"), (f"{translate(language, 'context')} {_percent(tokens.get('ctx_pct'))}", "ctx"),
        ("  │  ", "sep"),
        (f"{_money(tokens.get('cost'))} {translate(language, 'pi')}  ·  {_money(tokens.get('subagents_cost'))} {translate(language, 'subagents')}", "cost"),
    ))
    return tuple(segments)


@dataclass(frozen=True)
class MotionFrame:
    pulse: float
    hover: float
    press: float
    color: str
    animate: bool


class OrbMotion:
    """Time-based motion, independent of Tk callbacks and collection frequency."""

    def __init__(self):
        self.last = None
        self.hover = self.press = 0.0
        self.color = None
        self.targets = (False, False, None)

    def sample(self, now, state, color, hovered=False, pressed=False, reduced=False):
        dt = max(0.0, now - self.last) if self.last is not None else 0.0
        targets = (hovered, pressed, color)
        if targets != self.targets:
            # Idle has no frame loop; its elapsed time is not interaction time.
            dt = min(dt, 1 / 30)
        self.targets = targets
        self.last = now
        amount = 1.0 if reduced else 1 - math.exp(-dt / 0.09)

        def approach(value, target):
            value += (target - value) * amount
            return float(target) if abs(target - value) < .005 else value

        self.hover = approach(self.hover, int(hovered))
        self.press = approach(self.press, int(pressed))
        self.color = color if reduced or self.color is None else mix_color(self.color, color, amount)
        # Integer colors need a final snap to avoid an endless one-channel timer.
        if max(abs(a - b) for a, b in zip(_rgba(self.color), _rgba(color))) <= 2:
            self.color = color
        active = state != "idle"
        period = 2.8 if state == "running" else 3.6
        pulse = .5 if reduced or not active else .5 - .5 * math.cos(now * math.tau / period)
        settling = self.hover != int(hovered) or self.press != int(pressed) or self.color != color
        return MotionFrame(pulse, self.hover, self.press, self.color, not reduced and (active or settling))


def render_orb(face, status, ctx_pct, hit_pct, palette, output=None, tint=0.0,
               hover=0.0, pressed=0.0, state="idle"):
    """Straight-alpha artwork: context outside, cache inside, quiet idle center."""
    output = output or physical_size()
    bg = palette.get("bg", face)
    image = _material(output, bg).copy()
    glow, sheen, core, silhouette = _masks(output)
    active = state != "idle"
    strength = max(0, min(1, .30 + .62 * tint + .12 * hover - .14 * pressed)) if active else 0
    image.paste(status, mask=glow.point(lambda value: round(value * strength)))
    image.paste("#ffffff", mask=sheen.point(lambda value: round(value * (.08 + .16 * hover))))
    image.paste("#172234", mask=core.point(lambda value: round(value * .12 * pressed)))
    rings = _ring_layer(output, bg, clamp_percent(ctx_pct), clamp_percent(hit_pct))
    image.paste(rings, mask=rings.getchannel("A"))
    mark = _mark_layer(output)
    image.paste(mark, mask=mark.getchannel("A"))
    image = image.convert("RGBA")
    image.putalpha(silhouette)
    return image


@lru_cache(maxsize=8)
def _material(output, bg):
    size = output * RENDER_SCALE
    light = sum(_rgba(bg)) > 500
    top = mix_color(bg, "#ffffff", .64 if light else .20)
    bottom = mix_color(bg, "#6b7c98", .15 if light else .12)
    image = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(image)
    for y in range(size):
        draw.line((0, y, size, y), fill=mix_color(top, bottom, y / (size - 1)))
    return image.resize((output, output), Image.Resampling.LANCZOS)


@lru_cache(maxsize=8)
def _masks(output):
    size = output * RENDER_SCALE
    core = Image.new("L", (size, size))
    draw = ImageDraw.Draw(core)
    inset = size * .235
    draw.ellipse((inset, inset, size - 1 - inset, size - 1 - inset), fill=255)
    core = core.resize((output, output), Image.Resampling.LANCZOS)
    glow = Image.new("L", (output, output))
    draw = ImageDraw.Draw(glow)
    draw.ellipse((output * .23, output * .23, output * .77, output * .77), fill=255)
    glow = ImageChops.multiply(glow.filter(ImageFilter.GaussianBlur(output * .075)), core)
    sheen = Image.new("L", (output, output))
    ImageDraw.Draw(sheen).ellipse((output * .19, output * .16, output * .61, output * .47), fill=255)
    sheen = ImageChops.multiply(sheen.filter(ImageFilter.GaussianBlur(output * .10)), core)
    silhouette = Image.new("L", (size, size))
    margin = size * .020
    ImageDraw.Draw(silhouette).ellipse((margin, margin, size - 1 - margin, size - 1 - margin), fill=255)
    silhouette = silhouette.resize((output, output), Image.Resampling.LANCZOS)
    return glow, sheen, core, silhouette


@lru_cache(maxsize=16)
def _ring_layer(output, bg, ctx_pct, hit_pct):
    size = output * RENDER_SCALE
    image = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(image)
    light = sum(_rgba(bg)) > 500
    values = {"ctx": ctx_pct, "cache": hit_pct}
    for inset_ratio, width_ratio, key, stages in RING_LAYOUT:
        inset, width = round(size * inset_ratio), round(size * width_ratio)
        track = mix_color(bg, "#66758e" if light else "#b4c2dc", .18)
        _ring(draw, size, inset, width, 100, (track,) * 3, False)
        _ring(draw, size, inset, width, values[key], stages, True)
    return image.resize((output, output), Image.Resampling.LANCZOS)


@lru_cache(maxsize=8)
def _mark_layer(output):
    size = output * RENDER_SCALE
    image = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(image)
    for color, points in logo_polygons((size * .335, size * .335, size * .665, size * .665)):
        draw.polygon(points, fill=color)
    return image.resize((output, output), Image.Resampling.LANCZOS)


def physical_size(window=None):
    """50 design points -> Tk pixels; use this same size for window AND image."""
    import tkinter as tk
    try:
        root = window if window is not None else tk._default_root
        scaling = root.tk.call("tk", "scaling") if root is not None else 1.0
        return max(ORB_SIZE, int(round(ORB_SIZE * float(scaling))))
    except (AttributeError, tk.TclError, TypeError, ValueError):
        return ORB_SIZE


def _ring(draw, size, inset, width, percent, colors, caps):
    percent = clamp_percent(percent)
    if not percent:
        return
    box = (inset, inset, size - 1 - inset, size - 1 - inset)
    total = 360 * percent / 100
    for step in range(max(1, math.ceil(total))):
        low, high = step, min(step + 1.15, total)
        draw.arc(box, -90 + low, -90 + high, fill=_stage_color(colors, low), width=width)
    if not caps or percent == 100:
        return
    radius = (size - 1 - 2 * inset - (width - 1)) / 2
    center = (size - 1) / 2
    cap = (width - 1) / 2
    for angle in (0.0, total):
        x = center + radius * math.cos(math.radians(-90 + angle))
        y = center + radius * math.sin(math.radians(-90 + angle))
        draw.ellipse((x - cap, y - cap, x + cap, y + cap), fill=_stage_color(colors, angle))


def _stage_color(colors, angle, blend=28):
    """Fixed thirds with a longer cosine-eased hand-off at each boundary."""
    span = 360 / len(colors)
    for index in range(1, len(colors)):
        boundary = span * index
        distance = angle - boundary
        if distance < -blend / 2:
            return colors[index - 1]
        if distance <= blend / 2:
            progress = (distance + blend / 2) / blend
            eased = (1 - math.cos(progress * math.pi)) / 2
            return mix_color(colors[index - 1], colors[index], eased)
    return colors[-1]


SUMMARY_COLORS = {
    "brain": "#111827", "prov": "#173782", "lock": "#173782", "model": "#164654",
    "think": "#522481", "tokens": "#174626", "cache": "#783514", "ctx": "#173782",
    "cost": "#733c13", "sep": "#374151",
}


@lru_cache(maxsize=12)
def _summary_fonts(pixels):
    fonts_dir = os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts")

    def load(names):
        for name in names:
            try:
                return ImageFont.truetype(os.path.join(fonts_dir, name), pixels * RENDER_SCALE)
            except OSError:
                pass
        try:
            return ImageFont.truetype("DejaVuSans-Bold.ttf", pixels * RENDER_SCALE)
        except OSError:
            return ImageFont.load_default(size=pixels * RENDER_SCALE)

    return load(("msyhbd.ttc", "seguisb.ttf")), load(("seguiemj.ttf", "seguisb.ttf"))


def render_summary(data, font_pixels):
    """Supersample material AND glyphs, keeping text opaque over translucent frost."""
    font, symbols = _summary_fonts(font_pixels)
    pieces = [(text, SUMMARY_COLORS[tag], symbols if tag in ("brain", "lock") else font)
              for text, tag in summary_segments(data, data.get("language", "en") if isinstance(data, dict) else "en")]
    scale = RENDER_SCALE
    pad = math.ceil(symbols.getlength("🧠"))
    ascent, descent = font.getmetrics()
    height = ascent + descent + 12 * scale
    width = math.ceil(sum(f.getlength(text) for text, _color, f in pieces)) + pad * 2
    image = _summary_surface(width, height)
    text_layer = Image.new("RGBA", (width, height))
    draw = ImageDraw.Draw(text_layer)
    x = pad
    baseline = 6 * scale + ascent
    for text, color, piece_font in pieces:
        draw.text((x, baseline), text, font=piece_font, fill=color, anchor="ls", embedded_color=True)
        x += piece_font.getlength(text)
    image.alpha_composite(text_layer)
    return image.resize((math.ceil(width / scale), math.ceil(height / scale)), Image.Resampling.LANCZOS)


def _summary_surface(width, height):
    image = Image.new("RGBA", (width, height))
    draw = ImageDraw.Draw(image)
    for y in range(height):
        draw.line((0, y, width, y), fill=_rgba(mix_color("#ffffff", "#e1e8f2", y / max(1, height - 1))) + (180,))
    mask = Image.new("L", (width, height))
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, width - 1, height - 1), radius=height / 2, fill=180)
    image.putalpha(mask)
    return image


def _rgba(color):
    return tuple(int(color[index:index + 2], 16) for index in (1, 3, 5))


def _compact(value):
    try:
        value = int(value or 0)
    except (TypeError, ValueError):
        return "0"
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f}M"
    if value >= 1_000:
        return f"{value / 1_000:.1f}k"
    return str(value)


def _percent(value):
    value = clamp_percent(value)
    return "—" if value is None else f"{value:.1f}%"


def _money(value):
    try:
        return f"${float(value or 0):.4f}"
    except (TypeError, ValueError):
        return "$0.0000"
