/**
 * The desktop SQLite persistence layer: ALL SQL for the app lives here. This
 * module owns the on-disk `zeo.db` (a better-sqlite3 database in Electron's
 * userData directory), the schema DDL, migration, and the read/write mapping
 * between SQLite rows and the pure-core {@link PersistedState} codec.
 *
 * The pure serialize/deserialize logic lives in `@zeo/core`; this module only
 * moves rows in and out of SQLite and translates SQLite's integer/null
 * representation to the plain `number`/`string`/`boolean`/`null` the codec
 * expects. better-sqlite3 is fully synchronous, so every operation here is too.
 */
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { app } from "electron";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  SCHEMA_VERSION,
  HISTORY_RETENTION_MS,
  migrationAction,
  serializeStore,
  deserializeStore,
  UnsupportedSchemaVersionError,
} from "@zeo/core";
import type {
  PersistedState,
  MetaRow,
  ProfileRow,
  SpaceRow,
  TabRow,
  SpaceStore,
  HistoryEntry,
  HistoryVisit,
} from "@zeo/core";

/**
 * The four-table schema. The PRIMARY KEYs (no duplicate ids), the two foreign
 * keys, and `PRAGMA foreign_keys=ON` are the well-formedness contract the core
 * codec relies on: every on-disk state is guaranteed loadable. `spaces.activeTabId`
 * and `meta.activeSpaceId` are deliberately NOT foreign keys — a plain FK cannot
 * express "same space AND non-archived"; their integrity is enforced by the write
 * path plus the codec's repair-on-load.
 */
const DDL = `
CREATE TABLE profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt INTEGER NOT NULL, position INTEGER NOT NULL
);
CREATE TABLE spaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  profileId TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  createdAt INTEGER NOT NULL, activeTabId TEXT, position INTEGER NOT NULL
);
CREATE TABLE tabs (
  id TEXT PRIMARY KEY,
  spaceId TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  url TEXT NOT NULL, title TEXT NOT NULL, faviconUrl TEXT,
  createdAt INTEGER NOT NULL, pinned INTEGER NOT NULL, lastActiveAt INTEGER NOT NULL,
  archivedAt INTEGER, position INTEGER NOT NULL
);
CREATE TABLE meta (
  id INTEGER PRIMARY KEY CHECK (id = 0), schemaVersion INTEGER NOT NULL, activeSpaceId TEXT,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE history_entries (
  url TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  visitCount INTEGER NOT NULL,
  lastVisitedAt INTEGER NOT NULL
);
CREATE TABLE history_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL REFERENCES history_entries(url) ON DELETE CASCADE,
  title TEXT NOT NULL,
  visitedAt INTEGER NOT NULL
);
CREATE INDEX history_visits_visitedAt ON history_visits(visitedAt);
CREATE INDEX history_entries_lastVisitedAt ON history_entries(lastVisitedAt);
`;

/**
 * The ordered, in-place upgrade steps keyed by the version they PRODUCE: the
 * `v` entry is run to move a database from version `v-1` to `v`. {@link migrate}
 * runs every step from the on-disk version + 1 up through {@link SCHEMA_VERSION},
 * so a future 2→3 upgrade is added by appending a `3` entry here. Each step is a
 * plain SQL blob run inside the migrate transaction; the step MUST leave
 * `meta.schemaVersion` set to its own key.
 */
const HISTORY_DDL =
  "CREATE TABLE history_entries (" +
  "url TEXT PRIMARY KEY, title TEXT NOT NULL, visitCount INTEGER NOT NULL, lastVisitedAt INTEGER NOT NULL);" +
  "CREATE TABLE history_visits (" +
  "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
  "url TEXT NOT NULL REFERENCES history_entries(url) ON DELETE CASCADE, " +
  "title TEXT NOT NULL, visitedAt INTEGER NOT NULL);" +
  "CREATE INDEX history_visits_visitedAt ON history_visits(visitedAt);" +
  "CREATE INDEX history_entries_lastVisitedAt ON history_entries(lastVisitedAt);";

const MIGRATION_STEPS: Record<number, string> = {
  2:
    "ALTER TABLE meta ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;" +
    "UPDATE meta SET schemaVersion = 2 WHERE id = 0;",
  3: HISTORY_DDL + "UPDATE meta SET schemaVersion = 3 WHERE id = 0;",
};

