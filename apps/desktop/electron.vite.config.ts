import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// Main and preload only; there is no renderer block. The renderer is built by
// @zeo/ui and copied into out/renderer by scripts/copy-renderer.mjs after this
// build runs. @zeo/core and @zeo/adblock are excluded from externalization so
// they are bundled into out/main/index.js rather than required from node_modules
// at runtime. @zeo/adblock's runtime dep @ghostery/adblocker-electron is a
// direct dependency here and stays externalized (like better-sqlite3), so the
// bundle keeps a bare import resolved from node_modules.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@zeo/core", "@zeo/adblock"] })],
    ssr: {
      external: ["electron"],
    },
    build: {
      lib: {
        entry: "src/main/index.ts",
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@zeo/core", "@zeo/adblock"] })],
    ssr: {
      external: ["electron"],
    },
    build: {
      lib: {
        entry: "src/preload/index.ts",
        // Force CommonJS: an ESM preload can fail to run contextBridge under
        // contextIsolation. Emit .cjs (not .js) so Electron treats it as CJS
        // regardless of the package's "type": "module".
        formats: ["cjs"],
      },
      rollupOptions: {
        output: {
          entryFileNames: "index.cjs",
        },
      },
    },
  },
});
