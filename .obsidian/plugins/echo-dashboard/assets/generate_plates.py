# -*- coding: utf-8 -*-
"""墨痕观测 · The Marginalia Observatory — 六张维度图版生成器（精修轮）
渲染 3x 超采样后 LANCZOS 缩至 1040×336。
"""
import math, random
from PIL import Image, ImageDraw, ImageFont, ImageChops

S = 3
FW, FH = 1040, 336
W, H = FW * S, FH * S
M = 28 * S
PAPER = (245, 240, 230)
INK = (44, 40, 35)

FONT_DIR = "/Users/caijiaxin/.claude/skills/canvas-design/canvas-fonts"
OUT_DIR = "/Users/caijiaxin/my_project/thesis/.obsidian/plugins/echo-dashboard/assets"
mono = ImageFont.truetype(f"{FONT_DIR}/DMMono-Regular.ttf", 30)
song = ImageFont.truetype("/System/Library/Fonts/Supplemental/Songti.ttc", 44, index=0)

PLATES = [
    ("概念",   "I",   "CRYSTALLISATION", "凝晶", (61, 94, 128)),
    ("延伸",   "II",  "DEPARTURE",       "出岔", (63, 125, 108)),
    ("你的故事", "III", "STRATA",          "地层", (176, 122, 62)),
    ("闪回",   "IV",  "RUPTURE",         "裂隙", (108, 79, 148)),
    ("共振",   "V",   "INTERFERENCE",    "干涉", (168, 69, 92)),
    ("悬题",   "VI",  "OPEN ORBIT",      "悬轨", (179, 136, 46)),
]

def ink(a): return (*INK, a)

def base_canvas():
    img = Image.new("RGB", (W, H), PAPER)
    noise = Image.effect_noise((W, H), 20).point(lambda v: 255 - int(abs(v - 128) * 0.10))
    img = ImageChops.multiply(img, Image.merge("RGB", (noise, noise, noise)))
    d = ImageDraw.Draw(img, "RGBA")
    rng = random.Random(7)
    for _ in range(160):
        x, y = rng.uniform(0, W), rng.uniform(0, H)
        ang = rng.uniform(0, math.pi)
        l = rng.uniform(4, 14)
        d.line([x, y, x + math.cos(ang) * l, y + math.sin(ang) * l], fill=ink(10), width=1)
    return img.convert("RGBA")

def frame_and_caption(img, roman, en, zh, accent):
    d = ImageDraw.Draw(img, "RGBA")
    d.rectangle([M - 24, M - 24, W - M + 24, H - M + 24], outline=ink(80), width=2)
    d.rectangle([M, M, W - M, H - M], outline=ink(170), width=2)
    for cx, cy, dx, dy in [(36, 36, 1, 1), (W - 36, 36, -1, 1), (36, H - 36, 1, -1), (W - 36, H - 36, -1, -1)]:
        d.line([cx, cy, cx + dx * 26, cy], fill=ink(90), width=2)
        d.line([cx, cy, cx, cy + dy * 26], fill=ink(90), width=2)
    text = f"MARGINALIA OBS. · PLATE {roman} — {en}"
    x = M
    y = H - M + (M - 30) // 2 + 16
    for ch in text:
        d.text((x, y), ch, font=mono, fill=ink(140), anchor="lm")
        x += mono.getlength(ch) + 4
    lw = d.textlength(zh, font=song)
    d.ellipse([W - M - lw - 60, y - 8, W - M - lw - 44, y + 8], fill=(*accent, 230))
    d.text((W - M, y), zh, font=song, fill=ink(200), anchor="rm")

def art_layer():
    layer = Image.new("RGBA", (W - 2 * M, H - 2 * M), (0, 0, 0, 0))
    return layer, ImageDraw.Draw(layer, "RGBA")

def dotted_arc(d, cx, cy, r, a0, a1, step_px, dot_r, fill):
    if r <= 0: return
    da = step_px / r
    a = a0
    while a <= a1:
        x, y = cx + r * math.cos(a), cy + r * math.sin(a)
        d.ellipse([x - dot_r, y - dot_r, x + dot_r, y + dot_r], fill=fill)
        a += da

