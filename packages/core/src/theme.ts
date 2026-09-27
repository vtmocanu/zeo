/**
 * Pure theme function for zeo's design system (PRD 10.1, design book §3).
 *
 * Maps a nullable space theme (a hue or two-stop gradient plus an
 * intensity) and an appearance ("light" | "dark") to the full semantic
 * token set consumed by CSS custom properties. No DOM, no Electron, no
 * `node:*` imports: this module must stay usable from both the main and
 * renderer processes and from plain Node tooling/tests.
 *
 * `rgba(rgb, alpha)` strings below are emitted as CSS `rgb(r g b / alpha)`
 * with channels rounded to the nearest integer and the alpha rendered via
 * `String(alpha)` (e.g. `rgb(26 26 31 / 0.12)`). Every alpha value used
 * here is a "nice" decimal (0.06, 0.1, 0.88, ...) whose JS `String()`
 * form is stable and round-trips exactly, so this stays deterministic
 * across runs — required because these strings are copied verbatim into
 * `tokens.css` and compared for exact equality by the `apps/ui` parity test.
 */

export type SpaceHue =
  | "iris"
  | "violet"
  | "orchid"
  | "rose"
  | "coral"
  | "amber"
  | "lime"
  | "mint"
  | "teal"
  | "sky";

export const SPACE_HUES: readonly SpaceHue[] = [
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
];

export const HUE_DEFINITIONS: Readonly<
  Record<SpaceHue, { label: string; h: number; c: number }>
> = {
  iris: { label: "Iris", h: 277, c: 0.15 },
  violet: { label: "Violet", h: 305, c: 0.15 },
  orchid: { label: "Orchid", h: 338, c: 0.14 },
  rose: { label: "Rose", h: 12, c: 0.15 },
  coral: { label: "Coral", h: 42, c: 0.14 },
  amber: { label: "Amber", h: 78, c: 0.13 },
  lime: { label: "Lime", h: 128, c: 0.14 },
  mint: { label: "Mint", h: 162, c: 0.11 },
  teal: { label: "Teal", h: 198, c: 0.1 },
  sky: { label: "Sky", h: 240, c: 0.13 },
};

export const MIGRATION_HUE_ORDER: readonly SpaceHue[] = [
  "iris",
  "rose",
  "teal",
  "amber",
  "violet",
  "mint",
  "coral",
  "sky",
  "orchid",
  "lime",
];

export interface SpaceTheme {
  stops: [SpaceHue] | [SpaceHue, SpaceHue];
  intensity: number;
}

export type Appearance = "light" | "dark";

export const SEMANTIC_TOKENS = [
  "--surface-window",
  "--tint",
  "--tint-opacity",
  "--surface-card",
  "--surface-raised",
  "--surface-hover",
  "--fill-subtle",
  "--hairline",
  "--ink-primary",
  "--ink-secondary",
  "--accent",
  "--accent-soft",
  "--ink-on-accent",
  "--focus-ring",
  "--danger",
  "--ink-on-danger",
  "--surface-popover",
  "--ink-popover",
  "--ink-popover-secondary",
  "--popover-hairline",
  "--popover-hairline-strong",
  "--popover-hover",
  "--popover-well",
  "--control-raised",
  "--scrim",
  "--shadow-raised",
  "--shadow-card",
  "--shadow-popover",
  "--shadow-palette",
] as const;
export type SemanticToken = (typeof SEMANTIC_TOKENS)[number];

export type Rgb = readonly [number, number, number];

export interface ThemeReport {
  grounds: Rgb[];
  ink: Rgb;
  inkSecondary: Rgb;
  accent: Rgb;
  inkContrast: number;
  inkSecondaryContrast: number;
  accentContrast: number;
  popoverSecondaryContrast: number;
  inkOnAccentContrast: number;
}

// ---------------------------------------------------------------------------
// Constants (design book §3)
// ---------------------------------------------------------------------------

const WINDOW_BASE: Record<Appearance, Rgb> = {
  light: [234, 234, 238],
  dark: [32, 32, 36],
};

const CARD_BASE: Record<Appearance, Rgb> = {
  light: [255, 255, 255],
  dark: [27, 27, 31],
};

const POPOVER_BASE: Record<Appearance, Rgb> = {
  light: [250, 250, 252],
  dark: [44, 44, 49],
};

const INK_DARK: Rgb = [26, 26, 31];
const INK_LIGHT: Rgb = [245, 245, 247];
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

