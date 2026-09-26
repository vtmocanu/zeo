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
   exists (a fine-grained PAT scoped to `vtmocanu/homebrew-tap`,
   `contents: write` there only). It is used by the `publish-cask` job below;
   a missing secret fails that job fast, before it clones the tap.
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

The `publish-cask` job runs after `release` (`needs: [release]`) on
`ubuntu-latest`, with `contents: read` on this repo — it only checks out the
cask template and render script and downloads `SHA256SUMS` from the Release.
It reads the arm64 dmg's digest out of `SHA256SUMS`, renders
`packaging/homebrew/zeo.rb.tmpl` with `packaging/homebrew/render.mjs` (which
fails closed on a bad sha256, a version that does not match `package.json`, a
url missing the version, or template placeholder drift), then pushes
`Casks/zeo.rb` to `vtmocanu/homebrew-tap` as `zeo-release-bot` with commit
message `zeo <version>`. It is idempotent — if the tap already carries an
identical cask for that version it commits and pushes nothing — fails fast on
a missing `HOMEBREW_TAP_TOKEN`, and fails (never force-pushes) if the tap
advanced concurrently. It never writes to this repository. It does not
consume the `release` job's `version` output, deriving its own version from
the tag (`${GITHUB_REF_NAME#v}`) instead, which `release` already verified
matches `package.json`.

Note: the `publish-cask` job is delivered only in this template; per #20 it
still needs a human to commit `.github/workflows/release.yml` before it runs,
and the first publish to the tap is blocked on that same issue.

## Checking the cask locally

`pnpm cask:check` runs the render script's unit tests, renders
`packaging/homebrew/zeo.rb.tmpl` against a committed fixture, and, when
Homebrew is installed, runs `brew style --cask` on the rendered cask. When
Homebrew is not installed it prints "Homebrew not found; skipping brew style
check" and exits `0`.

`brew audit` is not run because current Homebrew refuses to audit a cask by
file path (it must live in a tap); `brew style --cask` is the check that
accepts a path.

## Hardening to consider before activating

The `release` job is the workflow as specified by PRD 8.1, and `publish-cask`
is as specified by PRD 8.2. A security review suggested these changes for the
human who commits it (none are applied, so the committed file matches the
specs unless you choose otherwise):

- **Split build from publish.** Dependency code (install, lint, build, test,
  package) runs in the same job that later hands `GH_TOKEN` (contents: write)
  to `gh`. A `build` job with `contents: read` that uploads the artifacts, plus
  a `publish` job with `contents: write` that only downloads them, re-checks
  `SHA256SUMS`, and runs `gh release create`, keeps the write token away from
  third-party code.
- **Pin actions to commit SHAs** (with a version comment) rather than moving
  tags such as `@v7`, at least in this write-scoped workflow — this applies to
  `publish-cask` too, which uses `actions/checkout@v7` and
  `actions/setup-node@v7` while holding `HOMEBREW_TAP_TOKEN`.
- **Pass the version through `env:`** in the "Generate SHA256SUMS" step
  (`"zeo-$VERSION-arm64.dmg"`) like the other steps, instead of interpolating
  `${{ steps.version.outputs.version }}` into the script.
- **Drop `cache: pnpm`** from `setup-node` here, so a release build never
  restores a dependency cache written by another workflow run.
- **Electron fuses.** `electron-builder.yml` sets no `electronFuses`, so the
  packaged app keeps Electron defaults (e.g. `ELECTRON_RUN_AS_NODE`). Consider
  disabling `runAsNode`, `enableNodeOptionsEnvironmentVariable`, and
  `enableNodeCliInspectArguments`.
- `publish-cask` already runs with `contents: read` on this repo, so the
  split-build-from-publish pattern above is not needed there, but two more
  cask-specific gaps remain:
  - **The tap token lives in the clone URL.** "Publish to the tap" clones
    `https://x-access-token:${HOMEBREW_TAP_TOKEN}@github.com/vtmocanu/homebrew-tap.git`,
    so the token persists in `tap/.git/config` until the job ends, where a
    later (or malicious) post-step of `checkout`/`setup-node` could read it.
    Authenticate with an `http.extraheader` or a credential helper instead of
    embedding it in the URL, or `rm -rf tap` at the end of the publish step.
  - **Render before the token step.** "Render the cask" runs repo code
    (`packaging/homebrew/render.mjs`) in the same job, before
    `HOMEBREW_TAP_TOKEN` is used. For stronger isolation, render in a separate
    job that uploads `zeo.rb` as an artifact to a token-only publish job.

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

The intended install path for end users is Homebrew:

```sh
brew install --cask vtmocanu/tap/zeo --no-quarantine
```

which installs the app without the quarantine attribute so Gatekeeper never
blocks it — see the README's [Installation](../../README.md#installation)
section.

`release/` is git-ignored; packaging artifacts are never committed.
