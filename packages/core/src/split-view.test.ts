import { describe, expect, it } from "vitest";
import {
  clampRatio,
  enterSplit,
  unsplit,
  swapPanes,
  setRatio,
  focusOtherPane,
  reconcileLayout,
  focusedPaneTab,
  paneOf,
  SINGLE_LAYOUT,
  DEFAULT_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
} from "./split-view.js";
import type { SplitLayout, WindowLayout } from "./split-view.js";

/** A frozen split layout so any mutation attempt by a reducer throws. */
function split(over: Partial<SplitLayout> = {}): SplitLayout {
  const layout: SplitLayout = {
    mode: "split",
    left: "L",
    right: "R",
    ratio: DEFAULT_SPLIT_RATIO,
    focused: "left",
    ...over,
  };
  return Object.freeze(layout);
}

describe("clampRatio", () => {
  it("passes an in-range ratio through unchanged", () => {
    expect(clampRatio(0.5)).toBe(0.5);
  });

  it("clamps a below-min ratio up to MIN_SPLIT_RATIO", () => {
    expect(clampRatio(0.1)).toBe(MIN_SPLIT_RATIO);
    expect(MIN_SPLIT_RATIO).toBe(0.2);
  });

  it("clamps an above-max ratio down to MAX_SPLIT_RATIO", () => {
    expect(clampRatio(0.95)).toBe(MAX_SPLIT_RATIO);
    expect(MAX_SPLIT_RATIO).toBe(0.8);
  });

  it("returns the default for NaN", () => {
    expect(clampRatio(NaN)).toBe(DEFAULT_SPLIT_RATIO);
  });

  it("returns the default for Infinity", () => {
    expect(clampRatio(Infinity)).toBe(DEFAULT_SPLIT_RATIO);
    expect(clampRatio(-Infinity)).toBe(DEFAULT_SPLIT_RATIO);
  });
});

describe("enterSplit", () => {
  it("splits distinct ids with the active tab on the left, focused left, default ratio", () => {
    expect(enterSplit("a", "b")).toEqual({
      mode: "split",
      left: "a",
      right: "b",
      ratio: DEFAULT_SPLIT_RATIO,
      focused: "left",
    });
  });

  it("returns single when the two ids are identical", () => {
    expect(enterSplit("a", "a")).toEqual(SINGLE_LAYOUT);
  });
});

describe("unsplit", () => {
  it("returns single from a split", () => {
    expect(unsplit(split())).toEqual(SINGLE_LAYOUT);
  });

  it("returns single from a single", () => {
    expect(unsplit(SINGLE_LAYOUT)).toEqual(SINGLE_LAYOUT);
  });
});

describe("swapPanes", () => {
  it("swaps left/right and flips focus so the same tab stays focused, ratio preserved", () => {
    const before = split({ left: "L", right: "R", ratio: 0.3, focused: "left" });
    const after = swapPanes(before);
    expect(after).toEqual({
      mode: "split",
      left: "R",
      right: "L",
      ratio: 0.3,
      focused: "right",
    });
    // The focused tab id is unchanged across the swap.
    expect(focusedPaneTab(before)).toBe("L");
    expect(focusedPaneTab(after)).toBe("L");
  });

  it("returns the input unchanged for a single layout", () => {
    expect(swapPanes(SINGLE_LAYOUT)).toBe(SINGLE_LAYOUT);
  });
});

describe("setRatio", () => {
  it("clamps the ratio in a split", () => {
    expect(setRatio(split(), 0.95)).toMatchObject({ ratio: MAX_SPLIT_RATIO });
    expect(setRatio(split(), 0.1)).toMatchObject({ ratio: MIN_SPLIT_RATIO });
    expect(setRatio(split(), NaN)).toMatchObject({ ratio: DEFAULT_SPLIT_RATIO });
    expect(setRatio(split({ ratio: 0.5 }), 0.65)).toMatchObject({ ratio: 0.65 });
  });

  it("is a no-op for a single layout", () => {
    expect(setRatio(SINGLE_LAYOUT, 0.3)).toBe(SINGLE_LAYOUT);
  });
});

describe("focusOtherPane", () => {
  it("flips the focused pane in a split", () => {
    expect(focusOtherPane(split({ focused: "left" }))).toMatchObject({ focused: "right" });
    expect(focusOtherPane(split({ focused: "right" }))).toMatchObject({ focused: "left" });
  });

  it("is a no-op for a single layout", () => {
    expect(focusOtherPane(SINGLE_LAYOUT)).toBe(SINGLE_LAYOUT);
  });
});

describe("reconcileLayout", () => {
  it("keeps a valid split and pins focus to the active tab's pane (active=left)", () => {
    expect(reconcileLayout(split(), ["L", "R"], "L")).toEqual({
      mode: "split",
      left: "L",
      right: "R",
      ratio: DEFAULT_SPLIT_RATIO,
      focused: "left",
    });
  });

  it("keeps a valid split and pins focus to the active tab's pane (active=right)", () => {
    expect(reconcileLayout(split({ focused: "left" }), ["L", "R"], "R")).toMatchObject({
      mode: "split",
      focused: "right",
    });
  });

  it("collapses to single when the active tab is a third tab", () => {
    expect(reconcileLayout(split(), ["L", "R", "X"], "X")).toEqual(SINGLE_LAYOUT);
  });

  it("collapses to single when there is no active tab", () => {
    expect(reconcileLayout(split(), ["L", "R"], null)).toEqual(SINGLE_LAYOUT);
  });

  it("collapses to single when the left pane's tab has closed", () => {
    expect(reconcileLayout(split(), ["R"], "R")).toEqual(SINGLE_LAYOUT);
  });

  it("collapses to single when the right pane's tab has closed", () => {
    expect(reconcileLayout(split(), ["L"], "L")).toEqual(SINGLE_LAYOUT);
  });

  it("collapses to single when the two panes are identical", () => {
    expect(reconcileLayout(split({ left: "L", right: "L" }), ["L"], "L")).toEqual(SINGLE_LAYOUT);
  });

  it("returns single for a single-layout input", () => {
    expect(reconcileLayout(SINGLE_LAYOUT, ["L", "R"], "L")).toEqual(SINGLE_LAYOUT);
  });
});

describe("focusedPaneTab", () => {
  it("returns the focused pane's tab in a split", () => {
    expect(focusedPaneTab(split({ focused: "left" }))).toBe("L");
    expect(focusedPaneTab(split({ focused: "right" }))).toBe("R");
  });

  it("returns null for a single layout", () => {
    expect(focusedPaneTab(SINGLE_LAYOUT)).toBeNull();
  });
});

describe("paneOf", () => {
  it("returns the pane holding the tab in a split", () => {
    const layout = split({ left: "L", right: "R" });
    expect(paneOf(layout, "L")).toBe("left");
    expect(paneOf(layout, "R")).toBe("right");
    expect(paneOf(layout, "X")).toBeNull();
  });

  it("returns null for a single layout", () => {
    expect(paneOf(SINGLE_LAYOUT, "L")).toBeNull();
  });
});

describe("reducers do not mutate their input", () => {
  it("leaves the input split object unmodified", () => {
    const input = split({ left: "L", right: "R", ratio: 0.5, focused: "left" });
    const snapshot: WindowLayout = { mode: "split", left: "L", right: "R", ratio: 0.5, focused: "left" };
    // Each reducer runs against the frozen input; a mutation would throw.
    unsplit(input);
    swapPanes(input);
    setRatio(input, 0.7);
    focusOtherPane(input);
    reconcileLayout(input, ["L", "R"], "R");
    expect(input).toEqual(snapshot);
  });
});
