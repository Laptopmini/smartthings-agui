import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { defineConfig, type ProxyOptions } from "vite";

/** Same-origin routes to the two local services, for `vite` and `vite preview`
 *  alike. With `VITE_AGENT_URL=/agent/run` and `VITE_TOKEN_EXCHANGE_URL=/exchange`
 *  the browser talks to one origin only, so the agent and the token exchange
 *  can stay on loopback while a phone uses the app over the network, and an
 *  HTTPS page never calls plain-http services (mixed content). */
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
export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: {
    __DEV_SMARTTHINGS_TOKEN__: JSON.stringify(
      command === "serve" ? (process.env.SMARTTHINGS_DEV_TOKEN ?? "") : "",
    ),
  },
  server: { proxy, https },
  preview: { proxy, https },
}));
