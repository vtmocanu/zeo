import { describe, expect, test } from "vitest";
import { suggest, nextSelectedIndex } from "./suggest.js";
import type { SuggestCatalog, SuggestOptions } from "./suggest.js";

/** Builds a catalog, defaulting each source to empty so a test names only what it needs. */
function catalog(partial: Partial<SuggestCatalog>): SuggestCatalog {
  return {
    spaces: partial.spaces ?? [],
    tabs: partial.tabs ?? [],
    archived: partial.archived ?? [],
    commands: partial.commands ?? [],
  };
}

/** A minimal command catalog entry with sensible defaults (enabled). */
function command(
  over: Partial<SuggestCatalog["commands"][number]> & { id: SuggestCatalog["commands"][number]["id"] },
): SuggestCatalog["commands"][number] {
  return {
    title: "",
    keywords: [],
    accelerator: null,
    enabled: true,
    ...over,
  };
}

/** Builds suggest options, defaulting to navigate mode with no active tab. */
function options(partial: Partial<SuggestOptions> = {}): SuggestOptions {
  return {
    mode: partial.mode ?? "navigate",
    activeTabId: partial.activeTabId ?? null,
  };
}

/** A minimal open-tab catalog entry with sensible defaults. */
function tab(
  over: Partial<SuggestCatalog["tabs"][number]> & { tabId: string },
): SuggestCatalog["tabs"][number] {
  return {
    spaceId: "s1",
    title: "",
    url: "https://example.test/",
    spaceName: "Personal",
    lastActiveAt: 0,
    ...over,
  };
}

/** A minimal archived-tab catalog entry with sensible defaults. */
function archivedTab(
  over: Partial<SuggestCatalog["archived"][number]> & { tabId: string },
): SuggestCatalog["archived"][number] {
  return {
    spaceId: "s1",
    title: "",
    url: "https://example.test/",
    spaceName: "Personal",
    archivedAt: 0,
    ...over,
  };
}

describe("suggest — row 0 text action", () => {
  test("a URL query yields a navigate row 0 whose label is the canonical url", () => {
    const rows = suggest("example.com", catalog({}), options());
    expect(rows[0]).toEqual({
      kind: "navigate",
      url: "https://example.com/",
      label: "https://example.com/",
    });
  });

  test("a non-URL query yields a search row 0 with the exact DuckDuckGo label", () => {
    const rows = suggest("  hello world  ", catalog({}), options());
    expect(rows[0]).toEqual({
      kind: "search",
      url: "https://duckduckgo.com/?q=hello%20world",
      label: 'Search DuckDuckGo for "hello world"',
    });
  });
});

describe("suggest — score tiers", () => {
  test("tier 1: a term that is a prefix of the title outranks a later substring", () => {
    const rows = suggest(
      "git",
      catalog({
        tabs: [
          tab({ tabId: "b", title: "My git notes", url: "https://notes.test/" }),
          tab({ tabId: "a", title: "GitHub home", url: "https://github.test/" }),
        ],
      }),
      options(),
    );
    // Prefix-of-title (a) scores tier 1, mid-title (b) tier 2 → a first.
    expect(rows.slice(1).map((r) => (r.kind === "tab" ? r.tabId : ""))).toEqual(["a", "b"]);
  });

  test("tier 1 via url host prefix even when the title does not match on prefix", () => {
    const rows = suggest(
      "acme",
      catalog({
        tabs: [tab({ tabId: "h", title: "Welcome page", url: "https://acme.test/x" })],
      }),
      options(),
    );
    expect(rows[1]).toMatchObject({ kind: "tab", tabId: "h" });
  });

  test("tier 2: a term starting a later word outranks a pure substring", () => {
    const rows = suggest(
      "note",
      catalog({
        tabs: [
          // "note" is a substring inside "footnotes" (tier 3), no word start.
          tab({ tabId: "sub", title: "footnotes archive", url: "https://sub.test/" }),
          // "note" starts the word "notes" (tier 2).
          tab({ tabId: "word", title: "daily notes", url: "https://word.test/" }),
        ],
      }),
      options(),
    );
    expect(rows.slice(1).map((r) => (r.kind === "tab" ? r.tabId : ""))).toEqual(["word", "sub"]);
  });

  test("tier 3: a mid-word substring still matches and ranks last", () => {
    const rows = suggest(
      "oot",
      catalog({ tabs: [tab({ tabId: "m", title: "footnotes", url: "https://m.test/" })] }),
      options(),
    );
    expect(rows[1]).toMatchObject({ kind: "tab", tabId: "m" });
  });

  test("worst-tier rule: a mixed prefix+substring multi-term query scores tier 3", () => {
    const rows = suggest(
      "daily oot",
      catalog({
        tabs: [
          // both terms present; "daily" prefix (1), "oot" mid-word (3) → score 3.
          tab({ tabId: "mixed", title: "daily footnotes", url: "https://mixed.test/", lastActiveAt: 1 }),
          // single-term tier-3 comparison anchor is not needed; assert mixed sorts
          // after a clean tier-1 candidate.
          tab({ tabId: "clean", title: "daily oot log", url: "https://clean.test/", lastActiveAt: 2 }),
        ],
      }),
      options(),
    );
    // "clean": daily(1) + oot as word-start of "oot log" (2) → score 2.
    // "mixed": score 3. So clean before mixed.
    expect(rows.slice(1).map((r) => (r.kind === "tab" ? r.tabId : ""))).toEqual(["clean", "mixed"]);
  });
});

