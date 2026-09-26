import { useLayoutEffect, useEffect, useState } from "react";
import type { Appearance, SpaceTheme } from "@zeo/core";
import { themeTokens } from "@zeo/core";

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
