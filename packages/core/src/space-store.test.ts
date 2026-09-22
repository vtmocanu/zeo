import { describe, expect, test } from "vitest";
import { SpaceStore } from "./space-store.js";

/**
 * Builds a store with deterministic id and clock factories, SHARED across every
 * space's tab set: ids are `t1`, `t2`, ... (the seed space is `t1`) and the
 * clock starts at 1000 and increments by 1 on each read.
 */
function makeStore(): SpaceStore {
  let idCounter = 0;
  let clock = 1000;
  return new SpaceStore({
    idFactory: () => `t${++idCounter}`,
    now: () => clock++,
  });
}

/**
 * Builds a store whose clock is a single mutable value the test drives via
 * `setClock`, so a test can hold time still while creating tabs and then jump
 * the clock to a precise idle age — the control `archiveIdleAll` needs to
 * exercise the strict "older than" threshold.
 */
function makeClockStore(start = 1000): {
  store: SpaceStore;
  setClock: (value: number) => void;
} {
  let idCounter = 0;
  let clock = start;
  const store = new SpaceStore({
    idFactory: () => `t${++idCounter}`,
    now: () => clock,
  });
  return { store, setClock: (value: number) => (clock = value) };
}

describe("SpaceStore seeding", () => {
  test("a fresh store has exactly one active space named Personal", () => {
    const store = makeStore();
    const spaces = store.spaces();
    expect(spaces).toHaveLength(1);
    expect(spaces[0].name).toBe("Personal");
    expect(spaces[0].profileId).toBe("default");
    expect(store.activeSpaceId).toBe(spaces[0].id);
    expect(store.activeSpace.id).toBe(spaces[0].id);
  });

  test("the seeded space starts with an empty tab set", () => {
    const store = makeStore();
    expect(store.list()).toEqual([]);
    expect(store.archived()).toEqual([]);
    expect(store.activeTabId).toBeNull();
    expect(store.activeTab).toBeNull();
  });

  test("spaces() and activeSpace return copies, not internal references", () => {
    const store = makeStore();
    const spaces = store.spaces();
    spaces[0].name = "Mutated";
    expect(store.spaces()[0].name).toBe("Personal");

    const active = store.activeSpace;
    active.name = "AlsoMutated";
    expect(store.activeSpace.name).toBe("Personal");
  });
});

describe("SpaceStore.createSpace", () => {
  test("adds a space without switching the active space", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId;
    const work = store.createSpace("Work");

    expect(work.name).toBe("Work");
    expect(work.profileId).toBe("default");
    // Not activated by creation.
    expect(store.activeSpaceId).toBe(personalId);
    // Reported in creation order.
    expect(store.spaces().map((s) => s.name)).toEqual(["Personal", "Work"]);
    expect(store.spaces().map((s) => s.id)).toEqual([personalId, work.id]);
  });

  test("a new space starts with an empty tab set of its own", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // into Personal (active)
    const work = store.createSpace("Work");

    store.setActiveSpace(work.id);
    expect(store.list()).toEqual([]);
    expect(store.activeTabId).toBeNull();
  });

  test("space ids and tab ids share one unique sequence", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId; // t1
    const tab = store.create({ url: "https://a.test" }); // t2
    const work = store.createSpace("Work"); // t3
    expect(personalId).toBe("t1");
    expect(tab.id).toBe("t2");
    expect(work.id).toBe("t3");
  });

  test("throws on a blank name", () => {
    const store = makeStore();
    expect(() => store.createSpace("")).toThrow(/blank/);
    expect(() => store.createSpace("   ")).toThrow(/blank/);
    expect(store.spaces()).toHaveLength(1);
  });
});

describe("SpaceStore.renameSpace", () => {
  test("renames an existing space", () => {
    const store = makeStore();
    const id = store.activeSpaceId;
    store.renameSpace(id, "Home");
    expect(store.activeSpace.name).toBe("Home");
    expect(store.spaces()[0].name).toBe("Home");
  });

  test("renames the space addressed by id, not the active space", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId; // active
    const work = store.createSpace("Work"); // not active

    // Rename the NON-active space by id; the active space must be untouched.
    store.renameSpace(work.id, "Errands");
    expect(store.spaces().find((s) => s.id === work.id)?.name).toBe("Errands");
    expect(store.spaces().find((s) => s.id === personalId)?.name).toBe("Personal");
    expect(store.activeSpace.name).toBe("Personal");
  });

  test("throws on an unknown space id", () => {
    const store = makeStore();
    expect(() => store.renameSpace("nope", "X")).toThrow(/Unknown space/);
  });

  test("throws on a blank name and keeps the current name", () => {
    const store = makeStore();
    const id = store.activeSpaceId;
    expect(() => store.renameSpace(id, "")).toThrow(/blank/);
    expect(() => store.renameSpace(id, "  ")).toThrow(/blank/);
    expect(store.activeSpace.name).toBe("Personal");
  });
});