describe("suggest — ordering", () => {
  test("kind order at equal score: open tab, then space, then archived tab", () => {
    const rows = suggest(
      "focus",
      catalog({
        spaces: [{ id: "sp", name: "Focus", active: false }],
        tabs: [tab({ tabId: "open", title: "Focus", url: "https://open.test/" })],
        archived: [archivedTab({ tabId: "arch", title: "Focus", url: "https://arch.test/" })],
      }),
      options(),
    );
    expect(rows.slice(1).map((r) => r.kind)).toEqual(["tab", "space", "archived-tab"]);
  });

  test("active-space tabs sort before other-space tabs at equal score", () => {
    const rows = suggest(
      "docs",
      catalog({
        spaces: [
          { id: "s1", name: "Personal", active: false },
          { id: "s2", name: "Work", active: true },
        ],
        tabs: [
          tab({ tabId: "other", title: "Docs", url: "https://o.test/", spaceId: "s1", lastActiveAt: 100 }),
          tab({ tabId: "active", title: "Docs", url: "https://a.test/", spaceId: "s2", lastActiveAt: 1 }),
        ],
      }),
      options(),
    );
    // Equal score; active-space tab wins despite lower lastActiveAt.
    expect(rows.slice(1).map((r) => (r.kind === "tab" ? r.tabId : ""))).toEqual(["active", "other"]);
  });

  test("recency breaks ties: newer lastActiveAt first among same-kind tabs", () => {
    const rows = suggest(
      "docs",
      catalog({
        tabs: [
          tab({ tabId: "old", title: "Docs", url: "https://o.test/", lastActiveAt: 1 }),
          tab({ tabId: "new", title: "Docs", url: "https://n.test/", lastActiveAt: 9 }),
        ],
      }),
      options(),
    );
    expect(rows.slice(1).map((r) => (r.kind === "tab" ? r.tabId : ""))).toEqual(["new", "old"]);
  });

  test("stable ordering on fully-equal keys falls back to catalog order", () => {
    const rows = suggest(
      "docs",
      catalog({
        tabs: [
          tab({ tabId: "first", title: "Docs", url: "https://one.test/", lastActiveAt: 5 }),
          tab({ tabId: "second", title: "Docs", url: "https://one.test/", lastActiveAt: 5 }),
        ],
      }),
      options(),
    );
    expect(rows.slice(1).map((r) => (r.kind === "tab" ? r.tabId : ""))).toEqual(["first", "second"]);
  });
});

describe("suggest — matching", () => {
  test("multi-term AND: every term must be a substring of the haystack", () => {
    const rows = suggest(
      "meeting notes",
      catalog({
        tabs: [
          tab({ tabId: "both", title: "Meeting notes", url: "https://both.test/" }),
          tab({ tabId: "one", title: "Meeting agenda", url: "https://one.test/" }),
        ],
      }),
      options(),
    );
    expect(rows.slice(1).map((r) => (r.kind === "tab" ? r.tabId : ""))).toEqual(["both"]);
  });

  test("the url contributes to the haystack after its scheme is stripped", () => {
    const rows = suggest(
      "example",
      catalog({ tabs: [tab({ tabId: "u", title: "Homepage", url: "https://example.test/path" })] }),
      options(),
    );
    expect(rows[1]).toMatchObject({ kind: "tab", tabId: "u" });
  });

  test("the active tab is excluded from matches", () => {
    const rows = suggest(
      "docs",
      catalog({
        tabs: [
          tab({ tabId: "active", title: "Docs", url: "https://a.test/" }),
          tab({ tabId: "other", title: "Docs", url: "https://o.test/" }),
        ],
      }),
      options({ activeTabId: "active" }),
    );
    expect(rows.slice(1).map((r) => (r.kind === "tab" ? r.tabId : ""))).toEqual(["other"]);
  });

  test("spaces match on their name", () => {
    const rows = suggest(
      "work",
      catalog({ spaces: [{ id: "s2", name: "Work", active: false }] }),
      options(),
    );
    expect(rows[1]).toEqual({ kind: "space", spaceId: "s2", name: "Work" });
  });
});

