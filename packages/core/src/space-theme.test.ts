import { describe, expect, test } from "vitest";
import {
  defaultSpaceTheme,
  encodeSpaceTheme,
  decodeSpaceTheme,
  themesEqual,
  cloneTheme,
  activeSpaceTheme,
  hueSwatchColor,
  spaceDotColor,
  pickerSetKind,
  pickerSelectHue,
  pickerSetIntensity,
} from "./space-theme.js";
import type { SpaceTheme } from "./theme.js";
import type { SpacesState } from "./ipc.js";
import type { Space } from "./space.js";

function space(overrides: Partial<Space> = {}): Space {
  return {
    id: "s1",
    name: "S",
    profileId: "default",
    createdAt: 0,
    theme: null,
    ...overrides,
  };
}

describe("defaultSpaceTheme", () => {
  test.each([
    [0, "iris"],
    [3, "amber"],
    [9, "lime"],
    [10, "iris"],
    [23, "amber"],
  ])("spaceCount %i -> %s", (count, hue) => {
    expect(defaultSpaceTheme(count)).toEqual({ stops: [hue], intensity: 1 });
  });
});

describe("encodeSpaceTheme / decodeSpaceTheme", () => {
  test("null round-trips to null", () => {
    expect(encodeSpaceTheme(null)).toBeNull();
    expect(decodeSpaceTheme(null)).toBeNull();
  });

  test("one-stop theme round-trips", () => {
    const theme: SpaceTheme = { stops: ["iris"], intensity: 0.5 };
    expect(decodeSpaceTheme(encodeSpaceTheme(theme))).toEqual(theme);
  });

  test("two-stop theme round-trips", () => {
    const theme: SpaceTheme = { stops: ["teal", "amber"], intensity: 0.25 };
    expect(decodeSpaceTheme(encodeSpaceTheme(theme))).toEqual(theme);
  });

  test.each([
    ["not json", "not json"],
    ["empty object", "{}"],
    ["unknown hue", JSON.stringify({ stops: ["notahue"], intensity: 1 })],
  ])("%s decodes to null", (_label, text) => {
    expect(decodeSpaceTheme(text)).toBeNull();
  });

  test("intensity 3 clamps to 1", () => {
    const text = JSON.stringify({ stops: ["iris"], intensity: 3 });
    expect(decodeSpaceTheme(text)).toEqual({ stops: ["iris"], intensity: 1 });
  });
});

describe("themesEqual", () => {
  test("both null", () => {
    expect(themesEqual(null, null)).toBe(true);
  });

  test("one null one not", () => {
    expect(themesEqual(null, { stops: ["iris"], intensity: 1 })).toBe(false);
    expect(themesEqual({ stops: ["iris"], intensity: 1 }, null)).toBe(false);
  });

  test("equal stops and intensity", () => {
    expect(
      themesEqual(
        { stops: ["iris", "rose"], intensity: 0.5 },
        { stops: ["iris", "rose"], intensity: 0.5 },
      ),
    ).toBe(true);
  });

  test("different stop count, order, or intensity", () => {
    expect(
      themesEqual({ stops: ["iris"], intensity: 1 }, { stops: ["iris", "rose"], intensity: 1 }),
    ).toBe(false);
    expect(
      themesEqual(
        { stops: ["iris", "rose"], intensity: 1 },
        { stops: ["rose", "iris"], intensity: 1 },
      ),
    ).toBe(false);
    expect(
      themesEqual({ stops: ["iris"], intensity: 1 }, { stops: ["iris"], intensity: 0.5 }),
    ).toBe(false);
  });
});

describe("cloneTheme", () => {
  test("null clones to null", () => {
    expect(cloneTheme(null)).toBeNull();
  });

  test("mutating the clone's stops leaves the original unchanged", () => {
    const original: SpaceTheme = { stops: ["iris", "rose"], intensity: 1 };
    const clone = cloneTheme(original) as SpaceTheme & { stops: string[] };
    clone.stops[0] = "teal";
    expect(original.stops[0]).toBe("iris");
  });
});

describe("activeSpaceTheme", () => {
  test("null state returns null", () => {
    expect(activeSpaceTheme(null)).toBeNull();
  });

  test("missing active id returns null", () => {
    const state: SpacesState = {
      spaces: [space({ id: "s1", theme: { stops: ["iris"], intensity: 1 } })],
      activeSpaceId: "ghost",
      profiles: [],
    };
    expect(activeSpaceTheme(state)).toBeNull();
  });

  test("resolves the active space's theme", () => {
    const theme: SpaceTheme = { stops: ["teal"], intensity: 0.5 };
    const state: SpacesState = {
      spaces: [space({ id: "s1", theme: null }), space({ id: "s2", theme })],
      activeSpaceId: "s2",
      profiles: [],
    };
    expect(activeSpaceTheme(state)).toEqual(theme);
  });
});

