# BDeploy — Themes

## Available Themes

| Theme | Description |
| ----- | ----------- |
| **Light** | Clean white/grey palette for bright environments |
| **Dark** | Pure black Nothing OS palette — `#ff2340` red accent, Space Grotesk font, dot-grid background texture |
| **Cyberpunk** | Neon mint-on-violet operator theme with luminous chrome |
| **Dracula** | Violet/graphite palette inspired by popular editor themes |
| **Monokai** | Warm amber and mint palette for long coding sessions |
| **Nord** | Calm glacial blue palette with restrained contrast |
| **Spider-Man** | Red and blue accent palette |
| **Batman** | Dark with gold accents |

Theme selection is saved in file-backed app state and persists across sessions on the same machine.
Theme preference is also included in app-state export/import flows, so it can be carried between machines manually.

## Switching Themes

- Click the theme swatches in the top-right header of the app, or
- Use the inline swatches in the **Customize** tab — both apply the theme instantly.

## Nothing OS Design System (Dark Theme)

The Dark theme is styled after the Nothing OS aesthetic:

| Property | Value |
| -------- | ----- |
| Background | Pure black `#000000` |
| Surface | `#0d0d0d` / `#141414` |
| Text | Off-white `#f0f0f0` |
| Muted text | `#b0b0b0` |
| Accent | Nothing Phone red `#ff2340` |
| Buttons | Flat — no gradients, no box-shadow |
| Border radius | 4 px (tight) |
| Background texture | Subtle dot-grid via radial-gradient |
| Font | Space Grotesk (primary) |

This is a design system applied to the Dark theme, not a separate selectable theme name.

## Font Customization

The **Customize** tab includes font controls:

- **Font Family** — Space Grotesk, Inter, JetBrains Mono, Fira Code, Segoe UI, Roboto, Poppins, Arial, Times New Roman.
- **Font Size** — slider from 11 px to 20 px.

Both preferences are persisted in file-backed app state (`data/app-state.json`) and applied on app load.

## Theme Engine

- Theme tokens now drive borders, hover states, icon framing, progress chrome, and panel surfaces in addition to background/text color.
- The header picker and Settings theme gallery are generated from one centralized theme registry (`public/themeRegistry.js`).
- The Settings screen now includes a live theme detail panel showing the active theme, contrast target, and sync behavior.

## Accessibility

- Theme palettes are tuned for WCAG AA contrast targets for text/UI chrome.
- The Settings theme gallery surfaces the contrast target directly so operators can pick a compliant palette quickly.

## Sync Notes

- Local usage: theme preference is still stored in file-backed app state on the current machine.
- Manual cross-device carry-over: theme preference moves with app-state export/import.
- Automatic live sync across multiple devices would still require shared backend profile/settings storage, which this local desktop/web app does not currently provide.
