import { useEffect, useState } from "react";
import type { TabsState } from "@zeo/core";
import "./App.css";

/**
 * The quick-browse chrome bar, mounted in its own WebContentsView (selected by
 * `?view=quick-browse` in {@link "./main.js"}). A thin renderer with no business
 * logic: it mirrors main's full {@link TabsState} and reaches main exclusively
 * through `window.zeo`.
 *
 * State ownership: main pushes the full `TabsState` over `onStateChange`, and
 * `tabs.list()` returns the same shape for the initial seed. This component keeps
 * that mirror and renders the current `quickBrowse` entry (the external link's
 * url and derived title); every action goes back through the bridge, so nothing
 * is kept optimistically.
 *
 * The window-local keys (Escape / Enter / Cmd+Enter / Cmd+Shift+Enter) are owned
 * by the main process — this chrome only renders the entry and the three action
 * buttons and subscribes to state.
 *
 * SECURITY: `quickBrowse.url` and `quickBrowse.title` are UNTRUSTED external
 * content. They are rendered as plain text children (React auto-escapes) and are
 * never placed in an `href`, `window.open`, `dangerouslySetInnerHTML`, or any
 * other URL-executing sink.
 */
export function QuickBrowse() {
  // The mirrored application state; null until the first snapshot/broadcast lands.
  const [state, setState] = useState<TabsState | null>(null);

  useEffect(() => {
    // Guard so a bare browser dev-open (no bridge) doesn't throw. In Electron
    // the preload injects `window.zeo` before the renderer runs.
    if (!window.zeo) {
      return;
    }
    // Broadcasts carry the full TabsState; mirror all of it.
    let sawBroadcast = false;
    const unsubscribe = window.zeo.onStateChange((s) => {
      sawBroadcast = true;
      setState(s);
    });
    // Seed the initial state; tabs.list() returns the full TabsState. Ignore this
    // async snapshot once a broadcast has arrived, so a late initial response can
    // never overwrite a newer state.
    void window.zeo.tabs
      .list()
      .then((s) => {
        if (!sawBroadcast) {
          setState(s);
        }
      })
      .catch(() => {});
    return unsubscribe;
  }, []);

  /** Promote the current link into the active space, then tear the window down. */
  const onPromote = (): void => {
    void window.zeo?.quickBrowse.promote().catch(() => {});
  };

  /** Promote the current link into a chosen space (opens the space picker). */
  const onPromoteToSpace = (): void => {
    void window.zeo?.commands.run("quickBrowse.promoteToSpace").catch(() => {});
  };

  /** Throw the current link away and tear the window down. */
  const onDismiss = (): void => {
    void window.zeo?.quickBrowse.dismiss().catch(() => {});
  };

  // A transient null (e.g. during teardown) renders an empty shell rather than
  // crashing; the entry's url/title stay text-only.
  const quickBrowse = state?.quickBrowse ?? null;

  return (
    <div className="quick-browse" data-testid="quick-browse">
      <div className="quick-browse__meta">
        {quickBrowse !== null && (
          <span className="quick-browse__title" data-testid="quick-browse-title">
            {quickBrowse.title}
          </span>
        )}
        <span className="quick-browse__url" data-testid="quick-browse-url">
          {quickBrowse?.url ?? ""}
        </span>
      </div>
      <div className="quick-browse__actions">
        <button
          type="button"
          className="quick-browse__button"
          data-testid="quick-browse-promote"
          onClick={onPromote}
        >
          Promote
        </button>
        <button
          type="button"
          className="quick-browse__button"
          data-testid="quick-browse-promote-space"
          onClick={onPromoteToSpace}
        >
          Promote to space…
        </button>
        <button
          type="button"
          className="quick-browse__button quick-browse__button--ghost"
          data-testid="quick-browse-dismiss"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
