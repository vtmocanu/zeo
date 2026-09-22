import { describe, expect, test } from "vitest";
import {
  selectViewsToUnload,
  type UnloadCandidate,
} from "./view-unload.js";

/** A hidden, silent candidate — the shape that IS eligible for unload. */
function candidate(
  tabId: string,
  lastActiveAt: number,
  overrides: Partial<UnloadCandidate> = {},
): UnloadCandidate {
  return { tabId, lastActiveAt, visible: false, audible: false, ...overrides };
}

describe("selectViewsToUnload", () => {
  test("empty input returns an empty list", () => {
    expect(selectViewsToUnload([], 10_000, 100)).toEqual([]);
  });

  test("a visible candidate is never selected, even if silent and long idle", () => {
    const candidates = [candidate("t1", 0, { visible: true })];
    expect(selectViewsToUnload(candidates, 1_000_000, 100)).toEqual([]);
  });

  test("an audible candidate is never selected, even if hidden and long idle", () => {
    const candidates = [candidate("t1", 0, { audible: true })];
    expect(selectViewsToUnload(candidates, 1_000_000, 100)).toEqual([]);
  });

  test("idle exactly at the threshold is kept; one past it is selected", () => {
    const now = 1000;
    const maxIdleMs = 100;
    // now - lastActiveAt === maxIdleMs -> kept (strictly greater required).
    const atBoundary = candidate("at", now - maxIdleMs);
    expect(selectViewsToUnload([atBoundary], now, maxIdleMs)).toEqual([]);

    // now - lastActiveAt === maxIdleMs + 1 -> selected.
    const pastBoundary = candidate("past", now - maxIdleMs - 1);
    expect(selectViewsToUnload([pastBoundary], now, maxIdleMs)).toEqual([
      "past",
    ]);
  });

  test("input order is preserved in the returned ids", () => {
    const now = 10_000;
    const maxIdleMs = 100;
    const candidates = [
      candidate("t3", 0),
      candidate("t1", 0),
      candidate("t2", 0),
    ];
    expect(selectViewsToUnload(candidates, now, maxIdleMs)).toEqual([
      "t3",
      "t1",
      "t2",
    ]);
  });

  test("a negative maxIdleMs selects every hidden, silent candidate", () => {
    const now = 1000;
    const candidates = [
      candidate("hidden-silent", now),
      candidate("visible", now, { visible: true }),
      candidate("audible", now, { audible: true }),
    ];
    // Even a candidate active at `now` (idle age 0) beats a negative threshold,
    // but visible/audible ones are still exempt.
    expect(selectViewsToUnload(candidates, now, -1)).toEqual(["hidden-silent"]);
  });
});
