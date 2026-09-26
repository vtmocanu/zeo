// Local/manual verification gate for the Homebrew cask: run the render
// script's unit tests, render the real template against a fixture input, and
// (when brew is available) lint the rendered cask with `brew style --cask`.
//
// Note: `brew audit <path>` is disabled in current Homebrew versions
// (dev-cmd/audit.rb marks path-form invocation `odisabled`), so `brew style
// --cask <path>` is used here as the path-accepting check the PRD's "and/or"
// allows.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const renderScript = resolve(scriptDir, "render.mjs");
const testScript = resolve(scriptDir, "render.test.mjs");
const rootPackageJsonPath = resolve(scriptDir, "..", "..", "package.json");

const FIXTURE_SHA256 = "0".repeat(64);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function main() {
  // 1. Run the render script's unit tests.
  const testRun = spawnSync(process.execPath, ["--test", testScript], { stdio: "inherit" });
  if (testRun.status !== 0) {
    fail("cask:check failed: render.test.mjs did not pass.");
    return;
  }

  // 2. Render the real template against a fixture input to a gitignored
  // temporary path, and assert it succeeds with no leftover placeholder.
  const version = JSON.parse(readFileSync(rootPackageJsonPath, "utf8")).version;
  const url =
    `https://github.com/vtmocanu/zeo/releases/download/v${version}/` +
    `zeo-${version}-arm64.dmg`;

  let tmpDir;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "zeo-cask-check-"));
    const renderedPath = join(tmpDir, "zeo.rb");

    const renderRun = spawnSync(process.execPath, [
      renderScript,
      "--version",
      version,
      "--url",
      url,
      "--sha256",
      FIXTURE_SHA256,
      "--out",
      renderedPath,
    ]);
    if (renderRun.status !== 0) {
      console.error(renderRun.stderr?.toString() ?? "");
      fail("cask:check failed: rendering the real template against the fixture input failed.");
      return;
    }

    const rendered = readFileSync(renderedPath, "utf8");
    if (rendered.includes("{{")) {
      fail("cask:check failed: rendered cask still contains an unreplaced {{ placeholder.");
      return;
    }

    // 3. If brew is on PATH, lint the rendered cask with `brew style --cask`.
    const brewCheck = spawnSync("sh", ["-c", "command -v brew"]);
    const hasBrew = brewCheck.status === 0 && brewCheck.stdout?.toString().trim().length > 0;

    if (!hasBrew) {
      console.log("Homebrew not found; skipping brew style check.");
    } else {
      const styleRun = spawnSync("brew", ["style", "--cask", renderedPath], { stdio: "inherit" });
      if (styleRun.status !== 0) {
        fail("cask:check failed: brew style --cask reported issues.");
        return;
      }
    }

    console.log("cask:check passed.");
    process.exit(0);
  } finally {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

main();
