/** Which icon a device card shows, how it's coloured, and what tapping it does.
 *
 *  Pure, so it's easy to test. The icon comes from SmartThings' device category
 *  first (every device on the test account had one) and from the device's
 *  state otherwise. The icons are Lucide's (ISC licence), never SmartThings'
 *  own artwork. Names here are mapped to components in iconComponents.tsx.
 */
import type { ConfirmCapability } from "../policy.js";
import type { DeviceResult } from "../tools.js";

export type IconName =
  | "lightbulb" | "lightbulb-off" | "power" | "plug" | "lock" | "lock-open" | "door-closed" | "door-open"
  | "garage" | "blinds" | "thermometer" | "air-vent" | "fan" | "heater" | "activity" | "radar" | "house"
  | "droplets" | "droplet" | "alarm-smoke" | "siren" | "camera" | "tv" | "speaker" | "cooking-pot"
  | "microwave" | "refrigerator" | "washing-machine" | "bot" | "server" | "router" | "button" | "shield"
  | "box";

/** on: highlighted (a light that's on). off: dimmed. alert: needs attention
 *  (unlocked, a door left open). neutral: plain. */
export type IconTone = "on" | "off" | "alert" | "neutral";

export interface DeviceIcon {
  icon: IconName;
  tone: IconTone;
  /** toggle: switch on/off. confirm: ask first, then send `command` to
   *  `capability`. none: the icon is only a picture. */
  action: "toggle" | "confirm" | "none";
  /** What the button does, for screen readers and tooltips: "Turn off Desk Lamp". */
  actionLabel: string;
  capability?: ConfirmCapability;
  command?: string;
}

/** SmartThings category names (lower-cased) → icon. Unknown ones fall back to state. */
const CATEGORY_ICONS: Record<string, IconName> = {
  light: "lightbulb",
  switch: "power",
  smartplug: "plug",
  smartlock: "lock",
  garagedoor: "garage",
  door: "door-closed",
  blind: "blinds",
  windowcovering: "blinds",
  shade: "blinds",
  thermostat: "thermometer",
  airconditioner: "air-vent",
  fan: "fan",
  heater: "heater",
  contactsensor: "door-closed",
  multifunctionalsensor: "activity",
  motionsensor: "radar",
  presencesensor: "house",
  waterleakdetector: "droplets",
  leaksensor: "droplets",
  smokedetector: "alarm-smoke",
  siren: "siren",
  camera: "camera",
  television: "tv",
  speaker: "speaker",
  networkaudio: "speaker",
  range: "cooking-pot",
  oven: "cooking-pot",
  microwave: "microwave",
  refrigerator: "refrigerator",
  washer: "washing-machine",
  dryer: "washing-machine",
  robotcleaner: "bot",
  hub: "server",
  wifirouter: "router",
  router: "router",
  button: "button",
  remotecontroller: "button",
  valve: "droplet",
  watervalve: "droplet",
  securitypanel: "shield",
};

function baseIcon(device: DeviceResult): IconName {
  const byCategory = device.category ? CATEGORY_ICONS[device.category.toLowerCase()] : undefined;
  if (byCategory) return byCategory;
  const s = device.state;
  if (s.lock) return "lock";
  if (s.door) return "door-closed";
  if (s.valve) return "droplet";
  if (s.securitySystem) return "shield";
  if (s.switch && s.level !== undefined) return "lightbulb";
  if (s.switch) return "power";
  if (s.windowShade || s.shadeLevel !== undefined) return "blinds";
  if (s.thermostatMode || s.heatingSetpoint || s.coolingSetpoint) return "thermometer";
  if (s.contact) return "door-closed";
  if (s.motion) return "radar";
  if (s.temperature) return "thermometer";
  return "box";
}

/** For results without `confirmCapability` (e.g. a card rebuilt from older chat
 *  history): infer it from the state. The confirmation's `prepare` still
 *  checks it against the device's real capabilities. */
function inferConfirmCapability(device: DeviceResult): ConfirmCapability | undefined {
  const s = device.state;
  if (s.lock) return "lock";
  if (s.valve) return "valve";
  if (s.securitySystem) return "securitySystem";
  if (s.door) return device.category?.toLowerCase() === "garagedoor" ? "garageDoorControl" : "doorControl";
  return undefined;
}

/** The command a tap on a confirm-only device asks about, from its state. */
function confirmCommand(capability: ConfirmCapability, device: DeviceResult): string {
  const s = device.state;
  switch (capability) {
    case "lock":
      return s.lock === "locked" ? "unlock" : "lock";
    case "doorControl":
    case "garageDoorControl":
      return s.door === "closed" ? "open" : "close";
    case "valve":
      return s.valve === "open" ? "close" : "open";
    case "securitySystem":
      return s.securitySystem && s.securitySystem.startsWith("armed") ? "disarm" : "armAway";
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const VERB: Record<string, string> = { armAway: "Arm", armStay: "Arm", disarm: "Disarm" };

/** "unlock" → "Unlock", "armAway" → "Arm": the word on a confirmation button. */
export function commandVerb(command: string): string {
  return VERB[command] ?? capitalize(command);
}

export function deviceIcon(device: DeviceResult): DeviceIcon {
  const s = device.state;
  let icon = baseIcon(device);
  let tone: IconTone = "neutral";

  if (s.switch) tone = s.switch === "on" ? "on" : "off";
  if (icon === "lightbulb" && s.switch === "off") icon = "lightbulb-off";
  if (s.lock) {
    icon = s.lock === "locked" ? "lock" : "lock-open";
    tone = s.lock === "locked" ? "neutral" : "alert";
  }
  if (s.door) {
    if (icon === "door-closed") icon = s.door === "closed" ? "door-closed" : "door-open";
    tone = s.door === "closed" ? "neutral" : "alert";
  } else if (s.contact && (icon === "door-closed" || icon === "activity")) {
    icon = s.contact === "closed" ? "door-closed" : "door-open";
    tone = s.contact === "open" ? "on" : "neutral";
  }
  if (s.valve) tone = s.valve === "open" ? "on" : "off";
  if (s.securitySystem) tone = s.securitySystem.startsWith("armed") ? "neutral" : "off";
  if (s.motion) tone = s.motion === "active" ? "on" : tone;

  // Confirm-only devices: a tap asks first, through the same policy as the chat.
  const guarded = device.confirmCapability ?? (device.needsConfirmation ? inferConfirmCapability(device) : undefined);
  if (guarded) {
    const command = confirmCommand(guarded, device);
    const verb = commandVerb(command);
    return {
      icon,
      tone,
      action: "confirm",
      actionLabel: `${verb} ${device.label}`,
      capability: guarded,
      command,
    };
  }
  if (s.switch) {
    return { icon, tone, action: "toggle", actionLabel: `Turn ${s.switch === "on" ? "off" : "on"} ${device.label}` };
  }
  return { icon, tone, action: "none", actionLabel: device.label };
}

