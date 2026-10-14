import { defineConfig } from "vite";

/** Library build: src/index.ts → dist/index.js (ES module). Dependencies and
 *  peers stay external, including their subpaths (`@copilotkit/react-core/v2`,
 *  `zod/v3`, `react/jsx-runtime`), so the host app gets one copy of each.
 *  Type declarations come from tsc (tsconfig.build.json). */
const external = [
  "react",
  "@copilotkit/react-core",
  "@copilotkit/a2ui-renderer",
  "@a2ui/web_core",
  "zod",
];

export default defineConfig({
  build: {
    lib: { entry: "src/index.ts", formats: ["es"], fileName: "index" },
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    rollupOptions: {
      external: (id) => external.some((dep) => id === dep || id.startsWith(`${dep}/`)),
    },
  },
});
