import { app, BrowserWindow } from "electron";
import {
  loadStore,
  flush,
  markInterruptedDownloadsOnLaunch,
  listDownloads,
} from "./db.js";
import { runtime, SWEEP_INTERVAL_MS } from "./state.js";
// Side-effect imports: each module registers its ipcMain.handle channels and its
// runtime hooks at load. They MUST all run before app.whenReady so every channel
// and hook is registered before the first renderer invoke or state broadcast.
// (broadcast/overlay/views carry no registrations but are pulled in transitively.)
import "./zoom.js";
import "./settings.js";
import "./find.js";
import "./spaces.js";
import "./command-bar.js";
import "./commands.js";
import { startHistoryPruning } from "./history.js";
import { installDownloadHandler, logDownloadError } from "./downloads.js";
import { startBlocking } from "./blocking.js";
import { buildMenu } from "./menu.js";
import { createWindow } from "./window.js";
import { sweepIdle } from "./tabs.js";
import { unloadIdleViews, viewUnloadIntervalMs } from "./views.js";
import { handleExternalLink, drainExternalLinks } from "./quick-browse.js";
import { flushLayoutSave } from "./layout.js";

// External-link handoff (PRD 7.2). macOS delivers deep links via open-url; a link
// that arrives before whenReady has drained is queued and dispatched by the
// cold-launch drain below, in arrival order, through the same handoff path.
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (!runtime.appReady) {
    runtime.pendingExternalLinks.push(url);
    return;
  }
  handleExternalLink(url);
});

app.whenReady().then(async () => {
  // Restore from disk if a prior session was persisted; otherwise start empty and
  // let createWindow seed the first tab.
  const restored = loadStore();
  const restoredFromDisk = restored !== null;
  if (restored !== null) {
    runtime.store = restored;
    // Reset the idle clock to relaunch time so restored non-active tabs are not
    // archived by the recurring sweep just because the app was closed: re-base
    // every open tab's lastActiveAt so the most-recently-active one sits at now.
    runtime.store.rebaseActivity(Date.now());
  }

  // Prune history older than the retention window once on launch and then every
  // 24 h (a database error is logged once and never blocks startup).
  startHistoryPruning();

  // Seed the in-memory downloads list from disk. The interrupted-on-launch sweep
  // runs FIRST (before listDownloads) so a download left progressing/paused by a
  // crash or quit is loaded as interrupted, never shown as still running. A
  // database error is logged once and leaves an empty list.
  try {
    markInterruptedDownloadsOnLaunch(Date.now());
    runtime.downloads = { items: listDownloads() };
  } catch (err) {
    logDownloadError(err);
  }

  // Content-blocking startup gate (PRD 5.1 §3): degrades gracefully to "blocking
  // off" on any failure. Also seeds the settings, default-browser, and zoom slices.
  await startBlocking();

  // Install the `will-download` handler on every existing profile's session so
  // startup profiles capture downloads, exactly once each (the guard makes the
  // later profilesCreate/remapSpaceProfile calls safe). Placed AFTER the blocking
  // gate so downloads are still captured even if content-blocking setup failed;
  // it is independent of the blocker.
  for (const p of runtime.store.profiles()) {
    installDownloadHandler(p.id);
  }

  buildMenu();
  createWindow(!restoredFromDisk);
  // Skip the launch sweep on a restored session: its tabs' persisted
  // lastActiveAt are stale by design (the app was closed), so an initial sweep
  // would wrongly auto-archive every non-active restored tab. The recurring
  // interval sweep still runs unconditionally.
  if (!restoredFromDisk) {
    sweepIdle();
  }
  setInterval(sweepIdle, SWEEP_INTERVAL_MS);

  // Idle view-unload policy (#40/#58): tear down hidden, silent views left idle
  // past the threshold. No launch-time run — a restored session materializes
  // only the active view already.
  setInterval(() => unloadIdleViews(Date.now()), viewUnloadIntervalMs());

  // Cold-launch drain (PRD 7.2): the window and settings now exist, so dispatch any
  // links that arrived before appReady, in arrival order, through the handoff path.
  // The e2e hook injects a single link deterministically through the SAME queue,
  // gated strictly on ZEO_E2E === "1".
  if (process.env.ZEO_E2E === "1") {
    const coldLaunchUrl = process.env.ZEO_QUICK_BROWSE_URL;
    if (typeof coldLaunchUrl === "string" && coldLaunchUrl !== "") {
      runtime.pendingExternalLinks.push(coldLaunchUrl);
    }
  }
  runtime.appReady = true;
  drainExternalLinks();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // A re-activate must never seed: the in-memory store already reflects the
      // user's state (even if all tabs are archived).
      createWindow(false);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Capture the final store snapshot synchronously at quit, so a mutation that
// never broadcast (e.g. the window-focus lastActiveAt re-stamp) is still saved.
app.on("before-quit", () => {
  flush(runtime.store);
  flushLayoutSave();
});
