/**
 * The pure update-check vocabulary: parsing versions and the GitHub Releases
 * feed, deciding whether a fetched release counts as "available", and the
 * broadcast slice `update` mirrors to the renderer.
 *
 * Electron-free and filesystem-free by design (lint-enforced): the Caskroom
 * probe and every network call live in `apps/desktop/src/main/update.ts`,
 * which injects the filesystem check through {@link installOrigin}'s
 * `existsDir` parameter and calls these functions on the results.
 */

/** GitHub's "latest" release endpoint for this repository. */
export const UPDATE_FEED_URL =
  "https://api.github.com/repos/vtmocanu/zeo/releases/latest";

/** How often an automatic (non-manual) check may run. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How long after launch the first automatic check fires. */
export const UPDATE_CHECK_STARTUP_DELAY_MS = 10_000;

/** Abort a feed fetch that takes longer than this. */
export const UPDATE_FETCH_TIMEOUT_MS = 5_000;

/** The command shown to Homebrew-managed installs. */
export const HOMEBREW_UPGRADE_COMMAND = "brew upgrade --cask zeo";

/** Caskroom directories that mark a Homebrew-managed install. */
export const CASKROOM_PATHS: readonly string[] = [
  "/opt/homebrew/Caskroom/zeo",
  "/usr/local/Caskroom/zeo",
];

/** A semantic version split into its comparable parts. */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Parses `MAJOR.MINOR.PATCH` with an optional leading `v` and an optional
 * `-prerelease` suffix. Build metadata (`+...`), missing components, and
 * non-digit components all return `null` rather than a partial parse.
 */
export function parseVersion(text: string): ParsedVersion | null {
  const match = VERSION_RE.exec(text);
  if (!match) {
    return null;
  }
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ?? null,
  };
}

/**
 * Compares two version strings numerically by major, minor, patch. A version
 * with a prerelease sorts BELOW the same numeric triple without one; two
 * prereleases compare by plain string order. An unparseable side is treated
 * as `0.0.0` (no prerelease).
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a) ?? { major: 0, minor: 0, patch: 0, prerelease: null };
  const pb = parseVersion(b) ?? { major: 0, minor: 0, patch: 0, prerelease: null };
  if (pa.major !== pb.major) {
    return pa.major < pb.major ? -1 : 1;
  }
  if (pa.minor !== pb.minor) {
    return pa.minor < pb.minor ? -1 : 1;
  }
  if (pa.patch !== pb.patch) {
    return pa.patch < pb.patch ? -1 : 1;
  }
  if (pa.prerelease === pb.prerelease) {
    return 0;
  }
  if (pa.prerelease === null) {
    return 1;
  }
  if (pb.prerelease === null) {
    return -1;
  }
  if (pa.prerelease < pb.prerelease) {
    return -1;
  }
  if (pa.prerelease > pb.prerelease) {
    return 1;
  }
  return 0;
}

/** The subset of a GitHub release the update check cares about. */
export interface LatestRelease {
  version: string;
  url: string;
  publishedAt: string;
}

/**
 * The result of parsing the releases feed: an eligible release, a valid feed
 * with no eligible release (draft or prerelease), or a feed that could not be
 * read at all.
 */
export type ParsedFeed =
  | { kind: "release"; release: LatestRelease }
  | { kind: "none" }
  | { kind: "malformed" };

/**
 * Reads `{ tag_name, html_url, published_at, draft, prerelease }` from the
 * GitHub releases API response. Returns `{ kind: "malformed" }` when `json`
 * is not an object, `tag_name` is not a string or does not parse as a
 * version, or `html_url` is not a string; `{ kind: "none" }` when `draft` or
 * `prerelease` is `true`; otherwise `{ kind: "release", release }` with
 * `version` the tag minus its leading `v`.
 */
export function parseLatestRelease(json: unknown): ParsedFeed {
  if (typeof json !== "object" || json === null) {
    return { kind: "malformed" };
  }
  const record = json as Record<string, unknown>;
  const tagName = record.tag_name;
  const htmlUrl = record.html_url;
  const publishedAt = record.published_at;
  if (typeof tagName !== "string" || typeof htmlUrl !== "string") {
    return { kind: "malformed" };
  }
  const parsed = parseVersion(tagName);
  if (parsed === null) {
    return { kind: "malformed" };
  }
  if (record.draft === true || record.prerelease === true) {
    return { kind: "none" };
  }
  const version = tagName.startsWith("v") ? tagName.slice(1) : tagName;
  return {
    kind: "release",
    release: {
      version,
      url: htmlUrl,
      publishedAt: typeof publishedAt === "string" ? publishedAt : "",
    },
  };
}

/** How this copy of zeo was installed. */
export type InstallOrigin = "homebrew" | "direct";

/**
 * Determines the install origin by probing for any Caskroom directory. The
 * filesystem probe is injected so the function stays pure and testable
 * without `node:fs`.
 */
export function installOrigin(
  existsDir: (path: string) => boolean,
  paths: readonly string[] = CASKROOM_PATHS,
): InstallOrigin {
  return paths.some((path) => existsDir(path)) ? "homebrew" : "direct";
}

/** An update the user has not yet dismissed. */
export interface AvailableUpdate {
  version: string;
  url: string;
}

/**
 * Decides whether a fetched release counts as an available update: `null`
 * when there is no release, when it is not newer than the current version,
 * or when it matches the dismissed version; otherwise the `{ version, url }`
 * pair to show.
 */
export function updateDecision(
  currentVersion: string,
  latest: LatestRelease | null,
  dismissedVersion: string | null,
): AvailableUpdate | null {
  if (latest === null) {
    return null;
  }
  if (compareVersions(latest.version, currentVersion) <= 0) {
    return null;
  }
  if (latest.version === dismissedVersion) {
    return null;
  }
  return { version: latest.version, url: latest.url };
}

/**
 * The update slice of the broadcast state, attached by main on every
 * broadcast like `zoom` and `find`.
 */
export interface UpdateState {
  enabled: boolean;
  origin: InstallOrigin;
  available: AvailableUpdate | null;
  checking: boolean;
  lastCheckedAt: number | null;
  error: string | null;
}
