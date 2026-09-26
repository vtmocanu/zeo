// Local pre-flight before pushing a release tag. Verifies, in order, exiting
// non-zero with a specific message on the first failure: the root version is
// present, CHANGELOG.md has a dated non-empty section for it, and the working
// tree is clean. Never pushes anything; the authoritative tag-equals-version
// gate lives in the release workflow.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parseChangelogSection } from "@zeo/core";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const rootPackageJson = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
);
const version = rootPackageJson.version;

if (!version) {
  console.error("release-check: root package.json has no \"version\".");
  process.exit(1);
}

const changelog = readFileSync(resolve(repoRoot, "CHANGELOG.md"), "utf8");
const section = parseChangelogSection(changelog, version);

if (section === null) {
  const headingRe = new RegExp(
    `^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`,
  );
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const headingLine = lines.find((line) => headingRe.test(line));

  if (!headingLine) {
    console.error(
      `release-check: CHANGELOG.md has no "## [${version}]" heading.`,
    );
  } else if (!/^## \[.+\] - (.+)$/.test(headingLine)) {
    console.error(
      `release-check: CHANGELOG.md heading "${headingLine}" is missing a " - <date>" suffix.`,
    );
  } else {
    const dateMatch = /^## \[.+\] - (.+)$/.exec(headingLine);
    const date = dateMatch ? dateMatch[1].trim() : "";
    // Probe the date alone: the parser also rejects a YYYY-MM-DD-shaped but
    // impossible calendar date (e.g. 2026-02-30), so ask it with a dummy body.
    const dateOk =
      parseChangelogSection(`## [${version}] - ${date}\nx\n`, version) !== null;
    if (!dateOk) {
      console.error(
        `release-check: CHANGELOG.md heading "${headingLine}" has an invalid date "${date}" (expected YYYY-MM-DD).`,
      );
    } else {
      console.error(
        `release-check: CHANGELOG.md section for ${version} (dated ${date}) has an empty body.`,
      );
    }
  }
  process.exit(1);
}

const status = execFileSync("git", ["status", "--porcelain"], {
  cwd: repoRoot,
  encoding: "utf8",
});

if (status.trim() !== "") {
  const dirtyPaths = status
    .split("\n")
    .filter((line) => line.trim() !== "");
  console.error(
    `release-check: working tree is not clean:\n${dirtyPaths.join("\n")}`,
  );
  process.exit(1);
}

console.log(`release-check: OK \u2013 version ${version} dated ${section.date}`);
