import { useAgentContext, useFrontendTools, useHumanInTheLoop } from "@copilotkit/react-core/v2";
import { useEffect, useMemo, useState } from "react";
import { ConfirmCard, DeviceCard, DeviceListCard, ErrorCard, PendingCard, parseResult } from "./cards";
import type { DeviceSummary, SceneSummary, SmartThingsClient } from "./client";
import type { ConfirmCapability } from "./policy";
import { createTools, isToolError, type ConfirmArgs, type DeviceResult } from "./tools";

export interface SmartThingsToolsOptions {
  /** CONFIRM capabilities the user has turned on. Default: none, so locks,
   *  doors, valves and security systems can't be commanded at all. */
  confirmCapabilities?: readonly ConfirmCapability[];
  /** Send the device and scene list to the agent as context (default true). */
  context?: boolean;
}

type RenderProps = { name: string; status: string; result?: string };

/** One renderer for every frontend tool: the card follows the result's shape. */
function ToolCard({ name, status, result }: RenderProps) {
  if (status !== "complete") return <PendingCard text={name === "list_devices" ? "Looking up devices…" : "Working…"} />;
  const parsed = parseResult<unknown>(result);
  if (!parsed) return null;
  if (isToolError(parsed)) return <ErrorCard message={parsed.error} />;
  if (Array.isArray(parsed)) {
    return name === "list_devices" ? <DeviceListCard devices={parsed as DeviceSummary[]} /> : null;
  }
  if (typeof parsed === "object" && "state" in parsed) return <DeviceCard device={parsed as DeviceResult} />;
  return null;
}

/** Compact text the model reads before choosing a tool: one line per device
 *  and scene. ~60 characters a device, so a 50-device home is ~3k characters. */
export function describeHome(devices: DeviceSummary[], scenes: SceneSummary[]): string {
  const lines = devices.map(
    (d) => `- ${d.label}${d.room ? ` (${d.room})` : ""} id=${d.deviceId}: ${d.capabilities.filter((c) => !c.includes(".")).join(", ")}`,
  );
  const sceneLines = scenes.map((s) => `- ${s.name} id=${s.sceneId}`);
  return `Devices:\n${lines.join("\n")}\n\nScenes:\n${sceneLines.join("\n") || "(none)"}`;
}

function useHomeContext(client: SmartThingsClient, enabled: boolean) {
  const [value, setValue] = useState("Loading the device list…");
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    Promise.all([client.listDevices(), client.listScenes()])
      .then(([devices, scenes]) => live && setValue(describeHome(devices, scenes)))
      .catch((error: Error) => live && setValue(`The device list couldn't be loaded (${error.message}).`));
    return () => {
      live = false;
    };
  }, [client, enabled]);
  useAgentContext({ description: "The user's SmartThings home", value: enabled ? value : "" });
}

/** Registers the SmartThings tools, device cards and confirmation flow with
 *  CopilotKit. Handlers run in the browser with the user's token; the agent
 *  sees only arguments and results. */
export function useSmartThingsTools(client: SmartThingsClient, options: SmartThingsToolsOptions = {}) {
  const key = [...(options.confirmCapabilities ?? [])].sort().join(",");
  const tools = useMemo(
    () => createTools(client, { confirmCapabilities: new Set(key ? (key.split(",") as ConfirmCapability[]) : []) }),
    [client, key],
  );

  useFrontendTools(
    tools.frontend.map((tool) => ({ ...tool, render: ToolCard })),
    [tools],
  );

  const { confirmCommand, runScene } = tools;
  useHumanInTheLoop<ConfirmArgs>(
    {
      name: confirmCommand.name,
      description: confirmCommand.description,
      parameters: confirmCommand.parameters,
      // Not offered to the agent at all until the user opts in to a capability.
      available: confirmCommand.available,
      render: (props) => (
        <ConfirmCard
          {...props}
          prepare={confirmCommand.prepare}
          execute={confirmCommand.execute}
          confirmLabel={props.args.command ? capitalize(String(props.args.command)) : "Confirm"}
        />
      ),
    },
    [tools],
  );

  useHumanInTheLoop<{ sceneId: string }>(
    {
      name: runScene.name,
      description: runScene.description,
      parameters: runScene.parameters,
      render: (props) => <ConfirmCard {...props} prepare={runScene.prepare} execute={runScene.execute} confirmLabel="Run" />,
    },
    [tools],
  );

  useHomeContext(client, options.context ?? true);
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
