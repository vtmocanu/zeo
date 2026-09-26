# zeo design book

The visual language for zeo (Epic 10): a frameless, tinted window where the page floats in a card and every surface draws from one token set. Every Epic 10 PRD cites a section of this document by number.

`design-book.html` is the interactive version: open it in a browser to switch spaces, appearances and tint intensity, open each surface in a live window mock, and read the token and contrast tables computed by a prototype of the theme function. This file is the text reference; where the two differ, this file wins.

## 1. Principles

- **Content is the hero.** The page sits in a floating card. Everything zeo draws recedes into the tinted window around it.
- **Keyboard first, looks second.** Every shortcut, focus order, ARIA role and `data-testid` keeps working. The redesign changes paint, not behavior.
- **One visual language.** Every color, size, radius, shadow and duration comes from a token. Component CSS contains no hex values.
- **Arc-like, not Arc.** The layout language follows Arc. The work is original: no Arc name, logo, icons or assets.

Styling uses plain CSS with custom-property tokens and one CSS file per component. No Tailwind, no CSS-in-JS, no new dependencies. Target is macOS arm64 only.

## 2. Window geometry

| Element        | Specification                                                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title bar      | None. `titleBarStyle: "hidden"`, `trafficLightPosition: { x: 14, y: 16 }`.                                                                                                                |
| Window row     | 44 px tall at the top of the sidebar: traffic lights, then sidebar toggle, back, forward, reload as 28 px icon buttons. Drag region except for its buttons.                               |
| Sidebar        | 240 px default, resizable 200–360 px by dragging the card's left edge.                                                                                                                    |
| Sidebar toggle | New command `view.toggleSidebar`, ⌘S, in the View menu.                                                                                                                                   |
| Collapsed      | Card inset 8 px on all four sides. Touching the left 6 px of the window slides the sidebar in over the card; it hides 400 ms after the pointer leaves.                                     |
| Content card   | Inset 8 px from top, right and bottom; left edge at the sidebar width. Radius 10, 1 px hairline, card shadow.                                                                             |
| Split view     | Two cards with an 8 px gap. The gap is the existing divider hit area. The focused pane adds a 2 px `--accent-soft` ring.                                                                   |
| View bounds    | WebContentsView bounds: x = sidebar width, y = 8, width = W − sidebar − 8, height = H − 16. Corner radius 10 on the view (confirm `setBorderRadius` against the pinned Electron version). |
| Card chrome    | The UI renderer paints the hairline and shadow in a card-shaped layer under the view.                                                                                                     |
| Material       | BrowserWindow `vibrancy: "sidebar"` with a transparent UI background. The space tint is a UI layer above the vibrancy and below the sidebar content.                                      |

## 3. Color and theming

### Tiers

1. **Palette.** A 12-step neutral ramp per appearance (OKLCH hue 275, chroma 0.006) and ten space hues. Components never read the palette directly.
2. **Semantic roles.** The token set in the table below, produced by the theme function.
3. **Component values.** Sizes such as `--sidebar-width`, `--row-height`, `--radius-tab`, `--card-inset`. Component colors alias semantic roles.

### Neutral ramps

OKLCH lightness per step, hue 275, chroma 0.006:

| Step  | 1     | 2     | 3     | 4    | 5     | 6     | 7    | 8    | 9    | 10   | 11   | 12   |
| ----- | ----- | ----- | ----- | ---- | ----- | ----- | ---- | ---- | ---- | ---- | ---- | ---- |
| Light | 0.992 | 0.978 | 0.955 | 0.93 | 0.905 | 0.875 | 0.83 | 0.76 | 0.62 | 0.55 | 0.44 | 0.22 |
| Dark  | 0.17  | 0.2   | 0.235 | 0.265 | 0.295 | 0.33 | 0.38 | 0.46 | 0.6  | 0.67 | 0.8  | 0.95 |

### Space hues

