import { clampRatio } from "./split-view.js";
import { contentRect, type ChromeState, type Rect } from "./chrome.js";

/** Delay before a single click on a space row activates it, so a double-click can cancel it. */
export const SPACE_ACTIVATE_DELAY_MS = 250;

/** Fixed width of the find bar overlay, before clamping to the page region. */
export const FIND_BAR_WIDTH = 360;

/** Fixed height of the find bar overlay. */
export const FIND_BAR_HEIGHT = 44;

/** Horizontal inset the find bar keeps from each edge of the page region. */
export const FIND_BAR_INSET = 12;

/** Fixed distance from the top of the PAGE region (the card) to the find bar. */
export const FIND_BAR_TOP = 12;

/** Fixed width of the command bar overlay's panel, before clamping to the window. */
export const COMMAND_BAR_WIDTH = 680;

/** Margin the command bar panel keeps from the window's side and bottom edges. */
export const COMMAND_BAR_MARGIN = 24;

/** Fraction of the window's content height at which the command bar panel's top sits. */
export const COMMAND_BAR_TOP_RATIO = 0.2;

/** Fixed height of the command bar panel's input row. */
export const COMMAND_BAR_INPUT_HEIGHT = 58;

/** Height of a single suggestion row in the command bar list. */
export const COMMAND_BAR_ROW_HEIGHT = 40;

/** Height of a group heading row in the command bar list. */
export const COMMAND_BAR_GROUP_HEIGHT = 28;

/** Padding above the first row (or group heading) in the command bar list. */
export const COMMAND_BAR_LIST_PADDING_TOP = 4;

/** Padding below the last row in the command bar list. */
export const COMMAND_BAR_LIST_PADDING_BOTTOM = 8;

/**
 * Computes the command bar panel's on-screen rectangle within the window's
 * content area. Unlike {@link splitPaneBounds} and the other overlay bounds
 * below, the panel is centered on the whole window, not on the PAGE region
 * ({@link contentRect}): the command bar overlay covers the entire content
 * area, sidebar included.
 *
 * The width is `min(COMMAND_BAR_WIDTH, contentWidth - 2 *
 * COMMAND_BAR_MARGIN)`, floored at 0; when it is 0, the window is too narrow
 * to show any bar and an all-zero rect is returned. The top sits at
 * `round(contentHeight * COMMAND_BAR_TOP_RATIO)`.
 *
 * The remaining room to the bottom margin, `contentHeight - y -
 * COMMAND_BAR_MARGIN`, must fit at least `COMMAND_BAR_INPUT_HEIGHT`; when it
 * doesn't, the all-zero rect is returned, as it is for the zero-width case.
 * Otherwise the height is the input plus the list (padding, `rows *
 * COMMAND_BAR_ROW_HEIGHT` and `groups * COMMAND_BAR_GROUP_HEIGHT`, or 0 when
 * there are no rows), clamped to that room. Negative `rows` or `groups` count
 * as 0.
 */
