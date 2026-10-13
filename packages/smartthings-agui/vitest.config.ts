import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    css: false,
    // CopilotKit's JS imports its own CSS; inlining runs it through vite's transform.
    server: { deps: { inline: [/@copilotkit/, /@ag-ui/] } },
    projects: [
      { extends: true, test: { name: "unit", include: ["test/*.test.ts", "test/*.test.tsx"] } },
      // Calls api.smartthings.com; skipped unless SMARTTHINGS_TOKEN is set.
      { extends: true, test: { name: "live", include: ["test/live/*.live.test.ts"], environment: "node" } },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/integration/*.test.tsx"],
          // Starts agent/serve.py --scripted (needs `uv`); no model, no SmartThings.
          globalSetup: ["test/integration/agentServer.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