describe("SpaceStore.allOpenTabs", () => {
  test("returns every space's open tabs tagged with their owning space id", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId;
    const p1 = store.create({ url: "https://p1.test" });
    const p2 = store.create({ url: "https://p2.test" });

    const work = store.createSpace("Work");
    store.setActiveSpace(work.id);
    const w1 = store.create({ url: "https://w1.test" });

    const all = store.allOpenTabs();
    // Every open tab across both spaces, each tagged with its owner.
    expect(all.map(({ spaceId, tab }) => [spaceId, tab.id])).toEqual([
      [personalId, p1.id],
      [personalId, p2.id],
      [work.id, w1.id],
    ]);
  });

  test("excludes archived tabs", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId;
    const open = store.create({ url: "https://open.test" });
    const gone = store.create({ url: "https://gone.test" });
    store.archive(gone.id);

    expect(store.allOpenTabs()).toEqual([{ spaceId: personalId, tab: expect.objectContaining({ id: open.id }) }]);
  });
});

describe("SpaceStore.setActiveSpace", () => {
  test("switches the active space", () => {
    const store = makeStore();
    const work = store.createSpace("Work");
    store.setActiveSpace(work.id);
    expect(store.activeSpaceId).toBe(work.id);
    expect(store.activeSpace.name).toBe("Work");
  });

  test("throws on an unknown space id", () => {
    const store = makeStore();
    expect(() => store.setActiveSpace("nope")).toThrow(/Unknown space/);
  });
});

describe("SpaceStore.deleteSpace", () => {
  test("throws when deleting the last remaining space", () => {
    const store = makeStore();
    expect(() => store.deleteSpace(store.activeSpaceId)).toThrow(
      /last remaining space/,
    );
    expect(store.spaces()).toHaveLength(1);
  });

  test("throws on an unknown space id", () => {
    const store = makeStore();
    store.createSpace("Work");
    expect(() => store.deleteSpace("nope")).toThrow(/Unknown space/);
  });

  test("returns the removed tab ids open-then-archived", () => {
    const store = makeStore();
    const work = store.createSpace("Work");
    const open1 = store.createInSpace(work.id, { url: "https://o1.test" });
    const open2 = store.createInSpace(work.id, { url: "https://o2.test" });
    const arch = store.createInSpace(work.id, { url: "https://a.test" });
    // Archive the third tab within Work (routed archive acts on its owner).
    store.archive(arch.id);

    const removed = store.deleteSpace(work.id);
    // Open tabs (in list order) first, then archived.
    expect(removed).toEqual([open1.id, open2.id, arch.id]);
    // The removed ids no longer resolve to any space.
    expect(store.spaceOfTab(open1.id)).toBeNull();
    expect(store.spaceOfTab(arch.id)).toBeNull();
  });

  test("an unknown-id throw leaves the store unmutated", () => {
    const store = makeStore();
    store.createSpace("Work");
    const before = store.spaces().map((s) => s.id);
    expect(() => store.deleteSpace("nope")).toThrow(/Unknown space/);
    expect(store.spaces().map((s) => s.id)).toEqual(before);
  });

  test("a last-space throw leaves the store unmutated", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId;
    const a = store.create({ url: "https://a.test" });
    expect(() => store.deleteSpace(personalId)).toThrow(/last remaining space/);
    // Space, its tab, active pointer, and ownership index all intact.
    expect(store.spaces().map((s) => s.id)).toEqual([personalId]);
    expect(store.activeSpaceId).toBe(personalId);
    expect(store.list().map((t) => t.id)).toEqual([a.id]);
    expect(store.spaceOfTab(a.id)).toBe(personalId);
  });

  test("drops the deleted space and its tabs", () => {
    const store = makeStore();
    const work = store.createSpace("Work");
    store.setActiveSpace(work.id);
    store.create({ url: "https://work.test" });
    store.setActiveSpace(store.spaces()[0].id); // back to Personal

    store.deleteSpace(work.id);
    expect(store.spaces().map((s) => s.name)).toEqual(["Personal"]);
    expect(store.spaces().some((s) => s.id === work.id)).toBe(false);
  });

  test("deleting a non-active space leaves the active space unchanged", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId;
    const work = store.createSpace("Work");
    store.deleteSpace(work.id);
    expect(store.activeSpaceId).toBe(personalId);
  });

  test("deleting the active space activates the first remaining space", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId;
    const work = store.createSpace("Work");
    const play = store.createSpace("Play");

    store.setActiveSpace(play.id);
    store.deleteSpace(play.id);
    // First remaining in creation order is Personal.
    expect(store.activeSpaceId).toBe(personalId);

    store.setActiveSpace(work.id);
    store.deleteSpace(work.id);
    expect(store.activeSpaceId).toBe(personalId);
  });
});

