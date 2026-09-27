import type { TabContextMenuItem } from "./ipc.js";

/** The maximum number of favorites the global list can hold. */
export const FAVORITES_MAX = 12;

/**
 * A single global favorite tile: a saved url/title/favicon that any space can
 * open its own tab for. `position` is always the contiguous index `0..n-1` in
 * display order; every mutation renumbers the whole array.
 */
export interface Favorite {
  id: string;
  url: string;
  title: string;
  /**
   * Lets a tile show its icon while no tab for it is currently open in any
   * space.
   */
  faviconUrl: string | null;
  position: number;
  createdAt: number;
}

/**
 * The descriptor returned by `FavoritesApi.showContextMenu`: the favorite the
 * menu was built for and the items it offers.
 */
export interface FavoriteContextMenuResult {
  favoriteId: string;
  items: TabContextMenuItem[];
}
