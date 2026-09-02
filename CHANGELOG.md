# Changelog

All notable changes to zeo are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) with a deliberately
conservative scale: 1.0.0 means a perfectly usable daily-driver browser at
least as good as Arc. Until then versions stay low — a patch bump per merged
milestone, a minor bump only for very large breakthroughs.

## [Unreleased]

## [0.0.9] - 2026-09-02

### Added

- Command bar: an overlay opened by Cmd+L (prefilled with the active tab's
  current url, to navigate that tab) or Cmd+T / the sidebar new-tab button
  (empty, creating a new tab on submit). Escape or clicking away dismisses
  it.
- Typed text resolves to either a URL or a DuckDuckGo search: an `http`/
  `https` input, or a bare host/host:port (localhost, an IPv4 literal, or a
  dotted hostname), navigates; anything else — including other schemes such
  as `file:` or `about:` — becomes a search of the typed text.
- The active tab's url is now tracked live: the sidebar label and the
  Cmd+L prefill follow in-page navigation instead of only the tab's initial
  url.

### Changed

- Cmd+T and the sidebar new-tab button now open the command bar in new-tab
  mode instead of immediately creating a tab against a default url; the tab
  is created when you submit.

## [0.0.8] - 2026-09-01

### Added

- Persistence: spaces, profiles, and tabs now survive quit and relaunch via
  an on-disk SQLite database (`better-sqlite3`) owned by the Electron main
  process. State loads on launch, saves are debounced (~1s) after
  mutations, and a final synchronous write runs on quit so no in-flight
  change is lost.
- Persisted state covers each space's open and archived tabs, pin state and
  order, the active space, and each space's active tab — a relaunch
  restores the browser to where it was left, including an archived-only
  space (nothing re-seeded).
- Restored tabs recreate their `WebContentsView`s lazily: only the active
  space's active tab gets a view at startup, with the rest materialized on
  first activation (including switching space/MRU) to keep launch fast.
- A corrupt or unreadable database, or one written by a newer schema
  version, is moved aside rather than crashing or silently discarding data,
  and the app starts fresh from a new database.

## [0.0.7] - 2026-09-01

### Added

- Spaces UI: a sidebar space-switcher strip above the tab sections, one item
  per space with the active one highlighted, click to switch, and a
  new-space button that creates a space (name prompted inline, default
  "Space N") and activates it.
- Inline rename and create directly in the switcher strip, editing the space
  name in place rather than via a dialog.
- Space management via a native context menu on a space item: Rename,
  Delete (offered only when it isn't the last space, and reading "Delete (N
  tabs)" when the space has open or archived tabs), and a Profile submenu
  listing profiles with the current one checked plus a "New profile…" entry.
- Application-menu accelerators: Cmd/Ctrl+1..9 activate the Nth space and
  Cmd/Ctrl+Shift+N creates a new space.
- Playwright e2e coverage for the switcher (render, highlight, switch,
  create, rename, delete) and for the space context-menu descriptor.

### Changed

- Tab numeric activation is rebound from Cmd/Ctrl+1..9 to Cmd/Ctrl+Alt+1..9;
  the plain number chords now activate spaces.

## [0.0.6] - 2026-08-31

### Added

- Profiles: a profile model in `packages/core` (`Profile` = id, name,
  createdAt). `SpaceStore` gains profile create/rename/delete with
  referential guards — the seeded "default" profile can't be deleted, nor
  can a profile any space still references. A fresh store seeds one profile
  named "Default" with id `"default"`.
- Spaces reference profiles: `createSpace` takes an optional profileId
  (defaults to `"default"`), and a new `spaces.setProfile` re-points an
  existing space to a different profile.
- Per-space session isolation: every tab's `WebContentsView` is created on
  the `persist:<profile-id>` partition resolved from its space, so spaces on
  different profiles have isolated cookies and storage while spaces sharing
  a profile share them. Re-pointing a space's profile migrates its views to
  the new partition in order (destroy, update the store reference, recreate,
  then broadcast once) since Electron cannot repartition a live
  `WebContents` in place — affected pages reload.
- IPC/bridge: `profiles.create`/`rename`/`delete` and `spaces.setProfile`;
  the broadcast state now carries the profile list alongside each space's
  `profileId`.
- Playwright e2e coverage proving cookie and session-partition isolation
  across spaces on different profiles, and sharing on spaces with the same
  profile.

There is no profile-management UI yet (the sidebar is unchanged) and
profiles are not persisted across restarts — both land in later milestones.

## [0.0.5] - 2026-08-31

### Added

- Spaces: named workspaces that each own their own tab set and active tab. A
  fresh launch seeds one space, "Personal", holding the seeded tab. The space
  domain model lives in `packages/core` (`SpaceStore`, composing one `TabStore`
  per space), with create/rename/delete/activate rules — always at least one
  space, deleting the last one is refused, and deleting the active space
  activates another.
- Space switching over the IPC bridge (`spaces.create`/`rename`/`delete`/
  `activate`/`list`): the broadcast state now carries the space list and active
  space id alongside the active space's tabs, the main process shows the
  incoming space's active tab and hides the others on a switch, and the idle
  sweep runs across every space. There is no space UI yet — the sidebar keeps
  rendering the active space's tabs unchanged; the space switcher lands in a
  later milestone.

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
