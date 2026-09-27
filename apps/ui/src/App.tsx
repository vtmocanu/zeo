import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { PaneSide, SpaceTheme, Tab, TabsState } from "@zeo/core";
import {
  DEFAULT_CHROME_STATE,
  DEFAULT_SEARCH_ENGINE_ID,
  SINGLE_LAYOUT,
  activeSpaceTheme,
  belowPinnedClip,
  cardLeft,
  clearableTabIds,
  defaultSpaceName,
  formatRelativeArchived,
  formatZoomPercent,
  hostMatchesAllowlist,
  paneOf,
  sidebarSections,
  siteKeyForUrl,
  sidebarVisible,
  toReorderIndex,
} from "@zeo/core";
import { BottomBar, SpaceNameEditor, type SpaceEdit } from "./BottomBar.js";
import { findSpaceItem } from "./dom.js";
import { Favicon } from "./Favicon.js";
import { DRAG_THRESHOLD, suppressNextClick } from "./drag.js";
import { FavoritesGrid } from "./FavoritesGrid.js";
import { Icon } from "./icons.js";
import { UrlPill } from "./UrlPill.js";
import {
  SidebarResizeHandle,
  WindowBackdrop,
  WindowRow,
  useSidebarReveal,
} from "./WindowChrome.js";
import { ThemePicker } from "./ThemePicker.js";
import { useThemeTokens } from "./theme.js";

type DragSection = "pinned" | "unpinned";

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
      (globalThis as { __zeoDrag?: unknown }).__zeoDrag = {
        y: event.clientY,
        target,
      };
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
    suppressNextClick();

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
        return;
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

/**
 * A single tab row. Thin: renders `tab` + active state and dispatches to the
 * injected `window.zeo` bridge. No business logic, no Node/Electron imports.
 * Shows a blocked-count shield when `blockedCount > 0`; when the tab's site is
 * `allowlisted` the shield instead marks blocking as disabled for `host` (no
 * count). The count shield is dimmed when blocking is globally disabled. Shows a
 * clickable zoom badge (sibling of the shield) when `zoomFactor !== 1.0`;
 * clicking it dispatches `zoom.reset` to return the host to actual size.
 *
 * Split view: when the tab occupies a pane (`paneSide !== null`) the row is
 * marked `tab-item--paned` (and `tab-item--pane-focused` for the focused pane),
 * and clicking its title focuses that pane instead of activating the tab. The
 * derived flags come from the parent; this row holds no split logic.
 */