describe("SpaceStore per-space tab isolation", () => {
  test("tabs created in one space never appear in another", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId;
    const a = store.create({ url: "https://a.test" });

    const work = store.createSpace("Work");
    store.setActiveSpace(work.id);
    const b = store.create({ url: "https://b.test" });

    // Active is Work: only b is visible.
    expect(store.list().map((t) => t.id)).toEqual([b.id]);
    expect(store.snapshot().tabs.map((t) => t.id)).toEqual([b.id]);

    // Switch back to Personal: only a is visible.
    store.setActiveSpace(personalId);
    expect(store.list().map((t) => t.id)).toEqual([a.id]);
    expect(store.snapshot().tabs.map((t) => t.id)).toEqual([a.id]);
  });

  test("pinning a tab in one space never touches another space's pin state", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId;
    const a = store.create({ url: "https://a.test" });

    const work = store.createSpace("Work");
    store.setActiveSpace(work.id);
    const b = store.create({ url: "https://b.test" });
    store.pin(b.id);

    // Pinning b (Work) must not touch a's pin state (Personal).
    store.setActiveSpace(personalId);
    expect(store.list().find((t) => t.id === a.id)?.pinned).toBe(false);
  });

  test("an unknown tab id is rejected by every routed op", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });

    expect(() => store.pin("nope")).toThrow(/Cannot pin unknown tab/);
    expect(() => store.unpin("nope")).toThrow(/Cannot unpin unknown tab/);
    expect(() => store.close("nope")).toThrow(/Cannot close unknown tab/);
    expect(() => store.archive("nope")).toThrow(/Cannot archive unknown tab/);
    expect(() => store.restore("nope")).toThrow(/Cannot restore unknown tab/);
    expect(() => store.remove("nope")).toThrow(/Cannot remove unknown tab/);
    expect(() => store.reorder("nope", 0)).toThrow(/Cannot reorder unknown tab/);
    expect(() => store.moveToTop("nope")).toThrow(/Cannot reorder unknown tab/);
    expect(() => store.moveToBottom("nope")).toThrow(/Cannot reorder unknown tab/);
    expect(() => store.activate("nope")).toThrow(/Cannot activate unknown tab/);
  });

  test("moveToTop/moveToBottom route to a tab's owning space", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId;
    const a = store.create({ url: "https://a.test" });
    const b = store.create({ url: "https://b.test" });
    const c = store.create({ url: "https://c.test" });

    store.moveToTop(c.id);
    expect(store.list().map((t) => t.id)).toEqual([c.id, a.id, b.id]);
    store.moveToBottom(c.id);
    expect(store.list().map((t) => t.id)).toEqual([a.id, b.id, c.id]);

    // A tab owned by another (now-inactive) space still routes to its owner
    // rather than throwing: Personal is [a, b, c] here, so moveToTop(a) is a
    // no-op and moveToBottom(a) yields [b, c, a] — and the active space (Work)
    // is never touched during the calls.
    const work = store.createSpace("Work");
    store.setActiveSpace(work.id);
    store.moveToTop(a.id);
    expect(store.activeSpaceId).toBe(work.id);
    store.moveToBottom(a.id);
    expect(store.activeSpaceId).toBe(work.id);

    // Switch back to Personal: the reorder landed on the owning space.
    store.setActiveSpace(personalId);
    expect(store.list().map((t) => t.id)).toEqual([b.id, c.id, a.id]);
  });
});

describe("SpaceStore routed tab ops target a tab's owning space", () => {
  /**
   * Builds a store with Personal active and a second space "Work" holding one
   * tab, created via `createInSpace` so the active space is never switched.
   */
  function withInactiveWorkTab(): {
    store: SpaceStore;
    personalId: string;
    workId: string;
    personalTabId: string;
    workTabId: string;
  } {
    const store = makeStore();
    const personalId = store.activeSpaceId;
    const personalTab = store.create({ url: "https://p.test" });
    const work = store.createSpace("Work");
    const workTab = store.createInSpace(work.id, { url: "https://w.test" });
    return {
      store,
      personalId,
      workId: work.id,
      personalTabId: personalTab.id,
      workTabId: workTab.id,
    };
  }

  test("close routes to the inactive owner and leaves the active space untouched", () => {
    const { store, personalId, workId, personalTabId, workTabId } =
      withInactiveWorkTab();

    store.close(workTabId);

    // Work's tab is gone; the ownership index forgot it.
    expect(store.spaceOfTab(workTabId)).toBeNull();
    expect(store.tabsOfSpace(workId).map((t) => t.id)).toEqual([]);
    // The active (Personal) space is untouched.
    expect(store.activeSpaceId).toBe(personalId);
    expect(store.list().map((t) => t.id)).toEqual([personalTabId]);
  });

  test("pin routes to the inactive owner", () => {
    const { store, personalId, workId, personalTabId, workTabId } =
      withInactiveWorkTab();

    store.pin(workTabId);

    expect(store.tabsOfSpace(workId).find((t) => t.id === workTabId)?.pinned).toBe(
      true,
    );
    // Personal's tab (still active) is unaffected.
    expect(store.list().find((t) => t.id === personalTabId)?.pinned).toBe(false);
    expect(store.activeSpaceId).toBe(personalId);
  });

  test("archive then restore route to the inactive owner and keep ownership", () => {
    const { store, workId, workTabId } = withInactiveWorkTab();

    store.archive(workTabId);
    // Archived tab keeps its owner.
    expect(store.spaceOfTab(workTabId)).toBe(workId);
    expect(store.tabsOfSpace(workId).map((t) => t.id)).toEqual([workTabId]);

    store.restore(workTabId);
    expect(store.spaceOfTab(workTabId)).toBe(workId);
  });

  test("remove routes to the inactive owner and forgets ownership", () => {
    const { store, workId, workTabId } = withInactiveWorkTab();

    store.archive(workTabId);
    store.remove(workTabId);

    expect(store.spaceOfTab(workTabId)).toBeNull();
    expect(store.tabsOfSpace(workId).map((t) => t.id)).toEqual([]);
  });

  test("close of a pinned inactive-space tab is a no-op and keeps ownership", () => {
    const { store, workId, workTabId } = withInactiveWorkTab();

    store.pin(workTabId);
    // close is a no-op on a pinned tab; the tab stays live so its ownership
    // entry must survive (a pinned tab must remain routable).
    store.close(workTabId);
    expect(store.spaceOfTab(workTabId)).toBe(workId);
    expect(store.tabsOfSpace(workId).map((t) => t.id)).toEqual([workTabId]);
  });

  test("activate of a foreign (inactive-space) tab throws and changes nothing", () => {
    const { store, personalId, personalTabId, workTabId } = withInactiveWorkTab();

    expect(() => store.activate(workTabId)).toThrow(
      `Cannot activate a tab outside the active space: ${workTabId}`,
    );
    // Still on Personal, its active tab unchanged.
    expect(store.activeSpaceId).toBe(personalId);
    expect(store.activeTabId).toBe(personalTabId);
  });

  test("a same-space activate still works", () => {
    const store = makeStore();
    const a = store.create({ url: "https://a.test" });
    const b = store.create({ url: "https://b.test" });
    expect(store.activeTabId).toBe(b.id);

    store.activate(a.id);
    expect(store.activeTabId).toBe(a.id);
  });

  test("moveToTop/moveToBottom route to the inactive owner (a context-menu action that outlives a space switch)", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId;
    store.create({ url: "https://p.test" }); // Personal stays active
    const work = store.createSpace("Work");
    // Two tabs in the inactive Work space so a reorder is visible.
    const w1 = store.createInSpace(work.id, { url: "https://w1.test" });
    const w2 = store.createInSpace(work.id, { url: "https://w2.test" });
    expect(store.tabsOfSpace(work.id).map((t) => t.id)).toEqual([w1.id, w2.id]);

    // A context-menu reorder on a Work tab fires while Personal is active; it
    // routes to Work's own store and never disturbs the active space.
    store.moveToTop(w2.id);
    expect(store.tabsOfSpace(work.id).map((t) => t.id)).toEqual([w2.id, w1.id]);
    expect(store.activeSpaceId).toBe(personalId);

    store.moveToBottom(w2.id);
    expect(store.tabsOfSpace(work.id).map((t) => t.id)).toEqual([w1.id, w2.id]);
    expect(store.activeSpaceId).toBe(personalId);
  });
});

