/**
 * Space-theme core contract (PRD 10.3 §1): the pure helpers that build,
 * codec, compare, and derive display colors from a {@link SpaceTheme}, plus
 * the picker's pure state-transition functions. No DOM, no Electron, no
 * `node:*` imports.
 */

import {
  HUE_DEFINITIONS,
  MIGRATION_HUE_ORDER,
  SPACE_HUES,
  normalizeTheme,
  oklchToRgb,
  toHex,
} from "./theme.js";
import type { SpaceHue, SpaceTheme } from "./theme.js";
import type { SpacesState } from "./ipc.js";

/** The lightness `hueSwatchColor` renders every hue's design-book swatch at. */
export const SPACE_DOT_LIGHTNESS = 0.66;
/** The chroma boost `hueSwatchColor` adds on top of each hue's base chroma. */
export const SPACE_DOT_CHROMA_BOOST = 0.02;
/** The offset (in `SPACE_HUES` order) `pickerSetKind` picks the second stop at. */
export const GRADIENT_SECOND_STOP_OFFSET = 3;

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * The theme a fresh space at position `spaceCount` (the count of spaces that
 * existed BEFORE it) receives: a single stop from {@link MIGRATION_HUE_ORDER},
 * cycling every ten spaces, at full intensity.
 */
export function defaultSpaceTheme(spaceCount: number): SpaceTheme {
  const index =
    ((spaceCount % MIGRATION_HUE_ORDER.length) + MIGRATION_HUE_ORDER.length) %
    MIGRATION_HUE_ORDER.length;
  return { stops: [MIGRATION_HUE_ORDER[index]], intensity: 1 };
}

/** Serializes a theme to JSON text for storage, or `null` for a null theme. */
export function encodeSpaceTheme(theme: SpaceTheme | null): string | null {
  if (theme === null) return null;
  return JSON.stringify({ stops: theme.stops, intensity: theme.intensity });
}

/**
 * Parses stored theme text back to a normalized {@link SpaceTheme}, or `null`
 * for `null` input, unparsable JSON, or anything {@link normalizeTheme}
 * rejects. Never throws.
 */
export function decodeSpaceTheme(text: string | null): SpaceTheme | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return normalizeTheme(parsed);
}

/** Whether two (possibly null) themes are equal: same stops, in order, and intensity. */
export function themesEqual(a: SpaceTheme | null, b: SpaceTheme | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.stops.length !== b.stops.length) return false;
  for (let i = 0; i < a.stops.length; i++) {
    if (a.stops[i] !== b.stops[i]) return false;
  }
  return a.intensity === b.intensity;
}

/** A defensive copy of a (possibly null) theme, safe to mutate independently. */
export function cloneTheme(theme: SpaceTheme | null): SpaceTheme | null {
  if (theme === null) return null;
  return {
    stops: theme.stops.length === 1 ? [theme.stops[0]] : [theme.stops[0], theme.stops[1]],
    intensity: theme.intensity,
  };
}

/**
 * The theme of the space named by `state.activeSpaceId` — `null` for a null
 * state or when no space in `state.spaces` has that id.
 */
export function activeSpaceTheme(state: SpacesState | null): SpaceTheme | null {
  if (state === null) return null;
  const space = state.spaces.find((s) => s.id === state.activeSpaceId);
  return space ? space.theme : null;
}

/**
 * The design book's swatch color for a hue: the hue's base chroma boosted by
 * {@link SPACE_DOT_CHROMA_BOOST} at {@link SPACE_DOT_LIGHTNESS}, the same in
 * both appearances.
 */
export function hueSwatchColor(hue: SpaceHue): string {
  const def = HUE_DEFINITIONS[hue];
  return toHex(oklchToRgb(SPACE_DOT_LIGHTNESS, def.c + SPACE_DOT_CHROMA_BOOST, def.h));
}

/**
 * The color (or gradient) a space-switcher dot renders for `theme`: `null`
 * for a null theme or intensity 0, the single stop's swatch color for one
 * stop, or a 135deg gradient between both stops' swatch colors for two.
 */
export function spaceDotColor(theme: SpaceTheme | null): string | null {
  if (theme === null || theme.intensity === 0) return null;
  if (theme.stops.length === 1) return hueSwatchColor(theme.stops[0]);
  return `linear-gradient(135deg, ${hueSwatchColor(theme.stops[0])}, ${hueSwatchColor(theme.stops[1])})`;
}

export type ThemeKind = "solid" | "gradient";

/** A `null` draft is treated as this theme by every picker transition below. */
const NULL_DRAFT: SpaceTheme = { stops: ["iris"], intensity: 0 };

function draftOf(theme: SpaceTheme | null): SpaceTheme {
  return theme === null ? NULL_DRAFT : theme;
}

/**
 * Switches a theme between solid (one stop) and gradient (two stops). Solid
 * keeps only `stops[0]`; gradient on a one-stop theme appends the hue
 * {@link GRADIENT_SECOND_STOP_OFFSET} steps ahead (wrapping) in
 * {@link SPACE_HUES} order. Already being the requested kind is a no-op on
 * the stops. A `null`/intensity-0 draft's intensity becomes 1.
 */
export function pickerSetKind(theme: SpaceTheme | null, kind: ThemeKind): SpaceTheme {
  const draft = draftOf(theme);
  const intensity = draft.intensity === 0 ? 1 : draft.intensity;
  if (kind === "solid") {
    return { stops: [draft.stops[0]], intensity };
  }
  if (draft.stops.length === 2) {
    return { stops: [...draft.stops] as [SpaceHue, SpaceHue], intensity };
  }
  const firstIndex = SPACE_HUES.indexOf(draft.stops[0]);
  const secondHue = SPACE_HUES[(firstIndex + GRADIENT_SECOND_STOP_OFFSET) % SPACE_HUES.length];
  return { stops: [draft.stops[0], secondHue], intensity };
}

/**
 * Replaces the stop at `stopIndex` (clamped to the last valid stop when the
 * theme has fewer stops) with `hue`. A `null`/intensity-0 draft's intensity
 * becomes 1, so picking a color on an untinted space shows it.
 */
export function pickerSelectHue(
  theme: SpaceTheme | null,
  stopIndex: 0 | 1,
  hue: SpaceHue,
): SpaceTheme {
  const draft = draftOf(theme);
  const index = Math.min(stopIndex, draft.stops.length - 1);
  const stops = [...draft.stops] as [SpaceHue] | [SpaceHue, SpaceHue];
  stops[index] = hue;
  const intensity = draft.intensity === 0 ? 1 : draft.intensity;
  return { stops, intensity };
}

/**
 * Sets the intensity from a 0-100 percent, snapped to the nearest 5 and
 * clamped. A non-finite percent (e.g. `NaN`) maps to 0.
 */
export function pickerSetIntensity(theme: SpaceTheme | null, percent: number): SpaceTheme {
  const draft = draftOf(theme);
  const safePercent = Number.isFinite(percent) ? percent : 0;
  const snapped = clamp01((Math.round(safePercent / 5) * 5) / 100);
  return { stops: [...draft.stops] as [SpaceHue] | [SpaceHue, SpaceHue], intensity: snapped };
}
