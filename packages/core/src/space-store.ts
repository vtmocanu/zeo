import { TabStore } from "./tab-store.js";
import type { Tab } from "./tab.js";
import type { Space } from "./space.js";
import type { Profile } from "./profile.js";
import type { TabsState, SpacesState } from "./ipc.js";
import { SCHEMA_VERSION, UnsupportedSchemaVersionError } from "./persistence.js";
import type { PersistedState, TabRow } from "./persistence.js";

export interface SpaceStoreOptions {
  idFactory?: () => string;
  now?: () => number;
  /**
   * Whether the constructor seeds the default `"Personal"` space and
   * `"Default"` profile (the normal path). `false` builds an EMPTY store with no
   * active space — used only by {@link SpaceStore.fromPersisted}, which rebuilds
   * the spaces and sets a real active id before returning. Defaults to `true`.
   */
  seed?: boolean;
}

/**
 * Projects a persisted {@link TabRow} down to the public {@link Tab} shape,
 * dropping the row-only `spaceId`/`position` fields. Used when rebuilding a
 * space's tab set for {@link TabStore.hydrate}.
 */
function tabRowToTab(row: TabRow): Tab {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    faviconUrl: row.faviconUrl,
    createdAt: row.createdAt,
    pinned: row.pinned,
    lastActiveAt: row.lastActiveAt,
    archivedAt: row.archivedAt,
  };
}

/** The default profile every space references until PRD 3.2 adds real profiles. */
const DEFAULT_PROFILE_ID = "default";

/**
 * Internal per-space record: the public {@link Space} metadata plus the
 * {@link TabStore} that owns that space's tab set. The `TabStore` is never
 * exposed directly — {@link SpaceStore} delegates the active space's tab
 * operations through it.
 */
interface SpaceRecord {
  space: Space;
  tabs: TabStore;
}

/**
 * Owns the browser's spaces and their tab sets. A space is a named workspace
 * with its own {@link TabStore}, so every PRD-2.x tab behavior (create, close,
 * activate, pin, reorder, archive, restore, remove, idle sweep, MRU close) is
 * reused verbatim per space with no change to {@link TabStore}.
 *
 * There is ALWAYS at least one space: a fresh store seeds one named "Personal"
 * and makes it active. The tab-mutating methods on this class
 * (`create`/`close`/`activate`/… and the read accessors `list`/`archived`/
 * `activeTabId`/`activeTab`) all delegate to the ACTIVE space's `TabStore`, so
 * existing tab operations act on the active space and a command carrying a tab
 * id from another space simply hits an "unknown tab" throw in the active store.
 *
 * Time and id generation are injectable and SHARED across every space's
 * `TabStore` (one sequence), so space ids and tab ids stay globally unique and
 * the store is deterministic under test.
 */
export class SpaceStore {
  /** Space ids in creation order — the order `spaces()` reports. */
  private readonly order: string[] = [];
  private readonly spacesById = new Map<string, SpaceRecord>();
  /** Profile ids in creation order — the order `profiles()` reports. */
  private readonly profileOrder: string[] = [];
  private readonly profilesById = new Map<string, Profile>();
  private activeId: string;
  private readonly idFactory: () => string;
  private readonly now: () => number;

