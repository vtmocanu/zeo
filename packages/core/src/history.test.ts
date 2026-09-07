import { describe, expect, test } from "vitest";
import {
  isHistoryUrl,
  historyKey,
  historyTerms,
  HISTORY_RETENTION_MS,
} from "./history.js";

describe("isHistoryUrl", () => {
  test("accepts http and https urls", () => {
    expect(isHistoryUrl("http://a.com")).toBe(true);
    expect(isHistoryUrl("https://a.com/p?q=1")).toBe(true);
  });

  test("rejects non-http(s) protocols", () => {
    expect(isHistoryUrl("ftp://a.com")).toBe(false);
    expect(isHistoryUrl("data:text/plain,hi")).toBe(false);
    expect(isHistoryUrl("about:blank")).toBe(false);
    expect(isHistoryUrl("file:///x")).toBe(false);
  });

  test("rejects a url carrying credentials", () => {
    expect(isHistoryUrl("https://user:pass@a.com")).toBe(false);
    expect(isHistoryUrl("https://user@a.com")).toBe(false);
  });

  test("rejects a url longer than 2048 characters", () => {
    const longUrl = `https://a.com/${"x".repeat(2048)}`;
    expect(longUrl.length).toBeGreaterThan(2048);
    expect(isHistoryUrl(longUrl)).toBe(false);
  });

  test("rejects an unparseable url", () => {
    expect(isHistoryUrl("not a url")).toBe(false);
    expect(isHistoryUrl("")).toBe(false);
  });
});

describe("historyKey", () => {
  test("strips the fragment but keeps the query string", () => {
    expect(historyKey("https://a.com/p?q=1#x")).toBe("https://a.com/p?q=1");
  });

  test("leaves a fragmentless url unchanged", () => {
    expect(historyKey("https://a.com/p?q=1")).toBe("https://a.com/p?q=1");
  });
});

describe("historyTerms", () => {
  test("lowercases, splits on whitespace, and drops empties", () => {
    expect(historyTerms(" Foo  BAR ")).toEqual(["foo", "bar"]);
  });

  test("an empty (or whitespace-only) query yields no terms", () => {
    expect(historyTerms("")).toEqual([]);
    expect(historyTerms("   ")).toEqual([]);
  });
});

describe("HISTORY_RETENTION_MS", () => {
  test("is 90 days in milliseconds", () => {
    expect(HISTORY_RETENTION_MS).toBe(90 * 24 * 60 * 60 * 1000);
  });
});
