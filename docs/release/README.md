# Release guide

zeo ships ad-hoc signed macOS `arm64` builds only (dmg + zip), created by a
tag-driven GitHub Actions workflow. This document covers one-time setup, how
to cut a release, and how to package the app locally.

## One-time setup (issue #20, a human, not automation)

The implementing run for PRD 8.1 does **not** create or modify anything under
`.github/workflows/` — workflow files are committed by a human. To activate
the release workflow:

1. Copy `docs/release/release.yml.template` to `.github/workflows/release.yml`
   and commit it by hand.
2. Confirm the `HOMEBREW_TAP_TOKEN` repository/organization Actions secret
   exists (a fine-grained PAT scoped to `vtmocanu/homebrew-tap`). This is
   needed by PRD 8.2's Homebrew cask job, appended later — 8.1's workflow
   never reads it and uses only the built-in `GITHUB_TOKEN`.
3. Add a tag-protection rule (or ruleset) restricting who may push `v*` tags
   to release maintainers. A pushed `v*` tag triggers a `contents: write`
   release build, so tag authorization is a release prerequisite, not
   something the workflow enforces.

## Cutting a release

1. Bump the root `package.json` to the next patch version.
2. Add a `## [x.y.z] - YYYY-MM-DD` section to `CHANGELOG.md` with a non-empty
   body — this becomes the GitHub Release notes verbatim.
3. Commit the version bump and changelog entry.
4. Run `pnpm release:check` locally. It verifies, in order: the root version
   is set, the CHANGELOG has a valid dated section with a non-empty body for
   that version, and the working tree is clean. It fails with a specific
   message on the first problem and never pushes anything.
5. Tag and push:

   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

Pushing the tag triggers `.github/workflows/release.yml` on `macos-latest`,
which:

1. Guards that the pushed tag's version matches `package.json`'s version,
   failing fast (before any build) on a mismatch.
2. Runs `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, then
   `pnpm package` to produce the arm64 `.app`/`dmg`/`zip`.
3. Generates a `SHA256SUMS` file over the `dmg` and `zip`.
4. Smoke-tests the packaged bundle: the app exists, is ad-hoc signed
   (`codesign -dv` reports `Signature=adhoc`), and its `Info.plist` carries
   the expected bundle id and version.
5. Builds the GitHub Release notes from the CHANGELOG section for that
   version.
6. Uploads the `dmg`, `zip`, and `SHA256SUMS` as workflow artifacts.
7. Creates the GitHub Release **last** — `gh release create` on the pushed
   tag, so any earlier failure means no Release is published.

PRD 8.2 appends a `cask` job (`needs: [release]`) that renders and pushes the
Homebrew cask to `vtmocanu/homebrew-tap`; that job is not part of 8.1.

## Hardening to consider before activating

The template is the workflow as specified by PRD 8.1. A security review of it
suggested these changes for the human who commits it (none are applied, so the
committed file matches the spec unless you choose otherwise):

- **Split build from publish.** Dependency code (install, lint, build, test,
  package) runs in the same job that later hands `GH_TOKEN` (contents: write)
  to `gh`. A `build` job with `contents: read` that uploads the artifacts, plus
  a `publish` job with `contents: write` that only downloads them, re-checks
  `SHA256SUMS`, and runs `gh release create`, keeps the write token away from
  third-party code.
- **Pin actions to commit SHAs** (with a version comment) rather than moving
  tags such as `@v7`, at least in this write-scoped workflow.
- **Pass the version through `env:`** in the "Generate SHA256SUMS" step
  (`"zeo-$VERSION-arm64.dmg"`) like the other steps, instead of interpolating
  `${{ steps.version.outputs.version }}` into the script.
- **Drop `cache: pnpm`** from `setup-node` here, so a release build never
  restores a dependency cache written by another workflow run.
- **Electron fuses.** `electron-builder.yml` sets no `electronFuses`, so the
  packaged app keeps Electron defaults (e.g. `ELECTRON_RUN_AS_NODE`). Consider
  disabling `runAsNode`, `enableNodeOptionsEnvironmentVariable`, and
  `enableNodeCliInspectArguments`.

## Local packaging on macOS

`pnpm package` (which runs `pnpm build` first) produces:

- `release/mac-arm64/zeo.app`
- `release/zeo-<version>-arm64.dmg`
- `release/zeo-<version>-arm64.zip`

where `<version>` is the root `package.json` version. This is `arm64`-only —
no Windows or Linux, no x64/universal — and cannot be run on Linux (a macOS
`.app`/`dmg` is only produced on macOS).

The app is **ad-hoc signed only**, not Developer ID signed, and is not
notarized:

```sh
codesign -dv release/mac-arm64/zeo.app
# Signature=adhoc
```

Because the app is un-notarized, a `dmg`/`zip` downloaded through a browser
carries the `com.apple.quarantine` attribute and macOS Gatekeeper blocks the
first open ("zeo cannot be opened because the developer cannot be verified" /
"is damaged"). Allow it under System Settings → Privacy & Security → Open
Anyway (older macOS also accepts a right-click → Open), or clear the attribute:

```sh
xattr -dr com.apple.quarantine /path/to/zeo.app
```

The intended install path for end users is PRD 8.2's
`brew install --cask … --no-quarantine`, which installs the app without the
quarantine attribute so Gatekeeper never blocks it. That cask is not shipped
by 8.1.

`release/` is git-ignored; packaging artifacts are never committed.
