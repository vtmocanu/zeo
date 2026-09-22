import { session } from "electron";
import { cookieUrlFor } from "@zeo/core";
import {
  clearDefaultSessionMigratedAt,
  readDefaultSessionMigratedAt,
  writeDefaultSessionMigratedAt,
} from "./db.js";

/**
 * One-shot migration of the legacy default Electron session onto the default
 * profile's partition (PRD 9.4 §8). Early builds ran tabs on the implicit default
 * session; spaces now always run on an explicit profile partition. The target is
 * derived from the store's default profile (`persist:<defaultProfileId>`) rather
 * than a hard-coded literal, so a renamed or re-seeded default profile still
 * receives the cookies. This copies every cookie from the old default session into
 * that partition, then clears those cookies from the old session.
 *
 * The whole body is wrapped in a single try/catch so the function RESOLVES in
 * every case (it never rejects) — a migration failure must never block startup:
 *
 * - Idempotent: a non-null marker means it already ran, so it returns immediately
 *   without reading cookies or clearing anything.
 * - Best-effort per cookie: a cookie with no addressable url is skipped; a cookie
 *   whose `(name, domain, path)` identity already exists in the target partition
 *   is skipped so a retry never overwrites a value the user changed there since;
 *   a single `cookies.set` rejection is collected, and if ANY cookie failed the
 *   source session is left intact (nothing cleared, marker unwritten) so the next
 *   launch retries copying only the cookies still missing from the target.
 * - The marker is written ONLY after the clear succeeds, so a crash between copy
 *   and clear re-copies (skipping what the target already holds) rather than
 *   losing data.
 */
export async function migrateDefaultSession(defaultProfileId: string): Promise<void> {
  try {
    if (readDefaultSessionMigratedAt() !== null) {
      return;
    }
    const cookies = await session.defaultSession.cookies.get({});
    const target = session.fromPartition("persist:" + defaultProfileId);
    // Snapshot the target's existing cookies so the copy is non-destructive: a
    // cookie already present by (name, domain, path) is left as the target has it
    // (possibly newer than the stale default-session copy) instead of overwritten.
    const cookieKey = (c: { name: string; domain?: string; path?: string }): string =>
      `${c.name}\t${c.domain ?? ""}\t${c.path ?? "/"}`;
    const present = new Set((await target.cookies.get({})).map(cookieKey));
    const rejections: unknown[] = [];
    for (const cookie of cookies) {
      const url = cookieUrlFor(cookie);
      if (url === null) {
        continue;
      }
      if (present.has(cookieKey(cookie))) {
        continue;
      }
      try {
        const hostOnly = !(cookie.domain ?? "").startsWith(".");
        await target.cookies.set({
          url,
          name: cookie.name,
          value: cookie.value,
          // A host-only cookie must stay host-only: an explicit `domain` would
          // promote it to a subdomain-wide cookie.
          ...(hostOnly ? {} : { domain: cookie.domain }),
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

// e2e-only: reset the one-shot marker so the NEXT launch re-runs the migration,
// letting a test seed a cookie in the legacy default session and prove it is
// migrated onto the default profile. Gated strictly on ZEO_E2E === "1" (the
// established main-process test-hook pattern); a packaged build never defines it.
if (process.env.ZEO_E2E === "1") {
  (globalThis as Record<string, unknown>).__zeoResetDefaultSessionMigration = (): void =>
    clearDefaultSessionMigratedAt();
}
