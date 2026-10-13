import { describe, expect, it } from "vitest";
import { SmartThingsClient } from "../src/client";
import type { ConfirmCapability } from "../src/policy";
import { createTools, hexToHueSaturation } from "../src/tools";
import { fakeSmartThings } from "./fakeSmartThings";

function setup(confirm: ConfirmCapability[] = []) {
  const st = fakeSmartThings();
  const client = new SmartThingsClient("tok", st.impl);
  const tools = createTools(client, { confirmCapabilities: new Set(confirm) });
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.frontend.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return (tool.handler as (a: unknown) => Promise<any>)(args);
  };
  return { st, tools, call };
}

describe("reading", () => {
  it("lists devices across pages with rooms, filtered capabilities and confirmation flags", async () => {
    const { call, st } = setup();
    const devices = await call("list_devices");
    expect(devices).toHaveLength(7);
    expect(devices.find((d: any) => d.deviceId === "bulb")).toEqual({
      deviceId: "bulb",
      label: "Color Bulb",
      room: "Living Room",
      // refresh/firmwareUpdate and namespaced capabilities are noise to a model.
      capabilities: ["switch", "colorControl", "switchLevel"],
    });
    expect(devices.find((d: any) => d.deviceId === "lock").needsConfirmation).toBe(true);
    expect(st.calls.every((c) => c.auth === "Bearer tok")).toBe(true);
  });

  it("caches the device list between commands", async () => {
    const { call, st } = setup();
    await call("set_switch", { deviceId: "dimmer", state: "on" });
    await call("set_switch", { deviceId: "dimmer", state: "off" });
    expect(st.calls.filter((c) => c.path.startsWith("/devices?") || c.path === "/devices")).toHaveLength(3); // 3 pages, once
  });

  it("summarises status and rounds noisy virtual-device values", async () => {
    const { call } = setup();
    const result = await call("get_device_status", { deviceId: "thermostat" });
    expect(result).toEqual({
      deviceId: "thermostat",
      label: "Hall Thermostat",
      room: "Living Room",
      state: {
        thermostatMode: "heat",
        heatingSetpoint: { value: 4243.1, unit: "C" },
        temperature: { value: 19.5, unit: "C" },
      },
    });
  });

  it("reports unknown devices in words the model can act on", async () => {
    const { call } = setup();
    expect(await call("get_device_status", { deviceId: "nope" })).toEqual({
      error: "No device with id nope. Call list_devices for valid ids.",
    });
  });
});

describe("typed commands", () => {
  it("switches, and returns the state read back afterwards", async () => {
    const { call, st } = setup();
    const result = await call("set_switch", { deviceId: "dimmer", state: "on" });
    expect(result.state.switch).toBe("on");
    expect(st.commandsSent()[0].body).toEqual({
      commands: [{ component: "main", capability: "switch", command: "on" }],
    });
  });

  it("coerces string numbers (the LlamaIndex router sends strings) and checks range", async () => {
    const { call } = setup();
    expect((await call("set_level", { deviceId: "dimmer", level: "42" })).state.level).toBe(42);
    expect(await call("set_level", { deviceId: "dimmer", level: "150" })).toEqual({ error: "level must be 0 to 100; got 150." });
  });

  it("converts hex colours to SmartThings hue/saturation", async () => {
    expect(hexToHueSaturation("#FF0000")).toEqual({ hue: 0, saturation: 100 });
    expect(hexToHueSaturation("00ff00")).toEqual({ hue: 33.3, saturation: 100 });
    const { call } = setup();
    const result = await call("set_color", { deviceId: "bulb", color: "#0000FF" });
    expect(result.state).toMatchObject({ hue: 66.7, saturation: 100 });
    expect(await call("set_color", { deviceId: "bulb", color: "blue" })).toHaveProperty("error");
  });

  it("sets thermostat mode and setpoint in one command batch", async () => {
    const { call, st } = setup();
    const result = await call("set_thermostat", { deviceId: "thermostat", mode: "heat", heatingSetpoint: "21" });
    expect(result.state.heatingSetpoint).toEqual({ value: 21, unit: "C" });
    expect(st.commandsSent()).toHaveLength(1);
    expect(await call("set_thermostat", { deviceId: "thermostat" })).toHaveProperty("error");
  });

  it("refuses a capability the device doesn't have", async () => {
    const { call } = setup();
    expect(await call("set_level", { deviceId: "shade", level: 5 })).toEqual({
      error: "Office Blind doesn't have the switchLevel capability.",
    });
  });
});

