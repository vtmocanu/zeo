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
  createdAt: number;
  pinned: boolean;
  lastActiveAt: number;
  archivedAt: number | null;
}
