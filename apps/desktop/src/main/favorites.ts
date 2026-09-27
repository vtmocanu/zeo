/**
 * The global-favorites main-process surface (PRD 10.4): the five
 * `zeo:favorites:*` IPC handlers plus the native favorite-tile context menu.
 * Imported for its side effects (its `ipcMain.handle` registrations) from
 * `index.ts`. Deliberately imports `state`, `broadcast`, `views` and `layout`
 * only — NEVER `tabs.js` — so `tabs.ts` can import THIS module (for the
 * native tab menu's favorite/unfavorite item and `clearTodayTabs`) with no
 * cycle (madge --circular clean); `tabs.ts` registers `runtime.closeTabHook`
 * so {@link showFavoriteContextMenu}'s "Close Tab" item can close a favorite's
 * open tab without an import edge back to `tabs.ts`.
 */
import { clipboard, ipcMain, Menu } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { IPC } from "@zeo/core";
import type { Favorite, FavoriteContextMenuResult } from "@zeo/core";
import { runtime } from "./state.js";
import { broadcast, withResync } from "./broadcast.js";
import { createViewFor } from "./views.js";
import { activateTab, reconcileAndApply } from "./layout.js";

/**
 * Opens (or activates) the favorite `id`'s tab in the active space: activates
 * the existing open tab if one already exists, otherwise creates it — the same
 * lifecycle `createTab` runs for an ordinary tab (store entry, view,
 * reconcile, broadcast).
 */
export function openFavorite(id: string): void {
  const existing = runtime.store.favoriteTabId(id);
  if (existing !== null) {
    activateTab(existing);
    return;
  }
  const tab = runtime.store.createFavoriteTab(id);
  createViewFor(tab, runtime.store.activeSpaceId);
  reconcileAndApply();
  broadcast();
}

/** Adds `tabId` as a favorite and broadcasts. Throws propagate to the caller. */
export function addFavorite(tabId: string): Favorite {
  const favorite = runtime.store.addFavorite(tabId);
  broadcast();
  return favorite;
}

/** Removes favorite `id` (unlinking its open tabs in every space) and broadcasts. */
export function removeFavorite(id: string): void {
  runtime.store.removeFavorite(id);
  broadcast();
}

/** Reorders favorite `id` to `toIndex` and broadcasts. */
export function reorderFavorite(id: string, toIndex: number): void {
  runtime.store.reorderFavorite(id, toIndex);
  broadcast();
}

/**
 * Builds the native favorite-tile context menu, mirroring `tabs.ts`'s
 * `showTabContextMenu`: an unknown favorite id returns `items: []`; otherwise
 * `open`, `copyUrl`, `close` (enabled only when the active space has an open
 * tab for it) and `remove`. Gated on `ZEO_E2E`/`runtime.win` like the tab menu
 * so headless e2e never blocks on the native popup.
 */
export function showFavoriteContextMenu(
  favoriteId: string,
  x: number,
  y: number,
): FavoriteContextMenuResult {
  const favorite = runtime.store.favorites().find((f) => f.id === favoriteId);
  if (favorite === undefined) {
    return { favoriteId, items: [] };
  }

  const openTabId = runtime.store.favoriteTabId(favoriteId);

  const actions: { id: string; label: string; enabled: boolean; click: () => void }[] = [
    {
      id: "open",
      label: "Open",
      enabled: true,
      click: () => openFavorite(favoriteId),
    },
    {
      id: "copyUrl",
      label: "Copy URL",
      enabled: true,
      click: () => clipboard.writeText(favorite.url),
    },
    {
      id: "close",
      label: "Close Tab",
      enabled: openTabId !== null,
      click: () => {
        if (openTabId !== null) {
          runtime.closeTabHook?.(openTabId);
        }
      },
    },
    {
      id: "remove",
      label: "Remove from Favorites",
      enabled: true,
      click: () => removeFavorite(favoriteId),
    },
  ];

  const items: FavoriteContextMenuResult["items"] = actions.map(({ id, label, enabled }) => ({
    id,
    label,
    enabled,
  }));

  if (process.env.ZEO_E2E !== "1" && runtime.win !== null) {
    const menu = Menu.buildFromTemplate(
      actions.map((a): MenuItemConstructorOptions => ({
        label: a.label,
        enabled: a.enabled,
        click: () => {
          try {
            a.click();
          } catch (err: unknown) {
            console.error(`favorite context-menu action "${a.id}" failed:`, err);
            broadcast();
          }
        },
      })),
    );
    menu.popup({ window: runtime.win!, x, y });
  }

  return { favoriteId, items };
}

ipcMain.handle(IPC.favoritesOpen, (_event, id: string): void => {
  withResync(() => openFavorite(id));
});

ipcMain.handle(IPC.favoritesAdd, (_event, tabId: string): Favorite =>
  withResync(() => addFavorite(tabId)),
);

ipcMain.handle(IPC.favoritesRemove, (_event, id: string): void => {
  withResync(() => removeFavorite(id));
});

ipcMain.handle(IPC.favoritesReorder, (_event, id: string, toIndex: number): void => {
  withResync(() => reorderFavorite(id, toIndex));
});

ipcMain.handle(
  IPC.favoritesContextMenu,
  (_event, favoriteId: string, x: number, y: number): FavoriteContextMenuResult =>
    showFavoriteContextMenu(favoriteId, x, y),
);
