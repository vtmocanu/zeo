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
          paths: [
            {
              name: "electron",
              message: "apps/ui must not use Node/Electron APIs; use the IPC bridge",
            },
            {
              name: "fs",
              message: "apps/ui must not use Node/Electron APIs; use the IPC bridge",
            },
            {
              name: "path",
              message: "apps/ui must not use Node/Electron APIs; use the IPC bridge",
            },
            {
              name: "os",
              message: "apps/ui must not use Node/Electron APIs; use the IPC bridge",
            },
            {
              name: "child_process",
              message: "apps/ui must not use Node/Electron APIs; use the IPC bridge",
            },
            {
              name: "crypto",
              message: "apps/ui must not use Node/Electron APIs; use the IPC bridge",
            },
            {
              name: "http",
              message: "apps/ui must not use Node/Electron APIs; use the IPC bridge",
            },
            {
              name: "https",
              message: "apps/ui must not use Node/Electron APIs; use the IPC bridge",
            },
            {
              name: "net",
              message: "apps/ui must not use Node/Electron APIs; use the IPC bridge",
            },
          ],
          patterns: [
            {
              group: ["electron/*", "node:*"],
              message: "apps/ui must not use Node/Electron APIs; use the IPC bridge",
            },
          ],
        },
      ],
    },
  },
  prettier,
);
