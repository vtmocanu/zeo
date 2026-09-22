import { session } from "electron";
import { cookieUrlFor } from "@zeo/core";
import { readDefaultSessionMigratedAt, writeDefaultSessionMigratedAt } from "./db.js";

/**
 * One-shot migration of the legacy default Electron session onto the
 * `persist:default` partition (PRD 9.4 §8). Early builds ran tabs on the implicit
 * default session; spaces now always run on an explicit profile partition, the
 * default profile being `persist:default`. This copies every cookie from the old
 * default session into that partition, then clears those cookies from the old session.
 *
 * The whole body is wrapped in a single try/catch so the function RESOLVES in
 * every case (it never rejects) — a migration failure must never block startup:
 *
 * - Idempotent: a non-null marker means it already ran, so it returns immediately
 *   without reading cookies or clearing anything.
 * - Best-effort per cookie: a cookie with no addressable url is skipped; a single
 *   `cookies.set` rejection is collected, and if ANY cookie failed the source
 *   session is left intact (nothing cleared, marker unwritten) so the next launch
 *   retries the whole copy.
 * - The marker is written ONLY after the clear succeeds, so a crash between copy
 *   and clear re-copies (cookie.set is an upsert) rather than losing data.
 */
export async function migrateDefaultSession(): Promise<void> {
  try {
    if (readDefaultSessionMigratedAt() !== null) {
      return;
    }
    const cookies = await session.defaultSession.cookies.get({});
    const target = session.fromPartition("persist:default");
    const rejections: unknown[] = [];
    for (const cookie of cookies) {
      const url = cookieUrlFor(cookie);
      if (url === null) {
        continue;
      }
      try {
        await target.cookies.set({
          url,
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          expirationDate: cookie.expirationDate,
          sameSite: cookie.sameSite,
        });
      } catch (err) {
        rejections.push(err);
      }
    }
    if (rejections.length > 0) {
      console.error(
        `[session-migration] ${rejections.length} cookie(s) failed to copy; source session left intact for retry`,
      );
      return;
    }
    // Clear only what the migration copied: cookies. The default session's other
    // stores (localstorage, indexdb, serviceworkers, cachestorage) are left in
    // place — the migration does not copy them, and once every view lives on a
    // profile partition no tab can reach the default session to read them, so
    // clearing them would only destroy data with no copy path (PRD 9.4 §7).
    await session.defaultSession.clearStorageData({ storages: ["cookies"] });
    writeDefaultSessionMigratedAt(Date.now());
  } catch (err) {
    console.error("[session-migration] default session migration failed:", err);
  }
}
