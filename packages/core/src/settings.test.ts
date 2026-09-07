import { describe, expect, test } from "vitest";
import {
  SETTINGS_SECTIONS,
  nextSection,
  prevSection,
  SEARCH_ENGINES,
  DEFAULT_SEARCH_ENGINE_ID,
  searchEngine,
  searchUrl,
} from "./settings.js";

describe("SETTINGS_SECTIONS", () => {
  test("has the four sections in registry order with their titles", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      "general",
      "blocking",
      "profiles",
      "history",
    ]);
    expect(SETTINGS_SECTIONS.map((s) => s.title)).toEqual([
      "General",
      "Blocking",
      "Profiles",
      "History",
    ]);
  });
});

describe("nextSection / prevSection", () => {
  test("nextSection walks the registry order", () => {
    expect(nextSection("general")).toBe("blocking");
    expect(nextSection("blocking")).toBe("profiles");
    expect(nextSection("profiles")).toBe("history");
  });

  test("nextSection clamps at the last section (no wrap)", () => {
    expect(nextSection("history")).toBe("history");
  });

  test("prevSection walks the registry order backward", () => {
    expect(prevSection("history")).toBe("profiles");
    expect(prevSection("profiles")).toBe("blocking");
    expect(prevSection("blocking")).toBe("general");
  });

  test("prevSection clamps at the first section (no wrap)", () => {
    expect(prevSection("general")).toBe("general");
  });
});

describe("SEARCH_ENGINES", () => {
  test("holds the catalog ids, names, and templates in order", () => {
    expect(SEARCH_ENGINES).toEqual([
      { id: "duckduckgo", name: "DuckDuckGo", urlTemplate: "https://duckduckgo.com/?q=" },
      { id: "google", name: "Google", urlTemplate: "https://www.google.com/search?q=" },
      { id: "bing", name: "Bing", urlTemplate: "https://www.bing.com/search?q=" },
      { id: "brave", name: "Brave", urlTemplate: "https://search.brave.com/search?q=" },
      { id: "startpage", name: "Startpage", urlTemplate: "https://www.startpage.com/sp/search?query=" },
    ]);
  });

  test("the default engine id is duckduckgo", () => {
    expect(DEFAULT_SEARCH_ENGINE_ID).toBe("duckduckgo");
  });
});

describe("searchEngine", () => {
  test("returns the catalog entry for each catalog id", () => {
    for (const engine of SEARCH_ENGINES) {
      expect(searchEngine(engine.id)).toEqual(engine);
    }
  });

  test("returns undefined for an id not in the catalog", () => {
    expect(searchEngine("nope")).toBeUndefined();
  });
});

describe("searchUrl", () => {
  test("appends the URL-encoded query to the engine template", () => {
    expect(searchUrl("duckduckgo", "a b")).toBe("https://duckduckgo.com/?q=a%20b");
    expect(searchUrl("google", "x&y")).toBe("https://www.google.com/search?q=x%26y");
  });
});
