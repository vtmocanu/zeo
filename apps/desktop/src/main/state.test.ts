import { describe, expect, test } from "vitest";
import { runtime } from "./state.js";

/**
 * Guards the runtime singleton against a future module seeding state at import
 * time: importing `state.ts` must do no disk reads and leave every documented
 * default in place (PRD 9.2 §4).
 */
describe("runtime initial state", () => {
  test("starts with the documented defaults", () => {
    expect(runtime.win).toBe(null);
    expect(runtime.views.size).toBe(0);
    expect(runtime.commandBar.open).toBe(false);
    expect(runtime.find.open).toBe(false);
    expect(runtime.settings.searchEngine).toBe("duckduckgo");
    expect(Object.keys(runtime.zoom.byHost)).toHaveLength(0);
  });
});
