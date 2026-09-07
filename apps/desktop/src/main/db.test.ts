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
  readAllowlist,
  insertAllowlistHost,
  deleteAllowlistHost,
  closeDb,
  recordVisit,
  updateVisitTitle,
  searchHistory,
  recentVisits,
  deleteHistoryUrl,
  clearHistory,
  pruneHistory,
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

/** The current (schema v4) DDL: the v3 tables plus the two history tables. */
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
  test("upgrades a v1 database to the current version, adding enabled, the allowlist, and history and preserving rows", () => {
    const path = join(tempDir, "v1.db");
    const db = new Database(path);
    db.exec(V1_DDL);
    db.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId) VALUES (0, 1, ?)",
    ).run("space-1");
    seedRows(db, "space-1");

    expect(hasEnabledColumn(db)).toBe(false);
    expect(hasHistoryTable(db)).toBe(false);

    migrate(db);

    const meta = db
      .prepare("SELECT schemaVersion, activeSpaceId, enabled FROM meta WHERE id=0")
      .get() as { schemaVersion: number; activeSpaceId: string; enabled: number };
    expect(meta.schemaVersion).toBe(4);
    expect(hasEnabledColumn(db)).toBe(true);
    expect(hasAllowlistTable(db)).toBe(true);
    expect(meta.enabled).toBe(1);
    expect(hasHistoryTable(db)).toBe(true);
    // Pre-existing rows preserved.
    expect(meta.activeSpaceId).toBe("space-1");
    expect(db.prepare("SELECT id FROM profiles").get()).toEqual({ id: "p1" });
    expect(db.prepare("SELECT id FROM spaces").get()).toEqual({ id: "space-1" });
    expect(db.prepare("SELECT id FROM tabs").get()).toEqual({ id: "t1" });
    db.close();
  });

  test("upgrades a v2 database to the current version, adding the allowlist and history and preserving rows", () => {
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

    migrate(db);

    const meta = db
      .prepare("SELECT schemaVersion, activeSpaceId, enabled FROM meta WHERE id=0")
      .get() as { schemaVersion: number; activeSpaceId: string; enabled: number };
    expect(meta.schemaVersion).toBe(4);
    expect(hasAllowlistTable(db)).toBe(true);
    expect(hasHistoryTable(db)).toBe(true);
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

  test("upgrades a v3 database to v4, adding the history tables and preserving the allowlist and rows", () => {
    const path = join(tempDir, "v3-to-v4.db");
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

    migrate(db);

    const meta = db
      .prepare("SELECT schemaVersion, activeSpaceId, enabled FROM meta WHERE id=0")
      .get() as { schemaVersion: number; activeSpaceId: string; enabled: number };
    expect(meta.schemaVersion).toBe(4);
    expect(hasHistoryTable(db)).toBe(true);
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

  test("creates a fresh v4 schema with enabled=1, the allowlist, and history tables on an empty database", () => {
    const path = join(tempDir, "fresh.db");
    const db = new Database(path);

    migrate(db);

    const meta = db
      .prepare("SELECT schemaVersion, enabled FROM meta WHERE id=0")
      .get() as { schemaVersion: number; enabled: number };
    expect(meta.schemaVersion).toBe(4);
    expect(hasEnabledColumn(db)).toBe(true);
    expect(hasAllowlistTable(db)).toBe(true);
    expect(meta.enabled).toBe(1);
    expect(hasHistoryTable(db)).toBe(true);
    db.close();
  });

  test("is a no-op on a database already at v4", () => {
    const path = join(tempDir, "v4.db");
    const db = new Database(path);
    db.exec(V4_DDL);
    // Seed enabled=0 so a spurious re-create/migrate (which would reset to 1)
    // is detectable.
    db.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled) VALUES (0, 4, 'space-9', 0)",
    ).run();

    migrate(db);

    const meta = db
      .prepare("SELECT schemaVersion, activeSpaceId, enabled FROM meta WHERE id=0")
      .get() as { schemaVersion: number; activeSpaceId: string; enabled: number };
    expect(meta.schemaVersion).toBe(4);
    expect(meta.activeSpaceId).toBe("space-9");
    expect(meta.enabled).toBe(0);
    db.close();
  });
});

describe("readAllowlist / insertAllowlistHost / deleteAllowlistHost", () => {
  test("round-trip: insert (ordered), INSERT OR IGNORE on a dup is a no-op, delete removes one", () => {
    // Hand-build a valid current (v4) database at the path loadStore will open.
    const path = join(tempDir, "zeo.db");
    const seed = new Database(path);
    seed.exec(V4_DDL);
    seed.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled) VALUES (0, 4, 'space-x', 1)",
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

describe("readBlockingEnabled / writeBlockingEnabled", () => {
  test("writeBlockingEnabled(false) round-trips and leaves schemaVersion/activeSpaceId intact", () => {
    // Hand-build a valid current (v4) database at the path loadStore will open.
    const path = join(tempDir, "zeo.db");
    const seed = new Database(path);
    seed.exec(V4_DDL);
    seed.prepare(
      "INSERT INTO meta(id,schemaVersion,activeSpaceId,enabled) VALUES (0, 4, 'space-x', 1)",
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
    expect(meta.schemaVersion).toBe(4);
    expect(meta.activeSpaceId).toBe("space-x");
    expect(meta.enabled).toBe(0);
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
});
