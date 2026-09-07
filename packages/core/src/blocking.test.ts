import { describe, expect, test } from "vitest";
import {
  applyBlockedRequest,
  applyUnattributedBlock,
  resetBlockedCount,
  dropBlockedTab,
  initialBlockingState,
  addAllowlistHost,
  removeAllowlistHost,
} from "./blocking.js";

describe("initialBlockingState", () => {
  test("returns the empty shape with the given enabled flag and list version", () => {
    expect(initialBlockingState(true, "v1")).toEqual({
      enabled: true,
      listVersion: "v1",
      blockedByTab: {},
      blockedUnattributed: 0,
      allowlist: [],
    });
    expect(initialBlockingState(false, "v2")).toEqual({
      enabled: false,
      listVersion: "v2",
      blockedByTab: {},
      blockedUnattributed: 0,
      allowlist: [],
    });
  });

  test("defaults the allowlist to an empty array", () => {
    expect(initialBlockingState(true, "v1").allowlist).toEqual([]);
  });

  test("normalizes the passed allowlist to sorted + deduplicated", () => {
    expect(
      initialBlockingState(true, "v1", ["b.com", "a.com", "b.com"]).allowlist,
    ).toEqual(["a.com", "b.com"]);
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

describe("applyUnattributedBlock", () => {
  test("increments blockedUnattributed from 0 to 1 to 2", () => {
    const s0 = initialBlockingState(true, "v1");
    const s1 = applyUnattributedBlock(s0);
    expect(s1.blockedUnattributed).toBe(1);
    const s2 = applyUnattributedBlock(s1);
    expect(s2.blockedUnattributed).toBe(2);
  });

  test("does not mutate the input and leaves per-tab counts alone", () => {
    const s0 = applyBlockedRequest(initialBlockingState(true, "v1"), "a");
    const s1 = applyUnattributedBlock(s0);
    expect(s1).not.toBe(s0);
    expect(s0.blockedUnattributed).toBe(0);
    expect(s1.blockedByTab).toEqual({ a: 1 });
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

describe("addAllowlistHost", () => {
  test("inserts keeping sorted order with no duplicates", () => {
    const s0 = initialBlockingState(true, "v1", ["b.com"]);
    const s1 = addAllowlistHost(s0, "a.com");
    expect(s1.allowlist).toEqual(["a.com", "b.com"]);
    const s2 = addAllowlistHost(s1, "c.com");
    expect(s2.allowlist).toEqual(["a.com", "b.com", "c.com"]);
  });

  test("returns the same reference when the host is already present", () => {
    const s0 = initialBlockingState(true, "v1", ["a.com"]);
    expect(addAllowlistHost(s0, "a.com")).toBe(s0);
  });

  test("does not mutate the input and leaves blocked counts alone", () => {
    const s0 = applyBlockedRequest(initialBlockingState(true, "v1"), "a");
    const s1 = addAllowlistHost(s0, "a.com");
    expect(s1).not.toBe(s0);
    expect(s0.allowlist).toEqual([]);
    expect(s1.blockedByTab).toEqual({ a: 1 });
  });
});

describe("removeAllowlistHost", () => {
  test("removes an existing host and keeps the rest sorted", () => {
    const s0 = initialBlockingState(true, "v1", ["a.com", "b.com"]);
    const s1 = removeAllowlistHost(s0, "a.com");
    expect(s1.allowlist).toEqual(["b.com"]);
  });

  test("returns the same reference when the host is absent", () => {
    const s0 = initialBlockingState(true, "v1", ["a.com"]);
    expect(removeAllowlistHost(s0, "ghost.com")).toBe(s0);
  });

  test("does not mutate the input and leaves blocked counts alone", () => {
    const s0 = applyBlockedRequest(
      initialBlockingState(true, "v1", ["a.com"]),
      "a",
    );
    const s1 = removeAllowlistHost(s0, "a.com");
    expect(s1).not.toBe(s0);
    expect(s0.allowlist).toEqual(["a.com"]);
    expect(s1.blockedByTab).toEqual({ a: 1 });
  });
});
