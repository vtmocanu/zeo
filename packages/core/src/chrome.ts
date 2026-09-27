/**
 * PRD 10.2 — frameless chrome. Pure geometry and state for the resizable,
 * collapsible sidebar and the inset "card" every page, split pane and settings
 * view floats in. No DOM, no Electron: main and the renderer both derive their
 * bounds from {@link contentRect} and the exported constants below.
 */
import type { Rect } from "./window-state.js";
export type { Rect };

/** Sidebar width restored when no persisted width exists. */
export const SIDEBAR_DEFAULT_WIDTH = 240;
/** Minimum sidebar width a drag or a restored value can settle at. */
export const SIDEBAR_MIN_WIDTH = 200;
/** Maximum sidebar width a drag or a restored value can settle at. */
export const SIDEBAR_MAX_WIDTH = 360;
/** Inset, in px, between the window edge and every floating card. */
export const CARD_INSET = 8;
/** Height, in px, of the draggable window row atop the sidebar. */
export const WINDOW_ROW_HEIGHT = 44;
/** Width, in px, of the edge strip that reveals a collapsed sidebar. */
export const SIDEBAR_REVEAL_EDGE = 6;
/** Delay, in ms, before a revealed sidebar hides after the pointer leaves. */
export const SIDEBAR_HIDE_DELAY_MS = 400;
/** Corner radius, in px, drawn on every floating card. */
export const CARD_RADIUS = 10;
/** Traffic-light position within the window row, in px from the top-left. */
export const TRAFFIC_LIGHT_POSITION = { x: 14, y: 16 } as const;

/** Live sidebar/window-chrome state. `sidebarRevealed` is never persisted. */
export interface ChromeState {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  sidebarRevealed: boolean;
}

/** The subset of {@link ChromeState} that survives a relaunch. */
export type PersistedChrome = Pick<ChromeState, "sidebarWidth" | "sidebarCollapsed">;

/** Chrome state for a first run or a restore failure. */
export const DEFAULT_CHROME_STATE: ChromeState = {
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  sidebarCollapsed: false,
  sidebarRevealed: false,
};

/**
 * Clamps a candidate sidebar width to `[SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH]`,
 * rounding first. A non-finite input (`NaN`, `Infinity`) falls back to
 * {@link SIDEBAR_DEFAULT_WIDTH}.
 */
export function clampSidebarWidth(w: number): number {
  if (!Number.isFinite(w)) {
    return SIDEBAR_DEFAULT_WIDTH;
  }
  const rounded = Math.round(w);
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, rounded));
}

/** Whether the sidebar currently occupies space in the layout. */
export function sidebarVisible(chrome: ChromeState): boolean {
  return !chrome.sidebarCollapsed || chrome.sidebarRevealed;
}

/** The x-coordinate at which the page card's left edge starts. */
export function cardLeft(chrome: ChromeState): number {
  return sidebarVisible(chrome) ? chrome.sidebarWidth : CARD_INSET;
}

/**
 * Computes the page region's rectangle within the window's content area: the
 * card inset {@link CARD_INSET} from the top and right edges and the bottom,
 * with its left edge at {@link cardLeft}. Floored at 0 in both dimensions so a
 * window too small to seat the card never yields negative bounds.
 */
export function contentRect(contentW: number, contentH: number, chrome: ChromeState): Rect {
  const x = cardLeft(chrome);
  return {
    x,
    y: CARD_INSET,
    width: Math.max(0, contentW - x - CARD_INSET),
    height: Math.max(0, contentH - 2 * CARD_INSET),
  };
}

/** Returns `chrome` with its sidebar width replaced by a clamped `w`. */
export function withSidebarWidth(chrome: ChromeState, w: number): ChromeState {
  return { ...chrome, sidebarWidth: clampSidebarWidth(w) };
}

/**
 * Returns `chrome` with `sidebarRevealed` set to `revealed`. Returns the same
 * reference unchanged when the sidebar is not collapsed (reveal is meaningless
 * while it is already visible) or when the flag already matches.
 */
export function withSidebarRevealed(chrome: ChromeState, revealed: boolean): ChromeState {
  if (!chrome.sidebarCollapsed || chrome.sidebarRevealed === revealed) {
    return chrome;
  }
  return { ...chrome, sidebarRevealed: revealed };
}

/** Flips `sidebarCollapsed` and clears `sidebarRevealed`. */
export function toggleSidebar(chrome: ChromeState): ChromeState {
  return { ...chrome, sidebarCollapsed: !chrome.sidebarCollapsed, sidebarRevealed: false };
}

/**
 * Restores a {@link ChromeState} from a persisted value: `null` (first run or
 * a restore failure) yields {@link DEFAULT_CHROME_STATE}; otherwise the saved
 * width is clamped and `sidebarRevealed` starts false (it is never persisted).
 */
export function restoreChrome(saved: PersistedChrome | null): ChromeState {
  if (saved === null) {
    return DEFAULT_CHROME_STATE;
  }
  return {
    sidebarWidth: clampSidebarWidth(saved.sidebarWidth),
    sidebarCollapsed: saved.sidebarCollapsed,
    sidebarRevealed: false,
  };
}
