import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const scriptPath = fileURLToPath(
  new URL("../../../scripts/check-css-tokens.mjs", import.meta.url),
);

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
});
