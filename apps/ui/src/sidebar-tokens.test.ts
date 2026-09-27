import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  BOTTOM_BAR_HEIGHT,
  FAVORITE_TILE_GAP,
  FAVORITE_TILE_HEIGHT,
  TAB_ROW_HEIGHT,
  URL_PILL_HEIGHT,
} from "@zeo/core";

/** The static-tier `:root` block (the first one): spacing, radius, sizes. */
function staticTokens(): Record<string, string> {
  const css = readFileSync(fileURLToPath(new URL("./styles/tokens.css", import.meta.url)), "utf8");
  const start = css.indexOf(":root");
  const block = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  const out: Record<string, string> = {};
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out[match[1]] = match[2].trim();
  }
  return out;
}

describe("tokens.css sidebar sizes (PRD 10.4 §7)", () => {
  const tokens = staticTokens();

  test.each([
    ["--url-pill-height", URL_PILL_HEIGHT],
    ["--row-height", TAB_ROW_HEIGHT],
    ["--tile-height", FAVORITE_TILE_HEIGHT],
    ["--tile-gap", FAVORITE_TILE_GAP],
    ["--bottom-bar-height", BOTTOM_BAR_HEIGHT],
  ])("%s equals the sidebar.ts constant (%i px)", (token, px) => {
    expect(tokens[token]).toBe(`${px}px`);
  });

  test.each([
    ["--tile-icon", "24px"],
    ["--icon-button", "28px"],
    ["--label-height", "22px"],
  ])("%s is %s", (token, value) => {
    expect(tokens[token]).toBe(value);
  });
});
