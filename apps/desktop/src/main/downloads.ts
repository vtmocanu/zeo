import { app, ipcMain, session, shell } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  IPC,
  uniqueFilename,
  safeFilename,
  stripUrlCredentials,
  upsertDownload,
} from "@zeo/core";
import type { Download } from "@zeo/core";
import {
  insertDownload,
  updateDownload,
  deleteDownload,
  clearFinishedDownloadRows,
} from "./db.js";
import {
  removeDownloadSequenced,
  applyDownloadEvent,
  createThrottledPersister,
  cleanupOrphanedDoneItem,
  persistDownloadRow,
  clearFinishedDownloadsSequenced,
} from "./download-ops.js";
import type { ApplyDownloadEventDeps } from "./download-ops.js";
import { runtime } from "./state.js";
import { broadcast, scheduleDownloadsBroadcast } from "./broadcast.js";

/**
 * Logs a downloads database error once per launch and swallows it thereafter, so a
 * failing download write never breaks a download, the command bar, or navigation.
 */
export function logDownloadError(err: unknown): void {
  if (!runtime.downloadErrorLogged) {
    runtime.downloadErrorLogged = true;
    console.error("[downloads] database error; download persistence degraded this launch:", err);
  }
}

/** Collaborators for the shared {@link applyDownloadEvent} helper, wired to the
 *  live in-memory state and the removal guard. */
const applyDownloadEventDeps: ApplyDownloadEventDeps = {
  getState: () => runtime.downloads,
  setState: (next) => {
    runtime.downloads = next;
  },
  removedDownloadIds: runtime.removedDownloadIds,
};

/**
 * The per-download throttled row persister (≤ once/sec per download): each write
 * reads the record LIVE at fire time through the update helper, so it can never
 * write a state older than the live record, and a guarded (removed) id is skipped.
 */
const downloadPersister = createThrottledPersister({
  getRecord: (id) => runtime.downloads.items.find((d) => d.id === id),
  persist: (record) => {
    try {
      updateDownload(record);
    } catch (err) {
      logDownloadError(err);
    }
  },
  removedDownloadIds: runtime.removedDownloadIds,
});

/** The downloads directory: the E2E override when `ZEO_E2E === "1"`, else the OS
 *  downloads folder. Used by `will-download` and `downloads.openFolder`. */
export function downloadsDir(): string {
  // ZEO_DOWNLOADS_DIR is guaranteed set by the e2e harness when ZEO_E2E === "1".
  return process.env.ZEO_E2E === "1" ? process.env.ZEO_DOWNLOADS_DIR! : app.getPath("downloads");
}

/**
 * Installs the `will-download` handler on a profile's `persist:<profileId>`
 * session, exactly once per profile (guarded by {@link downloadSessionProfiles}).
 * NOT gated on content blocking — downloads are always captured. Called at the
 * three sites the blocker attaches (startup, `profilesCreate`, `remapSpaceProfile`),
 * and the guard makes a repeated call a no-op so no session carries two handlers.
 *
 * Each download is saved to {@link downloadsDir} under a sanitized, de-duplicated
 * basename (so no save dialog shows and the path can never escape the directory),
 * recorded through {@link upsertDownload}/{@link insertDownload}, registered in
 * {@link downloadItems} BEFORE the first broadcast, and then tracked via its
 * `updated`/`done` events through the shared {@link applyDownloadEvent} guards.
 */
