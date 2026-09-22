import { beforeEach, describe, expect, test, vi } from "vitest";

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

import { SpaceStore } from "@zeo/core";
import { runtime } from "./state.js";
import { createProfileAndAssign, createSpaceAndActivate } from "./spaces.js";

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
