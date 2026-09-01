import { describe, expect, test } from "vitest";
import { buildSpaceContextMenu } from "./space-menu.js";
import type { SpaceContextMenuInput } from "./space-menu.js";
import type { Profile } from "./profile.js";

/** Builds a minimal Profile literal with just the fields the menu reads. */
function profile(id: string, name: string): Profile {
  return { id, name, createdAt: 0 };
}

/** Builds a menu input with sensible defaults each test can override. */
function input(overrides: Partial<SpaceContextMenuInput> = {}): SpaceContextMenuInput {
  return {
    spaceId: "s1",
    profiles: [profile("default", "Default")],
    tabCount: 0,
    currentProfileId: "default",
    canDelete: true,
    ...overrides,
  };
}

describe("buildSpaceContextMenu", () => {
  test("omits the Delete item for the last remaining space", () => {
    const result = buildSpaceContextMenu(input({ canDelete: false }));
    expect(result.items.find((i) => i.id === "delete")).toBeUndefined();
  });

  test("labels Delete with the tab count when the space owns tabs", () => {
    const result = buildSpaceContextMenu(input({ tabCount: 3 }));
    expect(result.items.find((i) => i.id === "delete")?.label).toBe("Delete (3 tabs)");
    const single = buildSpaceContextMenu(input({ tabCount: 1 }));
    expect(single.items.find((i) => i.id === "delete")?.label).toBe("Delete (1 tab)");
  });

  test("labels Delete plainly when the space owns no tabs", () => {
    const result = buildSpaceContextMenu(input({ tabCount: 0 }));
    expect(result.items.find((i) => i.id === "delete")?.label).toBe("Delete");
  });

  test("marks the current profile checked, preserves order, ends with New profile", () => {
    const result = buildSpaceContextMenu(
      input({
        profiles: [profile("default", "Default"), profile("work", "Work")],
        currentProfileId: "work",
      }),
    );
    const submenu = result.items.find((i) => i.id === "profile")?.submenu ?? [];
    expect(submenu.map((i) => i.id)).toEqual(["profile:default", "profile:work", "new-profile"]);
    expect(submenu[0]?.checked).toBe(false);
    expect(submenu[1]?.checked).toBe(true);
    expect(submenu[2]).toEqual({ id: "new-profile", label: "New profile…", enabled: true });
  });

  test("orders items rename, delete, profile", () => {
    const result = buildSpaceContextMenu(input({ tabCount: 1 }));
    expect(result.items.map((i) => i.id)).toEqual(["rename", "delete", "profile"]);
  });
});