export function installDownloadHandler(profileId: string): void {
  if (runtime.downloadSessionProfiles.has(profileId)) {
    return;
  }
  runtime.downloadSessionProfiles.add(profileId);
  const ses = session.fromPartition("persist:" + profileId);
  ses.on("will-download", (_event, item, webContents) => {
    const dir = downloadsDir();
    // Sanitize BEFORE de-duplicating so setSavePath only ever receives an absolute
    // path built from a safe basename inside the downloads directory; a reserved
    // name covers an in-flight download whose file does not exist on disk yet.
    const filename = uniqueFilename(
      safeFilename(item.getFilename()),
      (candidate) => existsSync(join(dir, candidate)) || runtime.reservedFilenames.has(candidate),
    );
    const path = join(dir, filename);
    runtime.reservedFilenames.add(filename);
    // setSavePath with an absolute path suppresses the save dialog. A throw here
    // aborts the download entirely: nothing is tracked yet, so release the held
    // name and stop.
    try {
      item.setSavePath(path);
    } catch (err) {
      runtime.reservedFilenames.delete(filename);
      logDownloadError(err);
      return;
    }
    const tabId = runtime.webContentsToTab.get(webContents.id);
    const record: Download = {
      id: randomUUID(),
      url: stripUrlCredentials(item.getURL()),
      filename,
      path,
      totalBytes: item.getTotalBytes(),
      receivedBytes: 0,
      state: "progressing",
      startedAt: Date.now(),
      completedAt: null,
      // A download whose webContents maps to no live tab gets spaceId null; it is
      // never dropped.
      spaceId: tabId !== undefined ? runtime.store.spaceOfTab(tabId) : null,
    };
    // Register the live item BEFORE broadcasting so a cancel/remove arriving as
    // soon as the renderer sees the row finds it.
    runtime.downloadItems.set(record.id, { item, profileId });
    runtime.downloads = upsertDownload(runtime.downloads, record);
    // Persist the row, but keep tracking the live item if only persistence fails:
    // its updated/done listeners, reservation, and in-memory record must survive a
    // DB error (a cap-evicted record couldn't be restored by a rollback anyway).
    persistDownloadRow(record, { insertRow: insertDownload, logError: logDownloadError });
    broadcast({ persist: false });
    const id = record.id;

    item.on("updated", () => {
      const updated = applyDownloadEvent(
        id,
        {
          receivedBytes: item.getReceivedBytes(),
          // A still-live item is progressing unless explicitly paused (no
          // pause/resume UI this PRD, so a resumable interrupt maps to progressing).
          state: item.isPaused() ? "paused" : "progressing",
        },
        applyDownloadEventDeps,
      );
      if (updated === null) {
        return; // removal-guarded or already terminal: no mutate/persist/broadcast
      }
      scheduleDownloadsBroadcast();
      downloadPersister.schedule(id);
    });

    item.on("done", (_doneEvent, state) => {
      // The throttled write is cancelled regardless; the final value is flushed
      // below (normal path), bypassing the 1s throttle.
      downloadPersister.cancel(id);
      // Removal guard: remove(id) removed this record from memory/disk while it was
      // in-flight and cancelled the item. Now its done has fired — release the
      // filename it still held (the reservation is the ONLY one for this name, since
      // the removed record was never reset), drop the registry entry, and clear the
      // guard (bounding the set). No persist/broadcast: the record is already gone.
      if (runtime.removedDownloadIds.has(id)) {
        runtime.reservedFilenames.delete(filename);
        runtime.downloadItems.delete(id);
        runtime.removedDownloadIds.delete(id);
        return;
      }
      const finished = applyDownloadEvent(
        id,
        {
          state,
          completedAt: Date.now(),
          receivedBytes: item.getReceivedBytes(),
        },
        applyDownloadEventDeps,
      );
      if (finished === null) {
        // The record was NOT updated (and is not removal-guarded, handled above), so
        // it is either teardown-terminalized OR cap-evicted while in-flight:
        //  - teardown: terminalizeProfileDownloads already released the filename and
        //    dropped the registry entry, so its entry is now ABSENT — do nothing (a
        //    re-release could steal a new download's reservation of a since-freed name);
        //  - cap-eviction: the 100-cap dropped this record from memory but left this
        //    item's reservation and registry entry, so its entry is still PRESENT and
        //    its reservation is still ours — release it now that done has fired.
        // cleanupOrphanedDoneItem release-and-drops iff the entry is still present.
        cleanupOrphanedDoneItem(id, filename, {
          downloadItems: runtime.downloadItems,
          releaseFilename: (name) => runtime.reservedFilenames.delete(name),
        });
        return;
      }
      // Normal completion: mutate in-memory (above) → persist → release/drop → broadcast.
      try {
        updateDownload(finished);
      } catch (err) {
        logDownloadError(err);
      }
      runtime.reservedFilenames.delete(finished.filename);
      runtime.downloadItems.delete(id);
      broadcast({ persist: false });
    });
  });
}

