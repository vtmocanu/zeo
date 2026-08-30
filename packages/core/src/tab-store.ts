import type { Tab } from "./tab.js";
import type { TabsState } from "./ipc.js";

export interface TabStoreOptions {
  idFactory?: () => string;
  now?: () => number;
}

/**
 * An ordered collection of {@link Tab}s with a single active-tab pointer.
 *
 * All accessors return defensive copies so external callers can never mutate
 * the store's internal state. Time and id generation are injectable to keep
 * the store deterministic under test.
 */
export class TabStore {
  private readonly tabs: Tab[] = [];
  private activeId: string | null = null;
  private readonly idFactory: () => string;
  private readonly now: () => number;

  constructor(options: TabStoreOptions = {}) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Creates a new tab with a fresh id and `createdAt` from the injected clock,
   * appends it to the end of the order, and makes it the active tab.
   *
   * `title` defaults to `input.url` when omitted. URL parsing (e.g. hostname
   * derivation) is intentionally NOT done here — that belongs to the desktop
   * main process.
   */
  create(input: { url: string; title?: string }): Tab {
    const tab: Tab = {
      id: this.idFactory(),
      url: input.url,
      title: input.title ?? input.url,
      createdAt: this.now(),
    };
    this.tabs.push(tab);
    this.activeId = tab.id;
    return { ...tab };
  }

  /**
   * Removes the tab with the given id.
   *
   * Active-tab invariant: if the closed tab was active, the tab that now
   * occupies the closed tab's former index becomes active; if the closed tab
   * was last in order, the new last tab becomes active; if no tabs remain,
   * the active pointer becomes null. Closing a non-active tab leaves the
   * active pointer unchanged.
   */
  close(id: string): void {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) {
      throw new Error(`Cannot close unknown tab: ${id}`);
    }

    const wasActive = this.activeId === id;
    this.tabs.splice(index, 1);

    if (!wasActive) {
      return;
    }

    if (this.tabs.length === 0) {
      this.activeId = null;
      return;
    }

    // The tab that shifted into `index` takes over; when the removed tab was
    // last, `index` is now out of range, so fall back to the new last tab.
    const nextIndex = index < this.tabs.length ? index : this.tabs.length - 1;
    this.activeId = this.tabs[nextIndex].id;
  }

  /** Makes `id` the active tab. Throws if `id` is unknown. */
  activate(id: string): void {
    if (!this.tabs.some((tab) => tab.id === id)) {
      throw new Error(`Cannot activate unknown tab: ${id}`);
    }
    this.activeId = id;
  }

  /**
   * Returns the tabs in insertion order as a new array of shallow copies, so
   * neither the array nor the tab objects can be used to mutate the store.
   */
  list(): Tab[] {
    return this.tabs.map((tab) => ({ ...tab }));
  }

  get activeTabId(): string | null {
    return this.activeId;
  }

  get activeTab(): Tab | null {
    if (this.activeId === null) {
      return null;
    }
    const tab = this.tabs.find((candidate) => candidate.id === this.activeId);
    return tab ? { ...tab } : null;
  }

  /** The full state shape broadcast to renderers. */
  snapshot(): TabsState {
    return { tabs: this.list(), activeTabId: this.activeId };
  }
}
