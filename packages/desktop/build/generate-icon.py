#!/usr/bin/env python3
"""Generate the placeholder app icon for the Clad desktop app.

PLACEHOLDER NOTICE: this is a programmatically-generated monochrome "C"
monogram (same silhouette as `packages/desktop/resources/trayIconTemplate.png`)
on a dark rounded-square backdrop, produced with Pillow — not a designed
asset. It exists so `electron-builder` has a real `.icns` (an unset icon
falls back to Electron's default app icon, which looks unfinished in DMG/
Finder/Dock). Swap this for real brand artwork before a signed 1.0 release
(D4.4); until then this script is the source of truth for `icon.icns` — do
not hand-edit the generated PNG/icns files, regenerate them instead:

    python3 packages/desktop/build/generate-icon.py
    # then rebuild icon.icns, e.g.:
    cd packages/desktop/build
    mkdir icon.iconset
    for spec in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" \
                "64 icon_32x32@2x" "128 icon_128x128" "256 icon_128x128@2x" \
                "256 icon_256x256" "512 icon_256x256@2x" "512 icon_512x512" \
                "1024 icon_512x512@2x"; do
      set -- $spec
      sips -z "$1" "$1" icon-1024.png --out "icon.iconset/$2.png" >/dev/null
    done
    iconutil -c icns icon.iconset -o icon.icns
    rm -rf icon.iconset
"""

from PIL import Image, ImageDraw

SIZE = 1024
BG = (17, 17, 20, 255)  # near-black, matches menu-bar monogram tone
FG = (255, 255, 255, 255)  # white glyph on dark rounded-square backdrop


def main() -> None:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Rounded-square backdrop (macOS "squircle"-ish icon convention, generous
    # margin so the shape doesn't get clipped by the OS's own icon mask).
    margin = 64
    radius = 224
    draw.rounded_rectangle([margin, margin, SIZE - margin, SIZE - margin], radius=radius, fill=BG)

    # "C" glyph: thick ring (same silhouette as the existing tray monogram)
    # with a gap on the right, built via an alpha mask so the stroke is a
    # clean punch-out rather than relying on a system font being installed.
    cx, cy = SIZE // 2, SIZE // 2 - 8
    outer_r = 300
    inner_r = 172

    mask = Image.new("L", (SIZE, SIZE), 0)
    mdraw = ImageDraw.Draw(mask)
    mdraw.ellipse([cx - outer_r, cy - outer_r, cx + outer_r, cy + outer_r], fill=255)
    mdraw.ellipse([cx - inner_r, cy - inner_r, cx + inner_r, cy + inner_r], fill=0)
    pad = 12
    mdraw.pieslice(
        [cx - outer_r - pad, cy - outer_r - pad, cx + outer_r + pad, cy + outer_r + pad],
        start=-38,
        end=38,
        fill=0,
    )

    glyph = Image.new("RGBA", (SIZE, SIZE), FG)
    img.paste(glyph, (0, 0), mask)

    out = __file__.rsplit("/", 1)[0] + "/icon-1024.png"
    img.save(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
