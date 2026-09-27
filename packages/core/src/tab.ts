/**
 * A single browser tab in the Zeo domain model.
 *
 * This is a plain data record with no behavior; the ordering and active-tab
 * lifecycle live in {@link TabStore}.
 */
export interface Tab {
  id: string;
  url: string;
  title: string;
  /**
   * URL of the tab's favicon, or `null` until a `page-favicon-updated` event
   * supplies one.
   */
  faviconUrl: string | null;
  createdAt: number;
  pinned: boolean;
  lastActiveAt: number;
  archivedAt: number | null;
  /**
   * The id of the {@link Favorite} this tab is the open instance of, or `null`
   * for an ordinary tab. A tab with a non-null `favoriteId` is that favorite's
   * instance in its space: it is never pinned, never archived, and is drawn as
   * the favorite tile, not as a row.
   */
  favoriteId: string | null;
}
