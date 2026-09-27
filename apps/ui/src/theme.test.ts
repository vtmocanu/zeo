import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { SEMANTIC_TOKENS, themeTokens, type Appearance, type SpaceTheme } from "@zeo/core";
import { applyThemeTokens } from "./theme.js";

/** A minimal fake root: just enough surface for applyThemeTokens to touch. */
function fakeRoot(): { style: { setProperty(name: string, value: string): void }; dataset: DOMStringMap; properties: Record<string, string> } {
  const properties: Record<string, string> = {};
  return {
    properties,
    style: {
      setProperty(name: string, value: string) {
        properties[name] = value;
      },
    },
    dataset: {} as DOMStringMap,
  };
}

describe("applyThemeTokens", () => {
  for (const appearance of ["light", "dark"] as const) {
    test(`sets all SEMANTIC_TOKENS and data-appearance (null theme, ${appearance})`, () => {
      const root = fakeRoot();
      applyThemeTokens(root as unknown as HTMLElement, null, appearance);

      const expected = themeTokens(null, appearance);
      for (const token of SEMANTIC_TOKENS) {
        expect(root.properties[token]).toBe(expected[token]);
      }
      expect(Object.keys(root.properties).sort()).toEqual([...SEMANTIC_TOKENS].sort());
      expect(root.dataset.appearance).toBe(appearance);
    });
  }

  test("sets all SEMANTIC_TOKENS for a themed input", () => {
    const theme: SpaceTheme = { stops: ["violet"], intensity: 0.5 };
    const root = fakeRoot();
    applyThemeTokens(root as unknown as HTMLElement, theme, "dark");

    const expected = themeTokens(theme, "dark");
    for (const token of SEMANTIC_TOKENS) {
      expect(root.properties[token]).toBe(expected[token]);
    }
    expect(root.dataset.appearance).toBe("dark");
  });
});

/**
 * Extracts the `--token: value;` declarations from a single braced CSS block
 * (no nested braces expected within it).
 */
function parseDeclarations(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out[match[1]] = match[2].trim();
  }
  return out;
}

/** Pulls the first top-level `:root { ... }` block's body out of `css`. */
function firstRootBlock(css: string): string {
  const start = css.indexOf(":root");
  if (start === -1) throw new Error("no :root block found");
  const braceStart = css.indexOf("{", start);
  const braceEnd = css.indexOf("}", braceStart);
  return css.slice(braceStart + 1, braceEnd);
}

/** Pulls the `:root { ... }` block nested inside the dark media query. */
function darkRootBlock(css: string): string {
  const mediaStart = css.indexOf("@media (prefers-color-scheme: dark)");
  if (mediaStart === -1) throw new Error("no dark media block found");
  return firstRootBlock(css.slice(mediaStart));
}

describe("tokens.css parity", () => {
  const tokensCssPath = fileURLToPath(new URL("./styles/tokens.css", import.meta.url));
  const css = readFileSync(tokensCssPath, "utf8");

  // tokens.css has two :root blocks: a static tier (spacing/radius/type/motion)
  // and a semantic tier holding the light values. Find the one that actually
  // holds semantic tokens by locating the block that defines --surface-window.
  function findSemanticRootBlock(source: string): string {
    let searchFrom = 0;
    for (;;) {
      const start = source.indexOf(":root", searchFrom);
      if (start === -1) throw new Error("no semantic :root block found");
      const braceStart = source.indexOf("{", start);
      const braceEnd = source.indexOf("}", braceStart);
      const block = source.slice(braceStart + 1, braceEnd);
      if (block.includes("--surface-window")) return block;
      searchFrom = braceEnd + 1;
    }
  }

  const lightDeclarations = parseDeclarations(findSemanticRootBlock(css));
  const darkDeclarations = parseDeclarations(darkRootBlock(css));

  for (const [appearance, declarations] of [
    ["light", lightDeclarations],
    ["dark", darkDeclarations],
  ] as const satisfies readonly [Appearance, Record<string, string>][]) {
    test(`${appearance} semantic tokens match themeTokens(null, "${appearance}")`, () => {
      const expected = themeTokens(null, appearance);
      for (const token of SEMANTIC_TOKENS) {
        expect(declarations[token], `missing token ${token}`).toBeDefined();
        expect(declarations[token]).toBe(expected[token]);
      }
      expect(Object.keys(declarations).sort()).toEqual([...SEMANTIC_TOKENS].sort());
    });
  }
});