describe("policy", () => {
  it("never commands a device that has a confirm capability through a regular tool", async () => {
    const { call, st } = setup(["valve", "lock"]);
    expect(await call("set_switch", { deviceId: "valve", state: "off" })).toEqual({
      error: "Water Valve has valve, so it can only be controlled through confirm_command.",
    });
    expect(st.commandsSent()).toHaveLength(0);
  });

  it("keeps execute_command to the allowlist", async () => {
    const { call, st } = setup(["lock"]);
    expect((await call("execute_command", { deviceId: "lock", capability: "lock", command: "unlock" })).error).toMatch(
      /confirm_command/,
    );
    expect((await call("execute_command", { deviceId: "shade", capability: "execute", command: "execute" })).error).toBe(
      "Commands for execute aren't available to the assistant.",
    );
    expect(st.commandsSent()).toHaveLength(0);
  });

  it("validates execute_command arguments against the capability definition", async () => {
    const { call } = setup();
    expect((await call("execute_command", { deviceId: "shade", capability: "windowShade", command: "open" })).state).toEqual({
      windowShade: "open",
    });
    expect((await call("execute_command", { deviceId: "shade", capability: "windowShade", command: "fling" })).error).toBe(
      'windowShade has no command "fling". Commands: close, open, pause.',
    );
    expect(
      (await call("execute_command", { deviceId: "dimmer", capability: "switchLevel", command: "setLevel", arguments: "[101]" }))
        .error,
    ).toBe("level must be integer, 0 to 100; got 101.");
    expect(
      (await call("execute_command", { deviceId: "dimmer", capability: "switchLevel", command: "setLevel", arguments: '["30"]' }))
        .state.level,
    ).toBe(30);
  });

  it("validates against the capability version the device reports", async () => {
    const { call, st } = setup();
    const ok = await call("execute_command", { deviceId: "fan", capability: "fanSpeed", command: "setFanSpeed", arguments: "[3]" });
    expect(ok).not.toHaveProperty("error");
    expect(st.calls.some((c) => c.path === "/capabilities/fanSpeed/2")).toBe(true);
    expect(
      (await call("execute_command", { deviceId: "fan", capability: "fanSpeed", command: "setFanSpeed", arguments: "[9]" })).error,
    ).toBe("speed must be integer, 0 to 4; got 9.");
  });

  it("doesn't offer confirm_command until the user opts in", () => {
    expect(setup().tools.confirmCommand.available).toBe(false);
    const { tools } = setup(["lock"]);
    expect(tools.confirmCommand.available).toBe(true);
    expect(tools.confirmCommand.description).toMatch(/Allowed now: lock \(lock\|unlock\)\.$/);
  });

  it("refuses confirm_command for a capability that isn't turned on, even if called anyway", async () => {
    const { tools, st } = setup(["lock"]);
    expect(await tools.confirmCommand.prepare({ deviceId: "valve", capability: "valve", command: "close" })).toEqual({
      error: "Commands for valve are turned off. The user can allow them (with confirmation) in the app's settings.",
    });
    expect(await tools.confirmCommand.execute({ deviceId: "valve", capability: "valve", command: "close" })).toHaveProperty(
      "error",
    );
    expect(st.commandsSent()).toHaveLength(0);
  });

  it("prepares, then executes a confirmed command", async () => {
    const { tools, st } = setup(["lock"]);
    expect(await tools.confirmCommand.prepare({ deviceId: "lock", capability: "lock", command: "unlock" })).toMatchObject({
      summary: "unlock Front Door (Living Room)",
    });
    expect(st.commandsSent()).toHaveLength(0); // preparing changes nothing
    const result = await tools.confirmCommand.execute({ deviceId: "lock", capability: "lock", command: "unlock" });
    expect(result).toMatchObject({ state: { lock: "unlocked" }, confirmed: true });
  });

  it("rejects commands outside a confirm capability's list", async () => {
    const { tools } = setup(["lock"]);
    expect(await tools.confirmCommand.prepare({ deviceId: "lock", capability: "lock", command: "unlatch" })).toEqual({
      error: "lock commands are: lock, unlock.",
    });
  });

  it("runs scenes only through the confirmation flow", async () => {
    const { tools, st } = setup();
    expect(tools.frontend.map((t) => t.name)).not.toContain("run_scene");
    expect(await tools.runScene.prepare({ sceneId: "s-night" })).toEqual({ summary: "Run the scene “Good night”" });
    expect(await tools.runScene.execute({ sceneId: "s-night" })).toEqual({ sceneId: "s-night", status: "success", confirmed: true });
    expect(st.scenesRun).toEqual(["s-night"]);
  });
});

describe("show_devices / show_scenes", () => {
  it("shows a room, case-insensitively, with each device's state", async () => {
    const { call } = setup();
    const result = await call("show_devices", { room: "office" });
    expect(result.title).toBe("Office");
    expect(result.devices.map((d: any) => d.deviceId)).toEqual(["dimmer", "valve", "shade"]);
    expect(result.devices.find((d: any) => d.deviceId === "valve").needsConfirmation).toBe(true);
  });

  it("accepts device ids as a comma-separated or JSON string (the LlamaIndex router sends strings)", async () => {
    const { call } = setup();
    expect((await call("show_devices", { deviceIds: "bulb, dimmer" })).devices.map((d: any) => d.deviceId)).toEqual([
      "bulb",
      "dimmer",
    ]);
    expect((await call("show_devices", { deviceIds: '["lock"]' })).devices[0].label).toBe("Front Door");
  });

  it("names the real rooms when asked for one that doesn't exist", async () => {
    const { call } = setup();
    expect((await call("show_devices", { room: "Garage" })).error).toBe('No room called "Garage". Rooms: Office, Living Room.');
  });

  it("lists scenes for the scene buttons", async () => {
    const { call } = setup();
    expect(await call("show_scenes")).toEqual({ scenes: [{ sceneId: "s-night", name: "Good night" }] });
  });

  it("reports every device state it reads, for the live cards", async () => {
    const st = fakeSmartThings();
    const seen: string[] = [];
    const tools = createTools(new SmartThingsClient("tok", st.impl), {
      confirmCapabilities: new Set(),
      onDeviceResult: (d) => seen.push(`${d.deviceId}:${d.state.switch}`),
    });
    const setSwitch = tools.frontend.find((t) => t.name === "set_switch")!.handler as (a: unknown) => Promise<unknown>;
    await setSwitch({ deviceId: "dimmer", state: "on" });
    expect(seen).toEqual(["dimmer:on"]);
  });
});
