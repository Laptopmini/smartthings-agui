import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev-only convenience for the Phase 0 spike: `SMARTTHINGS_DEV_TOKEN` pre-fills
// the sign-in field so the page can be driven without pasting a token. It is
// injected only by the dev server (`command === "serve"`), never into a build,
// and lives only in memory: nothing is written to disk.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: {
    __DEV_SMARTTHINGS_TOKEN__: JSON.stringify(
      command === "serve" ? (process.env.SMARTTHINGS_DEV_TOKEN ?? "") : "",
    ),
  },
}));
