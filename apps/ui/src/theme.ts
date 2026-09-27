import { useLayoutEffect, useEffect, useRef, useState } from "react";
import type { Appearance, SpaceTheme, TabsState } from "@zeo/core";
import { activeSpaceTheme, themeTokens, themesEqual } from "@zeo/core";

/**
 * Applies every semantic token returned by `themeTokens(theme, appearance)` to
 * `root` via `style.setProperty`, and stamps `root.dataset.appearance` so CSS
 * can select on the current appearance without re-reading `matchMedia`.
 */
export function applyThemeTokens(
  root: HTMLElement,
  theme: SpaceTheme | null,
  appearance: Appearance,
): void {
  const tokens = themeTokens(theme, appearance);
  for (const [name, value] of Object.entries(tokens)) {
    root.style.setProperty(name, value);
  }
  root.dataset.appearance = appearance;
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * The current OS appearance, re-rendering the caller whenever it flips (the
 * renderer follows Chromium's `prefers-color-scheme`, which tracks the macOS
 * appearance live).
 */
export function useAppearance(): Appearance {
  const [appearance, setAppearance] = useState<Appearance>(() =>
    window.matchMedia(DARK_QUERY).matches ? "dark" : "light",
  );

  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent): void => {
      setAppearance(event.matches ? "dark" : "light");
    };
    media.addEventListener("change", onChange);
    // Catch a flip between the initial render and this subscription.
    setAppearance(media.matches ? "dark" : "light");
    return () => {
      media.removeEventListener("change", onChange);
    };
  }, []);

  return appearance;
}

/** What `useThemeTokens` last applied to the DOM. */
export interface AppliedTheme {
  theme: SpaceTheme | null;
  appearance: Appearance;
}

/**
 * Whether `next` needs applying given the last-applied `AppliedTheme` (`null`
 * before anything has been applied). `activeSpaceTheme` (the caller's usual
 * source) returns a fresh object on every state broadcast even when nothing
 * changed, so this compares by VALUE (`themesEqual`) and appearance, not by
 * object identity.
 */
export function themeApplyIsRedundant(
  applied: AppliedTheme | null,
  next: AppliedTheme,
): boolean {
  return (
    applied !== null &&
    applied.appearance === next.appearance &&
    themesEqual(applied.theme, next.theme)
  );
}

/**
 * Applies `theme`'s tokens to `document.documentElement` in a layout effect,
 * whenever `theme` or the OS appearance changes, skipping the DOM write when
 * `themeApplyIsRedundant` says the last applied theme/appearance already
 * match — without altering the effect's timing (it still runs on every
 * `theme`/`appearance` change; it just no-ops the write when redundant).
 */
export function useThemeTokens(theme: SpaceTheme | null): void {
  const appearance = useAppearance();
  const appliedRef = useRef<AppliedTheme | null>(null);

  useLayoutEffect(() => {
    const next: AppliedTheme = { theme, appearance };
    if (themeApplyIsRedundant(appliedRef.current, next)) {
      return;
    }
    appliedRef.current = next;
    applyThemeTokens(document.documentElement, theme, appearance);
  }, [theme, appearance]);
}

/**
 * The active space's theme for a surface that keeps no {@link TabsState} of its
 * own (the overlay): mirrors state broadcasts, seeded from `tabs.list()` unless
 * a broadcast already arrived, and yields `null` until either lands or without
 * the bridge (a bare browser dev-open).
 */
export function useActiveSpaceTheme(): SpaceTheme | null {
  const [state, setState] = useState<TabsState | null>(null);

  useEffect(() => {
    if (!window.zeo) {
      return;
    }
    let sawBroadcast = false;
    const unsubscribe = window.zeo.onStateChange((s) => {
      sawBroadcast = true;
      setState(s);
    });
    void window.zeo.tabs
      .list()
      .then((s) => {
        if (!sawBroadcast) {
          setState(s);
        }
      })
      .catch(() => {});
    return unsubscribe;
  }, []);

  return activeSpaceTheme(state);
}
