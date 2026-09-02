import { describe, expect, test } from "vitest";
import { TabStore } from "./tab-store.js";
import type { Tab } from "./tab.js";

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

/**
 * Builds a store whose clock is a single mutable value the test drives via
 * `setClock`. Ids are `t1`, `t2`, ... . Unlike `makeStore` (which advances on
 * every read), this lets a test hold time still while creating tabs and then
 * jump the clock to a precise idle age — the control `archiveIdle` needs to
 * exercise its strict "older than" threshold.
 */
function makeClockStore(start = 1000): {
  store: TabStore;
  setClock: (value: number) => void;
} {
  let idCounter = 0;
  let clock = start;
  const store = new TabStore({
    idFactory: () => `t${++idCounter}`,
    now: () => clock,
  });
  return {
    store,
    setClock: (value: number) => {
      clock = value;
    },
  };
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

  test("a new tab's faviconUrl is null until an event supplies one", () => {
    const store = makeStore();
    const tab = store.create({ url: "https://a.test" });
    expect(tab.faviconUrl).toBeNull();
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
      faviconUrl: null,
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
        "faviconUrl",
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
    expect(store.activeTab?.lastActiveAt).toBe(1004);
  });

  test("re-stamps the outgoing tab's lastActiveAt on switch", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    store.create({ url: "https://b.test" });

    const before = store.list().find((t) => t.id === "t2")?.lastActiveAt ?? 0;
    store.activate("t1");
    const after = store.list().find((t) => t.id === "t2")?.lastActiveAt ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  test("re-stamps the outgoing tab's lastActiveAt on create", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    const before = store.list().find((t) => t.id === "t1")?.lastActiveAt ?? 0;

    store.create({ url: "https://b.test" });
    const after = store.list().find((t) => t.id === "t1")?.lastActiveAt ?? 0;
    expect(after).toBeGreaterThan(before);
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
    expect(store.activeTabId).toBe("t3");
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

  test("restore makes the restored tab active even when another tab is active", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2 (active)
    store.archive("t1");

    store.restore("t1");
    expect(store.activeTabId).toBe("t1");
  });

  test("restore re-stamps lastActiveAt so the idle sweep does not re-archive", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2 (active)
    store.archiveIdle(0);
    expect(store.archived().map((t) => t.id)).toEqual(["t1"]);

    store.restore("t1");
    store.activate("t2");
    expect(store.archiveIdle(10)).toEqual([]);
    expect(store.archived()).toEqual([]);
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

describe("TabStore.archiveIdle", () => {
  test("a tab whose age exactly equals maxIdleMs is NOT archived", () => {
    const { store, setClock } = makeClockStore(1000);
    store.create({ url: "https://a.test" }); // t1 lastActiveAt = 1000
    store.create({ url: "https://b.test" }); // t2 (active)

    setClock(6000); // t1 age = 5000, exactly the threshold
    expect(store.archiveIdle(5000)).toEqual([]);
    expect(store.list().map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(store.archived()).toEqual([]);
  });

  test("a tab one ms past the threshold IS archived", () => {
    const { store, setClock } = makeClockStore(1000);
    store.create({ url: "https://a.test" }); // t1 lastActiveAt = 1000
    store.create({ url: "https://b.test" }); // t2 (active)

    setClock(6001); // t1 age = 5001 > 5000
    expect(store.archiveIdle(5000)).toEqual(["t1"]);
    expect(store.list().map((t) => t.id)).toEqual(["t2"]);
    expect(store.archived().map((t) => t.id)).toEqual(["t1"]);
  });

  test("the active tab is exempt even when far past the threshold", () => {
    const { store, setClock } = makeClockStore(1000);
    store.create({ url: "https://a.test" }); // t1 (active)

    setClock(1_000_000); // t1 age enormous, but it is active
    expect(store.archiveIdle(5000)).toEqual([]);
    expect(store.activeTabId).toBe("t1");
    expect(store.list().map((t) => t.id)).toEqual(["t1"]);
  });

  test("a pinned tab is exempt even when far past the threshold", () => {
    const { store, setClock } = makeClockStore(1000);
    store.create({ url: "https://a.test" }); // t1
    store.pin("t1");
    store.create({ url: "https://b.test" }); // t2 (active)

    setClock(1_000_000); // both far past, but t1 pinned and t2 active
    expect(store.archiveIdle(5000)).toEqual([]);
    expect(store.list().map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  test("an empty store returns []", () => {
    const { store } = makeClockStore(1000);
    expect(store.archiveIdle(5000)).toEqual([]);
  });

  test("the returned ids equal the set that left list()", () => {
    const { store, setClock } = makeClockStore(1000);
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2
    store.create({ url: "https://c.test" }); // t3
    store.create({ url: "https://d.test" }); // t4 (active)

    const before = new Set(store.list().map((t) => t.id));
    setClock(1_000_000);
    const archivedIds = store.archiveIdle(5000);
    const after = new Set(store.list().map((t) => t.id));

    const left = [...before].filter((id) => !after.has(id));
    expect([...archivedIds].sort()).toEqual(left.sort());
    // t4 is active, so it stays; t1/t2/t3 leave.
    expect([...archivedIds].sort()).toEqual(["t1", "t2", "t3"]);
    expect([...after]).toEqual(["t4"]);
  });

  test("archived tabs appear in archived()", () => {
    const { store, setClock } = makeClockStore(1000);
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2
    store.create({ url: "https://c.test" }); // t3 (active)

    setClock(1_000_000);
    const archivedIds = store.archiveIdle(5000);

    expect(archivedIds.sort()).toEqual(["t1", "t2"]);
    expect(store.archived().map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    for (const tab of store.archived()) {
      expect(tab.archivedAt).not.toBeNull();
    }
  });
});

describe("TabStore.rebaseActivity", () => {
  /** Builds a persisted {@link Tab} with the given id/lastActiveAt/archivedAt. */
  function persistedTab(
    id: string,
    lastActiveAt: number,
    archivedAt: number | null = null,
  ): Tab {
    return {
      id,
      url: `https://${id}.test`,
      title: id,
      faviconUrl: null,
      createdAt: 0,
      pinned: false,
      lastActiveAt,
      archivedAt,
    };
  }

  test("shifts open tabs so the newest lands at now, preserving order and spacing", () => {
    // Open tabs (list order) with distinct lastActiveAt; newest is t2 at 300.
    const store = TabStore.hydrate(
      [
        persistedTab("t1", 100),
        persistedTab("t2", 300),
        persistedTab("t3", 200),
      ],
      "t2",
    );

    store.rebaseActivity(1000);

    const byId = new Map(store.list().map((t) => [t.id, t]));
    // delta = 1000 - 300 = 700; every open tab shifts by the same delta.
    expect(byId.get("t1")!.lastActiveAt).toBe(800);
    expect(byId.get("t2")!.lastActiveAt).toBe(1000);
    expect(byId.get("t3")!.lastActiveAt).toBe(900);
    // Newest open tab sits exactly at now; relative differences preserved.
    expect(byId.get("t2")!.lastActiveAt).toBe(1000);
    expect(byId.get("t2")!.lastActiveAt - byId.get("t1")!.lastActiveAt).toBe(200);
    expect(byId.get("t2")!.lastActiveAt - byId.get("t3")!.lastActiveAt).toBe(100);
    // Array/MRU order among open tabs is unchanged.
    expect(store.list().map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    // Active pointer untouched.
    expect(store.activeTabId).toBe("t2");
  });

  test("no-op when there are no open tabs (all archived)", () => {
    const store = TabStore.hydrate(
      [persistedTab("t1", 100, 150), persistedTab("t2", 200, 250)],
      null,
    );

    store.rebaseActivity(1_000_000);

    const archived = new Map(store.archived().map((t) => [t.id, t]));
    expect(archived.get("t1")!.lastActiveAt).toBe(100);
    expect(archived.get("t2")!.lastActiveAt).toBe(200);
    expect(store.list()).toEqual([]);
  });

  test("leaves archived tabs' lastActiveAt untouched", () => {
    const store = TabStore.hydrate(
      [
        persistedTab("t1", 100),
        persistedTab("t2", 300),
        persistedTab("a1", 50, 60),
      ],
      "t2",
    );

    store.rebaseActivity(1000);

    // Open tabs shifted by delta = 700.
    const open = new Map(store.list().map((t) => [t.id, t]));
    expect(open.get("t1")!.lastActiveAt).toBe(800);
    expect(open.get("t2")!.lastActiveAt).toBe(1000);
    // Archived tab is left exactly where it was.
    const archived = new Map(store.archived().map((t) => [t.id, t]));
    expect(archived.get("a1")!.lastActiveAt).toBe(50);
  });
});

describe("TabStore.remove", () => {
  test("removing an archived tab drops it from archived()", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2 (active)
    store.archive("t1");
    expect(store.archived().map((t) => t.id)).toEqual(["t1"]);

    store.remove("t1");
    expect(store.archived()).toEqual([]);
    expect(store.list().map((t) => t.id)).toEqual(["t2"]);
  });

  test("removing an open non-active tab leaves it gone from list()", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2 (active)

    store.remove("t1");
    expect(store.list().map((t) => t.id)).toEqual(["t2"]);
    expect(store.activeTabId).toBe("t2");
  });

  test("removing the active tab re-points active to the MRU remaining open tab", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2
    store.create({ url: "https://c.test" }); // t3 (active)

    store.remove("t3");
    // MRU of remaining open {t1, t2} is t2 (created after t1).
    expect(store.activeTabId).toBe("t2");
    expect(store.list().map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  test("throws on an unknown id", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    expect(() => store.remove("nope")).toThrow(/Cannot remove unknown tab/);
  });
});

describe("TabStore.updateMeta", () => {
  test("title-only update sets title and leaves faviconUrl unchanged", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1

    store.updateMeta("t1", { title: "X" });
    const tab = store.list().find((t) => t.id === "t1");
    expect(tab?.title).toBe("X");
    expect(tab?.faviconUrl).toBeNull();
  });

  test("favicon-only update sets favicon and leaves title unchanged", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1 title = url

    store.updateMeta("t1", { faviconUrl: "https://e.test/f.ico" });
    const tab = store.list().find((t) => t.id === "t1");
    expect(tab?.faviconUrl).toBe("https://e.test/f.ico");
    expect(tab?.title).toBe("https://a.test");
  });

  test("applying title then favicon ends with both set", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1

    store.updateMeta("t1", { title: "X" });
    store.updateMeta("t1", { faviconUrl: "https://e.test/f.ico" });

    const tab = store.list().find((t) => t.id === "t1");
    expect(tab?.title).toBe("X");
    expect(tab?.faviconUrl).toBe("https://e.test/f.ico");
  });

  test("applying favicon then title ends with both set", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1

    store.updateMeta("t1", { faviconUrl: "https://e.test/f.ico" });
    store.updateMeta("t1", { title: "X" });

    const tab = store.list().find((t) => t.id === "t1");
    expect(tab?.title).toBe("X");
    expect(tab?.faviconUrl).toBe("https://e.test/f.ico");
  });

  test("faviconUrl can be set back to null (empty-favicon case)", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.updateMeta("t1", { faviconUrl: "https://e.test/f.ico" });

    store.updateMeta("t1", { faviconUrl: null });
    expect(store.list().find((t) => t.id === "t1")?.faviconUrl).toBeNull();
  });

  test("updateMeta on an unknown id is a no-op and does not throw", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1

    expect(() => store.updateMeta("nonexistent", { title: "X" })).not.toThrow();
    expect(store.list().find((t) => t.id === "t1")?.title).toBe("https://a.test");
  });

  test("changes are observable via snapshot()", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1

    store.updateMeta("t1", {
      title: "X",
      faviconUrl: "https://e.test/f.ico",
    });

    const snap = store.snapshot();
    const tab = snap.tabs.find((t) => t.id === "t1");
    expect(tab?.title).toBe("X");
    expect(tab?.faviconUrl).toBe("https://e.test/f.ico");
  });

  test("url update replaces the record's url", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1

    store.updateMeta("t1", { url: "https://b.test/page" });
    expect(store.list().find((t) => t.id === "t1")?.url).toBe("https://b.test/page");
  });

  test("url update on an unknown id is a no-op and does not throw", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1

    expect(() => store.updateMeta("nonexistent", { url: "https://b.test" })).not.toThrow();
    expect(store.list().find((t) => t.id === "t1")?.url).toBe("https://a.test");
  });
});
