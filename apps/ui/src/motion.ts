/**
 * Motion helpers for the UI renderers (PRD 10.7 §3, design book §7).
 *
 * These read the DOM (computed styles, `<html>` classList) and React, so they
 * live in `apps/ui`, unlike the pure constants and `detectSpaceSwitch` in
 * `@zeo/core`'s `motion.ts`.
 */
import { useLayoutEffect, useRef, type RefObject } from "react";
import { themeTokens, type Appearance, type SpaceTheme } from "@zeo/core";

export type MotionToken = "--motion-fast" | "--motion-base" | "--motion-space";

/** Turns a CSS time such as `"320ms"` or `"0.12s"` into a millisecond count.
 *  Empty or unparsable input gives 0. */
export function parseDurationMs(value: string): number {
  const trimmed = value.trim();
  const match = /^(-?\d*\.?\d+)(m?s)$/i.exec(trimmed);
  if (!match) return 0;
  const amount = Number.parseFloat(match[1]);
  if (Number.isNaN(amount)) return 0;
  return match[2].toLowerCase() === "ms" ? amount : amount * 1000;
}

/** The current computed duration of `token` on `<html>`, in milliseconds. */
export function motionMs(token: MotionToken): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue(token);
  return parseDurationMs(value);
}

/** True when `<html>` carries `zeo-motion-off` (set by `main.tsx` under
 *  `ZEO_E2E=1` without `ZEO_E2E_MOTION`). */
export function motionDisabled(): boolean {
  return document.documentElement.classList.contains("zeo-motion-off");
}

/** Restarts a CSS animation on `element` without remounting it: removes
 *  `className`, forces a reflow by reading `offsetWidth`, then re-adds it. */
export function replayClass(element: HTMLElement, className: string): void {
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
}

export type SpaceSwitchDirectionClass =
  | "sidebar__space--enter-forward"
  | "sidebar__space--enter-backward"
  | "sidebar__space--enter-fade";

const SPACE_MOTION_CLASSES: readonly SpaceSwitchDirectionClass[] = [
  "sidebar__space--enter-forward",
  "sidebar__space--enter-backward",
  "sidebar__space--enter-fade",
];

/** Maps a `detectSpaceSwitch` direction (`null` meaning "fade") to the CSS
 *  class that animates it. */
export function spaceSwitchDirectionClass(
  direction: "forward" | "backward" | null,
): SpaceSwitchDirectionClass {
  return direction === "forward"
    ? "sidebar__space--enter-forward"
    : direction === "backward"
      ? "sidebar__space--enter-backward"
      : "sidebar__space--enter-fade";
}

/**
 * Restarts the sidebar space-switch animation on `element`: removes all
 * three `sidebar__space--enter-*` classes (so a stale one from a previous
 * switch can never outrank the current one in source order), forces a
 * reflow, then adds `className`.
 */
export function replaySpaceMotion(
  element: HTMLElement,
  className: SpaceSwitchDirectionClass,
): void {
  for (const name of SPACE_MOTION_CLASSES) {
    element.classList.remove(name);
  }
  void element.offsetWidth;
  element.classList.add(className);
}

export type EnterStep = "replay" | "close" | "none";

/**
 * Decides what an enter-motion element should do this render. `previousOpen`
 * is `null` on first mount.
 */
export function enterStep(previousOpen: boolean | null, open: boolean): EnterStep {
  if (open) return previousOpen === true ? "none" : "replay";
  return previousOpen === false ? "none" : "close";
}

/**
 * Drives an enter/close animation on a ref'd element as `open` changes.
 * `"close"` sets `data-motion="closed"` immediately (no delay, so a
 * subsequently shown native view never flashes stale content). `"replay"`
 * sets `data-motion="open"` and replays `className` (default `motion-enter`).
 */
export function useEnterMotion<T extends HTMLElement>(
  open: boolean,
  className: "motion-enter" | "motion-fade" = "motion-enter",
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const previousOpen = useRef<boolean | null>(null);

  useLayoutEffect(() => {
    const step = enterStep(previousOpen.current, open);
    previousOpen.current = open;
    const element = ref.current;
    if (!element) return;
    if (step === "close") {
      element.dataset.motion = "closed";
    } else if (step === "replay") {
      element.dataset.motion = "open";
      replayClass(element, className);
    }
  }, [open, className]);

  return ref;
}

export interface OutgoingTint {
  tint: string;
  opacity: number;
}

/**
 * The pure decision behind the space-switch tint cross-fade: given the
 * theme that was actually on screen before the switch and the theme that is
 * about to show, is there an outgoing tint to paint and fade out?
 *
 * Comparing resolved tokens (not `SpaceTheme` identity) means editing the
 * active space's theme and then switching away still cross-fades: the
 * caller is responsible for refreshing the "previous" theme on every commit
 * (PRD 10.7 §4), not just when the active space id changes, so this always
 * sees the theme that was last painted.
 */
export function outgoingTintDecision(
  previousTheme: SpaceTheme | null,
  nextTheme: SpaceTheme | null,
  appearance: Appearance,
): OutgoingTint | null {
  const previousTokens = themeTokens(previousTheme, appearance);
  const nextTokens = themeTokens(nextTheme, appearance);
  if (
    previousTokens["--tint"] === nextTokens["--tint"] &&
    previousTokens["--tint-opacity"] === nextTokens["--tint-opacity"]
  ) {
    return null;
  }
  return {
    tint: previousTokens["--tint"],
    opacity: Number(previousTokens["--tint-opacity"]),
  };
}
