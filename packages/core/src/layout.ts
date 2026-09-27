import { clampRatio, type PaneSide, type WindowLayout } from "./split-view.js";
import { contentRect, type ChromeState, type Rect } from "./chrome.js";

/** Delay before a single click on a space row activates it, so a double-click can cancel it. */
export const SPACE_ACTIVATE_DELAY_MS = 250;

/** Fixed width of the find pill, before clamping to its anchor card ({@link findPillRect}). */
export const FIND_BAR_WIDTH = 360;

/** Fixed height of the find pill. */
export const FIND_BAR_HEIGHT = 38;

/** Inset the find pill keeps from the top and right (and, when clamped, left) edges of its card. */
export const FIND_BAR_INSET = 8;

/**
 * Margin the find overlay view extends past the pill on every side, so the
 * pill's `--shadow-popover` is not clipped by the view's bounds.
 */
export const FIND_BAR_SHADOW_MARGIN = 16;

/** Maximum width of the settings sheet. */
export const SETTINGS_SHEET_WIDTH = 760;

/** Maximum height of the settings sheet. */
export const SETTINGS_SHEET_HEIGHT = 500;

/** Minimum margin the settings sheet keeps from every edge of the window. */
export const SHEET_MARGIN = 24;

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
 * the whole content area, sidebar included. The view is transparent; its
 * renderer paints the scrim and centers the sheet with {@link settingsSheetRect}.
 */
export function settingsBounds(contentWidth: number, contentHeight: number): Rect {
  return { x: 0, y: 0, width: contentWidth, height: contentHeight };
}

/**
 * The settings sheet's rectangle within the settings view's viewport: at most
 * {@link SETTINGS_SHEET_WIDTH} × {@link SETTINGS_SHEET_HEIGHT}, keeping
 * {@link SHEET_MARGIN} from every edge, centered. Each dimension is floored at
 * 0; an all-zero rect is returned when either is 0.
 */
export function settingsSheetRect(viewportWidth: number, viewportHeight: number): Rect {
  const width = Math.max(0, Math.min(SETTINGS_SHEET_WIDTH, viewportWidth - 2 * SHEET_MARGIN));
  const height = Math.max(0, Math.min(SETTINGS_SHEET_HEIGHT, viewportHeight - 2 * SHEET_MARGIN));
  if (width === 0 || height === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return {
    x: Math.round((viewportWidth - width) / 2),
    y: Math.round((viewportHeight - height) / 2),
    width,
    height,
  };
}

export const QUICK_BROWSE_WIDTH = 480;
export const QUICK_BROWSE_HEIGHT = 640;
/** Height of the quick-browse chrome bar above the page view. */
export const QUICK_BROWSE_CHROME_HEIGHT = 48;
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
 * The card a find session belongs to: in split mode, when `tabId` is one of
 * the two panes, that pane's rect from {@link splitPaneBounds}; otherwise the
 * single PAGE region ({@link contentRect}).
 */
export function findAnchorRect(
  contentWidth: number,
  contentHeight: number,
  chrome: ChromeState,
  layout: WindowLayout,
  tabId: string | null,
): Rect {
  if (layout.mode === "split" && tabId !== null) {
    if (tabId === layout.left || tabId === layout.right) {
      const panes = splitPaneBounds(contentWidth, contentHeight, chrome, layout.ratio);
      return tabId === layout.left ? panes.left : panes.right;
    }
  }
  return contentRect(contentWidth, contentHeight, chrome);
}

/**
 * The find pill's rectangle: {@link FIND_BAR_WIDTH} wide (clamped to
 * `anchor.width - 2 * FIND_BAR_INSET`), {@link FIND_BAR_HEIGHT} tall, inset
 * {@link FIND_BAR_INSET} from the anchor card's top-right corner. All-zero when
 * the anchor cannot seat any pill.
 */
export function findPillRect(anchor: Rect): Rect {
  const width = Math.min(FIND_BAR_WIDTH, anchor.width - 2 * FIND_BAR_INSET);
  if (width <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return {
    x: anchor.x + anchor.width - width - FIND_BAR_INSET,
    y: anchor.y + FIND_BAR_INSET,
    width,
    height: FIND_BAR_HEIGHT,
  };
}

/**
 * The find overlay view's rectangle: the {@link findPillRect} grown by
 * {@link FIND_BAR_SHADOW_MARGIN} on every side so the pill's shadow is not
 * clipped. All-zero when the pill is.
 */
export function findBarBounds(anchor: Rect): Rect {
  const pill = findPillRect(anchor);
  if (pill.width === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return {
    x: pill.x - FIND_BAR_SHADOW_MARGIN,
    y: pill.y - FIND_BAR_SHADOW_MARGIN,
    width: pill.width + 2 * FIND_BAR_SHADOW_MARGIN,
    height: pill.height + 2 * FIND_BAR_SHADOW_MARGIN,
  };
}

/** One card drawn beneath the native views; `focused` marks the focused split pane. */
export interface WindowCardRect {
  pane: "single" | PaneSide;
  rect: Rect;
  focused: boolean;
}

/**
 * The window cards: one unfocused `"single"` card at {@link contentRect} in
 * single mode, or the `left` and `right` panes of {@link splitPaneBounds} in
 * split mode with `focused` true on `layout.focused`.
 */
export function windowCardRects(
  contentWidth: number,
  contentHeight: number,
  chrome: ChromeState,
  layout: WindowLayout,
): WindowCardRect[] {
  if (layout.mode === "split") {
    const { left, right } = splitPaneBounds(contentWidth, contentHeight, chrome, layout.ratio);
    return [
      { pane: "left", rect: left, focused: layout.focused === "left" },
      { pane: "right", rect: right, focused: layout.focused === "right" },
    ];
  }
  return [{ pane: "single", rect: contentRect(contentWidth, contentHeight, chrome), focused: false }];
}
