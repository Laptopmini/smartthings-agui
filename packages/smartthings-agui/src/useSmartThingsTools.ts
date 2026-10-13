import { useFrontendTool } from "@copilotkit/react-core/v2";
import { jsonSchemaParameters } from "./capabilityTools";
import type { SmartThingsClient } from "./client";

const NO_PARAMETERS = jsonSchemaParameters<Record<string, never>>({ type: "object", properties: {} });

type SetSwitchArgs = { deviceId: string; state: "on" | "off" };

const SET_SWITCH_PARAMETERS = jsonSchemaParameters<SetSwitchArgs>({
  type: "object",
  properties: {
    deviceId: { type: "string", description: "Device id from list_devices" },
    // The enum is lost in the LlamaIndex router, so the
    // description carries the allowed values too.
    state: { type: "string", enum: ["on", "off"], description: "state (one of: on, off)" },
  },
  required: ["deviceId", "state"],
});

/** Registers the SmartThings frontend tools with CopilotKit.
 *
 *  Phase 0 spike: `list_devices` and `set_switch` only. Handlers run in the
 *  browser with the user's token; the agent sees arguments and results only.
 */
export function useSmartThingsTools(client: SmartThingsClient) {
  useFrontendTool(
    {
      name: "list_devices",
      description: "List the user's SmartThings devices with their ids, labels and capabilities.",
      parameters: NO_PARAMETERS,
      handler: async () => client.listDevices(),
    },
    [client],
  );

  useFrontendTool<SetSwitchArgs>(
    {
      name: "set_switch",
      description: "Turn a SmartThings device with the switch capability on or off.",
      parameters: SET_SWITCH_PARAMETERS,
      handler: async ({ deviceId, state }) => {
        if (state !== "on" && state !== "off") throw new Error(`state must be "on" or "off", got ${state}`);
        await client.executeCommands(deviceId, [{ capability: "switch", command: state }]);
        // Read back rather than echo the request: the result reports what the
        // platform says, which is what the device card will show.
        const status = await client.getCapabilityStatus(deviceId, "switch");
        return { deviceId, switch: status.switch?.value };
      },
    },
    [client],
  );
}