describe("SpaceStore.spaceOfTab ownership tracking", () => {
  test("tracks create, createInSpace, close, remove, and deleteSpace", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId;
    const a = store.create({ url: "https://a.test" });
    expect(store.spaceOfTab(a.id)).toBe(personalId);

    const work = store.createSpace("Work");
    const w = store.createInSpace(work.id, { url: "https://w.test" });
    expect(store.spaceOfTab(w.id)).toBe(work.id);

    // close drops ownership of the active-space tab.
    store.close(a.id);
    expect(store.spaceOfTab(a.id)).toBeNull();

    // remove (via archive first) drops ownership of the inactive-space tab.
    store.archive(w.id);
    store.remove(w.id);
    expect(store.spaceOfTab(w.id)).toBeNull();

    // deleteSpace forgets the whole space's tabs.
    const play = store.createSpace("Play");
    const p = store.createInSpace(play.id, { url: "https://p.test" });
    expect(store.spaceOfTab(p.id)).toBe(play.id);
    store.deleteSpace(play.id);
    expect(store.spaceOfTab(p.id)).toBeNull();
  });

  test("ownership is unchanged across archive and restore", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId;
    const a = store.create({ url: "https://a.test" });

    store.archive(a.id);
    expect(store.spaceOfTab(a.id)).toBe(personalId);
    store.restore(a.id);
    expect(store.spaceOfTab(a.id)).toBe(personalId);
  });

  test("rebuilds ownership from a persisted state", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId;
    const a = store.create({ url: "https://a.test" });
    const work = store.createSpace("Work");
    const w = store.createInSpace(work.id, { url: "https://w.test" });
    store.archive(w.id);

    const restored = SpaceStore.fromPersisted(store.toPersisted());
    expect(restored.spaceOfTab(a.id)).toBe(personalId);
    // An archived tab keeps its owner across a round trip.
    expect(restored.spaceOfTab(w.id)).toBe(work.id);
    expect(restored.spaceOfTab("nope")).toBeNull();
  });
});

describe("SpaceStore active-tab preservation across switches", () => {
  test("each space restores its own active tab on switch-back", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId;
    const p1 = store.create({ url: "https://p1.test" });
    const p2 = store.create({ url: "https://p2.test" });
    store.activate(p1.id);
    expect(store.activeTabId).toBe(p1.id);

    const work = store.createSpace("Work");
    store.setActiveSpace(work.id);
    const w1 = store.create({ url: "https://w1.test" });
    const w2 = store.create({ url: "https://w2.test" });
    store.activate(w1.id);
    expect(store.activeTabId).toBe(w1.id);

    // Switch back to Personal: its own active tab (p1) is preserved.
    store.setActiveSpace(personalId);
    expect(store.activeTabId).toBe(p1.id);
    expect(store.snapshot().activeTabId).toBe(p1.id);

    // And back to Work: its active tab (w1) is preserved.
    store.setActiveSpace(work.id);
    expect(store.activeTabId).toBe(w1.id);

    // Sanity: p2/w2 exist but are not the active tabs.
    expect(p2.id).not.toBe(store.activeTabId);
    expect(w2.id).not.toBe(store.activeTabId);
  });
});

