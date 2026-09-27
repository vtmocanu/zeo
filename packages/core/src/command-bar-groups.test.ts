import { describe, expect, test } from "vitest";
import { groupSuggestions, suggestionGroups, suggestionRowView } from "./command-bar-groups.js";
import { suggest } from "./suggest.js";
import type { Suggestion, SuggestCatalog, SuggestOptions } from "./suggest.js";

/** Builds a catalog, defaulting each source to empty so a test names only what it needs. */
function catalog(partial: Partial<SuggestCatalog>): SuggestCatalog {
  return {
    spaces: partial.spaces ?? [],
    tabs: partial.tabs ?? [],
    archived: partial.archived ?? [],
    commands: partial.commands ?? [],
    history: partial.history ?? [],
    downloads: partial.downloads ?? [],
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
    searchEngine: partial.searchEngine ?? "duckduckgo",
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

/** A minimal history catalog entry with sensible defaults. */
function historyEntry(
  over: Partial<SuggestCatalog["history"][number]> & { url: string },
): SuggestCatalog["history"][number] {
  return {
    title: "",
    visitCount: 1,
    lastVisitedAt: 0,
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

/** A minimal download catalog entry with sensible defaults. */
function downloadEntry(
  over: Partial<SuggestCatalog["downloads"][number]> & { id: string },
): SuggestCatalog["downloads"][number] {
  return {
    url: "https://example.test/file.bin",
    filename: "file.bin",
    path: "/downloads/file.bin",
    totalBytes: 0,
    receivedBytes: 0,
    state: "progressing",
    startedAt: 0,
    completedAt: null,
    spaceId: null,
    ...over,
  };
}

const searchRow: Suggestion = { kind: "search", url: "https://ddg.test/?q=x", label: "Search" };
const historyRow: Suggestion = { kind: "history", url: "https://h.test/", title: "History row", visitCount: 1, lastVisitedAt: 0 };
const tabRow: Suggestion = { kind: "tab", tabId: "t1", spaceId: "s1", title: "Tab row", url: "https://t.test/", spaceName: "Personal" };
const commandRow: Suggestion = { kind: "command", id: "tab.new", title: "Command row", accelerator: null };
const spaceRow: Suggestion = { kind: "space", spaceId: "sp1", name: "Space row" };
const archivedRow: Suggestion = { kind: "archived-tab", tabId: "a1", spaceId: "s1", title: "Archived row", url: "https://a.test/", spaceName: "Personal" };

describe("groupSuggestions", () => {
  test("stably partitions a mixed-kind list into canonical group order", () => {
    const rows = groupSuggestions([searchRow, historyRow, tabRow, commandRow, spaceRow, archivedRow]);
    expect(rows).toEqual([searchRow, tabRow, archivedRow, spaceRow, historyRow, commandRow]);
  });

  test("suggestionGroups of the grouped result has canonical ids and starts", () => {
    const rows = groupSuggestions([searchRow, historyRow, tabRow, commandRow, spaceRow, archivedRow]);
    const groups = suggestionGroups(rows);
    expect(groups.map((g) => g.id)).toEqual(["go", "tabs", "spaces", "history", "commands"]);
    expect(groups.map((g) => g.start)).toEqual([0, 1, 3, 4, 5]);
  });

  test("an empty list groups to an empty list", () => {
    expect(groupSuggestions([])).toEqual([]);
    expect(suggestionGroups([])).toEqual([]);
  });

  test("keeps same-group rows in their input's relative order", () => {
    const tab1: Suggestion = { ...tabRow, tabId: "1" };
    const tab2: Suggestion = { ...tabRow, tabId: "2" };
    const tab3: Suggestion = { ...tabRow, tabId: "3" };
    const h1: Suggestion = { ...historyRow, title: "h1" };
    const h2: Suggestion = { ...historyRow, title: "h2" };
    const input: Suggestion[] = [h1, tab1, h2, tab2, tab3];
    const rows = groupSuggestions(input);
    expect(rows.filter((r) => r.kind === "tab")).toEqual([tab1, tab2, tab3]);
    expect(rows.filter((r) => r.kind === "history")).toEqual([h1, h2]);
    expect(rows).toHaveLength(input.length);
    expect(input).toEqual([h1, tab1, h2, tab2, tab3]);
  });

  test("holds exactly suggest()'s rows for a fixture catalog, row 0 still at index 0", () => {
    const fixture = catalog({
      spaces: [
        { id: "s1", name: "Personal", active: true },
        { id: "s2", name: "Docs Space", active: false },
      ],
      tabs: [tab({ tabId: "t1", title: "Docs tab", url: "https://docs.test/", spaceId: "s1" })],
      archived: [archivedTab({ tabId: "a1", title: "Docs archive", url: "https://archive.test/" })],
      commands: [command({ id: "tab.new", title: "Docs command", keywords: ["docs"] })],
      history: [historyEntry({ url: "https://hist.test/", title: "Docs history" })],
    });
    const rows = suggest("docs", fixture, options());
    const grouped = groupSuggestions(rows);
    expect(grouped).toHaveLength(rows.length);
    expect(grouped[0]).toEqual(rows[0]);
    const byJson = (list: Suggestion[]) => list.map((r) => JSON.stringify(r)).sort();
    expect(byJson(grouped)).toEqual(byJson(rows));
  });

  test("leaves single-kind mode results (commands, history, promote, split, downloads) unchanged", () => {
    const fixture = catalog({
      spaces: [{ id: "s1", name: "Personal", active: true }],
      tabs: [
        tab({ tabId: "t1", title: "First", url: "https://one.test/", spaceId: "s1", lastActiveAt: 5 }),
        tab({ tabId: "t2", title: "Second", url: "https://two.test/", spaceId: "s1", lastActiveAt: 1 }),
      ],
      commands: [
        command({ id: "tab.new", title: "New Tab" }),
        command({ id: "tab.close", title: "Close Tab" }),
      ],
      history: [
        historyEntry({ url: "https://a.test/", title: "A" }),
        historyEntry({ url: "https://b.test/", title: "B" }),
      ],
      downloads: [
        downloadEntry({ id: "d1", filename: "a.bin" }),
        downloadEntry({ id: "d2", filename: "b.bin" }),
      ],
    });

    for (const mode of ["commands", "history", "promote", "split", "downloads"] as const) {
      const rows = suggest("", fixture, options({ mode }));
      expect(groupSuggestions(rows)).toEqual(rows);
    }
  });
});

describe("suggestionRowView", () => {
  test("navigate and search rows show label with no secondary", () => {
    const navigate: Suggestion = { kind: "navigate", url: "https://x.test/", label: "https://x.test/" };
    expect(suggestionRowView(navigate, "navigate", false)).toEqual({
      icon: "arrow",
      primary: "https://x.test/",
      secondary: "",
      hint: "",
      tone: "default",
    });
    const search: Suggestion = { kind: "search", url: "https://ddg.test/?q=x", label: "Search x" };
    expect(suggestionRowView(search, "navigate", false)).toEqual({
      icon: "search",
      primary: "Search x",
      secondary: "",
      hint: "",
      tone: "default",
    });
  });

  test("tab shows the url host as secondary, falling back to the raw url", () => {
    const tabSuggestion: Suggestion = tabRow.kind === "tab" ? { ...tabRow, url: "https://host.test/path" } : tabRow;
    expect(suggestionRowView(tabSuggestion, "navigate", false)).toEqual({
      icon: "globe",
      primary: "Tab row",
      secondary: "host.test",
      hint: "",
      tone: "default",
    });

    const badUrl: Suggestion = { ...tabRow, url: "not a url" };
    expect(suggestionRowView(badUrl, "navigate", false).secondary).toBe("not a url");
  });

  test("archived-tab shows 'Archived · <spaceName>' as secondary", () => {
    expect(suggestionRowView(archivedRow, "navigate", false)).toEqual({
      icon: "archive",
      primary: "Archived row",
      secondary: "Archived · Personal",
      hint: "",
      tone: "default",
    });
  });

  test("space shows the name with no secondary", () => {
    expect(suggestionRowView(spaceRow, "navigate", false)).toEqual({
      icon: "grid",
      primary: "Space row",
      secondary: "",
      hint: "",
      tone: "default",
    });
  });

  test("history shows the url host, and the delete hint only when selected in history mode", () => {
    const row: Suggestion = { ...historyRow, url: "https://h.test/page" };
    expect(suggestionRowView(row, "navigate", false)).toEqual({
      icon: "history",
      primary: "History row",
      secondary: "h.test",
      hint: "",
      tone: "default",
    });
    expect(suggestionRowView(row, "history", false).hint).toBe("");
    expect(suggestionRowView(row, "navigate", true).hint).toBe("");
    expect(suggestionRowView(row, "history", true).hint).toBe("⌘⌫ Delete");
  });

  test("command shows the formatted accelerator as hint, empty when there is none", () => {
    const pin: Suggestion = { kind: "command", id: "tab.pin", title: "Pin Tab", accelerator: "CmdOrCtrl+Shift+P" };
    expect(suggestionRowView(pin, "commands", false)).toEqual({
      icon: "bolt",
      primary: "Pin Tab",
      secondary: "",
      hint: "⌘⇧P",
      tone: "default",
    });
    const rename: Suggestion = { kind: "command", id: "space.rename", title: "Rename Space", accelerator: null };
    expect(suggestionRowView(rename, "commands", false).hint).toBe("");
  });

  test("download shows filename/detail, and the action hint only when selected in downloads mode", () => {
    const row: Suggestion = { kind: "download", id: "d1", filename: "report.bin", detail: "4.0 MB · Completed", state: "completed" };
    expect(suggestionRowView(row, "navigate", false)).toEqual({
      icon: "download",
      primary: "report.bin",
      secondary: "4.0 MB · Completed",
      hint: "",
      tone: "default",
    });
    expect(suggestionRowView(row, "downloads", false).hint).toBe("");
    expect(suggestionRowView(row, "downloads", true).hint).toBe("↵ Open · ⌘↵ Reveal · ⌘⌫ Remove");
  });

  test("interrupted and cancelled downloads are danger toned, completed is default", () => {
    const base = { kind: "download", id: "d1", filename: "f", detail: "" } as const;
    expect(suggestionRowView({ ...base, state: "interrupted" }, "downloads", false).tone).toBe("danger");
    expect(suggestionRowView({ ...base, state: "cancelled" }, "downloads", false).tone).toBe("danger");
    expect(suggestionRowView({ ...base, state: "completed" }, "downloads", false).tone).toBe("default");
  });
});
