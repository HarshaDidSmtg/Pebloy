# Build Assets

This directory contains assets used by `electron-builder` when creating the Windows installer.

## App Icon Assets

`public/logo.svg` is the approved Forward P vector master. `npm run build`
and `npm run build:dir` regenerate these assets from it before packaging:

```text
build/icon.ico
public/logo.png
```

`build/icon.ico` is used by the desktop shortcut, executable, and Windows installer.
It contains 16, 24, 32, 48, 64, 128, and 256 pixel images with 32-bit alpha.
`public/logo.png` is a 512 x 512 image used by Electron for the window icon.
The sidebar and browser favicon use the SVG directly.

The PNG is tracked in the repository. Both generated assets are refreshed on
every resource-preparation run, including when an older ICO already exists.
Do not customize the generated PNG or ICO independently; update the SVG master.
Generation uses electron-builder's existing icon tool, stages both outputs in a
temporary directory, and fails the build on conversion errors. The previous
assets are not replaced unless both outputs are generated successfully.
The build also prepares pinned SMO and self-contained DacFx resources;
see [the installation guide](../INSTALLATION.md).

### Updating the Artwork

1. Update `public/logo.svg`, preserving its square viewBox and transparency.
2. Run `npm run prepare:resources` to regenerate the PNG and ICO, or run a build.
3. Check the sidebar at 30 pixels and the Windows icon at small sizes before packaging.

Resource-generation tests cover stale assets and conversion failures. The packaged
desktop smoke test checks that the shipped SVG and PNG match the source assets and
captures the icon returned by the Windows shell. Already installed copies need a
new package installation to receive the artwork; a running window needs reopening
to reload its native icon.

Both local and packaged windows explicitly use the Windows application ID
`com.pebloy.app`. Local taskbar entries use `build/icon.ico` and relaunch Electron
with the workspace path; packaged entries use the executable's embedded icon.
The native desktop tests read these properties from the running Windows window,
so a valid PNG alone does not count as a passing taskbar check.

## Session Note — 2026-05-28

The runtime and documentation changes from the current session did not require any new build-asset generation. Packaging still depends on the same `build/icon.ico` and `public/logo.png` files described above.
