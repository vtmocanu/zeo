# Changelog

All notable changes to zeo are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) with a deliberately
conservative scale: 1.0.0 means a perfectly usable daily-driver browser at
least as good as Arc. Until then versions stay low — a patch bump per merged
milestone, a minor bump only for very large breakthroughs.

## [Unreleased]

## [0.0.4] - 2026-08-31

### Added

- Automatic archiving of idle tabs: an unpinned, non-active tab untouched for
  12 hours is archived by an hourly background sweep (also run once on
  launch); the focused tab's activity is refreshed on window focus, so a tab
  left focused (e.g. overnight) is never swept.
- Archived-tabs view in the sidebar footer: an "Archived (N)" toggle reveals
  the list, each row showing favicon, title, and how long ago it was
  archived; clicking a row restores it to the open tabs, and a per-row delete
  button permanently removes it.
- `formatRelativeArchived` helper in `packages/core` for the archived-age
  labels ("just now", "5m ago", "3h ago", "2d ago").

## [0.0.3] - 2026-08-31

### Added

- Drag to reorder sidebar tabs within a section, using pointer events (no
  drag-and-drop library); a drop indicator shows the insertion point.
- Dragging a tab across the pinned/unpinned boundary pins/unpins it and drops
  it at the target slot; both sections stay droppable during a drag.
- Native tab context menu (right-click) built in the main process — Pin/Unpin,
  Archive (disabled on pinned tabs), Close, Copy URL — reached over a new
  `showContextMenu` IPC channel and dispatching through the same store ops.
- Playwright e2e coverage for the pointer-drag reorder and the context-menu
  descriptor.

## [0.0.2] - 2026-08-30

### Added

- Live tab titles and favicons: main-process `page-title-updated`/
  `page-favicon-updated` listeners synced into the tab model via
  `TabStore.updateMeta`; the hostname-derived title remains the fallback
  until the first real title arrives.
- `Tab.faviconUrl` in `packages/core`.
- Sidebar redesigned into pinned (compact, top) and unpinned sections, each
  row showing a favicon (fallback glyph when none) with the close button
  revealed on hover.
- Keyboard shortcuts via application-menu accelerators: Cmd/Ctrl+T new tab,
  Cmd/Ctrl+W close active tab, Cmd/Ctrl+1..9 activate the Nth visible tab,
  working from both the sidebar and inside a tab's web contents.
- Main-process IPC handlers completing the pin/unpin/reorder/archive/restore
  bridge (the preload surface existed since PRD 2.1).
- Extended Playwright e2e suite covering the above.

## [0.0.1] - 2026-08-30

### Added

- pnpm monorepo: `packages/core` (pure-TypeScript domain logic),
  `packages/adblock`, `apps/desktop` (Electron main + preload), `apps/ui`
  (React renderer), `e2e` (Playwright Electron suite).
- Electron window hosting one `WebContentsView` per tab, sidebar placeholder,
  typed IPC bridge between main and renderer.
- Core tab model in `packages/core`: create/close/activate, pinning with
  pinned-first ordering, in-group reorder with clamped indices, MRU
  close-activation with sequence-based tie-breaks, archive/restore with an
  archived-tabs view, `TabsState`/`TabsApi` IPC contract for pin, unpin,
  reorder, archive, and restore.
- Vitest unit suite for the tab store and title derivation; Playwright e2e
  harness; lint/typecheck/build/test/e2e CI on Linux and macOS.
