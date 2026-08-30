# zeo

Keyboard-first, workspace-centric open-source browser for macOS. Electron +
TypeScript monorepo (pnpm workspaces). Design doc: `docs/specs/`.

## Commands

- `pnpm install --frozen-lockfile`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test` — Vitest unit tests
- `pnpm e2e` — Playwright Electron suite; needs a display (use `xvfb-run` on
  Linux, or run inside a Playwright container when GUI libraries are missing)
- `pnpm dev` — launch the app with HMR

## Structure

- `packages/core` — domain logic. Pure TypeScript: importing `electron` here is
  forbidden and lint-enforced. All tab/space/profile state, command registry,
  persistence schemas live here.
- `packages/adblock` — filter engine wrapper
- `apps/desktop` — Electron main process + preload
- `apps/ui` — renderer (React + Vite). No Node/Electron APIs; IPC bridge only.
- `e2e` — Playwright Electron tests

## Rules

- State lives in the main process; renderers subscribe and dispatch commands.
  Never fork state in the UI.
- New behavior lands with tests. Logic goes in `packages/core` where it is
  unit-testable; keep `apps/ui` components thin.
- TypeScript strict mode; no `any` without a stated reason in review.
- Conventional Commits.
- Do not create or modify files under `.github/workflows/` — pushes touching
  them are rejected for the automation token.
