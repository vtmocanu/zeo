/**
 * The `downloads` table row accessors: insert/update/delete/list plus the
 * launch-time interrupted-download sweep. Split out of `db.ts` to keep that
 * module under its `max-lines` ceiling; `db.ts` owns the DDL and migration for
 * this table (schema version 7), this module only moves rows in and out of it.
 */
import type { Database as DatabaseType } from "better-sqlite3";
import type { Download } from "@zeo/core";
import { requireDb } from "./db.js";

/**
 * The SQLite shape of a `downloads` row: `state` comes back as a plain string,
 * `completedAt`/`spaceId` as `number | null` / `string | null`. `db.ts`'s DDL is
 * the source of truth for these columns.
 */
interface DownloadRow {
  id: string;
  url: string;
  filename: string;
  path: string;
  totalBytes: number;
  receivedBytes: number;
  state: string;
  startedAt: number;
  completedAt: number | null;
  spaceId: string | null;
}

/** Maps a SQLite `downloads` row to a {@link Download}: the stored `state` string
 *  is narrowed to the union and the nullable columns stay `null`. */
function rowToDownload(row: DownloadRow): Download {
  return {
    id: row.id,
    url: row.url,
    filename: row.filename,
    path: row.path,
    totalBytes: row.totalBytes,
    receivedBytes: row.receivedBytes,
    state: row.state as Download["state"],
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? null,
    spaceId: row.spaceId ?? null,
  };
}

/**
 * Inserts one download row, then prunes the table to the newest 100 rows by
 * `startedAt DESC, id DESC`, both in one transaction. The prune keeps the on-disk
 * table bounded and matches the in-memory 100-cap so disk and memory drop the same
 * oldest entry. Throws when the database is not open.
 */
export function insertDownload(d: Download): void {
  const database: DatabaseType = requireDb();
  const insert = database.prepare(
    "INSERT INTO downloads(id,url,filename,path,totalBytes,receivedBytes,state,startedAt,completedAt,spaceId) " +
      "VALUES (@id,@url,@filename,@path,@totalBytes,@receivedBytes,@state,@startedAt,@completedAt,@spaceId)",
  );
  const prune = database.prepare(
    "DELETE FROM downloads WHERE id NOT IN (SELECT id FROM downloads ORDER BY startedAt DESC, id DESC LIMIT 100)",
  );
  const run = database.transaction((download: Download): void => {
    insert.run(download);
    prune.run();
  });
  run(d);
}

/**
 * Updates every mutable column of the download row with id `d.id`. An UPDATE that
 * matches no row (the id is absent — e.g. a throttled write for a record already
 * removed) affects zero rows and is a silent no-op. Throws when the database is
 * not open.
 */
export function updateDownload(d: Download): void {
  const database = requireDb();
  database
    .prepare(
      "UPDATE downloads SET url=@url, filename=@filename, path=@path, totalBytes=@totalBytes, " +
        "receivedBytes=@receivedBytes, state=@state, startedAt=@startedAt, completedAt=@completedAt, " +
        "spaceId=@spaceId WHERE id=@id",
    )
    .run(d);
}

/**
 * Deletes the download row with id `id`; a no-op when the id is absent.
 * Synchronous (better-sqlite3). Throws when the database is not open.
 */
export function deleteDownload(id: string): void {
  const database = requireDb();
  database.prepare("DELETE FROM downloads WHERE id = ?").run(id);
}

/**
 * Deletes every finished download row (`state` one of the three terminal states),
 * never touching an active (`progressing`/`paused`) row. Backs
 * `downloads.clearFinished`. Throws when the database is not open.
 */
export function clearFinishedDownloadRows(): void {
  const database = requireDb();
  database
    .prepare(
      "DELETE FROM downloads WHERE state IN ('completed','cancelled','interrupted')",
    )
    .run();
}

/**
 * Returns the newest 100 downloads ordered by `startedAt DESC, id DESC` (the same
 * total order the reducer and prune use), mapped back to {@link Download}s. Feeds
 * the in-memory `DownloadsState` at startup. Throws when the database is not open.
 */
export function listDownloads(): Download[] {
  const database = requireDb();
  // SQLite-row boundary: .all() is typed `unknown[]`; the columns are DownloadRow.
  const rows = database
    .prepare(
      "SELECT id,url,filename,path,totalBytes,receivedBytes,state,startedAt,completedAt,spaceId " +
        "FROM downloads ORDER BY startedAt DESC, id DESC LIMIT 100",
    )
    .all() as DownloadRow[];
  return rows.map(rowToDownload);
}

/**
 * Rewrites every active (`progressing`/`paused`) download row to `interrupted`
 * with its `completedAt` set to `launchTime`. Run once at startup BEFORE
 * {@link listDownloads} so a download interrupted by a crash or quit is never
 * shown as still running. Throws when the database is not open.
 */
export function markInterruptedDownloadsOnLaunch(launchTime: number): void {
  const database = requireDb();
  database
    .prepare(
      "UPDATE downloads SET state = 'interrupted', completedAt = @t WHERE state IN ('progressing','paused')",
    )
    .run({ t: launchTime });
}
