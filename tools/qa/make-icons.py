"""生成应用图标：官方彩色鲸鱼 + 浅色圆角底（与 DSH / 官方 App 图标风格一致）"""
from PIL import Image, ImageDraw
import os

OUT = r"D:\ai\deepseek-mobile\public\icons"
MARK = os.path.join(OUT, "deepseek-mark.png")
mark = Image.open(MARK).convert("RGBA")


def gradient(size, c1=(0xF7, 0xF9, 0xFF), c2=(0xE9, 0xEE, 0xFF)):
    img = Image.new("RGBA", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x / size * 0.4 + y / size * 0.6)
            px[x, y] = (
                int(c1[0] + (c2[0] - c1[0]) * t),
                int(c1[1] + (c2[1] - c1[1]) * t),
                int(c1[2] + (c2[2] - c1[2]) * t),
                255,
            )
    return img


def rounded_mask(size, radius_ratio=0.235):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=255)
    return mask


def compose(size, ratio, rounded=True):
    bg = gradient(size)
    if rounded:
        bg.putalpha(rounded_mask(size))
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(bg)
    w = int(size * ratio)
    m = mark.resize((w, w), Image.LANCZOS)
    canvas.alpha_composite(m, ((size - w) // 2, (size - w) // 2))
    return canvas


for name, size, ratio, rounded in [
    ("icon-512.png", 512, 0.68, True),
    ("icon-192.png", 192, 0.68, True),
    ("apple-touch-icon.png", 180, 0.68, True),
    ("favicon-32.png", 32, 0.76, True),
    ("icon-512-maskable.png", 512, 0.54, False),
]:
    compose(size, ratio, rounded).save(os.path.join(OUT, name))
    print("icon", name, size)
