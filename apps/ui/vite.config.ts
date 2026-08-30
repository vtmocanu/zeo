import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" so the built index.html references assets by relative path,
// which is required because Electron loads the renderer via file://.
export default defineConfig({
  plugins: [react()],
  base: "./",
});