function TabRow({
  tab,
  isActive,
  pinned,
  dragging,
  paneSide,
  paneFocused,
  blockedCount,
  blockingEnabled,
  allowlisted,
  host,
  zoomFactor,
  unloaded,
  onPointerDown,
}: {
  tab: Tab;
  isActive: boolean;
  pinned: boolean;
  dragging: boolean;
  paneSide: PaneSide | null;
  paneFocused: boolean;
  blockedCount: number;
  blockingEnabled: boolean;
  allowlisted: boolean;
  host: string | null;
  zoomFactor: number;
  unloaded: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLLIElement>) => void;
}) {
  const paned = paneSide !== null;
  const className = [
    "tab-item",
    pinned ? "tab-item--pinned" : "",
    isActive ? "tab-item--active" : "",
    dragging ? "tab-item--dragging" : "",
    paned ? "tab-item--paned" : "",
    paneFocused ? "tab-item--pane-focused" : "",
    unloaded ? "tab-item--unloaded" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <li
      className={className}
      data-testid={paned ? "tab-pane" : "tab-item"}
      data-tab-id={tab.id}
      data-pane={paneSide ?? undefined}
      data-unloaded={unloaded ? "true" : undefined}
      aria-current={isActive ? "true" : undefined}
      onPointerDown={onPointerDown}
      onContextMenu={(event) => {
        event.preventDefault();
        void window.zeo?.tabs
          .showContextMenu(tab.id, event.clientX, event.clientY)
          .then((result) => {
            (
              globalThis as { __zeoLastContextMenu?: unknown }
            ).__zeoLastContextMenu = result;
          })
          .catch(() => {});
      }}
    >
      <Favicon url={tab.faviconUrl} title={tab.title} />
      <button
        type="button"
        className="tab-item__title"
        title={tab.url}
        onClick={() =>
          paneSide !== null
            ? void window.zeo?.splitView.focusPane(paneSide).catch(() => {})
            : void window.zeo?.tabs.activate(tab.id).catch(() => {})
        }
      >
        {tab.title}
      </button>
      {zoomFactor !== 1.0 ? (
        <button
          type="button"
          className="tab-item__zoom"
          data-testid="tab-zoom"
          title={`Zoom ${formatZoomPercent(zoomFactor)} — click to reset to actual size`}
          aria-label={`Zoom ${formatZoomPercent(zoomFactor)}, click to reset to actual size`}
          onClick={(event) => {
            event.stopPropagation();
            void window.zeo?.commands.run("zoom.reset").catch(() => {});
          }}
        >
          {formatZoomPercent(zoomFactor)}
        </button>
      ) : null}
      {allowlisted ? (
        <span
          className="tab-item__shield tab-item__shield--allowlisted"
          role="img"
          data-testid="tab-shield"
          data-allowlisted="true"
          title={`Blocking disabled on ${host ?? ""}`}
          aria-label={`Blocking disabled on ${host ?? ""}`}
        >
          <Icon name="shield-off" size={12} />
        </span>
      ) : blockedCount > 0 ? (
        <span
          className={
            "tab-item__shield" +
            (blockingEnabled ? "" : " tab-item__shield--disabled")
          }
          role="img"
          data-testid="tab-shield"
          data-blocked-count={blockedCount}
          title={`${blockedCount} request${blockedCount === 1 ? "" : "s"} blocked`}
          aria-label={`${blockedCount} request${blockedCount === 1 ? "" : "s"} blocked`}
        >
          <Icon name="shield" size={12} />
          <span className="tab-item__shield-count">{blockedCount}</span>
        </span>
      ) : null}
      {!pinned && (
        <button
          type="button"
          className="icon-button tab-item__close"
          aria-label={`Close ${tab.title}`}
          onClick={(event) => {
            event.stopPropagation();
            void window.zeo?.tabs.close(tab.id).catch(() => {});
          }}
        >
          <Icon name="close" size={12} />
        </button>
      )}
    </li>
  );
}

/**
 * A single archived-tab row. Thin sibling of `TabRow`: reuses the exact favicon
 * markup, restores on title click, permanently deletes on the delete button,
 * and shows when the tab was archived. All side effects go through the bridge.
 */
function ArchivedRow({ tab, now }: { tab: Tab; now: number }) {
  return (
    <li
      className="archived-item"
      data-testid="archived-item"
      data-archived-id={tab.id}
    >
      <Favicon url={tab.faviconUrl} title={tab.title} />
      <button
        type="button"
        className="archived-item__title"
        title={tab.url}
        onClick={() => void window.zeo?.tabs.restore(tab.id).catch(() => {})}
      >
        {tab.title}
      </button>
      <span className="archived-item__time" data-testid="archived-time">
        {formatRelativeArchived(tab.archivedAt ?? now, now)}
      </span>
      <button
        type="button"
        className="icon-button archived-item__delete"
        data-testid="archived-delete"
        aria-label={`Delete ${tab.title}`}
        onClick={(event) => {
          event.stopPropagation();
          void window.zeo?.tabs.remove(tab.id).catch(() => {});
        }}
      >
        <Icon name="close" size={12} />
      </button>
    </li>
  );
}

/**
 * Clips the rows below the sticky pinned section where they scroll under it
 * (PRD 10.4 §7.4). The pinned section has no fill over the vibrancy and tint,
 * so instead of painting a ground it would have to fake, the region below it
 * is cut away: `--below-pinned-clip` on `.sidebar__below-pinned` is
 * `belowPinnedClip(scrollTop, pinnedHeight, offsetTop)` px, read by its
 * `clip-path`. Recomputed on scroll and whenever the scroller, the pinned
 * section or the region itself resizes; `0px` without a pinned section.
 */
