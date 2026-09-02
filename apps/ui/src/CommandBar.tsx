import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { CommandBarMode, CommandBarState } from "@zeo/core";
import "./App.css";

/**
 * The command-bar overlay: a single-input panel mounted in its own
 * WebContentsView (selected by `?view=command-bar` in {@link "./main.js"}).
 *
 * This is a thin renderer with no business logic — it holds only the input's
 * text and reaches main exclusively through `window.zeo`. Main owns the URL
 * resolution (`resolveInput`) and the navigate/new-tab decision; submitting just
 * forwards the raw text via `commandBar.submit`.
 *
 * The input is re-seeded from `initialText` on every closed→open transition (a
 * fresh open re-seeds even when the text is unchanged) and also when an
 * already-open bar's `mode` changes (so switching an open navigate bar into
 * new-tab mode clears the prior navigate url): `navigate` mode selects the seeded
 * url so typing replaces it, while `new-tab` mode opens empty and only places the
 * caret. The overlay's visibility is driven by main showing/hiding the hosting
 * view, so the panel always renders.
 */
export function CommandBar() {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Tracks the previous `open` so we re-seed on each closed→open transition
  // rather than on every broadcast.
  const prevOpenRef = useRef(false);
  // Tracks the previous `mode` so an already-open bar whose mode changes (e.g.
  // Cmd+L then Cmd+T without closing) re-seeds too — otherwise a navigate→new-tab
  // switch would keep the stale navigate url in the input.
  const prevModeRef = useRef<CommandBarMode>("navigate");
  // Bumped on each open transition to drive the focus/select effect AFTER the
  // seeded value has been committed to the DOM; carries the mode so the effect
  // knows whether to select-all (navigate) or just place the caret (new-tab).
  const [openSeed, setOpenSeed] = useState<{
    token: number;
    mode: CommandBarMode;
  } | null>(null);

  useEffect(() => {
    // Guard so a bare browser dev-open (no bridge) doesn't throw. In Electron
    // the preload injects `window.zeo` before the renderer runs.
    if (!window.zeo) {
      return;
    }
    const applyState = (state: CommandBarState): void => {
      const opening = state.open && !prevOpenRef.current;
      const modeChangedWhileOpen =
        state.open && prevOpenRef.current && state.mode !== prevModeRef.current;
      prevOpenRef.current = state.open;
      prevModeRef.current = state.mode;
      if (opening || modeChangedWhileOpen) {
        setValue(state.initialText);
        setOpenSeed((prev) => ({
          token: (prev?.token ?? 0) + 1,
          mode: state.mode,
        }));
      }
    };
    const unsubscribe = window.zeo.onCommandBarChange(applyState);
    void window.zeo.commandBar
      .state()
      .then(applyState)
      .catch(() => {});
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!openSeed) {
      return;
    }
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    if (openSeed.mode === "navigate") {
      input.select();
    }
  }, [openSeed]);

  /** Handles Enter (submit the raw text) and Escape (close), both routed to
   *  main and guarded so a missing bridge or rejected call is a no-op. */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      void window.zeo?.commandBar.submit(value).catch(() => {});
    } else if (event.key === "Escape") {
      event.preventDefault();
      void window.zeo?.commandBar.close().catch(() => {});
    }
  };

  return (
    <div className="command-bar" data-testid="command-bar">
      <input
        ref={inputRef}
        className="command-bar__input"
        data-testid="command-bar-input"
        type="text"
        value={value}
        placeholder="Search or enter address"
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
