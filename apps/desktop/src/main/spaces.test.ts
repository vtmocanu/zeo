import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Hoisted fakes that the ./views, ./tabs, ./layout and ./broadcast mocks below
// close over, so the deleteSpace tests can drive destroyView/forgetTab (throw or
// not) and assert reconcileAndApply/broadcast still run. vi.mock factories are
// hoisted above the imports and may only read hoisted state.
const h = vi.hoisted(() => ({
  destroyView: vi.fn(),
  createViewFor: vi.fn(),
  unloadSpaceViews: vi.fn(),
  forgetTab: vi.fn(),
  reconcileAndApply: vi.fn(),
  broadcast: vi.fn(),
}));

// spaces.ts imports electron at runtime and self-registers IPC via top-level
// ipcMain.handle at module load, exactly like tabs.test.ts. Mock electron so the
// import resolves with no real Electron: the only load-time API is ipcMain.handle.
vi.mock("electron", () => ({
  ipcMain: { handle: () => {} },
  Menu: {
    buildFromTemplate: () => ({ popup: () => {} }),
    setApplicationMenu: () => {},
  },
  clipboard: { writeText: () => {} },
  shell: { openExternal: () => {} },
  session: { fromPartition: () => ({}), defaultSession: {} },
  app: { getPath: () => "" },
  BrowserWindow: class {},
  WebContentsView: class {},
  nativeTheme: {},
}));

// Neutralize the session/adblock side effects createProfileAndAssign triggers
// BEFORE the injected collaborator runs, so the composite is exercised as pure
// store-plus-rollback logic with no Electron session work. These are the only
// exports spaces.ts imports from each module.
vi.mock("./blocking.js", () => ({
  attachBlockerToProfileSession: () => {},
}));
vi.mock("./downloads.js", () => ({
  installDownloadHandler: () => {},
  logDownloadError: () => {},
}));

// deleteSpace's teardown collaborators are ES named-import bindings inside
// spaces.ts, so they can only be observed/controlled by mocking their modules.
// Each factory stands in for exactly the exports spaces.ts imports from that
// module; the non-deleteSpace describes assert only store state, so these no-op
// fakes are inert there.
vi.mock("./views.js", () => ({
  destroyView: h.destroyView,
  createViewFor: h.createViewFor,
  unloadSpaceViews: h.unloadSpaceViews,
}));
vi.mock("./tabs.js", () => ({ forgetTab: h.forgetTab }));
vi.mock("./layout.js", () => ({ reconcileAndApply: h.reconcileAndApply }));
vi.mock("./broadcast.js", () => ({ broadcast: h.broadcast }));

import { SpaceStore } from "@zeo/core";
import { runtime } from "./state.js";
import { createProfileAndAssign, createSpaceAndActivate, deleteSpace } from "./spaces.js";

