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

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// The popover base colors from design book §3 / PRD 10.1 §1, duplicated
// here (not exported from theme.ts) so the oracle below is independent of
// the module under test.
const POPOVER_BASE_ORACLE: Record<Appearance, [number, number, number]> = {
  light: [250, 250, 252],
  dark: [44, 44, 49],
};

/** Parse a `#rrggbb` or `rgb(r g b / a)` token string into rgb + alpha. */
function parseColorToken(value: string): { rgb: [number, number, number]; alpha: number } {
  if (value.startsWith("#")) return { rgb: hexToRgb(value), alpha: 1 };
  const m = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(value);
  if (!m) throw new Error(`unexpected color token: ${value}`);
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: Number(m[4]) };
}

/** Alpha-composite a parsed token layer over a float ground, unrounded. */
function compositeTokenOverGround(
  layer: { rgb: [number, number, number]; alpha: number },
  ground: readonly number[],
): [number, number, number] {
  return [0, 1, 2].map(
    (i) => layer.rgb[i] * layer.alpha + ground[i] * (1 - layer.alpha),
  ) as [number, number, number];
}

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

          const tokens = themeTokens(t, appearance);
          const dangerContrast = contrastRatio(
            hexToRgb(tokens["--ink-on-danger"]),
            hexToRgb(tokens["--danger"]),
          );
          expect(dangerContrast).toBeGreaterThanOrEqual(4.5);

          // Independent oracle: recompute the window/popover backgrounds
          // from the *emitted* tokens (not from theme.ts's internal
          // report) and re-measure contrast here, so a reduced background
          // set or a swapped alpha in theme.ts fails this test even if the
          // internal report's own bookkeeping still claims 4.5:1.
          const inkSecondary = hexToRgb(tokens["--ink-secondary"]);
          const surfaceRaised = parseColorToken(tokens["--surface-raised"]);
          const surfaceHover = parseColorToken(tokens["--surface-hover"]);
          const fillSubtle = parseColorToken(tokens["--fill-subtle"]);
          for (const ground of report.grounds) {
            const windowBackgrounds = [
              ground,
              compositeTokenOverGround(surfaceRaised, ground),
              compositeTokenOverGround(surfaceHover, ground),
              compositeTokenOverGround(fillSubtle, ground),
            ];
            for (const bg of windowBackgrounds) {
              expect(contrastRatio(inkSecondary, bg)).toBeGreaterThanOrEqual(4.5);
            }
          }

          const popoverSecondary = hexToRgb(tokens["--ink-popover-secondary"]);
          const popoverBase = POPOVER_BASE_ORACLE[appearance];
          const popoverWell = parseColorToken(tokens["--popover-well"]);
          const popoverHover = parseColorToken(tokens["--popover-hover"]);
          const controlRaised = parseColorToken(tokens["--control-raised"]);
          const popoverBackgrounds = [
            popoverBase,
            compositeTokenOverGround(popoverWell, popoverBase),
            compositeTokenOverGround(popoverHover, popoverBase),
            compositeTokenOverGround(controlRaised, popoverBase),
          ];
          for (const bg of popoverBackgrounds) {
            expect(contrastRatio(popoverSecondary, bg)).toBeGreaterThanOrEqual(4.5);
          }
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
      "--ink-secondary": "#5d5d61",
      "--accent": "#585dd4",
      "--ink-on-accent": "#ffffff",
      "--danger": "#cc2827",
      "--ink-popover-secondary": "#66666a",
    });
  });

  test("dark", () => {
    expect(themeTokens(null, "dark")).toMatchObject({
      "--surface-window": "rgb(32 32 36 / 0.88)",
      "--surface-card": "#1b1b1f",
      "--hairline": "rgb(245 245 247 / 0.12)",
      "--ink-primary": "#f5f5f7",
      "--ink-secondary": "#adadaf",
      "--accent": "#96a2ff",
      "--ink-on-accent": "#1a1a1f",
      "--danger": "#f66d67",
      "--ink-popover-secondary": "#b9b9bc",
    });
  });
});

describe("intensity 0 keeps the first stop's accent, only null falls back to iris", () => {
  const appearances: Appearance[] = ["light", "dark"];
  for (const appearance of appearances) {
    test(`${appearance}: teal accent equal at intensity 0 and 1; tint/tint-opacity equal null's`, () => {
      const zero = themeTokens({ stops: ["teal"], intensity: 0 }, appearance);
      const one = themeTokens({ stops: ["teal"], intensity: 1 }, appearance);
      const nullTokens = themeTokens(null, appearance);
      expect(zero["--accent"]).toBe(one["--accent"]);
      expect(zero["--tint"]).toBe(nullTokens["--tint"]);
      expect(zero["--tint-opacity"]).toBe(nullTokens["--tint-opacity"]);
    });

    test(`${appearance}: null theme's accent is the iris accent`, () => {
      const nullTokens = themeTokens(null, appearance);
      expect(nullTokens["--accent"]).toBe(
        themeTokens({ stops: ["iris"], intensity: 0 }, appearance)["--accent"],
      );
    });
  }
});

describe("inkOnAccentContrast floor (PRD 10.3 §1)", () => {
  const appearances: Appearance[] = ["light", "dark"];
  const intensities = [0, 0.25, 0.5, 0.75, 1];

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
  const allThemes = [...singleThemes, ...pairThemes];

  test("exactly 1000 cases sweep inkOnAccentContrast >= 4.5", () => {
    let cases = 0;
    for (const appearance of appearances) {
      for (const intensity of intensities) {
        for (const theme of allThemes) {
          const t: SpaceTheme = { stops: theme.stops, intensity };
          const report = themeReport(t, appearance);
          expect(report.inkOnAccentContrast).toBeGreaterThanOrEqual(4.5);
          cases++;
        }
      }
    }
    expect(cases).toBe(1000);
  });

  test("light, teal, intensity 0 reaches at least 4.5", () => {
    const report = themeReport({ stops: ["teal"], intensity: 0 }, "light");
    expect(report.inkOnAccentContrast).toBeGreaterThanOrEqual(4.5);
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
