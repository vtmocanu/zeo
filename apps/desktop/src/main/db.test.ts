import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Shared, per-test mutable userData directory. vi.hoisted lets the electron mock
// factory (hoisted above the imports) read a variable the tests reassign.
const mockState = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({
  app: {
    // db.ts only ever calls getPath("userData"); return the per-test temp dir.
    getPath: (): string => mockState.userData,
  },
}));

import { HISTORY_RETENTION_MS } from "@zeo/core";
import {
  migrate,
  loadStore,
  readBlockingEnabled,
  writeBlockingEnabled,
  readSearchEngine,
  writeSearchEngine,
  readQuickBrowseExternal,
  writeQuickBrowseExternal,
  readUpdateSettings,
  writeUpdateCheckEnabled,
  writeUpdateDismissedVersion,
  writeUpdateLastCheckedAt,
  readDefaultSessionMigratedAt,
  writeDefaultSessionMigratedAt,
  readAllowlist,
  insertAllowlistHost,
  deleteAllowlistHost,
  readSiteZoom,
  upsertSiteZoom,
  deleteSiteZoom,
  readWindowLayout,
  writeWindowLayout,
  readWindowState,
  writeWindowState,
  closeDb,
  recordVisit,
  updateVisitTitle,
  searchHistory,
  recentVisits,
  deleteHistoryUrl,
  clearHistory,
  historyStats,
  pruneHistory,
  insertDownload,
  updateDownload,
  deleteDownload,
  clearFinishedDownloadRows,
  listDownloads,
  markInterruptedDownloadsOnLaunch,
  scheduleSave,
  flush,
} from "./db.js";
import type { Download, WindowState } from "@zeo/core";

/** The pre-migration (schema v1) DDL: the four tables WITHOUT `meta.enabled`. */
const V1_DDL = `
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

/** The schema v2 DDL, with `meta.enabled` but no `blocking_allowlist` table. */
const V2_DDL = `
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
`;

/** The schema v3 DDL, adding the `blocking_allowlist` table to v2. */
const V3_DDL =
  V2_DDL +
  "CREATE TABLE blocking_allowlist (host TEXT PRIMARY KEY, createdAt INTEGER NOT NULL);";

/** The schema v4 DDL: the v3 tables plus the two history tables. A historical
 *  fixture predating the searchEngine column and site_zoom table. */
const V4_DDL =
  V3_DDL +
  `
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

/** The schema v5 DDL: v4 plus the meta.searchEngine column. */
const V5_DDL =
  V4_DDL +
  "ALTER TABLE meta ADD COLUMN searchEngine TEXT NOT NULL DEFAULT 'duckduckgo';";

/** The schema v6 DDL: v5 plus the site_zoom table. A historical fixture
 *  predating BOTH the downloads table and the meta layout columns. */
const V6_DDL =
  V5_DDL +
  "CREATE TABLE site_zoom (host TEXT PRIMARY KEY, factor REAL NOT NULL, updatedAt INTEGER NOT NULL);";

/** The schema v7 DDL: v6 plus the downloads table. A historical fixture
 *  predating the meta layout columns and the meta.quickBrowseExternal column. */
const V7_DDL =
  V6_DDL +
  "CREATE TABLE downloads (id TEXT PRIMARY KEY, url TEXT NOT NULL, filename TEXT NOT NULL, path TEXT NOT NULL, totalBytes INTEGER NOT NULL, receivedBytes INTEGER NOT NULL, state TEXT NOT NULL, startedAt INTEGER NOT NULL, completedAt INTEGER, spaceId TEXT);";

/** The schema v8 DDL: v7 plus the five meta layout columns. A historical fixture
 *  predating the meta.quickBrowseExternal column. */
const V8_DDL =
  V7_DDL +
  "ALTER TABLE meta ADD COLUMN layoutMode TEXT NOT NULL DEFAULT 'single';" +
  "ALTER TABLE meta ADD COLUMN layoutLeftTabId TEXT;" +
  "ALTER TABLE meta ADD COLUMN layoutRightTabId TEXT;" +
  "ALTER TABLE meta ADD COLUMN layoutRatio REAL NOT NULL DEFAULT 0.5;" +
  "ALTER TABLE meta ADD COLUMN layoutFocused TEXT NOT NULL DEFAULT 'left';";

/** The schema v9 DDL: v8 plus the meta.quickBrowseExternal column. A historical
 *  fixture predating the meta.defaultSessionMigratedAt column. */
const V9_DDL =
  V8_DDL +
  "ALTER TABLE meta ADD COLUMN quickBrowseExternal INTEGER NOT NULL DEFAULT 1;";

/** The schema v10 DDL: v9 plus the meta.defaultSessionMigratedAt column. */
const V10_DDL =
  V9_DDL + "ALTER TABLE meta ADD COLUMN defaultSessionMigratedAt INTEGER;";

/** The schema v11 DDL: v10 plus the window_state table. A historical fixture
 *  predating the meta.updateCheckEnabled/updateDismissedVersion/
 *  updateLastCheckedAt columns. */
const V11_DDL =
  V10_DDL +
  "CREATE TABLE window_state (id INTEGER PRIMARY KEY CHECK (id = 0), x INTEGER, y INTEGER, width INTEGER NOT NULL, height INTEGER NOT NULL, maximized INTEGER NOT NULL DEFAULT 0);";

/** The current (schema v12) DDL: v11 plus the three update-check meta columns. */
const V12_DDL =
  V11_DDL +
  "ALTER TABLE meta ADD COLUMN updateCheckEnabled INTEGER NOT NULL DEFAULT 1;" +
  "ALTER TABLE meta ADD COLUMN updateDismissedVersion TEXT;" +
  "ALTER TABLE meta ADD COLUMN updateLastCheckedAt INTEGER;";

/** True when the `history_visits` table exists in the database. */
function hasHistoryTable(db: Database.Database): boolean {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='history_visits'",
      )
      .get() !== undefined
  );
}

/** True when the `site_zoom` table exists in the database. */
function hasSiteZoomTable(db: Database.Database): boolean {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='site_zoom'",
      )
      .get() !== undefined
  );
}

/** True when the `window_state` table exists in the database. */
function hasWindowStateTable(db: Database.Database): boolean {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='window_state'",
      )
      .get() !== undefined
  );
}

/** True when the `meta` table has all five window-layout columns. */
function hasLayoutColumns(db: Database.Database): boolean {
  const cols = db.prepare("PRAGMA table_info(meta)").all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  return (
    names.has("layoutMode") &&
    names.has("layoutLeftTabId") &&
    names.has("layoutRightTabId") &&
    names.has("layoutRatio") &&
    names.has("layoutFocused")
  );
}

/** True when the `downloads` table exists in the database. */
function hasDownloadsTable(db: Database.Database): boolean {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='downloads'",
      )
      .get() !== undefined
  );
}

/** Seeds one profile, space, and tab so the migration's data-preservation and
 *  loadStore's has-data path can be asserted. */
function seedRows(db: Database.Database, activeSpaceId: string): void {
  db.prepare(
    "INSERT INTO profiles(id,name,createdAt,position) VALUES ('p1','Personal',1,0)",
  ).run();
  db.prepare(
    "INSERT INTO spaces(id,name,profileId,createdAt,activeTabId,position) VALUES (?, 'Home','p1',1,'t1',0)",
  ).run(activeSpaceId);
  db.prepare(
    "INSERT INTO tabs(id,spaceId,url,title,faviconUrl,createdAt,pinned,lastActiveAt,archivedAt,position) " +
      "VALUES ('t1', ?, 'https://example.com','Example',NULL,1,0,1,NULL,0)",
  ).run(activeSpaceId);
}

/** True when the `meta` table has an `enabled` column. */
function hasEnabledColumn(db: Database.Database): boolean {
  const cols = db.prepare("PRAGMA table_info(meta)").all() as { name: string }[];
  return cols.some((c) => c.name === "enabled");
}

/** True when the `meta` table has a `searchEngine` column. */
function hasSearchEngineColumn(db: Database.Database): boolean {
  const cols = db.prepare("PRAGMA table_info(meta)").all() as { name: string }[];
  return cols.some((c) => c.name === "searchEngine");
}

/** True when the `meta` table has a `quickBrowseExternal` column. */
function hasQuickBrowseExternalColumn(db: Database.Database): boolean {
  const cols = db.prepare("PRAGMA table_info(meta)").all() as { name: string }[];
  return cols.some((c) => c.name === "quickBrowseExternal");
}

/** True when the `meta` table has a `defaultSessionMigratedAt` column. */
function hasDefaultSessionMigratedAtColumn(db: Database.Database): boolean {
  const cols = db.prepare("PRAGMA table_info(meta)").all() as { name: string }[];
  return cols.some((c) => c.name === "defaultSessionMigratedAt");
}

/** True when the `blocking_allowlist` table exists. */
function hasAllowlistTable(db: Database.Database): boolean {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='blocking_allowlist'",
      )
      .get() !== undefined
  );
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zeo-db-test-"));
  mockState.userData = tempDir;
});

