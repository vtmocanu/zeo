// Prints the CHANGELOG.md body for a given version to stdout. Used by the
// release workflow to build the GitHub Release notes:
//   node scripts/changelog-section.mjs <version>
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseChangelogSection } from "@zeo/core";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const version = process.argv[2];
if (!version) {
  console.error("Usage: node scripts/changelog-section.mjs <version>");
  process.exit(1);
}

const changelog = readFileSync(resolve(repoRoot, "CHANGELOG.md"), "utf8");
const section = parseChangelogSection(changelog, version);

if (section === null) {
  console.error(
    `changelog-section: no CHANGELOG.md section found for version ${version}.`,
  );
  process.exit(1);
}

process.stdout.write(`${section.body}\n`);