| Hue    | OKLCH h | Chroma |
| ------ | ------- | ------ |
| iris   | 277     | 0.15   |
| violet | 305     | 0.15   |
| orchid | 338     | 0.14   |
| rose   | 12      | 0.15   |
| coral  | 42      | 0.14   |
| amber  | 78      | 0.13   |
| lime   | 128     | 0.14   |
| mint   | 162     | 0.11   |
| teal   | 198     | 0.10   |
| sky    | 240     | 0.13   |

### Space theme model

A space theme is one hue or a two-stop gradient plus an intensity from 0 to 1. A pure function in `packages/core` maps the theme and the appearance to the full semantic token set.

```ts
export type SpaceHue =
  | "iris" | "violet" | "orchid" | "rose" | "coral"
  | "amber" | "lime" | "mint" | "teal" | "sky";

export interface SpaceTheme {
  stops: [SpaceHue] | [SpaceHue, SpaceHue];
  intensity: number;
}

export type Appearance = "light" | "dark";

export function themeTokens(
  theme: SpaceTheme | null,
  appearance: Appearance,
): Record<SemanticToken, string>;
```

| Rule       | Specification                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composite  | Vibrancy base, then the tint layer at 0.55 × intensity opacity (light) or 0.35 × intensity (dark), then sidebar content. Tint lightness: OKLCH 0.78 light, 0.48 dark.     |
| Gradient   | Two stops render as `linear-gradient(160deg, stop1, stop2)`. Contrast is checked against both stops.                                                                      |
| Ink        | Dark or light ink, whichever has the higher worst-case contrast against every stop's composite. `--ink-secondary` mixes ink toward the ground until it just holds 4.5:1. |
| Accent     | From the first stop's hue. Lightness starts at 0.54 (light) or 0.76 (dark) and moves in 0.02 steps until the accent holds 3:1 against the card and the tinted window.     |
| Null theme | No tint. The window shows plain vibrancy; the accent falls back to iris.                                                                                                  |
| Guarantees | Pure and deterministic; intensity clamped to 0–1.                                                                                                                         |
| Tests      | Sweep 10 single hues and 90 ordered pairs at intensity 0, 0.5 and 1 in both appearances (600 cases) and assert every contrast floor.                                      |
| Storage    | Nullable `theme` JSON column on spaces in the next schema version.                                                                                                        |
| Migration  | Existing spaces receive hues by position: iris, rose, teal, amber, violet, mint, coral, sky, orchid, lime, then repeat; intensity 1.                                     |

Reference base colors used by the function: window base `#eaeaee` light, `#202024` dark; card `#ffffff` light, `#1b1b1f` dark; popover `#fafafc` light, `#2c2c31` dark; ink `#1a1a1f` dark, `#f5f5f7` light.

### Semantic tokens

| Token                     | Role                                                     |
| ------------------------- | -------------------------------------------------------- |
| `--surface-window`        | Vibrancy fallback under the tint                         |
| `--tint`                  | Space tint layer (color or gradient)                     |
| `--tint-opacity`          | Tint layer opacity                                       |
| `--surface-card`          | Content card                                             |
| `--surface-raised`        | Active tab, active favorite tile, update banner          |
| `--surface-hover`         | Hover overlay on the window (ink at 8%)                  |
| `--fill-subtle`           | URL pill, favorite tiles                                 |
| `--hairline`              | Dividers on the window                                   |
| `--ink-primary`           | Text on the window                                       |
| `--ink-secondary`         | Secondary text and icons on the window                   |
| `--accent`                | Selection, primary buttons, progress                     |
| `--accent-soft`           | Selected rows, focused split pane ring                   |
| `--ink-on-accent`         | Text on the accent                                       |
| `--focus-ring`            | Keyboard focus                                           |
| `--danger`                | Destructive actions                                      |
| `--surface-popover`       | Popovers, command bar, sheets                            |
| `--ink-popover`           | Text on popovers                                         |
| `--ink-popover-secondary` | Secondary text on popovers                               |
| `--popover-hairline`      | Dividers on popovers                                     |
| `--popover-well`          | Grouped settings wells, segmented control track          |
| `--control-raised`        | Buttons and the selected segment on popovers             |
| `--scrim`                 | Behind modal surfaces                                    |
| `--shadow-raised`         | Raised items on the window                               |
| `--shadow-card`           | Content card                                             |
| `--shadow-popover`        | Popovers, find bar                                       |
| `--shadow-palette`        | Command bar, settings sheet, dialogs, quick-browse       |

