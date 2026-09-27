/**
 * Contrast audit for zeo's design system (PRD 10.7 §8, design book §8).
 *
 * Re-checks the 10.1 guarantees on composited surfaces (raised, hover,
 * fill-subtle, popover, popover-secondary, accent-soft) and adds the pairs
 * the 10.1 sweep does not cover. Pure: no DOM, no Electron, no `node:*`
 * imports.
 */

import { contrastRatio, themeReport, themeTokens, type Appearance, type Rgb, type SpaceTheme } from "./theme.js";

export type ContrastCheckId =
  | "ink-primary/window"
  | "ink-secondary/window"
  | "ink-primary/raised"
  | "ink-secondary/raised"
  | "ink-secondary/hover"
  | "ink-secondary/fill-subtle"
  | "accent/window"
  | "accent/card"
  | "focus-ring/raised"
  | "focus-ring/popover"
  | "ink-on-accent/accent"
  | "ink-popover/popover"
  | "ink-popover-secondary/popover"
  | "ink-popover/accent-soft"
  | "ink-on-danger/danger"
  | "danger/popover"
  | "danger/card";

export interface ContrastCheck {
  id: ContrastCheckId;
  ratio: number;
  floor: 3 | 4.5;
  pass: boolean;
}

/**
 * Parses the two color forms `themeTokens` emits: `#rrggbb` and
 * `rgb(r g b / a)`. Anything else (`transparent`, `linear-gradient(...)`,
 * or a bare keyword like `red`) returns `null`.
 */
export function parseCssColor(value: string): { rgb: Rgb; alpha: number } | null {
  const hexMatch = /^#([0-9a-fA-F]{6})$/.exec(value);
  if (hexMatch) {
    const n = parseInt(hexMatch[1], 16);
    return { rgb: [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff], alpha: 1 };
  }
  const rgbMatch = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(value);
  if (rgbMatch) {
    return {
      rgb: [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])],
      alpha: Number(rgbMatch[4]),
    };
  }
  return null;
}

/** Composites a parsed color layer over a single opaque ground. */
function compositeOver(top: { rgb: Rgb; alpha: number }, ground: Rgb): Rgb {
  return [0, 1, 2].map((i) => ground[i] + (top.rgb[i] - ground[i]) * top.alpha) as unknown as Rgb;
}

/** Composites a token's CSS value over each of a set of grounds. */
function layerOverGrounds(tokenValue: string, grounds: readonly Rgb[]): Rgb[] {
  const parsed = parseCssColor(tokenValue);
  if (!parsed) {
    throw new Error(`contrast-audit: unparseable color token "${tokenValue}"`);
  }
  return grounds.map((ground) => compositeOver(parsed, ground));
}

/** The worst-case (lowest) contrast of a foreground across a set of grounds. */
function worstContrast(fg: Rgb, grounds: readonly Rgb[]): number {
  return Math.min(...grounds.map((ground) => contrastRatio(fg, ground)));
}

function requireOpaque(value: string): Rgb {
  const parsed = parseCssColor(value);
  if (!parsed) {
    throw new Error(`contrast-audit: unexpected token format "${value}"`);
  }
  return parsed.rgb;
}

/**
 * Runs the §8 contrast audit for a theme/appearance pair. Every ratio is the
 * worst case across the check's grounds; the floor is 3:1 for `accent/*` and
 * `focus-ring/*` checks, 4.5:1 for every other check.
 */
export function contrastAudit(theme: SpaceTheme | null, appearance: Appearance): ContrastCheck[] {
  const tokens = themeTokens(theme, appearance);
  const report = themeReport(theme, appearance);

  const windowGrounds: Rgb[] = report.grounds;
  // "The color of --surface-window": the translucent window-chrome color
  // composited over each window ground.
  const surfaceWindowGrounds = layerOverGrounds(tokens["--surface-window"], windowGrounds);
  const raisedGrounds = layerOverGrounds(tokens["--surface-raised"], windowGrounds);
  const hoverGrounds = layerOverGrounds(tokens["--surface-hover"], windowGrounds);
  const fillSubtleGrounds = layerOverGrounds(tokens["--fill-subtle"], windowGrounds);
  const popoverGrounds = layerOverGrounds(tokens["--surface-popover"], surfaceWindowGrounds);
  const popoverSecondaryGrounds = [
    ...popoverGrounds,
    ...layerOverGrounds(tokens["--popover-well"], popoverGrounds),
    ...layerOverGrounds(tokens["--popover-hover"], popoverGrounds),
    ...layerOverGrounds(tokens["--control-raised"], popoverGrounds),
  ];
  const accentSoftGrounds = layerOverGrounds(tokens["--accent-soft"], popoverGrounds);

  const cardGround = requireOpaque(tokens["--surface-card"]);
  const accentGround = requireOpaque(tokens["--accent"]);
  const dangerGround = requireOpaque(tokens["--danger"]);

  const fg = (name: keyof typeof tokens): Rgb => requireOpaque(tokens[name]);

  const entries: { id: ContrastCheckId; fg: Rgb; grounds: readonly Rgb[]; floor: 3 | 4.5 }[] = [
    { id: "ink-primary/window", fg: fg("--ink-primary"), grounds: windowGrounds, floor: 4.5 },
    { id: "ink-secondary/window", fg: fg("--ink-secondary"), grounds: windowGrounds, floor: 4.5 },
    { id: "ink-primary/raised", fg: fg("--ink-primary"), grounds: raisedGrounds, floor: 4.5 },
    { id: "ink-secondary/raised", fg: fg("--ink-secondary"), grounds: raisedGrounds, floor: 4.5 },
    { id: "ink-secondary/hover", fg: fg("--ink-secondary"), grounds: hoverGrounds, floor: 4.5 },
    {
      id: "ink-secondary/fill-subtle",
      fg: fg("--ink-secondary"),
      grounds: fillSubtleGrounds,
      floor: 4.5,
    },
    { id: "accent/window", fg: fg("--accent"), grounds: windowGrounds, floor: 3 },
    { id: "accent/card", fg: fg("--accent"), grounds: [cardGround], floor: 3 },
    { id: "focus-ring/raised", fg: fg("--focus-ring"), grounds: raisedGrounds, floor: 3 },
    { id: "focus-ring/popover", fg: fg("--focus-ring"), grounds: popoverGrounds, floor: 3 },
    { id: "ink-on-accent/accent", fg: fg("--ink-on-accent"), grounds: [accentGround], floor: 4.5 },
    { id: "ink-popover/popover", fg: fg("--ink-popover"), grounds: popoverGrounds, floor: 4.5 },
    {
      id: "ink-popover-secondary/popover",
      fg: fg("--ink-popover-secondary"),
      grounds: popoverSecondaryGrounds,
      floor: 4.5,
    },
    {
      id: "ink-popover/accent-soft",
      fg: fg("--ink-popover"),
      grounds: accentSoftGrounds,
      floor: 4.5,
    },
    { id: "ink-on-danger/danger", fg: fg("--ink-on-danger"), grounds: [dangerGround], floor: 4.5 },
    { id: "danger/popover", fg: fg("--danger"), grounds: popoverGrounds, floor: 4.5 },
    { id: "danger/card", fg: fg("--danger"), grounds: [cardGround], floor: 4.5 },
  ];

  return entries.map(({ id, fg: fgColor, grounds, floor }) => {
    const ratio = worstContrast(fgColor, grounds);
    return { id, ratio, floor, pass: ratio >= floor };
  });
}
