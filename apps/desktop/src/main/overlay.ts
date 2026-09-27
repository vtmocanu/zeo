import { commandBarPanelRect, findAnchorRect, findBarBounds } from "@zeo/core";
import { runtime } from "./state.js";

/**
 * Positions the single overlay view for its active surface. The command bar
 * covers the whole window content area (the renderer draws a scrim and places
 * the panel with {@link commandBarPanelRect}), so every click in the window
 * lands in the overlay while the bar is open. The find bar keeps its
 * card-anchored {@link findBarBounds} rect, anchored to the split pane owning
 * `runtime.find.tabId` (or the single content region) via
 * {@link findAnchorRect}. A no-op unless both the window and the overlay
 * exist. When the window is too small for the surface the overlay is hidden
 * and left hidden until a later bounds pass has room. Otherwise, while the
 * surface is open, the overlay is (re-)shown. Returns whether it left the
 * overlay shown, so callers can drive focus off that rather than force
 * visibility. Called on open, on query change and on window resize.
 */
export function layoutOverlay(): boolean {
  if (runtime.win === null || runtime.overlay === null) {
    return false;
  }
  const [width, height] = runtime.win.getContentSize();
  const find = runtime.commandBar.surface === "find";
  const bounds = find
    ? findBarBounds(
        findAnchorRect(width, height, runtime.chrome, runtime.layout, runtime.find.tabId),
      )
    : commandBarPanelRect(width, height, 0).width === 0
      ? { x: 0, y: 0, width: 0, height: 0 }
      : { x: 0, y: 0, width, height };
  if (bounds.width === 0) {
    runtime.overlay.setVisible(false);
    return false;
  }
  runtime.overlay.setBounds(bounds);
  const surfaceOpen = find ? runtime.find.open : runtime.commandBar.open;
  if (surfaceOpen) {
    runtime.overlay.setVisible(true);
    return true;
  }
  return false;
}