afterEach(() => {
  // Release the module-level handle loadStore may have opened before deleting
  // the temp dir, so no database file stays open across tests.
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("migrate", () => {
  test("upgrades a v1 database to the current version, adding enabled, the allowlist, history, the search engine, site_zoom, the downloads table, and the quick-browse toggle and preserving rows", () => {
    const path = join(tempDir, "v1.db");
    const db = new Database(path);
    db.exec(V1_DDL);
    db.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId) VALUES (0, 1, ?)",
    ).run("space-1");
    seedRows(db, "space-1");

    expect(hasEnabledColumn(db)).toBe(false);
    expect(hasHistoryTable(db)).toBe(false);
    expect(hasSiteZoomTable(db)).toBe(false);
    expect(hasSearchEngineColumn(db)).toBe(false);
    expect(hasDownloadsTable(db)).toBe(false);

    migrate(db);

    const meta = db
      .prepare(
        "SELECT schemaVersion, activeSpaceId, enabled, searchEngine, quickBrowseExternal FROM meta WHERE id=0",
      )
      .get() as {
      schemaVersion: number;
      activeSpaceId: string;
      enabled: number;
      searchEngine: string;
      quickBrowseExternal: number;
    };
    expect(meta.schemaVersion).toBe(12);
    expect(hasEnabledColumn(db)).toBe(true);
    expect(hasAllowlistTable(db)).toBe(true);
    expect(meta.enabled).toBe(1);
    expect(hasHistoryTable(db)).toBe(true);
    expect(hasSearchEngineColumn(db)).toBe(true);
    expect(meta.searchEngine).toBe("duckduckgo");
    expect(hasSiteZoomTable(db)).toBe(true);
    expect(hasLayoutColumns(db)).toBe(true);
    expect(hasDownloadsTable(db)).toBe(true);
    expect(hasWindowStateTable(db)).toBe(true);
    expect(hasQuickBrowseExternalColumn(db)).toBe(true);
    expect(meta.quickBrowseExternal).toBe(1);
    // Pre-existing rows preserved.
    expect(meta.activeSpaceId).toBe("space-1");
    expect(db.prepare("SELECT id FROM profiles").get()).toEqual({ id: "p1" });
    expect(db.prepare("SELECT id FROM spaces").get()).toEqual({ id: "space-1" });
    expect(db.prepare("SELECT id FROM tabs").get()).toEqual({ id: "t1" });
    db.close();
  });

  test("upgrades a v2 database to the current version, adding the allowlist, history, the search engine, site_zoom, the downloads table, and the quick-browse toggle and preserving rows", () => {
    const path = join(tempDir, "v2.db");
    const db = new Database(path);
    db.exec(V2_DDL);
    // Seed enabled=0 so the migration is confirmed to preserve the flag.
    db.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled) VALUES (0, 2, ?, 0)",
    ).run("space-1");
    seedRows(db, "space-1");

    expect(hasAllowlistTable(db)).toBe(false);
    expect(hasHistoryTable(db)).toBe(false);
    expect(hasSiteZoomTable(db)).toBe(false);
    expect(hasDownloadsTable(db)).toBe(false);

    migrate(db);

    const meta = db
      .prepare(
        "SELECT schemaVersion, activeSpaceId, enabled, quickBrowseExternal FROM meta WHERE id=0",
      )
      .get() as {
      schemaVersion: number;
      activeSpaceId: string;
      enabled: number;
      quickBrowseExternal: number;
    };
    expect(meta.schemaVersion).toBe(12);
    expect(hasAllowlistTable(db)).toBe(true);
    expect(hasHistoryTable(db)).toBe(true);
    expect(hasSearchEngineColumn(db)).toBe(true);
    expect(hasSiteZoomTable(db)).toBe(true);
    expect(hasLayoutColumns(db)).toBe(true);
    expect(hasDownloadsTable(db)).toBe(true);
    expect(hasWindowStateTable(db)).toBe(true);
    expect(hasQuickBrowseExternalColumn(db)).toBe(true);
    expect(meta.quickBrowseExternal).toBe(1);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='history_entries'",
        )
        .get(),
    ).toEqual({ name: "history_entries" });
    // Pre-existing rows and the enabled flag preserved.
    expect(meta.activeSpaceId).toBe("space-1");
    expect(meta.enabled).toBe(0);
    expect(db.prepare("SELECT id FROM profiles").get()).toEqual({ id: "p1" });
    expect(db.prepare("SELECT id FROM spaces").get()).toEqual({ id: "space-1" });
    expect(db.prepare("SELECT id FROM tabs").get()).toEqual({ id: "t1" });
    db.close();
  });

  test("upgrades a v3 database to the current version, adding the history tables, the search engine, site_zoom, the downloads table, and the quick-browse toggle and preserving the allowlist and rows", () => {
    const path = join(tempDir, "v3-to-current.db");
    const db = new Database(path);
    db.exec(V3_DDL);
    // Seed enabled=0 so the migration is confirmed to preserve the flag.
    db.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled) VALUES (0, 3, ?, 0)",
    ).run("space-1");
    seedRows(db, "space-1");
    db.prepare(
      "INSERT INTO blocking_allowlist(host,createdAt) VALUES ('example.com', 5)",
    ).run();

    expect(hasHistoryTable(db)).toBe(false);
    expect(hasSiteZoomTable(db)).toBe(false);
    expect(hasDownloadsTable(db)).toBe(false);

    migrate(db);

    const meta = db
      .prepare(
        "SELECT schemaVersion, activeSpaceId, enabled, quickBrowseExternal FROM meta WHERE id=0",
      )
      .get() as {
      schemaVersion: number;
      activeSpaceId: string;
      enabled: number;
      quickBrowseExternal: number;
    };
    expect(meta.schemaVersion).toBe(12);
    expect(hasHistoryTable(db)).toBe(true);
    expect(hasSearchEngineColumn(db)).toBe(true);
    expect(hasSiteZoomTable(db)).toBe(true);
    expect(hasLayoutColumns(db)).toBe(true);
    expect(hasDownloadsTable(db)).toBe(true);
    expect(hasWindowStateTable(db)).toBe(true);
    expect(hasQuickBrowseExternalColumn(db)).toBe(true);
    expect(meta.quickBrowseExternal).toBe(1);
    // Pre-existing allowlist, rows, and the enabled flag preserved.
    expect(hasAllowlistTable(db)).toBe(true);
    expect(db.prepare("SELECT host FROM blocking_allowlist").get()).toEqual({
      host: "example.com",
    });
    expect(meta.activeSpaceId).toBe("space-1");
    expect(meta.enabled).toBe(0);
    expect(db.prepare("SELECT id FROM tabs").get()).toEqual({ id: "t1" });
    db.close();
  });

  test("upgrades a v4 database to the current version, adding the searchEngine column, site_zoom table, the downloads table, and the quick-browse toggle and preserving rows", () => {
    const path = join(tempDir, "v4-to-current.db");
    const db = new Database(path);
    db.exec(V4_DDL);
    // Seed enabled=0 so the migration is confirmed to preserve the flag.
    db.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled) VALUES (0, 4, ?, 0)",
    ).run("space-1");
    seedRows(db, "space-1");

    expect(hasSearchEngineColumn(db)).toBe(false);
    expect(hasSiteZoomTable(db)).toBe(false);
    expect(hasDownloadsTable(db)).toBe(false);

    migrate(db);

    const meta = db
      .prepare(
        "SELECT schemaVersion, activeSpaceId, enabled, searchEngine, quickBrowseExternal FROM meta WHERE id=0",
      )
      .get() as {
      schemaVersion: number;
      activeSpaceId: string;
      enabled: number;
      searchEngine: string;
      quickBrowseExternal: number;
    };
    expect(meta.schemaVersion).toBe(12);
    expect(hasSearchEngineColumn(db)).toBe(true);
    // The new column defaults to duckduckgo on the existing row.
    expect(meta.searchEngine).toBe("duckduckgo");
    expect(hasSiteZoomTable(db)).toBe(true);
    expect(hasLayoutColumns(db)).toBe(true);
    expect(hasDownloadsTable(db)).toBe(true);
    expect(hasWindowStateTable(db)).toBe(true);
    expect(hasQuickBrowseExternalColumn(db)).toBe(true);
    // The quick-browse toggle defaults to 1 (ON) on the existing row.
    expect(meta.quickBrowseExternal).toBe(1);
    // Pre-existing rows and the enabled flag preserved.
    expect(meta.activeSpaceId).toBe("space-1");
    expect(meta.enabled).toBe(0);
    expect(db.prepare("SELECT id FROM profiles").get()).toEqual({ id: "p1" });
    expect(db.prepare("SELECT id FROM spaces").get()).toEqual({ id: "space-1" });
    expect(db.prepare("SELECT id FROM tabs").get()).toEqual({ id: "t1" });
    db.close();
  });

  test("upgrades a v5 database to the current version, adding an empty site_zoom table, the downloads table, the layout columns, and the quick-browse toggle and preserving the search engine and other state", () => {
    const path = join(tempDir, "v5-to-current.db");
    const db = new Database(path);
    db.exec(V5_DDL);
    // Seed enabled=0 and a non-default searchEngine so a spurious re-create/migrate
    // (which would reset them to their defaults) is detectable.
    db.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled,searchEngine) VALUES (0, 5, 'space-9', 0, 'google')",
    ).run();

    expect(hasSiteZoomTable(db)).toBe(false);
    expect(hasDownloadsTable(db)).toBe(false);
    expect(hasSearchEngineColumn(db)).toBe(true);
    expect(hasQuickBrowseExternalColumn(db)).toBe(false);

    migrate(db);

    const meta = db
      .prepare(
        "SELECT schemaVersion, activeSpaceId, enabled, searchEngine, quickBrowseExternal FROM meta WHERE id=0",
      )
      .get() as {
      schemaVersion: number;
      activeSpaceId: string;
      enabled: number;
      searchEngine: string;
      quickBrowseExternal: number;
    };
    expect(meta.schemaVersion).toBe(12);
    expect(hasSiteZoomTable(db)).toBe(true);
    expect(hasLayoutColumns(db)).toBe(true);
    expect(hasDownloadsTable(db)).toBe(true);
    expect(hasWindowStateTable(db)).toBe(true);
    // The freshly-created tables start with no rows.
    const zoomCount = db
      .prepare("SELECT COUNT(*) AS n FROM site_zoom")
      .get() as { n: number };
    expect(zoomCount.n).toBe(0);
    const downloadCount = db
      .prepare("SELECT COUNT(*) AS n FROM downloads")
      .get() as { n: number };
    expect(downloadCount.n).toBe(0);
    // The quick-browse toggle column is added and defaults to 1 (ON).
    expect(hasQuickBrowseExternalColumn(db)).toBe(true);
    expect(meta.quickBrowseExternal).toBe(1);
    // The search engine is preserved (not reset) and other seeded state survives.
    expect(meta.searchEngine).toBe("google");
    expect(meta.activeSpaceId).toBe("space-9");
    expect(meta.enabled).toBe(0);
    db.close();
  });

  test("upgrades a v6 database to the current version (v9), adding the downloads table, the layout columns, and the quick-browse toggle and preserving the site_zoom row and other state", () => {
    const path = join(tempDir, "v6-to-current.db");
    const db = new Database(path);
    db.exec(V6_DDL);
    // Seed enabled=0, a non-default searchEngine, seeded tab rows, and a site_zoom
    // row so a spurious re-create (which would wipe them) is detectable.
    db.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled,searchEngine) VALUES (0, 6, 'space-1', 0, 'google')",
    ).run();
    seedRows(db, "space-1");
    db.prepare(
      "INSERT INTO site_zoom(host,factor,updatedAt) VALUES ('example.com', 1.5, 42)",
    ).run();

    expect(hasDownloadsTable(db)).toBe(false);
    expect(hasQuickBrowseExternalColumn(db)).toBe(false);
    expect(hasLayoutColumns(db)).toBe(false);

    migrate(db);

    const meta = db
      .prepare(
        "SELECT schemaVersion, activeSpaceId, enabled, searchEngine, quickBrowseExternal, layoutMode, layoutLeftTabId, layoutRightTabId, layoutRatio, layoutFocused FROM meta WHERE id=0",
      )
      .get() as {
      schemaVersion: number;
      activeSpaceId: string;
      enabled: number;
      searchEngine: string;
      quickBrowseExternal: number;
      layoutMode: string;
      layoutLeftTabId: string | null;
      layoutRightTabId: string | null;
      layoutRatio: number;
      layoutFocused: string;
    };
    expect(meta.schemaVersion).toBe(12);
    // The downloads table is present and empty.
    expect(hasDownloadsTable(db)).toBe(true);
    const downloadCount = db
      .prepare("SELECT COUNT(*) AS n FROM downloads")
      .get() as { n: number };
    expect(downloadCount.n).toBe(0);
    // The window_state table is present.
    expect(hasWindowStateTable(db)).toBe(true);
    // The quick-browse toggle column is added and defaults to 1 (ON).
    expect(hasQuickBrowseExternalColumn(db)).toBe(true);
    expect(meta.quickBrowseExternal).toBe(1);
    // The five layout columns are present with their defaults on the existing row.
    expect(hasLayoutColumns(db)).toBe(true);
    expect(meta.layoutMode).toBe("single");
    expect(meta.layoutLeftTabId).toBe(null);
    expect(meta.layoutRightTabId).toBe(null);
    expect(meta.layoutRatio).toBe(0.5);
    expect(meta.layoutFocused).toBe("left");
    // Pre-existing state preserved (no re-create wiped it).
    expect(meta.activeSpaceId).toBe("space-1");
    expect(meta.enabled).toBe(0);
    expect(meta.searchEngine).toBe("google");
    expect(db.prepare("SELECT id FROM tabs").get()).toEqual({ id: "t1" });
    // Pre-existing site_zoom row survives the upgrade.
    expect(
      db.prepare("SELECT host, factor, updatedAt FROM site_zoom").get(),
    ).toEqual({ host: "example.com", factor: 1.5, updatedAt: 42 });
    db.close();
  });

  test("upgrades a v7 database to the current version (v9), adding the layout columns and the quick-browse toggle and preserving the site_zoom and downloads rows and other state", () => {
    const path = join(tempDir, "v7-to-current.db");
    const db = new Database(path);
    db.exec(V7_DDL);
    // Seed enabled=0 and a non-default searchEngine so a spurious re-create/migrate
    // (which would reset them to their defaults) is detectable, plus a site_zoom row
    // and a downloads row that must survive the column-add untouched.
    db.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled,searchEngine) VALUES (0, 7, 'space-9', 0, 'google')",
    ).run();
    db.prepare(
      "INSERT INTO site_zoom(host,factor,updatedAt) VALUES ('example.com', 1.5, 42)",
    ).run();
    db.prepare(
      "INSERT INTO downloads(id,url,filename,path,totalBytes,receivedBytes,state,startedAt,completedAt,spaceId) " +
        "VALUES ('d1','https://example.com/f.bin','f.bin','/dl/f.bin',100,100,'completed',1000,2000,'space-9')",
    ).run();

    expect(hasQuickBrowseExternalColumn(db)).toBe(false);
    expect(hasLayoutColumns(db)).toBe(false);

    migrate(db);

    const meta = db
      .prepare(
        "SELECT schemaVersion, activeSpaceId, enabled, searchEngine, quickBrowseExternal, layoutMode, layoutLeftTabId, layoutRightTabId, layoutRatio, layoutFocused FROM meta WHERE id=0",
      )
      .get() as {
      schemaVersion: number;
      activeSpaceId: string;
      enabled: number;
      searchEngine: string;
      quickBrowseExternal: number;
      layoutMode: string;
      layoutLeftTabId: string | null;
      layoutRightTabId: string | null;
      layoutRatio: number;
      layoutFocused: string;
    };
    expect(meta.schemaVersion).toBe(12);
    // The window_state table is present.
    expect(hasWindowStateTable(db)).toBe(true);
    // The quick-browse toggle column is added and defaults to 1 (ON).
    expect(hasQuickBrowseExternalColumn(db)).toBe(true);
    expect(meta.quickBrowseExternal).toBe(1);
    // The five layout columns are present with their defaults on the existing row.
    expect(hasLayoutColumns(db)).toBe(true);
    expect(meta.layoutMode).toBe("single");
    expect(meta.layoutLeftTabId).toBe(null);
    expect(meta.layoutRightTabId).toBe(null);
    expect(meta.layoutRatio).toBe(0.5);
    expect(meta.layoutFocused).toBe("left");
    // Pre-existing state and the downloads row are preserved (no re-create wiped them).
    expect(meta.activeSpaceId).toBe("space-9");
    expect(meta.enabled).toBe(0);
    expect(meta.searchEngine).toBe("google");
    // The seeded downloads row survives the column-add unchanged.
    expect(
      db
        .prepare("SELECT id, state, receivedBytes, completedAt FROM downloads")
        .get(),
    ).toEqual({
      id: "d1",
      state: "completed",
      receivedBytes: 100,
      completedAt: 2000,
    });
    // Pre-existing site_zoom row survives the upgrade.
    expect(
      db.prepare("SELECT host, factor, updatedAt FROM site_zoom").get(),
    ).toEqual({ host: "example.com", factor: 1.5, updatedAt: 42 });
    db.close();
  });

  test("upgrades a v8 database to the current version (v9), adding only the quick-browse toggle and preserving the non-default layout values and other state", () => {
    const path = join(tempDir, "v8-to-current.db");
    const db = new Database(path);
    db.exec(V8_DDL);
    // Seed schemaVersion=8 with NON-default layout values plus enabled=0 and a
    // non-default searchEngine so a spurious re-run of step 8 (which would reset
    // the layout columns to their DDL defaults) or a re-create is detectable. This
    // is the real 0.0.21 -> 0.0.22 upgrade path: a v8 DB already has the layout
    // columns, so migrate must run ONLY step 9 to add quickBrowseExternal.
    db.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled,searchEngine,layoutMode,layoutLeftTabId,layoutRightTabId,layoutRatio,layoutFocused) " +
        "VALUES (0, 8, 'space-9', 0, 'google', 'split', 'tL', 'tR', 0.7, 'right')",
    ).run();

    expect(hasLayoutColumns(db)).toBe(true);
    expect(hasQuickBrowseExternalColumn(db)).toBe(false);

    migrate(db);

    const meta = db
      .prepare(
        "SELECT schemaVersion, activeSpaceId, enabled, searchEngine, quickBrowseExternal, layoutMode, layoutLeftTabId, layoutRightTabId, layoutRatio, layoutFocused FROM meta WHERE id=0",
      )
      .get() as {
      schemaVersion: number;
      activeSpaceId: string;
      enabled: number;
      searchEngine: string;
      quickBrowseExternal: number;
      layoutMode: string;
      layoutLeftTabId: string | null;
      layoutRightTabId: string | null;
      layoutRatio: number;
      layoutFocused: string;
    };
    expect(meta.schemaVersion).toBe(12);
    // Step 11 adds the window_state table.
    expect(hasWindowStateTable(db)).toBe(true);
    // Step 9 adds the quick-browse toggle column, defaulting to 1 (ON).
    expect(hasQuickBrowseExternalColumn(db)).toBe(true);
    expect(meta.quickBrowseExternal).toBe(1);
    // Step 8 is NOT re-run: the existing layout columns keep their non-default
    // seeded values.
    expect(hasLayoutColumns(db)).toBe(true);
    expect(meta.layoutMode).toBe("split");
    expect(meta.layoutLeftTabId).toBe("tL");
    expect(meta.layoutRightTabId).toBe("tR");
    expect(meta.layoutRatio).toBe(0.7);
    expect(meta.layoutFocused).toBe("right");
    // Pre-existing state preserved (no re-create wiped it).
    expect(meta.activeSpaceId).toBe("space-9");
    expect(meta.enabled).toBe(0);
    expect(meta.searchEngine).toBe("google");
    db.close();
  });

  test("creates a fresh v11 schema with enabled=1, the allowlist, history, site_zoom, and downloads tables, the search engine, the layout columns, the quick-browse toggle, and a non-null default-session marker on an empty database", () => {
    const path = join(tempDir, "fresh.db");
    const db = new Database(path);

    migrate(db);

    const meta = db
      .prepare(
        "SELECT schemaVersion, enabled, searchEngine, quickBrowseExternal, layoutMode, layoutLeftTabId, layoutRightTabId, layoutRatio, layoutFocused, defaultSessionMigratedAt FROM meta WHERE id=0",
      )
      .get() as {
      schemaVersion: number;
      enabled: number;
      searchEngine: string;
      quickBrowseExternal: number;
      layoutMode: string;
      layoutLeftTabId: string | null;
      layoutRightTabId: string | null;
      layoutRatio: number;
      layoutFocused: string;
      defaultSessionMigratedAt: number | null;
    };
    expect(meta.schemaVersion).toBe(12);
    expect(hasEnabledColumn(db)).toBe(true);
    expect(hasAllowlistTable(db)).toBe(true);
    expect(meta.enabled).toBe(1);
    expect(hasHistoryTable(db)).toBe(true);
    expect(hasSearchEngineColumn(db)).toBe(true);
    expect(meta.searchEngine).toBe("duckduckgo");
    expect(hasSiteZoomTable(db)).toBe(true);
    // The layout columns exist and carry their DDL defaults on the seeded row.
    expect(hasLayoutColumns(db)).toBe(true);
    expect(meta.layoutMode).toBe("single");
    expect(meta.layoutLeftTabId).toBe(null);
    expect(meta.layoutRightTabId).toBe(null);
    expect(meta.layoutRatio).toBe(0.5);
    expect(meta.layoutFocused).toBe("left");
    // The downloads table exists.
    expect(hasDownloadsTable(db)).toBe(true);
    // The window_state table exists (created empty, with no seed row).
    expect(hasWindowStateTable(db)).toBe(true);
    expect(hasQuickBrowseExternalColumn(db)).toBe(true);
    expect(meta.quickBrowseExternal).toBe(1);
    // A fresh install has nothing to migrate, so the default-session marker column
    // exists and is seeded NON-null.
    expect(hasDefaultSessionMigratedAtColumn(db)).toBe(true);
    expect(meta.defaultSessionMigratedAt).not.toBeNull();
    db.close();
  });

  test("upgrades a v9 database to the current version (v11), adding the default-session marker column (reading null) and preserving prior state", () => {
    const path = join(tempDir, "v9.db");
    const db = new Database(path);
    db.exec(V9_DDL);
    // Seed enabled=0, a non-default searchEngine, NON-default layout values, and
    // quickBrowseExternal=0 so the upgrade is confirmed to preserve prior state.
    db.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled,searchEngine,layoutMode,layoutLeftTabId,layoutRightTabId,layoutRatio,layoutFocused,quickBrowseExternal) " +
        "VALUES (0, 9, 'space-9', 0, 'google', 'split', 'tL', 'tR', 0.35, 'right', 0)",
    ).run();
    seedRows(db, "space-9");

    expect(hasDefaultSessionMigratedAtColumn(db)).toBe(false);

    migrate(db);

    const meta = db
      .prepare(
        "SELECT schemaVersion, activeSpaceId, enabled, searchEngine, quickBrowseExternal, layoutMode, layoutLeftTabId, layoutRightTabId, layoutRatio, layoutFocused, defaultSessionMigratedAt FROM meta WHERE id=0",
      )
      .get() as {
      schemaVersion: number;
      activeSpaceId: string;
      enabled: number;
      searchEngine: string;
      quickBrowseExternal: number;
      layoutMode: string;
      layoutLeftTabId: string | null;
      layoutRightTabId: string | null;
      layoutRatio: number;
      layoutFocused: string;
      defaultSessionMigratedAt: number | null;
    };
    expect(meta.schemaVersion).toBe(12);
    // The window_state table is present after the upgrade.
    expect(hasWindowStateTable(db)).toBe(true);
    // The new column exists and, for an UPGRADED database, reads null (unmigrated).
    expect(hasDefaultSessionMigratedAtColumn(db)).toBe(true);
    expect(meta.defaultSessionMigratedAt).toBeNull();
    // Prior state preserved by the upgrade.
    expect(meta.activeSpaceId).toBe("space-9");
    expect(meta.enabled).toBe(0);
    expect(meta.searchEngine).toBe("google");
    expect(meta.quickBrowseExternal).toBe(0);
    expect(meta.layoutMode).toBe("split");
    expect(meta.layoutLeftTabId).toBe("tL");
    expect(meta.layoutRightTabId).toBe("tR");
    expect(meta.layoutRatio).toBe(0.35);
    expect(meta.layoutFocused).toBe("right");
    expect(db.prepare("SELECT id FROM profiles").get()).toEqual({ id: "p1" });
    expect(db.prepare("SELECT id FROM spaces").get()).toEqual({ id: "space-9" });
    expect(db.prepare("SELECT id FROM tabs").get()).toEqual({ id: "t1" });
    db.close();
  });

  test("upgrades a v10 database to the current version (v11), adding the empty window_state table and preserving prior state", () => {
    const path = join(tempDir, "v10-to-v11.db");
    const db = new Database(path);
    db.exec(V10_DDL);
    db.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled,searchEngine,defaultSessionMigratedAt) VALUES (0, 10, 'space-10', 0, 'google', 12345)",
    ).run();
    seedRows(db, "space-10");

    // The window_state table does not exist before the upgrade.
    expect(hasWindowStateTable(db)).toBe(false);

    migrate(db);

    const meta = db
      .prepare("SELECT schemaVersion, activeSpaceId FROM meta WHERE id=0")
      .get() as { schemaVersion: number; activeSpaceId: string };
    expect(meta.schemaVersion).toBe(12);
    // The window_state table is created and starts EMPTY (no seed row).
    expect(hasWindowStateTable(db)).toBe(true);
    const windowStateCount = db
      .prepare("SELECT COUNT(*) AS n FROM window_state")
      .get() as { n: number };
    expect(windowStateCount.n).toBe(0);
    // Pre-existing rows preserved (no re-create wiped them).
    expect(meta.activeSpaceId).toBe("space-10");
    expect(db.prepare("SELECT id FROM profiles").get()).toEqual({ id: "p1" });
    expect(db.prepare("SELECT id FROM spaces").get()).toEqual({ id: "space-10" });
    expect(db.prepare("SELECT id FROM tabs").get()).toEqual({ id: "t1" });
    db.close();
  });

  test("upgrades a v11 database to the current version (v12), adding the three update-check columns and preserving prior state", () => {
    const path = join(tempDir, "v11-to-v12.db");
    const db = new Database(path);
    db.exec(V11_DDL);
    db.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled,searchEngine,defaultSessionMigratedAt) VALUES (0, 11, 'space-11', 0, 'google', 12345)",
    ).run();
    seedRows(db, "space-11");

    migrate(db);

    const meta = db
      .prepare(
        "SELECT schemaVersion, activeSpaceId, updateCheckEnabled, updateDismissedVersion, updateLastCheckedAt FROM meta WHERE id=0",
      )
      .get() as {
      schemaVersion: number;
      activeSpaceId: string;
      updateCheckEnabled: number;
      updateDismissedVersion: string | null;
      updateLastCheckedAt: number | null;
    };
    expect(meta.schemaVersion).toBe(12);
    // The updateCheckEnabled column defaults to 1 (on); the two nullable
    // columns default to null (never dismissed, never checked).
    expect(meta.updateCheckEnabled).toBe(1);
    expect(meta.updateDismissedVersion).toBeNull();
    expect(meta.updateLastCheckedAt).toBeNull();
    // Pre-existing rows preserved (no re-create wiped them).
    expect(meta.activeSpaceId).toBe("space-11");
    expect(db.prepare("SELECT id FROM profiles").get()).toEqual({ id: "p1" });
    expect(db.prepare("SELECT id FROM spaces").get()).toEqual({ id: "space-11" });
    expect(db.prepare("SELECT id FROM tabs").get()).toEqual({ id: "t1" });
    db.close();
  });

  test("is a no-op on a database already at the current version (v12) with non-default layout values, quickBrowseExternal, updateCheckEnabled, and a set default-session marker, leaving the site_zoom and downloads rows untouched", () => {
    const path = join(tempDir, "v12.db");
    const db = new Database(path);
    db.exec(V12_DDL);
    // Seed enabled=0, a non-default searchEngine, NON-default layout values,
    // quickBrowseExternal=0, updateCheckEnabled=0 with a dismissed version and a
    // set last-checked time, and a NON-null default-session marker so a spurious
    // re-create/migrate (which would reset them to their defaults / null) is
    // detectable, plus site_zoom, downloads, and window_state rows so a re-create
    // would be observable.
    db.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled,searchEngine,layoutMode,layoutLeftTabId,layoutRightTabId,layoutRatio,layoutFocused,quickBrowseExternal,defaultSessionMigratedAt,updateCheckEnabled,updateDismissedVersion,updateLastCheckedAt) " +
        "VALUES (0, 12, 'space-10', 0, 'google', 'split', 'tL', 'tR', 0.35, 'right', 0, 12345, 0, '9.9.9', 55555)",
    ).run();
    db.prepare(
      "INSERT INTO site_zoom(host,factor,updatedAt) VALUES ('example.com', 1.5, 42)",
    ).run();
    db.prepare(
      "INSERT INTO downloads(id,url,filename,path,totalBytes,receivedBytes,state,startedAt,completedAt,spaceId) " +
        "VALUES ('d1','https://example.com/f.bin','f.bin','/dl/f.bin',100,100,'completed',1000,2000,'space-10')",
    ).run();
    db.prepare(
      "INSERT INTO window_state(id,x,y,width,height,maximized) VALUES (0, 5, 6, 900, 700, 1)",
    ).run();

    migrate(db);

    const meta = db
      .prepare(
        "SELECT schemaVersion, activeSpaceId, enabled, searchEngine, quickBrowseExternal, layoutMode, layoutLeftTabId, layoutRightTabId, layoutRatio, layoutFocused, defaultSessionMigratedAt, updateCheckEnabled, updateDismissedVersion, updateLastCheckedAt FROM meta WHERE id=0",
      )
      .get() as {
      schemaVersion: number;
      activeSpaceId: string;
      enabled: number;
      searchEngine: string;
      quickBrowseExternal: number;
      layoutMode: string;
      layoutLeftTabId: string | null;
      layoutRightTabId: string | null;
      layoutRatio: number;
      layoutFocused: string;
      defaultSessionMigratedAt: number | null;
      updateCheckEnabled: number;
      updateDismissedVersion: string | null;
      updateLastCheckedAt: number | null;
    };
    expect(meta.schemaVersion).toBe(12);
    expect(meta.activeSpaceId).toBe("space-10");
    expect(meta.enabled).toBe(0);
    expect(meta.searchEngine).toBe("google");
    // The seeded quick-browse toggle is left untouched (no re-create reset it to 1).
    expect(meta.quickBrowseExternal).toBe(0);
    // The seeded default-session marker is left untouched (no re-create reset it).
    expect(meta.defaultSessionMigratedAt).toBe(12345);
    // The seeded update-check settings are left untouched (no re-create reset
    // them to their defaults).
    expect(meta.updateCheckEnabled).toBe(0);
    expect(meta.updateDismissedVersion).toBe("9.9.9");
    expect(meta.updateLastCheckedAt).toBe(55555);
    // The non-default layout values are left untouched (no re-run of step 8).
    expect(meta.layoutMode).toBe("split");
    expect(meta.layoutLeftTabId).toBe("tL");
    expect(meta.layoutRightTabId).toBe("tR");
    expect(meta.layoutRatio).toBe(0.35);
    expect(meta.layoutFocused).toBe("right");
    // The existing site_zoom row is left untouched (no re-create wiped it).
    expect(
      db.prepare("SELECT host, factor, updatedAt FROM site_zoom").get(),
    ).toEqual({ host: "example.com", factor: 1.5, updatedAt: 42 });
    // The seeded downloads row is left untouched.
    expect(
      db
        .prepare("SELECT id, state, receivedBytes, completedAt FROM downloads")
        .get(),
    ).toEqual({ id: "d1", state: "completed", receivedBytes: 100, completedAt: 2000 });
    // The seeded window_state row is left untouched (no re-create wiped it).
    expect(
      db
        .prepare("SELECT x, y, width, height, maximized FROM window_state WHERE id=0")
        .get(),
    ).toEqual({ x: 5, y: 6, width: 900, height: 700, maximized: 1 });
    db.close();
  });
});

