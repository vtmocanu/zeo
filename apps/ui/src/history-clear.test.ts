import { describe, expect, test } from "vitest";
import {
  historyClearDialogBody,
  historyClearTriggerDisabled,
  historyStatsText,
} from "./history-clear.js";

describe("historyStatsText", () => {
  test("reports the real counts once loaded", () => {
    expect(historyStatsText("loaded", { entries: 2, visits: 5 })).toBe("2 entries · 5 visits");
    expect(historyStatsText("loaded", { entries: 0, visits: 0 })).toBe("0 entries · 0 visits");
  });

  test("falls back to a neutral placeholder while loading", () => {
    expect(historyStatsText("loading", null)).toBe("Loading…");
  });

  test("reports a short unavailable message on failure, never stale counts", () => {
    expect(historyStatsText("failed", null)).toBe("History stats unavailable");
    // Defensive: even if a stale value lingered, a failed status wins.
    expect(historyStatsText("failed", { entries: 2, visits: 5 })).toBe("History stats unavailable");
  });

  test("falls back to loading text if loaded is reported with no stats", () => {
    expect(historyStatsText("loaded", null)).toBe("Loading…");
  });
});

describe("historyClearDialogBody", () => {
  test("quotes the counts once loaded", () => {
    expect(historyClearDialogBody("loaded", { entries: 2, visits: 5 })).toBe(
      "This removes 2 entries and 5 visits. It cannot be undone.",
    );
  });

  test("uses count-free wording when stats failed to load", () => {
    expect(historyClearDialogBody("failed", null)).toBe(
      "This removes all browsing history. It cannot be undone.",
    );
  });

  test("uses count-free wording defensively when loading or stats are missing", () => {
    expect(historyClearDialogBody("loading", null)).toBe(
      "This removes all browsing history. It cannot be undone.",
    );
    expect(historyClearDialogBody("loaded", null)).toBe(
      "This removes all browsing history. It cannot be undone.",
    );
  });
});

describe("historyClearTriggerDisabled", () => {
  test("disabled only while loading", () => {
    expect(historyClearTriggerDisabled("loading")).toBe(true);
    expect(historyClearTriggerDisabled("loaded")).toBe(false);
    expect(historyClearTriggerDisabled("failed")).toBe(false);
  });
});
