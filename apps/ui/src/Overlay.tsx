import { useEffect, useState } from "react";
import type { CommandBarState } from "@zeo/core";
import { CommandBar } from "./CommandBar.js";
import { FindBar } from "./FindBar.js";

/**
 * The single overlay WebContentsView (mounted for `?view=command-bar` in
 * {@link "./main.js"}) hosts TWO mutually-exclusive surfaces selected by
 * `CommandBarState.surface`: the command bar (`"bar"`) and the find bar
 * (`"find"`). This thin wrapper subscribes to `onCommandBarChange`, tracks the
 * pushed `surface`, and renders the matching surface. Main owns the overlay's
 * bounds/visibility/focus for whichever surface is active.
 *
 * `CommandBar` and `FindBar` each subscribe to their own state independently, so
 * this wrapper carries only the routing selector.
 */
export function Overlay() {
  const [surface, setSurface] = useState<CommandBarState["surface"]>("bar");

  useEffect(() => {
    // Guard so a bare browser dev-open (no bridge) doesn't throw. In Electron
    // the preload injects `window.zeo` before the renderer runs.
    if (!window.zeo) {
      return;
    }
    const applySurface = (state: CommandBarState): void => {
      setSurface(state.surface);
    };
    const unsubscribe = window.zeo.onCommandBarChange(applySurface);
    void window.zeo.commandBar
      .state()
      .then(applySurface)
      .catch(() => {});
    return unsubscribe;
  }, []);

  // Without the bridge (a bare browser dev-open) fall back to the command bar so
  // the surface still renders.
  if (!window.zeo) {
    return <CommandBar />;
  }
  return surface === "find" ? <FindBar /> : <CommandBar />;
}
