/** Device and scene data → A2UI v0.9 operations, for the catalog in this folder.
 *
 *  Pure functions: no React, no SmartThings calls. The component templates are
 *  fixed; only the data model changes, so a live update is one
 *  `updateDataModel` for one item.
 */
import type { SceneSummary } from "../client.js";
import type { DeviceState } from "../status.js";
import type { DeviceResult } from "../tools.js";

/** Every createSurface names it; must equal the id the catalog registers. */
export const CATALOG_ID = "urn:smartthings-agui:catalog:v1";
const VERSION = "v0.9";

export type Operation = Record<string, unknown>;

/** What a DeviceTile binds to. All derived here: templates can't compute. */
export interface TileModel {
  deviceId: string;
  label: string;
  room: string;
  stateText: string;
  color: string;
  isOn: boolean;
  level: number;
  canToggle: boolean;
  canDim: boolean;
  note: string;
}

const temp = (m?: { value: number; unit?: string }) => (m ? `${m.value}°${m.unit ?? ""}` : "");

/** A short, human-readable line: "On · 40%", "21.5°C · battery 80%". */
export function describeState(state: DeviceState): string {
  const parts = [
    state.switch === "on" ? "On" : state.switch === "off" ? "Off" : "",
    state.level !== undefined && state.switch !== "off" ? `${state.level}%` : "",
    temp(state.temperature),
    state.thermostatMode ? `mode ${state.thermostatMode}` : "",
    state.heatingSetpoint ? `heat to ${temp(state.heatingSetpoint)}` : "",
    state.coolingSetpoint ? `cool to ${temp(state.coolingSetpoint)}` : "",
    state.lock ?? "",
    state.door ? `door ${state.door}` : "",
    state.valve ? `valve ${state.valve}` : "",
    state.securitySystem ?? "",
    state.contact ?? "",
    state.motion ? (state.motion === "active" ? "motion" : "no motion") : "",
    state.windowShade ?? "",
    state.shadeLevel !== undefined ? `shade ${state.shadeLevel}%` : "",
    state.battery !== undefined ? `battery ${state.battery}%` : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

/** `hideRoom`: the card's title already names the room. */
export function tileModel(device: DeviceResult, hideRoom = false): TileModel {
  const { state } = device;
  // Rule 2 of policy.ts, mirrored in the UI: a device with a lock, door,
  // valve or security capability gets no controls on its tile. (A click would
  // be refused by the handler anyway; this avoids offering it.)
  const secure = device.needsConfirmation === true;
  return {
    deviceId: device.deviceId,
    label: device.label,
    room: hideRoom ? "" : (device.room ?? ""),
    stateText: describeState(state),
    color:
      state.hue !== undefined && state.saturation !== undefined
        ? `hsl(${Math.round(state.hue * 3.6)} ${Math.round(state.saturation)}% 50%)`
        : "",
    isOn: state.switch === "on",
    level: state.level ?? 0,
    canToggle: !secure && state.switch !== undefined,
    canDim: !secure && state.level !== undefined,
    note: secure ? "Controlled through the chat, with confirmation." : "",
  };
}

const DEVICE_COMPONENTS = [
  { id: "root", component: "TileGrid", title: { path: "/title" }, children: { path: "/items", componentId: "tile" } },
  {
    id: "tile",
    component: "DeviceTile",
    label: { path: "label" },
    room: { path: "room" },
    stateText: { path: "stateText" },
    color: { path: "color" },
    isOn: { path: "isOn" },
    level: { path: "level" },
    canToggle: { path: "canToggle" },
    canDim: { path: "canDim" },
    note: { path: "note" },
    toggle: { event: { name: "toggle", context: { deviceId: { path: "deviceId" }, isOn: { path: "isOn" } } } },
    changeLevel: { event: { name: "setLevel", context: { deviceId: { path: "deviceId" }, level: { path: "level" } } } },
  },
];

const SCENE_COMPONENTS = [
  { id: "root", component: "TileGrid", title: { path: "/title" }, children: { path: "/items", componentId: "scene" } },
  {
    id: "scene",
    component: "SceneButton",
    name: { path: "name" },
    run: { event: { name: "runScene", context: { sceneId: { path: "sceneId" } } } },
  },
];

function surface(surfaceId: string, components: unknown[], data: unknown): Operation[] {
  return [
    { version: VERSION, createSurface: { surfaceId, catalogId: CATALOG_ID } },
    { version: VERSION, updateComponents: { surfaceId, components } },
    { version: VERSION, updateDataModel: { surfaceId, path: "/", value: data } },
  ];
}

export function deviceSurface(surfaceId: string, title: string, devices: DeviceResult[]): Operation[] {
  return surface(surfaceId, DEVICE_COMPONENTS, { title, items: devices.map((d) => tileModel(d, d.room === title)) });
}

export function sceneSurface(surfaceId: string, scenes: SceneSummary[]): Operation[] {
  return surface(surfaceId, SCENE_COMPONENTS, { title: "Scenes", items: scenes });
}

/** Replace one tile's data (a live update). */
export function updateTile(surfaceId: string, index: number, device: DeviceResult, title = ""): Operation {
  return {
    version: VERSION,
    updateDataModel: { surfaceId, path: `/items/${index}`, value: tileModel(device, device.room === title) },
  };
}
