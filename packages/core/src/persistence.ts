/**
 * The persisted-state codec vocabulary shared by the pure core store and the
 * desktop SQLite layer: the on-disk ROW shapes, the current schema version, the
 * unsupported-version error, and the migration decision helper.
 *
 * This module is intentionally dependency-free — it imports neither
 * {@link SpaceStore} nor {@link TabStore} at runtime — so it can be pulled in by
 * both `space-store.ts` (which owns the serialize/deserialize logic) and the
 * desktop main WITHOUT creating an import cycle. Values are plain
 * `number`/`string`/`boolean`; mapping `boolean`/`null` to SQLite's `0`/`1`
 * representation is the desktop layer's job, not this module's.
 */

/**
 * The version stamped into every persisted state this build writes, and the
 * highest version it can read back. A stored version ABOVE this is from a newer
 * build and cannot be understood ({@link UnsupportedSchemaVersionError}).
 */
export const SCHEMA_VERSION = 2;

/**
 * The single meta row: the schema version the state was written with and the
 * id of the space that was active (or `null` when there is no active space).
 */
export interface MetaRow {
  schemaVersion: number;
  activeSpaceId: string | null;
}

/**
 * A persisted profile. `position` records the profile's index in creation
 * order so read-back can restore that order deterministically.
 */
export interface ProfileRow {
  id: string;
  name: string;
  createdAt: number;
  position: number;
}

/**
 * A persisted space. `activeTabId` is the space's own active tab (or `null`),
 * and `position` records the space's index in creation order.
 */
export interface SpaceRow {
  id: string;
  name: string;
  profileId: string;
  createdAt: number;
  activeTabId: string | null;
  position: number;
}

/**
 * A persisted tab. `spaceId` names its owning space and `position` records its
 * index within that space's ordered tab sequence (open tabs in `list()` order
 * followed by archived tabs in `archived()` order), so a read-back that orders
 * by `position` within a space reproduces the original sequence.
 */
export interface TabRow {
  id: string;
  spaceId: string;
  url: string;
  title: string;
  faviconUrl: string | null;
  createdAt: number;
  pinned: boolean;
  lastActiveAt: number;
  archivedAt: number | null;
  position: number;
}

/**
 * The complete persisted snapshot: one meta row plus the profile, space, and
 * tab rows. This is the value {@link serializeStore} produces and
 * {@link deserializeStore} consumes.
 */
export interface PersistedState {
  meta: MetaRow;
  profiles: ProfileRow[];
  spaces: SpaceRow[];
  tabs: TabRow[];
}

/**
 * Thrown when a persisted state carries a schema version this build cannot
 * read — i.e. a version strictly greater than {@link SCHEMA_VERSION}, written by
 * a newer build. The offending version is carried on {@link version} so the
 * caller can surface it.
 */
export class UnsupportedSchemaVersionError extends Error {
  /** The unreadable schema version found in the persisted state. */
  readonly version: number;

  constructor(version: number) {
    super(
      `Unsupported schema version: ${version} (this build supports up to ${SCHEMA_VERSION})`,
    );
    this.name = "UnsupportedSchemaVersionError";
    this.version = version;
  }
}

/**
 * Decides what the desktop layer should do with an on-disk state whose schema
 * version is `currentVersion`:
 *
 * - `> SCHEMA_VERSION` ⇒ `"abort"` — a newer build wrote it; refuse to touch it.
 * - `=== SCHEMA_VERSION` ⇒ `"noop"` — current; read it as-is.
 * - `> 0 && < SCHEMA_VERSION` ⇒ `"migrate"` — an existing older DB to upgrade
 *   in place.
 * - otherwise (`<= 0`) ⇒ `"create"` — there is nothing readable, so initialize
 *   a fresh schema. This branch also absorbs negative and any unexpected value
 *   so the helper stays total.
 */
export function migrationAction(
  currentVersion: number,
): "create" | "migrate" | "noop" | "abort" {
  if (currentVersion > SCHEMA_VERSION) {
    return "abort";
  }
  if (currentVersion === SCHEMA_VERSION) {
    return "noop";
  }
  if (currentVersion > 0) {
    return "migrate";
  }
  return "create";
}
