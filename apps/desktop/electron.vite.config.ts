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
    // electron-vite's preload preset forces `ssr.noExternal = true`, which tells
    // the SSR bundler to inline every dependency. Under vite 8 (Rolldown) that now
    // wins over `rollupOptions.external`, so `electron` gets bundled: Rolldown pulls
    // in node_modules/electron/index.js — the binary-path shim (spawnSync into
    // install.js) — instead of leaving `require("electron")` external. The bundled
    // shim returns a path string, so `ipcRenderer` is undefined at runtime and the
    // contextBridge/window.zeo setup silently fails. Listing electron in
    // `ssr.external` takes precedence over noExternal and keeps it a runtime require.
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
