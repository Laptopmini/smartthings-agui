import colorControl from "./fixtures/capability-colorControl.json";
import lock from "./fixtures/capability-lock.json";
import switchCap from "./fixtures/capability-switch.json";
import switchLevel from "./fixtures/capability-switchLevel.json";
import thermostatHeatingSetpoint from "./fixtures/capability-thermostatHeatingSetpoint.json";
import windowShade from "./fixtures/capability-windowShade.json";

/** An in-memory api.smartthings.com for tests: the endpoints the client uses,
 *  two pages of devices, rooms, scenes, real capability definitions (fixtures)
 *  and commands that change state. Every call is recorded. */

type Status = Record<string, Record<string, { value: unknown; unit?: string }>>;

interface FakeDevice {
  deviceId: string;
  label: string;
  roomId: string;
  capabilities: string[];
  status: Status;
}

export const LOCATION = "loc-1";

export function makeDevices(): FakeDevice[] {
  return [
    {
      deviceId: "dimmer",
      label: "Desk Lamp",
      roomId: "r-office",
      capabilities: ["switch", "switchLevel", "refresh"],
      status: { switch: { switch: { value: "off" } }, switchLevel: { level: { value: 10, unit: "%" } } },
    },
    {
      deviceId: "bulb",
      label: "Color Bulb",
      roomId: "r-living",
      capabilities: ["switch", "colorControl", "switchLevel", "firmwareUpdate", "synthetic.lightingEffectFade"],
      status: {
        switch: { switch: { value: "on" } },
        colorControl: { hue: { value: 78.99416110180604 }, saturation: { value: 60.4 } },
        switchLevel: { level: { value: 65, unit: "%" } },
      },
    },
    {
      deviceId: "lock",
      label: "Front Door",
      roomId: "r-living",
      capabilities: ["lock", "battery", "refresh"],
      status: { lock: { lock: { value: "locked" } }, battery: { battery: { value: 100, unit: "%" } } },
    },
    {
      deviceId: "valve",
      label: "Water Valve",
      roomId: "r-office",
      // Some valves also expose switch: rule 2 must still block set_switch.
      capabilities: ["valve", "switch"],
      status: { valve: { valve: { value: "open" } }, switch: { switch: { value: "on" } } },
    },
    {
      deviceId: "thermostat",
      label: "Hall Thermostat",
      roomId: "r-living",
      capabilities: ["thermostatMode", "thermostatHeatingSetpoint", "temperatureMeasurement"],
      status: {
        thermostatMode: { thermostatMode: { value: "heat" } },
        thermostatHeatingSetpoint: { heatingSetpoint: { value: 4243.108812287815, unit: "C" } },
        temperatureMeasurement: { temperature: { value: 19.5, unit: "C" } },
      },
    },
    {
      deviceId: "shade",
      label: "Office Blind",
      roomId: "r-office",
      capabilities: ["windowShade", "execute", "ocf"],
      status: { windowShade: { windowShade: { value: "closed" } } },
    },
  ];
}

const DEFINITIONS: Record<string, unknown> = {
  switch: switchCap,
  switchLevel,
  colorControl,
  lock,
  thermostatHeatingSetpoint,
  windowShade,
};

/** command → [capability attribute, value from args] */
const EFFECTS: Record<string, (args: unknown[]) => [string, string, unknown][]> = {
  "switch.on": () => [["switch", "switch", "on"]],
  "switch.off": () => [["switch", "switch", "off"]],
  "switchLevel.setLevel": (a) => [["switchLevel", "level", a[0]]],
  "colorControl.setHue": (a) => [["colorControl", "hue", a[0]]],
  "colorControl.setSaturation": (a) => [["colorControl", "saturation", a[0]]],
  "colorControl.setColor": (a) => {
    const c = a[0] as { hue: number; saturation: number };
    return [
      ["colorControl", "hue", c.hue],
      ["colorControl", "saturation", c.saturation],
    ];
  },
  "lock.lock": () => [["lock", "lock", "locked"]],
  "lock.unlock": () => [["lock", "lock", "unlocked"]],
  "valve.close": () => [["valve", "valve", "closed"]],
  "thermostatMode.setThermostatMode": (a) => [["thermostatMode", "thermostatMode", a[0]]],
  "thermostatHeatingSetpoint.setHeatingSetpoint": (a) => [["thermostatHeatingSetpoint", "heatingSetpoint", a[0]]],
  "windowShade.open": () => [["windowShade", "windowShade", "open"]],
};

export function fakeSmartThings(devices = makeDevices()) {
  const calls: { method: string; path: string; body?: unknown; auth?: string }[] = [];
  const scenesRun: string[] = [];
  const byId = new Map(devices.map((d) => [d.deviceId, d]));

  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    calls.push({ method, path: path + url.search, body, auth });

    if (path === "/devices") {
      // Two pages, with an absolute `next` link that omits /v1, as the real API does.
      const page = url.searchParams.get("page") === "1" ? 1 : 0;
      const items = devices.slice(page * 3, page * 3 + 3).map((d) => ({
        deviceId: d.deviceId,
        label: d.label,
        roomId: d.roomId,
        locationId: LOCATION,
        components: [{ id: "main", capabilities: d.capabilities.map((id) => ({ id, version: 1 })) }],
      }));
      const next = page === 0 ? { href: "https://api.smartthings.com/devices?page=1&isNext=true" } : null;
      return Response.json({ items, _links: { next } });
    }
    if (path === `/locations/${LOCATION}/rooms`) {
      return Response.json({
        items: [
          { roomId: "r-office", name: "Office" },
          { roomId: "r-living", name: "Living Room" },
        ],
        _links: {},
      });
    }
    if (path === "/scenes") {
      return Response.json({ items: [{ sceneId: "s-night", sceneName: "Good night" }], _links: {} });
    }
    const scene = path.match(/^\/scenes\/([^/]+)\/execute$/);
    if (scene && method === "POST") {
      scenesRun.push(scene[1]);
      return Response.json({ status: "success" });
    }
    const capability = path.match(/^\/capabilities\/([^/]+)\/1$/);
    if (capability) {
      const definition = DEFINITIONS[capability[1]];
      return definition ? Response.json(definition) : new Response("not found", { status: 404 });
    }
    const status = path.match(/^\/devices\/([^/]+)\/components\/main\/status$/);
    if (status && byId.has(status[1])) return Response.json(byId.get(status[1])!.status);
    const commands = path.match(/^\/devices\/([^/]+)\/commands$/);
    if (commands && method === "POST" && byId.has(commands[1])) {
      const device = byId.get(commands[1])!;
      for (const c of body.commands as { capability: string; command: string; arguments?: unknown[] }[]) {
        const effect = EFFECTS[`${c.capability}.${c.command}`];
        if (!effect) return new Response("unsupported", { status: 422 });
        for (const [cap, attr, value] of effect(c.arguments ?? [])) {
          device.status[cap] = { ...device.status[cap], [attr]: { ...device.status[cap]?.[attr], value } };
        }
      }
      return Response.json({ results: body.commands.map(() => ({ id: "x", status: "ACCEPTED" })) });
    }
    return new Response("not found", { status: 404 });
  };

  const commandsSent = () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/commands"));
  return { impl, calls, commandsSent, scenesRun, byId };
}