describe("readAllowlist / insertAllowlistHost / deleteAllowlistHost", () => {
  test("round-trip: insert (ordered), INSERT OR IGNORE on a dup is a no-op, delete removes one", () => {
    // Hand-build a valid current (v9) database at the path loadStore will open.
    const path = join(tempDir, "zeo.db");
    const seed = new Database(path);
    seed.exec(V9_DDL);
    seed.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled) VALUES (0, 9, 'space-x', 1)",
    ).run();
    seedRows(seed, "space-x");
    seed.close();

    // loadStore opens the module-level handle the helpers use.
    loadStore();
    expect(readAllowlist()).toEqual([]);

    // Insert two hosts out of order; readAllowlist returns them ordered by host.
    insertAllowlistHost("b.example", 200);
    insertAllowlistHost("a.example", 100);
    expect(readAllowlist()).toEqual(["a.example", "b.example"]);

    // INSERT OR IGNORE on a duplicate host is a no-op: no throw, no new row, the
    // original createdAt is untouched.
    insertAllowlistHost("a.example", 999);
    expect(readAllowlist()).toEqual(["a.example", "b.example"]);
    const inspect = new Database(path, { readonly: true });
    const row = inspect
      .prepare("SELECT createdAt FROM blocking_allowlist WHERE host='a.example'")
      .get() as { createdAt: number };
    expect(row.createdAt).toBe(100);
    inspect.close();

    // Delete removes exactly the named host.
    deleteAllowlistHost("a.example");
    expect(readAllowlist()).toEqual(["b.example"]);
  });
});

