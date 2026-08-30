import { useEffect, useState } from "react";
import type { TabsState } from "@zeo/core";
import "./App.css";

// Keyboard-first left sidebar listing open tabs. This is the renderer: it
// reaches the main process ONLY through the injected global `window.zeo`
// (which implements ZeoApi). No Node or Electron imports.
export function App() {
  const [state, setState] = useState<TabsState>({
    tabs: [],
    activeTabId: null,
  });

  useEffect(() => {
    // Guard so a bare browser dev-open (no bridge) doesn't throw. In Electron
    // the preload injects `window.zeo` before the renderer runs.
    if (!window.zeo) {
      return;
    }
    window.zeo.tabs.list().then(setState);
    const unsub = window.zeo.onStateChange(setState);
    return unsub;
  }, []);

  return (
    <aside className="sidebar" data-testid="sidebar">
      <header className="sidebar__header">
        <h1 className="sidebar__title">Tabs</h1>
        <button
          type="button"
          className="sidebar__new-tab"
          data-testid="new-tab-button"
          onClick={() => window.zeo?.tabs.create()}
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
                  onClick={() => window.zeo?.tabs.activate(tab.id)}
                >
                  {tab.title}
                </button>
                <button
                  type="button"
                  className="tab-item__close"
                  aria-label={`Close ${tab.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    window.zeo?.tabs.close(tab.id);
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
