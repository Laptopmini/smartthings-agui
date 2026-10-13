import { jsonSchemaParameters, validateArguments } from "./capabilityTools";
import { type Command, type DeviceSummary, type SmartThingsClient } from "./client";
import {
  CONFIRM_COMMANDS,
  CONFIRM_LABELS,
  PolicyError,
  assertConfirmCommand,
  assertConfirmable,
  assertGenericAllowed,
  assertNoConfirmCapability,
  type ConfirmCapability,
} from "./policy";
import { summarizeStatus, type DeviceState } from "./status";

/** What every device-changing or device-reading tool returns: the state read
 *  back from SmartThings after the command, so the card and the model see what
 *  the platform reports rather than an echo of the request. */
export interface DeviceResult {
  deviceId: string;
  label: string;
  room?: string;
  state: DeviceState;
  /** The device has a lock, door, valve or security capability (policy.ts rule 2). */
  needsConfirmation?: boolean;
  /** Set when the device hadn't reported the commanded state yet. */
  pending?: string;
}

export interface ToolError {
  error: string;
}

export type ToolResult<T> = T | ToolError;

/** Anything that answers "is this capability turned on?": a Set, or the live
 *  ConfirmSettings the hook passes. */
export interface CapabilitySet {
  has(capability: ConfirmCapability): boolean;
}

export interface ToolOptions {
  /** CONFIRM capabilities the user has opted in to. Empty (the default) means
   *  locks, doors, valves and security systems can't be commanded at all. */
  confirmCapabilities: CapabilitySet;
  /** Called with every device state a tool reads back, so cards already on
   *  screen can update (see useLiveDevices). */
  onDeviceResult?: (result: DeviceResult) => void;
  /** Devices shown in cards right now. After a scene runs they're read again
   *  (the API doesn't say which devices a scene touches), so the cards update. */
  shownDeviceIds?: () => string[];
  /** Wait before that read, for the scene to finish (ms; tests pass 0). */
  sceneSettleMs?: number;
  /** Gaps between status re-reads while waiting for a device to report a
   *  commanded state (ms). Default below; tests pass zeros. */
  settleSchedule?: number[];
}

/** Capabilities that say nothing useful to a model choosing a tool. */
const NOISE = new Set(["refresh", "healthCheck", "firmwareUpdate", "execute", "ocf", "bridge"]);

/** Gaps between re-reads after a command (ms): reads at about 0, 0.8, 1.8
 *  and 3.3 s, which covers the ~2 s a real lamp took to report. */
const SETTLE_SCHEDULE_MS = [800, 1000, 1500];

/** Most cards in one show_devices call (one status read each). */
const MAX_CARDS = 12;

/** A list of ids as an array, a JSON array string or a comma-separated string. */
function toIdList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" && value.trim().startsWith("[") ? toArray(value) : String(value ?? "").split(",");
  return items.map((v) => String(v).trim()).filter(Boolean);
}

/** Every argument arrives as a string from the LlamaIndex router
 *  (see describeSchema) and may arrive typed from other agents. */
function toNumber(name: string, value: unknown): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || Number.isNaN(n)) throw new PolicyError(`${name} must be a number; got ${JSON.stringify(value)}.`);
  return n;
}

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [value];
    }
  }
  return [value];
}

/** Hex colour → SmartThings hue/saturation (both 0–100). set_color sends them
 *  as `setHue` + `setSaturation` rather than `setColor`: the VIRTUAL_COLOR_BULB
 *  prototype accepts `setColor` (200) but ignores it in both the `{hue,
 *  saturation}` and `{hex}` forms, while `setHue`/`setSaturation` take effect
 *  (checked 13 Oct 2026). Both are standard colorControl commands. */
export function hexToHueSaturation(hex: string): { hue: number; saturation: number } {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) throw new PolicyError(`color must be a hex colour like #FF8800; got ${JSON.stringify(hex)}.`);
  const n = parseInt(match[1], 16);
  const [r, g, b] = [(n >> 16) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
  }
  const hue = ((h * 60 + 360) % 360) / 3.6;
  return { hue: Math.round(hue * 10) / 10, saturation: Math.round((max ? delta / max : 0) * 1000) / 10 };
}

