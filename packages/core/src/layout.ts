export const SIDEBAR_WIDTH = 240;

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

/** Fixed distance from the top of the content area to the find bar. */
export const FIND_BAR_TOP = 12;

/**
 * Computes the command bar's on-screen rectangle within the window's content
 * area. The bar is centered horizontally over the PAGE region (the content to
 * the right of the sidebar) and its top sits at 12% of the content height.
 *
 * The width tracks the page region but is clamped to at most 640px and inset by
 * 48px, and floored at 0. When the page region is too narrow to show any bar
 * (`pageWidth - 48 <= 0`), an all-zero rect is returned so no negative or
 * off-screen dimensions ever reach the caller.
 *
 * The height is `COMMAND_BAR_HEIGHT + rowCount * SUGGESTION_ROW_HEIGHT`, clamped
 * to `contentHeight - y` so the bottom edge never passes the content height.
 * When that clamp room (`contentHeight - y`) is smaller than
 * `COMMAND_BAR_HEIGHT` — the window is too short to seat even the input row —
 * the all-zero rect is returned, as it is for the zero-width case.
 */
export function commandBarBounds(
  contentWidth: number,
  contentHeight: number,
  rowCount: number,
): { x: number; y: number; width: number; height: number } {
  const pageWidth = contentWidth - SIDEBAR_WIDTH;
  const width = Math.max(0, Math.min(640, pageWidth - 48));
  if (width === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const x = SIDEBAR_WIDTH + Math.round((pageWidth - width) / 2);
  const y = Math.round(contentHeight * 0.12);
  if (contentHeight - y < COMMAND_BAR_HEIGHT) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  let height = COMMAND_BAR_HEIGHT + rowCount * SUGGESTION_ROW_HEIGHT;
  height = Math.min(height, contentHeight - y);
  return { x, y, width, height };
}

/**
 * The settings view's on-screen rectangle within the window's content area: it
 * covers the whole PAGE region (the content to the right of the sidebar),
 * starting at the sidebar's right edge and filling the content height.
 */
export function settingsBounds(
  contentWidth: number,
  contentHeight: number,
): { x: number; y: number; width: number; height: number } {
  return {
    x: SIDEBAR_WIDTH,
    y: 0,
    width: contentWidth - SIDEBAR_WIDTH,
    height: contentHeight,
  };
}

/**
 * Computes the find bar overlay's on-screen rectangle within the window's
 * content area. The bar is anchored to the top-right of the PAGE region (the
 * content to the right of the sidebar), insetting {@link FIND_BAR_INSET} from
 * both the right and left edges and sitting {@link FIND_BAR_TOP} below the top.
 *
 * The width is {@link FIND_BAR_WIDTH}, clamped down to `pageWidth - 2 *
 * FIND_BAR_INSET` when the page region is too narrow to seat the full bar with
 * its insets, and floored at 0. When the page region cannot fit any bar
 * (`pageWidth - 2 * FIND_BAR_INSET <= 0`), an all-zero rect is returned so no
 * negative or off-screen dimensions ever reach the caller. The height and `y`
 * are fixed, so the signature takes only `contentWidth`.
 */
export function findBarBounds(
  contentWidth: number,
): { x: number; y: number; width: number; height: number } {
  const pageWidth = contentWidth - SIDEBAR_WIDTH;
  const width = Math.max(0, Math.min(FIND_BAR_WIDTH, pageWidth - 2 * FIND_BAR_INSET));
  if (width === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const x = SIDEBAR_WIDTH + pageWidth - width - FIND_BAR_INSET;
  return { x, y: FIND_BAR_TOP, width, height: FIND_BAR_HEIGHT };
}