describe("suggest — empty query", () => {
  test("navigate mode: no row 0 and an empty list", () => {
    const rows = suggest(
      "   ",
      catalog({ tabs: [tab({ tabId: "x", title: "X", lastActiveAt: 5 })] }),
      options({ mode: "navigate" }),
    );
    expect(rows).toEqual([]);
  });

  test("new-tab mode: recent open tabs, most recent first, active excluded", () => {
    const rows = suggest(
      "",
      catalog({
        tabs: [
          tab({ tabId: "a", title: "A", lastActiveAt: 3 }),
          tab({ tabId: "active", title: "Active", lastActiveAt: 100 }),
          tab({ tabId: "b", title: "B", lastActiveAt: 7 }),
        ],
      }),
      options({ mode: "new-tab", activeTabId: "active" }),
    );
    expect(rows.map((r) => (r.kind === "tab" ? r.tabId : ""))).toEqual(["b", "a"]);
  });

  test("new-tab mode caps the recent list at 8", () => {
    const tabs = Array.from({ length: 12 }, (_, i) =>
      tab({ tabId: `t${i}`, title: `T${i}`, lastActiveAt: i }),
    );
    const rows = suggest("", catalog({ tabs }), options({ mode: "new-tab" }));
    expect(rows).toHaveLength(8);
    // Highest lastActiveAt first: t11 down to t4.
    expect(rows.map((r) => (r.kind === "tab" ? r.tabId : ""))).toEqual([
      "t11",
      "t10",
      "t9",
      "t8",
      "t7",
      "t6",
      "t5",
      "t4",
    ]);
  });
});

describe("suggest — cap on a non-empty query", () => {
  test("at most 8 matches follow row 0", () => {
    const tabs = Array.from({ length: 12 }, (_, i) =>
      tab({ tabId: `t${i}`, title: "Docs", url: `https://d${i}.test/`, lastActiveAt: i }),
    );
    const rows = suggest("docs", catalog({ tabs }), options());
    expect(rows).toHaveLength(9); // row 0 + 8 matches.
    expect(rows[0].kind).toBe("search");
    expect(rows.slice(1)).toHaveLength(8);
  });
});

describe("suggest — command rows", () => {
  test("a command matches on a keyword and surfaces when enabled", () => {
    const rows = suggest(
      "pin",
      catalog({
        // Title deliberately omits "pin" so the query can only match via the
        // keywords — this test fails if keyword matching regresses.
        commands: [command({ id: "tab.pin", title: "Favorite Tab", keywords: ["pin", "tab", "favorite"], accelerator: "CmdOrCtrl+Shift+P" })],
      }),
      options(),
    );
    expect(rows[1]).toEqual({
      kind: "command",
      id: "tab.pin",
      title: "Favorite Tab",
      accelerator: "CmdOrCtrl+Shift+P",
    });
  });

  test("a disabled command never appears in results", () => {
    const rows = suggest(
      "pin",
      catalog({
        commands: [command({ id: "tab.pin", title: "Pin Tab", keywords: ["pin"], enabled: false })],
      }),
      options(),
    );
    expect(rows.slice(1)).toEqual([]);
  });

  test("kind order at equal score: space, then command, then archived tab", () => {
    const rows = suggest(
      "focus",
      catalog({
        spaces: [{ id: "sp", name: "Focus", active: false }],
        commands: [command({ id: "tab.new", title: "Focus", keywords: [] })],
        archived: [archivedTab({ tabId: "arch", title: "Focus", url: "https://arch.test/" })],
      }),
      options(),
    );
    expect(rows.slice(1).map((r) => r.kind)).toEqual(["space", "command", "archived-tab"]);
  });

  test("a command row carries the catalog entry's accelerator, including null", () => {
    const rows = suggest(
      "rename",
      catalog({
        commands: [command({ id: "space.rename", title: "Rename Space", keywords: ["rename", "space"], accelerator: null })],
      }),
      options(),
    );
    expect(rows[1]).toEqual({
      kind: "command",
      id: "space.rename",
      title: "Rename Space",
      accelerator: null,
    });
  });
});

describe("nextSelectedIndex", () => {
  test("an empty list stays at -1 for both directions", () => {
    expect(nextSelectedIndex(-1, 0, 1)).toBe(-1);
    expect(nextSelectedIndex(-1, 0, -1)).toBe(-1);
  });

  test("wraps forward off the end back to 0", () => {
    expect(nextSelectedIndex(2, 3, 1)).toBe(0);
  });

  test("wraps backward off the start to the last row", () => {
    expect(nextSelectedIndex(0, 3, -1)).toBe(2);
  });

  test("moves within bounds without wrapping", () => {
    expect(nextSelectedIndex(0, 3, 1)).toBe(1);
    expect(nextSelectedIndex(2, 3, -1)).toBe(1);
  });
});