describe("readSiteZoom / upsertSiteZoom / deleteSiteZoom", () => {
  // Each test opens the module-level handle on a fresh, migrated (v9) database
  // via loadStore(), so the helpers act on the same handle production uses.
  beforeEach(() => {
    loadStore();
  });

  test("readSiteZoom on an empty table returns an empty map", () => {
    expect(readSiteZoom()).toEqual({});
  });

  test("upsertSiteZoom inserts a row that readSiteZoom returns as {host: factor}", () => {
    upsertSiteZoom("a.example", 1.5, 100);
    expect(readSiteZoom()).toEqual({ "a.example": 1.5 });

    // A second host folds into the same map.
    upsertSiteZoom("b.example", 0.75, 200);
    expect(readSiteZoom()).toEqual({ "a.example": 1.5, "b.example": 0.75 });
  });

  test("a second upsertSiteZoom on the same host replaces factor and updatedAt", () => {
    upsertSiteZoom("a.example", 1.5, 100);
    upsertSiteZoom("a.example", 2.0, 300);
    expect(readSiteZoom()).toEqual({ "a.example": 2.0 });

    // The stored updatedAt was overwritten too (single row per host).
    const database = new Database(join(tempDir, "zeo.db"), { readonly: true });
    const row = database
      .prepare("SELECT factor, updatedAt FROM site_zoom WHERE host='a.example'")
      .get() as { factor: number; updatedAt: number };
    expect(row).toEqual({ factor: 2.0, updatedAt: 300 });
    database.close();
  });

  test("deleteSiteZoom removes a host and is a no-op on an absent host", () => {
    upsertSiteZoom("a.example", 1.5, 100);
    upsertSiteZoom("b.example", 0.9, 200);

    deleteSiteZoom("a.example");
    expect(readSiteZoom()).toEqual({ "b.example": 0.9 });

    // Deleting a host with no row is a silent no-op.
    expect(() => deleteSiteZoom("missing.example")).not.toThrow();
    expect(readSiteZoom()).toEqual({ "b.example": 0.9 });
  });
});

