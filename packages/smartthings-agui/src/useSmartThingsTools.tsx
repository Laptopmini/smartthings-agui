import { useAgentContext, useFrontendTools, useHumanInTheLoop } from "@copilotkit/react-core/v2";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Surface, type CardOutcome, type UserAction } from "./a2ui/Surface.js";
import { deviceSurface, sceneSurface } from "./a2ui/surfaces.js";
import { ConfirmCard, DeviceListCard, ErrorCard, PendingCard, parseResult } from "./cards.js";
import type { DeviceSummary, SceneSummary, SmartThingsClient } from "./client.js";
import { ConfirmSettings } from "./confirmSettings.js";
import { LiveDevices } from "./liveDevices.js";
import type { ConfirmCapability } from "./policy.js";
import { createTools, isConfirmDisabled, isToolError, type ConfirmArgs, type DeviceResult } from "./tools.js";
import { commandVerb } from "./a2ui/icons.js";

export interface SmartThingsToolsOptions {
  /** CONFIRM capabilities the user has turned on. Default: none, so locks,
   *  doors, valves and security systems can't be commanded at all. */
  confirmCapabilities?: readonly ConfirmCapability[];
  /** Send the device and scene list to the agent as context (default true). */
  context?: boolean;
  /** Opens the app's safety settings. When given, a request for a control
   *  that's turned off shows a button for it, and the card continues to the
   *  confirmation if the person turns the control on. */
  onOpenSettings?: () => void;
}

type Tools = ReturnType<typeof createTools>;
type RenderProps = { name: string; toolCallId: string; status: string; result?: string };

/** A card's control (toggle, slider, scene button) runs through the same tool
 *  handlers the agent uses, so policy.ts applies to clicks too. Resolves to a
 *  message for the card, if there's something to say. */
async function runCardAction(tools: Tools, action: UserAction): Promise<CardOutcome> {
  const ctx = action.context ?? {};
  const handler = (name: string) =>
    tools.frontend.find((t) => t.name === name)!.handler as (args: Record<string, unknown>) => Promise<unknown>;
  let result: unknown;
  switch (action.name) {
    case "press":
      if (ctx.action === "toggle") {
        result = await handler("set_switch")({ deviceId: ctx.deviceId, state: ctx.isOn ? "off" : "on" });
        break;
      }
      if (ctx.action === "confirm") {
        // Locks, doors, valves, security: the tap only *asks*. Same checks as
        // the chat's confirmation (prepare, then execute on the second press).
        const args = { deviceId: String(ctx.deviceId), capability: String(ctx.capability), command: String(ctx.command) };
        const prepared = await tools.confirmCommand.prepare(args);
        if (isToolError(prepared)) return prepared.error;
        if (isConfirmDisabled(prepared)) return { message: prepared.message, openSettings: true };
        return {
          confirm: {
            summary: prepared.summary,
            confirmLabel: commandVerb(args.command),
            run: async () => {
              const done = await tools.confirmCommand.execute(args);
              return isToolError(done) ? done.error : undefined;
            },
          },
        };
      }
      return undefined;
    case "setLevel":
      result = await handler("set_level")({ deviceId: ctx.deviceId, level: ctx.level });
      break;
    case "runScene":
      // The person pressed the scene's button: that click is the confirmation.
      result = await tools.runScene.execute({ sceneId: String(ctx.sceneId) });
      if (!isToolError(result)) return `Ran “${(result as { name?: string }).name ?? "the scene"}”.`;
      break;
    default:
      return `Unknown action ${action.name}.`;
  }
  return isToolError(result) ? result.error : undefined;
}

