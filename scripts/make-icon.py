"""Renders images/icon.png (128x128): a green rounded square with a white git-merge glyph.
Pure Python (no Pillow): anti-aliased signed-distance shapes written as an RGBA PNG."""
import math, struct, zlib, pathlib

S = 128

def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)

def bezier(p0, p1, p2, n=32):
    return [((1-t)**2*p0[0] + 2*(1-t)*t*p1[0] + t*t*p2[0], (1-t)**2*p0[1] + 2*(1-t)*t*p1[1] + t*t*p2[1])
            for t in (i / n for i in range(n + 1))]

A, B, C = (42, 36), (42, 92), (88, 70)
curve = bezier(A, (42, 70), C)
STROKE = 4.0  # half width

def rounded_rect(px, py, r=26, m=4):
    qx = abs(px - S / 2) - (S / 2 - m - r)
    qy = abs(py - S / 2) - (S / 2 - m - r)
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r

def cover(d):
    return max(0.0, min(1.0, 0.5 - d))

def over(dst, rgb, a):
    r, g, b, da = dst
    oa = a + da * (1 - a)
    if oa == 0:
        return (0, 0, 0, 0)
    mix = lambda s, d: (s * a + d * da * (1 - a)) / oa
    return (mix(rgb[0], r), mix(rgb[1], g), mix(rgb[2], b), oa)

rows = []
for y in range(S):
    row = bytearray([0])
    for x in range(S):
        px, py = x + 0.5, y + 0.5
        t = py / S
        green = (46 + (26 - 46) * t, 160 + (127 - 160) * t, 67 + (55 - 67) * t)
        c = over((0, 0, 0, 0), green, cover(rounded_rect(px, py)))
        lines = min(seg_dist(px, py, *A, *B),
                    min(seg_dist(px, py, *curve[i], *curve[i + 1]) for i in range(len(curve) - 1))) - STROKE
        dots = min(math.hypot(px - nx, py - ny) for nx, ny in (A, B, C)) - 11
        c = over(c, (255, 255, 255), cover(min(lines, dots)))
        holes = min(math.hypot(px - nx, py - ny) for nx, ny in (A, B, C)) - 4.5
        c = over(c, green, cover(holes) * c[3])
        row += bytes(round(v) for v in c[:3]) + bytes([round(c[3] * 255)])
    rows.append(bytes(row))

def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', S, S, 8, 6, 0, 0, 0)) \
    + chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b'')
out = pathlib.Path(__file__).resolve().parent.parent / 'images' / 'icon.png'
out.write_bytes(png)
print(out, len(png), 'bytes')