function useBelowPinnedClip(hasPinned: boolean): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const below = ref.current;
    const scroller = below?.parentElement ?? null;
    if (below === null || scroller === null) {
      return;
    }
    const pinned = hasPinned
      ? scroller.querySelector<HTMLElement>(":scope > .sidebar__section--pinned")
      : null;
    const update = () => {
      const clip =
        pinned === null
          ? 0
          : belowPinnedClip(scroller.scrollTop, pinned.offsetHeight, below.offsetTop);
      below.style.setProperty("--below-pinned-clip", `${clip}px`);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(scroller);
    observer?.observe(below);
    if (pinned !== null) {
      observer?.observe(pinned);
    }
    return () => {
      scroller.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [hasPinned]);
  return ref;
}

/** Whether focus is currently somewhere inside the (still-mounted) theme picker. */
function pickerContainsActiveElement(): boolean {
  const picker = document.querySelector('[data-testid="theme-picker"]');
  const active = document.activeElement;
  return picker !== null && active instanceof Node && picker.contains(active);
}

/**
 * Restores focus after the theme picker closes for a reason other than
 * Escape or an outside pointerdown (both of which already leave focus where
 * they want it — Escape on the space's own `space-item`, an outside press
 * wherever the user clicked). The remaining programmatic close reasons —
 * sidebar collapse, active-space change, the edited space being removed —
 * give `<ThemePicker>` no chance to move focus itself before it unmounts.
 * `hadFocus` tells whether focus was inside the picker right before this
 * particular close; it is a no-op when it wasn't (or when the close was one
 * of the two self-handling reasons above, which never reach this call).
 *
 * For the active-space-change caller the picker is still mounted when this
 * runs (its own unmount is scheduled by that same call site, right after),
 * so `hadFocus` there is a direct DOM check (`pickerContainsActiveElement`).
 * For the sidebar-collapse / edited-space-removal caller the picker has
 * already unmounted in this same commit by the time the effect runs, so
 * `hadFocus` there comes from `ThemePicker`'s own `useLayoutEffect` cleanup
 * (see `reportUnmountFocus` below), captured while its DOM was still present
 * — a plain DOM check at that point would always see `<body>`.
 *
 * Documented limitation: on a FULL sidebar collapse (`sidebarCollapsed &&
 * !sidebarRevealed`) the whole `<aside data-testid="sidebar">` becomes
 * `visibility: hidden` (`.sidebar--hidden`, styles/sidebar.css) in the same
 * commit that unmounts the picker, so no space-item inside it is focusable
 * per the HTML focusability rules — `item?.focus()` below is then a verified
 * no-op and focus falls back to `<body>`. That is the correct outcome of the
 * sidebar itself going invisible, not something this function can prevent.
 */
function restoreFocusFromThemePicker(
  hadFocus: boolean,
  preferredSpaceId: string | null,
  activeSpaceId: string,
): void {
  if (!hadFocus) {
    return;
  }
  const item = (preferredSpaceId !== null ? findSpaceItem(preferredSpaceId) : null) ?? findSpaceItem(activeSpaceId);
  item?.focus();
}

/**
 * Keyboard-first left sidebar listing open tabs. This is the renderer: it
 * reaches the main process ONLY through the injected global `window.zeo`
 * (which implements ZeoApi). No Node or Electron imports.
 */
