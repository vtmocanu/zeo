import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { CommandBar } from "./CommandBar.js";
import { Settings } from "./Settings.js";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root not found");
}

// The command-bar overlay, the settings view, and the main sidebar share this
// bundle; the hosting WebContentsView picks which to mount via the `view` query
// param (main injects `?view=command-bar` for the overlay and `?view=settings`
// for the settings surface), defaulting to the app sidebar.
const view = new URLSearchParams(window.location.search).get("view");

createRoot(container).render(
  <StrictMode>
    {view === "command-bar" ? (
      <CommandBar />
    ) : view === "settings" ? (
      <Settings />
    ) : (
      <App />
    )}
  </StrictMode>,
);
