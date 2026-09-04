import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/*.d.ts",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/.vite/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node-executed tooling: build scripts and config files run under Node and
    // may use Node globals such as console/process.
    files: ["**/*.mjs", "**/*.config.{js,ts}", "**/scripts/**"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    files: ["packages/core/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "electron",
              message: "packages/core must stay electron-free",
            },
          ],
          patterns: [
            {
              group: ["electron/*"],
              message: "packages/core must stay electron-free",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "electron",
                "electron/*",
                "node:*",
                "assert",
                "assert/*",
                "buffer",
                "child_process",
                "crypto",
                "crypto/*",
                "dns",
                "dns/*",
                "events",
                "fs",
                "fs/*",
                "http",
                "http2",
                "https",
                "net",
                "os",
                "path",
                "path/*",
                "process",
                "readline",
                "readline/*",
                "stream",
                "stream/*",
                "timers",
                "timers/*",
                "tls",
                "url",
                "util",
                "util/*",
                "v8",
                "vm",
                "worker_threads",
                "zlib",
              ],
              message: "apps/ui must not use Node/Electron APIs; use the IPC bridge",
            },
          ],
        },
      ],
    },
  },
  {
    // The @zeo/adblock cosmetic frame preload is a hand-written CommonJS script
    // that runs in a sandboxed browser frame: it uses `require("electron")` plus
    // DOM globals (window/document/MutationObserver), so it needs the CommonJS
    // source type and browser globals rather than the default ESM/Node setup.
    files: ["packages/adblock/preload/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        window: "readonly",
        document: "readonly",
        MutationObserver: "readonly",
        requestIdleCallback: "readonly",
        setTimeout: "readonly",
        require: "readonly",
        module: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  prettier,
);
