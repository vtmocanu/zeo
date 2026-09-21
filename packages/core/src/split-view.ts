/**
 * The pure split-view window-layout state and its reducers. This module owns the
 * `layout` slice main attaches to the broadcast snapshot: whether the active
 * space's page region shows a single tab or two side-by-side panes, and — when
 * split — which open tab each pane holds, the left-pane width fraction, and which
 * pane is focused.
 *
 * The reducers are free functions (not store methods) and treat their input as
 * immutable: each returns a NEW state object rather than mutating the argument,
 * matching the existing store's immutable-update style (see `blocking.ts`).
 */

/** Which of the two split panes: the `"left"` one or the `"right"` one. */
export type PaneSide = "left" | "right";

/** The single-pane layout: the page region shows one tab, as it always has. */
export interface SingleLayout {
  readonly mode: "single";
}

/**
 * The two-pane layout: `left` and `right` are the open tab ids of the active
 * space (distinct from each other), `ratio` is the left pane's width fraction
 * clamped to `[MIN_SPLIT_RATIO, MAX_SPLIT_RATIO]`, and `focused` names the pane
 * that currently has focus.
 */
export interface SplitLayout {
  readonly mode: "split";
  readonly left: string;
  readonly right: string;
  readonly ratio: number;
  readonly focused: PaneSide;
}

/** The window layout: a single pane or a two-pane split. */
export type WindowLayout = SingleLayout | SplitLayout;

/** The shared single-pane layout value. */
export const SINGLE_LAYOUT: SingleLayout = { mode: "single" };

/** The left-pane width fraction a fresh split opens with. */
export const DEFAULT_SPLIT_RATIO = 0.5;

/** The smallest left-pane width fraction a split may hold. */
export const MIN_SPLIT_RATIO = 0.2;

/** The largest left-pane width fraction a split may hold. */
export const MAX_SPLIT_RATIO = 0.8;

/**
 * Clamps `ratio` into `[MIN_SPLIT_RATIO, MAX_SPLIT_RATIO]`, returning
 * {@link DEFAULT_SPLIT_RATIO} for any non-finite input (`NaN`, `±Infinity`).
 */
export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) {
    return DEFAULT_SPLIT_RATIO;
  }
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

/**
 * Enters a split with `activeTabId` on the left and `otherTabId` on the right,
 * focused left at the default ratio. When the two ids are identical there is
 * nothing to split against, so {@link SINGLE_LAYOUT} is returned instead.
 */
export function enterSplit(activeTabId: string, otherTabId: string): WindowLayout {
  if (activeTabId === otherTabId) {
    return SINGLE_LAYOUT;
  }
  return {
    mode: "split",
    left: activeTabId,
    right: otherTabId,
    ratio: DEFAULT_SPLIT_RATIO,
    focused: "left",
  };
}

/** Exits any split back to {@link SINGLE_LAYOUT}, ignoring the input layout. */
export function unsplit(layout: WindowLayout): WindowLayout {
  // `layout` exists for call-site symmetry with the other reducers but is
  // ignored: unsplitting always collapses to the single-pane layout.
  void layout;
  return SINGLE_LAYOUT;
}

/**
 * Swaps the two panes: the left tab moves right and vice versa, and `focused`
 * flips so the SAME tab stays focused. The `ratio` is preserved. A single layout
 * is returned unchanged.
 */
export function swapPanes(layout: WindowLayout): WindowLayout {
  if (layout.mode === "single") {
    return layout;
  }
  return {
    mode: "split",
    left: layout.right,
    right: layout.left,
    ratio: layout.ratio,
    focused: layout.focused === "left" ? "right" : "left",
  };
}

/**
 * Sets the left-pane width fraction to `clampRatio(ratio)`. A single layout is
 * returned unchanged.
 */
export function setRatio(layout: WindowLayout, ratio: number): WindowLayout {
  if (layout.mode === "single") {
    return layout;
  }
  return { ...layout, ratio: clampRatio(ratio) };
}

/**
 * Moves focus to the other pane. A single layout is returned unchanged.
 */
export function focusOtherPane(layout: WindowLayout): WindowLayout {
  if (layout.mode === "single") {
    return layout;
  }
  return { ...layout, focused: layout.focused === "left" ? "right" : "left" };
}

/**
 * Reconciles `layout` against the active space's current open tabs and active
 * tab, collapsing to {@link SINGLE_LAYOUT} whenever the split can no longer be
 * honored. A single layout stays single. A split collapses when its two panes
 * are not BOTH still open (or have become identical); otherwise `focused` is
 * pinned to whichever pane holds `activeTabId`, and a split whose active tab is
 * neither pane (or `null`) also collapses to single.
 */
export function reconcileLayout(
  layout: WindowLayout,
  openTabIds: readonly string[],
  activeTabId: string | null,
): WindowLayout {
  if (layout.mode === "single") {
    return SINGLE_LAYOUT;
  }
  const bothOpen =
    openTabIds.includes(layout.left) && openTabIds.includes(layout.right);
  if (!bothOpen || layout.left === layout.right) {
    return SINGLE_LAYOUT;
  }
  if (activeTabId === layout.left) {
    return { ...layout, focused: "left" };
  }
  if (activeTabId === layout.right) {
    return { ...layout, focused: "right" };
  }
  return SINGLE_LAYOUT;
}

/**
 * The tab id in the focused pane of a split, or `null` for a single layout.
 */
export function focusedPaneTab(layout: WindowLayout): string | null {
  if (layout.mode === "single") {
    return null;
  }
  return layout.focused === "left" ? layout.left : layout.right;
}

/**
 * Which pane holds `tabId` in a split, or `null` when neither pane holds it (or
 * the layout is single).
 */
export function paneOf(layout: WindowLayout, tabId: string): PaneSide | null {
  if (layout.mode === "single") {
    return null;
  }
  if (layout.left === tabId) {
    return "left";
  }
  if (layout.right === tabId) {
    return "right";
  }
  return null;
}

/**
 * Structural equality of two window layouts: two singles are always equal; a
 * single and a split never are; two splits match only when their pane tab ids,
 * ratio, and focused pane all match. Lets main decide whether a reconcile
 * produced a change worth persisting.
 */
export function layoutsEqual(a: WindowLayout, b: WindowLayout): boolean {
  if (a.mode === "single" || b.mode === "single") {
    return a.mode === b.mode;
  }
  return (
    a.left === b.left &&
    a.right === b.right &&
    a.ratio === b.ratio &&
    a.focused === b.focused
  );
}