export function createTools(client: SmartThingsClient, options: ToolOptions) {
  /** Run `fn`, turning a thrown error (policy refusal, SmartThings 4xx, bad
   *  arguments) into a result the model can read and recover from. */
  async function attempt<R>(fn: () => Promise<R>): Promise<ToolResult<R>> {
    try {
      return await fn();
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  const safely =
    <A, R>(fn: (args: A) => Promise<R>) =>
    (args: A) =>
      attempt(() => fn(args));

  async function deviceResult(device: DeviceSummary): Promise<DeviceResult> {
    const result: DeviceResult = {
      deviceId: device.deviceId,
      label: device.label,
      room: device.room,
      state: summarizeStatus(await client.getStatus(device.deviceId)),
      ...(device.capabilities.some((c) => c in CONFIRM_COMMANDS) ? { needsConfirmation: true } : {}),
    };
    options.onDeviceResult?.(result);
    return result;
  }

  /** Common path for every non-confirm command: rule 2, capability present. */
  /** Read the device back after a command, re-reading a few times until it
   *  reports the expected state. Real devices report late: a Zigbee lamp took
   *  1.7–2.4 s (13 Oct 2026), so an immediate read returned the old state and
   *  the model, seeing "still off", retried, drawing a card each time. Virtual
   *  devices report at once, so the first read usually settles it. At most 4
   *  reads per command: SmartThings allows about 10 status reads per device
   *  per window (`x-ratelimit-limit: 10`). */
  async function readBack(device: DeviceSummary, expect?: (state: DeviceState) => boolean): Promise<DeviceResult> {
    let result = await deviceResult(device);
    if (!expect) return result;
    for (const gap of options.settleSchedule ?? SETTLE_SCHEDULE_MS) {
      if (expect(result.state)) return result;
      await new Promise((r) => setTimeout(r, gap));
      result = await deviceResult(device);
    }
    return expect(result.state)
      ? result
      : { ...result, pending: "The device accepted the command but hasn't reported the new state yet; it may still be changing. Don't send the command again." };
  }

  async function commandDevice(
    deviceId: string,
    commands: Command[],
    expect?: (state: DeviceState) => boolean,
  ): Promise<DeviceResult> {
    const device = await client.getDevice(String(deviceId));
    assertNoConfirmCapability(device);
    for (const c of commands) {
      if (!device.capabilities.includes(c.capability)) {
        throw new PolicyError(`${device.label} doesn't have the ${c.capability} capability.`);
      }
    }
    await client.executeCommands(device.deviceId, commands);
    return readBack(device, expect);
  }

  const deviceId = { type: "string", description: "Device id from list_devices" };

  const frontend = [
    {
      name: "list_devices",
      description:
        "List the user's SmartThings devices: id, label, room and capabilities. " +
        "needsConfirmation marks devices that can only be controlled with confirm_command.",
      parameters: jsonSchemaParameters<Record<string, never>>({ type: "object", properties: {} }),
      handler: safely(async () =>
        (await client.listDevices(true)).map((d) => ({
          deviceId: d.deviceId,
          label: d.label,
          room: d.room,
          capabilities: d.capabilities.filter((c) => !NOISE.has(c) && !c.includes(".")),
          ...(d.capabilities.some((c) => c in CONFIRM_COMMANDS) ? { needsConfirmation: true } : {}),
        })),
      ),
    },
    {
      name: "get_device_status",
      description: "Read a device's current state (switch, level, colour, temperature, lock, contact, battery...).",
      parameters: jsonSchemaParameters<{ deviceId: string }>({
        type: "object",
        properties: { deviceId },
        required: ["deviceId"],
      }),
      handler: safely(async ({ deviceId }: { deviceId: string }) => deviceResult(await client.getDevice(String(deviceId)))),
    },
    {
      name: "set_switch",
      description: "Turn a device with the switch capability on or off.",
      parameters: jsonSchemaParameters<{ deviceId: string; state: "on" | "off" }>({
        type: "object",
        properties: {
          deviceId,
          // Allowed values repeated in prose: the enum doesn't survive the
          // LlamaIndex router (see describeSchema).
          state: { type: "string", enum: ["on", "off"], description: "state (one of: on, off)" },
        },
        required: ["deviceId", "state"],
      }),
      handler: safely(async ({ deviceId, state }: { deviceId: string; state: string }) => {
        if (state !== "on" && state !== "off") throw new PolicyError(`state must be "on" or "off"; got ${JSON.stringify(state)}.`);
        return commandDevice(deviceId, [{ capability: "switch", command: state }], (s) => s.switch === state);
      }),
    },
    {
      name: "set_level",
      description: "Set a dimmer's brightness (switchLevel capability), 0 to 100 percent.",
      parameters: jsonSchemaParameters<{ deviceId: string; level: number }>({
        type: "object",
        properties: {
          deviceId,
          level: { type: "integer", minimum: 0, maximum: 100, description: "level (integer, 0 to 100)" },
        },
        required: ["deviceId", "level"],
      }),
      handler: safely(async ({ deviceId, level }: { deviceId: string; level: unknown }) => {
        const n = Math.round(toNumber("level", level));
        if (n < 0 || n > 100) throw new PolicyError(`level must be 0 to 100; got ${n}.`);
        // Within 1: some dimmers round to their own steps.
        return commandDevice(deviceId, [{ capability: "switchLevel", command: "setLevel", arguments: [n] }], (s) =>
          s.level !== undefined ? Math.abs(s.level - n) <= 1 : false,
        );
      }),
    },
    {
      name: "set_color",
      description: "Set a colour bulb's colour (colorControl capability) from a hex colour such as #FF0000 for red.",
      parameters: jsonSchemaParameters<{ deviceId: string; color: string }>({
        type: "object",
        properties: {
          deviceId,
          color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$", description: "color (hex string, e.g. #FF8800)" },
        },
        required: ["deviceId", "color"],
      }),
      handler: safely(async ({ deviceId, color }: { deviceId: string; color: string }) => {
        const { hue, saturation } = hexToHueSaturation(String(color));
        return commandDevice(
          deviceId,
          [
            { capability: "colorControl", command: "setHue", arguments: [hue] },
            { capability: "colorControl", command: "setSaturation", arguments: [saturation] },
          ],
          (s) => s.hue !== undefined && Math.abs(s.hue - hue) <= 1,
        );
      }),
    },
    {
      name: "set_thermostat",
      description:
        "Change a thermostat: its mode and/or heating and cooling setpoints. Setpoints are in the device's " +
        "temperature unit (get_device_status shows it). Give at least one of mode, heatingSetpoint, coolingSetpoint.",
      parameters: jsonSchemaParameters<{ deviceId: string; mode?: string; heatingSetpoint?: number; coolingSetpoint?: number }>({
        type: "object",
        properties: {
          deviceId,
          mode: { type: "string", description: "mode (e.g. heat, cool, auto, off)" },
          heatingSetpoint: { type: "number", description: "heatingSetpoint (number)" },
          coolingSetpoint: { type: "number", description: "coolingSetpoint (number)" },
        },
        required: ["deviceId"],
      }),
      handler: safely(
        async (args: { deviceId: string; mode?: string; heatingSetpoint?: unknown; coolingSetpoint?: unknown }) => {
          const commands: Command[] = [];
          if (args.mode) commands.push({ capability: "thermostatMode", command: "setThermostatMode", arguments: [String(args.mode)] });
          if (args.heatingSetpoint !== undefined && args.heatingSetpoint !== null && args.heatingSetpoint !== "") {
            commands.push({
              capability: "thermostatHeatingSetpoint",
              command: "setHeatingSetpoint",
              arguments: [toNumber("heatingSetpoint", args.heatingSetpoint)],
            });
          }
          if (args.coolingSetpoint !== undefined && args.coolingSetpoint !== null && args.coolingSetpoint !== "") {
            commands.push({
              capability: "thermostatCoolingSetpoint",
              command: "setCoolingSetpoint",
              arguments: [toNumber("coolingSetpoint", args.coolingSetpoint)],
            });
          }
          if (!commands.length) throw new PolicyError("Give at least one of mode, heatingSetpoint, coolingSetpoint.");
          const mode = args.mode ? String(args.mode) : undefined;
          const heat = commands.find((c) => c.command === "setHeatingSetpoint")?.arguments?.[0] as number | undefined;
          const cool = commands.find((c) => c.command === "setCoolingSetpoint")?.arguments?.[0] as number | undefined;
          return commandDevice(args.deviceId, commands, (s) =>
            (mode === undefined || s.thermostatMode === mode) &&
            (heat === undefined || s.heatingSetpoint?.value === heat) &&
            (cool === undefined || s.coolingSetpoint?.value === cool),
          );
        },
      ),
    },
    {
      name: "execute_command",
      description:
        "Send any other SmartThings command, for capabilities the typed tools don't cover (e.g. windowShade open, " +
        "fanSpeed setFanSpeed). Only lighting, climate, shade, fan and media capabilities are allowed.",
      parameters: jsonSchemaParameters<{ deviceId: string; capability: string; command: string; arguments?: string }>({
        type: "object",
        properties: {
          deviceId,
          capability: { type: "string", description: "capability id, e.g. windowShade" },
          command: { type: "string", description: "command name, e.g. open" },
          arguments: { type: "string", description: "arguments (JSON array, e.g. [50]; omit if none)" },
        },
        required: ["deviceId", "capability", "command"],
      }),
      handler: safely(
        async (args: { deviceId: string; capability: string; command: string; arguments?: unknown }) => {
          const capability = String(args.capability);
          assertGenericAllowed(capability);
          const device = await client.getDevice(String(args.deviceId));
          // The definition for the version this device reports (all 280 on the
          // test account were version 1, but the API allows others).
          const definition = await client.getCapability(capability, device.versions?.[capability] ?? 1);
          const commandArgs = validateArguments(definition, String(args.command), toArray(args.arguments));
          return commandDevice(args.deviceId, [{ capability, command: String(args.command), arguments: commandArgs }]);
        },
      ),
    },
    {
      name: "show_devices",
      description:
        "Show device cards in the chat, with live state and on/off and dimmer controls the user can use directly. " +
        "Give a room name to show that room, or deviceIds for specific devices. Returns each device's state.",
      parameters: jsonSchemaParameters<{ room?: string; deviceIds?: string }>({
        type: "object",
        properties: {
          room: { type: "string", description: "room (a room name from the home context)" },
          deviceIds: { type: "string", description: "deviceIds (comma-separated device ids)" },
        },
      }),
      handler: safely(async (args: { room?: string; deviceIds?: unknown }) => {
        const devices = await client.listDevices();
        const ids = toIdList(args.deviceIds);
        const room = args.room ? String(args.room).trim().toLowerCase() : "";
        let chosen: DeviceSummary[];
        if (ids.length) {
          chosen = ids.map((id) => devices.find((d) => d.deviceId === id)).filter((d): d is DeviceSummary => !!d);
        } else if (room) {
          chosen = devices.filter((d) => d.room?.toLowerCase() === room);
          if (!chosen.length) {
            const rooms = [...new Set(devices.map((d) => d.room).filter(Boolean))].join(", ");
            throw new PolicyError(`No room called "${args.room}". Rooms: ${rooms}.`);
          }
        } else {
          throw new PolicyError("Give a room or deviceIds.");
        }
        if (!chosen.length) throw new PolicyError("None of those device ids exist. Call list_devices for valid ids.");
        // Status reads cost one request each and SmartThings rate-limits per
        // token, so a card set is capped.
        const shown = chosen.filter((d) => !d.capabilities.includes("bridge")).slice(0, MAX_CARDS);
        const results = await Promise.all(shown.map(deviceResult));
        return {
          title: ids.length ? "Devices" : (shown[0]?.room ?? "Devices"),
          devices: results,
          ...(chosen.length > shown.length ? { omitted: chosen.length - shown.length } : {}),
        };
      }),
    },
    {
      name: "show_scenes",
      description: "Show the user's scenes in the chat as buttons they can press to run a scene themselves.",
      parameters: jsonSchemaParameters<Record<string, never>>({ type: "object", properties: {} }),
      handler: safely(async () => ({ scenes: await client.listScenes() })),
    },
  ];

  const allConfirm = Object.keys(CONFIRM_COMMANDS) as ConfirmCapability[];

  /** Human-in-the-loop: the UI calls `execute` only after the person confirms.
   *
   *  Always offered, whatever the settings: the *app* decides. When the
   *  capability is turned off, the card says so and points at Safety
   *  settings; nothing can run until it's on and the person presses the
   *  button. (Earlier the tool was hidden while off, and the model explained
   *  that itself, naming the internal tool, then kept refusing from memory
   *  after the user turned Locks on.) */
  const confirmCommand = {
    name: "confirm_command",
    description:
      "Lock/unlock, open/close a door, valve or garage, or arm/disarm security. Always use this for those devices: the " +
      "app checks the user's safety settings and asks them with a button in this chat. A result with confirmed: true " +
      "means it has already run; disabled: true means that control is turned off and the user has been told how to " +
      `turn it on. Commands: ${allConfirm.map((c) => `${c} (${CONFIRM_COMMANDS[c].join("|")})`).join("; ")}.`,
    parameters: jsonSchemaParameters<ConfirmArgs>({
      type: "object",
      properties: {
        deviceId,
        capability: { type: "string", enum: allConfirm, description: `capability (one of: ${allConfirm.join(", ")})` },
        command: { type: "string", description: "command (see the list in the description)" },
      },
      required: ["deviceId", "capability", "command"],
    }),
    /** Validates before showing the card; returns what the card should say,
     *  or that this control is turned off. */
    async prepare(
      args: Partial<ConfirmArgs>,
    ): Promise<ToolResult<{ device: DeviceSummary; summary: string } | ConfirmDisabled>> {
      return attempt(async () => {
        const device = await client.getDevice(String(args.deviceId));
        const capability = String(args.capability);
        assertConfirmCommand(capability, String(args.command));
        if (!device.capabilities.includes(capability)) {
          throw new PolicyError(`${device.label} doesn't have the ${capability} capability.`);
        }
        if (!options.confirmCapabilities.has(capability)) {
          return {
            disabled: true as const,
            capability,
            label: CONFIRM_LABELS[capability],
            message: `${CONFIRM_LABELS[capability]} are turned off in Safety settings, so ${device.label} can't be controlled from here.`,
          };
        }
        return { device, summary: `${args.command} ${device.label}${device.room ? ` (${device.room})` : ""}` };
      });
    },
    /** Runs the command. Policy is checked again here, at the moment of
     *  confirmation, in case settings changed while the card was open. */
    async execute(args: ConfirmArgs): Promise<ToolResult<DeviceResult & { confirmed: true }>> {
      return attempt(async () => {
        assertConfirmable(args.capability, args.command, options.confirmCapabilities);
        const device = await client.getDevice(args.deviceId);
        if (!device.capabilities.includes(args.capability)) {
          throw new PolicyError(`${device.label} doesn't have the ${args.capability} capability.`);
        }
        await client.executeCommands(device.deviceId, [{ capability: args.capability, command: args.command }]);
        const target = CONFIRM_TARGET[args.command];
        const result = await readBack(device, target ? (s) => [s.lock, s.door, s.valve].includes(target) : undefined);
        // Tell the model plainly: the person pressed the button and it ran.
        return { ...result, confirmed: true };
      });
    },
  };

  /** Scenes always ask: the public API doesn't reliably say what a scene does
   *  (`GET /scenes/{id}` returned `"devices": []` for a lighting scene, 13 Oct
   *  2026), and a scene may unlock a door. */
  const runScene = {
    name: "run_scene",
    description:
      "Run one of the user's SmartThings scenes. The user sees a button in this chat and the scene runs only if they " +
      "press it; a result with confirmed: true means it has already run.",
    parameters: jsonSchemaParameters<{ sceneId: string }>({
      type: "object",
      properties: { sceneId: { type: "string", description: "Scene id from the home context or show_scenes" } },
      required: ["sceneId"],
    }),
    async prepare(args: Partial<{ sceneId: string }>): Promise<ToolResult<{ summary: string }>> {
      return attempt(async () => {
        const scene = (await client.listScenes()).find((s) => s.sceneId === args.sceneId);
        if (!scene) throw new PolicyError(`No scene with id ${args.sceneId}. Use a scene id from the home context.`);
        return { summary: `Run the scene “${scene.name}”` };
      });
    },
    async execute({ sceneId }: { sceneId: string }): Promise<ToolResult<{ sceneId: string; name?: string; status: string; confirmed: true }>> {
      return attempt(async () => {
        const name = (await client.listScenes()).find((s) => s.sceneId === sceneId)?.name;
        const { status } = await client.executeScene(sceneId);
        const shown = options.shownDeviceIds?.() ?? [];
        if (shown.length) {
          // One read per shown device, once: no polling. SmartThings runs a
          // scene asynchronously; the virtual test devices had settled within 2 s.
          await new Promise((r) => setTimeout(r, options.sceneSettleMs ?? 1500));
          await Promise.allSettled(shown.map(async (id) => deviceResult(await client.getDevice(id))));
        }
        return { sceneId, ...(name ? { name } : {}), status, confirmed: true as const };
      });
    },
  };

  return { frontend, confirmCommand, runScene };
}

/** What a confirmed command should end in, to wait for (see readBack). */
const CONFIRM_TARGET: Record<string, string> = { lock: "locked", unlock: "unlocked", open: "open", close: "closed" };

export interface ConfirmDisabled {
  disabled: true;
  capability: ConfirmCapability;
  label: string;
  message: string;
}

export function isConfirmDisabled(value: unknown): value is ConfirmDisabled {
  return typeof value === "object" && value !== null && (value as { disabled?: unknown }).disabled === true;
}

export interface ConfirmArgs {
  deviceId: string;
  capability: string;
  command: string;
  [key: string]: unknown;
}

export function isToolError(result: unknown): result is ToolError {
  return typeof result === "object" && result !== null && "error" in result;
}
