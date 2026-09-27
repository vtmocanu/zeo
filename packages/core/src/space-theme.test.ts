import { describe, expect, test } from "vitest";
import {
  activeSpaceTheme,
  cloneTheme,
  decodeSpaceTheme,
  defaultSpaceTheme,
  encodeSpaceTheme,
  hueSwatchColor,
  pickerSelectHue,
  pickerSetIntensity,
  pickerSetKind,
  spaceDotColor,
  themesEqual,
} from "./space-theme.js";
import type { Space } from "./space.js";
import type { SpacesState } from "./ipc.js";
import type { SpaceTheme } from "./theme.js";

function space(id: string, theme: Space["theme"]): Space {
  return { id, name: id, profileId: "default", createdAt: 0, theme };
}

describe("defaultSpaceTheme", () => {
  test.each([
    [0, "iris"],
    [3, "amber"],
    [9, "lime"],
    [10, "iris"],
    [23, "amber"],
  ] as const)("spaceCount %i -> %s", (count, hue) => {
    expect(defaultSpaceTheme(count)).toEqual({ stops: [hue], intensity: 1 });
  });
});

describe("encodeSpaceTheme / decodeSpaceTheme", () => {
  test("round-trips a one-stop theme", () => {
    const theme: SpaceTheme = { stops: ["teal"], intensity: 0.5 };
    expect(decodeSpaceTheme(encodeSpaceTheme(theme))).toEqual(theme);
  });

  test("round-trips a two-stop theme", () => {
    const theme: SpaceTheme = { stops: ["teal", "amber"], intensity: 0.75 };
    expect(decodeSpaceTheme(encodeSpaceTheme(theme))).toEqual(theme);
  });

  test("decode gives null for null", () => {
    expect(decodeSpaceTheme(null)).toBeNull();
  });

  test("decode gives null for undefined", () => {
    expect(decodeSpaceTheme(undefined)).toBeNull();
  });

  test("decode gives null for invalid JSON", () => {
    expect(decodeSpaceTheme("not json")).toBeNull();
  });

  test("decode gives null for an empty object", () => {
    expect(decodeSpaceTheme("{}")).toBeNull();
  });

  test("decode gives null for an unknown hue", () => {
    expect(decodeSpaceTheme(JSON.stringify({ stops: ["mauve"], intensity: 1 }))).toBeNull();
  });

  test("decode clamps an out-of-range intensity", () => {
    expect(decodeSpaceTheme(JSON.stringify({ stops: ["iris"], intensity: 3 }))).toEqual({
      stops: ["iris"],
      intensity: 1,
    });
  });

  test("encode gives null for null", () => {
    expect(encodeSpaceTheme(null)).toBeNull();
  });
});

describe("themesEqual", () => {
  test("two null themes are equal", () => {
    expect(themesEqual(null, null)).toBe(true);
  });

  test("null and non-null are not equal", () => {
    expect(themesEqual(null, { stops: ["iris"], intensity: 1 })).toBe(false);
    expect(themesEqual({ stops: ["iris"], intensity: 1 }, null)).toBe(false);
  });

  test("different stop counts are not equal", () => {
    expect(
      themesEqual({ stops: ["iris"], intensity: 1 }, { stops: ["iris", "rose"], intensity: 1 }),
    ).toBe(false);
  });

  test("different hue order is not equal", () => {
    expect(
      themesEqual(
        { stops: ["iris", "rose"], intensity: 1 },
        { stops: ["rose", "iris"], intensity: 1 },
      ),
    ).toBe(false);
  });

  test("different intensity is not equal", () => {
    expect(
      themesEqual({ stops: ["iris"], intensity: 1 }, { stops: ["iris"], intensity: 0.5 }),
    ).toBe(false);
  });

  test("equal themes are equal", () => {
    expect(
      themesEqual(
        { stops: ["iris", "rose"], intensity: 0.5 },
        { stops: ["iris", "rose"], intensity: 0.5 },
      ),
    ).toBe(true);
  });
});

