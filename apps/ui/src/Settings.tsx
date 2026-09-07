import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  SETTINGS_SECTIONS,
  nextSection,
  prevSection,
  SEARCH_ENGINES,
  HISTORY_RETENTION_MS,
  type BlockingState,
  type Profile,
  type Space,
  type SettingsSectionId,
  type SearchEngineId,
  type TabsState,
} from "@zeo/core";
import "./App.css";

/**
 * The settings surface, mounted in its own WebContentsView (selected by
 * `?view=settings` in {@link "./main.js"}). A thin renderer with no business
 * logic: it mirrors main's full {@link TabsState} and reaches main exclusively
 * through `window.zeo`.
 *
 * State ownership: main pushes the full `TabsState` over `onStateChange`, and
 * `tabs.list()` returns the same shape for the initial seed. This component keeps
 * that mirror and derives every rendered value (the chosen search engine, the
 * blocking slice, the profiles/spaces lists) from the latest snapshot; all
 * mutations go back through the bridge, so a value main rejected is never kept.
 *
 * Section selection is split: `selected` (the shown body) follows the pushed
 * `settingsSection` on every section-open request — main bumps
 * `settingsSectionNonce` each time a section-open command fires, so a re-invoked
 * open re-selects even when the section id is unchanged — while `highlight` is
 * the renderer-local keyboard cursor. `ArrowDown`/`ArrowUp` move the highlight
 * through {@link SETTINGS_SECTIONS}, `Enter` selects the highlight, and clicking a
 * row selects and highlights it. An unrelated broadcast (unchanged nonce) never
 * disturbs the user's local selection.
 *
 * `Escape` anywhere in the view dispatches the `settings.close` command; the
 * `Cmd+,` toggle is owned by the main process, not here.
 */
