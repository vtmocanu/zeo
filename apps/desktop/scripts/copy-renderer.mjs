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
