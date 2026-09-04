// Frame preload for @zeo/adblock cosmetic filtering. Plain CommonJS, library-
// free, and frame-agnostic: it runs in EVERY browsing frame including
// cross-origin children (the stock library preload wrongly self-gates to the
// top frame). It works under `sandbox: true`, using only `require("electron")`
// and DOM APIs, and exposes nothing to page scripts.
//
// It talks to the main process over the library's two channels. The first
// invoke carries only the frame url (no message), so the wrapper injects base,
// injection, and hostname rules. Later invokes carry the DOM tokens observed in
// the frame plus a lifecycle marker, so the wrapper injects DOM-driven rules.
const { ipcRenderer } = require("electron");

const INJECT = "@ghostery/adblocker/inject-cosmetic-filters";
const MUTATION = "@ghostery/adblocker/is-mutation-observer-enabled";

if (window.location.href.startsWith("devtools://") === false) {
  const send = (data) => ipcRenderer.invoke(INJECT, window.location.href, data);

  // First call: url only (the wrapper treats a missing message as the first run).
  // Wait until <html> exists before sending: at document-start in a cross-origin
  // child frame the invoke can otherwise reach main and run scriptlets before the
  // parser has created `document.documentElement`, and a scriptlet that touches
  // it would throw against null. Once created, documentElement never disappears,
  // so sending after it exists is safe and still early.
  const sendFirst = () => {
    if (document.documentElement) {
      send();
      return;
    }
    const observer = new MutationObserver(() => {
      if (document.documentElement) {
        observer.disconnect();
        send();
      }
    });
    observer.observe(document, { childList: true });
  };
  sendFirst();

  window.addEventListener(
    "DOMContentLoaded",
    () => {
      // Collect the unique class tokens, ids, and anchor hrefs currently in the
      // document, so the engine can match DOM-scoped cosmetic rules.
      const scan = () => {
        const classes = new Set();
        const ids = new Set();
        const hrefs = new Set();
        const elements = document.querySelectorAll("*");
        for (const el of elements) {
          // SVG elements expose `className` as an object, so read the attribute.
          const classAttr = el.getAttribute("class");
          if (classAttr) {
            for (const token of classAttr.split(/\s+/)) {
              if (token) {
                classes.add(token);
              }
            }
          }
          if (el.id) {
            ids.add(el.id);
          }
          if (el.tagName === "A") {
            const href = el.getAttribute("href");
            if (href) {
              hrefs.add(href);
            }
          }
        }
        return {
          classes: [...classes],
          ids: [...ids],
          hrefs: [...hrefs],
        };
      };

      send({ ...scan(), lifecycle: "start" });

      ipcRenderer
        .invoke(MUTATION)
        .then((enabled) => {
          if (!enabled) {
            return;
          }
          const schedule =
            typeof requestIdleCallback === "function"
              ? (fn) => requestIdleCallback(fn)
              : (fn) => setTimeout(fn, 0);
          let pending = false;
          const observer = new MutationObserver(() => {
            // Coalesce a burst of mutations into one full-document scan + IPC
            // send per idle turn: mutation-heavy pages (infinite scroll, ad
            // rotation) would otherwise walk the whole document and round-trip
            // to main many times per second on the frame's main thread.
            if (pending) {
              return;
            }
            pending = true;
            schedule(() => {
              pending = false;
              send({ ...scan(), lifecycle: "dom-update" });
            });
          });
          observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["class", "id", "href"],
          });
        })
        .catch(() => {});
    },
    { once: true, passive: true },
  );
}
