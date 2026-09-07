import {
  useEffect,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { BlockingState } from "@zeo/core";
import "./App.css";

/**
 * The settings surface, mounted in its own WebContentsView (selected by
 * `?view=settings` in {@link "./main.js"}). A thin renderer with no business
 * logic: it mirrors main's {@link BlockingState} and reaches main exclusively
 * through `window.zeo`.
 *
 * State ownership: main pushes full `TabsState` over `onStateChange` and returns
 * just the blocking slice from `blocking.state()`. This component keeps no copy
 * of blocking data beyond that mirror — it seeds from `blocking.state()` on
 * mount, then keeps the slice in sync from each broadcast's `s.blocking`, and
 * derives every rendered value (enabled, listVersion, allowlist) from the latest
 * slice. All mutations go back through the bridge; the allowlist toggle never
 * optimistically keeps a value main rejected.
 *
 * `Escape` anywhere in the view dispatches the `settings.close` command; the
 * `Cmd+,` toggle is owned by the main process, not here.
 */
export function Settings() {
  // The mirrored blocking slice; null until the first snapshot/broadcast lands.
  const [blocking, setBlocking] = useState<BlockingState | null>(null);
  // Error text for a rejected global-toggle call.
  const [blockingError, setBlockingError] = useState<string | null>(null);
  // Whether a filter-list refresh is in flight (disables the button), and the
  // last result message ("Updated" / "Update failed").
  const [refreshPending, setRefreshPending] = useState(false);
  const [refreshResult, setRefreshResult] = useState<string | null>(null);
  // The allowlist add-input value and the error shown on a rejected add.
  const [allowInput, setAllowInput] = useState("");
  const [allowError, setAllowError] = useState<string | null>(null);

  useEffect(() => {
    // Guard so a bare browser dev-open (no bridge) doesn't throw. In Electron
    // the preload injects `window.zeo` before the renderer runs.
    if (!window.zeo) {
      return;
    }
    // Broadcasts carry the full TabsState; mirror only its blocking slice.
    const unsubscribe = window.zeo.onStateChange((s) => setBlocking(s.blocking));
    // Seed the initial slice; blocking.state() returns BlockingState directly.
    void window.zeo.blocking
      .state()
      .then(setBlocking)
      .catch(() => {});
    return unsubscribe;
  }, []);

  const enabled = blocking?.enabled ?? false;
  const listVersion = blocking?.listVersion ?? "";
  const allowlist = blocking?.allowlist ?? [];

  /**
   * Toggles global blocking. The checkbox stays bound to state, so a rejected
   * call falls back to the current value on the next render (no optimistic keep)
   * and the error message is surfaced.
   */
  const onToggle = (event: ChangeEvent<HTMLInputElement>): void => {
    const next = event.target.checked;
    const api = window.zeo;
    if (!api) {
      return;
    }
    setBlockingError(null);
    void api.blocking.setEnabled(next).catch((err: unknown) => {
      setBlockingError(err instanceof Error ? err.message : String(err));
    });
  };

  /** Requests a filter-list refresh; a rejection reads as "Update failed". */
  const onRefresh = (): void => {
    const api = window.zeo;
    if (!api) {
      return;
    }
    setRefreshPending(true);
    setRefreshResult(null);
    void api.blocking
      .refreshLists()
      .then(
        (ok) => setRefreshResult(ok ? "Updated" : "Update failed"),
        () => setRefreshResult("Update failed"),
      )
      .finally(() => setRefreshPending(false));
  };

  /**
   * Adds the current input to the allowlist. Success clears the input and error;
   * a rejection keeps the typed value and shows the guidance text.
   */
  const onAdd = (): void => {
    const api = window.zeo;
    if (!api) {
      return;
    }
    void api.blocking.allowSite(allowInput).then(
      () => {
        setAllowInput("");
        setAllowError(null);
      },
      () => {
        setAllowError("Enter a host name such as example.com");
      },
    );
  };

  /** Enter in the add-input submits, mirroring the Add button. */
  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      onAdd();
    }
  };

  /** Removes an allowlist entry by host. */
  const onRemove = (host: string): void => {
    void window.zeo?.blocking.disallowSite(host).catch(() => {});
  };

  /** Escape anywhere in the view asks main to close settings. */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      void window.zeo?.commands.run("settings.close").catch(() => {});
    }
  };

  return (
    <div className="settings" data-testid="settings" onKeyDown={onKeyDown}>
      <nav className="settings__sections" aria-label="Settings sections">
        <span className="settings__section-item settings__section-item--active">
          Content blocking
        </span>
      </nav>

      <div className="settings__panel">
        <section className="settings__group">
          <h2 className="settings__group-title">Content blocking</h2>

          <div className="settings__row">
            <label className="settings__toggle-label">
              <input
                type="checkbox"
                className="settings__checkbox"
                data-testid="settings-blocking-enabled"
                checked={enabled}
                onChange={onToggle}
              />
              <span>Block ads and trackers</span>
            </label>
          </div>
          {blockingError !== null && (
            <p
              className="settings__error"
              data-testid="settings-blocking-error"
              role="alert"
            >
              {blockingError}
            </p>
          )}

          <div className="settings__row">
            <span className="settings__label">Filter lists</span>
            <span
              className="settings__value"
              data-testid="settings-blocking-version"
            >
              {listVersion}
            </span>
            <button
              type="button"
              className="settings__button"
              data-testid="settings-blocking-refresh"
              disabled={refreshPending}
              onClick={onRefresh}
            >
              Update now
            </button>
            {refreshResult !== null && (
              <span
                className="settings__value settings__value--muted"
                data-testid="settings-blocking-refresh-result"
              >
                {refreshResult}
              </span>
            )}
          </div>
        </section>

        <section className="settings__group">
          <h2 className="settings__group-title">Allowlisted sites</h2>

          <div className="settings__row">
            <input
              type="text"
              className="settings__input"
              data-testid="settings-allowlist-input"
              placeholder="example.com"
              spellCheck={false}
              autoComplete="off"
              value={allowInput}
              onChange={(event) => setAllowInput(event.target.value)}
              onKeyDown={onInputKeyDown}
            />
            <button
              type="button"
              className="settings__button"
              data-testid="settings-allowlist-add"
              onClick={onAdd}
            >
              Add
            </button>
          </div>
          {allowError !== null && (
            <p
              className="settings__error"
              data-testid="settings-allowlist-error"
              role="alert"
            >
              {allowError}
            </p>
          )}

          {allowlist.length === 0 ? (
            <p
              className="settings__empty"
              data-testid="settings-allowlist-empty"
            >
              No allowlisted sites
            </p>
          ) : (
            <ul className="settings__allowlist">
              {allowlist.map((host) => (
                <li
                  key={host}
                  className="settings__allowlist-row"
                  data-testid="settings-allowlist-row"
                  data-host={host}
                >
                  <span className="settings__allowlist-host">{host}</span>
                  <button
                    type="button"
                    className="settings__button settings__button--ghost"
                    data-testid="settings-allowlist-remove"
                    aria-label={`Remove ${host}`}
                    onClick={() => onRemove(host)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
