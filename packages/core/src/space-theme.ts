/**
 * Space-theme helpers: the default theme assigned to a newly created space,
 * the JSON codec used to persist a theme on a {@link SpaceRow}, the pure
 * transitions the theme picker (PRD 10.3 §6) applies, and the small color
 * helpers the space switcher and picker swatches use.
 *
 * No DOM, no Electron, no `node:*` imports — this module is used from both
 * the main and renderer processes and from plain Node tooling/tests.
 */

import {
  HUE_DEFINITIONS,
  MIGRATION_HUE_ORDER,
  SPACE_HUES,
  normalizeTheme,
  oklchToRgb,
  toHex,
  type SpaceHue,
  type SpaceTheme,
} from "./theme.js";
import type { SpacesState } from "./ipc.js";

/** Lightness used for the small swatch/dot colors shown in the picker and switcher. */
export const SPACE_DOT_LIGHTNESS = 0.66;
/** Chroma boost applied on top of a hue's base chroma for those swatch/dot colors. */
export const SPACE_DOT_CHROMA_BOOST = 0.02;
/** Offset into `SPACE_HUES` used to pick a second gradient stop from the first. */
export const GRADIENT_SECOND_STOP_OFFSET = 3;

/** The default theme for the `n`th space created (0-indexed by count, not history). */
export function defaultSpaceTheme(spaceCount: number): SpaceTheme {
  const index = ((spaceCount % MIGRATION_HUE_ORDER.length) + MIGRATION_HUE_ORDER.length) %
    MIGRATION_HUE_ORDER.length;
  return { stops: [MIGRATION_HUE_ORDER[index]], intensity: 1 };
}

/** Encodes a theme (or `null`) as the JSON text stored in `SpaceRow.theme`. */
export function encodeSpaceTheme(theme: SpaceTheme | null): string | null {
  if (theme === null) return null;
  return JSON.stringify({ stops: theme.stops, intensity: theme.intensity });
}

/**
 * Decodes the JSON text stored in `SpaceRow.theme` back into a theme,
 * returning `null` for `null`/`undefined` (rows written by an older desktop
 * layer that predates this column), invalid JSON, or anything
 * `normalizeTheme` rejects.
 */
export function decodeSpaceTheme(text: string | null | undefined): SpaceTheme | null {
  if (text === null || text === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return normalizeTheme(parsed);
}

/** Structural equality: both null, or equal stop count, hues in order and intensity. */
export function themesEqual(a: SpaceTheme | null, b: SpaceTheme | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.stops.length !== b.stops.length) return false;
  for (let i = 0; i < a.stops.length; i++) {
    if (a.stops[i] !== b.stops[i]) return false;
  }
  return a.intensity === b.intensity;
}

/** Deep-clones a theme (or passes through `null`) so callers can't mutate store state. */
export function cloneTheme(theme: SpaceTheme | null): SpaceTheme | null {
  if (theme === null) return null;
  return { stops: [...theme.stops] as SpaceTheme["stops"], intensity: theme.intensity };
}

/** The theme of the active space in `state`, or `null` for a null state or missing space. */
export function activeSpaceTheme(state: SpacesState | null): SpaceTheme | null {
  if (state === null) return null;
  const space = state.spaces.find((s) => s.id === state.activeSpaceId);
  return space ? space.theme : null;
}

/** The design book's flat swatch color for a hue, used by the picker and space-switcher dots. */
export function hueSwatchColor(hue: SpaceHue): string {
  const def = HUE_DEFINITIONS[hue];
  return toHex(oklchToRgb(SPACE_DOT_LIGHTNESS, def.c + SPACE_DOT_CHROMA_BOOST, def.h));
}

/**
 * The color (or gradient) shown for a space's switcher dot: `null` for a
 * null theme or intensity 0, a hex color for one stop, a 135deg linear
 * gradient for two.
 */
export function spaceDotColor(theme: SpaceTheme | null): string | null {
  if (theme === null || theme.intensity === 0) return null;
  if (theme.stops.length === 1) return hueSwatchColor(theme.stops[0]);
  return `linear-gradient(135deg, ${hueSwatchColor(theme.stops[0])}, ${hueSwatchColor(theme.stops[1])})`;
}

export type ThemeKind = "solid" | "gradient";

function asDraft(theme: SpaceTheme | null): SpaceTheme {
  return theme ?? { stops: ["iris"], intensity: 0 };
}

/** Switches a draft theme between one stop (solid) and two (gradient). Never returns null. */
export function pickerSetKind(theme: SpaceTheme | null, kind: ThemeKind): SpaceTheme {
  const draft = asDraft(theme);
  const intensity = draft.intensity === 0 ? 1 : draft.intensity;
  if (kind === "solid") {
    return { stops: [draft.stops[0]], intensity };
  }
  if (draft.stops.length === 2) {
    return { stops: draft.stops, intensity };
  }
  const secondIndex =
    (SPACE_HUES.indexOf(draft.stops[0]) + GRADIENT_SECOND_STOP_OFFSET) % SPACE_HUES.length;
  return { stops: [draft.stops[0], SPACE_HUES[secondIndex]], intensity };
}

/** Replaces one stop's hue in the draft theme. Never returns null; intensity 0 becomes 1. */
export function pickerSelectHue(
  theme: SpaceTheme | null,
  stopIndex: 0 | 1,
  hue: SpaceHue,
): SpaceTheme {
  const draft = asDraft(theme);
  const intensity = draft.intensity === 0 ? 1 : draft.intensity;
  const index = Math.min(stopIndex, draft.stops.length - 1);
  const stops = [...draft.stops] as [SpaceHue] | [SpaceHue, SpaceHue];
  stops[index] = hue;
  return { stops, intensity };
}

/** Sets the draft theme's intensity, snapped to the nearest 5% and clamped to [0, 100]. */
export function pickerSetIntensity(theme: SpaceTheme | null, percent: number): SpaceTheme {
  const draft = asDraft(theme);
  const snapped = Math.min(100, Math.max(0, Math.round(percent / 5) * 5));
  return { stops: draft.stops, intensity: snapped / 100 };
}
