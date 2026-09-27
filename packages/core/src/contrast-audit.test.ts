import { describe, expect, test } from "vitest";
import { contrastAudit, parseCssColor, type ContrastCheckId } from "./contrast-audit.js";
import {
  SPACE_HUES,
  contrastRatio,
  themeReport,
  themeTokens,
  type Appearance,
  type Rgb,
  type SpaceTheme,
} from "./theme.js";

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

const EXPECTED_FLOORS: Record<ContrastCheckId, 3 | 4.5> = {
  "ink-primary/window": 4.5,
  "ink-secondary/window": 4.5,
  "ink-primary/raised": 4.5,
  "ink-secondary/raised": 4.5,
  "ink-secondary/hover": 4.5,
  "ink-secondary/fill-subtle": 4.5,
  "accent/window": 3,
  "accent/card": 3,
  "focus-ring/raised": 3,
  "focus-ring/popover": 3,
  "ink-on-accent/accent": 4.5,
  "ink-popover/popover": 4.5,
  "ink-popover-secondary/popover": 4.5,
  "ink-popover/accent-soft": 4.5,
  "ink-on-danger/danger": 4.5,
  "danger/popover": 4.5,
  "danger/card": 4.5,
};

/** Composites a parsed color over a single ground, mirroring the compositing
 * math the audit itself uses (rewritten independently here so a mutation to
 * the production compositing/grounds logic changes this test's expectation). */
function compositeManual(top: { rgb: Rgb; alpha: number }, ground: Rgb): Rgb {
  return ground.map((c, i) => c + (top.rgb[i] - c) * top.alpha) as unknown as Rgb;
}

function requireParsed(value: string): { rgb: Rgb; alpha: number } {
  const parsed = parseCssColor(value);
  if (!parsed) throw new Error(`unparseable color "${value}"`);
  return parsed;
}

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

  test("rejects out-of-range rgb channels", () => {
    expect(parseCssColor("rgb(300 0 0 / 0.5)")).toBeNull();
    expect(parseCssColor("rgb(0 0 256 / 0.5)")).toBeNull();
  });

  test("rejects an out-of-range or malformed alpha", () => {
    expect(parseCssColor("rgb(1 2 3 / 1.2.3)")).toBeNull();
    expect(parseCssColor("rgb(1 2 3 / 5)")).toBeNull();
    expect(parseCssColor("rgb(1 2 3 / -0.1)")).toBeNull();
  });

  test("accepts boundary values", () => {
    expect(parseCssColor("rgb(0 0 0 / 0)")).toEqual({ rgb: [0, 0, 0], alpha: 0 });
    expect(parseCssColor("rgb(255 255 255 / 1)")).toEqual({ rgb: [255, 255, 255], alpha: 1 });
  });
});

describe("contrast check floors", () => {
  const checks = contrastAudit(null, "dark");

  for (const id of ALL_CHECK_IDS) {
    test(`${id} has floor ${EXPECTED_FLOORS[id]}`, () => {
      const check = checks.find((c) => c.id === id);
      expect(check).toBeDefined();
      expect(check?.floor).toBe(EXPECTED_FLOORS[id]);
    });
  }
});

describe("ink-popover-secondary/popover (hand-computed)", () => {
  test("ratio equals the min over popover, well, hover and control-raised grounds", () => {
    // A two-hue theme so the window grounds (and everything composited on
    // top of them) actually differ, giving the four popover-secondary
    // grounds distinct contrast ratios.
    const theme: SpaceTheme = { stops: [SPACE_HUES[0], SPACE_HUES[3]], intensity: 1 };
    const appearance: Appearance = "dark";

    const tokens = themeTokens(theme, appearance);
    const windowGrounds = themeReport(theme, appearance).grounds;

    const surfaceWindowLayer = requireParsed(tokens["--surface-window"]);
    const surfaceWindowGrounds = windowGrounds.map((g) => compositeManual(surfaceWindowLayer, g));

    const popoverLayer = requireParsed(tokens["--surface-popover"]);
    const popoverGrounds = surfaceWindowGrounds.map((g) => compositeManual(popoverLayer, g));

    const wellLayer = requireParsed(tokens["--popover-well"]);
    const hoverLayer = requireParsed(tokens["--popover-hover"]);
    const controlRaisedLayer = requireParsed(tokens["--control-raised"]);

    const allGrounds = [
      ...popoverGrounds,
      ...popoverGrounds.map((g) => compositeManual(wellLayer, g)),
      ...popoverGrounds.map((g) => compositeManual(hoverLayer, g)),
      ...popoverGrounds.map((g) => compositeManual(controlRaisedLayer, g)),
    ];

    const fg = requireParsed(tokens["--ink-popover-secondary"]).rgb;
    const ratios = allGrounds.map((g) => contrastRatio(fg, g));

    // Sanity: the grounds must actually differ, or this test can't
    // distinguish min from max (or from a truncated grounds list).
    expect(new Set(ratios.map((r) => r.toFixed(6))).size).toBeGreaterThan(1);

    const expectedRatio = Math.min(...ratios);

    const check = contrastAudit(theme, appearance).find(
      (c) => c.id === "ink-popover-secondary/popover",
    );
    expect(check).toBeDefined();
    expect(check?.ratio).toBeCloseTo(expectedRatio, 6);
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
            expect(check.pass, `${check.id} ratio=${check.ratio} floor=${check.floor}`).toBe(true);
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
