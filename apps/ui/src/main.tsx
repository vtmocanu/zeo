import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { Overlay } from "./Overlay.js";
import { QuickBrowse } from "./QuickBrowse.js";
import { Settings } from "./Settings.js";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root not found");
}

// The command-bar overlay, the settings view, the quick-browse chrome, and the
// main sidebar share this bundle; the hosting WebContentsView picks which to
// mount via the `view` query param (main injects `?view=command-bar` for the
// overlay, `?view=settings` for the settings surface, and `?view=quick-browse`
// for the quick-browse chrome), defaulting to the app sidebar.
const view = new URLSearchParams(window.location.search).get("view");

createRoot(container).render(
  <StrictMode>
    {view === "command-bar" ? (
      <Overlay />
    ) : view === "settings" ? (
      <Settings />
    ) : view === "quick-browse" ? (
      <QuickBrowse />
    ) : (
      <App />
    )}
  </StrictMode>,
);
