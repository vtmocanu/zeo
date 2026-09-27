import { describe, expect, test } from "vitest";
import {
  sidebarSections,
  clearableTabIds,
  urlPillLabel,
  favoriteGridColumns,
  favoriteInsertIndex,
  belowPinnedClip,
  toReorderIndex,
} from "./sidebar.js";
import type { Tab } from "./tab.js";
import type { TileBox } from "./sidebar.js";

/** A minimal open tab with sensible defaults. */
function tab(over: Partial<Tab> & { id: string }): Tab {
  return {
    url: "https://example.test",
    title: "Example",
    faviconUrl: null,
    createdAt: 0,
    pinned: false,
    lastActiveAt: 0,
    archivedAt: null,
    favoriteId: null,
    ...over,
  };
}

describe("sidebarSections", () => {
  test("partitions pinned / today / favorite, keeping input order", () => {
    const p1 = tab({ id: "p1", pinned: true });
    const t1 = tab({ id: "t1" });
    const f1 = tab({ id: "f1", favoriteId: "fav1" });
    const t2 = tab({ id: "t2" });
    const p2 = tab({ id: "p2", pinned: true });

    expect(sidebarSections([p1, t1, f1, t2, p2])).toEqual({
      pinned: [p1, p2],
      today: [t1, t2],
      favoriteTabs: [f1],
    });
  });

  test("empty input gives empty groups", () => {
    expect(sidebarSections([])).toEqual({ pinned: [], today: [], favoriteTabs: [] });
  });
});

describe("clearableTabIds", () => {
  test("is the ids of the today section only", () => {
    const p1 = tab({ id: "p1", pinned: true });
    const t1 = tab({ id: "t1" });
    const f1 = tab({ id: "f1", favoriteId: "fav1" });
    expect(clearableTabIds([p1, t1, f1])).toEqual(["t1"]);
  });
});

describe("urlPillLabel", () => {
  test("null, empty, about:blank and unparseable give empty", () => {
    expect(urlPillLabel(null)).toBe("");
    expect(urlPillLabel("")).toBe("");
    expect(urlPillLabel("about:blank")).toBe("");
    expect(urlPillLabel("not a url")).toBe("");
  });

  test("http(s) urls give the hostname without leading www or port", () => {
    expect(urlPillLabel("https://www.github.com/x")).toBe("github.com");
    expect(urlPillLabel("http://127.0.0.1:8080/a")).toBe("127.0.0.1");
  });

  test("other schemes give the protocol without the colon", () => {
    expect(urlPillLabel("data:text/html,x")).toBe("data");
    expect(urlPillLabel("file:///tmp/a")).toBe("file");
  });
});

describe("favoriteGridColumns", () => {
  test.each([
    [0, 240, 0],
    [1, 240, 1],
    [7, 240, 4],
    [7, 200, 3],
    [7, 360, 4],
    [2, 200, 2],
  ])("favoriteGridColumns(%i, %i) === %i", (count, width, expected) => {
    expect(favoriteGridColumns(count, width)).toBe(expected);
  });
});

describe("toReorderIndex", () => {
  test("shifts down by one when the slot sits after the current position", () => {
    expect(toReorderIndex(0, 2)).toBe(1);
  });

  test("leaves the slot unchanged when it sits at or before the current position", () => {
    expect(toReorderIndex(2, 0)).toBe(0);
    expect(toReorderIndex(2, 2)).toBe(2);
  });
});

describe("favoriteInsertIndex", () => {
  // A 4 x 2 grid of 48px tiles with no gap, for simplicity: rows at
  // top 0-48 and 48-96, columns at 0-50, 50-100, 100-150, 150-200.
  function box(col: number, row: number): TileBox {
    return { left: col * 50, top: row * 48, right: col * 50 + 50, bottom: row * 48 + 48 };
  }
  const tiles: TileBox[] = [
    box(0, 0), box(1, 0), box(2, 0), box(3, 0),
    box(0, 1), box(1, 1), box(2, 1), box(3, 1),
  ];

  test("pointer over the first tile's leading half inserts at 0", () => {
    expect(favoriteInsertIndex(tiles, 10, 20)).toBe(0);
  });

  test("pointer over a tile's trailing half inserts after it", () => {
    expect(favoriteInsertIndex(tiles, 40, 20)).toBe(1);
  });

  test("pointer below every tile inserts at the end", () => {
    expect(favoriteInsertIndex(tiles, 10, 500)).toBe(8);
  });
});

describe("belowPinnedClip", () => {
  test("clamps at 0 when the pinned section does not yet overlap", () => {
    expect(belowPinnedClip(0, 40, 100)).toBe(0);
  });

  test("returns the overlap amount otherwise", () => {
    expect(belowPinnedClip(80, 40, 100)).toBe(20);
  });
});
