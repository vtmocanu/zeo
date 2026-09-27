import type { Page } from "@playwright/test";

// PRD 10.6 §8 — resolve a design token to the value the renderer actually
// computes, so a spec compares computed colors with computed colors and never a
// copied literal. The probe is a throwaway element appended to `document.body`:
// `useThemeTokens` writes every token on `document.documentElement`, so the
// probe inherits the same (space-themed, light/dark) value as the element under
// test.

/**
 * The computed `background-color` of a probe whose `background` is
 * `var(<token>)` (e.g. `"--accent-soft"`), in `page`. The probe is removed
 * before returning, so it never lands in a later DOM query. Throws when the
 * token is undefined in the page: an unresolved `var()` computes to
 * transparent, which would let a comparison against a transparent element
 * pass vacuously.
 */
export function tokenBackground(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    if (getComputedStyle(document.documentElement).getPropertyValue(name).trim() === "") {
      throw new Error(`token ${name} is not defined in this page`);
    }
    const probe = document.createElement("div");
    probe.style.background = `var(${name})`;
    document.body.appendChild(probe);
    try {
      return getComputedStyle(probe).backgroundColor;
    } finally {
      probe.remove();
    }
  }, token);
}
