import type { Tab } from "./tab.js";
import type { TabsSlice } from "./ipc.js";

export interface TabStoreOptions {
  idFactory?: () => string;
  now?: () => number;
}

/**
 * Internal storage record: a public {@link Tab} plus two monotonic sequence
 * fields that are NEVER exposed to callers. They break ties when two ops share
 * one clock timestamp, keeping MRU selection and `archived()` ordering
 * deterministic under a fixed injected clock.
 *
 * - `activationSeq` — stamped on every activation (including `create`).
 * - `archivalSeq` — stamped on every archival.
 */
interface TabRecord extends Tab {
  activationSeq: number;
  archivalSeq: number;
}

/**
 * An ordered collection of {@link Tab}s with a single active-tab pointer,
 * pinning, in-group reordering, MRU close-activation, and archiving.
 *
 * A SINGLE internal array holds every tab — open and archived alike. `list()`
 * and `archived()` derive their views by filtering, so cross-group array
 * position is irrelevant; only the relative order WITHIN a group (pinned,
 * unpinned) matters. All accessors return defensive copies stripped of the
 * private sequence fields, so external callers can never mutate internal state
 * nor observe the internal bookkeeping. Time and id generation are injectable
 * to keep the store deterministic under test.
 */
export class TabStore {
  private readonly tabs: TabRecord[] = [];
  private activeId: string | null = null;
  private readonly idFactory: () => string;
  private readonly now: () => number;
  private seq = 0;

