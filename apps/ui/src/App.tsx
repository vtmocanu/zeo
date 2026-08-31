import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { Tab, TabsState } from "@zeo/core";
import { SIDEBAR_WIDTH } from "@zeo/core";
import "./App.css";

// Pointer travel (px) required before a press turns into a drag. Below this a
// press stays a plain click, so click-to-activate / click-to-close keep working.
const DRAG_THRESHOLD = 5;

type DragSection = "pinned" | "unpinned";

// Mutable per-drag bookkeeping. Held in a ref (never state) so the document
// pointer listeners always read the live session without stale closures.
interface DragSession {
  id: string;
  sourcePinned: boolean;
  fromIndex: number;
  startX: number;
  startY: number;
  started: boolean;
}

// The computed insertion point: which section the pointer is over, and the slot
// (0..len, "insert before the row at this index"; len == append) inside it.
interface DropTarget {
  section: DragSection;
  insertBefore: number;
}

/**
 * Pure translation from a drop slot to the `TabStore.reorder` index.
 *
 * `TabStore.reorder(id, toIndex)` removes the target from its group first, then
 * splice-inserts at `clamp(toIndex, 0, group.length - 1)` where `group.length`
 * still counts the target. So a slot computed against the pre-removal array
 * (`insertBefore`) must be shifted down by one when it sits after the row's
 * current position. Kept as a standalone function so it is trivially testable.
 */
export function toReorderIndex(fromIndex: number, insertBefore: number): number {
  return insertBefore > fromIndex ? insertBefore - 1 : insertBefore;
}

/**
 * Self-contained pointer-drag session for the tab sidebar. Keeps the component
 * thin: all mutable drag state lives in refs here, document-level
 * `pointermove`/`pointerup` listeners are attached on press and removed on drop
 * (and on unmount), and every bridge call is guarded like the click handlers.
 *
 * Reorder arithmetic:
 * - Within a section: `reorder(id, toReorderIndex(fromIndex, insertBefore))`,
 *   skipped when it resolves to a no-op.
 * - Across the pinned/unpinned boundary: `pin`/`unpin` (the store appends the
 *   tab to the END of the target group), then `reorder(id, insertBefore)` where
 *   `insertBefore` is the slot in the TARGET section; skipped when it is the end
 *   slot (already appended there).
 */
