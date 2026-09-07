import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { FindState } from "@zeo/core";
import "./App.css";

/**
 * The find-in-page surface of the single overlay WebContentsView, mounted by
 * {@link "./Overlay.js"} exactly when `CommandBarState.surface === "find"`.
 *
 * A thin renderer with no business logic: it holds only the input's local text
 * plus the pushed active-match/total counts, and reaches main exclusively
 * through `window.zeo`. Main owns `findInPage`, the highlight lifecycle, and the
 * overlay's bounds/visibility/focus; the renderer just fills the viewport main
 * sizes for it (360×44).
 *
 * The counter reads `activeMatch`/`matchCount` from the pushed `TabsState.find`
 * (delivered on `onStateChange`), never from local state. The input's `value`
 * is seeded ONCE from the committed `find.query` on mount (usually empty, since
 * a fresh open resets the query) and thereafter owned by the user's typing;
 * live pushes never overwrite it, so the debounced `setQuery` and the keystrokes
 * that drive it are never fought by an echoed query.
 */
export function FindBar() {
  const [value, setValue] = useState("");
  // The counter reflects the pushed find state, not local input state.
  const [activeMatch, setActiveMatch] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Debounce timer for setQuery; cleared on each change and on unmount.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Guard so a bare browser dev-open (no bridge) doesn't throw. In Electron
    // the preload injects `window.zeo` before the renderer runs.
    if (!window.zeo) {
      return;
    }
    const applyCounter = (find: FindState): void => {
      setActiveMatch(find.activeMatch);
      setMatchCount(find.matchCount);
    };
    const unsubscribe = window.zeo.onStateChange((state) => {
      applyCounter(state.find);
    });
    // Seed the counter and the input value once from the current session. The
    // input is seeded here (not in the listener) so live pushes never fight the
    // user's typing; the committed query is usually empty on a fresh open.
    void window.zeo.find
      .state()
      .then((find) => {
        applyCounter(find);
        setValue(find.query);
      })
      .catch(() => {});
    return unsubscribe;
  }, []);

  useEffect(() => {
    // FindBar mounts exactly when the find surface opens, so focus and select
    // the input on mount. Re-focusing an already-open bar re-selects via the
    // input's onFocus handler (PRD decision 6).
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    input.select();
  }, []);

  useEffect(() => {
    // Clear any pending debounce timer when the surface unmounts.
    return () => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  /**
   * Enter cycles forward, Shift+Enter backward, and Escape closes (main returns
   * focus to the page). Each bridge call is guarded so a missing bridge or a
   * rejected promise is a no-op.
   */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        void window.zeo?.find.previous().catch(() => {});
      } else {
        void window.zeo?.find.next().catch(() => {});
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      void window.zeo?.find.close().catch(() => {});
    }
  };

  /**
   * Updates the local input value immediately (a controlled input) and pushes
   * the query to main debounced 50 ms, so a burst of keystrokes issues one
   * search. The counter is not debounced — it reflects the pushed find state.
   */
  const onChange = (event: ReactChangeEvent<HTMLInputElement>): void => {
    const text = event.target.value;
    setValue(text);
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void window.zeo?.find.setQuery(text).catch(() => {});
    }, 50);
  };

  return (
    <div className="find-bar" data-testid="find-bar">
      <input
        ref={inputRef}
        className="find-bar__input"
        data-testid="find-input"
        type="text"
        value={value}
        spellCheck={false}
        autoComplete="off"
        onFocus={(event) => event.currentTarget.select()}
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
      <span className="find-bar__count" data-testid="find-count">
        {`${activeMatch}/${matchCount}`}
      </span>
      <button
        type="button"
        className="find-bar__button"
        data-testid="find-previous"
        aria-label="Previous match"
        onClick={() => {
          void window.zeo?.find.previous().catch(() => {});
        }}
      >
        ↑
      </button>
      <button
        type="button"
        className="find-bar__button"
        data-testid="find-next"
        aria-label="Next match"
        onClick={() => {
          void window.zeo?.find.next().catch(() => {});
        }}
      >
        ↓
      </button>
      <button
        type="button"
        className="find-bar__button"
        data-testid="find-close"
        aria-label="Close find"
        onClick={() => {
          void window.zeo?.find.close().catch(() => {});
        }}
      >
        ✕
      </button>
    </div>
  );
}
