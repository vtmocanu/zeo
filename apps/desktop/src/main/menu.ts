import { Menu } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { COMMANDS, menuEntries } from "@zeo/core";
import { runtime } from "./state.js";
import { commandContextOf, executeCommand } from "./commands.js";
import { switchSpace } from "./spaces.js";
import { activateTab } from "./layout.js";

/**
 * Ensures a window exists before a menu-driven command runs. On darwin the app
 * survives `window-all-closed` and the application menu stays live, so an
 * accelerator can fire with no window; recreating one first (never seeding — the
 * in-memory store already reflects the user's state) is the macOS-native behavior
 * and mirrors app.on("activate"). Uses the runtime.createWindow hook so menu.ts
 * adds no import edge to window.ts, keeping `madge --circular` clean.
 */
function ensureWindow(): void {
  if (runtime.win === null) {
    runtime.createWindow?.(false);
  }
}

/**
 * Builds and installs the application menu. Accelerators here are
 * application-level, so they fire whether focus is in the sidebar renderer or
 * inside a tab's WebContentsView — the reason we use a Menu rather than
 * globalShortcut / before-input-event (both forbidden by the PRD).
 */
export function buildMenu(): void {
  const activateItems: MenuItemConstructorOptions[] = Array.from(
    { length: 9 },
    (_unused, i): MenuItemConstructorOptions => ({
      label: `Activate Tab ${i + 1}`,
      accelerator: `CmdOrCtrl+Alt+${i + 1}`,
      visible: false,
      click: () => {
        ensureWindow();
        const tabs = runtime.store.list();
        const target = tabs[i];
        if (target !== undefined) {
          activateTab(target.id);
        }
      },
    }),
  );

  // Registry-generated menu items for a given submenu name: menuEntries collapses
  // the pin/unpin accelerator pair into one entry and computes each entry's
  // label/enabled from the current context; every item dispatches through the
  // single checked boundary executeCommand.
  const context = commandContextOf();
  const registryItems = (name: "tabs" | "spaces" | "view"): MenuItemConstructorOptions[] =>
    menuEntries(
      COMMANDS.filter((c) => c.menu === name),
      context,
    ).map((entry): MenuItemConstructorOptions => ({
      label: entry.label,
      accelerator: entry.accelerator ?? undefined,
      enabled: entry.enabled,
      click: () => {
        ensureWindow();
        try {
          executeCommand(entry.id);
        } catch (err: unknown) {
          // A stale-enabled menu item (e.g. a frozen menu's Go Back after the
          // window was closed and a fresh view has no history) is rejected by
          // executeCommand's enablement check; log rather than throw out of the
          // native menu dispatcher, matching the context-menu closures.
          console.error(`menu command "${entry.id}" failed:`, err);
        }
      },
    }));

  const tabsSubmenu: MenuItemConstructorOptions[] = [
    ...registryItems("tabs"),
    { type: "separator" },
    ...activateItems,
  ];

  const activateSpaceItems: MenuItemConstructorOptions[] = Array.from(
    { length: 9 },
    (_unused, i): MenuItemConstructorOptions => ({
      label: `Activate Space ${i + 1}`,
      accelerator: `CmdOrCtrl+${i + 1}`,
      visible: false,
      click: () => {
        ensureWindow();
        const target = runtime.store.spaces()[i];
        if (target !== undefined) {
          switchSpace(target.id);
        }
      },
    }),
  );

  const spacesSubmenu: MenuItemConstructorOptions[] = [
    ...registryItems("spaces"),
    { type: "separator" },
    ...activateSpaceItems,
  ];

  const viewSubmenu: MenuItemConstructorOptions[] = registryItems("view");

  const template: MenuItemConstructorOptions[] = [
    // macOS app menu (role: appMenu) provides the standard about/quit set;
    // omitting it on darwin would strip Cmd+Q and friends.
    ...(process.platform === "darwin" ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
    { label: "Tabs", submenu: tabsSubmenu },
    { label: "Spaces", submenu: spacesSubmenu },
    { label: "View", submenu: viewSubmenu },
    // editMenu preserves undo/redo/cut/copy/paste/selectAll accelerators so web
    // contents keep Cmd/Ctrl+C/V/X/A.
    { role: "editMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Register the rebuildMenu hook: refreshCommandState (command-bar.ts) calls it on
// every state change so the pin/unpin label and command enablement stay current.
runtime.rebuildMenu = buildMenu;
