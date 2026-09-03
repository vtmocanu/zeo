import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { formatAccelerator } from "@zeo/core";
import type { CommandBarMode, CommandBarState, Suggestion } from "@zeo/core";
import "./App.css";

/**
 * A per-kind glyph placeholder for a suggestion row. The {@link Suggestion} type
 * carries no favicon url, so every kind (tabs included) uses a text/emoji glyph
 * rather than a fetched favicon.
 */
function iconFor(suggestion: Suggestion): string {
  switch (suggestion.kind) {
    case "tab":
      return "🌐";
    case "archived-tab":
      return "🗄";
    case "space":
      return "▦";
    case "navigate":
      return "→";
    case "search":
      return "🔍";
    case "command":
      return "⚡";
  }
}

/** The primary (main) text for a suggestion row, by kind. */
function primaryText(suggestion: Suggestion): string {
  switch (suggestion.kind) {
    case "tab":
    case "archived-tab":
      return suggestion.title;
    case "space":
      return suggestion.name;
    case "navigate":
    case "search":
      return suggestion.label;
    case "command":
      return suggestion.title;
  }
}

/**
 * The muted secondary text for a suggestion row, or `""` when the kind has none.
 * For `tab` this is the host of its url (raw url when it does not parse).
 */
function secondaryText(suggestion: Suggestion): string {
  switch (suggestion.kind) {
    case "tab":
      try {
        return new URL(suggestion.url).host;
      } catch {
        return suggestion.url;
      }
    case "archived-tab":
      return `Archived · ${suggestion.spaceName}`;
    case "space":
      return "Space";
    case "navigate":
    case "search":
      return "";
    case "command":
      return "Command";
  }
}

/**
 * The command-bar overlay: a single-input panel mounted in its own
 * WebContentsView (selected by `?view=command-bar` in {@link "./main.js"}).
 *
 * This is a thin renderer with no business logic — it holds only the input's
 * text plus the pushed suggestion list/selection, and reaches main exclusively
 * through `window.zeo`. Main owns the suggestion list, the ranking, and the
 * URL/navigate decision. Enter calls `commandBar.accept()` (acting on the
 * selected row, or falling back to submit-like behavior in main when the list is
 * empty) and the arrows call `commandBar.moveSelection`; the renderer never
 * resolves urls or reorders rows itself.
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
  // Main owns the suggestion list and the selected row; the renderer only
  // stores what is pushed and never computes or reorders them.
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  // The revision of the suggestion list currently rendered. Echoed back to main
  // on a row click so a click that raced a newer pushed list is rejected there.
  const [revision, setRevision] = useState(0);
  // The bar's current mode, kept in React state (not just `prevModeRef`) so the
  // input placeholder re-renders when an already-open bar switches modes.
  const [mode, setMode] = useState<CommandBarMode>("navigate");
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
      // The suggestions and selection are pushed on every broadcast (main
      // recomputes them on each keystroke), not only on open.
      setSuggestions(state.suggestions);
      setSelectedIndex(state.selectedIndex);
      setRevision(state.revision);
      setMode(state.mode);
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

  /**
   * Routes the input's keys to main and guards each call so a missing bridge or
   * rejected promise is a no-op. Enter/Arrows go through the new suggestion API:
   * `accept` (no index) acts on the selected row and falls back to submitting the
   * query when the list is empty, so row-0 / empty-list behavior is preserved;
   * the arrows ask main to move the selection.
   */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      void window.zeo?.commandBar.accept().catch(() => {});
    } else if (event.key === "Escape") {
      event.preventDefault();
      void window.zeo?.commandBar.close().catch(() => {});
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      void window.zeo?.commandBar.moveSelection(1).catch(() => {});
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      void window.zeo?.commandBar.moveSelection(-1).catch(() => {});
    }
  };

  /**
   * Accepts the clicked row via `commandBar.accept(index, revision)`. Uses
   * `onMouseDown` with `preventDefault` rather than `onClick`: main closes the
   * bar on the overlay's blur, and a plain click would first blur the input
   * (firing that blur→close) before the accept ran. Preventing the default keeps
   * focus on the input so the bar is still open when `accept` reaches main. The
   * rendered `revision` is passed so main rejects a click that raced a newer
   * pushed suggestion list (the clicked index would otherwise resolve against
   * different rows).
   */
  const onRowMouseDown = (
    event: ReactMouseEvent<HTMLDivElement>,
    index: number,
  ): void => {
    event.preventDefault();
    void window.zeo?.commandBar.accept(index, revision).catch(() => {});
  };

  return (
    <div className="command-bar" data-testid="command-bar">
      <input
        ref={inputRef}
        className="command-bar__input"
        data-testid="command-bar-input"
        type="text"
        value={value}
        placeholder={
          mode === "commands" ? "Run a command" : "Search or enter address"
        }
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => {
          setValue(event.target.value);
          // Ask main to recompute suggestions on every change.
          void window.zeo?.commandBar.setQuery(event.target.value).catch(() => {});
        }}
        onKeyDown={onKeyDown}
      />
      {suggestions.length > 0 && (
        <div className="command-bar__list" role="listbox">
          {suggestions.map((suggestion, index) => {
            const selected = index === selectedIndex;
            const secondary = secondaryText(suggestion);
            return (
              <div
                key={index}
                className={
                  selected
                    ? "command-bar__row command-bar__row--selected"
                    : "command-bar__row"
                }
                data-testid="command-bar-suggestion"
                data-kind={suggestion.kind}
                role="option"
                aria-selected={selected}
                onMouseDown={(event) => onRowMouseDown(event, index)}
              >
                <span className="command-bar__row-icon" aria-hidden="true">
                  {iconFor(suggestion)}
                </span>
                <span className="command-bar__row-text">
                  <span className="command-bar__row-primary">
                    {primaryText(suggestion)}
                  </span>
                  {secondary !== "" && (
                    <span className="command-bar__row-secondary">{secondary}</span>
                  )}
                </span>
                {suggestion.kind === "command" &&
                  suggestion.accelerator !== null && (
                    <span className="command-bar__row-accel">
                      {formatAccelerator(suggestion.accelerator)}
                    </span>
                  )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
