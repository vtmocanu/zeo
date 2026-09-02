export const SIDEBAR_WIDTH = 240;

/** Fixed height of the command bar overlay's input row. */
export const COMMAND_BAR_HEIGHT = 56;

/** Height of a single suggestion row added below the input. */
export const SUGGESTION_ROW_HEIGHT = 44;

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