function useTabDrag(pinned: Tab[], unpinned: Tab[]) {
  const pinnedListRef = useRef<HTMLUListElement | null>(null);
  const unpinnedListRef = useRef<HTMLUListElement | null>(null);
  const sessionRef = useRef<DragSession | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // Latest section arrays, mirrored into refs so the pointerup closure reads the
  // pre-move ordering/lengths without being recreated on every render.
  const pinnedRef = useRef(pinned);
  const unpinnedRef = useRef(unpinned);
  pinnedRef.current = pinned;
  unpinnedRef.current = unpinned;

  // Pointer -> { section, insertBefore }. Section is the list whose rect
  // contains y, else the nearest available list; insertBefore counts rows whose
  // vertical midpoint sits above y.
  const computeDropTarget = useCallback((clientY: number): DropTarget | null => {
    const lists: { section: DragSection; el: HTMLUListElement }[] = [];
    if (pinnedListRef.current) {
      lists.push({ section: "pinned", el: pinnedListRef.current });
    }
    if (unpinnedListRef.current) {
      lists.push({ section: "unpinned", el: unpinnedListRef.current });
    }
    if (lists.length === 0) {
      return null;
    }

    let chosen = lists[0];
    const containing = lists.find(({ el }) => {
      const rect = el.getBoundingClientRect();
      return clientY >= rect.top && clientY <= rect.bottom;
    });
    if (containing) {
      chosen = containing;
    } else {
      let best = Number.POSITIVE_INFINITY;
      for (const item of lists) {
        const rect = item.el.getBoundingClientRect();
        const distance =
          clientY < rect.top ? rect.top - clientY : clientY - rect.bottom;
        if (distance < best) {
          best = distance;
          chosen = item;
        }
      }
    }

    const rows = Array.from(
      chosen.el.querySelectorAll<HTMLElement>("[data-tab-id]"),
    );
    let insertBefore = 0;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (rect.top + rect.height / 2 < clientY) {
        insertBefore += 1;
      }
    }
    insertBefore = Math.max(0, Math.min(insertBefore, rows.length));
    return { section: chosen.section, insertBefore };
  }, []);

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      const session = sessionRef.current;
      if (!session) {
        return;
      }
      if (!session.started) {
        const dx = event.clientX - session.startX;
        const dy = event.clientY - session.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) {
          return;
        }
        session.started = true;
        setDraggingId(session.id);
      }
      const target = computeDropTarget(event.clientY);
      dropTargetRef.current = target;
      setDropTarget(target);
    },
    [computeDropTarget],
  );

  const finishDrag = useCallback(() => {
    const session = sessionRef.current;
    const target = dropTargetRef.current;
    sessionRef.current = null;
    dropTargetRef.current = null;
    setDraggingId(null);
    setDropTarget(null);

    if (!session || !session.started) {
      return;
    }

    // A real drag just ended; swallow the click the browser fires on release so
    // it does not activate/close the row the pointer happens to be over.
    const suppressClick = (clickEvent: MouseEvent) => {
      clickEvent.stopPropagation();
      clickEvent.preventDefault();
      document.removeEventListener("click", suppressClick, true);
    };
    document.addEventListener("click", suppressClick, true);
    window.setTimeout(() => {
      document.removeEventListener("click", suppressClick, true);
    }, 0);

    if (!target) {
      return;
    }

    const id = session.id;
    const targetPinned = target.section === "pinned";
    if (targetPinned === session.sourcePinned) {
      const toIndex = toReorderIndex(session.fromIndex, target.insertBefore);
      if (toIndex !== session.fromIndex) {
        void window.zeo?.tabs.reorder(id, toIndex).catch(() => {});
      }
      return;
    }

    // Cross-boundary: move the tab into the other group (appended at its end),
    // then slide it to the drop slot. Skip the reorder when the slot is the end.
    const targetLen = targetPinned
      ? pinnedRef.current.length
      : unpinnedRef.current.length;
    void (async () => {
      // One try/catch so a failed pin/unpin skips the follow-up reorder: were
      // they caught independently, a rejected pin would leave the tab in its
      // source group and the reorder would then move it to a wrong index there.
      try {
        if (targetPinned) {
          await window.zeo?.tabs.pin(id);
        } else {
          await window.zeo?.tabs.unpin(id);
        }
        if (target.insertBefore < targetLen) {
          await window.zeo?.tabs.reorder(id, target.insertBefore);
        }
      } catch {
        // Best-effort: the drag is a UI convenience, the store stays consistent.
      }
    })();
  }, []);

  const handlePointerUp = useCallback(() => {
    document.removeEventListener("pointermove", handlePointerMove);
    document.removeEventListener("pointerup", handlePointerUp);
    finishDrag();
  }, [handlePointerMove, finishDrag]);

  const onRowPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLLIElement>, tab: Tab, sourcePinned: boolean) => {
      // Left button only; leave right-click for the context menu.
      if (event.button !== 0) {
        return;
      }
      const section = sourcePinned ? pinnedRef.current : unpinnedRef.current;
      const fromIndex = section.findIndex((t) => t.id === tab.id);
      if (fromIndex < 0) {
        return;
      }
      sessionRef.current = {
        id: tab.id,
        sourcePinned,
        fromIndex,
        startX: event.clientX,
        startY: event.clientY,
        started: false,
      };
      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", handlePointerUp);
    },
    [handlePointerMove, handlePointerUp],
  );

  // Safety net: detach any lingering listeners if we unmount mid-drag.
  useEffect(() => {
    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
    };
  }, [handlePointerMove, handlePointerUp]);

  return {
    pinnedListRef,
    unpinnedListRef,
    onRowPointerDown,
    dropTarget,
    draggingId,
  };
}