describe("readWindowLayout / writeWindowLayout", () => {
  // Each test opens the module-level handle on a fresh, migrated (v9) database
  // via loadStore(), so the helpers act on the same handle production uses.
  beforeEach(() => {
    loadStore();
  });

  test("a fresh database reads back the single layout", () => {
    expect(readWindowLayout()).toEqual({ mode: "single" });
  });

  test("round-trips a split layout (ratio preserved when in range)", () => {
    writeWindowLayout({
      mode: "split",
      left: "tL",
      right: "tR",
      ratio: 0.35,
      focused: "right",
    });
    expect(readWindowLayout()).toEqual({
      mode: "split",
      left: "tL",
      right: "tR",
      ratio: 0.35,
      focused: "right",
    });
  });

  test("clamps an out-of-range stored ratio on read", () => {
    writeWindowLayout({
      mode: "split",
      left: "tL",
      right: "tR",
      ratio: 0.35,
      focused: "left",
    });
    // Force an out-of-range ratio via a separate connection; readWindowLayout
    // returns it clamped to the [0.2, 0.8] band.
    const raw = new Database(join(tempDir, "zeo.db"));
    raw.prepare("UPDATE meta SET layoutRatio=? WHERE id=0").run(0.05);
    raw.close();
    expect(readWindowLayout()).toEqual({
      mode: "split",
      left: "tL",
      right: "tR",
      ratio: 0.2,
      focused: "left",
    });
  });

  test("writing single after a split reads back single", () => {
    writeWindowLayout({
      mode: "split",
      left: "tL",
      right: "tR",
      ratio: 0.5,
      focused: "left",
    });
    writeWindowLayout({ mode: "single" });
    expect(readWindowLayout()).toEqual({ mode: "single" });
  });

  test("a stored split with a NULL pane tab id reads back single", () => {
    writeWindowLayout({
      mode: "split",
      left: "tL",
      right: "tR",
      ratio: 0.5,
      focused: "left",
    });
    // A split row whose right pane id was cleared (as a legacy/hand-modified row
    // could carry) reads back as single rather than a broken split.
    const raw = new Database(join(tempDir, "zeo.db"));
    raw.prepare("UPDATE meta SET layoutRightTabId=NULL WHERE id=0").run();
    raw.close();
    expect(readWindowLayout()).toEqual({ mode: "single" });
  });

  test("a stored split with a NULL left pane tab id reads back single", () => {
    writeWindowLayout({
      mode: "split",
      left: "tL",
      right: "tR",
      ratio: 0.5,
      focused: "left",
    });
    // Symmetric to the right-pane case: clearing the LEFT pane id also reads
    // back as single, exercising that pane of the both-ids-present guard.
    const raw = new Database(join(tempDir, "zeo.db"));
    raw.prepare("UPDATE meta SET layoutLeftTabId=NULL WHERE id=0").run();
    raw.close();
    expect(readWindowLayout()).toEqual({ mode: "single" });
  });
});

