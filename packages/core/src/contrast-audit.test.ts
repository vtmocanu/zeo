import { describe, expect, test } from "vitest";
import { contrastAudit, parseCssColor, type ContrastCheckId } from "./contrast-audit.js";
import { SPACE_HUES, themeTokens, type Appearance, type SpaceTheme } from "./theme.js";

const ALL_CHECK_IDS: ContrastCheckId[] = [
  "ink-primary/window",
  "ink-secondary/window",
  "ink-primary/raised",
  "ink-secondary/raised",
  "ink-secondary/hover",
  "ink-secondary/fill-subtle",
  "accent/window",
  "accent/card",
  "focus-ring/raised",
  "focus-ring/popover",
  "ink-on-accent/accent",
  "ink-popover/popover",
  "ink-popover-secondary/popover",
  "ink-popover/accent-soft",
  "ink-on-danger/danger",
  "danger/popover",
  "danger/card",
];

describe("parseCssColor", () => {
  test("parses #rrggbb", () => {
    expect(parseCssColor("#1a1a1f")).toEqual({ rgb: [26, 26, 31], alpha: 1 });
  });

  test("parses rgb(r g b / a)", () => {
    expect(parseCssColor("rgb(255 255 255 / 0.8)")).toEqual({
      rgb: [255, 255, 255],
      alpha: 0.8,
    });
  });

  test("rejects transparent, linear-gradient and keywords", () => {
    expect(parseCssColor("transparent")).toBeNull();
    expect(parseCssColor("linear-gradient(160deg, #111111, #222222)")).toBeNull();
    expect(parseCssColor("red")).toBeNull();
  });
});

describe("contrastAudit sweep", () => {
  const appearances: Appearance[] = ["light", "dark"];
  const intensities = [0, 0.5, 1];

  const singleThemes: SpaceTheme[] = SPACE_HUES.map((hue) => ({ stops: [hue], intensity: 1 }));

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

  const allThemes: (SpaceTheme | null)[] = [null, ...singleThemes, ...pairThemes];

  for (const appearance of appearances) {
    for (const intensity of intensities) {
      for (const theme of allThemes) {
        const label = theme === null ? "null" : theme.stops.join("+");
        test(`${appearance} intensity=${intensity} theme=${label}`, () => {
          const t = theme === null ? null : ({ stops: theme.stops, intensity } as SpaceTheme);
          const checks = contrastAudit(t, appearance);

          expect(checks).toHaveLength(17);
          expect(new Set(checks.map((c) => c.id)).size).toBe(17);
          for (const id of ALL_CHECK_IDS) {
            expect(checks.some((c) => c.id === id)).toBe(true);
          }

          for (const check of checks) {
            expect(check.pass, `${check.id} ratio=${check.ratio} floor=${check.floor}`).toBe(
              true,
            );
            expect(check.ratio).toBeGreaterThanOrEqual(check.floor);
          }
        });
      }
    }
  }
});

describe("--ink-on-danger (10.1 guarantee, unchanged)", () => {
  test("is the dark ink in dark and white in light", () => {
    expect(themeTokens(null, "dark")["--ink-on-danger"]).toBe("#1a1a1f");
    expect(themeTokens(null, "light")["--ink-on-danger"]).toBe("#ffffff");
  });
});
