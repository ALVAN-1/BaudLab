# 按 build/welcome.svg 设计重画 welcome.bmp（修复中文乱码 + 版本号）
# 路径相对本脚本定位：输出到 上级/build/welcome.bmp，预览图到 ./output/welcome-preview.png
from PIL import Image, ImageDraw, ImageFont
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "output")
os.makedirs(OUT_DIR, exist_ok=True)

W, H = 164, 314
FONTS = r"C:\Windows\Fonts"

def hx(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))

C1, C2 = hx("#1a1d2e"), hx("#0d0f1a")          # 背景对角渐变
ACC1, ACC2 = hx("#FFB547"), hx("#FF6B00")      # 顶部条渐变（上→下）
CIRCLE_FILL, CIRCLE_STROKE = hx("#1e2236"), hx("#2a3050")
WHITE = (255, 255, 255)
DIVIDER = hx("#2a3050")
TXT_SUB, TXT_VER = hx("#6b7280"), hx("#4b5563")

# ---- 背景：对角渐变（有 numpy 用精确对角，无则退化为垂直渐变，深色下肉眼无差）----
try:
    import numpy as np
    ys, xs = np.mgrid[0:H, 0:W]
    t = (xs + ys) / float(W + H)
    arr = np.zeros((H, W, 3), dtype=np.uint8)
    for i in range(3):
        arr[..., i] = (C1[i] + (C2[i] - C1[i]) * t).astype(np.uint8)
    img = Image.fromarray(arr, "RGB")
except ImportError:
    img = Image.new("RGB", (W, H))
    px = img.load()
    for y in range(H):
        t = y / float(H)
        col = tuple(int(C1[i] + (C2[i] - C1[i]) * t) for i in range(3))
        for x in range(W):
            px[x, y] = col

d = ImageDraw.Draw(img)

# ---- 顶部 4px 橙色渐变条 ----
for y in range(4):
    t = y / 3.0
    d.line([(0, y), (W, y)], fill=tuple(int(ACC1[i] + (ACC2[i] - ACC1[i]) * t) for i in range(3)))

# ---- Logo 圆底 ----
d.ellipse([82 - 42, 110 - 42, 82 + 42, 110 + 42], fill=CIRCLE_FILL, outline=CIRCLE_STROKE, width=2)

# ---- 方波图标：M46 130 H70 V108 H94 V86 H118（stroke 8，圆角，垂直渐变取段中点色）----
pts = [(46, 130), (70, 130), (70, 108), (94, 108), (94, 86), (118, 86)]
def grad(y):
    t = min(max(y / 130.0, 0.0), 1.0)
    return tuple(int(ACC1[i] + (ACC2[i] - ACC1[i]) * t) for i in range(3))
for a, b in zip(pts, pts[1:]):
    d.line([a, b], fill=grad((a[1] + b[1]) / 2.0), width=8)
for x, y in pts:  # 圆角 join/cap
    d.ellipse([x - 4, y - 4, x + 4, y + 4], fill=grad(y))
d.ellipse([118 - 5, 86 - 5, 118 + 5, 86 + 5], fill=WHITE)

# ---- 文字（SVG y 为基线，anchor='mm' 需上移约 0.36*size）----
f_bold = ImageFont.truetype(os.path.join(FONTS, "arialbd.ttf"), 15)
f_sub = ImageFont.truetype(os.path.join(FONTS, "msyh.ttc"), 10)
f_ver = ImageFont.truetype(os.path.join(FONTS, "arial.ttf"), 9)
d.text((82, 180), "Serial", font=f_bold, fill=WHITE, anchor="mm")
d.text((82, 200), "Protocol", font=f_bold, fill=WHITE, anchor="mm")
d.text((82, 220), "Manager", font=f_bold, fill=ACC1, anchor="mm")
d.line([(40, 248), (124, 248)], fill=DIVIDER, width=1)
d.text((82, 272), "\u4e32\u53e3\u534f\u8bae\u7ba1\u7406\u5de5\u5177", font=f_sub, fill=TXT_SUB, anchor="mm")
d.text((82, 292), "v1.0.0", font=f_ver, fill=TXT_VER, anchor="mm")

out = os.path.join(HERE, "..", "build", "welcome.bmp")
img.save(out)
img.convert("RGB").save(os.path.join(OUT_DIR, "welcome-preview.png"))
print("saved:", out, img.size, img.mode)
