import { HttpAgent } from "@ag-ui/client";
import { CopilotChat, CopilotKit, useCopilotKit } from "@copilotkit/react-core/v2";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SmartThingsClient } from "../../src/client";
import type { ConfirmCapability } from "../../src/policy";
import { useSmartThingsTools } from "../../src/useSmartThingsTools";
import { fakeSmartThings } from "../fakeSmartThings";
import { AGENT_PORT } from "./port";

/** The frontend-tool loop on direct connect, end to end except for the model.
 *
 *  Real CopilotKit 1.79.0 + @ag-ui/client 1.0.2 in jsdom, over real HTTP to
 *  the real agent (agent/serve.py --scripted). Stand-ins: the model (scripted)
 *  and api.smartthings.com (fakeSmartThings). Browser-only concerns (CORS,
 *  layout) are covered by apps/demo/e2e, not here.
 */

// jsdom lacks these; CopilotChat's layout code uses them.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollTo ??= function () {};
Element.prototype.scrollIntoView ??= function () {};

type AgentRequest = {
  tools: { name: string; parameters: Record<string, unknown> }[];
  messages: { role: string; content?: unknown }[];
  context: { description: string; value: string }[];
};

let agentRequests: AgentRequest[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  agentRequests = [];
  // Record what CopilotKit sends to the agent, then pass it through unchanged.
  globalThis.fetch = async (input, init) => {
    if (String(input).includes(`:${AGENT_PORT}/run`)) agentRequests.push(JSON.parse(String(init?.body)));
    return realFetch(input, init);
  };
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

let core: ReturnType<typeof useCopilotKit>["copilotkit"] | undefined;

function Harness({ client, confirm }: { client: SmartThingsClient; confirm: ConfirmCapability[] }) {
  useSmartThingsTools(client, { confirmCapabilities: confirm });
  core = useCopilotKit().copilotkit;
  return null;
}

function mount(confirm: ConfirmCapability[] = [], chat = false) {
  const smartthings = fakeSmartThings();
  const client = new SmartThingsClient("test-token", smartthings.impl);
  const agent = new HttpAgent({ url: `http://127.0.0.1:${AGENT_PORT}/run` });
  render(
    <CopilotKit selfManagedAgents={{ default: agent }} enableInspector={false}>
      <Harness client={client} confirm={confirm} />
      {chat && <CopilotChat />}
    </CopilotKit>,
  );
  const send = (content: string) => {
    agent.addMessage({ id: `u${agent.messages.length}`, role: "user", content });
    return core!.runAgent({ agent });
  };
  return { smartthings, agent, send };
}

it("runs list_devices then set_switch in the browser and finishes the turn", async () => {
  const { smartthings, agent, send } = mount();
  // The home context loads asynchronously; a message sent before then gets
  // "Loading the device list…" as context (the tools still work).
  await waitFor(() => expect(smartthings.calls.some((c) => c.path === "/scenes")).toBe(true));
  await act(async () => {});
  await act(async () => {
    await send("Turn on Desk Lamp");
  });

  expect(smartthings.byId.get("dimmer")!.status.switch.switch.value).toBe("on");
  expect(smartthings.commandsSent().map((c) => c.path)).toEqual(["/devices/dimmer/commands"]);

  // Three runs: initial, after list_devices, after set_switch.
  expect(agentRequests).toHaveLength(3);
  const names = agentRequests[0].tools.map((t) => t.name).sort();
  expect(names).toEqual([
    "execute_command",
    "get_device_status",
    "list_devices",
    "list_scenes",
    "run_scene",
    "set_color",
    "set_level",
    "set_switch",
    "set_thermostat",
    "show_devices",
    "show_scenes",
  ]);
  // CopilotKit forwards the JSON Schema verbatim (enum intact; the LlamaIndex router drops it later).
  expect(agentRequests[0].tools.find((t) => t.name === "set_switch")?.parameters).toMatchObject({
    properties: { state: { enum: ["on", "off"] } },
  });
  // The home reaches the agent as AG-UI context (agent/router.py renders it for the model).
  expect(agentRequests[0].context[0].value).toContain("Desk Lamp (Office) id=dimmer");
  // The token never reaches the agent.
  expect(JSON.stringify(agentRequests)).not.toContain("test-token");
  // With agent/router.py's fix the echoed system message has a stable id, so the
  // thread holds one copy rather than one per run.
  expect(agentRequests[2].messages.filter((m) => m.role === "system").length).toBeLessThanOrEqual(1);

  const last = agent.messages.at(-1);
  expect(last?.role).toBe("assistant");
  expect(String(last?.content)).toContain('"switch":"on"');
});

it("sends string numbers from the agent through to a typed command", async () => {
  const { smartthings, send } = mount();
  await act(async () => {
    await send("Dim Desk Lamp to 30");
  });
  expect(smartthings.byId.get("dimmer")!.status.switchLevel.level.value).toBe(30);
});

it("doesn't offer confirm_command until a capability is turned on", async () => {
  const { smartthings, send } = mount([]);
  await act(async () => {
    await send("Unlock Front Door");
  });
  expect(agentRequests[0].tools.map((t) => t.name)).not.toContain("confirm_command");
  expect(smartthings.byId.get("lock")!.status.lock.lock.value).toBe("locked");
  expect(smartthings.commandsSent()).toHaveLength(0);
});

it("unlocks only after the person clicks the confirmation button", async () => {
  const { smartthings, agent, send } = mount(["lock"], true);
  let run!: Promise<unknown>;
  act(() => {
    run = send("Unlock Front Door");
  });

  const button = await screen.findByRole("button", { name: "Unlock" }, { timeout: 10_000 });
  expect(screen.getByTestId("confirm-card").textContent).toContain("unlock Front Door (Living Room)?");
  // Asked, not acted.
  expect(smartthings.commandsSent()).toHaveLength(0);
  expect(smartthings.byId.get("lock")!.status.lock.lock.value).toBe("locked");

  await act(async () => {
    button.click();
    await run;
  });
  await waitFor(() => expect(smartthings.byId.get("lock")!.status.lock.lock.value).toBe("unlocked"));
  await waitFor(() => expect(String(agent.messages.at(-1)?.content)).toContain('"lock":"unlocked"'));
  expect(smartthings.commandsSent()).toHaveLength(1);
});

it("leaves the lock alone when the person cancels", async () => {
  const { smartthings, agent, send } = mount(["lock"], true);
  act(() => {
    void send("Unlock Front Door");
  });
  const cancel = await screen.findByRole("button", { name: "Cancel" }, { timeout: 10_000 });
  await act(async () => cancel.click());
  await waitFor(() => expect(String(agent.messages.at(-1)?.content)).toContain("declined"));
  expect(smartthings.commandsSent()).toHaveLength(0);
  expect(smartthings.byId.get("lock")!.status.lock.lock.value).toBe("locked");
});

it("shows a room as A2UI cards whose controls work and stay live", async () => {
  const { smartthings, send } = mount([], true);
  await act(async () => {
    await send("Show Office");
  });
  const tiles = await screen.findAllByTestId("device-tile", {}, { timeout: 10_000 });
  expect(tiles.map((t) => t.dataset.label)).toEqual(["Desk Lamp", "Water Valve", "Office Blind"]);
  // The valve exposes switch too, but its tile has no controls (policy rule 2).
  expect(tiles[1].querySelector("button")).toBeNull();

  // A click on the card runs the command in the browser, with no agent run.
  const runsBefore = agentRequests.length;
  await act(async () => {
    tiles[0].querySelector("button")!.click();
  });
  await waitFor(() => expect(smartthings.byId.get("dimmer")!.status.switch.switch.value).toBe("on"));
  expect(agentRequests.length).toBe(runsBefore);
  await waitFor(() => expect(screen.getAllByTestId("tile-state")[0].textContent).toBe("On · 10%"));

  // The agent then turns the lamp off: the earlier card follows.
  await act(async () => {
    await send("Turn off Desk Lamp");
  });
  await waitFor(() => expect(screen.getAllByTestId("tile-state")[0].textContent).toBe("Off"));
});