/** The module-level database handle, `null` until {@link loadStore} opens it. */
let db: DatabaseType | null = null;

/** Pending debounced-save timer id, or `null` when no save is scheduled. */
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounce window for {@link scheduleSave}, in milliseconds. */
const SAVE_DEBOUNCE_MS = 1000;

/** Absolute path to the on-disk database file. */
function dbPath(): string {
  return join(app.getPath("userData"), "zeo.db");
}

/**
 * Reads the schema version currently on disk and applies {@link migrationAction}:
 * `"abort"` throws {@link UnsupportedSchemaVersionError}, `"create"` builds the
 * fresh four-table schema and seeds the single meta row, `"migrate"` runs the
 * ordered {@link MIGRATION_STEPS} from the on-disk version + 1 through
 * {@link SCHEMA_VERSION} inside a single transaction (so a partially-applied
 * upgrade never lands), and `"noop"` leaves an up-to-date database untouched.
 * Absence of the `meta` table is treated as version 0 (an empty/new file).
 */
export function migrate(database: DatabaseType): void {
  const hasMeta =
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='meta'",
      )
      .get() !== undefined;
  let version = 0;
  if (hasMeta) {
    // SQLite-row boundary: .get() is typed `unknown`, cast to the known shape.
    const row = database
      .prepare("SELECT schemaVersion FROM meta WHERE id=0")
      .get() as { schemaVersion: number } | undefined;
    version = row?.schemaVersion ?? 0;
  }

  switch (migrationAction(version)) {
    case "abort":
      throw new UnsupportedSchemaVersionError(version);
    case "create":
      database.exec(DDL);
      database
        .prepare(
          "INSERT INTO meta(id,schemaVersion,activeSpaceId) VALUES (0, ?, NULL)",
        )
        .run(SCHEMA_VERSION);
      break;
    case "migrate": {
      // Run each ordered step from version+1 up to SCHEMA_VERSION in one
      // transaction: an upgrade either lands whole or not at all. A missing step
      // for a version in range is a programming error, surfaced immediately.
      const runSteps = database.transaction((): void => {
        for (let next = version + 1; next <= SCHEMA_VERSION; next++) {
          const step = MIGRATION_STEPS[next];
          if (step === undefined) {
            throw new Error(`missing migration step for schema version ${next}`);
          }
          database.exec(step);
        }
      });
      runSteps();
      break;
    }
    case "noop":
      break;
  }
}

/** Throws when the module-level database handle is not open. */
function requireDb(): DatabaseType {
  if (db === null) {
    throw new Error("database is not open");
  }
  return db;
}

/**
 * Reads the persisted content-blocking `enabled` flag from the meta row,
 * mapping SQLite's integer to a boolean. Throws when the database is not open.
 * This flag is managed ONLY here and by {@link writeBlockingEnabled}; it is
 * deliberately kept out of the {@link writeState} full-state flush.
 */
export function readBlockingEnabled(): boolean {
  const database = requireDb();
  // SQLite-row boundary: .get() is typed `unknown`, cast to the known shape.
  const row = database
    .prepare("SELECT enabled FROM meta WHERE id=0")
    .get() as { enabled: number } | undefined;
  return (row?.enabled ?? 1) === 1;
}

/**
 * Persists the content-blocking `enabled` flag to the meta row, mapping the
 * boolean to SQLite's integer. Synchronous (better-sqlite3). Throws when the
 * database is not open, so a caller's ordered set-enabled contract sees the
 * failure before it changes anything else.
 */
export function writeBlockingEnabled(enabled: boolean): void {
  const database = requireDb();
  database.prepare("UPDATE meta SET enabled=? WHERE id=0").run(enabled ? 1 : 0);
}

/**
 * Escapes a term for use inside a `LIKE ... ESCAPE '\'` pattern: the three
 * LIKE metacharacters `\`, `%` and `_` are backslash-escaped so they match
 * literally. The backslash is escaped FIRST so the escapes added for `%`/`_`
 * are not themselves re-escaped.
 */
