import { describe, expect, test } from "vitest";
import { TabStore } from "./tab-store.js";

/**
 * Builds a store with deterministic id and clock factories:
 * ids are `t1`, `t2`, ... and the clock starts at 1000 and increments by 1
 * on each read.
 */
function makeStore(): TabStore {
  let idCounter = 0;
  let clock = 1000;
  return new TabStore({
    idFactory: () => `t${++idCounter}`,
    now: () => clock++,
  });
}

/**
 * Builds a store whose clock is FROZEN at a constant value, so every timestamp
 * read is identical. Used to exercise the sequence-based tie-breaks that decide
 * MRU selection and `archived()` ordering when two ops share one timestamp.
 */
function makeFrozenStore(constant = 500): TabStore {
  let idCounter = 0;
  return new TabStore({
    idFactory: () => `t${++idCounter}`,
    now: () => constant,
  });
}

describe("TabStore.create", () => {
  test("assigns injected id and clock, and becomes active", () => {
    const store = makeStore();
    const tab = store.create({ url: "https://a.test" });

    expect(tab.id).toBe("t1");
    expect(tab.url).toBe("https://a.test");
    expect(tab.createdAt).toBe(1000);
    expect(store.activeTabId).toBe("t1");
    expect(store.activeTab).toEqual(tab);
  });

  test("title defaults to url when omitted", () => {
    const store = makeStore();
    const tab = store.create({ url: "https://a.test" });
    expect(tab.title).toBe("https://a.test");
  });

  test("explicit title is respected", () => {
    const store = makeStore();
    const tab = store.create({ url: "https://a.test", title: "Alpha" });
    expect(tab.title).toBe("Alpha");
  });

  test("seeds the new pinning/archiving fields", () => {
    const store = makeStore();
    const tab = store.create({ url: "https://a.test" });
    expect(tab.pinned).toBe(false);
    expect(tab.archivedAt).toBeNull();
    expect(tab.lastActiveAt).toBe(tab.createdAt);
  });

  test("each create advances the active pointer to the new tab", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    const second = store.create({ url: "https://b.test" });
    expect(store.activeTabId).toBe(second.id);
  });
});

describe("TabStore.list / snapshot", () => {
  test("returns tabs in insertion order", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    store.create({ url: "https://b.test" });
    store.create({ url: "https://c.test" });

    expect(store.list().map((tab) => tab.id)).toEqual(["t1", "t2", "t3"]);
  });

  test("returned array is a defensive copy — mutating it does not affect the store", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });

    const listed = store.list();
    listed.pop();
    listed.push({
      id: "hacked",
      url: "x",
      title: "x",
      createdAt: 0,
      pinned: false,
      lastActiveAt: 0,
      archivedAt: null,
    });

    expect(store.list().map((tab) => tab.id)).toEqual(["t1"]);
  });

  test("mutating a returned tab object does not affect the store", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });

    const [tab] = store.list();
    tab.title = "mutated";

    expect(store.list()[0].title).toBe("https://a.test");
  });

  test("returned tabs never leak the internal sequence fields", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    const [tab] = store.list();
    expect(Object.keys(tab).sort()).toEqual(
      [
        "archivedAt",
        "createdAt",
        "id",
        "lastActiveAt",
        "pinned",
        "title",
        "url",
      ].sort(),
    );
  });

  test("snapshot returns tabs, activeTabId, and archived", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    store.create({ url: "https://b.test" });

    const snap = store.snapshot();
    expect(snap.tabs.map((tab) => tab.id)).toEqual(["t1", "t2"]);
    expect(snap.activeTabId).toBe("t2");
    expect(snap.archived).toEqual([]);
  });
});

describe("TabStore.activate", () => {
  test("switches the active tab", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    store.create({ url: "https://b.test" });

    store.activate("t1");
    expect(store.activeTabId).toBe("t1");
    expect(store.activeTab?.id).toBe("t1");
  });

  test("stamps lastActiveAt from the clock", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    store.create({ url: "https://b.test" });

    store.activate("t1");
    expect(store.activeTab?.lastActiveAt).toBe(1002);
  });

  test("throws on an unknown id", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    expect(() => store.activate("nope")).toThrow();
  });

  test("throws on an archived id (archived tabs never become active)", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2 (active)
    store.archive("t1");

    expect(() => store.activate("t1")).toThrow();
  });
});