// A single tab row. Thin: renders `tab` + active state and dispatches to the
// injected `window.zeo` bridge. No business logic, no Node/Electron imports.
function TabRow({
  tab,
  isActive,
  pinned,
  dragging,
  onPointerDown,
}: {
  tab: Tab;
  isActive: boolean;
  pinned: boolean;
  dragging: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLLIElement>) => void;
}) {
  const hasFavicon =
    typeof tab.faviconUrl === "string" && tab.faviconUrl.length > 0;
  const className = [
    "tab-item",
    pinned ? "tab-item--pinned" : "",
    isActive ? "tab-item--active" : "",
    dragging ? "tab-item--dragging" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <li
      className={className}
      data-testid="tab-item"
      data-tab-id={tab.id}
      aria-current={isActive ? "true" : undefined}
      onPointerDown={onPointerDown}
      onContextMenu={(event) => {
        event.preventDefault();
        void window.zeo?.tabs
          .showContextMenu(tab.id, event.clientX, event.clientY)
          .catch(() => {});
      }}
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

  const { pinnedListRef, unpinnedListRef, onRowPointerDown, dropTarget, draggingId } =
    useTabDrag(pinned, unpinned);
  const isDragging = draggingId !== null;

  const dropIndicator = (key: string): ReactNode => (
    <li
      key={key}
      className="drop-indicator"
      data-testid="drop-indicator"
      aria-hidden="true"
    />
  );

  const renderList = (
    rows: Tab[],
    section: DragSection,
    listRef: RefObject<HTMLUListElement | null>,
  ): ReactNode => {
    const isTarget = dropTarget?.section === section;
    const insertBefore = isTarget ? dropTarget.insertBefore : -1;
    const listClassName =
      section === "pinned" ? "sidebar__list sidebar__list--pinned" : "sidebar__list";

    const children: ReactNode[] = [];
    if (rows.length === 0) {
      // Only while dragging does an empty section become a real drop target.
      if (isDragging) {
        children.push(
          <li
            key="dropzone"
            className={`sidebar__dropzone${isTarget ? " sidebar__dropzone--active" : ""}`}
            data-testid="dropzone"
          >
            {isTarget ? dropIndicator("dropzone-indicator") : null}
          </li>,
        );
      }
    } else {
      rows.forEach((tab, index) => {
        if (isTarget && insertBefore === index) {
          children.push(dropIndicator(`indicator-${index}`));
        }
        children.push(
          <TabRow
            key={tab.id}
            tab={tab}
            isActive={tab.id === state.activeTabId}
            pinned={section === "pinned"}
            dragging={tab.id === draggingId}
            onPointerDown={(event) =>
              onRowPointerDown(event, tab, section === "pinned")
            }
          />,
        );
      });
      if (isTarget && insertBefore === rows.length) {
        children.push(dropIndicator("indicator-end"));
      }
    }

    return (
      <ul ref={listRef} className={listClassName} data-section={section}>
        {children}
      </ul>
    );
  };

  const showPinned = pinned.length > 0 || isDragging;
  const showUnpinned = unpinned.length > 0 || isDragging;

  return (
    <aside
      className={`sidebar${isDragging ? " sidebar--dragging" : ""}`}
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
          {showPinned && (
            <section
              className="sidebar__section sidebar__section--pinned"
              data-testid="pinned-section"
            >
              {renderList(pinned, "pinned", pinnedListRef)}
            </section>
          )}
          {showUnpinned && (
            <section
              className="sidebar__section"
              data-testid="unpinned-section"
            >
              {renderList(unpinned, "unpinned", unpinnedListRef)}
            </section>
          )}
        </div>
      )}
    </aside>
  );
}