describe("createSpaceAndActivate", () => {
  beforeEach(() => {
    // Clean, Electron-free baseline: a fresh seeded store (one "Personal" space on
    // the default profile) and no live views.
    runtime.store = new SpaceStore();
    runtime.win = null;
    runtime.views.clear();
  });

  test("creates the space, makes it active, and returns it (default activate)", () => {
    const before = runtime.store.spaces().length;

    const space = createSpaceAndActivate("Work");

    expect(runtime.store.spaces().length).toBe(before + 1);
    expect(runtime.store.spaces().some((s) => s.id === space.id)).toBe(true);
    expect(runtime.store.activeSpaceId).toBe(space.id);
  });

  test("rolls the created space back when the injected activate throws", () => {
    const before = runtime.store.spaces();

    expect(() =>
      createSpaceAndActivate("Work", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    // The just-created space was deleted, so spaces() equals its pre-call value.
    expect(runtime.store.spaces()).toEqual(before);
  });

  test("rolls back BOTH the space and the active-space pointer when a realistic activate throws mid-switch", () => {
    // Bind the test to the restore: make a NON-order[0] space active first, so a
    // rollback that merely deletes the new space (re-pointing active to order[0])
    // would leave the WRONG space active. Mimic switchSpace's ordering: it re-points
    // the active space BEFORE its throwable work.
    const second = runtime.store.createSpace("Second");
    runtime.store.setActiveSpace(second.id);
    const before = runtime.store.spaces();
    const previousActive = runtime.store.activeSpaceId; // = second (not order[0])

    expect(() =>
      createSpaceAndActivate("Work", (id) => {
        runtime.store.setActiveSpace(id);
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(runtime.store.spaces()).toEqual(before);
    expect(runtime.store.activeSpaceId).toBe(previousActive);
  });

  test("throws on a blank name before anything is created", () => {
    const before = runtime.store.spaces();

    expect(() => createSpaceAndActivate("   ")).toThrow();

    expect(runtime.store.spaces()).toEqual(before);
  });
});

describe("createProfileAndAssign", () => {
  beforeEach(() => {
    runtime.store = new SpaceStore();
    runtime.win = null;
    runtime.views.clear();
  });

  test("creates the profile, assigns it to the space, and returns it (default assign)", () => {
    const spaceId = runtime.store.activeSpaceId;
    const before = runtime.store.profiles().length;

    const profile = createProfileAndAssign(spaceId, "Work profile");

    expect(runtime.store.profiles().length).toBe(before + 1);
    expect(runtime.store.spaceProfileId(spaceId)).toBe(profile.id);
  });

  test("rolls the created profile back when the injected assign throws", () => {
    const spaceId = runtime.store.activeSpaceId;
    const before = runtime.store.profiles();

    expect(() =>
      createProfileAndAssign(spaceId, "Work profile", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    // The just-created profile was deleted, so profiles() equals its pre-call value.
    expect(runtime.store.profiles()).toEqual(before);
  });

  test("rolls back BOTH the profile and the space reassignment when a realistic assign throws mid-remap", () => {
    // Mimic remapSpaceProfile's ordering: it re-points the space at the new profile
    // BEFORE its throwable createViewFor/reconcile work. The rollback must un-assign
    // first so deleteProfile (which refuses a still-referenced profile) can succeed
    // and the store returns to its pre-call state.
    const spaceId = runtime.store.activeSpaceId;
    const before = runtime.store.profiles();
    const previousProfileId = runtime.store.spaceProfileId(spaceId);

    expect(() =>
      createProfileAndAssign(spaceId, "Work profile", (sid, pid) => {
        runtime.store.setSpaceProfile(sid, pid);
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(runtime.store.profiles()).toEqual(before);
    expect(runtime.store.spaceProfileId(spaceId)).toBe(previousProfileId);
  });

  test("throws for an unknown space before any profile is created", () => {
    const before = runtime.store.profiles();

    expect(() => createProfileAndAssign("no-such-space", "Work profile")).toThrow();

    // spaceProfileId(spaceId) threw first, so no profile ever existed.
    expect(runtime.store.profiles()).toEqual(before);
  });
});

describe("deleteSpace", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Clean, Electron-free baseline plus fresh teardown-collaborator spies.
    runtime.store = new SpaceStore();
    runtime.win = null;
    runtime.views.clear();
    h.destroyView.mockReset();
    h.forgetTab.mockReset();
    h.reconcileAndApply.mockReset();
    h.broadcast.mockReset();
    // Observe (and silence) the best-effort teardown diagnostics.
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test("best-effort teardown: a destroyView throw for one removed tab still destroys+forgets the rest and completes", () => {
    // A deletable, active space (not the last one) with three open tabs, so
    // store.deleteSpace returns [t1, t2, t3] and wasActive is true.
    const work = runtime.store.createSpace("Work");
    const t1 = runtime.store.createInSpace(work.id, { url: "https://a.test" });
    const t2 = runtime.store.createInSpace(work.id, { url: "https://b.test" });
    const t3 = runtime.store.createInSpace(work.id, { url: "https://c.test" });
    runtime.store.setActiveSpace(work.id);

    // One removed tab's destroyView throws; the loop must not abort.
    h.destroyView.mockImplementation((id: string) => {
      if (id === t2.id) {
        throw new Error("destroy boom");
      }
    });

    expect(() => deleteSpace(work.id)).not.toThrow();

    for (const id of [t1.id, t2.id, t3.id]) {
      // destroyView attempted for every removed tab (including the thrower)...
      expect(h.destroyView).toHaveBeenCalledWith(id);
      // ...and forgetTab still runs for every removed tab, because the two calls
      // are wrapped in SEPARATE try/catch blocks (t2's destroyView throw does not
      // skip its forgetTab).
      expect(h.forgetTab).toHaveBeenCalledWith(id);
    }

    // Logged exactly once, for the throwing tab, with its id in the message.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain(t2.id);

    // The function ran to completion: the deleted space was active, so the layout
    // reconcile and the state broadcast both fired.
    expect(h.reconcileAndApply).toHaveBeenCalledTimes(1);
    expect(h.broadcast).toHaveBeenCalledTimes(1);
  });

  test("best-effort teardown: a forgetTab throw for one removed tab still forgets the rest and completes", () => {
    // Same three-open-tab active space, but this time the OTHER best-effort call
    // (forgetTab) throws, pinning its own try/catch — without it, deleteSpace
    // would abort mid-loop.
    const work = runtime.store.createSpace("Work");
    const t1 = runtime.store.createInSpace(work.id, { url: "https://a.test" });
    const t2 = runtime.store.createInSpace(work.id, { url: "https://b.test" });
    const t3 = runtime.store.createInSpace(work.id, { url: "https://c.test" });
    runtime.store.setActiveSpace(work.id);

    // One removed tab's forgetTab throws; destroyView never throws here.
    h.forgetTab.mockImplementation((id: string) => {
      if (id === t2.id) {
        throw new Error("forget boom");
      }
    });

    expect(() => deleteSpace(work.id)).not.toThrow();

    for (const id of [t1.id, t2.id, t3.id]) {
      // destroyView ran for every removed tab (it precedes forgetTab and does not
      // throw in this case)...
      expect(h.destroyView).toHaveBeenCalledWith(id);
      // ...and forgetTab was attempted for every removed tab, including the
      // thrower, so a forgetTab failure does not abort the loop.
      expect(h.forgetTab).toHaveBeenCalledWith(id);
    }

    // Logged exactly once, for the throwing tab, with its id in the message.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain(t2.id);

    // The function still ran to completion despite the forgetTab failure.
    expect(h.reconcileAndApply).toHaveBeenCalledTimes(1);
    expect(h.broadcast).toHaveBeenCalledTimes(1);
  });
});
