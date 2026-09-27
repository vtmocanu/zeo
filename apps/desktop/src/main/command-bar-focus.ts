import { runtime } from "./state.js";

// closeCommandBar is reached through runtime.closeCommandBarHook (registered by
// command-bar.ts at load), NOT a direct import: command-bar.ts imports
// layout.ts, and both layout.ts and views.ts import this module, so a direct
// import here would close a cycle back to command-bar.ts (madge cycle guard;
// see the hook's doc comment in state.ts).
function closeCommandBar(): void {
  runtime.closeCommandBarHook?.();
}

/**
 * Set by {@link onTabViewFocus} when a tab view steals native focus WHILE the
 * command bar owns it, and read (then cleared) by {@link onOverlayBlur}'s
 * deferred check. The steal fires the overlay's `blur` before the tab view's own
 * `focus` handler runs the refocus, so the flag is how the deferred blur handler
 * learns the blur was a steal rather than a real dismiss.
 */
let focusStolen = false;

/**
 * Whether the single overlay `WebContentsView` currently owns focus AS the
 * command bar: the bar is open, its surface is `"bar"` (not `"find"`, the
 * overlay's other surface), and the overlay itself is live (non-null, not
 * destroyed) and visible. A hidden or destroyed overlay never owns focus, even
 * with `commandBar.open` true — e.g. a collapsed window leaves the bar "open"
 * with the overlay hidden until the next resize (see {@link openCommandBar}).
 */
export function commandBarOwnsFocus(): boolean {
  return (
    runtime.commandBar.open &&
    runtime.commandBar.surface === "bar" &&
    runtime.overlay !== null &&
    !runtime.overlay.webContents.isDestroyed() &&
    runtime.overlay.getVisible()
  );
}

/**
 * Registered on every tab view's `WebContents` `focus` event (views.ts). A tab
 * view can steal native focus from the overlay while it is loading, even though
 * the user's click never left the bar (the overlay is full-window, so a real
 * click on a tab never reaches its view at all). When the bar currently owns
 * focus, record the steal for {@link onOverlayBlur}'s deferred check and hand
 * focus straight back to the overlay. A no-op otherwise (the bar is closed, on
 * the find surface, or hidden), so a deliberate tab focus (e.g. after
 * {@link closeCommandBar}) is left alone.
 */
export function onTabViewFocus(): void {
  if (!commandBarOwnsFocus()) {
    return;
  }
  focusStolen = true;
  runtime.overlay!.webContents.focus();
}

/**
 * Registered on the overlay's `WebContents` `blur` event (window.ts), replacing
 * a direct, synchronous {@link closeCommandBar} call. Electron delivers
 * focus/blur asynchronously and the ordering between a losing view's `blur` and
 * a gaining view's `focus` is not guaranteed, so the decision is deferred one
 * tick (`setTimeout(..., 0)`) to let a same-tick steal (see {@link
 * onTabViewFocus}) — or the OS finishing its focus handoff — settle first.
 *
 * In the deferred callback: a bar that is no longer open, or moved off the
 * `"bar"` surface, needs no action beyond clearing the steal flag. Otherwise the
 * bar stays open (and the overlay is refocused) when any of these holds: a
 * steal was recorded, the overlay somehow already regained focus, or any live
 * tab view's `WebContents` reports focused — a backstop against the async
 * ordering (see find.ts's own note on this), since a genuinely stolen focus can
 * still be sitting on the tab view rather than back on the overlay by the time
 * this runs. Any other case (nothing focused — a real scrim click, Escape via
 * IPC, or window blur, all of which close through their own paths anyway) closes
 * the bar. The steal flag is cleared unconditionally. A destroyed overlay or a
 * gone window closes rather than refocuses, since there is nothing left to
 * refocus.
 */
export function onOverlayBlur(): void {
  setTimeout(() => {
    const stolen = focusStolen;
    focusStolen = false;
    if (!runtime.commandBar.open || runtime.commandBar.surface !== "bar") {
      return;
    }
    if (
      runtime.win === null ||
      runtime.overlay === null ||
      runtime.overlay.webContents.isDestroyed()
    ) {
      closeCommandBar();
      return;
    }
    const overlayFocused = runtime.overlay.webContents.isFocused();
    let tabViewFocused = false;
    for (const view of runtime.views.values()) {
      if (!view.webContents.isDestroyed() && view.webContents.isFocused()) {
        tabViewFocused = true;
        break;
      }
    }
    if (stolen || overlayFocused || tabViewFocused) {
      runtime.overlay.webContents.focus();
      return;
    }
    closeCommandBar();
  }, 0);
}

/**
 * Focuses `wc` from the main process, closing the command bar FIRST when it
 * currently owns focus. Deliberately focusing a tab view (e.g. after
 * {@link closeSettings}-style teardown, or {@link activateTab}/{@link
 * doSplitWith}'s focus return) would otherwise blur the overlay and let
 * {@link onOverlayBlur}'s deferred check decide whether to close it — racy and
 * unnecessary when the caller already knows it means to move focus away from
 * the bar. Closing first here keeps that existing "focusing a tab view closes
 * the bar" behavior, just synchronous and deliberate instead of blur-driven.
 */
export function focusTabViewDeliberately(wc: Electron.WebContents): void {
  if (commandBarOwnsFocus()) {
    closeCommandBar();
  }
  wc.focus();
}
