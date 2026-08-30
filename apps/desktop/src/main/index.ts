import { app } from "electron";
import { CORE_PLACEHOLDER } from "@zeo/core";

// Placeholder main process. The real window, WebContentsView tabs, and typed
// IPC bridge backed by TabStore land in a later milestone (m3). For now this is
// a compiling stub that references electron and @zeo/core so the bundling and
// externalization config is exercised. It does not open a window yet.
void CORE_PLACEHOLDER;

app.whenReady().then(() => {
  // Window creation lands in m3.
});