describe("SpaceStore.archiveIdleAll", () => {
  test("sweeps idle tabs in every space, exempting each space's active tab", () => {
    const { store, setClock } = makeClockStore(1000);
    const personalId = store.activeSpaceId;

    // Personal: two tabs; p2 is active (created last).
    const p1 = store.create({ url: "https://p1.test" });
    const p2 = store.create({ url: "https://p2.test" });

    const work = store.createSpace("Work");
    store.setActiveSpace(work.id);
    const w1 = store.create({ url: "https://w1.test" });
    const w2 = store.create({ url: "https://w2.test" });

    // Jump the clock far past the idle threshold for every tab.
    setClock(1000 + 10_000);
    const archived = store.archiveIdleAll(100);

    // Every non-active tab across BOTH spaces is archived; the active tab of
    // each space (p2 in Personal, w2 in Work) is exempt.
    expect(new Set(archived)).toEqual(new Set([p1.id, w1.id]));

    store.setActiveSpace(personalId);
    expect(store.archived().map((t) => t.id)).toEqual([p1.id]);
    expect(store.list().map((t) => t.id)).toEqual([p2.id]);

    store.setActiveSpace(work.id);
    expect(store.archived().map((t) => t.id)).toEqual([w1.id]);
    expect(store.list().map((t) => t.id)).toEqual([w2.id]);
  });

  test("returns an empty list when nothing is idle", () => {
    const { store, setClock } = makeClockStore(1000);
    store.create({ url: "https://a.test" });
    setClock(1050);
    expect(store.archiveIdleAll(100)).toEqual([]);
  });
});

describe("SpaceStore.rebaseActivity", () => {
  const IDLE_THRESHOLD = 100;
  const RELAUNCH_AT = 1000 + 10_000;

  /**
   * Builds a two-space store whose tabs were all last active at t=1000 (the
   * "persisted" state) and whose non-active tabs are p1 (Personal) and w1
   * (Work). Returns the store plus its setClock so a test can jump to relaunch.
   */
  function twoSpaceStore(): {
    store: SpaceStore;
    setClock: (value: number) => void;
    ids: { p1: string; p2: string; w1: string; w2: string };
  } {
    const { store, setClock } = makeClockStore(1000);
    const p1 = store.create({ url: "https://p1.test" });
    const p2 = store.create({ url: "https://p2.test" }); // active in Personal
    const work = store.createSpace("Work");
    store.setActiveSpace(work.id);
    const w1 = store.create({ url: "https://w1.test" });
    const w2 = store.create({ url: "https://w2.test" }); // active in Work
    return {
      store,
      setClock,
      ids: { p1: p1.id, p2: p2.id, w1: w1.id, w2: w2.id },
    };
  }

  test("re-basing at relaunch keeps restored non-active tabs from being archived", () => {
    // Control: WITHOUT a rebase, the closed-gap idle age archives every
    // non-active tab across both spaces.
    {
      const { store, setClock, ids } = twoSpaceStore();
      setClock(RELAUNCH_AT);
      expect(new Set(store.archiveIdleAll(IDLE_THRESHOLD))).toEqual(
        new Set([ids.p1, ids.w1]),
      );
    }

    // With a rebase to relaunch time, the same sweep archives nothing: the
    // restored open tabs read as freshly active.
    const { store, setClock, ids } = twoSpaceStore();
    setClock(RELAUNCH_AT);
    store.rebaseActivity(RELAUNCH_AT);
    expect(store.archiveIdleAll(IDLE_THRESHOLD)).toEqual([]);

    // Every tab is still open in its own space.
    const openIds = new Set<string>();
    for (const spaceId of store.spaces().map((s) => s.id)) {
      store.setActiveSpace(spaceId);
      for (const tab of store.list()) {
        openIds.add(tab.id);
      }
      expect(store.archived()).toEqual([]);
    }
    expect(openIds).toEqual(new Set([ids.p1, ids.p2, ids.w1, ids.w2]));
  });
});