describe("hueSwatchColor", () => {
  test("matches a hex color pattern for every hue", () => {
    for (const hue of [
      "iris",
      "violet",
      "orchid",
      "rose",
      "coral",
      "amber",
      "lime",
      "mint",
      "teal",
      "sky",
    ] as const) {
      expect(hueSwatchColor(hue)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("spaceDotColor", () => {
  test("null theme is null", () => {
    expect(spaceDotColor(null)).toBeNull();
  });

  test("intensity 0 is null", () => {
    expect(spaceDotColor({ stops: ["iris"], intensity: 0 })).toBeNull();
  });

  test("one stop returns its swatch color", () => {
    expect(spaceDotColor({ stops: ["iris"], intensity: 1 })).toBe(hueSwatchColor("iris"));
  });

  test("two stops start a 135deg linear-gradient", () => {
    const color = spaceDotColor({ stops: ["iris", "rose"], intensity: 1 });
    expect(color).toMatch(/^linear-gradient\(135deg,/);
  });
});

describe("pickerSetKind", () => {
  test("solid->gradient on teal appends violet (index 8 + 3 wraps to 1)", () => {
    expect(pickerSetKind({ stops: ["teal"], intensity: 1 }, "gradient")).toEqual({
      stops: ["teal", "violet"],
      intensity: 1,
    });
  });

  test("gradient->solid keeps stop 0", () => {
    expect(pickerSetKind({ stops: ["teal", "violet"], intensity: 1 }, "solid")).toEqual({
      stops: ["teal"],
      intensity: 1,
    });
  });

  test("same kind is a no-op on stops", () => {
    expect(pickerSetKind({ stops: ["teal"], intensity: 1 }, "solid")).toEqual({
      stops: ["teal"],
      intensity: 1,
    });
    expect(pickerSetKind({ stops: ["teal", "violet"], intensity: 1 }, "gradient")).toEqual({
      stops: ["teal", "violet"],
      intensity: 1,
    });
  });

  test("intensity 0 becomes 1", () => {
    expect(pickerSetKind(null, "solid")).toEqual({ stops: ["iris"], intensity: 1 });
  });

  test("returns a fresh stops array, never the input's", () => {
    const theme = { stops: ["teal", "violet"] as ["teal", "violet"], intensity: 1 };
    const result = pickerSetKind(theme, "gradient");
    expect(result.stops).not.toBe(theme.stops);
    expect(result.stops).toEqual(theme.stops);
  });

  test("does not share NULL_DRAFT's stops array across calls", () => {
    const a = pickerSetKind(null, "solid");
    const b = pickerSetKind(null, "solid");
    expect(a.stops).not.toBe(b.stops);
    a.stops[0] = "teal" as never;
    expect(b.stops).toEqual(["iris"]);
  });
});

describe("pickerSelectHue", () => {
  test("selecting stop 1 of a one-stop theme replaces stop 0", () => {
    expect(pickerSelectHue({ stops: ["iris"], intensity: 1 }, 1, "rose")).toEqual({
      stops: ["rose"],
      intensity: 1,
    });
  });

  test("selecting a hue on null gives intensity 1", () => {
    expect(pickerSelectHue(null, 0, "teal")).toEqual({ stops: ["teal"], intensity: 1 });
  });

  test("replaces the targeted stop of a two-stop theme", () => {
    expect(pickerSelectHue({ stops: ["iris", "rose"], intensity: 1 }, 1, "teal")).toEqual({
      stops: ["iris", "teal"],
      intensity: 1,
    });
  });
});

describe("pickerSetIntensity", () => {
  test("47 -> 0.45", () => {
    expect(pickerSetIntensity({ stops: ["iris"], intensity: 1 }, 47)).toEqual({
      stops: ["iris"],
      intensity: 0.45,
    });
  });

  test("130 -> 1", () => {
    expect(pickerSetIntensity({ stops: ["iris"], intensity: 1 }, 130)).toEqual({
      stops: ["iris"],
      intensity: 1,
    });
  });

  test("NaN percent maps to 0 intensity", () => {
    expect(pickerSetIntensity({ stops: ["iris"], intensity: 1 }, NaN)).toEqual({
      stops: ["iris"],
      intensity: 0,
    });
  });

  test("Infinity percent maps to 0 intensity", () => {
    expect(pickerSetIntensity({ stops: ["iris"], intensity: 1 }, Infinity)).toEqual({
      stops: ["iris"],
      intensity: 0,
    });
    expect(pickerSetIntensity({ stops: ["iris"], intensity: 1 }, -Infinity)).toEqual({
      stops: ["iris"],
      intensity: 0,
    });
  });

  test("returns a fresh stops array, never the input's", () => {
    const theme = { stops: ["teal"] as ["teal"], intensity: 1 };
    const result = pickerSetIntensity(theme, 40);
    expect(result.stops).not.toBe(theme.stops);
    expect(result.stops).toEqual(theme.stops);
  });
});
