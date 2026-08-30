import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// Main and preload only; there is no renderer block. The renderer is built by
// @zeo/ui and copied into out/renderer by scripts/copy-renderer.mjs after this
// build runs. @zeo/core is excluded from externalization so it is bundled into
// out/main/index.js rather than required from node_modules at runtime.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@zeo/core"] })],
    build: {
      lib: {
        entry: "src/main/index.ts",
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@zeo/core"] })],
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