export function Settings() {
  // The mirrored application state; null until the first snapshot/broadcast lands.
  const [state, setState] = useState<TabsState | null>(null);
  // The section whose body is shown, and the renderer-local keyboard cursor.
  const [selected, setSelected] = useState<SettingsSectionId>("general");
  const [highlight, setHighlight] = useState<SettingsSectionId>("general");
  // The last `settingsSectionNonce` seen from state, so only a genuine
  // section-open request (main bumps the nonce, including the very first
  // snapshot) drives selection — never an unrelated rebroadcast, which carries an
  // unchanged nonce. A re-invoked section-open command re-selects even when the
  // section id is unchanged. Seeded to a sentinel that no real nonce equals.
  const lastNonceRef = useRef<number | null>(null);

  useEffect(() => {
    // Guard so a bare browser dev-open (no bridge) doesn't throw. In Electron
    // the preload injects `window.zeo` before the renderer runs.
    if (!window.zeo) {
      return;
    }
    // Broadcasts carry the full TabsState; mirror all of it.
    let sawBroadcast = false;
    const unsubscribe = window.zeo.onStateChange((s) => {
      sawBroadcast = true;
      setState(s);
    });
    // Seed the initial state; tabs.list() returns the full TabsState. Ignore this
    // async snapshot once a broadcast has arrived, so a late initial response can
    // never overwrite a newer state.
    void window.zeo.tabs
      .list()
      .then((s) => {
        if (!sawBroadcast) {
          setState(s);
        }
      })
      .catch(() => {});
    return unsubscribe;
  }, []);

  useEffect(() => {
    // A section-open command bumps `settingsSectionNonce`; adopt the pushed
    // `settingsSection` as the selected and highlighted section. This re-selects
    // even when the section id is unchanged (a re-invoked open of the same
    // section), because a section-open is a discrete user intent to reveal it.
    // The very first snapshot (ref still the sentinel) selects its section too —
    // main defaults it to "general" when none was pushed. An unrelated broadcast
    // carries the same nonce and so never overrides the local selection.
    if (!state) {
      return;
    }
    if (state.settingsSectionNonce !== lastNonceRef.current) {
      lastNonceRef.current = state.settingsSectionNonce;
      setSelected(state.settingsSection);
      setHighlight(state.settingsSection);
    }
  }, [state]);

  useEffect(() => {
    // Escape closes the view regardless of which control (if any) has focus. A
    // window-level listener is used rather than a handler on the container div:
    // the container is not focusable, so on a fresh open (activeElement is the
    // body, an ancestor of the container) a descendant handler would never see
    // the keydown. The settings view owns the whole renderer, so a window
    // listener only fires while this WebContentsView has focus.
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        void window.zeo?.commands.run("settings.close").catch(() => {});
      }
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, []);

  useEffect(() => {
    // Section-list keyboard navigation. Highlight is a renderer-local cursor
    // that is independent of DOM focus. ArrowUp/ArrowDown move the highlight and
    // are skipped only in a text-cursor context (INPUT/TEXTAREA/SELECT) where an
    // arrow moves the caret. Enter selects the highlighted section — whether
    // focus rests on the body (a fresh open, where activeElement is the body) or
    // on a section-list <button> (e.g. after a mouse click) — but a focused text
    // field or an action button OUTSIDE the section list handles Enter natively
    // (submit the field / activate the button), so Enter defers to the DOM there.
    const onNavigate = (event: KeyboardEvent): void => {
      const target = event.target;
      const tagName = target instanceof HTMLElement ? target.tagName : "";
      const inTextField =
        tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
      const inSectionNav =
        target instanceof HTMLElement &&
        target.closest(".settings__sections") !== null;
      if (event.key === "ArrowDown") {
        if (inTextField) {
          return;
        }
        event.preventDefault();
        setHighlight((current) => nextSection(current));
      } else if (event.key === "ArrowUp") {
        if (inTextField) {
          return;
        }
        event.preventDefault();
        setHighlight((current) => prevSection(current));
      } else if (event.key === "Enter") {
        // A section-list button still selects the highlight (preventDefault
        // suppresses that button's own activation); a text field or an action
        // button elsewhere keeps its native Enter.
        if (inTextField || (tagName === "BUTTON" && !inSectionNav)) {
          return;
        }
        event.preventDefault();
        setSelected(highlight);
      }
    };
    window.addEventListener("keydown", onNavigate);
    return () => window.removeEventListener("keydown", onNavigate);
  }, [highlight]);

  /** Selects and highlights the clicked section row. */
  const onSelectSection = (id: SettingsSectionId): void => {
    setSelected(id);
    setHighlight(id);
  };

  return (
    <div className="settings" data-testid="settings">
      <nav className="settings__sections" aria-label="Settings sections">
        {SETTINGS_SECTIONS.map((section) => {
          const classes = ["settings__section-item"];
          if (section.id === selected) {
            classes.push(
              "settings__section-item--selected",
              "settings__section-item--active",
            );
          }
          if (section.id === highlight) {
            classes.push("settings__section-item--highlight");
          }
          return (
            <button
              key={section.id}
              type="button"
              className={classes.join(" ")}
              data-testid={`settings-section-${section.id}`}
              aria-current={section.id === selected ? "page" : undefined}
              onClick={() => onSelectSection(section.id)}
            >
              {section.title}
            </button>
          );
        })}
      </nav>

      <div className="settings__panel">
        {selected === "general" && state !== null && (
          <GeneralSection searchEngine={state.settings.searchEngine} />
        )}
        {selected === "blocking" && state !== null && (
          <BlockingSection blocking={state.blocking} />
        )}
        {selected === "profiles" && state !== null && (
          <ProfilesSection profiles={state.profiles} spaces={state.spaces} />
        )}
        {selected === "history" && <HistorySection />}
      </div>
    </div>
  );
}

/**
 * The general settings body: a radio group over the fixed {@link SEARCH_ENGINES}
 * catalog for the default search engine. The checked control is driven purely by
 * the broadcast `searchEngine`, so a rejected `setSearchEngine` never leaves the
 * UI showing an unpersisted choice; the rejection surfaces in an inline error.
 */
