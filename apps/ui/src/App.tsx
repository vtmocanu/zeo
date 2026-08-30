import { useEffect, useState } from "react";
import type { TabsState } from "@zeo/core";
import { SIDEBAR_WIDTH } from "@zeo/core";
import "./App.css";

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
        <ul className="sidebar__list">
          {state.tabs.map((tab) => {
            const isActive = tab.id === state.activeTabId;
            return (
              <li
                key={tab.id}
                className={isActive ? "tab-item tab-item--active" : "tab-item"}
                data-testid="tab-item"
                aria-current={isActive ? "true" : undefined}
              >
                <button
                  type="button"
                  className="tab-item__title"
                  title={tab.url}
                  onClick={() =>
                    void window.zeo?.tabs.activate(tab.id).catch(() => {})
                  }
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
          })}
        </ul>
      )}
    </aside>
  );
}