describe("cloneTheme", () => {
  test("passes through null", () => {
    expect(cloneTheme(null)).toBeNull();
  });

  test("copies stops so mutating the clone leaves the original unchanged", () => {
    const original: SpaceTheme = { stops: ["iris"], intensity: 1 };
    const clone = cloneTheme(original)!;
    clone.stops[0] = "rose" as never;
    expect(original.stops[0]).toBe("iris");
  });
});

describe("activeSpaceTheme", () => {
  test("returns null for a null state", () => {
    expect(activeSpaceTheme(null)).toBeNull();
  });

  test("returns null when the active id matches no space", () => {
    const state: SpacesState = {
      spaces: [space("s1", { stops: ["iris"], intensity: 1 })],
      activeSpaceId: "missing",
      profiles: [],
    };
    expect(activeSpaceTheme(state)).toBeNull();
  });

  test("returns the active space's theme", () => {
    const theme: SpaceTheme = { stops: ["teal"], intensity: 0.5 };
    const state: SpacesState = {
      spaces: [space("s1", null), space("s2", theme)],
      activeSpaceId: "s2",
      profiles: [],
    };
    expect(activeSpaceTheme(state)).toEqual(theme);
  });
});

describe("hueSwatchColor", () => {
  test("returns a 6-digit hex color for every hue", () => {
    for (const hue of ["iris", "violet", "orchid", "rose", "coral", "amber", "lime", "mint", "teal", "sky"] as const) {
      expect(hueSwatchColor(hue)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("spaceDotColor", () => {
  test("is null for a null theme", () => {
    expect(spaceDotColor(null)).toBeNull();
  });

  test("is null at intensity 0", () => {
    expect(spaceDotColor({ stops: ["iris"], intensity: 0 })).toBeNull();
  });

  test("is the hue swatch color for one stop", () => {
    expect(spaceDotColor({ stops: ["teal"], intensity: 1 })).toBe(hueSwatchColor("teal"));
  });

  test("starts with a 135deg linear-gradient for two stops", () => {
    const color = spaceDotColor({ stops: ["teal", "amber"], intensity: 1 });
    expect(color).toMatch(/^linear-gradient\(135deg,/);
  });
});

describe("pickerSetKind", () => {
  test("solid->gradient on teal appends violet (index 8 + 3 wraps to 1)", () => {
    const result = pickerSetKind({ stops: ["teal"], intensity: 1 }, "gradient");
    expect(result.stops).toEqual(["teal", "violet"]);
  });

  test("gradient->solid keeps stop 0", () => {
    const result = pickerSetKind({ stops: ["teal", "violet"], intensity: 1 }, "solid");
    expect(result.stops).toEqual(["teal"]);
  });

  test("a null theme is treated as intensity 0, iris", () => {
    const result = pickerSetKind(null, "solid");
    expect(result).toEqual({ stops: ["iris"], intensity: 1 });
  });

  test("same kind is a no-op on stops", () => {
    const solid = pickerSetKind({ stops: ["teal"], intensity: 1 }, "solid");
    expect(solid.stops).toEqual(["teal"]);

    const gradient = pickerSetKind({ stops: ["teal", "violet"], intensity: 1 }, "gradient");
    expect(gradient.stops).toEqual(["teal", "violet"]);
  });
});

describe("pickerSelectHue", () => {
  test("selecting stop 1 of a one-stop theme replaces stop 0", () => {
    const result = pickerSelectHue({ stops: ["iris"], intensity: 1 }, 1, "sky");
    expect(result.stops).toEqual(["sky"]);
  });

  test("selecting a hue on a null theme gives intensity 1", () => {
    const result = pickerSelectHue(null, 0, "sky");
    expect(result).toEqual({ stops: ["sky"], intensity: 1 });
  });
});

describe("pickerSetIntensity", () => {
  test("47 snaps to 45%", () => {
    expect(pickerSetIntensity({ stops: ["iris"], intensity: 1 }, 47).intensity).toBe(0.45);
  });

  test("130 clamps to 100%", () => {
    expect(pickerSetIntensity({ stops: ["iris"], intensity: 1 }, 130).intensity).toBe(1);
  });

  test("a non-finite percent leaves the draft's intensity unchanged", () => {
    expect(pickerSetIntensity({ stops: ["iris"], intensity: 0.65 }, NaN).intensity).toBe(0.65);
  });
});
