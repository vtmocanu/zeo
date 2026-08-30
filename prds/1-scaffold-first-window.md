# PRD 1 — Monorepo scaffold and first window

## Context

zeo is a keyboard-first, workspace-centric open-source browser for macOS built
on Electron. Full design: `docs/specs/2026-08-30-zeo-v1-design.md`. This PRD
creates the foundation every later PRD builds on: the monorepo, the running
app shell, the test harnesses, and green CI.

## Deliverables

### 1. Monorepo

pnpm workspaces with these packages, all TypeScript strict:

- `packages/core` — domain logic package. For this PRD it contains the tab
  domain model only: a `Tab` type (id, url, title, createdAt) and a
  `TabStore` with create/close/activate/list operations and an active-tab
  invariant (closing the active tab activates its neighbor; closing the last
  tab leaves no active tab). Pure TypeScript; importing `electron` must fail
  lint.
- `apps/desktop` — Electron main process + preload. Uses `electron-vite` for
  build/dev. On launch: opens one window hosting the UI renderer and one
  `WebContentsView` tab showing `https://example.com`. A typed IPC bridge
  (preload, `contextBridge`) exposes `zeo.tabs` commands (create, close,
  activate, list) backed by the `TabStore` in main, and a state-change event
  channel the renderer subscribes to.
- `apps/ui` — renderer: React + Vite + TypeScript. Renders a left sidebar
  placeholder listing open tabs by title with a new-tab button, wired through
  the IPC bridge. No direct Node or Electron imports.
- `e2e` — Playwright Electron tests.

### 2. Tooling

- Root scripts: `lint`, `typecheck`, `test`, `e2e`, `dev`, `build` — each
  runs across all workspaces.
- ESLint (flat config) + Prettier. Add a lint rule forbidding `electron`
  imports in `packages/core` and Node/Electron imports in `apps/ui`.
- Vitest in `packages/core` with unit tests covering the `TabStore`
  operations and invariants.
- Playwright e2e: launch the built app, assert the window opens, the sidebar
  renders, a new tab can be created via the sidebar button, and the tab list
  updates.
- `.gitignore` covering node_modules, build output, Playwright artifacts.

### 3. Constraints

- Node 24, pnpm via corepack.
- Do not create or modify anything under `.github/workflows/` — the push will
  be rejected. The workflows already committed expect exactly the root script
  names listed above.
- Keep dependencies minimal; no state-management or UI-kit libraries in this
  PRD.

## Acceptance criteria

- `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test`
  passes locally.
- `pnpm e2e` passes under xvfb on Linux.
- `pnpm dev` opens a window with a sidebar and one tab rendering
  example.com.
- CI (`ci` workflow) is green on the merge request branch.
- `CLAUDE.md` commands and layout stay accurate; update it if a script name
  or path had to change.
