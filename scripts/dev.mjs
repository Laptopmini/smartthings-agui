// npm run dev: the agent, the demo and (when OAuth is configured) the token
// exchange, in one terminal. Settings come from the repo's .env.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = new URL("..", import.meta.url).pathname;
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);

// Certificate paths are given relative to the repo root; the demo runs from apps/demo.
for (const name of ["DEMO_TLS_KEY", "DEMO_TLS_CERT"]) {
  if (process.env[name]) process.env[name] = resolve(root, process.env[name]);
}

const missing = ["AGENT_API_BASE", "AGENT_API_KEY", "AGENT_MODEL"].filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Set ${missing.join(", ")} in .env (cp .env.example .env), then run npm run dev again.`);
  process.exit(1);
}

const services = [
  ["agent", "uv", ["run", "python", "serve.py"], `${root}agent`],
  ["demo", "npm", ["run", "dev", "-w", "demo"], root],
];
if (process.env.SMARTTHINGS_CLIENT_ID && process.env.SMARTTHINGS_CLIENT_SECRET) {
  services.push(["oauth", "uv", ["run", "python", "token_exchange.py"], `${root}agent`]);
}

const children = services.map(([name, cmd, args, cwd]) => {
  const child = spawn(cmd, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = (chunk) => chunk.toString().replace(/^(?=.)/gm, `[${name}] `);
  child.stdout.on("data", (c) => process.stdout.write(prefix(c)));
  child.stderr.on("data", (c) => process.stderr.write(prefix(c)));
  child.on("exit", (code) => {
    console.error(`[${name}] exited (${code}); stopping everything.`);
    shutdown(code ?? 1);
  });
  return child;
});

const scheme = process.env.DEMO_TLS_KEY ? "https" : "http";
console.log(`Starting ${services.map(([n]) => n).join(", ")}. Open ${scheme}://localhost:5173 (Ctrl+C to stop).`);
let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
