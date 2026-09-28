import { describe, expect, test } from "vitest";
import {
  MOTION_FAST_MS,
  MOTION_BASE_MS,
  MOTION_SPACE_MS,
  MOTION_REDUCED_MS,
  EASE_STANDARD,
  ENTER_SCALE_FROM,
  SPACE_SHIFT_PX,
  PRESS_SCALE,
  detectSpaceSwitch,
} from "./motion.js";

describe("motion constants", () => {
  test("match design book §7", () => {
    expect(MOTION_FAST_MS).toBe(120);
    expect(MOTION_BASE_MS).toBe(200);
    expect(MOTION_SPACE_MS).toBe(320);
    expect(MOTION_REDUCED_MS).toBe(120);
    expect(EASE_STANDARD).toBe("cubic-bezier(.2, .8, .2, 1)");
    expect(ENTER_SCALE_FROM).toBe(0.97);
    expect(SPACE_SHIFT_PX).toBe(28);
    expect(PRESS_SCALE).toBe(0.96);
  });
});

describe("detectSpaceSwitch", () => {
  test("null when previous id is empty (before first broadcast)", () => {
    expect(detectSpaceSwitch("", "a", ["a"])).toBeNull();
  });

  test("null when ids are equal", () => {
    expect(detectSpaceSwitch("a", "a", ["a", "b"])).toBeNull();
  });

  test("null when next id is not in spaceIds", () => {
    expect(detectSpaceSwitch("a", "z", ["a", "b"])).toBeNull();
  });

  test("forward when next index is greater", () => {
    expect(detectSpaceSwitch("a", "b", ["a", "b"])).toEqual({
      from: "a",
      to: "b",
      direction: "forward",
    });
  });

  test("backward when next index is smaller", () => {
    expect(detectSpaceSwitch("b", "a", ["a", "b"])).toEqual({
      from: "b",
      to: "a",
      direction: "backward",
    });
  });

  test("direction is null when previous id is no longer listed (active space deleted)", () => {
    expect(detectSpaceSwitch("x", "a", ["a", "b"])).toEqual({
      from: "x",
      to: "a",
      direction: null,
    });
  });
});
