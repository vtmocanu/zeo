# Changelog

All notable changes to zeo are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) with a deliberately
conservative scale: 1.0.0 means a perfectly usable daily-driver browser at
least as good as Arc. Until then versions stay low — a patch bump per merged
milestone, a minor bump only for very large breakthroughs.

## [Unreleased]

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
