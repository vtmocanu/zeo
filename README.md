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
brew install --cask vtmocanu/tap/zeo
xattr -dr com.apple.quarantine /Applications/zeo.app
```

Upgrade: `brew upgrade --cask zeo`.

Uninstall: `brew uninstall --cask zeo`; to also remove app data:
`brew uninstall --cask --zap zeo`.

zeo ships as an ad-hoc signed build — no Apple Developer ID signature and no
notarization — so macOS Gatekeeper quarantines it and blocks the first launch
("zeo can't be opened because Apple cannot check it for malicious software").
The `xattr` command above clears the quarantine attribute; run it again after
each `brew upgrade`. Alternatively, right-click zeo.app in Finder and choose
Open once.

Apple Silicon (arm64) only.

## License

TBD
