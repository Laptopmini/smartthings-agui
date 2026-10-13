import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AGENT_PORT } from "./port";

/** vitest globalSetup: start the reference agent with its scripted LLM.
 *  No model and no SmartThings involved; see agent/scripted_llm.py. */
const agentDir = fileURLToPath(new URL("../../../../agent", import.meta.url));

let server: ChildProcess | undefined;

export async function setup() {
  server = spawn("uv", ["run", "python", "serve.py", "--scripted", "--port", String(AGENT_PORT)], {
    cwd: agentDir,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  server.stderr?.on("data", (d) => (stderr += d));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${AGENT_PORT}/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  server.kill();
  throw new Error(`agent did not start:\n${stderr}`);
}

export async function teardown() {
  server?.kill();
}
