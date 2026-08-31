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

  test("canDeleteSpace mirrors the deleteSpace throw conditions", () => {
    const store = makeStore();
    const personalId = store.activeSpaceId;
    // Last remaining space: not deletable.
    expect(store.canDeleteSpace(personalId)).toBe(false);
    // Unknown id: not deletable.
    expect(store.canDeleteSpace("nope")).toBe(false);

    const work = store.createSpace("Work");
    // With two spaces, both known ids are deletable; an unknown id still is not.
    expect(store.canDeleteSpace(personalId)).toBe(true);
    expect(store.canDeleteSpace(work.id)).toBe(true);
    expect(store.canDeleteSpace("nope")).toBe(false);

    // After deleting down to one, the survivor is no longer deletable — exactly
    // when deleteSpace would throw.
    store.deleteSpace(work.id);
    expect(store.canDeleteSpace(personalId)).toBe(false);
    expect(() => store.deleteSpace(personalId)).toThrow(/last remaining space/);
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

  test("delegated tab ops (pin/archive) act only on the active space", () => {
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

    // A command carrying another space's tab id is rejected by the active store.
    expect(() => store.pin(b.id)).toThrow(/unknown tab/i);
    expect(() => store.close(b.id)).toThrow(/unknown tab/i);
    expect(() => store.activate(b.id)).toThrow(/unknown tab/i);
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

  test("is a silent no-op for an id owned by no space", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    expect(() => store.updateMeta("ghost", { title: "X" })).not.toThrow();
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
