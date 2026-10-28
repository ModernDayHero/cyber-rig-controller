"""Repack an 8-bit indexed BMP as 4-bit (16 colors), keeping pixel indices."""
import struct, sys

def convert(src, dst):
    d = open(src, "rb").read()
    off = struct.unpack("<I", d[10:14])[0]
    w, h = struct.unpack("<ii", d[18:26])
    hdr = struct.unpack("<I", d[14:18])[0]
    assert struct.unpack("<H", d[28:30])[0] == 8
    pal = d[14 + hdr:off]                       # 4 bytes per entry
    rows, stride8 = abs(h), (w + 3) & ~3
    px = [d[off + r * stride8: off + r * stride8 + w] for r in range(rows)]
    top = max(max(row) for row in px)
    assert top < 16, "uses index %d" % top
    stride4 = ((w + 1) // 2 + 3) & ~3
    body = b""
    for row in px:
        packed = bytes((row[i] << 4) | (row[i + 1] if i + 1 < w else 0) for i in range(0, w, 2))
        body += packed + b"\0" * (stride4 - len(packed))
    pal16 = (pal + b"\0" * 64)[:64]
    info = bytearray(d[14:14 + 40])
    struct.pack_into("<H", info, 14, 4)          # bits per pixel
    struct.pack_into("<I", info, 20, len(body))  # image size
    struct.pack_into("<II", info, 32, 16, 16)    # colors used / important
    off4 = 14 + 40 + 64
    fh = b"BM" + struct.pack("<IHHI", off4 + len(body), 0, 0, off4)
    open(dst, "wb").write(fh + bytes(info) + pal16 + body)
    print(src, "->", dst, "max index", top, len(d), "->", off4 + len(body), "bytes")
    # round-trip check
    e = open(dst, "rb").read()
    for r in range(rows):
        row4 = e[off4 + r * stride4: off4 + r * stride4 + (w + 1) // 2]
        un = []
        for b in row4:
            un += [b >> 4, b & 15]
        assert bytes(un[:w]) == px[r], "row %d mismatch" % r

for a, b in zip(sys.argv[1::2], sys.argv[2::2]):
    convert(a, b)
