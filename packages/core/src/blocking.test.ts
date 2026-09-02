import { describe, expect, test } from "vitest";
import {
  applyBlockedRequest,
  resetBlockedCount,
  dropBlockedTab,
  initialBlockingState,
} from "./blocking.js";

describe("initialBlockingState", () => {
  test("returns the empty shape with the given enabled flag and list version", () => {
    expect(initialBlockingState(true, "v1")).toEqual({
      enabled: true,
      listVersion: "v1",
      blockedByTab: {},
      blockedUnattributed: 0,
    });
    expect(initialBlockingState(false, "v2")).toEqual({
      enabled: false,
      listVersion: "v2",
      blockedByTab: {},
      blockedUnattributed: 0,
    });
  });
});

describe("applyBlockedRequest", () => {
  test("increments from absent to 1 and from 1 to 2", () => {
    const s0 = initialBlockingState(true, "v1");
    const s1 = applyBlockedRequest(s0, "a");
    expect(s1.blockedByTab).toEqual({ a: 1 });
    const s2 = applyBlockedRequest(s1, "a");
    expect(s2.blockedByTab).toEqual({ a: 2 });
  });

  test("does not mutate the input and returns a new reference", () => {
    const s0 = initialBlockingState(true, "v1");
    const s1 = applyBlockedRequest(s0, "a");
    expect(s1).not.toBe(s0);
    expect(s1.blockedByTab).not.toBe(s0.blockedByTab);
    // input untouched
    expect(s0.blockedByTab).toEqual({});
  });
});

describe("resetBlockedCount", () => {
  test("removes the key so the count is gone", () => {
    const s0 = applyBlockedRequest(initialBlockingState(true, "v1"), "a");
    const s1 = resetBlockedCount(s0, "a");
    expect("a" in s1.blockedByTab).toBe(false);
    expect(s1.blockedByTab).toEqual({});
    // input untouched
    expect(s0.blockedByTab).toEqual({ a: 1 });
  });

  test("is a no-op returning the same reference when the key is absent", () => {
    const s0 = initialBlockingState(true, "v1");
    expect(resetBlockedCount(s0, "ghost")).toBe(s0);
  });
});

describe("dropBlockedTab", () => {
  test("removes an existing entry", () => {
    let s = applyBlockedRequest(initialBlockingState(true, "v1"), "a");
    s = applyBlockedRequest(s, "b");
    const dropped = dropBlockedTab(s, "a");
    expect(dropped.blockedByTab).toEqual({ b: 1 });
  });

  test("is a no-op returning the same reference when absent", () => {
    const s0 = initialBlockingState(true, "v1");
    expect(dropBlockedTab(s0, "ghost")).toBe(s0);
  });
});
