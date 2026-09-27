import type { Tab } from "./tab.js";

/** Box sizes the sidebar renderer draws to, shared with `tokens.css`. */
export const URL_PILL_HEIGHT = 34;
export const TAB_ROW_HEIGHT = 34;
export const FAVORITE_TILE_HEIGHT = 48;
export const FAVORITE_TILE_GAP = 6;
export const FAVORITES_MAX_COLUMNS = 4;
export const BOTTOM_BAR_HEIGHT = 32;

/** A tab list partitioned into the three sidebar sections, input order kept. */
export interface SidebarSections {
  pinned: Tab[];
  today: Tab[];
  favoriteTabs: Tab[];
}

/** A tile's screen-space bounding box, used by drag-reorder geometry. */
export interface TileBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Partitions `tabs` into the three sidebar groups — pinned, today (unpinned,
 * `favoriteId === null`) and favorite (unpinned, `favoriteId !== null`) —
 * keeping each group's input order.
 */
export function sidebarSections(tabs: readonly Tab[]): SidebarSections {
  const pinned: Tab[] = [];
  const today: Tab[] = [];
  const favoriteTabs: Tab[] = [];
  for (const tab of tabs) {
    if (tab.pinned) {
      pinned.push(tab);
    } else if (tab.favoriteId !== null) {
      favoriteTabs.push(tab);
    } else {
      today.push(tab);
    }
  }
  return { pinned, today, favoriteTabs };
}

/** The ids of the `today` section — the tabs `tabs.clearToday` archives. */
export function clearableTabIds(tabs: readonly Tab[]): string[] {
  return sidebarSections(tabs).today.map((tab) => tab.id);
}

/**
 * The URL pill's label for `url`: `null`, `""`, `about:blank` and unparseable
 * input give `""`; an `http:`/`https:` url gives its hostname without a
 * leading `www.` (and no port); any other parseable url gives its protocol
 * without the trailing colon (e.g. `data`, `file`, `about`).
 */
export function urlPillLabel(url: string | null): string {
  if (url === null || url === "" || url === "about:blank") {
    return "";
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return parsed.hostname.replace(/^www\./, "");
  }
  return parsed.protocol.replace(/:$/, "");
}

/**
 * The number of columns the favorites grid uses for `count` tiles at
 * `sidebarWidth`: `0` when there are no favorites, else at least 1 and at most
 * both `FAVORITES_MAX_COLUMNS` and `count`, sized to fit tiles of
 * `FAVORITE_TILE_HEIGHT` with `FAVORITE_TILE_GAP` between them inside the
 * sidebar's content width (`sidebarWidth` minus 2×8px padding, plus one gap
 * since there is no trailing gap after the last column).
 */
export function favoriteGridColumns(count: number, sidebarWidth: number): number {
  if (count === 0) {
    return 0;
  }
  const contentWidth = sidebarWidth - 2 * 8 + FAVORITE_TILE_GAP;
  const fit = Math.floor(contentWidth / (FAVORITE_TILE_HEIGHT + FAVORITE_TILE_GAP));
  return Math.max(1, Math.min(FAVORITES_MAX_COLUMNS, count, fit));
}

/**
 * Pure translation from a drop slot to the `TabStore.reorder` index.
 *
 * `TabStore.reorder(id, toIndex)` removes the target from its group first,
 * then splice-inserts at `clamp(toIndex, 0, group.length - 1)` where
 * `group.length` still counts the target. So a slot computed against the
 * pre-removal array (`insertBefore`) must be shifted down by one when it sits
 * after the row's current position.
 */
export function toReorderIndex(fromIndex: number, insertBefore: number): number {
  return insertBefore > fromIndex ? insertBefore - 1 : insertBefore;
}

/**
 * Counts the tiles in `tiles` that precede the pointer at `(x, y)` in reading
 * order: a tile strictly above the pointer (`y > tile.bottom`), or a tile the
 * pointer's row falls within (`tile.top <= y <= tile.bottom`) when the pointer
 * sits past its horizontal midpoint (`x > (left + right) / 2`). The result is
 * the insertion index into the (pre-drag) tile array.
 */
export function favoriteInsertIndex(
  tiles: readonly TileBox[],
  x: number,
  y: number,
): number {
  let index = 0;
  for (const tile of tiles) {
    if (y > tile.bottom) {
      index++;
    } else if (y >= tile.top && x > (tile.left + tile.right) / 2) {
      index++;
    }
  }
  return index;
}

/**
 * The clip amount (px) for the below-pinned scroll region: how far the
 * pinned section currently overlaps it, clamped to never go negative.
 */
export function belowPinnedClip(
  scrollTop: number,
  pinnedHeight: number,
  belowOffsetTop: number,
): number {
  return Math.max(0, scrollTop + pinnedHeight - belowOffsetTop);
}
