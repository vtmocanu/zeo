import { describe, expect, test } from "vitest";
import {
  CASKROOM_PATHS,
  compareVersions,
  installOrigin,
  parseLatestRelease,
  parseVersion,
  updateDecision,
} from "./update.js";

describe("parseVersion", () => {
  test("parses a version with a leading v", () => {
    expect(parseVersion("v0.0.21")).toEqual({
      major: 0,
      minor: 0,
      patch: 21,
      prerelease: null,
    });
  });

  test("parses a version without a leading v", () => {
    expect(parseVersion("0.0.21")).toEqual({
      major: 0,
      minor: 0,
      patch: 21,
      prerelease: null,
    });
  });

  test("parses a prerelease suffix", () => {
    expect(parseVersion("1.2.3-rc.1")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: "rc.1",
    });
  });

  test("rejects a version missing a component", () => {
    expect(parseVersion("1.2")).toBeNull();
  });

  test("rejects build metadata", () => {
    expect(parseVersion("1.2.3+meta")).toBeNull();
  });

  test("rejects a non-numeric string", () => {
    expect(parseVersion("latest")).toBeNull();
  });
});

describe("compareVersions", () => {
  test("compares numerically, not lexically", () => {
    expect(compareVersions("0.0.10", "0.0.9")).toBe(1);
  });

  test("a prerelease sorts below the same numbers without one", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
  });

  test("equal versions compare equal", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  test("an unparseable side is treated as 0.0.0", () => {
    expect(compareVersions("latest", "0.0.1")).toBe(-1);
    expect(compareVersions("0.0.0", "latest")).toBe(0);
  });
});

describe("parseLatestRelease", () => {
  const base = {
    tag_name: "v1.2.3",
    html_url: "https://example.com/releases/v1.2.3",
    published_at: "2026-01-01T00:00:00Z",
    draft: false,
    prerelease: false,
  };

  test("a full object returns a release", () => {
    expect(parseLatestRelease(base)).toEqual({
      kind: "release",
      release: {
        version: "1.2.3",
        url: "https://example.com/releases/v1.2.3",
        publishedAt: "2026-01-01T00:00:00Z",
      },
    });
  });

  test("a draft returns none", () => {
    expect(parseLatestRelease({ ...base, draft: true })).toEqual({
      kind: "none",
    });
  });

  test("a prerelease returns none", () => {
    expect(parseLatestRelease({ ...base, prerelease: true })).toEqual({
      kind: "none",
    });
  });

  test("a missing html_url returns malformed", () => {
    const { html_url: _htmlUrl, ...rest } = base;
    expect(parseLatestRelease(rest)).toEqual({ kind: "malformed" });
  });

  test("an unparseable tag_name returns malformed", () => {
    expect(parseLatestRelease({ ...base, tag_name: "latest" })).toEqual({
      kind: "malformed",
    });
  });

  test("a non-object returns malformed", () => {
    expect(parseLatestRelease(null)).toEqual({ kind: "malformed" });
    expect(parseLatestRelease("string")).toEqual({ kind: "malformed" });
    expect(parseLatestRelease(42)).toEqual({ kind: "malformed" });
  });
});

describe("installOrigin", () => {
  test("a probe true on the second default path returns homebrew", () => {
    const exists = (path: string): boolean => path === CASKROOM_PATHS[1];
    expect(installOrigin(exists)).toBe("homebrew");
  });

  test("all false returns direct", () => {
    expect(installOrigin(() => false)).toBe("direct");
  });

  test("custom paths are honored", () => {
    const exists = (path: string): boolean => path === "/custom/path";
    expect(installOrigin(() => false, ["/custom/path"])).toBe("direct");
    expect(installOrigin(exists, ["/custom/path"])).toBe("homebrew");
  });
});

describe("updateDecision", () => {
  const latest = {
    version: "2.0.0",
    url: "https://example.com/releases/v2.0.0",
    publishedAt: "2026-01-01T00:00:00Z",
  };

  test("a newer release returns the pair", () => {
    expect(updateDecision("1.0.0", latest, null)).toEqual({
      version: "2.0.0",
      url: "https://example.com/releases/v2.0.0",
    });
  });

  test("no release returns null", () => {
    expect(updateDecision("1.0.0", null, null)).toBeNull();
  });

  test("an equal version returns null", () => {
    expect(updateDecision("2.0.0", latest, null)).toBeNull();
  });

  test("an older release returns null", () => {
    expect(updateDecision("3.0.0", latest, null)).toBeNull();
  });

  test("a dismissed version returns null", () => {
    expect(updateDecision("1.0.0", latest, "2.0.0")).toBeNull();
  });

  test("a newer-than-dismissed version returns the pair", () => {
    expect(updateDecision("1.0.0", latest, "1.5.0")).toEqual({
      version: "2.0.0",
      url: "https://example.com/releases/v2.0.0",
    });
  });
});
