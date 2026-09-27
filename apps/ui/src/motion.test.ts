import { describe, expect, test } from "vitest";
import { enterStep, parseDurationMs, replayClass } from "./motion.js";

describe("parseDurationMs (PRD 10.7 §3, §10)", () => {
  test.each([
    ["320ms", 320],
    ["0.12s", 120],
    ["", 0],
  ])("%s -> %i", (value, expected) => {
    expect(parseDurationMs(value)).toBe(expected);
  });
});

describe("enterStep", () => {
  test.each([
    [null, true, "replay"],
    [false, true, "replay"],
    [true, true, "none"],
    [false, false, "none"],
    [true, false, "close"],
  ] as const)("(%s, %s) -> %s", (previousOpen, open, expected) => {
    expect(enterStep(previousOpen, open)).toBe(expected);
  });
});

describe("replayClass", () => {
  test("removes the class, reads offsetWidth once, and re-adds it", () => {
    const calls: string[] = [];
    let widthReads = 0;
    const classes = new Set(["motion-enter"]);
    const element = {
      classList: {
        remove: (name: string) => {
          calls.push(`remove:${name}`);
          classes.delete(name);
        },
        add: (name: string) => {
          calls.push(`add:${name}`);
          classes.add(name);
        },
      },
      get offsetWidth() {
        widthReads += 1;
        calls.push("offsetWidth");
        return 42;
      },
    } as unknown as HTMLElement;

    replayClass(element, "motion-enter");

    expect(calls).toEqual(["remove:motion-enter", "offsetWidth", "add:motion-enter"]);
    expect(widthReads).toBe(1);
    expect(classes.has("motion-enter")).toBe(true);
  });
});