export function App() {
  const [state, setState] = useState<TabsState>({
    spaces: [],
    activeSpaceId: "",
    profiles: [],
    tabs: [],
    activeTabId: null,
    favorites: [],
    archived: [],
    unloadedTabIds: [],
    settingsOpen: false,
    settings: {
      searchEngine: DEFAULT_SEARCH_ENGINE_ID,
      quickBrowseExternal: true,
      updateCheckEnabled: true,
    },
    settingsSection: "general",
    settingsSectionNonce: 0,
    blocking: {
      enabled: true,
      listVersion: "none",
      blockedByTab: {},
      blockedUnattributed: 0,
      allowlist: [],
    },
    zoom: { byHost: {} },
    downloads: { items: [] },
    find: {
      open: false,
      query: "",
      activeMatch: 0,
      matchCount: 0,
      tabId: null,
      activeRequestId: null,
    },
    quickBrowse: null,
    isDefaultBrowser: false,
    appVersion: "",
    layout: SINGLE_LAYOUT,
    chrome: DEFAULT_CHROME_STATE,
    update: {
      enabled: true,
      origin: "direct",
      available: null,
      checking: false,
      lastCheckedAt: null,
      error: null,
    },
  });
  useThemeTokens(activeSpaceTheme(state));
  const [showArchived, setShowArchived] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Frameless chrome (PRD 10.2): mirror the live sidebar width into a token so
  // CSS can read it, and drive the collapsed sidebar's edge reveal.
  const sidebarWidth = state.chrome.sidebarWidth;
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
  }, [sidebarWidth]);
  useSidebarReveal(state.chrome);

  // Ephemeral inline-edit buffer for the space switcher (create / rename /
  // new-profile). `editRef` mirrors `edit` so a stray blur firing after an
  // Escape-cancel unmounts the input is a guaranteed no-op.
  const [edit, setEditState] = useState<SpaceEdit | null>(null);
  const [draft, setDraft] = useState("");
  const editRef = useRef<SpaceEdit | null>(null);
  const spacesRef = useRef<TabsState["spaces"]>([]);
  const openEdit = useCallback((next: SpaceEdit, initialDraft: string) => {
    editRef.current = next;
    setDraft(initialDraft);
    setEditState(next);
  }, []);
  const cancelEdit = useCallback(() => {
    editRef.current = null;
    setEditState(null);
  }, []);

  // The space whose theme picker is open (PRD 10.3 §6), or null. The picker
  // closes when that space leaves the list, the active space changes or the
  // sidebar hides; it dismisses itself on Escape, outside press and blur.
  const [themeEditSpaceId, setThemeEditSpaceId] = useState<string | null>(null);
  const closeThemePicker = useCallback(() => setThemeEditSpaceId(null), []);
  // Set by ThemePicker's own useLayoutEffect cleanup, just before it unmounts,
  // to whether focus was inside it at that moment; see restoreFocusFromThemePicker.
  const themePickerHadFocusRef = useRef(false);
  const reportThemePickerUnmountFocus = useCallback((hadFocus: boolean) => {
    themePickerHadFocusRef.current = hadFocus;
  }, []);
  const sidebarShown = cardLeft(state.chrome) === state.chrome.sidebarWidth;
  const themeEditSpace =
    themeEditSpaceId !== null && sidebarShown
      ? state.spaces.find((s) => s.id === themeEditSpaceId)
      : undefined;
  useEffect(() => {
    if (themeEditSpaceId !== null && themeEditSpace === undefined) {
      restoreFocusFromThemePicker(themePickerHadFocusRef.current, themeEditSpaceId, state.activeSpaceId);
      themePickerHadFocusRef.current = false;
      setThemeEditSpaceId(null);
    }
  }, [themeEditSpaceId, themeEditSpace, state.activeSpaceId]);
  const activeSpaceId = state.activeSpaceId;
  const lastActiveSpaceId = useRef(activeSpaceId);
  useEffect(() => {
    if (lastActiveSpaceId.current !== activeSpaceId) {
      lastActiveSpaceId.current = activeSpaceId;
      if (themeEditSpaceId !== null) {
        restoreFocusFromThemePicker(pickerContainsActiveElement(), themeEditSpaceId, activeSpaceId);
      }
      setThemeEditSpaceId(null);
    }
  }, [activeSpaceId, themeEditSpaceId]);

  useEffect(() => {
    spacesRef.current = state.spaces;
    const current = editRef.current;
    if (current !== null && current.mode !== "create" && !state.spaces.some((s) => s.id === current.spaceId)) {
      cancelEdit();
    }
  }, [state.spaces, cancelEdit]);

  useEffect(() => {
    if (!showArchived) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [showArchived]);

  useEffect(() => {
    // Guard so a bare browser dev-open (no bridge) doesn't throw. In Electron
    // the preload injects `window.zeo` before the renderer runs.
    if (!window.zeo) {
      return;
    }
    let sawBroadcast = false;
    const unsubState = window.zeo.onStateChange((s) => {
      sawBroadcast = true;
      setState(s);
    });
    const unsubMenu = window.zeo.onSpaceMenuAction((action) => {
      if (action.action === "rename") {
        const space = spacesRef.current.find((s) => s.id === action.spaceId);
        openEdit({ mode: "rename", spaceId: action.spaceId }, space?.name ?? "");
      } else if (action.action === "edit-theme") {
        cancelEdit();
        setThemeEditSpaceId(action.spaceId);
      } else if (action.action === "new-profile") {
        openEdit({ mode: "new-profile", spaceId: action.spaceId }, "");
      }
    });
    window.zeo.tabs
      .list()
      .then((s) => {
        if (!sawBroadcast) {
          setState(s);
        }
      })
      .catch(() => {});
    return () => {
      unsubState();
      unsubMenu();
    };
  }, [openEdit, cancelEdit]);

  const commitEdit = useCallback(() => {
    const current = editRef.current;
    if (!current) {
      return;
    }
    cancelEdit();
    const name = draft.trim();
    if (name.length === 0) {
      // Blank/whitespace-only: cancel rather than dispatch a name the store
      // would reject anyway.
      return;
    }
    if (current.mode !== "create" && !spacesRef.current.some((s) => s.id === current.spaceId)) {
      return;
    }
    if (current.mode === "rename") {
      void window.zeo?.spaces.rename(current.spaceId, name).catch(() => {});
      return;
    }
    if (current.mode === "create") {
      void (async () => {
        try {
          await window.zeo?.spaces.createAndActivate(name);
        } catch {
          // Bridge unavailable or the store rejected the name; the buffer is
          // already discarded, so nothing to roll back.
        }
      })();
      return;
    }
    const spaceId = current.spaceId;
    void (async () => {
      try {
        await window.zeo?.profiles.createAndAssign(spaceId, name);
      } catch {
        // As above: buffer discarded, nothing to roll back.
      }
    })();
  }, [draft, cancelEdit]);

  // `state.tabs` is ordered pinned, today, favorite; `sidebarSections` keeps
  // that order within each group. Favorite tabs are drawn as tiles, never rows.
  const { pinned, today, favoriteTabs } = sidebarSections(state.tabs);
  const clearable = clearableTabIds(state.tabs);
  const activeTab = state.tabs.find((t) => t.id === state.activeTabId) ?? null;
  const openFavoriteIds = new Set(
    favoriteTabs.flatMap((t) => (t.favoriteId === null ? [] : [t.favoriteId])),
  );
  const activeSpace = state.spaces.find((s) => s.id === state.activeSpaceId);

  const { pinnedListRef, unpinnedListRef, onRowPointerDown, dropTarget, draggingId } =
    useTabDrag(pinned, today);
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
        const host = siteKeyForUrl(tab.url);
        const allowlisted =
          host !== null && hostMatchesAllowlist(host, state.blocking.allowlist);
        const zoomFactor =
          tab.id === state.activeTabId && host !== null
            ? (state.zoom.byHost[host] ?? 1.0)
            : 1.0;
        const paneSide = paneOf(state.layout, tab.id);
        children.push(
          <TabRow
            key={tab.id}
            tab={tab}
            isActive={tab.id === state.activeTabId}
            pinned={section === "pinned"}
            dragging={tab.id === draggingId}
            paneSide={paneSide}
            paneFocused={paneSide !== null && tab.id === state.activeTabId}
            blockedCount={state.blocking.blockedByTab[tab.id] ?? 0}
            blockingEnabled={state.blocking.enabled}
            allowlisted={allowlisted}
            host={host}
            zoomFactor={zoomFactor}
            unloaded={state.unloadedTabIds.includes(tab.id)}
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
  const belowPinnedRef = useBelowPinnedClip(showPinned);

  const sidebarClassName = `sidebar${isDragging ? " sidebar--dragging" : ""}${
    sidebarVisible(state.chrome) ? "" : " sidebar--hidden"
  }`;

  const sidebar = (
    <aside className={sidebarClassName} data-testid="sidebar" style={{ width: sidebarWidth }}>
      <WindowRow />
      <UrlPill url={activeTab?.url ?? null} />
      <FavoritesGrid
        favorites={state.favorites}
        activeFavoriteId={activeTab?.favoriteId ?? null}
        openFavoriteIds={openFavoriteIds}
        sidebarWidth={sidebarWidth}
      />
      <h1 className="sidebar__title">{activeSpace?.name ?? ""}</h1>

      <div className="sidebar__sections">
        {showPinned && (
          <section
            className="sidebar__section sidebar__section--pinned"
            data-testid="pinned-section"
            aria-label="Pinned tabs"
          >
            {renderList(pinned, "pinned", pinnedListRef)}
          </section>
        )}
        <div className="sidebar__below-pinned" ref={belowPinnedRef}>
          <div className="sidebar__divider">
            <button
              type="button"
              className="sidebar__clear"
              data-testid="clear-today-button"
              aria-label="Clear today's tabs"
              title="Archive today's tabs"
              disabled={clearable.length === 0}
              onClick={() => void window.zeo?.commands.run("tabs.clearToday").catch(() => {})}
            >
              <Icon name="chevron-down" size={12} />
              Clear
            </button>
          </div>
          <section
            className="sidebar__section"
            data-testid="unpinned-section"
            aria-label="Today's tabs"
          >
            <button
              type="button"
              className="sidebar__new-tab"
              data-testid="new-tab-button"
              onClick={() => void window.zeo?.commandBar.open("new-tab").catch(() => {})}
            >
              <Icon name="plus" size={14} />
              <span className="sidebar__new-tab-label">New Tab</span>
            </button>
            {renderList(today, "unpinned", unpinnedListRef)}
            {state.tabs.length === 0 && <p className="sidebar__empty">No open tabs</p>}
          </section>
        </div>
      </div>

      {state.update.available !== null && (
        <div className="update-banner" data-testid="update-banner" role="status">
          <div className="update-banner__head">
            <span className="update-banner__text">
              Update available: zeo {state.update.available.version}
            </span>
            <button
              type="button"
              className="icon-button update-banner__dismiss"
              aria-label="Dismiss update"
              title="Dismiss"
              onClick={() => void window.zeo?.update.dismiss().catch(() => {})}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
          <button
            type="button"
            className="update-banner__action"
            data-testid="update-banner-action"
            onClick={() =>
              void (state.update.origin === "homebrew"
                ? window.zeo?.commands.run("settings.openGeneral")
                : window.zeo?.update.openRelease()
              )?.catch(() => {})
            }
          >
            {state.update.origin === "homebrew" ? "How to upgrade" : "Open release"}
          </button>
        </div>
      )}

      {edit !== null && (
        <SpaceNameEditor
          edit={edit}
          value={draft}
          onChange={setDraft}
          onCommit={commitEdit}
          onCancel={cancelEdit}
        />
      )}
      {showArchived && (
        <div
          className="archived-view"
          data-testid="archived-view"
          role="region"
          aria-label="Archived tabs"
        >
          {state.archived.length === 0 ? (
            <p className="archived-empty" data-testid="archived-empty">
              No archived tabs
            </p>
          ) : (
            <ul className="archived-list">
              {state.archived.map((tab) => (
                <ArchivedRow key={tab.id} tab={tab} now={now} />
              ))}
            </ul>
          )}
        </div>
      )}

      <BottomBar
        spaces={state.spaces}
        activeSpaceId={state.activeSpaceId}
        downloads={state.downloads.items}
        archivedCount={state.archived.length}
        archivedOpen={showArchived}
        onToggleArchived={() => setShowArchived((open) => !open)}
        onRenameSpace={(space) => openEdit({ mode: "rename", spaceId: space.id }, space.name)}
        onNewSpace={() => openEdit({ mode: "create" }, defaultSpaceName(state.spaces))}
      />
      {themeEditSpace !== undefined && (
        <ThemePicker
          key={themeEditSpace.id}
          space={themeEditSpace}
          sidebarWidth={sidebarWidth}
          onChange={(theme: SpaceTheme) =>
            void window.zeo?.spaces.setTheme(themeEditSpace.id, theme).catch(() => {})
          }
          onClose={closeThemePicker}
          reportUnmountFocus={reportThemePickerUnmountFocus}
        />
      )}
      <SidebarResizeHandle width={sidebarWidth} />
    </aside>
  );

  // The backdrop (window ground, card, drag strip) belongs only to this main
  // sidebar surface; the other ?view= surfaces mount different roots.
  return (
    <>
      <WindowBackdrop chrome={state.chrome} layout={state.layout} />
      {sidebar}
    </>
  );
}
