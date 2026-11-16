#!/usr/bin/env python3
"""
make-icon.py: draw the plugin's icon (the lock with VC) as a PNG for Unraid's
Plugins list, which accepts only PNG files or font icons. The same drawing as
the SVG in VeraCryptMount.page and the Dashboard tile, in dark grey.

Uses only Python's own modules (no image library): each pixel is sampled
4 x 4 times against the lines of the drawing, which gives smooth edges.

Usage:  python scripts/make-icon.py
Writes: src/usr/local/emhttp/plugins/veracrypt.mount/images/veracrypt.mount.png
"""

import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'src/usr/local/emhttp/plugins/veracrypt.mount/images/veracrypt.mount.png'

SIZE = 96                      # pixels; Unraid shows it smaller, so it stays sharp
COLOUR = (0x40, 0x40, 0x40)    # dark grey
HALF_WIDTH = 0.95              # half the line width, in drawing units (the SVG uses 1.9)
VIEW = (3.5, 3.0, 25.0, 26.0)  # the cropped view box of the SVG: x, y, width, height
SAMPLES = 4


def seg(p, a, b):
    """Distance from p to the line from a to b, with round ends."""
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def arc(p, c, r, start, end):
    """Distance from p to the arc of radius r around c, from angle start to end
    (radians, y pointing down, counter-clockwise on screen = decreasing angle)."""
    ang = math.atan2(p[1] - c[1], p[0] - c[0])
    lo, hi = min(start, end), max(start, end)
    a = ang
    while a < lo:
        a += 2 * math.pi
    if a <= hi:
        return abs(math.hypot(p[0] - c[0], p[1] - c[1]) - r)
    ends = [(c[0] + r * math.cos(x), c[1] + r * math.sin(x)) for x in (start, end)]
    return min(math.hypot(p[0] - e[0], p[1] - e[1]) for e in ends)


def round_rect(p, x, y, w, h, r):
    """Distance from p to the outline of a rectangle with rounded corners."""
    cx, cy = x + w / 2, y + h / 2
    qx, qy = abs(p[0] - cx) - (w / 2 - r), abs(p[1] - cy) - (h / 2 - r)
    outside = math.hypot(max(qx, 0), max(qy, 0))
    inside = min(max(qx, qy), 0)
    return abs(outside + inside - r)


# The C: the SVG arc from (23, 18.6) to (23, 22.9), radius 3.6, round the left.
C_R = 3.6
C_HALF = (22.9 - 18.6) / 2
C_CENTRE = (23 - math.sqrt(C_R ** 2 - C_HALF ** 2), 18.6 + C_HALF)
C_GAP = math.atan2(C_HALF, 23 - C_CENTRE[0])     # half the opening on the right


def distance(p):
    return min(
        seg(p, (10, 13), (10, 10)),                      # shackle, left leg
        seg(p, (22, 13), (22, 10)),                      # shackle, right leg
        arc(p, (16, 10), 6, math.pi, 2 * math.pi),       # shackle, top
        round_rect(p, 5, 13, 22, 15, 2),                 # body
        seg(p, (9, 17.5), (12, 24)),                     # V
        seg(p, (12, 24), (15, 17.5)),
        arc(p, C_CENTRE, C_R, C_GAP, 2 * math.pi - C_GAP),  # C
    )


def main():
    vx, vy, vw, vh = VIEW
    scale = SIZE / max(vw, vh)
    off_x = (SIZE - vw * scale) / 2
    off_y = (SIZE - vh * scale) / 2
    rows = []
    for py in range(SIZE):
        row = bytearray([0])                             # PNG filter: none
        for px in range(SIZE):
            hits = 0
            for sy in range(SAMPLES):
                for sx in range(SAMPLES):
                    x = vx + (px + (sx + 0.5) / SAMPLES - off_x) / scale
                    y = vy + (py + (sy + 0.5) / SAMPLES - off_y) / scale
                    if distance((x, y)) <= HALF_WIDTH:
                        hits += 1
            alpha = round(255 * hits / SAMPLES ** 2)
            row += bytes(COLOUR) + bytes([alpha])
        rows.append(bytes(row))

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(b''.join(rows), 9))
           + chunk(b'IEND', b''))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(png)
    print(f'Wrote {OUT.relative_to(ROOT).as_posix()} ({len(png)} bytes, {SIZE} x {SIZE})')


if __name__ == '__main__':
    main()
