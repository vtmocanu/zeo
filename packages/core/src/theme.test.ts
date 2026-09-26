import { describe, expect, test } from "vitest";
import {
  SPACE_HUES,
  SEMANTIC_TOKENS,
  oklchToRgb,
  contrastRatio,
  normalizeTheme,
  themeReport,
  themeTokens,
  toHex,
  type SpaceTheme,
  type Appearance,
} from "./theme.js";

describe("oklchToRgb", () => {
  test("white and black", () => {
    const white = oklchToRgb(1, 0, 0).map(Math.round);
    expect(white).toEqual([255, 255, 255]);
    const black = oklchToRgb(0, 0, 0).map(Math.round);
    expect(black).toEqual([0, 0, 0]);
  });

  test("chromatic reference: oklch(0.7 0.1 200) is #40b1b7", () => {
    expect(toHex(oklchToRgb(0.7, 0.1, 200))).toBe("#40b1b7");
    expect(toHex(oklchToRgb(0.627955, 0.257683, 29.2339))).toBe("#ff0000");
  });

  test("out-of-gamut input stays within 0-255", () => {
    const rgb = oklchToRgb(0.7, 0.5, 30);
    for (const c of rgb) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(255);
    }
  });
});

describe("contrastRatio", () => {
  test("black vs white is 21", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 2);
  });

  test("identical colors is 1", () => {
    const a: [number, number, number] = [123, 45, 67];
    expect(contrastRatio(a, a)).toBeCloseTo(1, 5);
  });
});

