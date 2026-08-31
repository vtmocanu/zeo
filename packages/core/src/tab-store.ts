import type { Tab } from "./tab.js";
import type { TabsState } from "./ipc.js";

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
    this.activeId = record.id;
    return this.toTab(record);
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
    record.lastActiveAt = this.now();
    record.activationSeq = ++this.seq;
    this.activeId = id;
  }

  /**
   * Applies a PARTIAL metadata sync to `id`, preserving any omitted field:
   * `title` and/or `faviconUrl` are updated only when present. A title-only
   * update leaves `faviconUrl` untouched and vice versa. Because `faviconUrl`
   * may legitimately be set to `null`, presence is tested with `!== undefined`
   * rather than a truthiness check.
   *
   * Unlike `close`/`activate`/`pin`, an UNKNOWN id is a silent no-op instead of
   * a throw. This method is driven by `webContents` `page-title-updated`/
   * `page-favicon-updated` events, which can fire AFTER a tab is closed or torn
   * down; throwing there would crash the main-process event listener, so a late
   * event on a gone tab must be ignored.
   */
  updateMeta(id: string, meta: { title?: string; faviconUrl?: string | null }): void {
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
   * Restores an archived tab: clears `archivedAt`, clears `pinned`, and moves
   * the record to the end of the array (= the end of the unpinned group).
   * Throws on an unknown id, or if the tab is not archived. When the active
   * pointer is currently null, the restored tab becomes active.
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

    if (this.activeId === null) {
      record.lastActiveAt = this.now();
      record.activationSeq = ++this.seq;
      this.activeId = record.id;
    }
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

  /** The full state shape broadcast to renderers. */
  snapshot(): TabsState {
    return {
      tabs: this.list(),
      activeTabId: this.activeId,
      archived: this.archived(),
    };
  }
}