describe("readWindowState / writeWindowState", () => {
  /** Hand-builds a valid current (v12) database at the loadStore path and opens
   *  the module-level handle the accessors use. The fresh window_state table has
   *  no row, so readWindowState reads null until writeWindowState saves one. */
  function seedAndLoad(): void {
    const path = join(tempDir, "zeo.db");
    const seed = new Database(path);
    seed.exec(V12_DDL);
    seed.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled) VALUES (0, 12, 'space-x', 1)",
    ).run();
    seedRows(seed, "space-x");
    seed.close();
    loadStore();
  }

  test("reads null when no window_state row has been saved", () => {
    seedAndLoad();
    expect(readWindowState()).toBeNull();
  });

  test("round-trips a full window state (numbers and boolean)", () => {
    seedAndLoad();
    const state: WindowState = {
      x: 100,
      y: 80,
      width: 900,
      height: 700,
      maximized: false,
    };
    writeWindowState(state);
    expect(readWindowState()).toEqual(state);
  });

  test("round-trips null x/y and maximized true", () => {
    seedAndLoad();
    const state: WindowState = {
      x: null,
      y: null,
      width: 1024,
      height: 768,
      maximized: true,
    };
    writeWindowState(state);
    expect(readWindowState()).toEqual(state);
  });

  test("a second writeWindowState updates the single row (id=0), never adding a second", () => {
    seedAndLoad();
    writeWindowState({ x: 100, y: 80, width: 900, height: 700, maximized: false });
    writeWindowState({ x: 5, y: 6, width: 640, height: 400, maximized: true });
    expect(readWindowState()).toEqual({
      x: 5,
      y: 6,
      width: 640,
      height: 400,
      maximized: true,
    });
    // The upsert targets row 0, so exactly one row exists (no duplicate).
    const inspect = new Database(join(tempDir, "zeo.db"), { readonly: true });
    const count = inspect
      .prepare("SELECT COUNT(*) AS n FROM window_state")
      .get() as { n: number };
    expect(count.n).toBe(1);
    inspect.close();
  });
});

describe("readBlockingEnabled / writeBlockingEnabled", () => {
  test("writeBlockingEnabled(false) round-trips and leaves schemaVersion/activeSpaceId intact", () => {
    // Hand-build a valid current (v11) database at the path loadStore will open.
    const path = join(tempDir, "zeo.db");
    const seed = new Database(path);
    seed.exec(V12_DDL);
    seed.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled) VALUES (0, 12, 'space-x', 1)",
    ).run();
    seedRows(seed, "space-x");
    seed.close();

    // loadStore opens the module-level handle the accessors use.
    loadStore();
    expect(readBlockingEnabled()).toBe(true);

    writeBlockingEnabled(false);
    expect(readBlockingEnabled()).toBe(false);

    // A separate connection confirms the full-state columns were untouched.
    const inspect = new Database(path, { readonly: true });
    const meta = inspect
      .prepare("SELECT schemaVersion, activeSpaceId, enabled FROM meta WHERE id=0")
      .get() as { schemaVersion: number; activeSpaceId: string; enabled: number };
    expect(meta.schemaVersion).toBe(12);
    expect(meta.activeSpaceId).toBe("space-x");
    expect(meta.enabled).toBe(0);
    inspect.close();
  });
});

describe("readDefaultSessionMigratedAt / writeDefaultSessionMigratedAt", () => {
  /** Hand-builds a valid current (v12) database at the loadStore path (seeding the
   *  marker column to `migratedAt`) and opens the module handle the accessors use. */
  function seedAndLoad(migratedAt: number | null): void {
    const path = join(tempDir, "zeo.db");
    const seed = new Database(path);
    seed.exec(V12_DDL);
    seed
      .prepare(
        "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled,defaultSessionMigratedAt) VALUES (0, 12, 'space-x', 1, ?)",
      )
      .run(migratedAt);
    seedRows(seed, "space-x");
    seed.close();
    loadStore();
  }

  test("reads null when the marker is unset and round-trips a written timestamp", () => {
    seedAndLoad(null);
    expect(readDefaultSessionMigratedAt()).toBeNull();

    writeDefaultSessionMigratedAt(1_700_000_000_000);
    expect(readDefaultSessionMigratedAt()).toBe(1_700_000_000_000);
  });

  test("reads a pre-set marker value", () => {
    seedAndLoad(42);
    expect(readDefaultSessionMigratedAt()).toBe(42);
  });

  test("defaults to null when the meta row is absent", () => {
    seedAndLoad(7);
    const raw = new Database(join(tempDir, "zeo.db"));
    raw.prepare("DELETE FROM meta WHERE id=0").run();
    raw.close();
    expect(readDefaultSessionMigratedAt()).toBeNull();
  });

  test("writeDefaultSessionMigratedAt throws when there is no meta row to update", () => {
    seedAndLoad(7);
    const raw = new Database(join(tempDir, "zeo.db"));
    raw.prepare("DELETE FROM meta WHERE id=0").run();
    raw.close();
    expect(() => writeDefaultSessionMigratedAt(1)).toThrow(
      "writeDefaultSessionMigratedAt: no meta row (id=0) to update",
    );
  });
});

describe("readSearchEngine / writeSearchEngine", () => {
  /** Hand-builds a valid current (v9) database at the loadStore path, opens the
   *  module-level handle the accessors use, and returns the db file path. */
  function seedAndLoad(): string {
    const path = join(tempDir, "zeo.db");
    const seed = new Database(path);
    seed.exec(V9_DDL);
    seed.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled) VALUES (0, 9, 'space-x', 1)",
    ).run();
    seedRows(seed, "space-x");
    seed.close();
    loadStore();
    return path;
  }

  test("round-trips a catalog id and defaults to duckduckgo when unset", () => {
    seedAndLoad();
    // The freshly-added column defaults to duckduckgo.
    expect(readSearchEngine()).toBe("duckduckgo");

    writeSearchEngine("google");
    expect(readSearchEngine()).toBe("google");
  });

  test("falls back to duckduckgo for a non-catalog stored value", () => {
    const path = seedAndLoad();
    // Force a value outside the catalog via a separate connection.
    const raw = new Database(path);
    raw.prepare("UPDATE meta SET searchEngine=? WHERE id=0").run("not-an-engine");
    raw.close();
    expect(readSearchEngine()).toBe("duckduckgo");
  });

  test("falls back to duckduckgo when the stored value is NULL", () => {
    // A meta row whose searchEngine is genuinely NULL (a nullable column, as a
    // legacy/hand-modified row could carry); readSearchEngine must still default.
    const path = join(tempDir, "zeo.db");
    const seed = new Database(path);
    seed.exec(V4_DDL);
    seed.exec("ALTER TABLE meta ADD COLUMN searchEngine TEXT;");
    seed.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled,searchEngine) VALUES (0, 5, 'space-x', 1, NULL)",
    ).run();
    seedRows(seed, "space-x");
    seed.close();
    loadStore();
    expect(readSearchEngine()).toBe("duckduckgo");
  });

  test("falls back to duckduckgo when the meta row is absent", () => {
    const path = seedAndLoad();
    const raw = new Database(path);
    raw.prepare("DELETE FROM meta WHERE id=0").run();
    raw.close();
    expect(readSearchEngine()).toBe("duckduckgo");
  });

  test("writeSearchEngine throws (and changes nothing) when the meta row is absent", () => {
    const path = seedAndLoad();
    // Remove the id=0 row via a separate connection so the module handle's UPDATE
    // affects zero rows.
    const raw = new Database(path);
    raw.prepare("DELETE FROM meta WHERE id=0").run();
    raw.close();

    expect(() => writeSearchEngine("google")).toThrow();

    // No meta row was resurrected: the zero-row UPDATE persisted nothing.
    const inspect = new Database(path, { readonly: true });
    const count = inspect
      .prepare("SELECT COUNT(*) AS n FROM meta")
      .get() as { n: number };
    expect(count.n).toBe(0);
    inspect.close();
  });
});

describe("readQuickBrowseExternal / writeQuickBrowseExternal", () => {
  /** Hand-builds a valid current (v9) database at the loadStore path, opens the
   *  module-level handle the accessors use, and returns the db file path. */
  function seedAndLoad(): string {
    const path = join(tempDir, "zeo.db");
    const seed = new Database(path);
    seed.exec(V9_DDL);
    seed.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled) VALUES (0, 9, 'space-x', 1)",
    ).run();
    seedRows(seed, "space-x");
    seed.close();
    loadStore();
    return path;
  }

  test("round-trips the flag true → false → true", () => {
    seedAndLoad();
    // The freshly-added column defaults to 1 (ON), read as true.
    expect(readQuickBrowseExternal()).toBe(true);

    writeQuickBrowseExternal(false);
    expect(readQuickBrowseExternal()).toBe(false);

    writeQuickBrowseExternal(true);
    expect(readQuickBrowseExternal()).toBe(true);
  });

  test("defaults to true when the column value is the default", () => {
    seedAndLoad();
    // No write has occurred; the DEFAULT 1 column maps to true.
    expect(readQuickBrowseExternal()).toBe(true);
  });

  test("defaults to true when the stored value is NULL", () => {
    // A meta row whose quickBrowseExternal is genuinely NULL (a nullable column,
    // as a legacy/hand-modified row could carry); readQuickBrowseExternal must
    // still default to true. The migration column is NOT NULL, so build a fixture
    // whose column allows NULL and seed the row at the current version so migrate
    // is a no-op that leaves the NULL in place.
    const path = join(tempDir, "zeo.db");
    const seed = new Database(path);
    seed.exec(V7_DDL);
    seed.exec("ALTER TABLE meta ADD COLUMN quickBrowseExternal INTEGER;");
    seed.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled,quickBrowseExternal) VALUES (0, 9, 'space-x', 1, NULL)",
    ).run();
    seedRows(seed, "space-x");
    seed.close();
    loadStore();
    expect(readQuickBrowseExternal()).toBe(true);
  });

  test("defaults to true when the meta row is absent", () => {
    const path = seedAndLoad();
    const raw = new Database(path);
    raw.prepare("DELETE FROM meta WHERE id=0").run();
    raw.close();
    expect(readQuickBrowseExternal()).toBe(true);
  });

  test("writeQuickBrowseExternal throws (and changes nothing) when the meta row is absent", () => {
    const path = seedAndLoad();
    // Remove the id=0 row via a separate connection so the module handle's UPDATE
    // affects zero rows.
    const raw = new Database(path);
    raw.prepare("DELETE FROM meta WHERE id=0").run();
    raw.close();

    expect(() => writeQuickBrowseExternal(false)).toThrow();

    // No meta row was resurrected: the zero-row UPDATE persisted nothing.
    const inspect = new Database(path, { readonly: true });
    const count = inspect
      .prepare("SELECT COUNT(*) AS n FROM meta")
      .get() as { n: number };
    expect(count.n).toBe(0);
    inspect.close();
  });
});