## 4. Type

SF Pro through `-apple-system`. Web content keeps its own fonts.

| Size / weight   | Token         | Use                                    |
| --------------- | ------------- | -------------------------------------- |
| 22 / 400        | `--text-xl`   | Command bar input                      |
| 17 / 600        | `--text-lg`   | Sheet and page titles                  |
| 15 / 600        | `--text-md`   | Dialog and popover titles              |
| 13 / 500        | `--text-base` | Tab titles, buttons                    |
| 13 / 400        | `--text-base` | Body text in surfaces                  |
| 12 / 400        | `--text-sm`   | Meta, counts, shortcut hints           |
| 11 / 600, +0.06em, uppercase | `--text-xs` | Section labels                |

## 5. Spacing, radius, elevation, icons

- **Spacing:** 4 px grid with half steps: 2, 4, 6, 8, 12, 16, 20, 24, 32 (`--space-1` … `--space-9`).
- **Radius:** 6 controls, 8 tabs and rows, 10 pills and cards, 12 favorite tiles, 14 command bar, sheets and dialogs.
- **Elevation:** three shadow levels (card, popover, palette), each paired with a hairline so edges hold on any tint.
- **Icons:** 16 px line icons, 1.5 stroke, round caps and joins, inline SVG with `currentColor`. No icon dependency.

## 6. Surfaces

### Sidebar, top to bottom

1. **Window row.** Traffic lights, sidebar toggle, back, forward, reload.
2. **URL pill.** Domain of the active tab only. 34 px tall, radius 10, `--fill-subtle`. Click or ⌘L opens the command bar in location mode.
3. **Favorites.** A global list shared by every space. Up to four columns of 48 px tiles with 24 px favicons, radius 12. The active favorite is raised.
4. **Pinned tabs.** Per space, rendered as rows. They survive Clear.
5. **Divider and Clear.** A hairline with a Clear action that archives today's tabs.
6. **Today's tabs.** New Tab row, then 34 px rows. Active row raised, hover is an 8% ink overlay. Zoom level and blocked-request count at the trailing edge; close on hover.
7. **Update banner.** Only when an update is ready. Raised surface, primary action in the accent.
8. **Bottom bar.** Downloads and archived tabs on the left, one dot per space in its theme color (active raised), new space on the right.

### Command bar

Floats centered about 20% from the top of the window, 680 px wide, over a blurred scrim. 22 px input. Results group as Tabs, History and Commands in 40 px rows with right-aligned shortcut hints. The selected row uses `--accent-soft`.

### Settings

A 760 × 500 sheet over the scrim with a section list on the left: General (search engine, external links, updates), Content blocking (including allowlisted sites), Profiles, History, About. Groups sit in wells with hairline row separators.

### Find bar

A floating pill at the top right of the content card, inset 8 px: query, match count, previous, next, close.

### Space theme picker

Opens from Edit Theme… in a space's context menu, anchored to its dot in the bottom bar. Solid or gradient, ten swatches, intensity slider, and a contrast readout for both appearances.

### Popovers, dialogs, menus

Downloads, quick-browse, the update banner and dialogs share the popover tokens (radius 10 or 14). Tab and space context menus stay native macOS `Menu` popups.

## 7. Motion

