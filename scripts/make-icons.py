#!/usr/bin/env python3
"""
Ritar Fondinsyns ikoner (fliken, hemskärmen, appen) från samma mått, så att de är skarpa i alla storlekar.

Symbolen är en cirkel delad i fyra av ett kors, på en skogsgrön ruta. I små storlekar blir den suddig om korsets
kanter hamnar mitt emellan två pixlar, så korsets bredd väljs per storlek så att kanterna ligger på hela pixlar
(16 px: 2 px brett, kanterna på pixel 7 och 9). Cirkeln ritas åtta gånger större och skalas ned, så att kanten blir
mjuk men korset förblir skarpt.

  py scripts/make-icons.py
"""
import io
import math
import os
import struct

from PIL import Image, ImageChops, ImageDraw

GREEN = (12, 46, 35)      # --navy #0c2e23
MINT = (95, 211, 162)     # #5fd3a2
WHITE = (255, 255, 255)
SS = 8                    # översampling för cirkelns kant


def geometry(n, safe=1.0):
    """Mått i pixlar för storleken n: hörnradie, cirkelns radie och korsets bredd (samma paritet som n)."""
    r_box = round(n * 0.19)
    radius = n * 0.42 * safe
    gap = max(2, round(n * 0.125 * safe))
    if (n - gap) % 2:
        gap += 1
    return r_box, radius, gap


def draw(n, rounded=True, safe=1.0):
    r_box, radius, gap = geometry(n, safe)
    big = n * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle((0, 0, big - 1, big - 1), radius=r_box * SS, fill=GREEN)
    else:
        d.rectangle((0, 0, big - 1, big - 1), fill=GREEN)
    c, rr = big / 2, radius * SS
    # fyra kvartscirklar: övre högra i mint, resten vita
    circle = Image.new("L", (big, big), 0)
    ImageDraw.Draw(circle).ellipse((c - rr, c - rr, c + rr, c + rr), fill=255)
    lo, hi = (n - gap) // 2 * SS, (n + gap) // 2 * SS
    cut = ImageDraw.Draw(circle)
    cut.rectangle((lo, 0, hi - 1, big), fill=0)
    cut.rectangle((0, lo, big, hi - 1), fill=0)
    white = Image.new("RGBA", (big, big), WHITE + (255,))
    mint = Image.new("RGBA", (big, big), MINT + (255,))
    quarter = Image.new("L", (big, big), 0)
    ImageDraw.Draw(quarter).rectangle((hi, 0, big, lo - 1), fill=255)
    img.paste(white, (0, 0), circle)
    img.paste(mint, (0, 0), ImageChops.multiply(circle, quarter))
    # BOX-filtret behåller korsets raka kanter skarpa eftersom de ligger på hela pixlar
    return img.resize((n, n), Image.BOX)


def svg():
    """Vektorversionen på ett rutnät om 32: korset 4 enheter brett (kanterna på 14 och 18), cirkelns radie 13,44."""
    n = 32
    r_box, radius, gap = geometry(n)
    lo, hi, c, r = (n - gap) // 2, (n + gap) // 2, n / 2, round(radius, 2)

    dy = round(math.sqrt(r * r - (c - hi) ** 2), 3)   # där korsets kant möter cirkeln
    e1, e2 = round(c - dy, 3), round(c + dy, 3)

    def q(x0, y0, x1, y1, xs, ys):
        return "M%s %sA%s %s 0 0 1 %s %sL%s %sZ" % (x0, y0, r, r, x1, y1, xs, ys)
    tr = q(hi, e1, e2, lo, hi, lo)
    br = q(e2, hi, hi, e2, hi, hi)
    bl = q(lo, e2, e1, hi, lo, hi)
    tl = q(e1, lo, lo, e1, lo, lo)
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="%d" fill="#0C2E23"/>'
            '<path d="%s" fill="#5FD3A2"/><path d="%s%s%s" fill="#fff"/></svg>\n' % (r_box, tr, br, bl, tl))


def ico(images):
    """En .ico med PNG-bilder i (alla moderna webbläsare läser det)."""
    data = []
    for im in images:
        b = io.BytesIO()
        im.save(b, "PNG", optimize=True)
        data.append(b.getvalue())
    head = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b""
    for im, d in zip(images, data):
        w = im.size[0]
        entries += struct.pack("<BBBBHHII", w % 256, w % 256, 0, 0, 1, 32, len(d), offset)
        offset += len(d)
    return head + entries + b"".join(data)


def main():
    site = "site"
    open(os.path.join(site, "favicon.svg"), "w", encoding="utf-8", newline="\n").write(svg())
    open(os.path.join(site, "favicon.ico"), "wb").write(ico([draw(n) for n in (16, 32, 48, 64)]))
    draw(48).save(os.path.join(site, "favicon-48x48.png"), optimize=True)
    draw(96).save(os.path.join(site, "favicon-96x96.png"), optimize=True)
    # Hemskärmen: iOS rundar själv hörnen, så rutan fyller hela bilden
    draw(180, rounded=False).convert("RGB").save(os.path.join(site, "assets", "apple-touch-icon.png"), optimize=True)
    draw(192).save(os.path.join(site, "assets", "icon-192.png"), optimize=True)
    draw(512).save(os.path.join(site, "assets", "icon-512.png"), optimize=True)
    # Android beskär "maskable" ikoner till en cirkel: symbolen inom den säkra zonen (80 % av bredden)
    draw(512, rounded=False, safe=0.78).save(os.path.join(site, "assets", "icon-maskable-512.png"), optimize=True)
    print("klart")


if __name__ == "__main__":
    main()
