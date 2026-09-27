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
 * deferred check, so the deferred blur handler learns the blur was a steal
 * rather than a real dismiss.
 *
 * Bounded so it can never outlive the focus handoff it was recorded for:
 * {@link onTabViewFocus} also schedules a two-level deferred clear
 * (`setTimeout(..., 0)` that itself schedules a second `setTimeout(..., 0)`)
 * back to `false`. Two levels, not one, because {@link onOverlayBlur}'s OWN
 * check is only a single deferred `setTimeout`, and Electron's focus/blur
 * ordering is not guaranteed — a steal's `focus` event can fire either before
 * or after the losing view's `blur` event, so the reset timer may end up queued
 * either before or after the blur's check timer. A single-level reset could
 * therefore run and clear the flag before a same-batch blur check gets to read
 * it; deferring the actual clear to a second level guarantees it always runs
 * AFTER any single-level timer scheduled in the same synchronous batch,
 * regardless of registration order. When focus and blur land in separate
 * native tasks far enough apart that the flag has already cleared, the
 * blur check falls back on `isFocused()`: {@link onTabViewFocus} refocused the
 * overlay synchronously, so the overlay (or the tab view) still reports focus
 * unless the window itself lost it. A blur arriving only after both
 * levels have already run (flushed timers, or simply much later) correctly
 * sees `false` and closes normally. Without this bound, a stale `true` from an
 * earlier steal (e.g. one whose own blur never arrived, or arrived and closed
 * the bar already) could wrongly keep a later, unrelated close-worthy blur
 * open.
 */
let focusStolen = false;
let focusStolenResetTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Clears {@link focusStolen} and cancels its pending deferred reset timer(s),
 * if any. Called from {@link openCommandBar}/{@link closeCommandBar} (via
 * command-bar.ts) so a steal recorded just before the bar closes (or a fresh
 * bar opens) can never leak into a later, unrelated blur decision.
 */
export function resetCommandBarFocusSteal(): void {
  focusStolen = false;
  if (focusStolenResetTimer !== null) {
    clearTimeout(focusStolenResetTimer);
    focusStolenResetTimer = null;
  }
}

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
  if (focusStolenResetTimer !== null) {
    clearTimeout(focusStolenResetTimer);
  }
  // Two-level deferred clear — see focusStolen's doc comment for why a single
  // level is not enough to outlast a same-batch blur check regardless of
  // registration order.
  focusStolenResetTimer = setTimeout(() => {
    focusStolenResetTimer = setTimeout(() => {
      focusStolen = false;
      focusStolenResetTimer = null;
    }, 0);
  }, 0);
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
 * `"bar"` surface, needs no action beyond clearing the steal flag. A destroyed
 * overlay or a gone window closes rather than refocuses, since there is
 * nothing left to refocus. Then, when the bar no longer OWNS focus per
 * {@link commandBarOwnsFocus} (e.g. the overlay is hidden — a collapsed window
 * leaves the bar "open" with the overlay hidden until the next resize; see
 * {@link openCommandBar}), this is a no-op: there is nothing to refocus and
 * nothing to close, since a hidden overlay never held real focus to lose.
 * Otherwise the bar stays open (and the overlay is refocused) when any of
 * these holds: a steal was recorded, the overlay somehow already regained
 * focus, or any live tab view's `WebContents` reports focused — a backstop
 * against the async ordering (see find.ts's own note on this), since a
 * genuinely stolen focus can still be sitting on the tab view rather than back
 * on the overlay by the time this runs. Any other case (nothing focused — a
 * real scrim click, Escape via IPC, or window blur, all of which close through
 * their own paths anyway) closes the bar. The steal flag is cleared
 * unconditionally.
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
    if (!commandBarOwnsFocus()) {
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
 * {@link closeSettings}-style teardown, or an explicit user split/focus op —
 * {@link doSplit}, {@link doSplitWith}, {@link doSwap}, {@link doFocusPane},
 * {@link doFocusOther}, {@link doUnsplit} — or {@link activateTab}'s focus
 * return) would otherwise blur the overlay and let {@link onOverlayBlur}'s
 * deferred check decide whether to close it — racy and unnecessary when the
 * caller already knows it means to move focus away from the bar. Closing
 * first here keeps that existing "focusing a tab view closes the bar"
 * behavior, just synchronous and deliberate instead of blur-driven. Use ONLY
 * for a user-initiated focus move; a non-user-initiated layout pass (e.g. a
 * background tab closing itself, a non-pane tab closing, a popup opening as a
 * tab, idle sweeping) must use {@link focusTabViewPassively} instead so it
 * never steals focus away from an open command bar. Note {@link doUnsplit}
 * and a split-collapsing {@link activateTab} pass `"deliberate"` too, but it
 * is a no-op there: the resulting single-mode branch never focuses a view.
 */
export function focusTabViewDeliberately(wc: Electron.WebContents): void {
  if (commandBarOwnsFocus()) {
    closeCommandBar();
  }
  wc.focus();
}

/**
 * Focuses `wc` from the main process UNLESS the command bar is open on its
 * `"bar"` surface, in which case this is a no-op — neither closing the bar nor
 * moving focus. Deliberately broader than {@link commandBarOwnsFocus}: a bar
 * left "open" behind a hidden overlay (collapsed window) must not have a tab
 * view take focus either, or keystrokes would land on the page once the
 * overlay is shown again. Used by {@link applyLayout} /
 * {@link reconcileAndApply}'s default ("passive") focus pass, so a layout
 * reconcile that was not triggered by a deliberate user split/focus action
 * (e.g. a background tab closing itself, a non-pane tab closing, a popup
 * opening as a tab, idle sweeping) never closes an open command bar out from
 * under the user.
 */
export function focusTabViewPassively(wc: Electron.WebContents): void {
  if (runtime.commandBar.open && runtime.commandBar.surface === "bar") {
    return;
  }
  wc.focus();
}
