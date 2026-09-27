import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const scriptPath = fileURLToPath(new URL("../../../scripts/check-css-tokens.mjs", import.meta.url));

let dirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "check-css-tokens-"));
  dirs.push(dir);
  return dir;
}

function run(dir: string): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [scriptPath, dir], { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

describe("check-css-tokens.mjs", () => {
  test("exits 0 on a clean file", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "clean.css"), ".foo { color: var(--ink-primary); }\n");

    const { status, stderr } = run(dir);
    expect(status).toBe(0);
    expect(stderr).toBe("");
  });

  test("exits 1 on a literal hex color", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "bad.css"), ".foo { color: #fff; }\n");

    const { status, stderr } = run(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('literal color "#fff"');
  });

  test("exits 1 on a named color in a multi-line value", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "bad-multiline.css"),
      ".foo {\n  box-shadow:\n    0 0 0 1px red,\n    0 1px 2px var(--x);\n}\n",
    );

    const { status, stderr } = run(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('literal color "red"');
  });

  test("reports named colors in nested at-rules and after quoted braces, with line numbers", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "bad-nested.css"),
      ".a { color: var(--x); @media (min-width: 1px) { color: red; } }\n" +
        '.b { content: "}"; color: purple; }\n',
    );

    const { status, stderr } = run(dir);
    expect(status).toBe(1);
    expect(stderr).toMatch(/bad-nested\.css:1: literal color "red"/);
    expect(stderr).toMatch(/bad-nested\.css:2: literal color "purple"/);
  });

  test("ignores color words in selectors, strings, url() and identifier properties", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "names.css"),
      ".red,\n.mark {\n  animation: highlight var(--motion-base);\n  grid-area: mark;\n" +
        '  content: "white";\n  background-image: url(icons/white.svg);\n' +
        "  color: currentColor;\n  background: transparent;\n}\n",
    );

    const { status, stderr } = run(dir);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  test("exits 2 when the target is not a directory", () => {
    const { status, stderr } = run(join(makeTempDir(), "missing"));
    expect(status).toBe(2);
    expect(stderr).toContain("not a directory");
  });

  test.each([
    ["six-digit hex", "color: #aabbcc;", "#aabbcc"],
    ["eight-digit hex", "color: #aabbcc80;", "#aabbcc80"],
    ["rgb()", "color: rgb(0 0 0);", "rgb("],
    ["hsl()", "color: hsl(0 0% 0%);", "hsl("],
    ["oklch()", "color: oklch(0.5 0.1 200);", "oklch("],
    ["color()", "color: color(srgb 0 0 0);", "color("],
    ["a system color", "color: WindowText;", "WindowText"],
    [
      "-webkit-focus-ring-color",
      "outline-color: -webkit-focus-ring-color;",
      "-webkit-focus-ring-color",
    ],
  ])("exits 1 on %s", (_name, declaration, match) => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "bad.css"), `.foo { ${declaration} }\n`);

    const { status, stderr } = run(dir);
    expect(status).toBe(1);
    expect(stderr).toContain(`literal color "${match}"`);
  });

  test("a comment marker inside a string does not hide later colors", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "bad-string.css"),
      '.a::before { content: "/*"; }\n.b { background: #fff; }\n.c { content: "*/"; }\n',
    );

    const { status, stderr } = run(dir);
    expect(status).toBe(1);
    expect(stderr).toMatch(/bad-string\.css:2: literal color "#fff"/);
  });

  test("line numbers stay right after an escaped newline inside a string", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "bad-escape.css"),
      '.a::before { content: "a\\\n b"; }\n.b { color: red; }\n',
    );

    const { status, stderr } = run(dir);
    expect(status).toBe(1);
    expect(stderr).toMatch(/bad-escape\.css:3: literal color "red"/);
  });

  test("property names in transition values are not colors", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "transition.css"),
      ".a { transition: background var(--motion-fast) var(--ease-standard); outline-color: var(--webkit-focus-ring-color); }\n",
    );

    const { status, stderr } = run(dir);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  test("an unterminated string ends at the newline", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "bad-unterminated.css"),
      '.a { content: "oops; }\n.b { color: red; }\n',
    );

    const { status, stderr } = run(dir);
    expect(status).toBe(1);
    expect(stderr).toMatch(/bad-unterminated\.css:2: literal color "red"/);
  });

  test("an escaped CRLF inside a string continues it", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "bad-crlf.css"), '.a { content: "x\\\r\ny"; } .b { color: red; }\r\n');

    const { status, stderr } = run(dir);
    expect(status).toBe(1);
    expect(stderr).toMatch(/bad-crlf\.css:2: literal color "red"/);
  });

  test("color words inside a string with an escaped newline are ignored", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "string.css"), '.a::before { content: "a\\\n red"; }\n');

    const { status, stderr } = run(dir);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  test("an escaped CRLF inside a string keeps its color words and comment markers inert", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "ok-crlf.css"), '.a::before { content: "a\\\r\n red"; }\r\n');
    writeFileSync(
      join(dir, "bad-crlf-comment.css"),
      '.a { content: "/*\\\r\n"; color: red; }\r\n.b { content: "*/"; }\r\n',
    );

    const { status, stderr } = run(dir);
    expect(status).toBe(1);
    expect(stderr).not.toContain("ok-crlf.css");
    expect(stderr).toMatch(/bad-crlf-comment\.css:2: literal color "red"/);
  });

  test("exits 1 on a literal duration and easing in a transition", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "bad-motion.css"), ".a { transition: opacity 0.1s ease-in-out; }\n");

    const { status, stderr } = run(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('literal motion "0.1s"');
    expect(stderr).toContain('literal motion "ease-in-out"');
  });

  test("exits 1 on a literal duration in an animation", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "bad-anim.css"), ".a { animation: x 200ms; }\n");

    const { status, stderr } = run(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('literal motion "200ms"');
  });

  test("exits 0 on a transition that reads a token", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "ok-transition.css"),
      ".a { transition: var(--transition-control); }\n",
    );

    const { status, stderr } = run(dir);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  test("exits 0 on an animation that reads tokens", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "ok-anim.css"),
      ".a { animation: zeo-fade-in var(--motion-base) var(--ease-standard) both; }\n",
    );

    const { status, stderr } = run(dir);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  test("does not flag literal motion inside tokens.css", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "tokens.css"), ".a { transition: opacity 0.1s ease-in-out; }\n");

    const { status, stderr } = run(dir);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  test("pins the exact file:line for a literal on a continuation line", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "bad-motion-multiline.css"),
      ".a {\n  transition:\n    opacity\n    120ms\n    var(--ease-standard);\n}\n",
    );

    const { status, stderr } = run(dir);
    expect(status).toBe(1);
    expect(stderr).toMatch(/bad-motion-multiline\.css:4: literal motion "120ms"/);
  });

  test("exits 1 on a leading-dot duration", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "bad-dot.css"), ".a { transition: opacity .5s; }\n");

    const { status, stderr } = run(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('literal motion ".5s"');
  });

  test("exits 1 on a negative delay and reports it whole", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "bad-negative.css"),
      ".a { animation-delay: -200ms; }\n.b { transition-delay: -.5s; }\n",
    );

    const { status, stderr } = run(dir);
    expect(status).toBe(1);
    expect(stderr).toMatch(/bad-negative\.css:1: literal motion "-200ms"/);
    expect(stderr).toMatch(/bad-negative\.css:2: literal motion "-\.5s"/);
  });

  test("does not flag a duration-shaped custom property name", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "ok-var-name.css"),
      ".a { transition: var(--dur-2s); }\n.b { transition: var(--2s); }\n.c { animation: a--2s var(--motion-base); }\n",
    );

    const { status, stderr } = run(dir);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  test("exits 1 on an uppercase duration unit", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "bad-upper.css"), ".a { transition: opacity 200MS; }\n");

    const { status, stderr } = run(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('literal motion "200MS"');
  });

  test("exits 1 on a literal transition-timing-function", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "bad-timing-function.css"),
      ".a { transition-timing-function: ease-in; }\n",
    );

    const { status, stderr } = run(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('literal motion "ease-in"');
  });
});