describe("readUpdateSettings / writeUpdateCheckEnabled / writeUpdateDismissedVersion / writeUpdateLastCheckedAt", () => {
  /** Hand-builds a valid current (v12) database at the loadStore path, opens the
   *  module-level handle the accessors use, and returns the db file path. */
  function seedAndLoad(): string {
    const path = join(tempDir, "zeo.db");
    const seed = new Database(path);
    seed.exec(V12_DDL);
    seed.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled) VALUES (0, 12, 'space-x', 1)",
    ).run();
    seedRows(seed, "space-x");
    seed.close();
    loadStore();
    return path;
  }

  test("readUpdateSettings defaults to enabled=true, dismissedVersion=null, lastCheckedAt=null", () => {
    seedAndLoad();
    expect(readUpdateSettings()).toEqual({
      enabled: true,
      dismissedVersion: null,
      lastCheckedAt: null,
    });
  });

  test("readUpdateSettings defaults to true when the meta row is absent", () => {
    const path = seedAndLoad();
    const raw = new Database(path);
    raw.prepare("DELETE FROM meta WHERE id=0").run();
    raw.close();
    expect(readUpdateSettings()).toEqual({
      enabled: true,
      dismissedVersion: null,
      lastCheckedAt: null,
    });
  });

  test("writeUpdateCheckEnabled round-trips true -> false -> true", () => {
    seedAndLoad();
    expect(readUpdateSettings().enabled).toBe(true);

    writeUpdateCheckEnabled(false);
    expect(readUpdateSettings().enabled).toBe(false);

    writeUpdateCheckEnabled(true);
    expect(readUpdateSettings().enabled).toBe(true);
  });

  test("writeUpdateDismissedVersion round-trips a version and clears it back to null", () => {
    seedAndLoad();
    expect(readUpdateSettings().dismissedVersion).toBeNull();

    writeUpdateDismissedVersion("1.2.3");
    expect(readUpdateSettings().dismissedVersion).toBe("1.2.3");

    writeUpdateDismissedVersion(null);
    expect(readUpdateSettings().dismissedVersion).toBeNull();
  });

  test("writeUpdateLastCheckedAt round-trips a timestamp", () => {
    seedAndLoad();
    expect(readUpdateSettings().lastCheckedAt).toBeNull();

    writeUpdateLastCheckedAt(123456);
    expect(readUpdateSettings().lastCheckedAt).toBe(123456);
  });

  test("each write throws (and changes nothing) when the meta row is absent", () => {
    const path = seedAndLoad();
    const raw = new Database(path);
    raw.prepare("DELETE FROM meta WHERE id=0").run();
    raw.close();

    expect(() => writeUpdateCheckEnabled(false)).toThrow();
    expect(() => writeUpdateDismissedVersion("1.2.3")).toThrow();
    expect(() => writeUpdateLastCheckedAt(1)).toThrow();

    // No meta row was resurrected: the zero-row UPDATEs persisted nothing.
    const inspect = new Database(path, { readonly: true });
    const count = inspect
      .prepare("SELECT COUNT(*) AS n FROM meta")
      .get() as { n: number };
    expect(count.n).toBe(0);
    inspect.close();
  });
});

describe("history helpers", () => {
  // Each test opens the module-level handle on a fresh, migrated (v3) database
  // via loadStore(); openDb sets `foreign_keys=ON`, so cascade/FK behavior is
  // exercised the same way it is in production.
  beforeEach(() => {
    loadStore();
  });

  describe("recordVisit", () => {
    test("folds visits and honors the newest-visit rule", () => {
      const idA = recordVisit("https://x.com/", "Alpha", 1000);
      const idB = recordVisit("https://x.com/", "Beta", 2000);
      expect(idB).toBeGreaterThan(idA);

      let entry = searchHistory(["x.com"], 10)[0];
      expect(entry.visitCount).toBe(2);
      expect(entry.lastVisitedAt).toBe(2000);
      expect(entry.title).toBe("Beta");

      // An OLDER visit is still counted but must not move lastVisitedAt back nor
      // replace the entry title with its older title.
      recordVisit("https://x.com/", "Gamma", 500);
      entry = searchHistory(["x.com"], 10)[0];
      expect(entry.visitCount).toBe(3);
      expect(entry.lastVisitedAt).toBe(2000);
      expect(entry.title).toBe("Beta");
    });

    test("creates an entry with an empty title; a newer non-empty title replaces it", () => {
      recordVisit("https://y.com/", "", 1000);
      let entry = searchHistory(["y.com"], 10)[0];
      expect(entry).toBeDefined();
      expect(entry.title).toBe("");
      expect(entry.visitCount).toBe(1);

      recordVisit("https://y.com/", "Why", 2000);
      entry = searchHistory(["y.com"], 10)[0];
      expect(entry.title).toBe("Why");
      expect(entry.visitCount).toBe(2);
    });

    test("a newer visit with an empty title does not wipe an existing non-empty title", () => {
      recordVisit("https://e.com/", "RealTitle", 1000);
      // The title replacement is guarded on a non-empty new title, so this
      // newest-but-empty visit still counts and moves lastVisitedAt but must
      // keep the entry's existing non-empty title.
      recordVisit("https://e.com/", "", 2000);
      const entry = searchHistory(["e.com"], 10)[0];
      expect(entry.title).toBe("RealTitle");
      expect(entry.visitCount).toBe(2);
      expect(entry.lastVisitedAt).toBe(2000);
    });

    test("on equal visitedAt, the larger visit id wins the entry title/lastVisitedAt", () => {
      // Two visits with the SAME visitedAt: the tie is broken by the larger id
      // (the later-inserted visit), which owns the entry title.
      recordVisit("https://tie.com/", "First", 5000);
      recordVisit("https://tie.com/", "Second", 5000);
      const entry = searchHistory(["tie.com"], 10)[0];
      expect(entry.visitCount).toBe(2);
      expect(entry.lastVisitedAt).toBe(5000);
      expect(entry.title).toBe("Second");
    });
  });

  describe("updateVisitTitle", () => {
    test("updates the entry title only for the newest visit (last-write rule)", () => {
      const older = recordVisit("https://z.com/", "First", 1000);
      const newer = recordVisit("https://z.com/", "Second", 2000);

      // Updating the NEWER visit updates both its row and the shared entry.
      updateVisitTitle(newer, "Second-Updated");
      let entry = searchHistory(["z.com"], 10)[0];
      expect(entry.title).toBe("Second-Updated");

      // Updating the OLDER visit updates only its own row; the entry keeps the
      // newest visit's title.
      updateVisitTitle(older, "First-Updated");
      entry = searchHistory(["z.com"], 10)[0];
      expect(entry.title).toBe("Second-Updated");

      const olderRow = recentVisits(10).filter((v) => v.id === older)[0];
      expect(olderRow.title).toBe("First-Updated");
    });

    test("is a no-op when the visit id does not exist", () => {
      recordVisit("https://z.com/", "First", 1000);
      expect(() => updateVisitTitle(999999, "Nope")).not.toThrow();
      expect(searchHistory(["z.com"], 10)[0].title).toBe("First");
    });
  });

  describe("searchHistory", () => {
    test("matches url and title case-insensitively, ordered by visitCount then lastVisitedAt", () => {
      recordVisit("https://apple.com/", "Apple Store", 1000); // count 1
      recordVisit("https://banana.com/", "Banana", 2000);
      recordVisit("https://banana.com/", "Banana", 3000); // count 2, newest 3000
      recordVisit("https://cherry.com/", "Cherry", 4000); // count 1, newest 4000

      // Case-insensitive title match.
      expect(searchHistory(["APPLE"], 10).map((e) => e.url)).toEqual([
        "https://apple.com/",
      ]);
      // Url match.
      expect(searchHistory(["banana.com"], 10).map((e) => e.url)).toEqual([
        "https://banana.com/",
      ]);
      // Ordering: banana (count 2) first, then the count-1 rows by lastVisitedAt.
      expect(searchHistory(["com"], 10).map((e) => e.url)).toEqual([
        "https://banana.com/",
        "https://cherry.com/",
        "https://apple.com/",
      ]);
    });

    test("with empty terms returns entries by lastVisitedAt desc", () => {
      recordVisit("https://a.com/", "A", 1000);
      recordVisit("https://b.com/", "B", 3000);
      recordVisit("https://c.com/", "C", 2000);
      expect(searchHistory([], 10).map((e) => e.url)).toEqual([
        "https://b.com/",
        "https://c.com/",
        "https://a.com/",
      ]);
    });

    test("respects limit", () => {
      recordVisit("https://a.com/", "A", 1000);
      recordVisit("https://b.com/", "B", 3000);
      recordVisit("https://c.com/", "C", 2000);
      expect(searchHistory([], 2).map((e) => e.url)).toEqual([
        "https://b.com/",
        "https://c.com/",
      ]);
    });

    test("escapes LIKE metacharacters so `%` matches a literal percent", () => {
      recordVisit("https://plain.com/", "Plain title", 1000);
      recordVisit("https://pct.com/", "100% cotton", 2000);
      // `%` must match the literal-percent title only, not act as a wildcard.
      expect(searchHistory(["%"], 10).map((e) => e.url)).toEqual([
        "https://pct.com/",
      ]);
    });

    test("escapes LIKE `_` so it matches a literal underscore, not any single char", () => {
      recordVisit("https://snake.com/", "a_b snake", 1000);
      recordVisit("https://other.com/", "axb nomatch", 2000);
      // `a_b` must match only the literal-underscore title, not "axb".
      expect(searchHistory(["a_b"], 10).map((e) => e.url)).toEqual([
        "https://snake.com/",
      ]);
    });

    test("caps the number of matched terms so a huge query cannot explode the SQL", () => {
      recordVisit("https://example.com/", "Example", 1);
      // 16 matching terms fill the cap; the 17th term (absent from url/title) is
      // dropped by the slice, so the row still matches — and a pathological term
      // count does not throw at prepare time.
      const terms = [...Array<string>(16).fill("example"), "definitely-not-present"];
      expect(searchHistory(terms, 10).map((e) => e.url)).toEqual([
        "https://example.com/",
      ]);
    });
  });

  describe("recentVisits", () => {
    test("returns visits ordered by visitedAt desc and respects limit", () => {
      recordVisit("https://a.com/", "A", 1000);
      recordVisit("https://a.com/", "A", 3000);
      recordVisit("https://b.com/", "B", 2000);
      const recent = recentVisits(2);
      expect(recent.length).toBe(2);
      expect(recent.map((v) => v.visitedAt)).toEqual([3000, 2000]);
    });
  });

  describe("deleteHistoryUrl", () => {
    test("deletes the entry and cascades its visits", () => {
      recordVisit("https://a.com/", "A", 1000);
      recordVisit("https://a.com/", "A", 2000);
      recordVisit("https://b.com/", "B", 1500);

      deleteHistoryUrl("https://a.com/");

      expect(searchHistory([], 10).map((e) => e.url)).toEqual([
        "https://b.com/",
      ]);
      expect(recentVisits(10).every((v) => v.url !== "https://a.com/")).toBe(
        true,
      );
    });
  });

  describe("clearHistory", () => {
    test("empties both tables", () => {
      recordVisit("https://a.com/", "A", 1000);
      recordVisit("https://b.com/", "B", 2000);

      clearHistory();

      expect(searchHistory([], 10)).toEqual([]);
      expect(recentVisits(10)).toEqual([]);
    });
  });

  describe("pruneHistory", () => {
    test("removes stale visits and orphan entries but keeps lifetime visitCount", () => {
      const now = 1_000_000_000_000;
      const old = now - HISTORY_RETENTION_MS - 1000; // older than retention
      const recent = now - 1000; // within retention

      // A url with only old visits is removed entirely.
      recordVisit("https://old.com/", "Old", old);
      // A url with one old + one recent visit keeps its entry; the old visit is
      // deleted; its lifetime visitCount stays 2.
      recordVisit("https://mix.com/", "Mix", old);
      recordVisit("https://mix.com/", "Mix", recent);

      const removed = pruneHistory(now);
      // The old.com entry was orphaned by the visit deletion and returned;
      // mix.com kept a recent visit and is not returned.
      expect(removed).toEqual(["https://old.com/"]);

      const entries = searchHistory([], 10);
      expect(entries.map((e) => e.url)).toEqual(["https://mix.com/"]);
      expect(entries[0].visitCount).toBe(2);

      const mixVisits = recentVisits(10).filter(
        (v) => v.url === "https://mix.com/",
      );
      expect(mixVisits.length).toBe(1);
      expect(mixVisits[0].visitedAt).toBe(recent);
    });
  });

  describe("historyStats", () => {
    test("returns the current entry and visit counts, both zero after clearHistory", () => {
      recordVisit("https://a.com/", "A", 1000);
      recordVisit("https://a.com/", "A", 2000);
      recordVisit("https://b.com/", "B", 1500);
      // Two distinct urls → 2 aggregated entries; three recorded visits.
      expect(historyStats()).toEqual({ entries: 2, visits: 3 });

      clearHistory();
      expect(historyStats()).toEqual({ entries: 0, visits: 0 });
    });
  });
});