def dashed_path(d, pts, dash, gap, width, fill):
    acc, on = 0.0, True
    px, py = pts[0]
    for x, y in pts[1:]:
        dx, dy = x - px, y - py
        seg = math.hypot(dx, dy)
        if seg == 0: continue
        t = 0.0
        while t < seg:
            need = (dash if on else gap) - acc
            take = min(need, seg - t)
            if on:
                x0, y0 = px + dx * (t / seg), py + dy * (t / seg)
                x1, y1 = px + dx * ((t + take) / seg), py + dy * ((t + take) / seg)
                d.line([x0, y0, x1, y1], fill=fill, width=width)
            acc += take
            t += take
            if acc >= (dash if on else gap) - 1e-6:
                acc, on = 0.0, not on
        px, py = x, y

def bezier(p0, p1, p2, p3, n=160):
    pts = []
    for i in range(n + 1):
        t = i / n
        mt = 1 - t
        x = mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0]
        y = mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1]
        pts.append((x, y))
    return pts

# ---------- PLATE I 概念 · 凝晶 ----------
def plate_concept(accent):
    layer, d = art_layer()
    w, h = layer.size
    cx, cy = w * 0.30, h * 0.54
    rng = random.Random(11)
    radii = [k * 34 * S for k in range(1, 13)]
    for i, r in enumerate(radii):
        a = 150 - i * 9
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=ink(max(42, a)), width=3)
    for k in range(24):
        ang = k * math.pi / 12
        r0 = radii[0]
        r1 = radii[2 + (k * 5) % 8]
        d.line([cx + r0 * math.cos(ang), cy + r0 * math.sin(ang),
                cx + r1 * math.cos(ang), cy + r1 * math.sin(ang)], fill=ink(95), width=2)
    for k in range(24):
        ang = k * math.pi / 12
        for j in [1, 3, 5, 7]:
            if (k + j) % 3 == 0:
                r = radii[j]
                x, y = cx + r * math.cos(ang), cy + r * math.sin(ang)
                rr = 6 if j > 3 else 8
                d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=ink(205))
    d.ellipse([cx - 24, cy - 24, cx + 24, cy + 24], outline=(*accent, 200), width=3)
    d.ellipse([cx - 13, cy - 13, cx + 13, cy + 13], fill=(*accent, 245))
    R = radii[-2]
    for k in range(72):
        ang = k * math.pi / 36
        r_in = R - (20 if k % 6 == 0 else 10)
        d.line([cx + r_in * math.cos(ang), cy + r_in * math.sin(ang),
                cx + R * math.cos(ang), cy + R * math.sin(ang)], fill=ink(85), width=2)
    for i in range(3):
        sy = h * (0.20 + 0.28 * i) + rng.uniform(-20, 20)
        pts = bezier((w * 0.99, sy), (w * 0.78, sy + rng.uniform(-60, 60)),
                     (w * 0.58, cy + rng.uniform(-90, 90)), (cx + radii[5], cy))
        step = max(2, len(pts) // 30)
        for p in pts[::step]:
            d.ellipse([p[0] - 3.5, p[1] - 3.5, p[0] + 3.5, p[1] + 3.5], fill=ink(75))
        px, py = pts[len(pts) // 5]
        d.ellipse([px - 9, py - 9, px + 9, py + 9], fill=(*accent, 225))
    return layer

# ---------- PLATE II 延伸 · 出岔 ----------
def plate_extend(accent):
    layer, d = art_layer()
    w, h = layer.size
    rng = random.Random(23)
    for fy in (0.24, 0.50, 0.76):
        d.line([0, h * fy, w, h * fy], fill=ink(36), width=2)
    ox, oy = w * 0.075, h * 0.58
    targets = [(w * 1.02, h * f) for f in (0.02, 0.20, 0.40, 0.58, 0.78, 0.97)]
    main_idx = 2
    for i, (tx, ty) in enumerate(targets):
        c1 = (ox + w * 0.16, oy + (ty - oy) * 0.50)
        c2 = (ox + w * 0.55, ty + (oy - ty) * 0.18)
        pts = bezier((ox, oy), c1, c2, (tx, ty), 200)
        cut = int(len(pts) * rng.uniform(0.48, 0.62))
        main = i == main_idx
        a = 215 if main else 135
        for j in range(cut):
            d.line([*pts[j], *pts[j + 1]], fill=ink(a), width=4 if main else 3)
        dashed_path(d, pts[cut:], 16, 18, 2, ink(105))
        ex, ey = pts[cut]
        rr = 12 if main else 8
        col = (*accent, 235) if main else ink(170)
        d.ellipse([ex - rr, ey - rr, ex + rr, ey + rr], outline=col, width=4 if main else 3)
        if main:
            d.ellipse([ex - 4, ey - 4, ex + 4, ey + 4], fill=(*accent, 235))
        for j in range(14, cut, 30):
            x0, y0 = pts[j]; x1, y1 = pts[j + 1]
            ang = math.atan2(y1 - y0, x1 - x0) + math.pi / 2
            t = 9
            d.line([x0 - t * math.cos(ang), y0 - t * math.sin(ang),
                    x0 + t * math.cos(ang), y0 + t * math.sin(ang)], fill=ink(110), width=2)
    d.ellipse([ox - 10, oy - 10, ox + 10, oy + 10], fill=ink(220))
    d.ellipse([ox - 19, oy - 19, ox + 19, oy + 19], outline=ink(120), width=3)
    return layer

# ---------- PLATE III 你的故事 · 地层 ----------
def plate_story(accent):
    layer, d = art_layer()
    w, h = layer.size
    rng = random.Random(37)
    waves = [(rng.uniform(4, 11) * S / 3, rng.uniform(0.8, 2.4), rng.uniform(0, 6.28)) for _ in range(3)]
    def yline(y0, x):
        return y0 + sum(a * math.sin(x / (w / (6.28 * f)) + p) for a, f, p in waves)
    ys, y = [], h * 0.06
    gaps = [0.118, 0.105, 0.092, 0.080, 0.070, 0.062, 0.056, 0.052, 0.050, 0.049, 0.049, 0.049]
    for g in gaps:
        ys.append(y); y += h * g
    seam = 7
    for i, y0 in enumerate(ys):
        pts = [(x, yline(y0, x) + i * 3) for x in range(0, w + 1, 12)]
        if i == seam:
            for j in range(len(pts) - 1):
                d.line([*pts[j], *pts[j + 1]], fill=(*accent, 240), width=5)
        else:
            a = 75 + i * 9
            for j in range(len(pts) - 1):
                d.line([*pts[j], *pts[j + 1]], fill=ink(a), width=2)
    for _ in range(480):
        x = rng.uniform(0, w)
        yy = rng.uniform(yline(ys[seam], x) + seam * 3 + 9, yline(ys[seam + 1], x) + (seam + 1) * 3 - 6)
        r = rng.uniform(1.8, 3.4)
        d.ellipse([x - r, yy - r, x + r, yy + r], fill=ink(90))
    bx = w * 0.74
    d.line([bx, h * 0.02, bx, h * 0.98], fill=ink(120), width=2)
    for i, y0 in enumerate(ys):
        yy = yline(y0, bx) + i * 3
        d.line([bx - 11, yy, bx + 11, yy], fill=ink(160), width=3)
    yy = yline(ys[seam], bx) + seam * 3
    d.ellipse([bx - 18, yy - 18, bx + 18, yy + 18], outline=(*accent, 245), width=4)
    for i, y0 in enumerate(ys):                            # 右缘深度刻度
        yy = yline(y0, w - 4) + i * 3
        d.line([w - 16, yy, w, yy], fill=ink(110), width=2)
    return layer

# ---------- PLATE IV 闪回 · 裂隙 ----------
def plate_flash(accent):
    layer, d = art_layer()
    w, h = layer.size
    rng = random.Random(53)
    bolt = [(w * 0.62, -10), (w * 0.545, h * 0.42), (w * 0.585, h * 0.46), (w * 0.50, h * 1.04)]
    def seg_dist(p, a, b):
        ax, ay = a; bx, by = b; px, py = p
        dx, dy = bx - ax, by - ay
        t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
        return math.hypot(px - ax - t * dx, py - ay - t * dy), math.atan2(dy, dx)
    def bolt_field(p):
        best = (1e9, 0)
        for i in range(len(bolt) - 1):
            dist, ang = seg_dist(p, bolt[i], bolt[i + 1])
            if dist < best[0]: best = (dist, ang)
        return best
    gx, gy = 64, 56
    for ix in range(int(w / gx) + 1):
        for iy in range(int(h / gy) + 1):
            x = ix * gx + (iy % 2) * gx / 2 + rng.uniform(-4, 4)
            y = iy * gy + rng.uniform(-4, 4)
            dist, bang = bolt_field((x, y))
            infl = max(0.0, 1 - dist / (w * 0.26))
            ang = infl * bang
            a = int(58 + infl * 110)
            l = 11 + infl * 11
            col = (*accent, 225) if dist < 50 else ink(a)
            d.line([x - l * math.cos(ang), y - l * math.sin(ang),
                    x + l * math.cos(ang), y + l * math.sin(ang)], fill=col, width=2)
    for off, a, wd in [(28, 60, 2), (14, 110, 3), (0, 245, 6)]:
        pts = [(x + off, y) for x, y in bolt]
        col = (*accent, a) if off == 0 else ink(a)
        d.line(pts, fill=col, width=wd, joint="curve")
    for _ in range(7):
        t = rng.uniform(0.1, 0.9)
        i = min(int(t * (len(bolt) - 1)), len(bolt) - 2)
        x0, y0 = bolt[i]; x1, y1 = bolt[i + 1]
        tt = t * (len(bolt) - 1) - i
        x, y = x0 + (x1 - x0) * tt + rng.uniform(-70, 70), y0 + (y1 - y0) * tt + rng.uniform(-40, 40)
        r = rng.uniform(6, 11)
        poly = [(x + r * math.cos(a2), y + r * math.sin(a2))
                for a2 in [rng.uniform(0, 2) + k * 2.1 for k in range(3)]]
        d.polygon(poly, outline=ink(175), width=2)
    return layer

# ---------- PLATE V 共振 · 干涉 ----------
def plate_resonance(accent):
    layer, d = art_layer()
    w, h = layer.size
    s1, s2 = (w * 0.36, h * 0.42), (w * 0.62, h * 0.42)
    step = 66
    nmax = 16
    for sx, sy in (s1, s2):
        for i in range(1, nmax + 1):
            r = i * step
            a = max(32, 98 - i * 4)
            d.ellipse([sx - r, sy - r, sx + r, sy + r], outline=ink(a), width=2)
        d.ellipse([sx - 8, sy - 8, sx + 8, sy + 8], fill=ink(225))
    D = math.hypot(s2[0] - s1[0], s2[1] - s1[1])
    for i in range(1, nmax + 1):
        for j in range(1, nmax + 1):
            r1, r2 = i * step, j * step
            if abs(r1 - r2) >= D or r1 + r2 <= D: continue
            a_ = (r1 * r1 - r2 * r2 + D * D) / (2 * D)
            h2 = r1 * r1 - a_ * a_
            if h2 <= 0: continue
            hh = math.sqrt(h2)
            mx = s1[0] + a_ * (s2[0] - s1[0]) / D
            my = s1[1] + a_ * (s2[1] - s1[1]) / D
            for sgn in (1, -1):
                x = mx + sgn * hh * (s2[1] - s1[1]) / D
                y = my - sgn * hh * (s2[0] - s1[0]) / D
                if not (0 <= x <= w and 0 <= y <= h): continue
                if i == j:
                    d.ellipse([x - 6, y - 6, x + 6, y + 6], fill=(*accent, 235))
                elif abs(i - j) == 2:
                    d.ellipse([x - 3, y - 3, x + 3, y + 3], fill=ink(120))
    y0 = h * 0.86
    d.line([0, y0, w, y0], fill=ink(55), width=2)
    pts = []
    for x in range(0, w + 1, 6):
        d1 = math.hypot(x - s1[0], y0 - s1[1])
        d2 = math.hypot(x - s2[0], y0 - s2[1])
        amp = math.cos(d1 / step * math.pi) + math.cos(d2 / step * math.pi)
        pts.append((x, y0 - amp * h * 0.05))
    for j in range(len(pts) - 1):
        d.line([*pts[j], *pts[j + 1]], fill=(*accent, 210), width=4)
    return layer

# ---------- PLATE VI 悬题 · 悬轨 ----------
def plate_question(accent):
    layer, d = art_layer()
    w, h = layer.size
    cx, cy = w * 0.30, h * 0.52
    R = h * 0.40
    gap0, gap1 = -0.95, -0.18                              # 缺口：右上方
    dotted_arc(d, cx, cy, R, gap1, 2 * math.pi + gap0, 27, 5, ink(195))
    dotted_arc(d, cx, cy, R * 0.62, 0, 2 * math.pi, 24, 3.5, ink(120))
    dotted_arc(d, cx, cy, R * 0.33, 0, 2 * math.pi, 22, 3, ink(95))
    def in_gap(ang):
        a = math.atan2(math.sin(ang), math.cos(ang))
        return gap0 - 0.12 <= a <= gap1 + 0.12
    for k in range(24):                                    # 方位刻度
        ang = k * math.pi / 12
        if in_gap(ang): continue
        r0, r1 = R + 16, R + 30 if k % 2 == 0 else R + 24
        d.line([cx + r0 * math.cos(ang), cy + r0 * math.sin(ang),
                cx + r1 * math.cos(ang), cy + r1 * math.sin(ang)], fill=ink(85), width=2)
    for ga in (gap0, gap1):                                # 缺口端点
        d.line([cx + (R - 18) * math.cos(ga), cy + (R - 18) * math.sin(ga),
                cx + (R + 18) * math.cos(ga), cy + (R + 18) * math.sin(ga)], fill=ink(200), width=4)
    d.line([cx - 15, cy, cx + 15, cy], fill=ink(140), width=2)
    d.line([cx, cy - 15, cx, cy + 15], fill=ink(140), width=2)
    gm = (gap0 + gap1) / 2                                 # 从缺口逃逸的省略号
    ex, ey = cx + R * math.cos(gm), cy + R * math.sin(gm)
    pts = bezier((ex, ey), (ex + w * 0.10, ey - h * 0.10),
                 (ex + w * 0.28, ey - h * 0.04), (w * 0.97, ey + h * 0.10), 100)
    marks = [10, 22, 36, 52, 70, 86, 97]
    for n, idx in enumerate(marks):
        px, py = pts[min(idx, len(pts) - 1)]
        if px > w - 10: break
        if n == 1:
            d.ellipse([px - 10, py - 10, px + 10, py + 10], fill=(*accent, 240))
            d.ellipse([px - 20, py - 20, px + 20, py + 20], outline=(*accent, 140), width=3)
        else:
            r = max(2.5, 7 - n * 0.7)
            d.ellipse([px - r, py - r, px + r, py + r], fill=ink(max(60, 170 - n * 18)))
    return layer

GEN = {"概念": plate_concept, "延伸": plate_extend, "你的故事": plate_story,
       "闪回": plate_flash, "共振": plate_resonance, "悬题": plate_question}

for name, roman, en, zh, accent in PLATES:
    canvas = base_canvas()
    layer = GEN[name](accent)
    canvas.alpha_composite(layer, (M, M))
    frame_and_caption(canvas, roman, en, zh, accent)
    final = canvas.convert("RGB").resize((FW, FH), Image.LANCZOS)
    final.save(f"{OUT_DIR}/{name}.png")
    print(f"PLATE {roman:4s} {name} -> {name}.png")
print("done")
