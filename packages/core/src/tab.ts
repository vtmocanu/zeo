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
}