/**
 * Looks up a completed download and opens its file with the OS handler — only when
 * the record is `completed` AND the file still exists on disk; otherwise a no-op.
 * The mouse-click path for a `download` suggestion row (the renderer handles the
 * keyboard open over the bridge).
 */
export async function openDownloadById(id: string): Promise<void> {
  const record = runtime.downloads.items.find((d) => d.id === id);
  if (record === undefined || record.state !== "completed" || !existsSync(record.path)) {
    return;
  }
  await shell.openPath(record.path);
}

// --- Downloads ----------------------------------------------------------------
// A single trusted global download manager: every handler may act on any record
// by id, with no per-profile/per-space ownership check. Updates ride the existing
// stateChange broadcast on TabsState.downloads; there is no separate channel.

ipcMain.handle(IPC.downloadsList, (): Download[] => runtime.downloads.items);

ipcMain.handle(IPC.downloadsCancel, (_event, id: string): void => {
  // Cancel the live item when active; a finished/unknown/absent id is a no-op. A
  // successful cancel arrives at `done` with `cancelled` through the normal path.
  const entry = runtime.downloadItems.get(id);
  if (entry !== undefined) {
    entry.item.cancel();
  }
});

ipcMain.handle(IPC.downloadsOpen, async (_event, id: string): Promise<void> => {
  // Resolve only when the record is completed AND the file still exists; otherwise
  // reject, changing nothing (the renderer tolerates the reject and keeps the bar).
  const record = runtime.downloads.items.find((d) => d.id === id);
  if (record === undefined || record.state !== "completed" || !existsSync(record.path)) {
    throw new Error(`download not openable: ${id}`);
  }
  await shell.openPath(record.path);
});

ipcMain.handle(IPC.downloadsReveal, async (_event, id: string): Promise<void> => {
  // Show the record's path in Finder when the record exists; an unknown id rejects.
  const record = runtime.downloads.items.find((d) => d.id === id);
  if (record === undefined) {
    throw new Error(`download not found: ${id}`);
  }
  shell.showItemInFolder(record.path);
});

ipcMain.handle(IPC.downloadsRemove, (_event, id: string): Promise<void> =>
  // Commit-first remove through the extracted helper: delete the row, then (only on
  // success, synchronously) drop from memory, guard+cancel a live item, broadcast.
  removeDownloadSequenced(id, {
    getState: () => runtime.downloads,
    setState: (next) => {
      runtime.downloads = next;
    },
    deleteRow: (rid) => deleteDownload(rid),
    downloadItems: runtime.downloadItems,
    removedDownloadIds: runtime.removedDownloadIds,
    broadcast: () => broadcast({ persist: false }),
  }),
);

ipcMain.handle(IPC.downloadsClearFinished, (): void => {
  // Shared with the downloads.clearFinished command: delete the finished rows
  // FIRST, then clear memory + broadcast (a failed delete leaves both untouched so
  // cleared rows can't reappear next launch). Never deletes a file, never touches
  // an active download.
  clearFinishedDownloadsSequenced({
    getState: () => runtime.downloads,
    setState: (next) => {
      runtime.downloads = next;
    },
    clearRows: clearFinishedDownloadRows,
    broadcast,
    logError: logDownloadError,
  });
});