describe("TabStore.pin / unpin", () => {
  test("pinning moves the tab to the end of the pinned group", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2
    store.create({ url: "https://c.test" }); // t3

    store.pin("t2");
    // pinned [t2], unpinned [t1, t3]
    expect(store.list().map((t) => t.id)).toEqual(["t2", "t1", "t3"]);

    store.pin("t1");
    // pinned [t2, t1] (t1 appended after existing pinned), unpinned [t3]
    expect(store.list().map((t) => t.id)).toEqual(["t2", "t1", "t3"]);
    expect(store.list().filter((t) => t.pinned).map((t) => t.id)).toEqual([
      "t2",
      "t1",
    ]);
  });

  test("unpinning moves the tab to the end of the unpinned group", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2
    store.create({ url: "https://c.test" }); // t3
    store.pin("t2");
    store.pin("t1"); // pinned [t2, t1], unpinned [t3]

    store.unpin("t2");
    // pinned [t1], unpinned [t3, t2] (t2 appended to end of unpinned)
    expect(store.list().map((t) => t.id)).toEqual(["t1", "t3", "t2"]);
  });

  test("list returns the pinned group first, stable within each group", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2
    store.create({ url: "https://c.test" }); // t3
    store.create({ url: "https://d.test" }); // t4

    store.pin("t3");
    store.pin("t1");
    // pinned group [t3, t1] in pin order; unpinned [t2, t4] stable
    expect(store.list().map((t) => t.id)).toEqual(["t3", "t1", "t2", "t4"]);
  });

  test("re-pinning an already-pinned tab is a strict no-op (order preserved)", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1 = a
    store.create({ url: "https://b.test" }); // t2 = b

    store.pin("t1");
    store.pin("t2"); // pinned group [t1, t2]
    expect(store.list().map((t) => t.id)).toEqual(["t1", "t2"]);

    store.pin("t1"); // MUST NOT move t1 to the end -> stays [t1, t2]
    expect(store.list().map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  test("re-unpinning an already-unpinned tab is a strict no-op (order preserved)", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2
    store.create({ url: "https://c.test" }); // t3

    store.unpin("t2"); // already unpinned — must NOT move to the end
    expect(store.list().map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  test("pin on an archived tab throws", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2 (active)
    store.archive("t1");

    expect(() => store.pin("t1")).toThrow();
  });

  test("unpin on an archived tab throws", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    store.create({ url: "https://b.test" });
    store.archive("t1");

    expect(() => store.unpin("t1")).toThrow(/archived/);
  });

  test("pin and unpin throw on unknown ids", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    expect(() => store.pin("nope")).toThrow();
    expect(() => store.unpin("nope")).toThrow();
  });
});

describe("TabStore.reorder", () => {
  test("clamps toIndex past the end to the last position", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2
    store.create({ url: "https://c.test" }); // t3

    store.reorder("t1", 10);
    expect(store.list().map((t) => t.id)).toEqual(["t2", "t3", "t1"]);
  });

  test("clamps a negative toIndex to the front", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2
    store.create({ url: "https://c.test" }); // t3

    store.reorder("t3", -5);
    expect(store.list().map((t) => t.id)).toEqual(["t3", "t1", "t2"]);
  });

  test("reorders within a group without moving across groups", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2
    store.create({ url: "https://c.test" }); // t3
    store.pin("t1"); // pinned [t1], unpinned [t2, t3]

    store.reorder("t2", 5); // clamps within the unpinned group -> end of it
    // t2 stays unpinned; pinned group untouched.
    expect(store.list().map((t) => t.id)).toEqual(["t1", "t3", "t2"]);
    expect(store.list().find((t) => t.id === "t2")?.pinned).toBe(false);
  });

  test("throws on an unknown id", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    expect(() => store.reorder("nope", 0)).toThrow();
  });

  test("throws on an archived id", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2 (active)
    store.archive("t1");
    expect(() => store.reorder("t1", 0)).toThrow(/archived/);
  });

  test("throws on a non-integer toIndex", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    store.create({ url: "https://b.test" });

    expect(() => store.reorder("t1", Number.NaN)).toThrow(/non-integer/);
    expect(() => store.reorder("t1", 1.5)).toThrow(/non-integer/);
    expect(store.list().map((t) => t.id)).toEqual(["t1", "t2"]);
  });
});

