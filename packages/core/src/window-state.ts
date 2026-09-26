/**
 * PRD 9.5 — pure window-state restore. This module decides the bounds a restored
 * browser window should open with, given the state persisted from its last close
 * and the work areas of the displays currently attached. No Electron here: main
 * reads the saved state and the per-display work areas itself and feeds in plain
 * rects, then hands the result to `BrowserWindow`.
 *
 * {@link resolveWindowBounds} is pure and total — no side effects, defined for
 * all inputs — so it can be unit-tested without a display.
 */

/**
 * A window's persisted geometry. `x`/`y` are `null` when the last session left
 * the position to the platform (e.g. a first run that centered on the primary
 * display); `width`/`height` are always stored. `maximized` records whether the
 * window was maximized at close, independent of the restored `width`/`height`
 * (which hold the un-maximized bounds to restore to on un-maximize).
 */
export interface WindowState {
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  maximized: boolean;
}

/** An axis-aligned rectangle: a display's work area, or a saved window rect. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The size a window opens with when there is no usable saved state. */
export const DEFAULT_WINDOW_SIZE = { width: 1280, height: 800 } as const;

/** The smallest size a restored window may be clamped to. */
export const MIN_WINDOW_SIZE = { width: 640, height: 400 } as const;

/**
 * The least a saved window rect must overlap some work area — on BOTH axes — to
 * count as still on-screen. Below this the saved position is dropped and the
 * window is centered, so a window saved on a now-detached display is not lost
 * off the visible desktop.
 */
export const MIN_VISIBLE_PX = 100;

/** The overlap of `[aStart, aEnd)` and `[bStart, bEnd)`; negative when disjoint. */
function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
}

/**
 * The bounds a restored window should open with.
 *
 * When `saved` is `null` or `workAreas` is empty there is nothing to restore, so
 * the default size is returned with NO `x`/`y` — Electron then centers the window
 * on the primary display.
 *
 * Otherwise `width`/`height` are the saved size clamped into
 * `[MIN_WINDOW_SIZE, largest work area by area]` (the low bound applied first, so
 * on a pathologically tiny display the high bound wins and the window never
 * exceeds the largest work area). The saved `x`/`y` are kept only when both are non-null
 * AND the saved rect overlaps at least one work area by at least
 * {@link MIN_VISIBLE_PX} on BOTH axes of the SAME work area; otherwise they are
 * omitted and the window centers. `maximized` passes through unchanged.
 */
export function resolveWindowBounds(
  saved: WindowState | null,
  workAreas: readonly Rect[],
): { x?: number; y?: number; width: number; height: number; maximized: boolean } {
  if (saved === null || workAreas.length === 0) {
    return {
      width: DEFAULT_WINDOW_SIZE.width,
      height: DEFAULT_WINDOW_SIZE.height,
      maximized: false,
    };
  }

  // Pick a single work area to clamp into — the largest by area, ties broken by
  // array order — rather than mixing the widest and tallest work areas, which
  // could come from different displays and allow a size no single display fits
  // (e.g. a 1920x1080 display plus a portrait 1080x1920 one would otherwise
  // allow 1920x1920).
  const largest = workAreas.reduce((best, wa) =>
    wa.width * wa.height > best.width * best.height ? wa : best,
  );
  // Clamp the low bound first, then the high bound, so a min above the largest
  // work area still never exceeds it.
  const width = Math.min(largest.width, Math.max(MIN_WINDOW_SIZE.width, saved.width));
  const height = Math.min(largest.height, Math.max(MIN_WINDOW_SIZE.height, saved.height));

  const positioned = keepsPosition(saved, workAreas);
  if (positioned) {
    return { x: positioned.x, y: positioned.y, width, height, maximized: saved.maximized };
  }
  return { width, height, maximized: saved.maximized };
}

/**
 * The saved position when it is still on-screen (both coordinates non-null and
 * the SAVED, unclamped rect overlapping some work area by at least
 * {@link MIN_VISIBLE_PX} on both axes), or `null` when it should be dropped.
 */
function keepsPosition(
  saved: WindowState,
  workAreas: readonly Rect[],
): { x: number; y: number } | null {
  const { x, y } = saved;
  if (x === null || y === null) {
    return null;
  }
  const onScreen = workAreas.some((wa) => {
    const dx = overlap(x, x + saved.width, wa.x, wa.x + wa.width);
    const dy = overlap(y, y + saved.height, wa.y, wa.y + wa.height);
    return dx >= MIN_VISIBLE_PX && dy >= MIN_VISIBLE_PX;
  });
  return onScreen ? { x, y } : null;
}

/**
 * The top-left corner that centers a `width`x`height` window within `area`.
 * Pure arithmetic — no Electron — so a caller with no saved position can center
 * explicitly on a chosen work area rather than relying on platform defaults.
 */
export function centerInWorkArea(
  width: number,
  height: number,
  area: Rect,
): { x: number; y: number } {
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
  };
}
