import { TabStore } from "./tab-store.js";
import type { Tab } from "./tab.js";
import type { Space } from "./space.js";
import type { TabsState, SpacesState } from "./ipc.js";

export interface SpaceStoreOptions {
  idFactory?: () => string;
  now?: () => number;
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
  private activeId: string;
  private readonly idFactory: () => string;
  private readonly now: () => number;

  constructor(options: SpaceStoreOptions = {}) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => Date.now());
    const seed = this.insertSpace("Personal", DEFAULT_PROFILE_ID);
    this.activeId = seed.id;
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

  /** The active space's tab store — the target of all delegated tab ops. */
  private active(): TabStore {
    // activeId always names a live record (constructor seeds it; delete
    // re-points it to a surviving space), so the lookup never fails.
    return this.spacesById.get(this.activeId)!.tabs;
  }

  // --- Space lifecycle -----------------------------------------------------

  /**
   * Creates a new space with the given name (referencing the `"default"`
   * profile) and returns it. Does NOT switch the active space — the caller
   * activates it explicitly via {@link setActiveSpace}. The new space starts
   * with an empty tab set.
   */
  createSpace(name: string): Space {
    return this.insertSpace(name, DEFAULT_PROFILE_ID);
  }

  /** Renames a space. Throws on an unknown id. */
  renameSpace(id: string, name: string): void {
    const record = this.require(id);
    record.space = { ...record.space, name };
  }

  /**
   * Deletes a space and drops its entire tab set. Throws on an unknown id, and
   * throws when it is the last remaining space (there is always at least one).
   * When the deleted space was active, the first remaining space (in creation
   * order) becomes active.
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
      spaces: this.spaces(),
      activeSpaceId: this.activeId,
      ...this.active().snapshot(),
    };
  }

  /** The space-only slice (space list + active space id). */
  spacesSnapshot(): SpacesState {
    return {
      spaces: this.spaces(),
      activeSpaceId: this.activeId,
    };
  }
}