function escapeLike(term: string): string {
  return term
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

/**
 * Records one visit to `url` and folds it into the aggregated entry in a single
 * transaction, returning the new visit's autoincrement id. The visit row always
 * inserts and `visitCount` always increments by one, but `lastVisitedAt` and
 * `title` (the latter only when the new `title` is non-empty) move to this
 * visit's values ONLY when the inserted visit is the newest for the url — its
 * `(visitedAt, id)` pair is the maximum among the url's visits. An out-of-order
 * (older) visit is still counted but never moves `lastVisitedAt` backward nor
 * replaces the entry title with an older one. Throws when the database is not
 * open.
 */
export function recordVisit(url: string, title: string, visitedAt: number): number {
  const database = requireDb();
  // Seed a placeholder entry (visitCount 0) so the history_visits FK is
  // satisfied before the visit inserts; an existing entry is left untouched and
  // the single UPDATE below applies the count/newest-visit rule uniformly.
  const seedEntry = database.prepare(
    "INSERT INTO history_entries(url,title,visitCount,lastVisitedAt) VALUES (?,?,0,?) " +
      "ON CONFLICT(url) DO NOTHING",
  );
  const insertVisit = database.prepare(
    "INSERT INTO history_visits(url,title,visitedAt) VALUES (?,?,?)",
  );
  const isNewestStmt = database.prepare(
    "SELECT NOT EXISTS(SELECT 1 FROM history_visits " +
      "WHERE url=? AND (visitedAt > ? OR (visitedAt = ? AND id > ?))) AS newest",
  );
  const updateEntry = database.prepare(
    "UPDATE history_entries SET visitCount = visitCount + 1, " +
      "lastVisitedAt = CASE WHEN @newest = 1 THEN @visitedAt ELSE lastVisitedAt END, " +
      "title = CASE WHEN @newest = 1 AND @title <> '' THEN @title ELSE title END " +
      "WHERE url = @url",
  );
  const run = database.transaction((): number => {
    seedEntry.run(url, title, visitedAt);
    const info = insertVisit.run(url, title, visitedAt);
    const id = Number(info.lastInsertRowid);
    // SQLite-row boundary: .get() is typed `unknown`; NOT EXISTS yields 0/1.
    const row = isNewestStmt.get(url, visitedAt, visitedAt, id) as {
      newest: number;
    };
    updateEntry.run({ newest: row.newest, visitedAt, title, url });
    return id;
  });
  return run();
}

/**
 * Sets `title` on the visit row `visitId`, and on that visit's aggregated entry
 * only when the visit is still the newest for its url (its `(visitedAt, id)`
 * pair is the maximum among the url's visits), both in one transaction. A no-op
 * when `visitId` does not exist. The newest-visit guard stops a delayed title
 * update for an older visit from overwriting a newer visit's title on the
 * shared entry row. Throws when the database is not open.
 */
export function updateVisitTitle(visitId: number, title: string): void {
  const database = requireDb();
  const visitStmt = database.prepare(
    "SELECT url, visitedAt FROM history_visits WHERE id=?",
  );
  const updateVisit = database.prepare(
    "UPDATE history_visits SET title=? WHERE id=?",
  );
  const updateEntry = database.prepare(
    "UPDATE history_entries SET title=@title WHERE url=@url AND NOT EXISTS(" +
      "SELECT 1 FROM history_visits WHERE url=@url AND " +
      "(visitedAt > @visitedAt OR (visitedAt = @visitedAt AND id > @id)))",
  );
  const run = database.transaction((): void => {
    // SQLite-row boundary: .get() is typed `unknown`; select the known columns.
    const visit = visitStmt.get(visitId) as
      | { url: string; visitedAt: number }
      | undefined;
    if (visit === undefined) {
      return;
    }
    updateVisit.run(title, visitId);
    updateEntry.run({
      title,
      url: visit.url,
      visitedAt: visit.visitedAt,
      id: visitId,
    });
  });
  run();
}

/**
 * Returns aggregated history entries where every term in `terms` is a
 * case-insensitive substring of the `url` or `title`, ranked by `visitCount`
 * then `lastVisitedAt` (both descending) and capped at `limit`. Each term's
 * LIKE metacharacters are escaped so they match literally. An empty `terms`
 * array returns the most recently visited entries (by `lastVisitedAt`). Throws
 * when the database is not open.
 */
export function searchHistory(terms: string[], limit: number): HistoryEntry[] {
  const database = requireDb();
  const select =
    "SELECT url, title, visitCount, lastVisitedAt FROM history_entries";
  // SQLite-row boundary: .all() is typed `unknown[]`; the columns are the
  // HistoryEntry shape.
  if (terms.length === 0) {
    return database
      .prepare(`${select} ORDER BY lastVisitedAt DESC LIMIT ?`)
      .all(limit) as HistoryEntry[];
  }
  const clauses = terms.map(
    () => "(url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')",
  );
  const params: string[] = [];
  for (const term of terms) {
    const pattern = `%${escapeLike(term)}%`;
    params.push(pattern, pattern);
  }
  const sql =
    `${select} WHERE ${clauses.join(" AND ")} ` +
    "ORDER BY visitCount DESC, lastVisitedAt DESC LIMIT ?";
  return database.prepare(sql).all(...params, limit) as HistoryEntry[];
}

/**
 * Returns the most recent visits ordered by `visitedAt` descending, capped at
 * `limit`. Throws when the database is not open.
 */
export function recentVisits(limit: number): HistoryVisit[] {
  const database = requireDb();
  // SQLite-row boundary: .all() is typed `unknown[]`; the columns are the
  // HistoryVisit shape.
  return database
    .prepare(
      "SELECT id, url, title, visitedAt FROM history_visits ORDER BY visitedAt DESC LIMIT ?",
    )
    .all(limit) as HistoryVisit[];
}

/**
 * Deletes the history entry for `url`; its visits cascade via the foreign key
 * (`PRAGMA foreign_keys=ON` is set in {@link openDb}). Throws when the database
 * is not open.
 */
export function deleteHistoryUrl(url: string): void {
  const database = requireDb();
  database.prepare("DELETE FROM history_entries WHERE url=?").run(url);
}

/**
 * Empties both history tables in a single transaction. Throws when the database
 * is not open.
 */
export function clearHistory(): void {
  const database = requireDb();
  const run = database.transaction((): void => {
    database.exec("DELETE FROM history_visits");
    database.exec("DELETE FROM history_entries");
  });
  run();
}

/**
 * Deletes visits older than {@link HISTORY_RETENTION_MS} relative to `now`, then
 * removes entries left with no remaining visits, in one transaction.
 * `visitCount` is a lifetime counter and is deliberately NOT adjusted, so a
 * surviving entry keeps its lifetime count even after its old visits are
 * deleted. Throws when the database is not open.
 */
export function pruneHistory(now: number): void {
  const database = requireDb();
  const deleteOldVisits = database.prepare(
    "DELETE FROM history_visits WHERE visitedAt < ?",
  );
  const deleteOrphanEntries = database.prepare(
    "DELETE FROM history_entries WHERE url NOT IN (SELECT DISTINCT url FROM history_visits)",
  );
  const run = database.transaction((): void => {
    deleteOldVisits.run(now - HISTORY_RETENTION_MS);
    deleteOrphanEntries.run();
  });
  run();
}

/**
 * True when the database holds any persistable state — any space, or any tab
 * (open or archived). A brand-new database with only the seeded meta row returns
 * false, signalling the caller to seed an initial store.
 */
function hasData(database: DatabaseType): boolean {
  const anySpace = database.prepare("SELECT 1 FROM spaces LIMIT 1").get();
  const anyTab = database.prepare("SELECT 1 FROM tabs LIMIT 1").get();
  return anySpace !== undefined || anyTab !== undefined;
}

/**
 * Reads the full persisted snapshot out of SQLite into a typed
 * {@link PersistedState}. Profiles and spaces come back in `position` order, tabs
 * in `(spaceId, position)` order, and the single meta row is read from id 0.
 * SQLite's integer `pinned` maps to a boolean; `faviconUrl`/`archivedAt`/
 * `activeTabId`/`activeSpaceId` stay `null` as `null`.
 */
function readState(database: DatabaseType): PersistedState {
  // SQLite-row boundary: better-sqlite3 .all()/.get() are typed `unknown`; the
  // schema DDL above is the source of truth for these row shapes.
  const profiles = database
    .prepare("SELECT id, name, createdAt, position FROM profiles ORDER BY position")
    .all() as ProfileRow[];
  const spaces = database
    .prepare(
      "SELECT id, name, profileId, createdAt, activeTabId, position FROM spaces ORDER BY position",
    )
    .all() as SpaceRow[];
  const tabRows = database
    .prepare(
      "SELECT id, spaceId, url, title, faviconUrl, createdAt, pinned, lastActiveAt, archivedAt, position FROM tabs ORDER BY spaceId, position",
    )
    .all() as (Omit<TabRow, "pinned"> & { pinned: number })[];
  const tabs: TabRow[] = tabRows.map((row) => ({
    ...row,
    pinned: row.pinned === 1,
  }));
  const metaRow = database
    .prepare("SELECT schemaVersion, activeSpaceId FROM meta WHERE id=0")
    .get() as MetaRow;

  return { meta: metaRow, profiles, spaces, tabs };
}

/**
 * Persists a full {@link PersistedState} snapshot in a single transaction. The
 * step order — upsert profiles → spaces → tabs, then delete-absent tabs → spaces
 * → profiles, then update meta — avoids the profile-FK RESTRICT hazard when a
 * space is re-pointed to a new profile and its old profile is deleted in the same
 * snapshot: the space row is rewritten before the old profile is removed. An empty
 * id list on a delete-absent step correctly clears every row of that table.
 */
function writeState(database: DatabaseType, state: PersistedState): void {
  const upsertProfile = database.prepare(
    "INSERT INTO profiles(id,name,createdAt,position) VALUES (@id,@name,@createdAt,@position) " +
      "ON CONFLICT(id) DO UPDATE SET name=excluded.name, createdAt=excluded.createdAt, position=excluded.position",
  );
  const upsertSpace = database.prepare(
    "INSERT INTO spaces(id,name,profileId,createdAt,activeTabId,position) " +
      "VALUES (@id,@name,@profileId,@createdAt,@activeTabId,@position) " +
      "ON CONFLICT(id) DO UPDATE SET name=excluded.name, profileId=excluded.profileId, " +
      "createdAt=excluded.createdAt, activeTabId=excluded.activeTabId, position=excluded.position",
  );
  const upsertTab = database.prepare(
    "INSERT INTO tabs(id,spaceId,url,title,faviconUrl,createdAt,pinned,lastActiveAt,archivedAt,position) " +
      "VALUES (@id,@spaceId,@url,@title,@faviconUrl,@createdAt,@pinned,@lastActiveAt,@archivedAt,@position) " +
      "ON CONFLICT(id) DO UPDATE SET spaceId=excluded.spaceId, url=excluded.url, title=excluded.title, " +
      "faviconUrl=excluded.faviconUrl, createdAt=excluded.createdAt, pinned=excluded.pinned, " +
      "lastActiveAt=excluded.lastActiveAt, archivedAt=excluded.archivedAt, position=excluded.position",
  );
  const deleteAbsentTabs = database.prepare(
    "DELETE FROM tabs WHERE id NOT IN (SELECT value FROM json_each(?))",
  );
  const deleteAbsentSpaces = database.prepare(
    "DELETE FROM spaces WHERE id NOT IN (SELECT value FROM json_each(?))",
  );
  const deleteAbsentProfiles = database.prepare(
    "DELETE FROM profiles WHERE id NOT IN (SELECT value FROM json_each(?))",
  );
  const updateMeta = database.prepare(
    "UPDATE meta SET schemaVersion=?, activeSpaceId=? WHERE id=0",
  );

  const run = database.transaction((s: PersistedState): void => {
    // (1) upsert profiles
    for (const p of s.profiles) {
      upsertProfile.run(p);
    }
    // (2) upsert spaces
    for (const sp of s.spaces) {
      upsertSpace.run(sp);
    }
    // (3) upsert tabs (boolean pinned → SQLite integer)
    for (const t of s.tabs) {
      upsertTab.run({ ...t, pinned: t.pinned ? 1 : 0 });
    }
    // (4) delete-absent tabs, (5) spaces, (6) profiles
    deleteAbsentTabs.run(JSON.stringify(s.tabs.map((t) => t.id)));
    deleteAbsentSpaces.run(JSON.stringify(s.spaces.map((sp) => sp.id)));
    deleteAbsentProfiles.run(JSON.stringify(s.profiles.map((p) => p.id)));
    // (7) update meta
    updateMeta.run(s.meta.schemaVersion, s.meta.activeSpaceId);
  });

  run(state);
}

/**
 * Moves the current database files aside (`zeo.db`, `zeo.db-wal`, `zeo.db-shm`)
 * by renaming each existing one to `<name>.bak-<timestamp>`, so a corrupt or
 * unreadable database is preserved for inspection rather than deleted. Used by
 * the {@link loadStore} recovery path.
 */
function moveDbAside(): void {
  const base = dbPath();
  const stamp = Date.now();
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = base + suffix;
    if (existsSync(path)) {
      renameSync(path, `${path}.bak-${stamp}`);
    }
  }
}

