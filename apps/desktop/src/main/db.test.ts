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

import {
  migrate,
  loadStore,
  readBlockingEnabled,
  writeBlockingEnabled,
  closeDb,
} from "./db.js";

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

/** The current (schema v2) DDL, with `meta.enabled`. */
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
  test("upgrades a v1 database to v2, adding enabled=1 and preserving rows", () => {
    const path = join(tempDir, "v1.db");
    const db = new Database(path);
    db.exec(V1_DDL);
    db.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId) VALUES (0, 1, ?)",
    ).run("space-1");
    seedRows(db, "space-1");

    expect(hasEnabledColumn(db)).toBe(false);

    migrate(db);

    const meta = db
      .prepare("SELECT schemaVersion, activeSpaceId, enabled FROM meta WHERE id=0")
      .get() as { schemaVersion: number; activeSpaceId: string; enabled: number };
    expect(meta.schemaVersion).toBe(2);
    expect(hasEnabledColumn(db)).toBe(true);
    expect(meta.enabled).toBe(1);
    // Pre-existing rows preserved.
    expect(meta.activeSpaceId).toBe("space-1");
    expect(db.prepare("SELECT id FROM profiles").get()).toEqual({ id: "p1" });
    expect(db.prepare("SELECT id FROM spaces").get()).toEqual({ id: "space-1" });
    expect(db.prepare("SELECT id FROM tabs").get()).toEqual({ id: "t1" });
    db.close();
  });

  test("creates a fresh v2 schema with enabled=1 on an empty database", () => {
    const path = join(tempDir, "fresh.db");
    const db = new Database(path);

    migrate(db);

    const meta = db
      .prepare("SELECT schemaVersion, enabled FROM meta WHERE id=0")
      .get() as { schemaVersion: number; enabled: number };
    expect(meta.schemaVersion).toBe(2);
    expect(hasEnabledColumn(db)).toBe(true);
    expect(meta.enabled).toBe(1);
    db.close();
  });

  test("is a no-op on a database already at v2", () => {
    const path = join(tempDir, "v2.db");
    const db = new Database(path);
    db.exec(V2_DDL);
    // Seed enabled=0 so a spurious re-create/migrate (which would reset to 1)
    // is detectable.
    db.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled) VALUES (0, 2, 'space-9', 0)",
    ).run();

    migrate(db);

    const meta = db
      .prepare("SELECT schemaVersion, activeSpaceId, enabled FROM meta WHERE id=0")
      .get() as { schemaVersion: number; activeSpaceId: string; enabled: number };
    expect(meta.schemaVersion).toBe(2);
    expect(meta.activeSpaceId).toBe("space-9");
    expect(meta.enabled).toBe(0);
    db.close();
  });
});

describe("readBlockingEnabled / writeBlockingEnabled", () => {
  test("writeBlockingEnabled(false) round-trips and leaves schemaVersion/activeSpaceId intact", () => {
    // Hand-build a valid v2 database at the path loadStore will open.
    const path = join(tempDir, "zeo.db");
    const seed = new Database(path);
    seed.exec(V2_DDL);
    seed.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled) VALUES (0, 2, 'space-x', 1)",
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
    expect(meta.schemaVersion).toBe(2);
    expect(meta.activeSpaceId).toBe("space-x");
    expect(meta.enabled).toBe(0);
    inspect.close();
  });
});
