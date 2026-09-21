import { describe, expect, test } from "vitest";
import {
  openQuickBrowse,
  replaceQuickBrowseUrl,
  setQuickBrowseUrl,
  setQuickBrowseTitle,
  promoteQuickBrowse,
  dismissQuickBrowse,
  type QuickBrowse,
} from "./quick-browse.js";

describe("openQuickBrowse", () => {
  test("builds the url with a fallback title from the host", () => {
    expect(openQuickBrowse("https://example.com/path")).toEqual({
      url: "https://example.com/path",
      title: "example.com",
    });
  });

  test("falls back to the raw url when it does not parse", () => {
    expect(openQuickBrowse("not a url")).toEqual({
      url: "not a url",
      title: "not a url",
    });
  });

  test("ignores any prior state — opening always starts fresh", () => {
    expect(openQuickBrowse("https://b.com/")).toEqual({
      url: "https://b.com/",
      title: "b.com",
    });
  });
});

describe("replaceQuickBrowseUrl", () => {
  test("updates the url and resets the title from an open state", () => {
    const s0: QuickBrowse = { url: "https://a.com/", title: "A Custom Title" };
    expect(replaceQuickBrowseUrl(s0, "https://b.com/page")).toEqual({
      url: "https://b.com/page",
      title: "b.com",
    });
  });

  test("throws when no window is open", () => {
    expect(() => replaceQuickBrowseUrl(null, "https://b.com/")).toThrow();
  });
});

describe("setQuickBrowseUrl", () => {
  test("tracks a new url and re-derives the fallback title", () => {
    const s0: QuickBrowse = { url: "https://a.com/", title: "A Custom Title" };
    expect(setQuickBrowseUrl(s0, "https://b.com/deep/path")).toEqual({
      url: "https://b.com/deep/path",
      title: "b.com",
    });
  });

  test("throws when no window is open", () => {
    expect(() => setQuickBrowseUrl(null, "https://b.com/")).toThrow();
  });
});

describe("setQuickBrowseTitle", () => {
  test("updates the title when the url matches", () => {
    const s0: QuickBrowse = { url: "https://a.com/", title: "a.com" };
    expect(setQuickBrowseTitle(s0, "https://a.com/", "Real Title")).toEqual({
      url: "https://a.com/",
      title: "Real Title",
    });
  });

  test("is a no-op when the url does not match (a raced title event)", () => {
    const s0: QuickBrowse = { url: "https://a.com/", title: "a.com" };
    const s1 = setQuickBrowseTitle(s0, "https://other.com/", "Stale Title");
    expect(s1).toBe(s0);
  });

  test("is a no-op on null (a title event after dismissal)", () => {
    expect(setQuickBrowseTitle(null, "https://a.com/", "Late Title")).toBeNull();
  });
});

describe("promoteQuickBrowse", () => {
  test("returns the current entry from an open state", () => {
    const s0: QuickBrowse = { url: "https://a.com/", title: "Real Title" };
    expect(promoteQuickBrowse(s0)).toEqual({
      url: "https://a.com/",
      title: "Real Title",
    });
  });

  test("throws when no window is open", () => {
    expect(() => promoteQuickBrowse(null)).toThrow();
  });
});

describe("dismissQuickBrowse", () => {
  test("returns null from an open state", () => {
    const s0: QuickBrowse = { url: "https://a.com/", title: "a.com" };
    expect(dismissQuickBrowse(s0)).toBeNull();
  });

  test("returns null from null (idempotent)", () => {
    expect(dismissQuickBrowse(null)).toBeNull();
  });
});

describe("every transition leaves its input object unmodified", () => {
  test("no reducer mutates the frozen entry it is handed", () => {
    const frozen: QuickBrowse = Object.freeze({
      url: "https://a.com/",
      title: "Frozen Title",
    });

    // A mutation of a frozen object would throw in strict mode; each returns a
    // fresh value (or the input reference) without touching the input.
    replaceQuickBrowseUrl(frozen, "https://b.com/");
    setQuickBrowseUrl(frozen, "https://b.com/");
    setQuickBrowseTitle(frozen, "https://a.com/", "New Title");
    setQuickBrowseTitle(frozen, "https://other.com/", "New Title");
    promoteQuickBrowse(frozen);
    dismissQuickBrowse(frozen);

    expect(frozen).toEqual({ url: "https://a.com/", title: "Frozen Title" });
  });
});
