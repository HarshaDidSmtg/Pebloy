# Build Assets

This directory contains assets used by `electron-builder` when creating the Windows installer.

## App Icon Assets

Before running `npm run build`, confirm these generated assets exist:

```
build/icon.ico
public/logo.png
```

`build/icon.ico` is used by the desktop shortcut and Windows installer.
`public/logo.png` is used by Electron for the window icon.

### How to regenerate the icon assets from the SVG

1. Open `public/logo.svg` in a browser or image editor
2. Export as 256×256 PNG
3. Convert PNG → ICO using any of these free tools:
   - https://icoconvert.com  (online, free)
   - ImageMagick: `magick convert logo.png -resize 256x256 build/icon.ico`
   - Inkscape: `inkscape --export-type=png --export-width=256 public/logo.svg -o build/icon.png && magick build/icon.png build/icon.ico`

If either asset is missing, Electron or the Windows shortcut may fall back to a default icon.

## Session Note — 2026-05-28

The runtime and documentation changes from the current session did not require any new build-asset generation. Packaging still depends on the same `build/icon.ico` and `public/logo.png` files described above.
