import { IPC } from "@zeo/core";
import { runtime } from "./state.js";
import { closeCommandBar } from "./command-bar.js";

/**
 * The `space.editTheme` command's body, pulled out of `commands.ts` so a unit
 * test can prove the ordering below without mocking every module `commands.ts`
 * imports: close the command bar FIRST, then hand the sidebar the edit-theme
 * action, then focus it.
 *
 * Ordering matters: `acceptCommandBar`'s own `closeCommandBar` (run right
 * after the command handler when this was reached from the command bar)
 * focuses the active tab's page view, which would steal focus from the
 * sidebar right after we hand it the edit-theme action. Calling
 * `closeCommandBar` here first makes that later call a no-op (already
 * closed) instead of a focus-stealer.
 */
export function openSpaceThemeEditor(spaceId: string): void {
  closeCommandBar();
  runtime.win?.webContents.send(IPC.spaceMenuAction, {
    action: "edit-theme",
    spaceId,
  });
  runtime.win?.webContents.focus();
}
