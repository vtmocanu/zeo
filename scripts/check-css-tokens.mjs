#!/usr/bin/env node
// Literal-color lint for the UI stylesheets (PRD 10.1 §4).
//
// Every color in a component stylesheet must read a semantic token; only
// tokens.css may hold literal colors. Scans every *.css file under the target
// directory (default apps/ui/src/styles, or the first CLI argument) except
// files named tokens.css, and reports each hex color, color function call
// (rgb, rgba, hsl, hsla, hwb, lab, lch, oklab, oklch, color), named color and
// CSS system color (Canvas, ButtonText, ...). `transparent`, `currentColor` and
// `inherit` are allowed; `color-mix(` is allowed as long as its arguments are
// tokens. Comments are ignored. Named colors count only inside declaration
// values, outside strings and `url(...)`, and not in properties whose values
// are author-chosen names (animation, grid-area, font-family, ...), where a
// word such as `highlight` is a name rather than a color.
//
// Usage: node scripts/check-css-tokens.mjs [dir]
// Exit code 1 on any finding, 0 otherwise, 2 when the target is not a directory.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2] ? resolve(process.argv[2]) : join(repoRoot, "apps/ui/src/styles");

const HEX = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/gi;
// `\b` before `color(` keeps `color-mix(` and `accent-color:` out: the former
// has `-mix` before the paren, the latter no paren at all.
const FUNC = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi;
// CSS named colors (the full CSS Color 4 keyword list) and system colors,
// excluding the allowed `transparent`, `currentColor` and `inherit`. Compared
// lowercased, as CSS keywords are case-insensitive.
const NAMED_COLORS = new Set(
  (
    "canvas canvastext buttonface buttontext field fieldtext highlight " +
    "highlighttext mark linktext visitedtext activetext graytext marktext " +
    "accentcolor accentcolortext selecteditem selecteditemtext " +
    // Deprecated system colors, which Chromium still renders.
    "activeborder activecaption appworkspace background buttonhighlight " +
    "buttonshadow captiontext inactiveborder inactivecaption " +
    "inactivecaptiontext infobackground infotext menu menutext scrollbar " +
    "threeddarkshadow threedface threedhighlight threedlightshadow " +
    "threedshadow window windowframe windowtext -webkit-focus-ring-color " +
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
const IDENT = /(?<![\w.#:-])[a-z]+(?![\w-]|\()|-webkit-focus-ring-color\b/gi;
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
  // Strings are matched first and kept, so a `/*` inside `content: "/*"` does
  // not open a comment.
  return source.replace(
    /"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'|\/\*[\s\S]*?\*\//g,
    (c) => (c.startsWith("/*") ? c.replace(/[^\n]/g, " ") : c),
  );
}

// Properties whose values are author-chosen identifiers, not colors: a name
// such as `highlight` or `mark` there is an animation or grid-area name.
const IDENT_PROPERTIES = new Set([
  "-webkit-animation",
  "-webkit-animation-name",
  "anchor-name",
  "animation",
  "animation-name",
  "animation-timeline",
  "container",
  "container-name",
  "counter-increment",
  "counter-reset",
  "counter-set",
  "font",
  "font-family",
  "grid-area",
  "grid-column",
  "grid-column-end",
  "grid-column-start",
  "grid-row",
  "grid-row-end",
  "grid-row-start",
  "grid-template-areas",
  "list-style-type",
  "position-anchor",
  "scroll-timeline",
  "scroll-timeline-name",
  "timeline-scope",
  "transition-property",
  "view-timeline",
  "view-timeline-name",
  "view-transition-name",
  "will-change",
]);

/**
 * Every declaration value in `source` (comments already blanked), with the
 * line each character sits on. Tracks braces across lines, so selectors,
 * at-rule preludes and property names are never returned, while a value that
 * wraps over several lines (a font stack, a multi-layer shadow) is.
 */
function declarationValues(source) {
  const values = [];
  // Block kinds on the brace stack: "group" holds rules (`@media`, `@supports`,
  // the top level), "rule" holds declarations.
  const stack = ["group"];
  let text = "";
  let lines = [];
  let line = 1;
  let quote = "";
  const flushDeclaration = () => {
    const colon = text.indexOf(":");
    if (stack.at(-1) === "rule" && colon !== -1) {
      const property = text.slice(0, colon).trim().toLowerCase();
      if (!IDENT_PROPERTIES.has(property)) {
        values.push({ text: text.slice(colon + 1), lines: lines.slice(colon + 1) });
      }
    }
    text = "";
    lines = [];
  };
  // Index by UTF-16 unit, not code point, so `lines` lines up with the
  // `RegExp` match indices used against the collected text.
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      // Braces and semicolons inside a string are part of the value.
      if (char === "\\") {
        text += char + (source[i + 1] ?? "");
        lines.push(line, line);
        i += 1;
        if (source[i] === "\n") line += 1;
        continue;
      }
      if (char === quote) quote = "";
      text += char;
      lines.push(line);
    } else if (char === '"' || char === "'") {
      quote = char;
      text += char;
      lines.push(line);
    } else if (char === "{") {
      const prelude = text.trim();
      text = "";
      lines = [];
      // A group at-rule nested inside a rule (CSS nesting) holds declarations.
      const group =
        stack.at(-1) === "group" &&
        /^@(media|supports|layer|container|document|scope)\b/i.test(prelude);
      stack.push(group ? "group" : "rule");
    } else if (char === "}") {
      flushDeclaration();
      if (stack.length > 1) stack.pop();
    } else if (char === ";") {
      flushDeclaration();
    } else {
      text += char;
      lines.push(line);
    }
    if (char === "\n") line += 1;
  }
  return values;
}

function findings(file) {
  const source = stripComments(readFileSync(file, "utf8"));
  const found = [];
  source.split("\n").forEach((line, index) => {
    for (const m of line.matchAll(HEX)) found.push({ line: index + 1, match: m[0] });
    for (const m of line.matchAll(FUNC)) found.push({ line: index + 1, match: m[0] });
  });
  // Named colors only count in declaration values, so selectors such as
  // `.tab-item` or `:hover` and property names never trip the check.
  for (const value of declarationValues(source)) {
    const scanned = value.text
      .replace(STRING, (s) => " ".repeat(s.length))
      .replace(/\burl\([^)]*\)/gi, (s) => " ".repeat(s.length));
    for (const m of scanned.matchAll(IDENT)) {
      if (NAMED_COLORS.has(m[0].toLowerCase())) {
        found.push({ line: value.lines[m.index], match: m[0] });
      }
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

let isDirectory = false;
try {
  isDirectory = statSync(target).isDirectory();
} catch {
  // A missing path is reported below, like a path that is not a directory.
}
if (!isDirectory) {
  console.error(`check-css-tokens: not a directory: ${target}`);
  process.exit(2);
}

let failures = 0;
for (const file of cssFiles(target)) {
  for (const { line, match } of findings(file)) {
    failures += 1;
    console.error(`${relative(process.cwd(), file)}:${line}: literal color "${match}"`);
  }
}
process.exit(failures > 0 ? 1 : 0);
