import { describe, expect, test } from "vitest";
import type { SpaceTheme } from "@zeo/core";
import {
  enterStep,
  outgoingTintDecision,
  parseDurationMs,
  replayClass,
  replaySpaceMotion,
} from "./motion.js";

const iris: SpaceTheme = { stops: ["iris"], intensity: 1 };
const rose: SpaceTheme = { stops: ["rose"], intensity: 1 };

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

function fakeSpaceElement() {
  const classes = new Set<string>();
  const element = {
    classList: {
      remove: (name: string) => classes.delete(name),
      add: (name: string) => classes.add(name),
      contains: (name: string) => classes.has(name),
    },
    get offsetWidth() {
      return 42;
    },
  } as unknown as HTMLElement;
  return { element, classes };
}

describe("replaySpaceMotion (direction classes must not pile up)", () => {
  test("forward -> backward -> forward leaves exactly the current class", () => {
    const { element, classes } = fakeSpaceElement();

    replaySpaceMotion(element, "sidebar__space--enter-forward");
    expect([...classes]).toEqual(["sidebar__space--enter-forward"]);

    replaySpaceMotion(element, "sidebar__space--enter-backward");
    expect([...classes]).toEqual(["sidebar__space--enter-backward"]);

    replaySpaceMotion(element, "sidebar__space--enter-forward");
    expect([...classes]).toEqual(["sidebar__space--enter-forward"]);
  });

  test("fade -> forward leaves only forward", () => {
    const { element, classes } = fakeSpaceElement();

    replaySpaceMotion(element, "sidebar__space--enter-fade");
    expect([...classes]).toEqual(["sidebar__space--enter-fade"]);

    replaySpaceMotion(element, "sidebar__space--enter-forward");
    expect([...classes]).toEqual(["sidebar__space--enter-forward"]);
  });
});

describe("outgoingTintDecision (compares the theme actually on screen)", () => {
  test("null -> null: no tint change, nothing to fade", () => {
    expect(outgoingTintDecision(null, null, "light")).toBeNull();
  });

  test("same theme (by value): nothing to fade even with different object identity", () => {
    const irisAgain: SpaceTheme = { stops: ["iris"], intensity: 1 };
    expect(outgoingTintDecision(iris, irisAgain, "light")).toBeNull();
  });

  test("outgoingTintDecision paints the theme it is given as previous (the caller keeps it fresh)", () => {
    // The active space started iris, was edited to rose (still the active
    // space, no switch), then the user switched away. The caller is
    // responsible for refreshing "previous" to rose on the edit commit; once
    // it has, the outgoing tint must be rose's, not iris's.
    const refreshedPrevious = rose;
    const next: SpaceTheme = { stops: ["teal"], intensity: 1 };
    const decision = outgoingTintDecision(refreshedPrevious, next, "light");
    expect(decision).not.toBeNull();
    expect(decision?.tint).not.toBe(
      outgoingTintDecision(iris, next, "light")?.tint,
    );
  });
});