/**
 * Opens `zeo.db`, applies the standard pragmas (WAL journaling, foreign keys),
 * and migrates it. Returns the open handle. Callers own recovery on failure.
 */
function openDb(): DatabaseType {
  const database = new Database(dbPath());
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  try {
    migrate(database);
  } catch (err) {
    try {
      database.close();
    } catch {
      // Ignore close failures while unwinding an already-failed open.
    }
    throw err;
  }
  return database;
}

/**
 * Opens (creating/migrating as needed) the on-disk database and returns the
 * restored {@link SpaceStore}, or `null` when there is nothing to restore (a
 * fresh database — the caller then seeds an initial store). On a corrupt or
 * otherwise unreadable file, the offending files are moved aside, a fresh empty
 * database is created in their place, and `null` is returned so the app still
 * launches. The ONE exception is a database written by a NEWER build (schema
 * version ahead of this build): that file is PRESERVED in place — never moved
 * aside or replaced — and the session simply runs without persistence, so a
 * later upgrade can still read the state.
 */
export function loadStore(): SpaceStore | null {
  try {
    db = openDb();
    if (hasData(db)) {
      return deserializeStore(readState(db));
    }
    return null;
  } catch (err: unknown) {
    if (err instanceof UnsupportedSchemaVersionError) {
      // A newer build wrote this database. Do NOT move it aside or replace it —
      // that would destroy state a later upgrade could still read. Preserve the
      // file at its active path and run without persistence this session.
      if (db !== null) {
        try {
          db.close();
        } catch {
          // Ignore close failures on the newer-schema handle.
        }
        db = null;
      }
      console.error(
        "zeo.db was written by a newer build; running without persistence this session:",
        err,
      );
      return null;
    }
    console.error(
      "zeo.db could not be opened/read; moving it aside and starting fresh:",
      err,
    );
    if (db !== null) {
      try {
        db.close();
      } catch {
        // Ignore close failures on an already-broken handle.
      }
      db = null;
    }
    moveDbAside();
    // Reopen a clean database in place so subsequent saves have somewhere to go.
    // If even the fresh open fails (e.g. an unwritable userData dir), degrade to
    // no persistence rather than aborting startup: db stays null, scheduleSave/
    // flush no-op, and the app still launches with a seeded in-memory store.
    try {
      db = openDb();
    } catch (reopenErr: unknown) {
      console.error(
        "zeo.db could not be recreated; running without persistence this session:",
        reopenErr,
      );
      db = null;
    }
    return null;
  }
}

/**
 * Schedules a debounced save of the current store snapshot (~1s), replacing any
 * pending save so a burst of mutations collapses into a single write. Safe no-op
 * when the database is not yet initialized.
 */
export function scheduleSave(store: SpaceStore): void {
  if (db === null) {
    return;
  }
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (db === null) {
      return;
    }
    try {
      writeState(db, serializeStore(store));
    } catch (err: unknown) {
      console.error("scheduled save failed:", err);
    }
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Writes the current store snapshot SYNCHRONOUSLY, first cancelling any pending
 * debounced save. Used at quit so a mutation that never broadcast (e.g. the
 * window-focus lastActiveAt re-stamp) is still captured. Safe no-op when the
 * database is not yet initialized.
 */
export function flush(store: SpaceStore): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (db === null) {
    return;
  }
  try {
    writeState(db, serializeStore(store));
  } catch (err: unknown) {
    console.error("flush save failed:", err);
  }
}

/**
 * Closes the module-level database handle and cancels any pending debounced
 * save. Safe no-op when no database is open. Callers that mutate the on-disk
 * file afterwards (e.g. tests deleting the temp dir) must call this first so the
 * handle is released.
 */
export function closeDb(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (db !== null) {
    db.close();
    db = null;
  }
}