describe("SpaceStore.updateMeta", () => {
  test("updates the owning space's tab regardless of which space is active", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId;
    const a = store.create({ url: "https://a.test", title: "A" });

    const work = store.createSpace("Work");
    store.setActiveSpace(work.id);
    const b = store.create({ url: "https://b.test", title: "B" });

    // While Work is active, a metadata event fires for a tab owned by Personal
    // (its view is alive but hidden). It must reach a, not b.
    store.updateMeta(a.id, { title: "A updated", faviconUrl: "https://a.test/f.png" });
    store.updateMeta(b.id, { title: "B updated" });

    store.setActiveSpace(personalId);
    const aTab = store.list().find((t) => t.id === a.id);
    expect(aTab?.title).toBe("A updated");
    expect(aTab?.faviconUrl).toBe("https://a.test/f.png");

    store.setActiveSpace(work.id);
    expect(store.list().find((t) => t.id === b.id)?.title).toBe("B updated");
  });

  test("reports changed + inActiveSpace for a real change on the active space", () => {
    const store = makeStore();
    const a = store.create({ url: "https://a.test", title: "A" });
    expect(store.updateMeta(a.id, { title: "A2" })).toEqual({
      changed: true,
      inActiveSpace: true,
    });
  });

  test("reports not-changed but inActiveSpace for a no-op on an active tab", () => {
    const store = makeStore();
    const a = store.create({ url: "https://a.test", title: "A" });
    expect(store.updateMeta(a.id, { title: "A" })).toEqual({
      changed: false,
      inActiveSpace: true,
    });
  });

  test("reports changed but not-inActiveSpace for a change on an inactive space", () => {
    const store = makeStore();
    const work = store.createSpace("Work");
    const w = store.createInSpace(work.id, { url: "https://w.test", title: "W" });
    // Personal stays active; w lives in the inactive Work space.
    expect(store.updateMeta(w.id, { title: "W2" })).toEqual({
      changed: true,
      inActiveSpace: false,
    });
  });

  test("reports neither for an id owned by no space, and never throws", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    let result: { changed: boolean; inActiveSpace: boolean } | undefined;
    expect(() => {
      result = store.updateMeta("ghost", { title: "X" });
    }).not.toThrow();
    expect(result).toEqual({ changed: false, inActiveSpace: false });
  });
});

describe("SpaceStore snapshots", () => {
  test("snapshot carries spaces, active space id, and the active tab payload", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId;
    const a = store.create({ url: "https://a.test" });

    const work = store.createSpace("Work");
    store.setActiveSpace(work.id);
    const b = store.create({ url: "https://b.test" });

    const snap = store.snapshot();
    expect(snap.spaces.map((s) => s.name)).toEqual(["Personal", "Work"]);
    expect(snap.activeSpaceId).toBe(work.id);
    // Active-space tab payload only.
    expect(snap.tabs.map((t) => t.id)).toEqual([b.id]);
    expect(snap.activeTabId).toBe(b.id);
    expect(snap.archived).toEqual([]);

    store.setActiveSpace(personalId);
    expect(store.snapshot().tabs.map((t) => t.id)).toEqual([a.id]);
    expect(store.snapshot().activeSpaceId).toBe(personalId);
  });

  test("spacesSnapshot carries only the space list and active space id", () => {
    const store = makeStore();
    const work = store.createSpace("Work");
    const snap = store.spacesSnapshot();
    expect(snap.spaces.map((s) => s.name)).toEqual(["Personal", "Work"]);
    expect(snap.activeSpaceId).toBe(store.activeSpaceId);
    // No tab dimension on the spaces-only slice.
    expect("tabs" in snap).toBe(false);
    expect(work.id).toBeDefined();
  });
});

describe("SpaceStore profile seeding", () => {
  test("a fresh store has exactly one profile named Default with id default", () => {
    const store = makeStore();
    const profiles = store.profiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe("default");
    expect(profiles[0].name).toBe("Default");
  });

  test("the seeded Personal space references the default profile", () => {
    const store = makeStore();
    expect(store.spaces()[0].profileId).toBe("default");
    expect(store.spaceProfileId(store.activeSpaceId)).toBe("default");
  });

  test("profiles() returns copies, not internal references", () => {
    const store = makeStore();
    const profiles = store.profiles();
    profiles[0].name = "Mutated";
    expect(store.profiles()[0].name).toBe("Default");
  });
});

describe("SpaceStore.defaultProfileId", () => {
  test("a fresh store resolves to the seeded default profile id", () => {
    const store = makeStore();
    expect(store.defaultProfileId).toBe("default");
    expect(store.defaultProfileId).toBe(store.profiles()[0].id);
  });

  test("stays the default even after other profiles are created", () => {
    const store = makeStore();
    store.createProfile("Work");
    store.createProfile("Personal 2");
    // Created profiles append after the default, so it remains first.
    expect(store.defaultProfileId).toBe("default");
  });

  test("survives a persistence round trip", () => {
    const store = makeStore();
    store.createProfile("Work");
    const restored = SpaceStore.fromPersisted(store.toPersisted());
    expect(restored.defaultProfileId).toBe("default");
  });
});

describe("SpaceStore.createProfile", () => {
  test("creates a profile with a fresh id from the id factory", () => {
    const store = makeStore();
    // The seed space consumed t1; the first created profile consumes t2.
    const profile = store.createProfile("Work");
    expect(profile.id).toBe("t2");
    expect(profile.id).not.toBe("default");
    expect(profile.name).toBe("Work");
    expect(store.profiles().some((p) => p.id === profile.id)).toBe(true);
  });

  test("appends the new profile after the default in order", () => {
    const store = makeStore();
    const work = store.createProfile("Work");
    expect(store.profiles().map((p) => p.id)).toEqual(["default", work.id]);
  });

  test("throws on a blank name", () => {
    const store = makeStore();
    expect(() => store.createProfile("")).toThrow(/blank/);
    expect(() => store.createProfile("   ")).toThrow(/blank/);
    expect(store.profiles()).toHaveLength(1);
  });

  test("stores the name trimmed", () => {
    const store = makeStore();
    const work = store.createProfile("  Work  ");
    expect(work.name).toBe("Work");
    expect(store.profiles().find((p) => p.id === work.id)?.name).toBe("Work");
  });

  test("rejects a duplicate name case-insensitively", () => {
    const store = makeStore();
    store.createProfile("Work");
    expect(() => store.createProfile("work")).toThrow(
      /Profile name already exists/,
    );
    // Duplicate against the trimmed form, too.
    expect(() => store.createProfile("  WORK  ")).toThrow(
      /Profile name already exists/,
    );
    // Nothing was added past the original two (default + Work).
    expect(store.profiles()).toHaveLength(2);
  });
});

