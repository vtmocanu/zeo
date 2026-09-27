/**
 * The `window_state` row accessors (PRD 10.2 §5): the persisted window bounds
 * plus the chrome (sidebar) preferences added at schema version 13. Split out
 * of `db.ts` to keep that module under its `max-lines` ceiling; `db.ts` owns
 * the DDL and migration for this table, this module only reads and writes its
 * single row.
 */
import type { PersistedChrome, WindowState } from "@zeo/core";
import { requireDb } from "./db.js";

/**
 * Reads the persisted window {@link WindowState} from the `window_state` row 0,
 * mapping SQLite's integer `maximized` to a boolean. Returns `null` when no row
 * has been saved yet (its absence means the bounds were never persisted — a first
 * run), so the caller opens with platform defaults; `x`/`y` stay `null` as `null`.
 * Managed ONLY here and by {@link writeWindowState}; like the other window/meta
 * helpers it is kept out of the full-state flush. Throws when the database is
 * not open.
 */
export function readWindowState(): WindowState | null {
  const database = requireDb();
  // SQLite-row boundary: .get() is typed `unknown`, cast to the known shape.
  const row = database
    .prepare("SELECT x, y, width, height, maximized FROM window_state WHERE id=0")
    .get() as
    | {
        x: number | null;
        y: number | null;
        width: number;
        height: number;
        maximized: number;
      }
    | undefined;
  if (row === undefined) {
    return null;
  }
  return {
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    maximized: row.maximized !== 0,
  };
}

/**
 * Persists the window {@link WindowState} to the `window_state` row 0, upserting
 * the single row (`ON CONFLICT(id)` overwrites every column) and mapping the
 * boolean `maximized` to SQLite's integer; `x`/`y` pass through as `number | null`.
 * Synchronous (better-sqlite3). Throws when the database is not open, so a caller's
 * ordered window-state-write contract sees the failure before it changes anything
 * else.
 */
export function writeWindowState(state: WindowState): void {
  const database = requireDb();
  database
    .prepare(
      "INSERT INTO window_state (id, x, y, width, height, maximized) VALUES (0, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET x=excluded.x, y=excluded.y, width=excluded.width, height=excluded.height, maximized=excluded.maximized",
    )
    .run(state.x, state.y, state.width, state.height, state.maximized ? 1 : 0);
}

/**
 * Reads the persisted chrome preferences (sidebar width and collapsed flag)
 * from the `window_state` row 0, mapping SQLite's integer `sidebarCollapsed`
 * to a boolean. Returns `null` when no row has been saved yet, so the caller
 * falls back to {@link DEFAULT_CHROME_STATE}. Throws when the database is not
 * open.
 */
export function readChromePrefs(): PersistedChrome | null {
  const database = requireDb();
  // SQLite-row boundary: .get() is typed `unknown`, cast to the known shape.
  const row = database
    .prepare("SELECT sidebarWidth, sidebarCollapsed FROM window_state WHERE id=0")
    .get() as { sidebarWidth: number; sidebarCollapsed: number } | undefined;
  if (row === undefined) {
    return null;
  }
  return {
    sidebarWidth: row.sidebarWidth,
    sidebarCollapsed: row.sidebarCollapsed !== 0,
  };
}

/**
 * Persists the chrome preferences to the `window_state` row 0, upserting ONLY
 * the two chrome columns (`ON CONFLICT(id)` touches nothing else) so an
 * existing row's bounds are left untouched. `frame` seeds a missing row's
 * bounds/maximized columns (their NOT NULL constraint requires a value on
 * insert); it is otherwise unused. Synchronous (better-sqlite3). Throws when
 * the database is not open.
 */
export function writeChromePrefs(prefs: PersistedChrome, frame: WindowState): void {
  const database = requireDb();
  database
    .prepare(
      "INSERT INTO window_state (id, x, y, width, height, maximized, sidebarWidth, sidebarCollapsed) VALUES (0, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET sidebarWidth=excluded.sidebarWidth, sidebarCollapsed=excluded.sidebarCollapsed",
    )
    .run(
      frame.x,
      frame.y,
      frame.width,
      frame.height,
      frame.maximized ? 1 : 0,
      prefs.sidebarWidth,
      prefs.sidebarCollapsed ? 1 : 0,
    );
}
