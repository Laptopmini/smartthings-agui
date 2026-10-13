import type { ComponentStatus } from "./client";

/** The attributes the typed tools and device cards understand.
 *
 *  A full component status is large (a color bulb's is ~40 attributes, most
 *  of them ranges and metadata), and every token of it is re-sent to the model
 *  on each later run. This keeps the values a person would ask about.
 */
export interface DeviceState {
  switch?: "on" | "off";
  level?: number;
  /** Hue and saturation in SmartThings' 0–100 scale. */
  hue?: number;
  saturation?: number;
  colorTemperature?: number;
  temperature?: Measurement;
  heatingSetpoint?: Measurement;
  coolingSetpoint?: Measurement;
  thermostatMode?: string;
  thermostatOperatingState?: string;
  thermostatFanMode?: string;
  lock?: string;
  door?: string;
  valve?: string;
  securitySystem?: string;
  contact?: "open" | "closed";
  motion?: "active" | "inactive";
  battery?: number;
  shadeLevel?: number;
  windowShade?: string;
}

export interface Measurement {
  value: number;
  unit?: string;
}

const ATTRIBUTES: [keyof DeviceState, capability: string, attribute: string][] = [
  ["switch", "switch", "switch"],
  ["level", "switchLevel", "level"],
  ["hue", "colorControl", "hue"],
  ["saturation", "colorControl", "saturation"],
  ["colorTemperature", "colorTemperature", "colorTemperature"],
  ["temperature", "temperatureMeasurement", "temperature"],
  ["heatingSetpoint", "thermostatHeatingSetpoint", "heatingSetpoint"],
  ["coolingSetpoint", "thermostatCoolingSetpoint", "coolingSetpoint"],
  ["thermostatMode", "thermostatMode", "thermostatMode"],
  ["thermostatOperatingState", "thermostatOperatingState", "thermostatOperatingState"],
  ["thermostatFanMode", "thermostatFanMode", "thermostatFanMode"],
  ["lock", "lock", "lock"],
  ["door", "doorControl", "door"],
  ["door", "garageDoorControl", "door"],
  ["valve", "valve", "valve"],
  ["securitySystem", "securitySystem", "securitySystemStatus"],
  ["contact", "contactSensor", "contact"],
  ["motion", "motionSensor", "motion"],
  ["battery", "battery", "battery"],
  ["shadeLevel", "windowShadeLevel", "shadeLevel"],
  ["windowShade", "windowShade", "windowShade"],
];

const MEASUREMENTS = new Set<keyof DeviceState>(["temperature", "heatingSetpoint", "coolingSetpoint"]);

/** Rounded to one decimal: virtual devices start with values like 4243.108812287815. */
const round = (n: number) => Math.round(n * 10) / 10;

export function summarizeStatus(status: ComponentStatus): DeviceState {
  const state: Record<string, unknown> = {};
  for (const [key, capability, attribute] of ATTRIBUTES) {
    const entry = status[capability]?.[attribute];
    if (entry === undefined || entry.value === null || entry.value === undefined) continue;
    const value = typeof entry.value === "number" ? round(entry.value) : entry.value;
    state[key] = MEASUREMENTS.has(key) && typeof value === "number" ? { value, unit: entry.unit } : value;
  }
  return state as DeviceState;
}
