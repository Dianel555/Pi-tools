"""Regenerate the README's previews using the shipped renderer (no desktop capture)."""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages" / "pi-hud"))
from orb import OrbMotion, render_orb
from theme import THEMES

ASSETS = ROOT / "packages" / "pi-hud" / "assets"
STATES = ("idle", "thinking", "running")


def font(size):
    try:
        return ImageFont.truetype("segoeui.ttf", size)
    except OSError:
        return ImageFont.load_default()


def paste_orb(canvas, theme, state, x, y, frame):
    palette = THEMES[theme]
    image = render_orb(palette["bg"], frame.color, 48, 76, palette, 67,
                       frame.pulse, frame.hover, frame.press, state)
    canvas.paste(image, (x + 33, y + 33), image)


def board(themes):
    image = Image.new("RGB", (760, 122 + 190 * len(themes)), "#eef1f6")
    draw = ImageDraw.Draw(image)
    draw.text((32, 21), "Pi, quietly present.", font=font(28), fill="#1e293b")
    draw.text((32, 63), "50pt dial. Bolder rings. Smooth alpha edges.", font=font(15), fill="#596579")
    for row, theme in enumerate(themes):
        y = 104 + row * 190
        dark = theme == "dark"
        draw.rounded_rectangle((24, y, 736, y + 178), radius=22,
                               fill="#19212e" if dark else "#f8f5ef" if theme == "paper" else "#ffffff")
        draw.text((46, y + 16), theme.upper(), font=font(10), fill="#96a7c0" if dark else "#6b7280")
        for col, state in enumerate(STATES):
            palette = THEMES[theme]
            color = {"idle": palette["dim"], "thinking": "#ad6bff", "running": "#22d6ff"}[state]
            frame = OrbMotion().sample(.9, state, color)
            paste_orb(image, theme, state, 114 + col * 205, y + 23, frame)
    return image


def main():
    ASSETS.mkdir(exist_ok=True)
    board(("dark", "white", "paper")).save(ASSETS / "orb-preview.png")
    motions = [OrbMotion() for _ in STATES]
    frames = []
    base = board(("dark",))
    for index in range(72):
        image = base.copy()
        for col, state in enumerate(STATES):
            color = {"idle": THEMES["dark"]["dim"], "thinking": "#ad6bff", "running": "#22d6ff"}[state]
            frame = motions[col].sample(index * .05, state, color,
                                         hovered=20 <= index < 48, pressed=34 <= index < 39)
            paste_orb(image, "dark", state, 114 + col * 205, 127, frame)
        frames.append(image)
    # A shared palette avoids animated quantization noise in the static rings.
    palette = frames[36].quantize(colors=256)
    frames = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
    frames[0].save(ASSETS / "orb-motion.gif", save_all=True, append_images=frames[1:],
                   duration=50, loop=0, disposal=2, optimize=False)
    print("Saved orb-preview.png and orb-motion.gif")


if __name__ == "__main__":
    main()
