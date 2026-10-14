import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";

/** Same-origin routes to the two local services, for `vite` and `vite preview`
 *  alike (the app uses /agent/run and /exchange by default). The browser talks
 *  to one origin only: no agent URL or CORS to configure, the services can
 *  stay on loopback while a phone uses the app over the network, and an HTTPS
 *  page never calls plain-http services (mixed content). */
const AGENT = process.env.AGENT_TARGET ?? "http://127.0.0.1:8000";
const EXCHANGE = process.env.EXCHANGE_TARGET ?? "http://127.0.0.1:8001";
const proxy: Record<string, ProxyOptions> = {
  "/agent": { target: AGENT, changeOrigin: true, rewrite: (p) => p.replace(/^\/agent/, "") },
  "/exchange": { target: EXCHANGE, changeOrigin: true, rewrite: (p) => p.replace(/^\/exchange/, "") },
};

/** Optional HTTPS (`DEMO_TLS_KEY`/`DEMO_TLS_CERT`, PEM files). SmartThings
 *  accepts plain-http OAuth redirect URIs only for localhost, so signing in
 *  from a phone needs the app on https://<address>/ (checked 13 Oct 2026). */
const https =
  process.env.DEMO_TLS_KEY && process.env.DEMO_TLS_CERT
    ? { key: readFileSync(process.env.DEMO_TLS_KEY), cert: readFileSync(process.env.DEMO_TLS_CERT) }
    : undefined;

// `SMARTTHINGS_DEV_TOKEN` pre-fills the sign-in field so the page can be driven
// without pasting a token. It is injected only by the dev server
// (`command === "serve"`), never into a build, and lives only in memory.
export default defineConfig(({ command, mode }) => {
  // The repo's single .env (shared with the agent). Only the OAuth client id is
  // read from it: it's public by design. The client secret stays server-side.
  const env = { ...loadEnv(mode, new URL("../..", import.meta.url).pathname, ""), ...process.env };
  return {
    plugins: [react()],
    // The package's source, not its build: edits show up without a rebuild.
    resolve: { alias: { "smartthings-agui": new URL("../../packages/smartthings-agui/src/index.ts", import.meta.url).pathname } },
    define: {
      __DEV_SMARTTHINGS_TOKEN__: JSON.stringify(command === "serve" ? (env.SMARTTHINGS_DEV_TOKEN ?? "") : ""),
      __SMARTTHINGS_CLIENT_ID__: JSON.stringify(env.SMARTTHINGS_CLIENT_ID ?? ""),
    },
    // DEMO_HOST=0.0.0.0 makes the app reachable from a phone on the same network
    // (the agent and token exchange stay on loopback behind the proxy).
    server: { proxy, https, host: env.DEMO_HOST },
    preview: { proxy, https, host: env.DEMO_HOST },
  };
});