  constructor(options: TabStoreOptions = {}) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Rebuilds a {@link TabStore} from persisted tabs, laying the records into the
   * internal array in EXACTLY the given order and assigning the private sequence
   * fields so the store REPRODUCES the input under `list()`/`archived()`.
   *
   * The caller passes open tabs in `list()` order (pinned-then-unpinned)
   * followed by archived tabs in `archived()` order (most-recently-archived
   * first). Because `list()` filters by the `pinned` flag while preserving array
   * order, the open prefix reproduces exactly. For the archived suffix,
   * `archived()` sorts by `archivedAt` desc then `archivalSeq` desc, so an
   * EARLIER archived-array element is given a LARGER `archivalSeq`; that keeps
   * the caller's order when two archived tabs share an `archivedAt`.
   * `activationSeq` increases in array order, and the internal `seq` counter is
   * advanced past every value assigned so later operations stay monotonic.
   *
   * The active pointer is set to `activeTabId` verbatim (`null` allowed); the
   * caller is responsible for having repaired it to a valid OPEN tab id or
   * `null` beforehand — this method does not re-validate it.
   */
  static hydrate(
    orderedOpenThenArchived: Tab[],
    activeTabId: string | null,
    options: TabStoreOptions = {},
  ): TabStore {
    const store = new TabStore(options);
    let seq = 0;
    const records: TabRecord[] = orderedOpenThenArchived.map((tab) => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      faviconUrl: tab.faviconUrl,
      createdAt: tab.createdAt,
      pinned: tab.pinned,
      lastActiveAt: tab.lastActiveAt,
      archivedAt: tab.archivedAt,
      activationSeq: ++seq,
      archivalSeq: 0,
    }));
    // Assign `archivalSeq` so the FIRST archived-array element (which
    // `archived()` must return first) gets the LARGEST value: walk the archived
    // records in reverse, stamping increasing values.
    const archivedRecords = records.filter((record) => record.archivedAt !== null);
    for (let i = archivedRecords.length - 1; i >= 0; i--) {
      archivedRecords[i].archivalSeq = ++seq;
    }
    store.tabs.push(...records);
    store.seq = seq;
    store.activeId = activeTabId;
    return store;
  }

  /**
   * Projects an internal record down to the public {@link Tab} shape, dropping
   * the private `activationSeq`/`archivalSeq` fields. Every accessor returns
   * the result of this helper so the sequence bookkeeping never leaks.
   */
  private toTab(record: TabRecord): Tab {
    return {
      id: record.id,
      url: record.url,
      title: record.title,
      faviconUrl: record.faviconUrl,
      createdAt: record.createdAt,
      pinned: record.pinned,
      lastActiveAt: record.lastActiveAt,
      archivedAt: record.archivedAt,
    };
  }

  /**
   * Picks the most-recently-used record among `candidates`: greatest
   * `lastActiveAt`, tie-broken by greatest `activationSeq`. Returns `null` for
   * an empty list. Callers pass only OPEN (non-archived) records.
   */
  private mruAmong(candidates: TabRecord[]): TabRecord | null {
    let best: TabRecord | null = null;
    for (const candidate of candidates) {
      if (
        best === null ||
        candidate.lastActiveAt > best.lastActiveAt ||
        (candidate.lastActiveAt === best.lastActiveAt &&
          candidate.activationSeq > best.activationSeq)
      ) {
        best = candidate;
      }
    }
    return best;
  }

  /** Open (non-archived) records in their current array order. */
  private openTabs(): TabRecord[] {
    return this.tabs.filter((tab) => tab.archivedAt === null);
  }

  /**
   * Re-bases every OPEN (non-archived) tab's `lastActiveAt` by a single shared
   * delta so the most-recently-active open tab lands exactly at `now`, while the
   * relative MRU spacing among open tabs is preserved. Used at relaunch so idle
   * sweeps measure idleness from the restart, not across the closed gap.
   *
   * No-op when there are no open tabs or when the required delta is 0. Archived
   * tabs and the active pointer (`this.activeId`) are left untouched.
   */
  rebaseActivity(now: number): void {
    const open = this.openTabs();
    if (open.length === 0) {
      return;
    }
    let max = open[0].lastActiveAt;
    for (const record of open) {
      if (record.lastActiveAt > max) {
        max = record.lastActiveAt;
      }
    }
    const delta = now - max;
    if (delta === 0) {
      return;
    }
    for (const record of open) {
      record.lastActiveAt += delta;
    }
  }

  /**
   * Creates a new tab with a fresh id and `createdAt` from the injected clock,
   * appends it to the end of the order, and makes it the active tab. A create
   * counts as an activation, so it seeds `lastActiveAt` from the clock and
   * stamps a fresh `activationSeq`.
   *
   * `title` defaults to `input.url` when omitted. URL parsing (e.g. hostname
   * derivation) is intentionally NOT done here — that belongs to the desktop
   * main process.
   */
  create(input: { url: string; title?: string }): Tab {
    const createdAt = this.now();
    const record: TabRecord = {
      id: this.idFactory(),
      url: input.url,
      title: input.title ?? input.url,
      faviconUrl: null,
      createdAt,
      pinned: false,
      lastActiveAt: createdAt,
      archivedAt: null,
      activationSeq: ++this.seq,
      archivalSeq: 0,
    };
    this.tabs.push(record);
    this.stampOutgoing(record.id);
    this.activeId = record.id;
    return this.toTab(record);
  }

  private stampOutgoing(nextId: string): void {
    if (this.activeId === null || this.activeId === nextId) {
      return;
    }
    const previous = this.tabs.find((tab) => tab.id === this.activeId);
    if (previous !== undefined) {
      previous.lastActiveAt = this.now();
    }
  }

  /**
   * Removes the tab with the given id from the store entirely.
   *
   * Active-tab invariant: if the closed tab was active, the most-recently-used
   * remaining OPEN tab becomes active (greatest `lastActiveAt`, tie-broken by
   * `activationSeq`); if none remain, the active pointer becomes null. Closing
   * a non-active tab leaves the active pointer unchanged.
   */
  close(id: string): void {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) {
      throw new Error(`Cannot close unknown tab: ${id}`);
    }
    if (this.tabs[index].archivedAt !== null) {
      throw new Error(`Cannot close an archived tab: ${id}`);
    }

    const wasActive = this.activeId === id;
    this.tabs.splice(index, 1);

    if (!wasActive) {
      return;
    }

    this.activateMru();
  }

  /**
   * Removes the tab with the given id from the store entirely, whether it is
   * OPEN or ARCHIVED. Unlike `close`, which throws on an archived tab to keep it
   * restorable, `remove` drops the record outright — it is the hard-delete path
   * for evicting an archived tab from the archive.
   *
   * Active-tab invariant: if the removed tab was active, the most-recently-used
   * remaining OPEN tab becomes active (via `activateMru`); if none remain, the
   * active pointer becomes null. Removing a non-active tab leaves the active
   * pointer unchanged. Throws on an unknown id.
   */
  remove(id: string): void {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) {
      throw new Error(`Cannot remove unknown tab: ${id}`);
    }

    const wasActive = this.activeId === id;
    this.tabs.splice(index, 1);

    if (!wasActive) {
      return;
    }

    this.activateMru();
  }

  private activateMru(): void {
    const next = this.mruAmong(this.openTabs());
    if (next === null) {
      this.activeId = null;
      return;
    }
    next.lastActiveAt = this.now();
    next.activationSeq = ++this.seq;
    this.activeId = next.id;
  }

  /**
   * Makes `id` the active tab and stamps its `lastActiveAt`/`activationSeq`.
   * Throws if there is no OPEN tab with that id — an unknown id AND an archived
   * id both throw, enforcing that archived tabs never become active.
   */
  activate(id: string): void {
    const record = this.tabs.find((tab) => tab.id === id);
    if (!record) {
      throw new Error(`Cannot activate unknown tab: ${id}`);
    }
    if (record.archivedAt !== null) {
      throw new Error(`Cannot activate an archived tab: ${id}`);
    }
    this.stampOutgoing(id);
    record.lastActiveAt = this.now();
    record.activationSeq = ++this.seq;
    this.activeId = id;
  }

  /**
   * Applies a PARTIAL metadata sync to `id`, preserving any omitted field:
   * `title`, `faviconUrl`, and/or `url` are updated only when present. A
   * title-only update leaves `faviconUrl` and `url` untouched, and so on.
   * Because `faviconUrl` may legitimately be set to `null`, presence is tested
   * with `!== undefined` rather than a truthiness check.
   *
   * Unlike `close`/`activate`/`pin`, an UNKNOWN id is a silent no-op instead of
   * a throw. This method is driven by `webContents` `page-title-updated`/
   * `page-favicon-updated` events, which can fire AFTER a tab is closed or torn
   * down; throwing there would crash the main-process event listener, so a late
   * event on a gone tab must be ignored.
   */
  updateMeta(
    id: string,
    meta: { title?: string; faviconUrl?: string | null; url?: string },
  ): void {
    const record = this.tabs.find((tab) => tab.id === id);
    if (!record) {
      return;
    }
    if (meta.title !== undefined) {
      record.title = meta.title;
    }
    if (meta.faviconUrl !== undefined) {
      record.faviconUrl = meta.faviconUrl;
    }
    if (meta.url !== undefined) {
      record.url = meta.url;
    }
  }

  /**
   * Pins `id`, appending it to the end of the pinned group. Throws on an
   * unknown id, or if the tab is archived. Already-pinned is a COMPLETE no-op:
   * the record is not moved, so an existing pinned order is preserved
   * (`pin(a); pin(b); pin(a)` keeps `[a, b]`, never `[b, a]`).
   */
  pin(id: string): void {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) {
      throw new Error(`Cannot pin unknown tab: ${id}`);
    }
    const record = this.tabs[index];
    if (record.archivedAt !== null) {
      throw new Error(`Cannot pin an archived tab: ${id}`);
    }
    if (record.pinned) {
      return;
    }
    record.pinned = true;
    // Move to the end of the array so it lands after all existing pinned tabs
    // (= the end of the pinned group).
    this.tabs.splice(index, 1);
    this.tabs.push(record);
  }

  /**
   * Unpins `id`, appending it to the end of the unpinned group. Throws on an
   * unknown id. Already-unpinned is a COMPLETE no-op (the record is not moved).
   */
  unpin(id: string): void {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) {
      throw new Error(`Cannot unpin unknown tab: ${id}`);
    }
    const record = this.tabs[index];
    if (record.archivedAt !== null) {
      throw new Error(`Cannot unpin an archived tab: ${id}`);
    }
    if (!record.pinned) {
      return;
    }
    record.pinned = false;
    // Move to the end of the array (= the end of the unpinned group).
    this.tabs.splice(index, 1);
    this.tabs.push(record);
  }

  /**
   * Moves an OPEN tab to `toIndex` WITHIN its own group (pinned or unpinned);
   * the index is interpreted within that group and clamped to its bounds.
   * Throws on an unknown or archived id. The other group and archived tabs keep
   * their positions.
   */
  reorder(id: string, toIndex: number): void {
    if (!Number.isInteger(toIndex)) {
      throw new Error(`Cannot reorder to a non-integer index: ${toIndex}`);
    }
    const target = this.tabs.find((tab) => tab.id === id);
    if (!target) {
      throw new Error(`Cannot reorder unknown tab: ${id}`);
    }
    if (target.archivedAt !== null) {
      throw new Error(`Cannot reorder an archived tab: ${id}`);
    }

    // The ordered group (among OPEN tabs) the target belongs to, and the array
    // indices those group members currently occupy.
    const positions: number[] = [];
    const group: TabRecord[] = [];
    this.tabs.forEach((tab, index) => {
      if (tab.archivedAt === null && tab.pinned === target.pinned) {
        positions.push(index);
        group.push(tab);
      }
    });

    // Clamp `toIndex` to [0, group.length - 1] where group.length counts the
    // target (the pre-removal group size), then splice-insert.
    const clamped = Math.max(0, Math.min(toIndex, group.length - 1));
    const from = group.indexOf(target);
    group.splice(from, 1);
    group.splice(clamped, 0, target);

    // Rebuild the array: map the group's former positions to the reordered
    // group, leaving every other slot untouched.
    positions.forEach((position, i) => {
      this.tabs[position] = group[i];
    });
  }

  /**
   * Archives `id`: flags it with `archivedAt` and an `archivalSeq` stamp so it
   * drops out of `list()` but STAYS in the internal array (recoverable via
   * `restore`). Throws on an unknown id, or if the tab is pinned. If the
   * archived tab was active, re-points active to the MRU remaining open tab
   * (null if none).
   */
  archive(id: string): void {
    const record = this.tabs.find((tab) => tab.id === id);
    if (!record) {
      throw new Error(`Cannot archive unknown tab: ${id}`);
    }
    if (record.pinned) {
      throw new Error(`Cannot archive a pinned tab: ${id}`);
    }
    if (record.archivedAt !== null) {
      throw new Error(`Cannot archive an archived tab: ${id}`);
    }

    record.archivedAt = this.now();
    record.archivalSeq = ++this.seq;

    if (this.activeId === id) {
      this.activateMru();
    }
  }

  /**
   * Auto-archives every OPEN tab that has gone idle: not pinned, not the active
   * tab, and whose age (`this.now() - lastActiveAt`) is STRICTLY GREATER THAN
   * `maxIdleMs`. A tab whose age exactly equals `maxIdleMs` is kept (the PRD
   * archives tabs "older than" the threshold, not at it). Each archived tab is
   * stamped exactly as `archive` stamps it: `archivedAt` from the clock plus a
   * fresh `archivalSeq`.
   *
   * Because the active tab is exempt, `this.activeId` never changes here, so no
   * MRU re-point is needed. Returns the ids of the tabs it archived (empty when
   * nothing qualifies).
   */
  archiveIdle(maxIdleMs: number): string[] {
    const now = this.now();
    const archivedIds: string[] = [];
    for (const record of this.tabs) {
      if (
        record.archivedAt !== null ||
        record.pinned ||
        record.id === this.activeId ||
        now - record.lastActiveAt <= maxIdleMs
      ) {
        continue;
      }
      record.archivedAt = now;
      record.archivalSeq = ++this.seq;
      archivedIds.push(record.id);
    }
    return archivedIds;
  }

  /**
   * Restores an archived tab: clears `archivedAt`, clears `pinned`, and moves
   * the record to the end of the array (= the end of the unpinned group).
   */
  restore(id: string): void {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) {
      throw new Error(`Cannot restore unknown tab: ${id}`);
    }
    const record = this.tabs[index];
    if (record.archivedAt === null) {
      throw new Error(`Cannot restore a tab that is not archived: ${id}`);
    }

    record.archivedAt = null;
    record.pinned = false;
    this.tabs.splice(index, 1);
    this.tabs.push(record);

    this.stampOutgoing(record.id);
    record.lastActiveAt = this.now();
    record.activationSeq = ++this.seq;
    this.activeId = record.id;
  }

  /**
   * Returns the OPEN (non-archived) tabs as new shallow copies: the pinned
   * group first, then the unpinned group, each STABLE in its internal order.
   */
  list(): Tab[] {
    const open = this.openTabs();
    const pinned = open.filter((tab) => tab.pinned);
    const unpinned = open.filter((tab) => !tab.pinned);
    return [...pinned, ...unpinned].map((tab) => this.toTab(tab));
  }

  /**
   * Returns the archived tabs as new shallow copies, MOST RECENTLY ARCHIVED
   * FIRST: sorted by `archivedAt` descending, tie-broken by `archivalSeq`
   * descending.
   */
  archived(): Tab[] {
    return this.tabs
      .filter((tab) => tab.archivedAt !== null)
      .sort((a, b) => {
        // Non-null asserted: filtered to archived records above.
        const byTime = (b.archivedAt as number) - (a.archivedAt as number);
        return byTime !== 0 ? byTime : b.archivalSeq - a.archivalSeq;
      })
      .map((tab) => this.toTab(tab));
  }

  get activeTabId(): string | null {
    return this.activeId;
  }

  get activeTab(): Tab | null {
    if (this.activeId === null) {
      return null;
    }
    const record = this.tabs.find((candidate) => candidate.id === this.activeId);
    return record ? this.toTab(record) : null;
  }

  /** This tab set's payload (tabs, active pointer, archived) for a snapshot. */
  snapshot(): TabsSlice {
    return {
      tabs: this.list(),
      activeTabId: this.activeId,
      archived: this.archived(),
    };
  }
}
