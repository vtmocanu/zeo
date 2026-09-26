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

Add the tap and install with Homebrew:

```sh
brew tap vtmocanu/tap
brew install --cask vtmocanu/tap/zeo --no-quarantine
```

Upgrade: `brew upgrade --cask zeo`.

Uninstall: `brew uninstall --cask zeo`; to also remove app data:
`brew uninstall --cask --zap zeo`.

zeo ships as an ad-hoc signed build — no Apple Developer ID signature and no
notarization — so `--no-quarantine` is required: without it macOS Gatekeeper
blocks the first launch ("zeo can't be opened because Apple cannot check it
for malicious software"). With `--no-quarantine`, zeo launches directly on
first run. If you installed without it, recover by right-clicking zeo.app in
Finder and choosing Open once, or by clearing the quarantine attribute:

```sh
xattr -dr com.apple.quarantine "/Applications/zeo.app"
```

Apple Silicon (arm64) only.

## License

TBD
