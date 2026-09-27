import { useLayoutEffect, useEffect, useState } from "react";
import type { Appearance, SpaceTheme, TabsState } from "@zeo/core";
import { activeSpaceTheme, themeTokens } from "@zeo/core";

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

/**
 * Applies `theme`'s tokens to `document.documentElement` in a layout effect,
 * whenever `theme` or the OS appearance changes.
 */
export function useThemeTokens(theme: SpaceTheme | null): void {
  const appearance = useAppearance();

  useLayoutEffect(() => {
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