describe("SpaceStore.renameProfile", () => {
  test("renames an existing profile", () => {
    const store = makeStore();
    const work = store.createProfile("Work");
    store.renameProfile(work.id, "Job");
    expect(store.profiles().find((p) => p.id === work.id)?.name).toBe("Job");
  });

  test("stores the new name trimmed", () => {
    const store = makeStore();
    const work = store.createProfile("Work");
    store.renameProfile(work.id, "  Job  ");
    expect(store.profiles().find((p) => p.id === work.id)?.name).toBe("Job");
  });

  test("throws on a blank name", () => {
    const store = makeStore();
    const work = store.createProfile("Work");
    expect(() => store.renameProfile(work.id, "")).toThrow(/blank/);
    expect(() => store.renameProfile(work.id, "   ")).toThrow(/blank/);
    expect(store.profiles().find((p) => p.id === work.id)?.name).toBe("Work");
  });

  test("throws on an unknown profile id", () => {
    const store = makeStore();
    expect(() => store.renameProfile("nope", "X")).toThrow(/Unknown profile/);
  });

  test("rejects renaming onto another profile's name case-insensitively", () => {
    const store = makeStore();
    const work = store.createProfile("Work");
    store.createProfile("Play");
    expect(() => store.renameProfile(work.id, "play")).toThrow(
      /Profile name already exists/,
    );
    // Also blocked against the seeded default profile.
    expect(() => store.renameProfile(work.id, "default")).toThrow(
      /Profile name already exists/,
    );
    expect(store.profiles().find((p) => p.id === work.id)?.name).toBe("Work");
  });

  test("accepts a self-rename to the profile's own name in any case", () => {
    const store = makeStore();
    const work = store.createProfile("Work");
    expect(() => store.renameProfile(work.id, "WORK")).not.toThrow();
    expect(store.profiles().find((p) => p.id === work.id)?.name).toBe("WORK");
  });
});

describe("SpaceStore.deleteProfile", () => {
  test("throws when deleting the default profile", () => {
    const store = makeStore();
    expect(() => store.deleteProfile("default")).toThrow(
      /Cannot delete the default profile/,
    );
    expect(store.profiles().some((p) => p.id === "default")).toBe(true);
  });

  test("throws on an unknown profile id", () => {
    const store = makeStore();
    expect(() => store.deleteProfile("nope")).toThrow(/Unknown profile/);
  });

  test("throws when a space references the profile", () => {
    const store = makeStore();
    const work = store.createProfile("Work");
    store.setSpaceProfile(store.activeSpaceId, work.id);
    expect(() => store.deleteProfile(work.id)).toThrow(/referenced by a space/);
    expect(store.profiles().some((p) => p.id === work.id)).toBe(true);
  });

  test("deletes an unreferenced profile and removes it from profiles()", () => {
    const store = makeStore();
    const work = store.createProfile("Work");
    store.deleteProfile(work.id);
    expect(store.profiles().some((p) => p.id === work.id)).toBe(false);
    expect(store.profiles().map((p) => p.id)).toEqual(["default"]);
  });
});

describe("SpaceStore.createSpace with a profile", () => {
  test("defaults the profile to default when omitted", () => {
    const store = makeStore();
    const work = store.createSpace("Work");
    expect(work.profileId).toBe("default");
  });

  test("uses an explicit valid profile id", () => {
    const store = makeStore();
    const profile = store.createProfile("Work");
    const space = store.createSpace("Work", profile.id);
    expect(space.profileId).toBe(profile.id);
    expect(store.spaceProfileId(space.id)).toBe(profile.id);
  });

  test("throws on an unknown profile and creates no space", () => {
    const store = makeStore();
    const before = store.spaces().length;
    expect(() => store.createSpace("Work", "nope")).toThrow(/Unknown profile/);
    expect(store.spaces()).toHaveLength(before);
  });
});

describe("SpaceStore.setSpaceProfile", () => {
  test("re-points a space at a valid profile", () => {
    const store = makeStore();
    const profile = store.createProfile("Work");
    store.setSpaceProfile(store.activeSpaceId, profile.id);
    expect(store.spaceProfileId(store.activeSpaceId)).toBe(profile.id);
  });

  test("throws on an unknown space id", () => {
    const store = makeStore();
    const profile = store.createProfile("Work");
    expect(() => store.setSpaceProfile("nope", profile.id)).toThrow(
      /Unknown space/,
    );
  });

  test("throws on an unknown profile id", () => {
    const store = makeStore();
    expect(() => store.setSpaceProfile(store.activeSpaceId, "nope")).toThrow(
      /Unknown profile/,
    );
    // The space keeps its original profile.
    expect(store.spaceProfileId(store.activeSpaceId)).toBe("default");
  });
});