function GeneralSection({ searchEngine }: { searchEngine: SearchEngineId }) {
  // Error text for a rejected setSearchEngine call.
  const [error, setError] = useState<string | null>(null);

  /**
   * Requests the picked engine. The radios stay bound to the broadcast value, so
   * a rejected call falls back to the persisted engine on the next render and the
   * error message is surfaced.
   */
  const onSelect = (event: ChangeEvent<HTMLInputElement>): void => {
    const id = event.target.value as SearchEngineId;
    setError(null);
    void window.zeo?.settings.setSearchEngine(id).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  return (
    <section className="settings__group">
      <h2 className="settings__group-title">Default search engine</h2>

      <div className="settings__radio-group" role="radiogroup">
        {SEARCH_ENGINES.map((engine) => (
          <label key={engine.id} className="settings__radio-label">
            <input
              type="radio"
              className="settings__radio"
              name="settings-search-engine"
              data-testid={`settings-search-engine-${engine.id}`}
              value={engine.id}
              checked={searchEngine === engine.id}
              onChange={onSelect}
            />
            <span>{engine.name}</span>
          </label>
        ))}
      </div>
      {error !== null && (
        <p
          className="settings__error"
          data-testid="settings-search-engine-error"
          role="alert"
        >
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * The content-blocking settings body (from PRD 5.2): the global toggle, the
 * filter-list version with a manual refresh, and the per-site allowlist editor.
 * All blocking data is derived from the broadcast {@link BlockingState}; every
 * mutation goes back through `window.zeo.blocking` and no rejected value is kept
 * optimistically.
 */
function BlockingSection({ blocking }: { blocking: BlockingState }) {
  // Error text for a rejected global-toggle call.
  const [blockingError, setBlockingError] = useState<string | null>(null);
  // Whether a filter-list refresh is in flight (disables the button), and the
  // last result message ("Updated" / "Update failed").
  const [refreshPending, setRefreshPending] = useState(false);
  const [refreshResult, setRefreshResult] = useState<string | null>(null);
  // The allowlist add-input value and the error shown on a rejected add.
  const [allowInput, setAllowInput] = useState("");
  const [allowError, setAllowError] = useState<string | null>(null);

  const enabled = blocking.enabled;
  const listVersion = blocking.listVersion;
  const allowlist = blocking.allowlist;

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

  return (
    <>
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
          <p className="settings__empty" data-testid="settings-allowlist-empty">
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
    </>
  );
}

/**
 * The profiles settings body: every broadcast {@link Profile} in received order
 * with an inline rename field, its id and space-usage count, and a delete control
 * disabled while any space still references it, plus a create row. It reuses the
 * existing `window.zeo.profiles` create/rename/delete bridge and refreshes from
 * the `onStateChange` broadcast — no new bridge method.
 *
 * Each name field is controlled by a per-row draft that falls back to the stored
 * `p.name`, so a not-being-edited row reflects a broadcast rename while an
 * in-progress edit is preserved; the draft entry is cleared on a successful
 * rename (when the field still holds the submitted name) or a blank-revert so
 * the field re-follows the stored name.
 */
function ProfilesSection({
  profiles,
  spaces,
}: {
  profiles: Profile[];
  spaces: Space[];
}) {
  // Per-profile-id rename drafts; a missing entry means the row follows p.name.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // The create-input value.
  const [createName, setCreateName] = useState("");

  /** Drops a row's rename draft so its field re-follows the stored name. */
  const clearDraft = (id: string): void => {
    setDrafts((current) => {
      if (!(id in current)) {
        return current;
      }
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  /**
   * Drops a row's rename draft only when it still holds `submitted`, so a rename
   * that resolves after the user typed a newer name does not discard that edit.
   */
  const clearDraftIfUnchanged = (id: string, submitted: string): void => {
    setDrafts((current) => {
      if (current[id] !== submitted) {
        return current;
      }
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  /**
   * Renames a profile to its current draft. A blank or whitespace-only draft is
   * not submitted and reverts the field to the stored name; a successful rename
   * clears the draft so the field re-follows the (now updated) stored name.
   */
  const onRename = (profile: Profile): void => {
    const draft = drafts[profile.id] ?? profile.name;
    if (draft.trim() === "") {
      clearDraft(profile.id);
      return;
    }
    void window.zeo?.profiles.rename(profile.id, draft).then(
      () => clearDraftIfUnchanged(profile.id, draft),
      () => {},
    );
  };

  /** Deletes a profile; the control is disabled while any space still uses it. */
  const onDelete = (id: string): void => {
    void window.zeo?.profiles.delete(id).catch(() => {});
  };

  /** Creates a profile from the create-input; a blank name is not submitted. */
  const onCreate = (): void => {
    const submitted = createName;
    if (submitted.trim() === "") {
      return;
    }
    void window.zeo?.profiles.create(submitted).then(
      () => setCreateName((current) => (current === submitted ? "" : current)),
      () => {},
    );
  };

  return (
    <section className="settings__group">
      <h2 className="settings__group-title">Profiles</h2>

      {profiles.length === 0 ? (
        <p className="settings__empty">No profiles</p>
      ) : (
        <ul className="settings__profiles">
          {profiles.map((profile) => {
            const usage = spaces.filter(
              (space) => space.profileId === profile.id,
            ).length;
            const name = drafts[profile.id] ?? profile.name;
            return (
              <li
                key={profile.id}
                className="settings__profile-row"
                data-profile={profile.id}
              >
                <input
                  type="text"
                  className="settings__input"
                  data-testid={`settings-profile-name-${profile.id}`}
                  spellCheck={false}
                  autoComplete="off"
                  value={name}
                  onChange={(event) =>
                    setDrafts((current) => ({
                      ...current,
                      [profile.id]: event.target.value,
                    }))
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      onRename(profile);
                    }
                  }}
                />
                <span className="settings__profile-id" title={profile.id}>
                  {profile.id}
                </span>
                <span className="settings__profile-usage">
                  {usage} {usage === 1 ? "space" : "spaces"}
                </span>
                <button
                  type="button"
                  className="settings__button"
                  data-testid={`settings-profile-rename-${profile.id}`}
                  onClick={() => onRename(profile)}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="settings__button settings__button--ghost"
                  data-testid={`settings-profile-delete-${profile.id}`}
                  disabled={usage > 0}
                  onClick={() => onDelete(profile.id)}
                >
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="settings__row">
        <input
          type="text"
          className="settings__input"
          data-testid="settings-profile-create-name"
          placeholder="New profile name"
          spellCheck={false}
          autoComplete="off"
          value={createName}
          onChange={(event) => setCreateName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onCreate();
            }
          }}
        />
        <button
          type="button"
          className="settings__button"
          data-testid="settings-profile-create"
          onClick={onCreate}
        >
          Create
        </button>
      </div>
    </section>
  );
}

/**
 * The history settings body: the fixed retention derived from
 * {@link HISTORY_RETENTION_MS}, the on-demand entry/visit summary from
 * `history.stats()` (read on mount and re-read after a clear), and a two-step
 * clear where only the revealed confirm control calls `history.clear()`.
 */
function HistorySection() {
  // The on-demand stats; null until the first read resolves.
  const [stats, setStats] = useState<{ entries: number; visits: number } | null>(
    null,
  );
  // Whether the destructive confirm control is revealed.
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    // History is not broadcast; read the counts on mount.
    void window.zeo?.history.stats().then(setStats).catch(() => {});
  }, []);

  /**
   * Clears history, then re-reads the counts and dismisses the confirm step. Only
   * this confirm control clears — the initial button just reveals it.
   */
  const onConfirmClear = (): void => {
    const api = window.zeo;
    if (!api) {
      return;
    }
    void api.history
      .clear()
      .then(() => api.history.stats())
      .then((next) => {
        setStats(next);
        setConfirming(false);
      })
      .catch(() => {});
  };

  const retentionDays = HISTORY_RETENTION_MS / (24 * 60 * 60 * 1000);

  return (
    <section className="settings__group">
      <h2 className="settings__group-title">History</h2>

      <p className="settings__value" data-testid="settings-history-retention">
        History is kept for {retentionDays} days.
      </p>
      <p className="settings__value" data-testid="settings-history-stats">
        {stats?.entries ?? 0} entries · {stats?.visits ?? 0} visits
      </p>

      <div className="settings__row">
        <button
          type="button"
          className="settings__button"
          data-testid="settings-history-clear"
          onClick={() => setConfirming(true)}
        >
          Clear browsing history
        </button>
        {confirming && (
          <button
            type="button"
            className="settings__button settings__button--danger"
            data-testid="settings-history-clear-confirm"
            onClick={onConfirmClear}
          >
            Confirm clear
          </button>
        )}
      </div>
    </section>
  );
}