const TINT_LIGHTNESS: Record<Appearance, number> = { light: 0.78, dark: 0.48 };
const MAX_TINT_OPACITY: Record<Appearance, number> = { light: 0.55, dark: 0.35 };

// ---------------------------------------------------------------------------
// Color math
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function srgbEncode(linear: number): number {
  const c = clamp01(linear);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function srgbDecode(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * OKLCH -> OKLab -> linear sRGB -> gamma-encoded sRGB. Each linear channel
 * is clamped to 0-1 before gamma encoding; the result is returned as
 * 0-255 floats (unrounded — callers that need integers use {@link toHex}
 * or round explicitly).
 */
export function oklchToRgb(l: number, c: number, h: number): Rgb {
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b;

  const lCubed = l_ * l_ * l_;
  const mCubed = m_ * m_ * m_;
  const sCubed = s_ * s_ * s_;

  const rLin = 4.0767416621 * lCubed - 3.3077115913 * mCubed + 0.2309699292 * sCubed;
  const gLin = -1.2684380046 * lCubed + 2.6097574011 * mCubed - 0.3413193965 * sCubed;
  const bLin = -0.0041960863 * lCubed - 0.7034186147 * mCubed + 1.7076147010 * sCubed;

  return [
    srgbEncode(rLin) * 255,
    srgbEncode(gLin) * 255,
    srgbEncode(bLin) * 255,
  ];
}

function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => srgbDecode(clamp01(c / 255)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export function toHex(c: Rgb): string {
  return (
    "#" +
    c
      .map((channel) => {
        const clamped = Math.min(255, Math.max(0, Math.round(channel)));
        return clamped.toString(16).padStart(2, "0");
      })
      .join("")
  );
}

function roundRgb(c: Rgb): Rgb {
  return c.map((channel) => Math.round(Math.min(255, Math.max(0, channel)))) as unknown as Rgb;
}

function rgba(c: Rgb, alpha: number): string {
  const [r, g, b] = roundRgb(c);
  return `rgb(${r} ${g} ${b} / ${alpha})`;
}

function mix(from: Rgb, to: Rgb, t: number): Rgb {
  return [
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
  ];
}

function average(rgbs: Rgb[]): Rgb {
  const sum = rgbs.reduce<[number, number, number]>(
    (acc, c) => [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]],
    [0, 0, 0],
  );
  return [sum[0] / rgbs.length, sum[1] / rgbs.length, sum[2] / rgbs.length];
}

function minContrast(candidate: Rgb, grounds: Rgb[]): number {
  return Math.min(...grounds.map((ground) => contrastRatio(candidate, ground)));
}

/**
 * The alpha each token layer is emitted at (design book §3 / the token
 * table). Shared between the background-compositing helpers below (used to
 * build the contrast-sweep backgrounds) and `themeTokens` (which emits the
 * literal `rgb(r g b / a)` strings) so the two never drift apart.
 */
const SURFACE_RAISED_ALPHA = (isInkDark: boolean): number => (isInkDark ? 0.8 : 0.15);
const SURFACE_HOVER_ALPHA = (isDark: boolean): number => (isDark ? 0.1 : 0.08);
const FILL_SUBTLE_ALPHA = (isDark: boolean): number => (isDark ? 0.09 : 0.06);
const POPOVER_WELL_ALPHA = 0.035;
const POPOVER_HOVER_ALPHA = 0.07;
const CONTROL_RAISED_ALPHA = (isDark: boolean): number => (isDark ? 0.14 : 1);

/**
 * Alpha-composite `overlay` (at `alpha`) over `background`: the token
 * color's channels rounded to the integers CSS actually emits (matching
 * `rgba()`/`toHex()` above), alpha-blended over the *float* background, per
 * the spec ("alpha blend of the token color at its alpha"). The background
 * is never rounded — grounds are floats derived from OKLCH mixes, and only
 * the compositing itself should introduce rounding, matching what the
 * browser renders when a rounded-channel CSS layer sits over an arbitrary
 * backdrop.
 */
function compositeOver(overlay: Rgb, alpha: number, background: Rgb): Rgb {
  const ov = roundRgb(overlay);
  return [0, 1, 2].map((i) => ov[i] * alpha + background[i] * (1 - alpha)) as unknown as Rgb;
}

/**
 * The four backgrounds secondary text can sit on for each window ground:
 * the ground itself, and the ground with `--surface-raised`,
 * `--surface-hover` and `--fill-subtle` composited over it.
 */
function windowBackgrounds(
  grounds: Rgb[],
  ink: Rgb,
  isInkDark: boolean,
  isDark: boolean,
): Rgb[] {
  const raisedAlpha = SURFACE_RAISED_ALPHA(isInkDark);
  const hoverAlpha = SURFACE_HOVER_ALPHA(isDark);
  const subtleAlpha = FILL_SUBTLE_ALPHA(isDark);
  const backgrounds: Rgb[] = [];
  for (const ground of grounds) {
    backgrounds.push(ground);
    backgrounds.push(compositeOver(WHITE, raisedAlpha, ground));
    backgrounds.push(compositeOver(ink, hoverAlpha, ground));
    backgrounds.push(compositeOver(ink, subtleAlpha, ground));
  }
  return backgrounds;
}

/**
 * The popover backgrounds secondary popover text can sit on: the popover
 * base, and the base with `--popover-well`, `--popover-hover` and
 * `--control-raised` composited over it.
 */
function popoverBackgrounds(popoverBase: Rgb, popoverInk: Rgb, isDark: boolean): Rgb[] {
  const controlRaisedAlpha = CONTROL_RAISED_ALPHA(isDark);
  return [
    popoverBase,
    compositeOver(popoverInk, POPOVER_WELL_ALPHA, popoverBase),
    compositeOver(popoverInk, POPOVER_HOVER_ALPHA, popoverBase),
    compositeOver(WHITE, controlRaisedAlpha, popoverBase),
  ];
}

function clampIntensity(raw: number): number {
  if (Number.isNaN(raw)) return 0;
  return clamp01(raw);
}

// ---------------------------------------------------------------------------
// normalizeTheme
// ---------------------------------------------------------------------------

const SPACE_HUE_SET: ReadonlySet<string> = new Set(SPACE_HUES);

export function normalizeTheme(value: unknown): SpaceTheme | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;

  const stopsRaw = record.stops;
  if (!Array.isArray(stopsRaw) || stopsRaw.length < 1 || stopsRaw.length > 2) {
    return null;
  }
  for (const stop of stopsRaw) {
    if (typeof stop !== "string" || !SPACE_HUE_SET.has(stop)) return null;
  }
  const stops = stopsRaw as SpaceHue[];

  const intensityRaw = record.intensity;
  if (typeof intensityRaw !== "number" || !Number.isFinite(intensityRaw)) {
    return null;
  }
  const intensity = clamp01(intensityRaw);

  return {
    stops: stops.length === 1 ? [stops[0]] : [stops[0], stops[1]],
    intensity,
  };
}

// ---------------------------------------------------------------------------
// themeReport
// ---------------------------------------------------------------------------

const DANGER: Record<Appearance, Rgb> = {
  light: oklchToRgb(0.55, 0.2, 27),
  dark: oklchToRgb(0.7, 0.17, 25),
};

interface InternalReport extends ThemeReport {
  isInkDark: boolean;
  danger: Rgb;
  inkOnDanger: Rgb;
  inkOnAccent: Rgb;
  popoverInk: Rgb;
  popoverSecondaryInk: Rgb;
  popoverBase: Rgb;
  card: Rgb;
  base: Rgb;
  tintOpacity: number;
  tintStops: Rgb[];
}

function computeInternalReport(theme: SpaceTheme | null, appearance: Appearance): InternalReport {
  const base = WINDOW_BASE[appearance];
  const card = CARD_BASE[appearance];
  const popoverBase = POPOVER_BASE[appearance];
  const tintL = TINT_LIGHTNESS[appearance];
  const maxTintOpacity = MAX_TINT_OPACITY[appearance];

  const intensity = clampIntensity(theme?.intensity ?? 0);

  const tintStops: Rgb[] =
    theme && intensity > 0
      ? theme.stops.map((hue) => {
          const def = HUE_DEFINITIONS[hue];
          return oklchToRgb(tintL, def.c, def.h);
        })
      : [];
  const tintOpacity = tintStops.length > 0 ? maxTintOpacity * intensity : 0;

  const grounds: Rgb[] =
    tintStops.length > 0
      ? tintStops.map((stop) => mix(base, stop, tintOpacity))
      : [base];

  // Ink: the candidate with the higher minimum contrast across grounds.
  const darkMin = minContrast(INK_DARK, grounds);
  const lightMin = minContrast(INK_LIGHT, grounds);
  const isInkDark = darkMin >= lightMin;
  const ink = isInkDark ? INK_DARK : INK_LIGHT;
  const inkContrast = isInkDark ? darkMin : lightMin;

  // Ink secondary: mix the average ground toward the ink until the
  // candidate holds 4.5:1 against every window background — each ground,
  // plus each ground with --surface-raised, --surface-hover and
  // --fill-subtle composited over it.
  const avgGround = average(grounds);
  const windowBgs = windowBackgrounds(grounds, ink, isInkDark, appearance === "dark");
  let inkSecondary = ink;
  let inkSecondaryContrast = minContrast(ink, windowBgs);
  for (let step = 56; step <= 100; step += 2) {
    const m = step / 100;
    // Round the candidate before measuring: toHex emits the rounded color,
    // so what gets measured here must be what CSS actually renders.
    const candidate = roundRgb(mix(avgGround, ink, m));
    const candidateContrast = minContrast(candidate, windowBgs);
    if (candidateContrast >= 4.5) {
      inkSecondary = candidate;
      inkSecondaryContrast = candidateContrast;
      break;
    }
  }

  // Accent.
  const accentHue = theme ? theme.stops[0] : "iris";
  const accentHueDef = HUE_DEFINITIONS[accentHue];
  const accentChroma = Math.min(accentHueDef.c + 0.03, 0.19);
  let accentLightness = appearance === "light" ? 0.54 : 0.76;
  const lightnessStep = appearance === "light" ? -0.02 : 0.02;
  let accent: Rgb = oklchToRgb(accentLightness, accentChroma, accentHueDef.h);
  for (let i = 0; i < 14; i++) {
    accent = oklchToRgb(accentLightness, accentChroma, accentHueDef.h);
    const cardContrast = contrastRatio(accent, card);
    const groundsContrast = minContrast(accent, grounds);
    if (cardContrast >= 3 && groundsContrast >= 3) break;
    accentLightness += lightnessStep;
  }

  // Ink on accent. Once chosen, the ink stays fixed; if the contrast against
  // the rounded accent (what `toHex` actually emits) falls short of WCAG AA
  // (4.5:1), nudge the accent's OKLCH lightness away from the ink in 0.02
  // steps (hue, chroma and ink unchanged) until it clears the floor.
  const inkOnAccent =
    contrastRatio(WHITE, accent) >= contrastRatio(INK_DARK, accent) ? WHITE : INK_DARK;
  const inkOnAccentIsWhite = inkOnAccent === WHITE;
  const inkOnAccentStep = inkOnAccentIsWhite ? -0.02 : 0.02;
  let inkOnAccentContrast = contrastRatio(inkOnAccent, roundRgb(accent));
  for (let i = 0; i < 60 && inkOnAccentContrast < 4.5; i++) {
    accentLightness += inkOnAccentStep;
    accent = oklchToRgb(accentLightness, accentChroma, accentHueDef.h);
    inkOnAccentContrast = contrastRatio(inkOnAccent, roundRgb(accent));
  }
  const accentContrast = Math.min(contrastRatio(accent, card), minContrast(accent, grounds));

  // Popover ink. Secondary: mix the popover base toward the popover ink
  // until the candidate holds 4.5:1 against every popover background —
  // the base, plus the base with --popover-well, --popover-hover and
  // --control-raised composited over it.
  const popoverInk = appearance === "light" ? INK_DARK : INK_LIGHT;
  const popoverBgs = popoverBackgrounds(popoverBase, popoverInk, appearance === "dark");
  let popoverSecondaryInk = popoverInk;
  let popoverSecondaryContrast = minContrast(popoverInk, popoverBgs);
  for (let step = 50; step <= 100; step += 2) {
    const m = step / 100;
    // Round the candidate before measuring, for the same reason as above:
    // toHex emits the rounded color.
    const candidate = roundRgb(mix(popoverBase, popoverInk, m));
    const candidateContrast = minContrast(candidate, popoverBgs);
    if (candidateContrast >= 4.5) {
      popoverSecondaryInk = candidate;
      popoverSecondaryContrast = candidateContrast;
      break;
    }
  }

  // Ink on danger: white or the dark ink, whichever has higher contrast
  // on the danger color.
  const danger = DANGER[appearance];
  const inkOnDanger =
    contrastRatio(WHITE, danger) >= contrastRatio(INK_DARK, danger) ? WHITE : INK_DARK;

  return {
    grounds,
    ink,
    inkSecondary,
    accent,
    inkContrast,
    inkSecondaryContrast,
    accentContrast,
    popoverSecondaryContrast,
    inkOnAccentContrast,
    isInkDark,
    danger,
    inkOnDanger,
    inkOnAccent,
    popoverInk,
    popoverSecondaryInk,
    popoverBase,
    card,
    base,
    tintOpacity,
    tintStops,
  };
}

export function themeReport(theme: SpaceTheme | null, appearance: Appearance): ThemeReport {
  const {
    grounds,
    ink,
    inkSecondary,
    accent,
    inkContrast,
    inkSecondaryContrast,
    accentContrast,
    popoverSecondaryContrast,
    inkOnAccentContrast,
  } = computeInternalReport(theme, appearance);
  return {
    grounds,
    ink,
    inkSecondary,
    accent,
    inkContrast,
    inkSecondaryContrast,
    accentContrast,
    popoverSecondaryContrast,
    inkOnAccentContrast,
  };
}

// ---------------------------------------------------------------------------
// themeTokens
// ---------------------------------------------------------------------------

export function themeTokens(
  theme: SpaceTheme | null,
  appearance: Appearance,
): Record<SemanticToken, string> {
  const report = computeInternalReport(theme, appearance);
  const isDark = appearance === "dark";

  const tint =
    report.tintStops.length === 0
      ? "transparent"
      : report.tintStops.length === 1
        ? toHex(report.tintStops[0])
        : `linear-gradient(160deg, ${toHex(report.tintStops[0])}, ${toHex(report.tintStops[1])})`;

  const shadowRaised = report.isInkDark
    ? "0 1px 2px rgb(0 0 0 / .08), 0 0 0 .5px rgb(0 0 0 / .06)"
    : "0 1px 2px rgb(0 0 0 / .3)";

  const shadowCard = isDark
    ? "0 0 0 1px rgb(255 255 255 / .07), 0 1px 3px rgb(0 0 0 / .4), 0 8px 24px rgb(0 0 0 / .28)"
    : "0 0 0 1px rgb(0 0 0 / .07), 0 1px 2px rgb(0 0 0 / .06), 0 6px 18px rgb(0 0 0 / .06)";

  const shadowPopover = isDark
    ? "0 0 0 1px rgb(255 255 255 / .09), 0 10px 30px rgb(0 0 0 / .45)"
    : "0 0 0 1px rgb(0 0 0 / .06), 0 10px 30px rgb(0 0 0 / .14), 0 2px 6px rgb(0 0 0 / .06)";

  const shadowPalette = isDark
    ? "0 0 0 1px rgb(255 255 255 / .1), 0 28px 70px rgb(0 0 0 / .6)"
    : "0 0 0 1px rgb(0 0 0 / .06), 0 28px 70px rgb(0 0 0 / .22), 0 6px 18px rgb(0 0 0 / .08)";

  return {
    "--surface-window": rgba(report.base, 0.88),
    "--tint": tint,
    "--tint-opacity": report.tintOpacity.toFixed(3),
    "--surface-card": toHex(report.card),
    "--surface-raised": rgba(WHITE, SURFACE_RAISED_ALPHA(report.isInkDark)),
    "--surface-hover": rgba(report.ink, SURFACE_HOVER_ALPHA(isDark)),
    "--fill-subtle": rgba(report.ink, FILL_SUBTLE_ALPHA(isDark)),
    "--hairline": rgba(report.ink, 0.12),
    "--ink-primary": toHex(report.ink),
    "--ink-secondary": toHex(report.inkSecondary),
    "--accent": toHex(report.accent),
    "--accent-soft": isDark ? rgba(report.accent, 0.3) : rgba(report.accent, 0.16),
    "--ink-on-accent": toHex(report.inkOnAccent),
    "--focus-ring": toHex(report.accent),
    "--danger": toHex(report.danger),
    "--ink-on-danger": toHex(report.inkOnDanger),
    "--surface-popover": rgba(report.popoverBase, 0.94),
    "--ink-popover": toHex(report.popoverInk),
    "--ink-popover-secondary": toHex(report.popoverSecondaryInk),
    "--popover-hairline": rgba(report.popoverInk, 0.1),
    "--popover-hairline-strong": rgba(report.popoverInk, 0.28),
    "--popover-hover": rgba(report.popoverInk, POPOVER_HOVER_ALPHA),
    "--popover-well": rgba(report.popoverInk, POPOVER_WELL_ALPHA),
    "--control-raised": isDark ? rgba(WHITE, CONTROL_RAISED_ALPHA(true)) : "#ffffff",
    "--scrim": isDark ? rgba(BLACK, 0.34) : rgba([24, 24, 32], 0.14),
    "--shadow-raised": shadowRaised,
    "--shadow-card": shadowCard,
    "--shadow-popover": shadowPopover,
    "--shadow-palette": shadowPalette,
  };
}