describe("SpaceStore.tabsOfSpace", () => {
  test("returns a space's open then archived tabs", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId;
    const open = store.create({ url: "https://open.test" });
    const gone = store.create({ url: "https://gone.test" });
    store.archive(gone.id);

    expect(store.tabsOfSpace(personalId).map((t) => t.id)).toEqual([
      open.id,
      gone.id,
    ]);
  });

  test("throws on an unknown space id", () => {
    const store = makeStore();
    expect(() => store.tabsOfSpace("nope")).toThrow(/Unknown space/);
  });
});

describe("SpaceStore.createInSpace", () => {
  test("creates a tab in an INACTIVE space without disturbing the active space", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId;
    const a = store.create({ url: "https://a.test" }); // into Personal (active)

    const work = store.createSpace("Work"); // not active
    const w1 = store.createInSpace(work.id, { url: "https://w1.test" });

    // The new tab is THAT space's active tab.
    expect(store.activeTabIdOf(work.id)).toBe(w1.id);
    // The active space and its tab list are untouched.
    expect(store.activeSpaceId).toBe(personalId);
    expect(store.list().map((t) => t.id)).toEqual([a.id]);
  });

  test("throws on an unknown space id", () => {
    const store = makeStore();
    expect(() =>
      store.createInSpace("nope", { url: "https://x.test" }),
    ).toThrow(/Unknown space/);
  });
});

describe("SpaceStore.activeTabIdOf", () => {
  test("mirrors each space's own active-tab pointer", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId;
    const p1 = store.create({ url: "https://p1.test" });
    store.create({ url: "https://p2.test" });
    store.activate(p1.id);

    const work = store.createSpace("Work");
    const w1 = store.createInSpace(work.id, { url: "https://w1.test" });

    // Each space reports its own active tab, independent of the active space.
    expect(store.activeTabIdOf(personalId)).toBe(p1.id);
    expect(store.activeTabIdOf(work.id)).toBe(w1.id);
    expect(store.activeSpaceId).toBe(personalId);
  });

  test("returns null for a space with no tabs", () => {
    const store = makeStore();
    const work = store.createSpace("Work");
    expect(store.activeTabIdOf(work.id)).toBeNull();
  });

  test("throws on an unknown space id", () => {
    const store = makeStore();
    expect(() => store.activeTabIdOf("nope")).toThrow(/Unknown space/);
  });
});

describe("SpaceStore profile snapshots", () => {
  test("spacesSnapshot carries the profile list and each space's profileId", () => {
    const store = makeStore();
    const profile = store.createProfile("Work");
    const work = store.createSpace("Work", profile.id);

    const snap = store.spacesSnapshot();
    expect(snap.profiles.map((p) => p.id)).toEqual(["default", profile.id]);
    expect(snap.spaces.find((s) => s.id === work.id)?.profileId).toBe(
      profile.id,
    );
    expect(snap.spaces.find((s) => s.id === store.activeSpaceId)?.profileId).toBe(
      "default",
    );
  });

  test("snapshot carries the profile list and each space's profileId", () => {
    const store = makeStore();
    const snap = store.snapshot();
    expect(snap.profiles.map((p) => p.id)).toEqual(["default"]);
    expect(snap.spaces[0].profileId).toBe("default");
  });
});

describe("SpaceStore.spaceOfTab", () => {
  test("finds the owning space of an open tab", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId;
    const open = store.create({ url: "https://open.test" });

    const work = store.createSpace("Work");
    store.setActiveSpace(work.id);
    const workTab = store.create({ url: "https://work.test" });

    expect(store.spaceOfTab(open.id)).toBe(personalId);
    expect(store.spaceOfTab(workTab.id)).toBe(work.id);
  });

  test("finds the owning space of an archived tab", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId;
    const gone = store.create({ url: "https://gone.test" });
    store.archive(gone.id);

    expect(store.spaceOfTab(gone.id)).toBe(personalId);
  });

  test("returns null for an unknown tab id", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    expect(store.spaceOfTab("nope")).toBeNull();
  });
});

describe("SpaceStore.allArchivedTabs", () => {
  test("returns every space's archived tabs tagged with their owning space id", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId;
    const p1 = store.create({ url: "https://p1.test" });
    const p2 = store.create({ url: "https://p2.test" });
    store.archive(p1.id);

    const work = store.createSpace("Work");
    store.setActiveSpace(work.id);
    const w1 = store.create({ url: "https://w1.test" });
    const w2 = store.create({ url: "https://w2.test" });
    store.archive(w1.id);

    const all = store.allArchivedTabs();
    expect(all.map(({ spaceId, tab }) => [spaceId, tab.id])).toEqual([
      [personalId, p1.id],
      [work.id, w1.id],
    ]);
    // Open tabs are excluded.
    expect(all.some(({ tab }) => tab.id === p2.id || tab.id === w2.id)).toBe(false);
  });

  test("returns an empty list when no space has archived tabs", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    expect(store.allArchivedTabs()).toEqual([]);
  });
});
