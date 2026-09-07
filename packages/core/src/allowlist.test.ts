import { describe, expect, test } from "vitest";
import {
  siteKeyForUrl,
  normalizeAllowlistHost,
  hostMatchesAllowlist,
} from "./allowlist.js";

describe("siteKeyForUrl", () => {
  test("returns the lowercased hostname for http(s) urls", () => {
    expect(siteKeyForUrl("http://example.com/path")).toBe("example.com");
    expect(siteKeyForUrl("https://EXAMPLE.com/x?y#z")).toBe("example.com");
    expect(siteKeyForUrl("https://Sub.Example.COM")).toBe("sub.example.com");
  });

  test("returns null for non-http(s) schemes and unparsable input", () => {
    expect(siteKeyForUrl("about:blank")).toBeNull();
    expect(siteKeyForUrl("file:///tmp/x.html")).toBeNull();
    expect(siteKeyForUrl("data:text/html,hi")).toBeNull();
    expect(siteKeyForUrl("chrome://settings")).toBeNull();
    expect(siteKeyForUrl("not a url")).toBeNull();
  });
});

describe("normalizeAllowlistHost", () => {
  const valid: [string, string][] = [
    ["example.com", "example.com"],
    ["EXAMPLE.com", "example.com"],
    ["*.example.com", "example.com"],
    ["https://example.com/path?x#y", "example.com"],
    ["example.com.", "example.com"],
    ["127.0.0.1", "127.0.0.1"],
    ["[::1]", "[::1]"],
  ];

  for (const [input, expected] of valid) {
    test(`normalizes ${JSON.stringify(input)} to ${expected}`, () => {
      expect(normalizeAllowlistHost(input)).toBe(expected);
    });
  }

  const invalid = [
    "",
    "exa mple.com",
    "evil.com@good.com",
    "example.com:8080",
    "exämple.com",
    "127.1",
  ];

  for (const input of invalid) {
    test(`rejects ${JSON.stringify(input)}`, () => {
      expect(normalizeAllowlistHost(input)).toBeNull();
    });
  }
});

describe("hostMatchesAllowlist", () => {
  test("matches an entry, its subdomains, but not a superstring host", () => {
    const entries = ["example.com"];
    expect(hostMatchesAllowlist("example.com", entries)).toBe(true);
    expect(hostMatchesAllowlist("www.example.com", entries)).toBe(true);
    expect(hostMatchesAllowlist("a.b.example.com", entries)).toBe(true);
    expect(hostMatchesAllowlist("notexample.com", entries)).toBe(false);
  });

  test("an IPv4 literal entry matches only the identical host", () => {
    const entries = ["127.0.0.1"];
    expect(hostMatchesAllowlist("127.0.0.1", entries)).toBe(true);
    expect(hostMatchesAllowlist("foo.127.0.0.1", entries)).toBe(false);
  });

  test("a bracketed IPv6 literal entry matches only itself", () => {
    const entries = ["[::1]"];
    expect(hostMatchesAllowlist("[::1]", entries)).toBe(true);
    expect(hostMatchesAllowlist("foo.[::1]", entries)).toBe(false);
  });

  test("returns false with no entries", () => {
    expect(hostMatchesAllowlist("example.com", [])).toBe(false);
  });
});
