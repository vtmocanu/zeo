import { useLayoutEffect, useEffect, useState } from "react";
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

/**
 * Applies `theme`'s tokens to `document.documentElement` in a layout effect,
 * whenever `theme` or the OS appearance changes.
 */
export function useThemeTokens(theme: SpaceTheme | null): void {
  const appearance = useAppearance();
  const stable = useStableTheme(theme);

  useLayoutEffect(() => {
    applyThemeTokens(document.documentElement, stable, appearance);
  }, [stable, appearance]);
}

/**
 * `theme`, but keeping the previous object while the value is structurally
 * equal. Every state broadcast carries fresh space objects, so without this a
 * tab-only broadcast would recompute and re-apply identical tokens.
 */
function useStableTheme(theme: SpaceTheme | null): SpaceTheme | null {
  const [stable, setStable] = useState(theme);
  if (!themesEqual(stable, theme)) {
    // Adjusting state during render: React re-renders before committing, so
    // the layout effect below only ever sees the settled value.
    setStable(theme);
    return theme;
  }
  return stable;
}

/**
 * The active space's theme for a surface that keeps no `TabsState` of its own
 * (the overlay). Subscribes to state broadcasts and seeds from `tabs.list()`
 * unless a broadcast already arrived, so a late seed never overwrites a newer
 * state. `null` until the first state lands, and without the bridge.
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
