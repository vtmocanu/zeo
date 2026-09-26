import { commandBarBounds, findBarBounds } from "@zeo/core";
import { runtime } from "./state.js";

/**
 * Positions the command-bar overlay over the page region using the shared
 * {@link commandBarBounds} geometry, sized to the current suggestion row count.
 * A no-op unless both the window and the overlay exist. When the window is too
 * short or too narrow the geometry collapses to an all-zero rect; the overlay is
 * hidden in that case and left hidden until a later bounds pass yields a
 * non-zero rectangle. Otherwise, while the bar is open, the overlay is (re-)shown.
 * Returns whether it left the overlay shown, so callers can drive focus off that
 * rather than force visibility. Bounds are re-applied whenever the row count can
 * change — on open, on query change, and on window resize (a selection move
 * pushes state but does not re-layout, which is fine since the row count is
 * unchanged).
 */
export function layoutOverlay(): boolean {
  if (runtime.win === null || runtime.overlay === null) {
    return false;
  }
  const [width, height] = runtime.win.getContentSize();
  // The overlay hosts two mutually exclusive surfaces: the find bar anchors
  // top-right of the page region, the command bar spans it. Size to whichever is
  // active and show it only while that surface's own open flag is set.
  const bounds =
    runtime.commandBar.surface === "find"
      ? findBarBounds(width)
      : commandBarBounds(width, height, runtime.commandBar.suggestions.length);
  if (bounds.width === 0) {
    runtime.overlay.setVisible(false);
    return false;
  }
  runtime.overlay.setBounds(bounds);
  const surfaceOpen =
    runtime.commandBar.surface === "find" ? runtime.find.open : runtime.commandBar.open;
  if (surfaceOpen) {
    runtime.overlay.setVisible(true);
    return true;
  }
  return false;
}
