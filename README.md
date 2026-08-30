# zeo

A keyboard-first, workspace-centric open-source browser for macOS, built on
Electron and Chromium.

## Features (v1, in development)

- Left sidebar with vertical tabs, pinning, and tab archiving
- Spaces: workspaces with their own tabs and isolated profiles
- Command bar: one keyboard entry point for URLs, search, and actions
- Built-in content blocking
- Split view

Design: [docs/specs/](docs/specs/)

## Status

Early development. Not yet usable.

## Development

```sh
corepack enable
pnpm install
pnpm dev
```

`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm e2e` mirror CI.

## Installation

Planned: Homebrew cask via `vtmocanu/tap` once the first release ships.

## License

TBD
