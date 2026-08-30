import { useEffect, useState } from "react";
import type { Tab, TabsState } from "@zeo/core";
import { SIDEBAR_WIDTH } from "@zeo/core";
import "./App.css";

// A single tab row. Thin: renders `tab` + active state and dispatches to the
// injected `window.zeo` bridge. No business logic, no Node/Electron imports.
function TabRow({ tab, isActive, pinned }: {
  tab: Tab;
  isActive: boolean;
  pinned: boolean;
}) {
  const hasFavicon =
    typeof tab.faviconUrl === "string" && tab.faviconUrl.length > 0;
  const className = [
    "tab-item",
    pinned ? "tab-item--pinned" : "",
    isActive ? "tab-item--active" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <li
      className={className}
      data-testid="tab-item"
      aria-current={isActive ? "true" : undefined}
    >
      {hasFavicon ? (
        <img className="tab-item__favicon" src={tab.faviconUrl ?? ""} alt="" />
      ) : (
        <span
          className="tab-item__favicon tab-item__favicon--fallback"
          aria-hidden="true"
        >
          ◦
        </span>
      )}
      <button
        type="button"
        className="tab-item__title"
        title={tab.url}
        onClick={() => void window.zeo?.tabs.activate(tab.id).catch(() => {})}
      >
        {tab.title}
      </button>
      <button
        type="button"
        className="tab-item__close"
        aria-label={`Close ${tab.title}`}
        onClick={(event) => {
          event.stopPropagation();
          void window.zeo?.tabs.close(tab.id).catch(() => {});
        }}
      >
        ×
      </button>
    </li>
  );
}

// Keyboard-first left sidebar listing open tabs. This is the renderer: it
// reaches the main process ONLY through the injected global `window.zeo`
// (which implements ZeoApi). No Node or Electron imports.
export function App() {
  const [state, setState] = useState<TabsState>({
    tabs: [],
    activeTabId: null,
    archived: [],
  });

  useEffect(() => {
    // Guard so a bare browser dev-open (no bridge) doesn't throw. In Electron
    // the preload injects `window.zeo` before the renderer runs.
    if (!window.zeo) {
      return;
    }
    let sawBroadcast = false;
    const unsub = window.zeo.onStateChange((s) => {
      sawBroadcast = true;
      setState(s);
    });
    window.zeo.tabs
      .list()
      .then((s) => {
        if (!sawBroadcast) {
          setState(s);
        }
      })
      .catch(() => {});
    return unsub;
  }, []);

  // `state.tabs` is already ordered pinned-first then unpinned; filtering
  // preserves that order within each section.
  const pinned = state.tabs.filter((t) => t.pinned);
  const unpinned = state.tabs.filter((t) => !t.pinned);

  return (
    <aside
      className="sidebar"
      data-testid="sidebar"
      style={{ width: SIDEBAR_WIDTH }}
    >
      <header className="sidebar__header">
        <h1 className="sidebar__title">Tabs</h1>
        <button
          type="button"
          className="sidebar__new-tab"
          data-testid="new-tab-button"
          onClick={() => void window.zeo?.tabs.create().catch(() => {})}
        >
          + New tab
        </button>
      </header>

      {state.tabs.length === 0 ? (
        <p className="sidebar__empty">No open tabs</p>
      ) : (
        <div className="sidebar__sections">
          {pinned.length > 0 && (
            <section
              className="sidebar__section sidebar__section--pinned"
              data-testid="pinned-section"
            >
              <ul className="sidebar__list sidebar__list--pinned">
                {pinned.map((tab) => (
                  <TabRow
                    key={tab.id}
                    tab={tab}
                    isActive={tab.id === state.activeTabId}
                    pinned
                  />
                ))}
              </ul>
            </section>
          )}
          {unpinned.length > 0 && (
            <section
              className="sidebar__section"
              data-testid="unpinned-section"
            >
              <ul className="sidebar__list">
                {unpinned.map((tab) => (
                  <TabRow
                    key={tab.id}
                    tab={tab}
                    isActive={tab.id === state.activeTabId}
                    pinned={false}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </aside>
  );
}
