# zeo v1 design

## Overview

zeo is a keyboard-first, workspace-centric open-source browser for macOS,
built on Electron and Chromium.

## Goals (v1)

- Left sidebar with vertical tabs, pinned tabs, and tab archiving
- Spaces: named workspaces, each with its own tab set and profile
- Command bar: one keyboard entry point for URLs, search, tab switching, and actions
- Profiles: isolated cookies/storage per space via Electron session partitions
- Built-in content blocking (filter-list based)
- Table stakes: history, downloads, find-in-page, zoom, settings
- Split view and a lightweight quick-browse window
- Distribution via Homebrew cask

## Non-goals (v1)

- Windows and Linux releases
- Chrome extension support (roadmap)
- Cross-device sync (roadmap)
- Signed/notarized builds

## Architecture

### Process model

- The Electron main process is the browser kernel: window management, tab
  hosting, profiles, content blocking, persistence.
- Each tab is a `WebContentsView` owned by the main process.
- Each window has one UI renderer (React) for sidebar, command bar, and settings.
- Application state lives in the main process as the single source of truth.
  Renderers subscribe to a state stream and dispatch commands over a typed IPC
  bridge exposed through the preload script.

### Profiles

A profile maps to an Electron `session` partition (`persist:<profile-id>`),
giving real cookie/storage isolation. Each space references a profile; multiple
spaces may share one.

### Content blocking

Filter-list based blocking (uBlock Origin lists) applied through
`@ghostery/adblocker-electron` in the main process, per session.

## Package layout

| Path | Purpose | Constraints |
|---|---|---|
| `packages/core` | Domain logic: tab/space/profile state machines, command registry, persistence schemas | Pure TypeScript. No Electron imports (lint-enforced) |
| `packages/adblock` | Filter engine wrapper | |
| `apps/desktop` | Electron main + preload | |
| `apps/ui` | Renderer: React + Vite | No Node/Electron APIs; talks to main via the IPC bridge only |
| `e2e` | Playwright Electron suites | |

## Persistence

SQLite via `better-sqlite3` in the main process: spaces, tabs, archived tabs,
history, downloads metadata, settings.

## Testing

- `packages/core`: Vitest unit tests
- `e2e`: Playwright drives the real app (headless under xvfb on Linux)
- CI: Linux job runs lint, typecheck, unit, e2e; macOS job builds, tests, and
  packages
- Manual review on macOS covers visual polish

## Distribution

- Ad-hoc signed build, dmg/zip artifacts from CI on tagged releases
- Homebrew cask in `vtmocanu/homebrew-tap`
- In-app update check against GitHub Releases prompting `brew upgrade`

## Milestones

1. Monorepo scaffold, app window, first tab renders a page, CI green
2. Tab model and sidebar: vertical tabs, pin, close, reorder
3. Spaces and profiles
4. Command bar
5. Content blocking
6. History, downloads, find-in-page, zoom, settings
7. Split view and quick-browse window
8. Packaging and Homebrew release
