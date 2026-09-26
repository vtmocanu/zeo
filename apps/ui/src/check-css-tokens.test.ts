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
      ".red,\n.mark {\n  animation: highlight 1s;\n  grid-area: mark;\n" +
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
      ".a { transition: background 120ms ease; outline-color: var(--webkit-focus-ring-color); }\n",
    );

    const { status, stderr } = run(dir);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });
});
