"""从 DSH 的官方 icon.png 提取鲸鱼剪影，生成品牌蓝版与纯白版（透明背景）"""
from PIL import Image
import os

SRC = r"D:\ai\deepseek-mobile\public\icons\deepseek-official.png"
OUT = r"D:\ai\deepseek-mobile\public\icons"

img = Image.open(SRC).convert("RGBA")
w, h = img.size
px = img.load()

blue = Image.new("RGBA", (w, h), (0, 0, 0, 0))
white = Image.new("RGBA", (w, h), (0, 0, 0, 0))
bp = blue.load()
wp = white.load()

# 背景约 246 亮度，鲸鱼约 45；以 215 为阈值向上平滑
for y in range(h):
    for x in range(w):
        r, g, b, sa = px[x, y]
        if sa < 128:
            continue
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        a = (215.0 - lum) / 155.0
        a = 0.0 if a < 0 else (1.0 if a > 1 else a)
        alpha = int(round(a * 255))
        if alpha == 0:
            continue
        # 渐变 #6E8CFF -> #3D5AFE
        br = int(0x6E + (0x3D - 0x6E) * a)
        bg = int(0x8C + (0x5A - 0x8C) * a)
        bb = int(0xFF + (0xFE - 0xFF) * a)
        bp[x, y] = (br, bg, bb, alpha)
        wp[x, y] = (255, 255, 255, alpha)

# 裁掉四周空白，保留少量边距，让 mark 在大小时视觉更饱满
bbox = blue.getbbox()
if bbox:
    pad = 12
    box = (max(0, bbox[0] - pad), max(0, bbox[1] - pad),
           min(w, bbox[2] + pad), min(h, bbox[3] + pad))
    blue = blue.crop(box)
    white = white.crop(box)

for name, im in (("deepseek-mark.png", blue), ("deepseek-whale-white.png", white)):
    im = im.resize((512, 512), Image.LANCZOS)
    im.save(os.path.join(OUT, name))
    print(name, im.size, im.mode)
