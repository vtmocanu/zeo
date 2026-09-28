import { describe, expect, test } from "vitest";
import { reselectIndex, resolveAcceptIndex, suggestionKey } from "./command-bar.js";
import type { Suggestion } from "./suggest.js";

function tab(tabId: string, title = tabId): Suggestion {
  return {
    kind: "tab",
    tabId,
    spaceId: "s1",
    title,
    url: `https://${tabId}.test/`,
    spaceName: "S",
  };
}

const search: Suggestion = { kind: "search", url: "https://s.test/?q=a", label: "a" };

describe("suggestionKey", () => {
  test("ignores titles and labels", () => {
    expect(suggestionKey(tab("a", "Loading"))).toBe(suggestionKey(tab("a", "Loaded")));
    const navigate: Suggestion = { kind: "navigate", url: "https://a.test/", label: "a.test" };
    expect(suggestionKey(navigate)).toBe(
      suggestionKey({ ...navigate, url: "https://b.test/", label: "b.test" }),
    );
    expect(suggestionKey(search)).toBe(
      suggestionKey({ ...search, label: "b", url: "https://s.test/?q=b" }),
    );
  });

  test("distinguishes kinds and ids", () => {
    const keys = [
      tab("a"),
      tab("b"),
      { kind: "archived-tab", tabId: "a", spaceId: "s1", title: "", url: "", spaceName: "" },
      { kind: "space", spaceId: "a", name: "A" },
      { kind: "command", id: "tab.new", title: "New Tab", accelerator: null },
      { kind: "history", url: "https://a.test/", title: "", visitCount: 1, lastVisitedAt: 0 },
      { kind: "download", id: "a", filename: "a", detail: "", state: "completed" },
      { kind: "navigate", url: "https://a.test/", label: "" },
      search,
    ] satisfies Suggestion[];
    expect(new Set(keys.map(suggestionKey)).size).toBe(keys.length);
  });
});

describe("reselectIndex", () => {
  test("keeps the selected row when only its title changed", () => {
    expect(reselectIndex([tab("a"), tab("b")], 1, [tab("a"), tab("b", "New title")])).toBe(1);
  });

  test("follows the selected row to its new position", () => {
    expect(reselectIndex([tab("a"), tab("b"), tab("c")], 1, [tab("c"), tab("a"), tab("b")])).toBe(
      2,
    );
  });

  test("falls back to row 0 when the selected row is gone", () => {
    expect(reselectIndex([tab("a"), tab("b")], 1, [tab("a"), tab("c")])).toBe(0);
  });

  test("falls back to row 0 with no previous selection", () => {
    expect(reselectIndex([], -1, [tab("a")])).toBe(0);
  });

  test("returns -1 for an empty list", () => {
    expect(reselectIndex([tab("a")], 0, [])).toBe(-1);
  });

  test("keeps the text-action row selected", () => {
    expect(reselectIndex([search, tab("a")], 0, [{ ...search, label: "b" }, tab("a")])).toBe(0);
  });
});

describe("resolveAcceptIndex", () => {
  const current = { revision: 5, suggestions: [tab("c"), tab("a"), tab("b")] };
  const previous = [{ revision: 4, suggestions: [tab("a"), tab("b")] }];

  test("uses the index as-is against the current revision", () => {
    expect(resolveAcceptIndex(2, 5, current, previous)).toBe(2);
  });

  test("rejects an out-of-range index against the current revision", () => {
    expect(resolveAcceptIndex(3, 5, current, previous)).toBeNull();
    expect(resolveAcceptIndex(-1, 5, current, previous)).toBeNull();
  });

  test("remaps a click on the previous list to the row's new index", () => {
    expect(resolveAcceptIndex(1, 4, current, previous)).toBe(2);
  });

  test("rejects a previous-list click whose row is gone", () => {
    expect(resolveAcceptIndex(0, 4, { revision: 5, suggestions: [tab("b")] }, previous)).toBeNull();
  });

  test("remaps a click on an older background list, not only the latest", () => {
    const older = [{ revision: 3, suggestions: [tab("b"), tab("a")] }, ...previous];
    expect(resolveAcceptIndex(0, 3, current, older)).toBe(2);
  });

  test("remaps a click on the text-action row", () => {
    const next = { revision: 5, suggestions: [{ ...search, label: "b" }, tab("a")] };
    expect(resolveAcceptIndex(0, 4, next, [{ revision: 4, suggestions: [search] }])).toBe(0);
  });

  test("rejects a previous-list click with an out-of-range index", () => {
    expect(resolveAcceptIndex(2, 4, current, previous)).toBeNull();
  });

  test("rejects any older revision, or a stale click with no previous list", () => {
    expect(resolveAcceptIndex(0, 3, current, previous)).toBeNull();
    expect(resolveAcceptIndex(0, 4, current, [])).toBeNull();
  });
});