describe("TabStore.close (MRU activation)", () => {
  test("closing a non-active tab leaves the active pointer unchanged", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2 (active)

    store.close("t1");
    expect(store.activeTabId).toBe("t2");
    expect(store.list().map((tab) => tab.id)).toEqual(["t2"]);
  });

  test("closing the active tab activates the most-recently-active remaining tab", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2
    store.create({ url: "https://c.test" }); // t3 (active)

    store.activate("t1"); // recency: t1 newest
    store.activate("t2"); // recency: t2 > t1 > t3, active t2

    store.close("t2");
    // MRU of remaining {t1, t3} is t1.
    expect(store.activeTabId).toBe("t1");
    expect(store.list().map((tab) => tab.id)).toEqual(["t1", "t3"]);
  });

  test("same-timestamp ties are broken by activation sequence (later wins)", () => {
    const store = makeFrozenStore();
    store.create({ url: "https://a.test" }); // t1 seq1
    store.create({ url: "https://b.test" }); // t2 seq2
    store.create({ url: "https://c.test" }); // t3 seq3 (active)

    // All lastActiveAt share the frozen timestamp; t3 is active and closed.
    store.close("t3");
    // Remaining {t1 seq1, t2 seq2} tie on timestamp -> greatest seq wins: t2.
    expect(store.activeTabId).toBe("t2");
  });

  test("an archived tab is never chosen as the next active tab", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1 (oldest active)
    store.create({ url: "https://b.test" }); // t2
    store.create({ url: "https://c.test" }); // t3 (active)
    store.archive("t2"); // t2 has a newer lastActiveAt than t1 but is archived

    store.close("t3");
    // Only t1 remains OPEN; archived t2 is excluded despite being more recent.
    expect(store.activeTabId).toBe("t1");
    expect(store.list().map((tab) => tab.id)).toEqual(["t1"]);
  });

  test("closing every tab one by one ends with a null active pointer", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2
    store.create({ url: "https://c.test" }); // t3

    store.close("t3");
    store.close("t2");
    store.close("t1");

    expect(store.activeTabId).toBeNull();
    expect(store.activeTab).toBeNull();
    expect(store.list()).toEqual([]);
  });

  test("throws on an unknown id", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    expect(() => store.close("nope")).toThrow();
  });

  test("throws on an archived id (archived tabs stay restorable)", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    store.create({ url: "https://b.test" });
    store.archive("t1");

    expect(() => store.close("t1")).toThrow(/archived/);
    expect(store.archived().map((t) => t.id)).toEqual(["t1"]);
  });

  test("the implicitly activated MRU successor is stamped as an activation", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    store.create({ url: "https://b.test" });
    store.create({ url: "https://c.test" });

    store.archive("t3");
    store.restore("t3");
    store.activate("t1");

    store.close("t1");
    expect(store.activeTabId).toBe("t2");
  });
});

describe("TabStore.archive / restore", () => {
  test("archive removes the tab from list() and shows it in archived()", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2 (active)

    store.archive("t1");
    expect(store.list().map((t) => t.id)).toEqual(["t2"]);
    expect(store.archived().map((t) => t.id)).toEqual(["t1"]);
    expect(store.archived()[0].archivedAt).not.toBeNull();
  });

  test("archiving the only open tab leaves activeTabId null, then restore re-activates it", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1 (active)

    store.archive("t1");
    expect(store.activeTabId).toBeNull();
    expect(store.list()).toEqual([]);

    store.restore("t1");
    expect(store.activeTabId).toBe("t1");
    expect(store.list().map((t) => t.id)).toEqual(["t1"]);
    expect(store.archived()).toEqual([]);
  });

  test("archiving the active tab re-points active via the MRU rule", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2
    store.create({ url: "https://c.test" }); // t3 (active)
    store.activate("t1"); // recency: t1 newest, active t1

    store.archive("t1");
    // MRU of remaining open {t2, t3} is t3 (created after t2).
    expect(store.activeTabId).toBe("t3");
  });

  test("restore clears pinned and appends to the end of the unpinned group", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2 (active)
    store.archive("t1");

    store.restore("t1");
    const restored = store.list().find((t) => t.id === "t1");
    expect(restored?.pinned).toBe(false);
    // Appended to the end of the unpinned group -> after t2.
    expect(store.list().map((t) => t.id)).toEqual(["t2", "t1"]);
  });

  test("archive of a pinned tab throws", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.pin("t1");
    expect(() => store.archive("t1")).toThrow();
  });

  test("restore of a tab that is not archived throws", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    expect(() => store.restore("t1")).toThrow();
  });

  test("archive of an already-archived tab throws", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    store.create({ url: "https://b.test" });
    store.archive("t1");
    const [archivedTab] = store.archived();

    expect(() => store.archive("t1")).toThrow(/archived/);
    expect(store.archived()).toEqual([archivedTab]);
  });

  test("archive and restore throw on unknown ids", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    expect(() => store.archive("nope")).toThrow();
    expect(() => store.restore("nope")).toThrow();
  });

  test("archived() lists most-recently-archived first, tie-broken by sequence", () => {
    const store = makeFrozenStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2
    store.create({ url: "https://c.test" }); // t3 (active)

    // All archivedAt share the frozen timestamp; ordering falls to archivalSeq.
    store.archive("t3");
    store.archive("t2");
    store.archive("t1");

    // Most recently archived (highest seq) first.
    expect(store.archived().map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  test("snapshot().archived matches archived() ordering", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2
    store.create({ url: "https://c.test" }); // t3 (active)
    store.archive("t1");
    store.archive("t2");

    expect(store.snapshot().archived.map((t) => t.id)).toEqual(
      store.archived().map((t) => t.id),
    );
  });
});
