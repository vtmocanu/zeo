import type { Profile } from "./profile.js";
import type { SpaceContextMenuItem, SpaceContextMenuResult } from "./ipc.js";

/** Inputs for buildSpaceContextMenu, all read from the SpaceStore by the caller. */
export interface SpaceContextMenuInput {
  spaceId: string;
  profiles: Profile[];
  /** Total tabs the space owns (open + archived): SpaceStore.tabsOfSpace(id).length. */
  tabCount: number;
  /** The space's current profile id: SpaceStore.spaceProfileId(id). */
  currentProfileId: string;
  /** Whether deleting the space is allowed: SpaceStore.canDeleteSpace(id).
   *  When false (the last remaining space) the Delete item is OMITTED entirely. */
  canDelete: boolean;
}

/** Builds the serializable descriptor for a space's native context menu: Rename,
 *  an optional Delete (omitted for the last remaining space, labelled with the tab
 *  count when the space owns any), and a Profile submenu listing every profile —
 *  the current one checked — followed by a "New profile…" entry. Pure and
 *  electron-free so the main process can pop it and a headless test can assert it. */
export function buildSpaceContextMenu(input: SpaceContextMenuInput): SpaceContextMenuResult {
  const items: SpaceContextMenuItem[] = [{ id: "rename", label: "Rename", enabled: true }];
  if (input.canDelete) {
    items.push({
      id: "delete",
      label:
        input.tabCount > 0
          ? `Delete (${input.tabCount} ${input.tabCount === 1 ? "tab" : "tabs"})`
          : "Delete",
      enabled: true,
    });
  }
  const submenu: SpaceContextMenuItem[] = input.profiles.map((p) => ({
    id: `profile:${p.id}`,
    label: p.name,
    enabled: true,
    checked: p.id === input.currentProfileId,
  }));
  submenu.push({ id: "new-profile", label: "New profile…", enabled: true });
  items.push({ id: "profile", label: "Profile", enabled: true, submenu });
  return { spaceId: input.spaceId, items };
}
