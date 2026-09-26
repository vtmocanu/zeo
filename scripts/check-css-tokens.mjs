#!/usr/bin/env node
// Literal-color lint for the UI stylesheets (PRD 10.1 §4).
//
// Every color in a component stylesheet must read a semantic token; only
// tokens.css may hold literal colors. Scans every *.css file under the target
// directory (default apps/ui/src/styles, or the first CLI argument) except
// files named tokens.css, and reports each hex color, color function call
// (rgb, rgba, hsl, hsla, oklch, color) and named color. `transparent`,
// `currentColor` and `inherit` are allowed; `color-mix(` is allowed as long as
// its arguments are tokens. Comments are ignored.
//
// Usage: node scripts/check-css-tokens.mjs [dir]
// Exit code 1 on any finding, 0 otherwise.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2] ? resolve(process.argv[2]) : join(repoRoot, "apps/ui/src/styles");

const HEX = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/gi;
// `\b` before `color(` keeps `color-mix(` and `accent-color:` out: the former
// has `-mix` before the paren, the latter no paren at all.
const FUNC = /\b(?:rgba?|hsla?|oklch|color)\(/gi;
// CSS named colors (the full CSS Color 4 keyword list), excluding the allowed
// `transparent`, `currentColor` and `inherit`.
const NAMED_COLORS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black " +
    "blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse " +
    "chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan " +
    "darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta " +
    "darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet " +
    "deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite " +
    "forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green " +
    "greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender " +
    "lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink " +
    "lightsalmon lightseagreen lightskyblue lightslategray lightslategrey " +
    "lightsteelblue lightyellow lime limegreen linen magenta maroon " +
    "mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen " +
    "mediumslateblue mediumspringgreen mediumturquoise mediumvioletred " +
    "midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive " +
    "olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise " +
    "palevioletred papayawhip peachpuff peru pink plum powderblue purple " +
    "rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown " +
    "seagreen seashell sienna silver skyblue slateblue slategray slategrey " +
    "snow springgreen steelblue tan teal thistle tomato turquoise violet " +
    "wheat white whitesmoke yellow yellowgreen"
  ).split(" "),
);
// A bare identifier: not part of a longer or hyphenated name (so custom
// properties such as `--ink-primary` never match), not a class, id or pseudo
// selector, and not a function name.
const IDENT = /(?<![\w.#:-])[a-z]+(?![\w-]|\()/gi;
const STRING = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;

/** Recursively list *.css files under `dir`, skipping tokens.css. */
function cssFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...cssFiles(path));
    } else if (entry.name.endsWith(".css") && entry.name !== "tokens.css") {
      out.push(path);
    }
  }
  return out.sort();
}

/** Blank out comments while keeping line breaks, so line numbers hold. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
}

/**
 * The declaration values on a line, joined by spaces: the text after each
 * `property:` inside a rule body (including one-line `a{color:red}` rules), or
 * a whole indented continuation line of a multi-line value (e.g. a font stack).
 * Selector text and property names are never returned.
 */
function valueText(line) {
  const opened = line.includes("{");
  const body = (opened ? line.slice(line.lastIndexOf("{") + 1) : line).split("}")[0];
  const values = [];
  for (const part of body.split(";")) {
    const declaration = /^\s*[\w-]+\s*:(.*)$/.exec(part);
    if (declaration) values.push(declaration[1]);
    else if (!opened && !line.includes("}") && /^\s+\S/.test(part)) values.push(part);
  }
  return values.join(" ");
}

function findings(file) {
  const lines = stripComments(readFileSync(file, "utf8")).split("\n");
  const found = [];
  lines.forEach((line, index) => {
    const report = (match) => found.push({ line: index + 1, match });
    for (const m of line.matchAll(HEX)) report(m[0]);
    for (const m of line.matchAll(FUNC)) report(m[0]);
    // Named colors only count in declaration values, so selectors such as
    // `.tab-item` or `:hover` and property names never trip the check.
    for (const m of valueText(line).replace(STRING, "").matchAll(IDENT)) {
      if (NAMED_COLORS.has(m[0].toLowerCase())) report(m[0]);
    }
  });
  return found;
}

let failures = 0;
for (const file of cssFiles(target)) {
  for (const { line, match } of findings(file)) {
    failures += 1;
    console.error(`${relative(process.cwd(), file)}:${line}: literal color "${match}"`);
  }
}
process.exit(failures > 0 ? 1 : 0);
