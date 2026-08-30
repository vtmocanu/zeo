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
    listed.push({ id: "hacked", url: "x", title: "x", createdAt: 0 });

    expect(store.list().map((tab) => tab.id)).toEqual(["t1"]);
  });

  test("mutating a returned tab object does not affect the store", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });

    const [tab] = store.list();
    tab.title = "mutated";

    expect(store.list()[0].title).toBe("https://a.test");
  });

  test("snapshot returns tabs plus activeTabId", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    store.create({ url: "https://b.test" });

    const snap = store.snapshot();
    expect(snap.tabs.map((tab) => tab.id)).toEqual(["t1", "t2"]);
    expect(snap.activeTabId).toBe("t2");
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

  test("throws on an unknown id", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" });
    expect(() => store.activate("nope")).toThrow();
  });
});

describe("TabStore.close", () => {
  test("closing a non-active tab leaves the active pointer unchanged", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2 (active)

    store.close("t1");
    expect(store.activeTabId).toBe("t2");
    expect(store.list().map((tab) => tab.id)).toEqual(["t2"]);
  });

  test("closing the active middle tab activates the tab that takes its index", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2
    store.create({ url: "https://c.test" }); // t3
    store.activate("t2");

    store.close("t2");
    // t3 shifted into index 1 and becomes active.
    expect(store.activeTabId).toBe("t3");
    expect(store.list().map((tab) => tab.id)).toEqual(["t1", "t3"]);
  });

  test("closing the active first tab activates the new first tab", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2
    store.create({ url: "https://c.test" }); // t3
    store.activate("t1");

    store.close("t1");
    expect(store.activeTabId).toBe("t2");
    expect(store.list().map((tab) => tab.id)).toEqual(["t2", "t3"]);
  });

  test("closing the active last tab activates the new last tab", () => {
    const store = makeStore();
    store.create({ url: "https://a.test" }); // t1
    store.create({ url: "https://b.test" }); // t2
    store.create({ url: "https://c.test" }); // t3 (active, last)

    store.close("t3");
    expect(store.activeTabId).toBe("t2");
    expect(store.list().map((tab) => tab.id)).toEqual(["t1", "t2"]);
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
});
