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
  "bar.open-commands",
  "blocking.toggle",
  "blocking.allowSite",
  "blocking.disallowSite",
  "settings.open",
  "settings.close",
  "history.open",
  "history.clear",
  "settings.openGeneral",
  "settings.openProfiles",
  "settings.openHistory",
];

/**
 * Builds a command context, defaulting to no active tab, a single space, and a
 * closed settings view.
 */
function context(partial: Partial<CommandContext> = {}): CommandContext {
  return {
    activeTab: partial.activeTab === undefined ? null : partial.activeTab,
    spaceCount: partial.spaceCount ?? 1,
    settingsOpen: partial.settingsOpen ?? false,
  };
}

/**
 * An active-tab descriptor with sensible defaults (unpinned, no history, an
 * http(s) site host that is not allowlisted).
 */
function activeTab(
  over: Partial<NonNullable<CommandContext["activeTab"]>> = {},
): NonNullable<CommandContext["activeTab"]> {
  return {
    pinned: false,
    canGoBack: false,
    canGoForward: false,
    siteHost: "example.com",
    siteAllowlisted: false,
    ...over,
  };
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
  test("tab.new, space.new, space.rename, bar.open-location, bar.open-commands, blocking.toggle are enabled with no active tab", () => {
    for (const id of ["tab.new", "space.new", "space.rename", "bar.open-location", "bar.open-commands", "blocking.toggle"] as const) {
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

describe("history commands", () => {
  test("history.open is a view command with the Cmd+Y accelerator", () => {
    const entry = COMMANDS.find((c) => c.id === "history.open");
    expect(entry).toBeDefined();
    expect(entry?.menu).toBe("view");
    expect(entry?.accelerator).toBe("CmdOrCtrl+Y");
  });

  test("history.clear is a view command with no accelerator", () => {
    const entry = COMMANDS.find((c) => c.id === "history.clear");
    expect(entry).toBeDefined();
    expect(entry?.menu).toBe("view");
    expect(entry?.accelerator).toBeNull();
  });

  test("both history commands are always enabled regardless of context", () => {
    for (const id of ["history.open", "history.clear"] as const) {
      expect(isCommandEnabled(id, context({ activeTab: null, spaceCount: 1 }))).toBe(true);
      expect(isCommandEnabled(id, context({ activeTab: activeTab(), spaceCount: 3 }))).toBe(true);
    }
  });
});

describe("settings section-open commands", () => {
  const sectionIds = [
    "settings.openGeneral",
    "settings.openProfiles",
    "settings.openHistory",
  ] as const;

  test("each is registered exactly once with no accelerator and no menu", () => {
    for (const id of sectionIds) {
      const matches = COMMANDS.filter((c) => c.id === id);
      expect(matches).toHaveLength(1);
      expect(matches[0]?.accelerator).toBeNull();
      expect(matches[0]?.menu).toBeNull();
    }
  });

  test("each is always enabled, including with no active tab", () => {
    for (const id of sectionIds) {
      expect(isCommandEnabled(id, context({ activeTab: null, spaceCount: 1 }))).toBe(true);
      expect(isCommandEnabled(id, context({ activeTab: activeTab(), spaceCount: 3 }))).toBe(true);
    }
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

describe("isCommandEnabled — allowlist and settings commands", () => {
  test("blocking.allowSite needs an active tab with a non-allowlisted http(s) host", () => {
    expect(
      isCommandEnabled("blocking.allowSite", context({ activeTab: activeTab({ siteHost: "example.com", siteAllowlisted: false }) })),
    ).toBe(true);
    expect(
      isCommandEnabled("blocking.allowSite", context({ activeTab: activeTab({ siteHost: "example.com", siteAllowlisted: true }) })),
    ).toBe(false);
    expect(
      isCommandEnabled("blocking.allowSite", context({ activeTab: activeTab({ siteHost: null }) })),
    ).toBe(false);
    expect(
      isCommandEnabled("blocking.allowSite", context({ activeTab: null })),
    ).toBe(false);
  });

  test("blocking.disallowSite needs an active tab whose site is allowlisted", () => {
    expect(
      isCommandEnabled("blocking.disallowSite", context({ activeTab: activeTab({ siteAllowlisted: true }) })),
    ).toBe(true);
    expect(
      isCommandEnabled("blocking.disallowSite", context({ activeTab: activeTab({ siteAllowlisted: false }) })),
    ).toBe(false);
    expect(
      isCommandEnabled("blocking.disallowSite", context({ activeTab: null })),
    ).toBe(false);
  });

  test("settings.open is always enabled", () => {
    expect(isCommandEnabled("settings.open", context({ activeTab: null, settingsOpen: false }))).toBe(true);
    expect(isCommandEnabled("settings.open", context({ activeTab: activeTab(), settingsOpen: true }))).toBe(true);
  });

  test("settings.close needs the settings view open", () => {
    expect(isCommandEnabled("settings.close", context({ settingsOpen: true }))).toBe(true);
    expect(isCommandEnabled("settings.close", context({ settingsOpen: false }))).toBe(false);
  });
});

describe("isCommandEnabled — no active tab yields exactly the expected set", () => {
  function enabledIds(ctx: CommandContext): CommandId[] {
    return ALL_IDS.filter((id) => isCommandEnabled(id, ctx)).sort();
  }

  test("with one space: only the always-enabled commands", () => {
    expect(enabledIds(context({ activeTab: null, spaceCount: 1 }))).toEqual(
      ["bar.open-commands", "bar.open-location", "blocking.toggle", "history.clear", "history.open", "settings.open", "settings.openGeneral", "settings.openHistory", "settings.openProfiles", "space.new", "space.rename", "tab.new"].sort(),
    );
  });

  test("with more than one space: the always-enabled commands plus space.delete", () => {
    expect(enabledIds(context({ activeTab: null, spaceCount: 2 }))).toEqual(
      ["bar.open-commands", "bar.open-location", "blocking.toggle", "history.clear", "history.open", "settings.open", "settings.openGeneral", "settings.openHistory", "settings.openProfiles", "space.delete", "space.new", "space.rename", "tab.new"].sort(),
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
