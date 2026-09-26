// Local/manual verification gate for the Homebrew cask: run the render
// script's unit tests, render the real template against a fixture input, and
// (when brew is available) lint the rendered cask with `brew style --cask`.
//
// Note: current Homebrew refuses to check a cask by bare file path — `brew
// audit <path>` is disabled and `brew style --cask <path>` fails with
// "Homebrew requires casks to be in a tap". So the rendered cask is copied
// into a temporary local tap and linted by its tap token, and the tap is
// removed again afterwards.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const renderScript = resolve(scriptDir, "render.mjs");
const testScript = resolve(scriptDir, "render.test.mjs");
const rootPackageJsonPath = resolve(scriptDir, "..", "..", "package.json");

const FIXTURE_SHA256 = "0".repeat(64);
const CHECK_TAP = "zeo-cask-check/local";

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

// Returns without throwing in every case; failure is signalled via
// process.exitCode so callers can rely on cleanup (a `finally` block) always
// running instead of being skipped by a process.exit() inside the try.
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
    `https://github.com/vtmocanu/zeo/releases/download/v${version}/` + `zeo-${version}-arm64.dmg`;

  let tmpDir;
  let tapped = false;
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

    // 3. If brew is on PATH, lint the rendered cask with `brew style --cask`
    // from inside a temporary local tap.
    const brewCheck = spawnSync("sh", ["-c", "command -v brew"]);
    const hasBrew = brewCheck.status === 0 && brewCheck.stdout?.toString().trim().length > 0;

    if (!hasBrew) {
      console.log("Homebrew not found; skipping brew style check.");
    } else {
      // Best effort: clear a tap left behind by an interrupted earlier run.
      spawnSync("brew", ["untap", CHECK_TAP], { stdio: "ignore" });

      const tapRun = spawnSync("brew", ["tap-new", "--no-git", CHECK_TAP], { stdio: "inherit" });
      if (tapRun.status !== 0) {
        fail(`cask:check failed: brew tap-new ${CHECK_TAP} failed.`);
        return;
      }
      tapped = true;

      const repoRun = spawnSync("brew", ["--repository", CHECK_TAP]);
      const tapPath = repoRun.stdout?.toString().trim() ?? "";
      if (repoRun.status !== 0 || tapPath.length === 0) {
        console.error(repoRun.stderr?.toString() ?? "");
        fail(`cask:check failed: could not locate the ${CHECK_TAP} tap.`);
        return;
      }
      const casksDir = join(tapPath, "Casks");
      mkdirSync(casksDir, { recursive: true });
      copyFileSync(renderedPath, join(casksDir, "zeo.rb"));

      const styleRun = spawnSync("brew", ["style", "--cask", `${CHECK_TAP}/zeo`], {
        stdio: "inherit",
      });
      if (styleRun.status !== 0) {
        fail("cask:check failed: brew style --cask reported issues.");
        return;
      }
    }

    console.log("cask:check passed.");
  } finally {
    if (tapped) {
      const untapRun = spawnSync("brew", ["untap", CHECK_TAP], { stdio: "inherit" });
      if (untapRun.status !== 0) {
        fail(`cask:check failed: brew untap ${CHECK_TAP} failed; remove it manually.`);
      }
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

main();