function DevicesSurface(props: {
  id: string;
  title: string;
  devices: DeviceResult[];
  tools: Tools;
  live: LiveDevices;
  onOpenSettings?: () => void;
}) {
  const { id, title, devices, tools, live, onOpenSettings } = props;
  // Start from the latest known state, not the tool's original result: chat
  // re-renders (and the virtualized message list on small screens) rebuild
  // cards from history, and a card built from the old result showed a stale
  // state until the live update landed (seen on a Pixel 7 emulation, 2 of 3 runs).
  const operations = useMemo(() => deviceSurface(id, title, live.current(devices)), [id, title, devices, live]);
  return (
    <Surface
      surfaceId={id}
      operations={operations}
      deviceIds={devices.map((d) => d.deviceId)}
      title={title}
      live={live}
      onAction={(a) => runCardAction(tools, a)}
      onOpenSettings={onOpenSettings}
    />
  );
}

/** One renderer for every frontend tool: the card follows the result's shape. */
function ToolCard({
  name,
  toolCallId,
  status,
  result,
  tools,
  live,
  onOpenSettings,
}: RenderProps & { tools: Tools; live: LiveDevices; onOpenSettings?: () => void }) {
  const parsed = useMemo(() => (status === "complete" ? parseResult<unknown>(result) : undefined), [status, result]);
  if (status !== "complete") return <PendingCard text={name === "list_devices" ? "Looking up devices…" : "Working…"} />;
  if (!parsed) return null;
  if (isToolError(parsed)) return <ErrorCard message={parsed.error} />;
  const id = `${name}-${toolCallId}`;
  if (Array.isArray(parsed)) {
    return name === "list_devices" ? <DeviceListCard devices={parsed as DeviceSummary[]} /> : null;
  }
  const value = parsed as Record<string, unknown>;
  if ("state" in value) return <DevicesSurface id={id} title="" devices={[value as unknown as DeviceResult]} tools={tools} live={live} onOpenSettings={onOpenSettings} />;
  if (Array.isArray(value.devices)) {
    return <DevicesSurface id={id} title={String(value.title ?? "")} devices={value.devices as DeviceResult[]} tools={tools} live={live} onOpenSettings={onOpenSettings} />;
  }
  if (Array.isArray(value.scenes)) {
    return (
      <Surface
        surfaceId={id}
        operations={sceneSurface(id, value.scenes as SceneSummary[])}
        live={live}
        onAction={(a) => runCardAction(tools, a)}
      />
    );
  }
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
  // One live store per client: every card on screen shares it.
  const live = useMemo(() => new LiveDevices(), [client]);
  // Settings read live by tools and cards (see confirmSettings.ts), updated
  // before paint so a request made right after a change already sees it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const settings = useMemo(() => new ConfirmSettings(options.confirmCapabilities ?? []), []);
  const settingsKey = [...(options.confirmCapabilities ?? [])].sort().join(",");
  useLayoutEffect(() => {
    settings.set(settingsKey ? (settingsKey.split(",") as ConfirmCapability[]) : []);
  }, [settings, settingsKey]);
  const tools = useMemo(
    () =>
      createTools(client, {
        confirmCapabilities: settings,
        onDeviceResult: (device) => live.set(device),
        shownDeviceIds: () => live.ids(),
      }),
    [client, settings, live],
  );

  useFrontendTools(
    tools.frontend.map((tool) => ({
      ...tool,
      render: (props: RenderProps) => <ToolCard {...props} tools={tools} live={live} onOpenSettings={options.onOpenSettings} />,
    })),
    [tools, options.onOpenSettings],
  );

  const { confirmCommand, runScene } = tools;
  useHumanInTheLoop<ConfirmArgs>(
    {
      name: confirmCommand.name,
      description: confirmCommand.description,
      parameters: confirmCommand.parameters,
      render: (props) => (
        <ConfirmCard
          {...props}
          prepare={confirmCommand.prepare}
          execute={confirmCommand.execute}
          confirmLabel={props.args.command ? capitalize(String(props.args.command)) : "Confirm"}
          onOpenSettings={options.onOpenSettings}
          settings={settings}
          renderDevice={(device) => (
            <DevicesSurface
              id={`confirm_command-${props.toolCallId}`}
              title=""
              devices={[device]}
              tools={tools}
              live={live}
              onOpenSettings={options.onOpenSettings}
            />
          )}
        />
      ),
    },
    [tools, options.onOpenSettings],
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