describe("themeTokens sweep", () => {
  const appearances: Appearance[] = ["light", "dark"];
  const intensities = [0, 0.5, 1];

  const singleThemes: SpaceTheme[] = SPACE_HUES.map((hue) => ({
    stops: [hue],
    intensity: 1,
  }));

  const pairThemes: SpaceTheme[] = [];
  for (const a of SPACE_HUES) {
    for (const b of SPACE_HUES) {
      if (a === b) continue;
      pairThemes.push({ stops: [a, b], intensity: 1 });
    }
  }

  test("exactly 10 single hues and 90 ordered pairs", () => {
    expect(singleThemes).toHaveLength(10);
    expect(pairThemes).toHaveLength(90);
  });

  const allThemes = [...singleThemes, ...pairThemes];

  for (const appearance of appearances) {
    for (const intensity of intensities) {
      for (const theme of allThemes) {
        test(`${appearance} intensity=${intensity} stops=${theme.stops.join("+")}`, () => {
          const t: SpaceTheme = { stops: theme.stops, intensity };
          const report = themeReport(t, appearance);
          expect(report.inkContrast).toBeGreaterThanOrEqual(4.5);
          expect(report.inkSecondaryContrast).toBeGreaterThanOrEqual(4.5);
          expect(report.accentContrast).toBeGreaterThanOrEqual(3);
          expect(report.popoverSecondaryContrast).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }
});

describe("themeTokens tint edge cases", () => {
  test("null theme returns transparent tint and 0.000 opacity", () => {
    const tokens = themeTokens(null, "light");
    expect(tokens["--tint"]).toBe("transparent");
    expect(tokens["--tint-opacity"]).toBe("0.000");
  });

  test("intensity 0 returns transparent tint and 0.000 opacity", () => {
    const tokens = themeTokens({ stops: ["iris"], intensity: 0 }, "dark");
    expect(tokens["--tint"]).toBe("transparent");
    expect(tokens["--tint-opacity"]).toBe("0.000");
  });

  test("intensity 1.7 behaves as 1", () => {
    const a = themeTokens({ stops: ["iris"], intensity: 1.7 }, "light");
    const b = themeTokens({ stops: ["iris"], intensity: 1 }, "light");
    expect(a).toEqual(b);
  });

  test("NaN intensity behaves as 0", () => {
    const a = themeTokens({ stops: ["iris"], intensity: NaN }, "light");
    const b = themeTokens(null, "light");
    expect(a["--tint"]).toBe(b["--tint"]);
    expect(a["--tint-opacity"]).toBe(b["--tint-opacity"]);
  });

  test("Infinity intensity clamps to 1", () => {
    const a = themeTokens({ stops: ["iris"], intensity: Infinity }, "light");
    const b = themeTokens({ stops: ["iris"], intensity: 1 }, "light");
    expect(a).toEqual(b);
  });

  test("two stops render a gradient", () => {
    const tokens = themeTokens({ stops: ["iris", "rose"], intensity: 1 }, "light");
    expect(tokens["--tint"]).toMatch(
      /^linear-gradient\(160deg, #[0-9a-f]{6}, #[0-9a-f]{6}\)$/,
    );
  });
});

describe("determinism and shape", () => {
  test("two calls with equal input return deep-equal output", () => {
    const theme: SpaceTheme = { stops: ["teal", "amber"], intensity: 0.5 };
    const a = themeTokens(theme, "dark");
    const b = themeTokens({ stops: ["teal", "amber"], intensity: 0.5 }, "dark");
    expect(a).toEqual(b);
  });

  test("returned object has exactly the SEMANTIC_TOKENS keys", () => {
    const tokens = themeTokens(null, "light");
    expect(Object.keys(tokens).sort()).toEqual([...SEMANTIC_TOKENS].sort());
  });
});

describe("tokens follow the report", () => {
  test.each([
    [null, "light"],
    [null, "dark"],
    [{ stops: ["amber", "lime"], intensity: 1 }, "light"],
    [{ stops: ["rose", "teal"], intensity: 0.5 }, "dark"],
  ] as [SpaceTheme | null, Appearance][])("%j %s", (theme, appearance) => {
    const report = themeReport(theme, appearance);
    const tokens = themeTokens(theme, appearance);
    expect(tokens["--ink-primary"]).toBe(toHex(report.ink));
    expect(tokens["--ink-secondary"]).toBe(toHex(report.inkSecondary));
    expect(tokens["--accent"]).toBe(toHex(report.accent));
    expect(tokens["--focus-ring"]).toBe(toHex(report.accent));
  });
});

describe("null-theme golden values", () => {
  test("light", () => {
    expect(themeTokens(null, "light")).toMatchObject({
      "--surface-window": "rgb(234 234 238 / 0.88)",
      "--surface-card": "#ffffff",
      "--hairline": "rgb(26 26 31 / 0.12)",
      "--ink-primary": "#1a1a1f",
      "--ink-secondary": "#69696e",
      "--accent": "#585dd4",
      "--ink-on-accent": "#ffffff",
      "--danger": "#cc2827",
      "--ink-popover-secondary": "#6f6f73",
    });
  });

  test("dark", () => {
    expect(themeTokens(null, "dark")).toMatchObject({
      "--surface-window": "rgb(32 32 36 / 0.88)",
      "--surface-card": "#1b1b1f",
      "--hairline": "rgb(245 245 247 / 0.12)",
      "--ink-primary": "#f5f5f7",
      "--ink-secondary": "#97979a",
      "--accent": "#96a2ff",
      "--ink-on-accent": "#1a1a1f",
      "--danger": "#f66d67",
      "--ink-popover-secondary": "#959598",
    });
  });
});

describe("normalizeTheme", () => {
  test("valid one-stop theme passes through", () => {
    expect(normalizeTheme({ stops: ["iris"], intensity: 0.5 })).toEqual({
      stops: ["iris"],
      intensity: 0.5,
    });
  });

  test("valid two-stop theme passes through", () => {
    expect(normalizeTheme({ stops: ["iris", "rose"], intensity: 0.5 })).toEqual({
      stops: ["iris", "rose"],
      intensity: 0.5,
    });
  });

  test("intensity 2 becomes 1", () => {
    expect(normalizeTheme({ stops: ["iris"], intensity: 2 })).toEqual({
      stops: ["iris"],
      intensity: 1,
    });
  });

  test.each([
    ["null", null],
    ["empty object", {}],
    ["three stops", { stops: ["iris", "rose", "teal"], intensity: 1 }],
    ["unknown hue", { stops: ["notahue"], intensity: 1 }],
    ["string intensity", { stops: ["iris"], intensity: "1" }],
    ["NaN intensity", { stops: ["iris"], intensity: NaN }],
  ])("%s returns null", (_label, value) => {
    expect(normalizeTheme(value)).toBeNull();
  });
});
