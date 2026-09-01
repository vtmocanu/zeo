import { describe, expect, test } from "vitest";
import { SpaceStore } from "./space-store.js";
import { serializeStore, deserializeStore } from "./space-store.js";
import {
  migrationAction,
  UnsupportedSchemaVersionError,
  type PersistedState,
} from "./persistence.js";

/**
 * Builds a store with deterministic id and clock factories, SHARED across every
 * space's tab set: ids are `t1`, `t2`, ... (the seed space is `t1`) and the
 * clock starts at 1000 and increments by 1 on each read, so every createdAt /
 * lastActiveAt / archivedAt is distinct.
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
 * `setClock`, so two archivals can be forced to share an identical `archivedAt`
 * — the input the tie-break assertion needs.
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

/**
 * The full observable state of a store, read via its public API: profiles,
 * spaces, the active space id, and — per space, in creation order — the open
 * list, the archived list, and the active tab id. `activeSpaceId` is captured
 * BEFORE the per-space loop switches the active space, so the loop's switching
 * does not corrupt the captured value.
 */
function capture(store: SpaceStore) {
  const profiles = store.profiles();
  const spaces = store.spaces();
  const activeSpaceId = store.activeSpaceId;
  const perSpace = spaces.map((space) => {
    store.setActiveSpace(space.id);
    return {
      id: space.id,
      list: store.list(),
      archived: store.archived(),
      activeTabId: store.activeTabId,
    };
  });
  return { profiles, spaces, activeSpaceId, perSpace };
}

describe("serialize/deserialize round-trip", () => {
  test("reproduces profiles, spaces, tabs, active pointers, and every tab field", () => {
    const store = makeStore();
    const seed = store.spaces()[0]; // "Personal", default profile, id t1

    // Two profiles beyond the seeded default, and spaces on different profiles.
    const work = store.createProfile("Work");
    const docs = store.createSpace("Docs", work.id);
    const research = store.createSpace("Research"); // default profile

    // Seed space: a pinned tab (with a favicon), a specific reorder, and an
    // archived tab.
    store.setActiveSpace(seed.id);
    const a = store.create({ url: "https://a.example", title: "A" });
    const b = store.create({ url: "https://b.example", title: "B" });
    const c = store.create({ url: "https://c.example", title: "C" });
    store.updateMeta(a.id, { faviconUrl: "https://a.example/favicon.ico" });
    store.pin(a.id); // pinned group: [a]
    store.reorder(c.id, 0); // unpinned group: [b, c] -> [c, b]
    store.archive(b.id); // archived: [b]; open unpinned: [c]

    // Docs space: one archived, one open (open is active).
    store.setActiveSpace(docs.id);
    const d = store.create({ url: "https://d.example", title: "D" });
    store.create({ url: "https://e.example", title: "E" });
    store.archive(d.id); // archived: [d]; open: [e] (active)

    // Research space: a single pinned tab.
    store.setActiveSpace(research.id);
    const f = store.create({ url: "https://f.example", title: "F" });
    store.pin(f.id);

    // A non-default active space.
    store.setActiveSpace(docs.id);

    // Serialize BEFORE capturing: `capture` switches the active space as it
    // walks, so the snapshot must be taken while the store still holds its real
    // active space.
    const persisted = serializeStore(store);
    const before = capture(store);
    const restored = deserializeStore(persisted);
    const after = capture(restored);

    expect(after).toEqual(before);

    // Spot-check the load-bearing fields explicitly (capture's toEqual already
    // covers them, but pin these so a regression names the field).
    restored.setActiveSpace(seed.id);
    const restoredPinned = restored.list()[0];
    expect(restoredPinned.id).toBe(a.id);
    expect(restoredPinned.pinned).toBe(true);
    expect(restoredPinned.faviconUrl).toBe("https://a.example/favicon.ico");
    expect(restored.list().map((tab) => tab.id)).toEqual([a.id, c.id]);
    expect(restored.archived().map((tab) => tab.id)).toEqual([b.id]);
    // The active space id round-trips (captured above as before/after equal).
    expect(after.activeSpaceId).toBe(docs.id);
  });
});

describe("archived tie-break survives the round-trip", () => {
  test("two archived tabs with identical archivedAt keep their archived() order", () => {
    const { store, setClock } = makeClockStore();
    setClock(1000);
    const x = store.create({ url: "https://x.example", title: "X" });
    const y = store.create({ url: "https://y.example", title: "Y" });
    setClock(5000);
    store.archive(x.id);
    store.archive(y.id); // same archivedAt (5000); y archived last -> first

    const originalOrder = store.archived().map((tab) => tab.id);
    expect(originalOrder).toEqual([y.id, x.id]);

    const restored = deserializeStore(serializeStore(store));
    expect(restored.archived().map((tab) => tab.id)).toEqual(originalOrder);
  });
});

/**
 * A minimal single-profile persisted state the repair tests extend. Callers
 * override `spaces`/`tabs`/`meta.activeSpaceId` as each repair rule requires.
 */
