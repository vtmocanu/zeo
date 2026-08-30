import { describe, expect, it } from "vitest";
import { titleForUrl } from "./tab-title.js";

describe("titleForUrl", () => {
  it("returns the hostname for a well-formed url", () => {
    expect(titleForUrl("https://example.com/path?q=1")).toBe("example.com");
  });

  it("keeps subdomains", () => {
    expect(titleForUrl("https://docs.example.com")).toBe("docs.example.com");
  });

  it("falls back to the raw string for an invalid url", () => {
    expect(titleForUrl("not a url")).toBe("not a url");
  });

  it("falls back to the raw url when the hostname is empty", () => {
    expect(titleForUrl("about:blank")).toBe("about:blank");
  });

  it("handles file urls with empty hostname", () => {
    expect(titleForUrl("file:///tmp/x.html")).toBe("file:///tmp/x.html");
  });
});
