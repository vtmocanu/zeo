// Copies the built @zeo/ui renderer (apps/ui/dist) into this app's
// out/renderer directory so Electron can load it via file://. electron-vite
// builds only main and preload; the renderer is a separate Vite build.
import { cpSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const uiDist = resolve(desktopRoot, "..", "ui", "dist");
const outRenderer = resolve(desktopRoot, "out", "renderer");

if (!existsSync(uiDist)) {
  throw new Error(
    `Renderer build not found at ${uiDist}. Build @zeo/ui first (pnpm --filter @zeo/ui run build).`,
  );
}

cpSync(uiDist, outRenderer, { recursive: true });
console.log(`Copied renderer from ${uiDist} to ${outRenderer}`);

// Also ship the @zeo/adblock cosmetic frame preload as a sibling of the main
// bundle. electron-vite builds only main + the desktop renderer preload; this
// library-owned preload (registered on profile sessions by the blocker) is a
// plain .cjs asset, so copy it into out/preload where main resolves it.
const cosmeticPreloadSrc = resolve(
  desktopRoot, "..", "..", "packages", "adblock", "preload", "cosmetic-preload.cjs",
);
const cosmeticPreloadDest = resolve(desktopRoot, "out", "preload", "cosmetic-preload.cjs");
if (!existsSync(cosmeticPreloadSrc)) {
  throw new Error(`Cosmetic preload not found at ${cosmeticPreloadSrc}.`);
}
cpSync(cosmeticPreloadSrc, cosmeticPreloadDest);
console.log(`Copied cosmetic preload from ${cosmeticPreloadSrc} to ${cosmeticPreloadDest}`);
