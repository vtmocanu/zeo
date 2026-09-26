// Packages the desktop app with electron-builder, invoked as the root
// `pnpm package` script (after `pnpm build`). Hard-checks the electron-vite
// build output and the app icon exist before invoking electron-builder, and
// threads the root package.json version into the packaged bundle via
// extraMetadata.version.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const desktopRoot = resolve(repoRoot, "apps", "desktop");

const requiredOutputs = [
  resolve(desktopRoot, "out", "main", "index.js"),
  resolve(desktopRoot, "out", "renderer", "index.html"),
];

for (const outputPath of requiredOutputs) {
  if (!existsSync(outputPath)) {
    console.error(
      `Missing build output ${outputPath} – run \`pnpm build\` first.`,
    );
    process.exit(1);
  }
}

const iconPath = resolve(desktopRoot, "build", "icon.png");
if (!existsSync(iconPath)) {
  console.error(
    `Missing app icon ${iconPath} – electron-builder would silently fall back to the default Electron icon; restore apps/desktop/build/icon.png.`,
  );
  process.exit(1);
}

const rootPackageJson = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
);
const version = rootPackageJson.version;

const result = spawnSync(
  "pnpm",
  [
    "exec",
    "electron-builder",
    "--mac",
    "--arm64",
    "--publish",
    "never",
    `-c.extraMetadata.version=${version}`,
  ],
  { cwd: desktopRoot, stdio: "inherit" },
);

if (result.error) {
  console.error(result.error);
}

process.exit(result.status ?? 1);
