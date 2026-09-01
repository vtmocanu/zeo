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
  id INTEGER PRIMARY KEY CHECK (id = 0), schemaVersion INTEGER NOT NULL, activeSpaceId TEXT
);
`;

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
 * fresh four-table schema and seeds the single meta row, `"noop"` leaves an
 * up-to-date database untouched. Absence of the `meta` table is treated as
 * version 0 (an empty/new file).
 */
function migrate(database: DatabaseType): void {
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
    case "noop":
      break;
  }
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
  migrate(database);
  return database;
}

/**
 * Opens (creating/migrating as needed) the on-disk database and returns the
 * restored {@link SpaceStore}, or `null` when there is nothing to restore (a
 * fresh database — the caller then seeds an initial store). On ANY failure to
 * open, migrate, or read (a corrupt file, or a schema version this build cannot
 * read), the offending files are moved aside, a fresh empty database is created
 * in their place, and `null` is returned so the app still launches.
 */
export function loadStore(): SpaceStore | null {
  try {
    db = openDb();
    if (hasData(db)) {
      return deserializeStore(readState(db));
    }
    return null;
  } catch (err: unknown) {
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