| Token             | Value                        | Use                                                            |
| ----------------- | ---------------------------- | -------------------------------------------------------------- |
| `--motion-fast`   | 120ms                        | Hover and press on rows, tiles, icon buttons                   |
| `--motion-base`   | 200ms                        | Popover, find bar, settings and command bar open (scale 0.97 → 1 and fade) |
| `--motion-space`  | 320ms                        | Space switch: tab list slides toward the new space, tint cross-fades |
| `--ease-standard` | `cubic-bezier(.2, .8, .2, 1)` | All of the above                                               |

With `prefers-reduced-motion: reduce`, every movement becomes a 120 ms cross-fade and the caret stops blinking.

## 8. Accessibility and tests

- **Focus:** every control shows a 2 px `--focus-ring` outline on `:focus-visible`, offset 1 px.
- **Contrast:** enforced by the theme function: 4.5:1 for primary and secondary ink on every tint, 3:1 for the accent against the card and the window.
- **Hit targets:** at least 28 × 28 px.
- **Semantics:** existing ARIA roles and every `data-testid` stay on the same elements; class names may change.

Test ids that must survive:

| Surface      | `data-testid`                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| Sidebar      | sidebar, pinned-section, unpinned-section, new-tab-button, tab-zoom, tab-shield, drop-indicator, dropzone      |
| Spaces       | space-switcher, space-item, new-space-button, space-name-input                                                 |
| Archive      | archived-toggle, archived-view, archived-item, archived-time, archived-delete, archived-empty                  |
| Footer       | downloads-indicator, update-banner, update-banner-action                                                       |
| Command bar  | command-bar, command-bar-input, command-bar-suggestion                                                          |
| Find bar     | find-bar, find-input, find-count, find-previous, find-next, find-close                                         |
| Quick-browse | quick-browse, quick-browse-title, quick-browse-url, quick-browse-promote, quick-browse-promote-space, quick-browse-dismiss |

End-to-end checks each surface PRD adds:

- **Tokens:** computed custom properties on the window root after a space switch match `themeTokens()` output.
- **Geometry:** WebContentsView bounds match the §2 formula at several window sizes, sidebar widths and in split view.
- **No hex:** a lint step fails when a component CSS file contains a hex color outside the palette file.
- **No screenshot assertions:** checks read the DOM and bounds.

## 9. Delivery

One PRD per uzi run, in order.

| PRD  | Scope                                                                                                                                   | Sections   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 10.1 | Foundation: token tiers as CSS, `themeTokens()` with the contrast sweep, `App.css` split into one file per component, hex lint.          | §3, §4, §5 |
| 10.2 | Frameless chrome: hidden title bar, traffic lights in the sidebar row, vibrancy, inset card and view bounds, resizable and collapsible sidebar, `view.toggleSidebar` on ⌘S. | §2 |
| 10.3 | Space themes: schema column and migration, theme picker, window re-tint on space switch, space dots in theme colors.                    | §3, §6     |
| 10.4 | Sidebar: URL pill, global favorites (storage and grid), pinned and today sections, Clear, bottom bar, update banner.                    | §6         |
| 10.5 | Command bar: floating bar, grouped results, shortcut hints, scrim.                                                                      | §6         |
| 10.6 | Secondary surfaces: settings sheet, find bar, downloads, split view, quick-browse, dialogs.                                             | §6         |
| 10.7 | Motion and polish: durations, space switch animation, reduced motion, final contrast and focus pass.                                    | §7, §8     |

## 10. Decisions

- **Favorites are global.** A new favorites list shared by every space fills the tile grid; pinned tabs stay per space as rows. PRD 10.4 adds the storage.
- **Sidebar toggle on ⌘S.** New `view.toggleSidebar` command, delivered with PRD 10.2.
- **Existing spaces get hues by position** during the migration that adds the `theme` column, at intensity 1.
- **Context menus stay native.** Only surfaces zeo draws itself take the popover tokens.
