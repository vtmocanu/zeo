import { describe, expect, it } from "vitest";
import { resolveInput } from "./resolve-input.js";
import { DEFAULT_SEARCH_ENGINE_ID, searchUrl } from "./settings.js";

describe("resolveInput", () => {
  it("returns null for empty input", () => {
    expect(resolveInput("", DEFAULT_SEARCH_ENGINE_ID)).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(resolveInput("   ", DEFAULT_SEARCH_ENGINE_ID)).toBeNull();
  });

  it("trims surrounding whitespace before resolving a host", () => {
    expect(resolveInput("  example.com  ", DEFAULT_SEARCH_ENGINE_ID)).toEqual({
      kind: "url",
      url: "https://example.com/",
    });
  });

  it("treats a bare word as a search", () => {
    expect(resolveInput("zeo", DEFAULT_SEARCH_ENGINE_ID)).toEqual({
      kind: "search",
      url: searchUrl(DEFAULT_SEARCH_ENGINE_ID, "zeo"),
    });
  });

  it("treats a trailing-dot token as a search (last label invalid)", () => {
    expect(resolveInput("done.", DEFAULT_SEARCH_ENGINE_ID)).toEqual({
      kind: "search",
      url: searchUrl(DEFAULT_SEARCH_ENGINE_ID, "done."),
    });
  });

  it("treats input with whitespace as a search even if it embeds a host", () => {
    expect(resolveInput("what is example.com", DEFAULT_SEARCH_ENGINE_ID)).toEqual({
      kind: "search",
      url: searchUrl(DEFAULT_SEARCH_ENGINE_ID, "what is example.com"),
    });
  });

  it("keeps port, path, query, and fragment on a host candidate", () => {
    expect(resolveInput("example.com:8080/path?q=1#frag", DEFAULT_SEARCH_ENGINE_ID)).toEqual({
      kind: "url",
      url: "https://example.com:8080/path?q=1#frag",
    });
  });

  it("uses http:// for localhost with a port", () => {
    expect(resolveInput("localhost:3000", DEFAULT_SEARCH_ENGINE_ID)).toEqual({
      kind: "url",
      url: "http://localhost:3000/",
    });
  });

  it("canonicalizes an explicit https scheme and lowercases the host", () => {
    expect(resolveInput("HTTPS://Example.COM", DEFAULT_SEARCH_ENGINE_ID)).toEqual({
      kind: "url",
      url: "https://example.com/",
    });
  });

  it("treats a file: scheme as a search", () => {
    expect(resolveInput("file:///etc/hosts", DEFAULT_SEARCH_ENGINE_ID)).toEqual({
      kind: "search",
      url: searchUrl(DEFAULT_SEARCH_ENGINE_ID, "file:///etc/hosts"),
    });
  });

  it("treats an about: scheme as a search", () => {
    expect(resolveInput("about:blank", DEFAULT_SEARCH_ENGINE_ID)).toEqual({
      kind: "search",
      url: searchUrl(DEFAULT_SEARCH_ENGINE_ID, "about:blank"),
    });
  });

  it("uses http:// for an IPv4 literal", () => {
    expect(resolveInput("192.168.1.10", DEFAULT_SEARCH_ENGINE_ID)).toEqual({
      kind: "url",
      url: "http://192.168.1.10/",
    });
  });

  it("treats an out-of-range IPv4 as a search (octet > 255, numeric last label)", () => {
    expect(resolveInput("999.1.1.1", DEFAULT_SEARCH_ENGINE_ID)).toEqual({
      kind: "search",
      url: searchUrl(DEFAULT_SEARCH_ENGINE_ID, "999.1.1.1"),
    });
  });

  it("canonicalizes a plain http url", () => {
    expect(resolveInput("http://example.com", DEFAULT_SEARCH_ENGINE_ID)).toEqual({
      kind: "url",
      url: "http://example.com/",
    });
  });

  it("canonicalizes an https url whose path contains a space", () => {
    expect(resolveInput("https://example.com/a b", DEFAULT_SEARCH_ENGINE_ID)).toEqual({
      kind: "url",
      url: "https://example.com/a%20b",
    });
  });

  it("builds a search target from a non-default engine, URL-encoded", () => {
    const target = resolveInput("some query", "google");
    expect(target).toEqual({
      kind: "search",
      url: "https://www.google.com/search?q=some%20query",
    });
    expect(target?.url.startsWith("https://www.google.com/search?q=")).toBe(true);
  });

  it("still resolves a URL input to a url target regardless of engine", () => {
    expect(resolveInput("http://example.com", "google")).toEqual({
      kind: "url",
      url: "http://example.com/",
    });
  });
});
