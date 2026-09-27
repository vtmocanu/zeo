import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import type { Favorite, TileBox } from "@zeo/core";
import { favoriteGridColumns, favoriteInsertIndex, toReorderIndex } from "@zeo/core";
import { DRAG_THRESHOLD, suppressNextClick } from "./drag.js";
import { Favicon } from "./Favicon.js";

interface FavoriteDragSession {
  id: string;
  fromIndex: number;
  startX: number;
  startY: number;
  started: boolean;
}

/**
 * Pointer-drag reorder for the favorites grid, modelled on the sidebar's
 * `useTabDrag`: a 5px threshold, document-level `pointermove`/`pointerup`
 * listeners attached on press and removed on release (and on unmount), and
 * click suppression after a real drag. The insertion slot is
 * `favoriteInsertIndex` over the tiles' boxes in reading order; the drop calls
 * `favorites.reorder(id, toReorderIndex(fromIndex, slot))`, skipped when it
 * resolves to a no-op. Tiles and tab rows never drag into each other: each has
 * its own session and target set.
 */
export function useFavoriteDrag(favorites: readonly Favorite[]) {
  const gridRef = useRef<HTMLUListElement | null>(null);
  const sessionRef = useRef<FavoriteDragSession | null>(null);
  const slotRef = useRef<number | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const favoritesRef = useRef(favorites);
  favoritesRef.current = favorites;

  const computeSlot = useCallback((x: number, y: number): number | null => {
    const grid = gridRef.current;
    if (grid === null) {
      return null;
    }
    const boxes: TileBox[] = Array.from(
      grid.querySelectorAll<HTMLElement>("[data-favorite-id]"),
      (tile) => {
        const rect = tile.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      },
    );
    return favoriteInsertIndex(boxes, x, y);
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
      const next = computeSlot(event.clientX, event.clientY);
      slotRef.current = next;
      setSlot(next);
    },
    [computeSlot],
  );

  const finishDrag = useCallback(() => {
    const session = sessionRef.current;
    const target = slotRef.current;
    sessionRef.current = null;
    slotRef.current = null;
    setDraggingId(null);
    setSlot(null);
    if (!session || !session.started) {
      return;
    }
    suppressNextClick();
    if (target === null) {
      return;
    }
    const toIndex = toReorderIndex(session.fromIndex, target);
    if (toIndex !== session.fromIndex) {
      void window.zeo?.favorites.reorder(session.id, toIndex).catch(() => {});
    }
  }, []);

  const handlePointerUp = useCallback(() => {
    document.removeEventListener("pointermove", handlePointerMove);
    document.removeEventListener("pointerup", handlePointerUp);
    finishDrag();
  }, [handlePointerMove, finishDrag]);

  const onTilePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, favoriteId: string) => {
      // Left button only; right-click stays the context menu.
      if (event.button !== 0) {
        return;
      }
      const fromIndex = favoritesRef.current.findIndex((f) => f.id === favoriteId);
      if (fromIndex < 0) {
        return;
      }
      sessionRef.current = {
        id: favoriteId,
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

  useEffect(() => {
    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
    };
  }, [handlePointerMove, handlePointerUp]);

  return { gridRef, onTilePointerDown, slot, draggingId };
}

/** Where the drop bar sits for `index` given the live insertion `slot`. */
export function tileDropEdge(
  index: number,
  count: number,
  slot: number | null,
): "before" | "after" | null {
  if (slot === null) {
    return null;
  }
  if (slot === index) {
    return "before";
  }
  if (slot >= count && index === count - 1) {
    return "after";
  }
  return null;
}

/**
 * The global favorites grid (PRD 10.4 §7.2): up to four columns of 48px
 * tiles, absent when there are no favorites. The tile for the active tab's
 * favorite is raised with `aria-current`; `data-open` says whether the active
 * space has an open tab for it. Click opens or activates that tab; right-click
 * pops the native favorite menu; a drag reorders.
 */
export function FavoritesGrid({
  favorites,
  activeFavoriteId,
  openFavoriteIds,
  sidebarWidth,
}: {
  favorites: readonly Favorite[];
  activeFavoriteId: string | null;
  openFavoriteIds: ReadonlySet<string>;
  sidebarWidth: number;
}): ReactElement | null {
  const { gridRef, onTilePointerDown, slot, draggingId } = useFavoriteDrag(favorites);
  if (favorites.length === 0) {
    return null;
  }
  const columns = favoriteGridColumns(favorites.length, sidebarWidth);
  const className = `favorites-grid${draggingId !== null ? " favorites-grid--dragging" : ""}`;
  return (
    <ul
      ref={gridRef}
      className={className}
      data-testid="favorites-grid"
      aria-label="Favorites"
      style={{ "--favorite-columns": columns } as CSSProperties}
    >
      {favorites.map((favorite, index) => {
        const active = favorite.id === activeFavoriteId;
        const edge = tileDropEdge(index, favorites.length, slot);
        const tileClass = [
          "favorite-tile",
          active ? "favorite-tile--active" : "",
          favorite.id === draggingId ? "favorite-tile--dragging" : "",
          edge === "before" ? "favorite-tile--drop-before" : "",
          edge === "after" ? "favorite-tile--drop-after" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <li key={favorite.id} className="favorites-grid__cell">
            <button
              type="button"
              className={tileClass}
              data-testid="favorite-tile"
              data-favorite-id={favorite.id}
              data-open={openFavoriteIds.has(favorite.id) ? "true" : "false"}
              aria-current={active ? "true" : undefined}
              aria-label={favorite.title}
              title={favorite.url}
              onPointerDown={(event) => onTilePointerDown(event, favorite.id)}
              onClick={() => void window.zeo?.favorites.open(favorite.id).catch(() => {})}
              onContextMenu={(event) => {
                event.preventDefault();
                void window.zeo?.favorites
                  .showContextMenu(favorite.id, event.clientX, event.clientY)
                  .then((result) => {
                    (
                      globalThis as { __zeoLastFavoriteContextMenu?: unknown }
                    ).__zeoLastFavoriteContextMenu = result;
                  })
                  .catch(() => {});
              }}
            >
              <Favicon url={favorite.faviconUrl} title={favorite.title} size={24} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
