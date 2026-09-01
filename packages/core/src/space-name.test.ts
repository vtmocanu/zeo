import { describe, expect, test } from "vitest";
import { defaultSpaceName } from "./space-name.js";
import type { Space } from "./space.js";

/** Builds a minimal Space literal with just the fields defaultSpaceName reads. */
function space(name: string): Space {
  return { id: name, name, profileId: "default", createdAt: 0 };
}

describe("defaultSpaceName", () => {
  test("names the next space after a seeded Personal space", () => {
    expect(defaultSpaceName([space("Personal")])).toBe("Space 2");
  });

  test("skips a name that is already taken", () => {
    expect(defaultSpaceName([space("Personal"), space("Space 2")])).toBe("Space 3");
  });

  test("names the first space when the list is empty", () => {
    expect(defaultSpaceName([])).toBe("Space 1");
  });
});