function baseTab(overrides: Partial<PersistedState["tabs"][number]>) {
  return {
    id: "t1",
    spaceId: "s1",
    url: "https://u.example",
    title: "U",
    faviconUrl: null,
    createdAt: 1,
    pinned: false,
    lastActiveAt: 1,
    archivedAt: null,
    position: 0,
    ...overrides,
  };
}

describe("repair rules on deserialize", () => {
  const profiles = [
    { id: "default", name: "Default", createdAt: 1, position: 0 },
  ];

  test("activeTabId pointing at an archived tab restores to null", () => {
    const state: PersistedState = {
      meta: { schemaVersion: 1, activeSpaceId: "s1" },
      profiles,
      spaces: [
        {
          id: "s1",
          name: "S",
          profileId: "default",
          createdAt: 1,
          activeTabId: "tArch",
          position: 0,
        },
      ],
      tabs: [baseTab({ id: "tArch", archivedAt: 5 })],
    };
    const restored = deserializeStore(state);
    restored.setActiveSpace("s1");
    expect(restored.activeTabId).toBeNull();
  });

  test("activeTabId pointing at a missing id restores to null", () => {
    const state: PersistedState = {
      meta: { schemaVersion: 1, activeSpaceId: "s1" },
      profiles,
      spaces: [
        {
          id: "s1",
          name: "S",
          profileId: "default",
          createdAt: 1,
          activeTabId: "ghost",
          position: 0,
        },
      ],
      tabs: [baseTab({ id: "tOpen" })],
    };
    const restored = deserializeStore(state);
    restored.setActiveSpace("s1");
    expect(restored.activeTabId).toBeNull();
  });

  test("activeTabId pointing at a tab owned by another space restores to null", () => {
    const state: PersistedState = {
      meta: { schemaVersion: 1, activeSpaceId: "s1" },
      profiles,
      spaces: [
        {
          id: "s1",
          name: "S1",
          profileId: "default",
          createdAt: 1,
          activeTabId: "tInS2",
          position: 0,
        },
        {
          id: "s2",
          name: "S2",
          profileId: "default",
          createdAt: 2,
          activeTabId: null,
          position: 1,
        },
      ],
      tabs: [baseTab({ id: "tInS2", spaceId: "s2" })],
    };
    const restored = deserializeStore(state);
    restored.setActiveSpace("s1");
    expect(restored.activeTabId).toBeNull();
    // Sanity: the tab lives (and is open) in s2.
    restored.setActiveSpace("s2");
    expect(restored.list().map((tab) => tab.id)).toEqual(["tInS2"]);
  });

  test("an archived-only space restores with a null active tab", () => {
    const state: PersistedState = {
      meta: { schemaVersion: 1, activeSpaceId: "s1" },
      profiles,
      spaces: [
        {
          id: "s1",
          name: "S",
          profileId: "default",
          createdAt: 1,
          activeTabId: null,
          position: 0,
        },
      ],
      tabs: [baseTab({ id: "tArch", archivedAt: 5 })],
    };
    const restored = deserializeStore(state);
    restored.setActiveSpace("s1");
    expect(restored.activeTabId).toBeNull();
    expect(restored.archived().map((tab) => tab.id)).toEqual(["tArch"]);
  });

  test("a null activeSpaceId restores to the first space in position order", () => {
    const state: PersistedState = {
      meta: { schemaVersion: 1, activeSpaceId: null },
      profiles,
      spaces: [
        {
          id: "sFirst",
          name: "First",
          profileId: "default",
          createdAt: 1,
          activeTabId: null,
          position: 0,
        },
        {
          id: "sSecond",
          name: "Second",
          profileId: "default",
          createdAt: 2,
          activeTabId: null,
          position: 1,
        },
      ],
      tabs: [],
    };
    expect(deserializeStore(state).activeSpaceId).toBe("sFirst");
  });

  test("a dangling activeSpaceId restores to the first space in position order", () => {
    const state: PersistedState = {
      meta: { schemaVersion: 1, activeSpaceId: "nope" },
      profiles,
      spaces: [
        {
          id: "sFirst",
          name: "First",
          profileId: "default",
          createdAt: 1,
          activeTabId: null,
          position: 0,
        },
        {
          id: "sSecond",
          name: "Second",
          profileId: "default",
          createdAt: 2,
          activeTabId: null,
          position: 1,
        },
      ],
      tabs: [],
    };
    expect(deserializeStore(state).activeSpaceId).toBe("sFirst");
  });
});

describe("migrationAction", () => {
  test("version 0 means create, current means noop, above means abort", () => {
    expect(migrationAction(0)).toBe("create");
    expect(migrationAction(1)).toBe("noop");
    expect(migrationAction(2)).toBe("abort");
  });
});

describe("version guard", () => {
  test("deserialize of a newer schema version throws UnsupportedSchemaVersionError", () => {
    const state: PersistedState = {
      meta: { schemaVersion: 2, activeSpaceId: null },
      profiles: [{ id: "default", name: "Default", createdAt: 1, position: 0 }],
      spaces: [],
      tabs: [],
    };
    expect(() => deserializeStore(state)).toThrow(UnsupportedSchemaVersionError);
  });
});