export function commandBarPanelRect(
  contentW: number,
  contentH: number,
  rows: number,
  groups = 0,
): Rect {
  const width = Math.max(0, Math.min(COMMAND_BAR_WIDTH, contentW - 2 * COMMAND_BAR_MARGIN));
  if (width === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const x = Math.round((contentW - width) / 2);
  const y = Math.round(contentH * COMMAND_BAR_TOP_RATIO);
  const room = contentH - y - COMMAND_BAR_MARGIN;
  if (room < COMMAND_BAR_INPUT_HEIGHT) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const rowCount = Math.max(0, rows);
  const groupCount = Math.max(0, groups);
  const list =
    rowCount === 0
      ? 0
      : COMMAND_BAR_LIST_PADDING_TOP +
        COMMAND_BAR_LIST_PADDING_BOTTOM +
        rowCount * COMMAND_BAR_ROW_HEIGHT +
        groupCount * COMMAND_BAR_GROUP_HEIGHT;
  const height = Math.min(COMMAND_BAR_INPUT_HEIGHT + list, room);
  return { x, y, width, height };
}

/**
 * The settings view's on-screen rectangle within the window's content area:
 * it covers the whole PAGE region ({@link contentRect}), the inset card to
 * the right of the sidebar.
 */
export function settingsBounds(
  contentWidth: number,
  contentHeight: number,
  chrome: ChromeState,
): Rect {
  return contentRect(contentWidth, contentHeight, chrome);
}

export const QUICK_BROWSE_WIDTH = 480;
export const QUICK_BROWSE_HEIGHT = 640;
/** Height of the quick-browse chrome bar above the page view. */
export const QUICK_BROWSE_CHROME_HEIGHT = 44;
/**
 * The quick-browse page WebContentsView's rectangle WITHIN the quick-browse
 * window's content area: full width, starting below the chrome bar, filling the
 * remaining height. Floored at 0 so a window shorter than the chrome bar never
 * yields a negative height. Quick-browse is its own window with no sidebar, so
 * this never reads {@link ChromeState}.
 */
export function quickBrowsePageBounds(
  contentWidth: number,
  contentHeight: number,
): Rect {
  return { x: 0, y: QUICK_BROWSE_CHROME_HEIGHT, width: contentWidth, height: Math.max(0, contentHeight - QUICK_BROWSE_CHROME_HEIGHT) };
}

/** Width, in px, of the draggable divider gutter drawn between split panes. */
export const DIVIDER_WIDTH = 8;

/**
 * Computes the two page-region rectangles of a split view plus the divider
 * gutter between them, within the window's content area. The panes tile the
 * PAGE region ({@link contentRect}, the inset card to the right of the
 * sidebar): the left pane, then the {@link DIVIDER_WIDTH}-wide divider, then
 * the right pane, all filling the page region's height.
 *
 * The usable page width is `r.width - DIVIDER_WIDTH`. When that is
 * non-positive (the page region cannot seat even the divider), all three
 * rects are all-zero so no negative or off-screen dimensions reach the
 * caller, mirroring the zero-width guard in {@link commandBarPanelRect}.
 * Otherwise the left
 * pane takes `round(usable * r)` of the usable width (with `r` the
 * {@link clampRatio}-clamped `ratio`) and the right pane takes the remainder,
 * so the two pane widths plus the divider sum to the page region's width
 * exactly.
 */
export function splitPaneBounds(
  contentWidth: number,
  contentHeight: number,
  chrome: ChromeState,
  ratio: number,
): {
  left: Rect;
  divider: Rect;
  right: Rect;
} {
  const r = contentRect(contentWidth, contentHeight, chrome);
  const usable = r.width - DIVIDER_WIDTH;
  if (usable <= 0) {
    return {
      left: { x: 0, y: 0, width: 0, height: 0 },
      divider: { x: 0, y: 0, width: 0, height: 0 },
      right: { x: 0, y: 0, width: 0, height: 0 },
    };
  }
  const ratioClamped = clampRatio(ratio);
  const leftW = Math.round(usable * ratioClamped);
  return {
    left: { x: r.x, y: r.y, width: leftW, height: r.height },
    divider: { x: r.x + leftW, y: r.y, width: DIVIDER_WIDTH, height: r.height },
    right: {
      x: r.x + leftW + DIVIDER_WIDTH,
      y: r.y,
      width: usable - leftW,
      height: r.height,
    },
  };
}

/**
 * Computes the find bar overlay's on-screen rectangle within the window's
 * content area. The bar is anchored to the top-right of the PAGE region
 * ({@link contentRect}, the inset card to the right of the sidebar), insetting
 * {@link FIND_BAR_INSET} from both the right and left edges and sitting
 * {@link FIND_BAR_TOP} below the top.
 *
 * The width is {@link FIND_BAR_WIDTH}, clamped down to `r.width - 2 *
 * FIND_BAR_INSET` when the page region is too narrow to seat the full bar with
 * its insets, and floored at 0. When the page region cannot fit any bar
 * (`r.width - 2 * FIND_BAR_INSET <= 0`), an all-zero rect is returned so no
 * negative or off-screen dimensions ever reach the caller.
 */
export function findBarBounds(
  contentWidth: number,
  contentHeight: number,
  chrome: ChromeState,
): Rect {
  const r = contentRect(contentWidth, contentHeight, chrome);
  const width = Math.max(0, Math.min(FIND_BAR_WIDTH, r.width - 2 * FIND_BAR_INSET));
  if (width === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const x = r.x + r.width - width - FIND_BAR_INSET;
  return { x, y: r.y + FIND_BAR_TOP, width, height: FIND_BAR_HEIGHT };
}