  constructor(options: SpaceStoreOptions = {}) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => Date.now());
    // A non-seeded store (seed: false) is produced ONLY by `fromPersisted`,
    // which overwrites `activeId` with a real space id before returning; the
    // placeholder keeps the field type-safe until then.
    this.activeId = "";
    if (options.seed !== false) {
      // Seed the default profile BEFORE the seed space so the space's
      // `profileId: "default"` resolves through the same validation
      // `createSpace` will apply.
      this.insertProfile(DEFAULT_PROFILE_ID, "Default");
      const seed = this.insertSpace("Personal", DEFAULT_PROFILE_ID);
      this.activeId = seed.id;
    }
  }

  /**
   * Creates a fresh {@link SpaceRecord} (a new `Space` plus its own `TabStore`
   * wired to the shared id/clock factories), registers it, and returns the
   * space. Does not change the active space.
   */
  private insertSpace(name: string, profileId: string): Space {
    const space: Space = {
      id: this.idFactory(),
      name,
      profileId,
      createdAt: this.now(),
    };
    this.spacesById.set(space.id, {
      space,
      tabs: new TabStore({ idFactory: this.idFactory, now: this.now }),
    });
    this.order.push(space.id);
    return { ...space };
  }

  /** Looks up a space record, throwing on an unknown id. */
  private require(id: string): SpaceRecord {
    const record = this.spacesById.get(id);
    if (record === undefined) {
      throw new Error(`Unknown space: ${id}`);
    }
    return record;
  }

  /**
   * Builds a {@link Profile} with the given id and name, registers it in the
   * profile map and order, and returns a defensive copy. Used both to seed the
   * `"default"` profile and to create fresh ones.
   */
  private insertProfile(id: string, name: string): Profile {
    const profile: Profile = { id, name, createdAt: this.now() };
    this.profilesById.set(id, profile);
    this.profileOrder.push(id);
    return { ...profile };
  }

  /** Looks up a profile, throwing on an unknown id. */
  private requireProfile(id: string): Profile {
    const profile = this.profilesById.get(id);
    if (profile === undefined) {
      throw new Error(`Unknown profile: ${id}`);
    }
    return profile;
  }

  /** The active space's tab store — the target of all delegated tab ops. */
  private active(): TabStore {
    // activeId always names a live record (constructor seeds it; delete
    // re-points it to a surviving space), so the lookup never fails.
    return this.spacesById.get(this.activeId)!.tabs;
  }

  // --- Profile lifecycle ---------------------------------------------------

  /**
   * Creates a new profile with the given name and returns it. The id is a fresh
   * value from the id factory — never reused, so orphaned session-partition data
   * from a deleted profile can never be reached by a later one. Throws on a blank
   * name.
   */
  createProfile(name: string): Profile {
    if (name.trim() === "") {
      throw new Error("Profile name must not be blank");
    }
    return this.insertProfile(this.idFactory(), name);
  }

  /** Renames a profile. Throws on a blank name or an unknown id. */
  renameProfile(id: string, name: string): void {
    if (name.trim() === "") {
      throw new Error("Profile name must not be blank");
    }
    const profile = this.requireProfile(id);
    this.profilesById.set(id, { ...profile, name });
  }

  /**
   * Deletes a profile. Throws when it is the `"default"` profile, when the id is
   * unknown, or when any space still references it (a space must always resolve
   * to a live profile).
   */
  deleteProfile(id: string): void {
    if (id === DEFAULT_PROFILE_ID) {
      throw new Error("Cannot delete the default profile");
    }
    this.requireProfile(id);
    if ([...this.spacesById.values()].some((r) => r.space.profileId === id)) {
      throw new Error(`Cannot delete a profile referenced by a space: ${id}`);
    }
    this.profilesById.delete(id);
    this.profileOrder.splice(this.profileOrder.indexOf(id), 1);
  }

  // --- Profile read access -------------------------------------------------

  /** The profiles in creation order, as defensive copies. */
  profiles(): Profile[] {
    return this.profileOrder.map((id) => ({ ...this.profilesById.get(id)! }));
  }

  // --- Space lifecycle -----------------------------------------------------

  /**
   * Creates a new space with the given name and returns it. The `profileId`
   * defaults to `"default"` and must resolve to an existing profile — an unknown
   * profile throws with no side effect. Does NOT switch the active space — the
   * caller activates it explicitly via {@link setActiveSpace}. The new space
   * starts with an empty tab set.
   */
  createSpace(name: string, profileId: string = DEFAULT_PROFILE_ID): Space {
    if (name.trim() === "") {
      throw new Error("Space name must not be blank");
    }
    this.requireProfile(profileId);
    return this.insertSpace(name, profileId);
  }

  /** Renames a space. Throws on an unknown id. */
  renameSpace(id: string, name: string): void {
    if (name.trim() === "") {
      throw new Error("Space name must not be blank");
    }
    const record = this.require(id);
    record.space = { ...record.space, name };
  }

  /**
   * Whether {@link deleteSpace} would succeed for `id`: it names a known space
   * AND is not the last remaining space. This is the single source of truth for
   * deletability — the desktop main queries it to decide whether to tear down a
   * space's views before calling {@link deleteSpace}, so the rule is never
   * duplicated across the process boundary.
   */
  canDeleteSpace(id: string): boolean {
    return this.spacesById.has(id) && this.order.length > 1;
  }

  /**
   * Deletes a space and drops its entire tab set. Throws on an unknown id, and
   * throws when it is the last remaining space (there is always at least one) —
   * exactly the two conditions {@link canDeleteSpace} rules out. When the deleted
   * space was active, the first remaining space (in creation order) becomes
   * active.
   */
  deleteSpace(id: string): void {
    this.require(id);
    if (this.order.length <= 1) {
      throw new Error(`Cannot delete the last remaining space: ${id}`);
    }
    const wasActive = this.activeId === id;
    this.spacesById.delete(id);
    this.order.splice(this.order.indexOf(id), 1);
    if (wasActive) {
      this.activeId = this.order[0];
    }
  }

  /** Makes `id` the active space. Throws on an unknown id. */
  setActiveSpace(id: string): void {
    this.require(id);
    this.activeId = id;
  }

  // --- Space read access ---------------------------------------------------

  /** The spaces in creation order, as defensive copies. */
  spaces(): Space[] {
    return this.order.map((id) => ({ ...this.spacesById.get(id)!.space }));
  }

  get activeSpaceId(): string {
    return this.activeId;
  }

  /** The active space, as a defensive copy. */
  get activeSpace(): Space {
    return { ...this.spacesById.get(this.activeId)!.space };
  }

  // --- Delegated tab operations (act on the ACTIVE space) ------------------

  create(input: { url: string; title?: string }): Tab {
    return this.active().create(input);
  }

  close(id: string): void {
    this.active().close(id);
  }

  activate(id: string): void {
    this.active().activate(id);
  }

  pin(id: string): void {
    this.active().pin(id);
  }

  unpin(id: string): void {
    this.active().unpin(id);
  }

  reorder(id: string, toIndex: number): void {
    this.active().reorder(id, toIndex);
  }

  archive(id: string): void {
    this.active().archive(id);
  }

  restore(id: string): void {
    this.active().restore(id);
  }

  remove(id: string): void {
    this.active().remove(id);
  }

  list(): Tab[] {
    return this.active().list();
  }

  archived(): Tab[] {
    return this.active().archived();
  }

  get activeTabId(): string | null {
    return this.active().activeTabId;
  }

  get activeTab(): Tab | null {
    return this.active().activeTab;
  }

  // --- Cross-space operations ----------------------------------------------

  /**
   * Re-points a space at a different profile. Throws on an unknown space id and
   * on a `profileId` that does not resolve to an existing profile; the desktop
   * main destroys and recreates the space's views on the new partition.
   */
  setSpaceProfile(id: string, profileId: string): void {
    const record = this.require(id);
    this.requireProfile(profileId);
    record.space = { ...record.space, profileId };
  }

  /** The profile id a space references. Throws on an unknown space id. */
  spaceProfileId(id: string): string {
    return this.require(id).space.profileId;
  }

  /**
   * Every tab of a space — open (non-archived) followed by archived. The desktop
   * main uses this to remap a space's views onto a new partition when its profile
   * changes. Throws on an unknown space id.
   */
  tabsOfSpace(id: string): Tab[] {
    const record = this.require(id);
    return [...record.tabs.list(), ...record.tabs.archived()];
  }

  /**
   * Applies a partial metadata sync to whichever space owns `id`. Metadata
   * events (`page-title-updated`/`page-favicon-updated`) fire for tab views in
   * INACTIVE spaces too (their views stay alive but hidden), so this cannot be
   * scoped to the active space. `TabStore.updateMeta` is a silent no-op on an
   * unknown id, so fanning the call to every space updates only the owner.
   */
  updateMeta(id: string, meta: { title?: string; faviconUrl?: string | null }): void {
    for (const spaceId of this.order) {
      this.spacesById.get(spaceId)!.tabs.updateMeta(id, meta);
    }
  }

  /**
   * Runs the idle auto-archive sweep across EVERY space's tab set and returns
   * the flattened list of archived tab ids. Each space's `TabStore` exempts its
   * own active tab, so a space keeps its active tab alive whether or not the
   * space is currently active.
   */
  archiveIdleAll(maxIdleMs: number): string[] {
    const archived: string[] = [];
    for (const spaceId of this.order) {
      archived.push(...this.spacesById.get(spaceId)!.tabs.archiveIdle(maxIdleMs));
    }
    return archived;
  }

  /**
   * Re-bases restored tab activity across EVERY space at launch: each space's
   * `TabStore.rebaseActivity(now)` shifts its open tabs so the most-recently
   * active one lands at `now`. This resets the idle clock to relaunch time so
   * restored non-active tabs are not archived merely because the app was closed.
   */
  rebaseActivity(now: number): void {
    for (const spaceId of this.order) {
      this.spacesById.get(spaceId)!.tabs.rebaseActivity(now);
    }
  }

  /**
   * Every open (non-archived) tab across all spaces, each tagged with its
   * owning space id. The desktop main uses this to rebuild every space's tab
   * views when a window is recreated (e.g. a macOS re-activate).
   */
  allOpenTabs(): { spaceId: string; tab: Tab }[] {
    const result: { spaceId: string; tab: Tab }[] = [];
    for (const spaceId of this.order) {
      for (const tab of this.spacesById.get(spaceId)!.tabs.list()) {
        result.push({ spaceId, tab });
      }
    }
    return result;
  }

  // --- Snapshots -----------------------------------------------------------

  /**
   * The full application state broadcast to renderers: the space list, the
   * active space id, and the active space's tab payload in the existing shape.
   */
  snapshot(): TabsState {
    return {
      ...this.spacesSnapshot(),
      ...this.active().snapshot(),
    };
  }

  /** The space-only slice (space list + active space id + profile list). */
  spacesSnapshot(): SpacesState {
    return {
      spaces: this.spaces(),
      activeSpaceId: this.activeId,
      profiles: this.profiles(),
    };
  }

  // --- Persistence codec ---------------------------------------------------

  /**
   * Serializes the whole store to a versioned {@link PersistedState} — a pure
   * read with no mutation. Profiles and spaces carry their creation-order index
   * as `position`; each space's tabs are emitted as `list()` (pinned-then-
   * unpinned) followed by `archived()` (most-recently-archived first), with a
   * per-space running `position` so read-back reproduces the order. The meta
   * row stamps {@link SCHEMA_VERSION} and the active space id.
   */
  toPersisted(): PersistedState {
    const profiles = this.profileOrder.map((id, position) => {
      const profile = this.profilesById.get(id)!;
      return {
        id: profile.id,
        name: profile.name,
        createdAt: profile.createdAt,
        position,
      };
    });

    const spaces = this.order.map((id, position) => {
      const record = this.spacesById.get(id)!;
      return {
        id: record.space.id,
        name: record.space.name,
        profileId: record.space.profileId,
        createdAt: record.space.createdAt,
        activeTabId: record.tabs.activeTabId,
        position,
      };
    });

    const tabs: TabRow[] = [];
    for (const spaceId of this.order) {
      const record = this.spacesById.get(spaceId)!;
      const ordered = [...record.tabs.list(), ...record.tabs.archived()];
      ordered.forEach((tab, position) => {
        tabs.push({
          id: tab.id,
          spaceId,
          url: tab.url,
          title: tab.title,
          faviconUrl: tab.faviconUrl,
          createdAt: tab.createdAt,
          pinned: tab.pinned,
          lastActiveAt: tab.lastActiveAt,
          archivedAt: tab.archivedAt,
          position,
        });
      });
    }

    return {
      meta: { schemaVersion: SCHEMA_VERSION, activeSpaceId: this.activeId },
      profiles,
      spaces,
      tabs,
    };
  }

  /**
   * Rebuilds a {@link SpaceStore} from a persisted state — a pure rows→store
   * construction. Throws {@link UnsupportedSchemaVersionError} when the state
   * was written by a newer build (`meta.schemaVersion > SCHEMA_VERSION`).
   *
   * Profiles and spaces are restored in `position` order, preserving every
   * stored id/name/createdAt (and each space's `profileId`). Each space's tabs
   * are gathered by `spaceId`, ordered by `position`, split into open
   * (`archivedAt === null`) and archived, and handed to {@link TabStore.hydrate}
   * as open-then-archived.
   *
   * Repair rules, applied BEFORE the active pointers are set:
   * - A space's `activeTabId` restores only when it names an OPEN tab in the
   *   SAME space; an archived tab, a missing id, or a tab owned by another space
   *   all restore to `null` (so an archived-only space restores with no active
   *   tab).
   * - `meta.activeSpaceId` restores to the first space (in `position` order)
   *   when it is `null` or names no rebuilt space.
   *
   * A state with zero spaces (only reachable from a hand-built
   * {@link PersistedState}; the desktop layer calls this only when there is
   * data) restores with an empty `""` active space id — no space is fabricated.
   */
  static fromPersisted(
    state: PersistedState,
    options: SpaceStoreOptions = {},
  ): SpaceStore {
    if (state.meta.schemaVersion > SCHEMA_VERSION) {
      throw new UnsupportedSchemaVersionError(state.meta.schemaVersion);
    }

    const store = new SpaceStore({ ...options, seed: false });

    const orderedProfiles = [...state.profiles].sort(
      (a, b) => a.position - b.position,
    );
    for (const row of orderedProfiles) {
      const profile: Profile = {
        id: row.id,
        name: row.name,
        createdAt: row.createdAt,
      };
      store.profilesById.set(profile.id, profile);
      store.profileOrder.push(profile.id);
    }

    const orderedSpaces = [...state.spaces].sort(
      (a, b) => a.position - b.position,
    );
    for (const row of orderedSpaces) {
      const space: Space = {
        id: row.id,
        name: row.name,
        profileId: row.profileId,
        createdAt: row.createdAt,
      };
      const spaceTabs = state.tabs
        .filter((tab) => tab.spaceId === row.id)
        .sort((a, b) => a.position - b.position);
      const open = spaceTabs
        .filter((tab) => tab.archivedAt === null)
        .map(tabRowToTab);
      const archived = spaceTabs
        .filter((tab) => tab.archivedAt !== null)
        .map(tabRowToTab);
      // Repair: an active tab is valid only when it is an OPEN tab in THIS
      // space; anything else (archived, missing, foreign) restores to null.
      const activeTabId = open.some((tab) => tab.id === row.activeTabId)
        ? row.activeTabId
        : null;
      const tabs = TabStore.hydrate(open.concat(archived), activeTabId, {
        idFactory: store.idFactory,
        now: store.now,
      });
      store.spacesById.set(space.id, { space, tabs });
      store.order.push(space.id);
    }

    // Repair: fall back to the first space when the persisted active space id is
    // null or names no rebuilt space.
    const activeSpaceId = state.meta.activeSpaceId;
    if (activeSpaceId !== null && store.spacesById.has(activeSpaceId)) {
      store.activeId = activeSpaceId;
    } else if (store.order.length > 0) {
      store.activeId = store.order[0];
    }

    return store;
  }
}

/**
 * Free-function alias for {@link SpaceStore.toPersisted} — serializes a store to
 * its versioned {@link PersistedState}.
 */
export const serializeStore = (store: SpaceStore): PersistedState =>
  store.toPersisted();

/**
 * Free-function alias for {@link SpaceStore.fromPersisted} — rebuilds a store
 * from a persisted state, throwing {@link UnsupportedSchemaVersionError} on a
 * newer schema version.
 */
export const deserializeStore = (
  state: PersistedState,
  options?: SpaceStoreOptions,
): SpaceStore => SpaceStore.fromPersisted(state, options);
