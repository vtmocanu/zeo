import { describe, expect, test } from "vitest";
import {
  COMMANDS,
  isCommandEnabled,
  menuEntries,
  formatAccelerator,
} from "./commands.js";
import type { CommandId, CommandContext } from "./commands.js";

const ALL_IDS: CommandId[] = [
  "tab.new",
  "tab.close",
  "tab.pin",
  "tab.unpin",
  "tab.archive",
  "tab.copy-url",
  "tab.reload",
  "tab.back",
  "tab.forward",
  "space.new",
  "space.rename",
  "space.delete",
  "bar.open-location",
  "blocking.toggle",
];

/** Builds a command context, defaulting to no active tab and a single space. */
function context(partial: Partial<CommandContext> = {}): CommandContext {
  return {
    activeTab: partial.activeTab === undefined ? null : partial.activeTab,
    spaceCount: partial.spaceCount ?? 1,
  };
}

/** An active-tab descriptor with sensible defaults (unpinned, no history). */
function activeTab(
  over: Partial<NonNullable<CommandContext["activeTab"]>> = {},
): NonNullable<CommandContext["activeTab"]> {
  return { pinned: false, canGoBack: false, canGoForward: false, ...over };
}

describe("COMMANDS registry", () => {
  test("every CommandId appears exactly once and length matches the id count", () => {
    expect(COMMANDS).toHaveLength(ALL_IDS.length);
    for (const id of ALL_IDS) {
      expect(COMMANDS.filter((c) => c.id === id)).toHaveLength(1);
    }
    // No stray ids beyond the known set.
    expect(COMMANDS.map((c) => c.id).sort()).toEqual([...ALL_IDS].sort());
  });

  test("accelerators are unique across COMMANDS except the pin/unpin pair", () => {
    const accelerators = COMMANDS.map((c) => c.accelerator).filter(
      (a): a is string => a !== null,
    );
    const counts = new Map<string, number>();
    for (const a of accelerators) {
      counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    for (const [accelerator, count] of counts) {
      if (accelerator === "CmdOrCtrl+Shift+P") {
        expect(count).toBe(2);
      } else {
        expect(count).toBe(1);
      }
    }
    // The shared accelerator is exactly tab.pin and tab.unpin.
    expect(
      COMMANDS.filter((c) => c.accelerator === "CmdOrCtrl+Shift+P").map((c) => c.id).sort(),
    ).toEqual(["tab.pin", "tab.unpin"]);
  });
});

describe("isCommandEnabled — always-enabled commands", () => {
  test("tab.new, space.new, space.rename, bar.open-location, blocking.toggle are enabled with no active tab", () => {
    for (const id of ["tab.new", "space.new", "space.rename", "bar.open-location", "blocking.toggle"] as const) {
      expect(isCommandEnabled(id, context({ activeTab: null }))).toBe(true);
    }
  });
});

describe("blocking.toggle command", () => {
  test("is registered in the view menu with no accelerator", () => {
    const entry = COMMANDS.find((c) => c.id === "blocking.toggle");
    expect(entry).toBeDefined();
    expect(entry?.menu).toBe("view");
    expect(entry?.accelerator).toBeNull();
  });

  test("is always enabled regardless of context", () => {
    expect(isCommandEnabled("blocking.toggle", context({ activeTab: null, spaceCount: 1 }))).toBe(true);
    expect(isCommandEnabled("blocking.toggle", context({ activeTab: activeTab(), spaceCount: 3 }))).toBe(true);
  });
});

describe("isCommandEnabled — active-tab-gated commands", () => {
  test("tab.close needs an active tab", () => {
    expect(isCommandEnabled("tab.close", context({ activeTab: activeTab() }))).toBe(true);
    expect(isCommandEnabled("tab.close", context({ activeTab: null }))).toBe(false);
  });

  test("tab.copy-url needs an active tab", () => {
    expect(isCommandEnabled("tab.copy-url", context({ activeTab: activeTab() }))).toBe(true);
    expect(isCommandEnabled("tab.copy-url", context({ activeTab: null }))).toBe(false);
  });

  test("tab.reload needs an active tab", () => {
    expect(isCommandEnabled("tab.reload", context({ activeTab: activeTab() }))).toBe(true);
    expect(isCommandEnabled("tab.reload", context({ activeTab: null }))).toBe(false);
  });

  test("tab.pin needs an unpinned active tab", () => {
    expect(isCommandEnabled("tab.pin", context({ activeTab: activeTab({ pinned: false }) }))).toBe(true);
    expect(isCommandEnabled("tab.pin", context({ activeTab: activeTab({ pinned: true }) }))).toBe(false);
    expect(isCommandEnabled("tab.pin", context({ activeTab: null }))).toBe(false);
  });

  test("tab.unpin needs a pinned active tab", () => {
    expect(isCommandEnabled("tab.unpin", context({ activeTab: activeTab({ pinned: true }) }))).toBe(true);
    expect(isCommandEnabled("tab.unpin", context({ activeTab: activeTab({ pinned: false }) }))).toBe(false);
    expect(isCommandEnabled("tab.unpin", context({ activeTab: null }))).toBe(false);
  });

  test("tab.archive needs an unpinned active tab", () => {
    expect(isCommandEnabled("tab.archive", context({ activeTab: activeTab({ pinned: false }) }))).toBe(true);
    expect(isCommandEnabled("tab.archive", context({ activeTab: activeTab({ pinned: true }) }))).toBe(false);
    expect(isCommandEnabled("tab.archive", context({ activeTab: null }))).toBe(false);
  });

  test("tab.back needs canGoBack", () => {
    expect(isCommandEnabled("tab.back", context({ activeTab: activeTab({ canGoBack: true }) }))).toBe(true);
    expect(isCommandEnabled("tab.back", context({ activeTab: activeTab({ canGoBack: false }) }))).toBe(false);
    expect(isCommandEnabled("tab.back", context({ activeTab: null }))).toBe(false);
  });

  test("tab.forward needs canGoForward", () => {
    expect(isCommandEnabled("tab.forward", context({ activeTab: activeTab({ canGoForward: true }) }))).toBe(true);
    expect(isCommandEnabled("tab.forward", context({ activeTab: activeTab({ canGoForward: false }) }))).toBe(false);
    expect(isCommandEnabled("tab.forward", context({ activeTab: null }))).toBe(false);
  });
});

describe("isCommandEnabled — space.delete", () => {
  test("needs more than one space", () => {
    expect(isCommandEnabled("space.delete", context({ spaceCount: 2 }))).toBe(true);
    expect(isCommandEnabled("space.delete", context({ spaceCount: 1 }))).toBe(false);
  });
});

describe("isCommandEnabled — no active tab yields exactly the expected set", () => {
  function enabledIds(ctx: CommandContext): CommandId[] {
    return ALL_IDS.filter((id) => isCommandEnabled(id, ctx)).sort();
  }

  test("with one space: only the five always-enabled commands", () => {
    expect(enabledIds(context({ activeTab: null, spaceCount: 1 }))).toEqual(
      ["bar.open-location", "blocking.toggle", "space.new", "space.rename", "tab.new"].sort(),
    );
  });

  test("with more than one space: the five plus space.delete", () => {
    expect(enabledIds(context({ activeTab: null, spaceCount: 2 }))).toEqual(
      ["bar.open-location", "blocking.toggle", "space.delete", "space.new", "space.rename", "tab.new"].sort(),
    );
  });
});

describe("menuEntries — pin/unpin grouping", () => {
  const pinPair = COMMANDS.filter((c) => c.id === "tab.pin" || c.id === "tab.unpin");

  test("active + unpinned tab yields one enabled 'Pin Tab' entry", () => {
    const entries = menuEntries(pinPair, context({ activeTab: activeTab({ pinned: false }) }));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "tab.pin", label: "Pin Tab", enabled: true });
  });

  test("active + pinned tab yields one enabled 'Unpin Tab' entry", () => {
    const entries = menuEntries(pinPair, context({ activeTab: activeTab({ pinned: true }) }));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "tab.unpin", label: "Unpin Tab", enabled: true });
  });

  test("no active tab yields one disabled 'Pin Tab' entry", () => {
    const entries = menuEntries(pinPair, context({ activeTab: null }));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "tab.pin", label: "Pin Tab", enabled: false });
  });

  test("the full Tabs menu has no duplicate accelerators", () => {
    const tabsCommands = COMMANDS.filter((c) => c.menu === "tabs");
    const entries = menuEntries(tabsCommands, context({ activeTab: activeTab() }));
    const accelerators = entries
      .map((e) => e.accelerator)
      .filter((a): a is string => a !== null);
    expect(new Set(accelerators).size).toBe(accelerators.length);
  });
});

describe("formatAccelerator", () => {
  test("maps modifiers to macOS glyphs and keeps the final key", () => {
    expect(formatAccelerator("CmdOrCtrl+Shift+P")).toBe("⌘⇧P");
    expect(formatAccelerator("CmdOrCtrl+T")).toBe("⌘T");
    expect(formatAccelerator("CmdOrCtrl+[")).toBe("⌘[");
  });
});