describe("downloads helpers", () => {
  /** Builds a {@link Download} with defaults, overridable per field. */
  function makeDownload(overrides: Partial<Download> = {}): Download {
    return {
      id: "d1",
      url: "https://example.com/file.bin",
      filename: "file.bin",
      path: "/downloads/file.bin",
      totalBytes: 1000,
      receivedBytes: 0,
      state: "progressing",
      startedAt: 1000,
      completedAt: null,
      spaceId: null,
      ...overrides,
    };
  }

  describe("insert / update / delete / list / prune / interrupted sweep", () => {
    // Each test opens the module-level handle on a fresh, migrated (v9) database
    // via loadStore(); the downloads table exists after the migration.
    beforeEach(() => {
      loadStore();
    });

    test("insert, update, and delete round-trip a download row", () => {
      const d = makeDownload({ id: "d1" });
      insertDownload(d);
      expect(listDownloads()).toEqual([d]);

      const updated: Download = {
        ...d,
        state: "completed",
        receivedBytes: 1000,
        completedAt: 5000,
      };
      updateDownload(updated);
      expect(listDownloads()).toEqual([updated]);

      // updateDownload on an absent id affects zero rows: a silent no-op.
      updateDownload(makeDownload({ id: "missing", state: "completed" }));
      expect(listDownloads()).toEqual([updated]);

      deleteDownload("d1");
      expect(listDownloads()).toEqual([]);
      // deleting an absent id is a no-op.
      expect(() => deleteDownload("missing")).not.toThrow();
    });

    test("list returns rows newest-first by startedAt DESC then id DESC", () => {
      insertDownload(makeDownload({ id: "a", startedAt: 1000 }));
      insertDownload(makeDownload({ id: "b", startedAt: 2000 }));
      // Equal startedAt as "b"; the higher id ("c") sorts first.
      insertDownload(makeDownload({ id: "c", startedAt: 2000 }));
      expect(listDownloads().map((d) => d.id)).toEqual(["c", "b", "a"]);
    });

    test("inserting a 101st row prunes the oldest so exactly 100 remain", () => {
      for (let i = 1; i <= 101; i++) {
        insertDownload(
          makeDownload({ id: `d${String(i).padStart(3, "0")}`, startedAt: i }),
        );
      }
      const rows = listDownloads();
      expect(rows.length).toBe(100);
      // The oldest (startedAt 1) was pruned; the smallest remaining startedAt is 2.
      expect(rows.some((d) => d.startedAt === 1)).toBe(false);
      expect(Math.min(...rows.map((d) => d.startedAt))).toBe(2);
    });

    test("clearFinishedDownloadRows deletes every finished row and keeps active ones", () => {
      insertDownload(makeDownload({ id: "prog", state: "progressing", startedAt: 5000 }));
      insertDownload(makeDownload({ id: "paused", state: "paused", startedAt: 4000 }));
      insertDownload(makeDownload({ id: "done", state: "completed", startedAt: 3000, completedAt: 3500 }));
      insertDownload(makeDownload({ id: "cancelled", state: "cancelled", startedAt: 2000, completedAt: 2500 }));
      insertDownload(makeDownload({ id: "interrupted", state: "interrupted", startedAt: 1000, completedAt: 1500 }));

      clearFinishedDownloadRows();

      // Only the two active rows survive, newest-first.
      expect(listDownloads().map((d) => d.id)).toEqual(["prog", "paused"]);
    });

    test("markInterruptedDownloadsOnLaunch rewrites progressing and paused rows to interrupted with completedAt, leaving finished rows untouched", () => {
      insertDownload(
        makeDownload({ id: "prog", state: "progressing", startedAt: 3000, receivedBytes: 50 }),
      );
      insertDownload(
        makeDownload({ id: "paused", state: "paused", startedAt: 2000, receivedBytes: 20 }),
      );
      insertDownload(
        makeDownload({ id: "done", state: "completed", startedAt: 1000, completedAt: 1500, receivedBytes: 1000 }),
      );

      markInterruptedDownloadsOnLaunch(9999);

      const byId = new Map(listDownloads().map((d) => [d.id, d]));
      expect(byId.get("prog")!.state).toBe("interrupted");
      expect(byId.get("prog")!.completedAt).toBe(9999);
      expect(byId.get("paused")!.state).toBe("interrupted");
      expect(byId.get("paused")!.completedAt).toBe(9999);
      // The already-finished row is untouched.
      expect(byId.get("done")!.state).toBe("completed");
      expect(byId.get("done")!.completedAt).toBe(1500);
    });
  });

  test("a full-state flush does not delete or alter download rows (writeState isolation)", () => {
    // Hand-build a seeded current (v9) database so loadStore returns a real store.
    const path = join(tempDir, "zeo.db");
    const seed = new Database(path);
    seed.exec(V9_DDL);
    seed.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled) VALUES (0, 9, 'space-x', 1)",
    ).run();
    seedRows(seed, "space-x");
    seed.close();

    const store = loadStore();
    expect(store).not.toBeNull();

    const d1 = makeDownload({
      id: "d1",
      state: "completed",
      startedAt: 2000,
      completedAt: 2500,
      receivedBytes: 1000,
    });
    const d2 = makeDownload({ id: "d2", state: "progressing", startedAt: 1000, receivedBytes: 10 });
    insertDownload(d1);
    insertDownload(d2);

    // Mutate the store (add a tab) and drive a full-state save + synchronous flush.
    store!.create({ url: "https://added.example", title: "Added" });
    scheduleSave(store!);
    flush(store!);

    // writeState covers profiles/spaces/tabs/meta only; download rows are intact
    // and unchanged (newest first by startedAt: d1 then d2).
    expect(listDownloads()).toEqual([d1, d2]);
  });
});
