import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  EASE_STANDARD,
  ENTER_SCALE_FROM,
  MOTION_BASE_MS,
  MOTION_FAST_MS,
  MOTION_REDUCED_MS,
  MOTION_SPACE_MS,
  PRESS_SCALE,
  SPACE_SHIFT_PX,
} from "@zeo/core";

const stylesDir = fileURLToPath(new URL("./styles", import.meta.url));

function readTokensCss(): string {
  return readFileSync(join(stylesDir, "tokens.css"), "utf8");
}

/** The first `:root { ... }` block: the static tier (PRD 10.7 §2). */
function staticTokens(): Record<string, string> {
  const css = readTokensCss();
  const start = css.indexOf(":root");
  const block = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  const out: Record<string, string> = {};
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out[match[1]] = match[2].trim();
  }
  return out;
}

/** The `:root` block inside a given `@media`/selector prelude, as a token map. */
function blockTokens(css: string, preludeMatch: RegExp): Record<string, string> {
  const preludeIndex = preludeMatch.exec(css);
  if (!preludeIndex) {
    throw new Error(`no block matching ${preludeMatch}`);
  }
  // Find the block's own opening brace after the prelude, then its matching
  // close by depth-counting (the reduced-motion block nests a `:root { }`
  // inside the `@media { }`).
  const openOuter = css.indexOf("{", preludeIndex.index);
  let depth = 0;
  let end = openOuter;
  for (let i = openOuter; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const block = css.slice(openOuter, end);
  const out: Record<string, string> = {};
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out[match[1]] = match[2].trim();
  }
  return out;
}

describe("tokens.css motion tokens (PRD 10.7 §2, §10)", () => {
  const tokens = staticTokens();

  test.each([
    ["--motion-fast", `${MOTION_FAST_MS}ms`],
    ["--motion-base", `${MOTION_BASE_MS}ms`],
    ["--motion-space", `${MOTION_SPACE_MS}ms`],
    ["--ease-standard", EASE_STANDARD],
    ["--motion-enter-scale", String(ENTER_SCALE_FROM)],
    ["--motion-space-shift", `${SPACE_SHIFT_PX}px`],
    ["--motion-press-scale", String(PRESS_SCALE)],
  ])("%s equals the core constant (%s)", (token, value) => {
    expect(tokens[token]).toBe(value);
  });

  test("the reduced-motion block sets --motion-base and --motion-space to the reduced duration", () => {
    const css = readTokensCss();
    const reduced = blockTokens(css, /@media \(prefers-reduced-motion: reduce\)/);
    expect(reduced["--motion-base"]).toBe(`${MOTION_REDUCED_MS}ms`);
    expect(reduced["--motion-space"]).toBe(`${MOTION_REDUCED_MS}ms`);
  });

  test(".zeo-motion-off sets every duration to 0ms", () => {
    const css = readTokensCss();
    const off = blockTokens(css, /\.zeo-motion-off\s*\{/);
    expect(off["--motion-fast"]).toBe("0ms");
    expect(off["--motion-base"]).toBe("0ms");
    expect(off["--motion-space"]).toBe("0ms");
  });
});

/** Selectors allowed to keep `outline: none`/`outline: 0` (PRD 10.7 §6 D6). */
const EXEMPT_FILES = new Set(["command-bar.css", "find-bar.css", "dialog.css"]);

/** Blanks out `/* ... *\/` comments while keeping line breaks, so a mention of
 *  "outline: none" inside a comment is never mistaken for a declaration. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
}

describe("no stray outline:none/outline:0 (PRD 10.7 §6, §10)", () => {
  const files = readdirSync(stylesDir).filter(
    (name) => name.endsWith(".css") && name !== "tokens.css",
  );

  test("every component file is free of a literal outline reset, except the exempt inputs", () => {
    const offenders: string[] = [];
    for (const name of files) {
      const css = stripComments(readFileSync(join(stylesDir, name), "utf8"));
      const hasOutlineNone = /outline\s*:\s*(none|0)\b/i.test(css);
      if (hasOutlineNone && !EXEMPT_FILES.has(name)) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the exempt files still carry exactly one outline reset each", () => {
    for (const name of EXEMPT_FILES) {
      const css = stripComments(readFileSync(join(stylesDir, name), "utf8"));
      const matches = css.match(/outline\s*:\s*(none|0)\b/gi) ?? [];
      expect(matches).toHaveLength(1);
    }
  });
});
