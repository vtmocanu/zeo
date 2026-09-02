import { describe, expect, it } from "vitest";
import { resolveInput, DEFAULT_SEARCH_ENGINE } from "./resolve-input.js";

describe("resolveInput", () => {
  it("returns null for empty input", () => {
    expect(resolveInput("")).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(resolveInput("   ")).toBeNull();
  });

  it("trims surrounding whitespace before resolving a host", () => {
    expect(resolveInput("  example.com  ")).toEqual({
      kind: "url",
      url: "https://example.com/",
    });
  });

  it("treats a bare word as a search", () => {
    expect(resolveInput("zeo")).toEqual({
      kind: "search",
      url: DEFAULT_SEARCH_ENGINE + encodeURIComponent("zeo"),
    });
  });

  it("treats a trailing-dot token as a search (last label invalid)", () => {
    expect(resolveInput("done.")).toEqual({
      kind: "search",
      url: DEFAULT_SEARCH_ENGINE + encodeURIComponent("done."),
    });
  });

  it("treats input with whitespace as a search even if it embeds a host", () => {
    expect(resolveInput("what is example.com")).toEqual({
      kind: "search",
      url: DEFAULT_SEARCH_ENGINE + encodeURIComponent("what is example.com"),
    });
  });

  it("keeps port, path, query, and fragment on a host candidate", () => {
    expect(resolveInput("example.com:8080/path?q=1#frag")).toEqual({
      kind: "url",
      url: "https://example.com:8080/path?q=1#frag",
    });
  });

  it("uses http:// for localhost with a port", () => {
    expect(resolveInput("localhost:3000")).toEqual({
      kind: "url",
      url: "http://localhost:3000/",
    });
  });

  it("canonicalizes an explicit https scheme and lowercases the host", () => {
    expect(resolveInput("HTTPS://Example.COM")).toEqual({
      kind: "url",
      url: "https://example.com/",
    });
  });

  it("treats a file: scheme as a search", () => {
    expect(resolveInput("file:///etc/hosts")).toEqual({
      kind: "search",
      url: DEFAULT_SEARCH_ENGINE + encodeURIComponent("file:///etc/hosts"),
    });
  });

  it("treats an about: scheme as a search", () => {
    expect(resolveInput("about:blank")).toEqual({
      kind: "search",
      url: DEFAULT_SEARCH_ENGINE + encodeURIComponent("about:blank"),
    });
  });

  it("uses http:// for an IPv4 literal", () => {
    expect(resolveInput("192.168.1.10")).toEqual({
      kind: "url",
      url: "http://192.168.1.10/",
    });
  });

  it("treats an out-of-range IPv4 as a search (octet > 255, numeric last label)", () => {
    expect(resolveInput("999.1.1.1")).toEqual({
      kind: "search",
      url: DEFAULT_SEARCH_ENGINE + encodeURIComponent("999.1.1.1"),
    });
  });

  it("canonicalizes a plain http url", () => {
    expect(resolveInput("http://example.com")).toEqual({
      kind: "url",
      url: "http://example.com/",
    });
  });

  it("canonicalizes an https url whose path contains a space", () => {
    expect(resolveInput("https://example.com/a b")).toEqual({
      kind: "url",
      url: "https://example.com/a%20b",
    });
  });
});
