import { HttpAgent } from "@ag-ui/client";
import { CopilotChat, CopilotKit, useCopilotKit } from "@copilotkit/react-core/v2";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SmartThingsClient } from "../../src/client";
import type { ConfirmCapability } from "../../src/policy";
import { useSmartThingsTools } from "../../src/useSmartThingsTools";
import { fakeSmartThings } from "../fakeSmartThings";
import { AGENT_PORT } from "./port";

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollTo ??= function () {};
Element.prototype.scrollIntoView ??= function () {};
afterEach(cleanup);

let core: ReturnType<typeof useCopilotKit>["copilotkit"] | undefined;
const openSettings = vi.fn();
function Harness({ client, confirm }: { client: SmartThingsClient; confirm: ConfirmCapability[] }) {
  useSmartThingsTools(client, { confirmCapabilities: confirm, onOpenSettings: openSettings });
  core = useCopilotKit().copilotkit;
  return null;
}

it("a turned-off control points at the settings, then continues once it's turned on", async () => {
  const smartthings = fakeSmartThings();
  const client = new SmartThingsClient("t", smartthings.impl);
  const agent = new HttpAgent({ url: `http://127.0.0.1:${AGENT_PORT}/run` });
  const requests: { tools: { name: string }[] }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes(`:${AGENT_PORT}/run`)) requests.push(JSON.parse(String(init?.body)));
    return realFetch(input, init);
  };
  try {
    const tree = (confirm: ConfirmCapability[]) => (
      <CopilotKit selfManagedAgents={{ default: agent }} enableInspector={false}>
        <Harness client={client} confirm={confirm} />
        <CopilotChat />
      </CopilotKit>
    );
    const { rerender } = render(tree([]));
    // Locks off: the card says so and offers the settings; nothing runs.
    let run!: Promise<unknown>;
    act(() => {
      agent.addMessage({ id: "u1", role: "user", content: "Unlock Front Door" });
      run = core!.runAgent({ agent });
    });
    const open = await screen.findByRole("button", { name: "Open Safety settings" }, { timeout: 10_000 });
    expect(screen.getByTestId("confirm-disabled").textContent).toMatch(/Locks are turned off/);
    act(() => open.click());
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(smartthings.commandsSent()).toHaveLength(0);

    // The person ticks Locks: the same card becomes the confirmation, and
    // still nothing runs until Unlock is pressed.
    rerender(tree(["lock"]));
    const button = await screen.findByRole("button", { name: "Unlock" }, { timeout: 10_000 });
    expect(smartthings.commandsSent()).toHaveLength(0);
    await act(async () => {
      button.click();
      await run;
    });
    expect(smartthings.byId.get("lock")!.status.lock.lock.value).toBe("unlocked");
    const last = requests.at(-1)!;
    expect(last.tools.map((t) => t.name)).toContain("confirm_command");
  } finally {
    globalThis.fetch = realFetch;
  }
});
