import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { Overlay } from "./Overlay.js";
import { Settings } from "./Settings.js";
import { Divider } from "./Divider.js";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root not found");
}

// The command-bar overlay, the settings view, the split divider, and the main
// sidebar share this bundle; the hosting WebContentsView picks which to mount via
// the `view` query param (main injects `?view=command-bar` for the overlay,
// `?view=settings` for the settings surface, and `?view=divider` for the
// draggable gutter between split panes), defaulting to the app sidebar.
const view = new URLSearchParams(window.location.search).get("view");

createRoot(container).render(
  <StrictMode>
    {view === "command-bar" ? (
      <Overlay />
    ) : view === "settings" ? (
      <Settings />
    ) : view === "divider" ? (
      <Divider />
    ) : (
      <App />
    )}
  </StrictMode>,
);
