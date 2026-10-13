import { HttpAgent } from "@ag-ui/client";
import { CopilotKit, useCopilotKit } from "@copilotkit/react-core/v2";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SmartThingsClient } from "../../src/client";
import { useSmartThingsTools } from "../../src/useSmartThingsTools";
import { AGENT_PORT } from "./port";

/** Phase 0 item 2: the frontend-tool round trip on direct connect.
 *
 *  Real CopilotKit 1.79.0 + @ag-ui/client 1.0.2 in jsdom, over real HTTP to
 *  the real Python router (agent/serve.py --scripted). Only two things are
 *  stand-ins: the model (scripted) and api.smartthings.com (fakeSmartThings).
 *  Browser-only concerns (CORS, rendering) are not covered here.
 */

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

afterEach(cleanup);

const DEVICES = {
  items: [
    { deviceId: "dev-1", label: "Tall Lamp", components: [{ id: "main", capabilities: [{ id: "switch", version: 1 }] }] },
    { deviceId: "dev-2", label: "Spike Switch", components: [{ id: "main", capabilities: [{ id: "switch", version: 1 }] }] },
  ],
};

function fakeSmartThings() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const state: Record<string, string> = { "dev-1": "off", "dev-2": "off" };
  const impl: typeof fetch = async (input, init) => {
    const path = String(input).replace("https://api.smartthings.com/v1", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (path === "/devices") return Response.json(DEVICES);
    const commands = path.match(/^\/devices\/([^/]+)\/commands$/);
    if (commands && method === "POST") {
      state[commands[1]] = body.commands[0].command;
      return Response.json({ results: [{ id: "x", status: "ACCEPTED" }] });
    }
    const status = path.match(/^\/devices\/([^/]+)\/components\/main\/capabilities\/switch\/status$/);
    if (status) return Response.json({ switch: { value: state[status[1]] } });
    return new Response("not found", { status: 404 });
  };
  return { impl, calls, state };
}

let core: ReturnType<typeof useCopilotKit>["copilotkit"] | undefined;

function Harness({ client }: { client: SmartThingsClient }) {
  useSmartThingsTools(client);
  core = useCopilotKit().copilotkit;
  return null;
}

it("runs list_devices then set_switch in the browser and finishes the turn", async () => {
  const smartthings = fakeSmartThings();
  const client = new SmartThingsClient("test-token", smartthings.impl);

  // Record what CopilotKit sends to the agent, then pass it through unchanged.
  const agentRequests: { tools: { name: string; parameters: Record<string, unknown> }[]; messages: unknown[] }[] = [];
  const realFetch = globalThis.fetch;
  const recordingFetch: typeof fetch = async (input, init) => {
    if (String(input).includes(`:${AGENT_PORT}/run`)) agentRequests.push(JSON.parse(String(init?.body)));
    return realFetch(input, init);
  };
  globalThis.fetch = recordingFetch;

  try {
    const agent = new HttpAgent({ url: `http://127.0.0.1:${AGENT_PORT}/run` });
    render(
      <CopilotKit selfManagedAgents={{ default: agent }} enableInspector={false}>
        <Harness client={client} />
      </CopilotKit>,
    );

    await act(async () => {
      agent.addMessage({ id: "u1", role: "user", content: "Turn on Spike Switch" });
      await core!.runAgent({ agent });
    });

    // The device changed, via the browser-side client, with the token.
    expect(smartthings.state["dev-2"]).toBe("on");
    expect(smartthings.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /devices",
      "POST /devices/dev-2/commands",
      "GET /devices/dev-2/components/main/capabilities/switch/status",
    ]);

    // Three runs: initial, after list_devices, after set_switch.
    expect(agentRequests).toHaveLength(3);
    const setSwitch = agentRequests[0].tools.find((t) => t.name === "set_switch");
    // CopilotKit forwards the generated JSON Schema verbatim (enum intact).
    expect(setSwitch?.parameters).toMatchObject({
      properties: { state: { enum: ["on", "off"] } },
      required: ["deviceId", "state"],
    });
    // The token never reaches the agent.
    expect(JSON.stringify(agentRequests)).not.toContain("test-token");

    const roles = agent.messages.map((m) => m.role);
    expect(roles.filter((r) => r !== "system")).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant"]);
    // Known upstream behaviour (llama-index-protocols-ag-ui 0.5.0): each run's
    // MESSAGES_SNAPSHOT includes the server-side system prompt, CopilotKit
    // adopts it into the thread and resends it, and the router prepends a new
    // one, so the model sees runs + 1 copies. If this fails, it was fixed.
    expect(roles.filter((r) => r === "system")).toHaveLength(3);
    expect(agentRequests[2].messages.filter((m) => (m as { role: string }).role === "system")).toHaveLength(2);
    const last = agent.messages.at(-1);
    expect(last?.content).toContain('"switch":"on"');
  } finally {
    globalThis.fetch = realFetch;
  }
});
