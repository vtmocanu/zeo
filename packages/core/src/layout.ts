import { clampRatio } from "./split-view.js";
import { contentRect, type ChromeState, type Rect } from "./chrome.js";

/** Delay before a single click on a space row activates it, so a double-click can cancel it. */
export const SPACE_ACTIVATE_DELAY_MS = 250;

/** Fixed height of the command bar overlay's input row. */
export const COMMAND_BAR_HEIGHT = 56;

/** Height of a single suggestion row added below the input. */
export const SUGGESTION_ROW_HEIGHT = 44;

/** Fixed width of the find bar overlay, before clamping to the page region. */
export const FIND_BAR_WIDTH = 360;

/** Fixed height of the find bar overlay. */
export const FIND_BAR_HEIGHT = 44;

/** Horizontal inset the find bar keeps from each edge of the page region. */
export const FIND_BAR_INSET = 12;

/** Fixed distance from the top of the PAGE region (the card) to the find bar. */
export const FIND_BAR_TOP = 12;

/**
 * Computes the command bar's on-screen rectangle within the window's content
 * area. The bar is centered horizontally over the PAGE region ({@link
 * contentRect}, the inset card to the right of the sidebar) and its top sits
 * at 12% down from the page region's top edge.
 *
 * The width tracks the page region but is clamped to at most 640px and inset by
 * 48px, and floored at 0. When the page region is too narrow to show any bar
 * (`r.width - 48 <= 0`), an all-zero rect is returned so no negative or
 * off-screen dimensions ever reach the caller.
 *
 * The height is `COMMAND_BAR_HEIGHT + rowCount * SUGGESTION_ROW_HEIGHT`, clamped
 * to `r.y + r.height - y` so the bottom edge never passes the page region's
 * bottom. When that clamp room is smaller than `COMMAND_BAR_HEIGHT` — the
 * window is too short to seat even the input row — the all-zero rect is
 * returned, as it is for the zero-width case.
 */
export function commandBarBounds(
  contentWidth: number,
  contentHeight: number,
  chrome: ChromeState,
  rowCount: number,
): Rect {
  const r = contentRect(contentWidth, contentHeight, chrome);
  const width = Math.max(0, Math.min(640, r.width - 48));
  if (width === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const x = r.x + Math.round((r.width - width) / 2);
  const y = r.y + Math.round(r.height * 0.12);
  if (r.y + r.height - y < COMMAND_BAR_HEIGHT) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  let height = COMMAND_BAR_HEIGHT + rowCount * SUGGESTION_ROW_HEIGHT;
  height = Math.min(height, r.y + r.height - y);
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
 * caller, mirroring the guard in {@link commandBarBounds}. Otherwise the left
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
