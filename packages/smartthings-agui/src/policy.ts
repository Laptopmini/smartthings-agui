/** What the agent may do. Kept in one small module so it can be reviewed alone.
 *
 *  Three rules:
 *  1. Commands on the CONFIRM capabilities (locks, doors, security, valves)
 *     are denied unless the user opted in to that capability, and even then
 *     only run after the person confirms in the UI (`confirm_command`).
 *  2. A device that has any CONFIRM capability can't be commanded through any
 *     other tool: some valves and garage openers also expose `switch`, and
 *     `set_switch off` must not become an unconfirmed way to shut a valve.
 *  3. The generic `execute_command` only reaches the ALLOWED capabilities.
 *     Everything else (`execute`, `ocf`, firmware updates, ovens, vendor
 *     debug commands, ...) is out of reach.
 */

/** Hard-coded on purpose: the API's per-command `sensitive` flag is not a
 *  safety signal. `GET /capabilities/lock/1` returns `"sensitive": false` for
 *  `unlock` (checked 13 Oct 2026); the flag marks commands whose *arguments*
 *  carry secrets, not commands with physical consequences.
 *
 *  `doorControl` is here as well as `garageDoorControl` because garage door
 *  openers use it too (the VIRTUAL_GARAGE_DOOR_OPENER prototype does). The
 *  list may grow; it must never shrink. */
export const CONFIRM_COMMANDS = {
  lock: ["lock", "unlock"],
  garageDoorControl: ["open", "close"],
  doorControl: ["open", "close"],
  valve: ["open", "close"],
  securitySystem: ["armAway", "armStay", "disarm"],
} as const satisfies Record<string, readonly string[]>;

export type ConfirmCapability = keyof typeof CONFIRM_COMMANDS;

export const CONFIRM_CAPABILITIES: ReadonlySet<string> = new Set(Object.keys(CONFIRM_COMMANDS));

export function isConfirmCapability(capability: string): capability is ConfirmCapability {
  return CONFIRM_CAPABILITIES.has(capability);
}

/** Capabilities `execute_command` may send commands to. Lighting, climate,
 *  shades, fans and media: things whose worst case is an annoyance. */
export const GENERIC_ALLOWED_CAPABILITIES: ReadonlySet<string> = new Set([
  "switch",
  "switchLevel",
  "statelessSwitchLevelStep",
  "colorControl",
  "colorTemperature",
  "thermostatMode",
  "thermostatHeatingSetpoint",
  "thermostatCoolingSetpoint",
  "thermostatFanMode",
  "windowShade",
  "windowShadeLevel",
  "windowShadePreset",
  "fanSpeed",
  "audioVolume",
  "audioMute",
  "mediaPlayback",
  "mediaInputSource",
  "tvChannel",
  "refresh",
]);

export class PolicyError extends Error {}

/** Rule 2: throws if the device must only be commanded through confirmation. */
export function assertNoConfirmCapability(device: { label: string; capabilities: string[] }) {
  const guarded = device.capabilities.filter(isConfirmCapability);
  if (guarded.length) {
    throw new PolicyError(
      `${device.label} has ${guarded.join(", ")}, so it can only be controlled through confirm_command.`,
    );
  }
}

/** Rule 1, checked both when the tool is offered and again at confirmation time. */
export function assertConfirmable(
  capability: string,
  command: string,
  enabled: ReadonlySet<ConfirmCapability>,
): asserts capability is ConfirmCapability {
  if (!isConfirmCapability(capability)) {
    throw new PolicyError(`${capability} doesn't need confirmation; use the regular tools.`);
  }
  if (!enabled.has(capability)) {
    throw new PolicyError(
      `Commands for ${capability} are turned off. The user can allow them (with confirmation) in the app's settings.`,
    );
  }
  if (!(CONFIRM_COMMANDS[capability] as readonly string[]).includes(command)) {
    throw new PolicyError(`${capability} commands are: ${CONFIRM_COMMANDS[capability].join(", ")}.`);
  }
}

/** Rule 3. */
export function assertGenericAllowed(capability: string) {
  if (isConfirmCapability(capability)) {
    throw new PolicyError(`${capability} commands need the user's confirmation; use confirm_command.`);
  }
  if (!GENERIC_ALLOWED_CAPABILITIES.has(capability)) {
    throw new PolicyError(`Commands for ${capability} aren't available to the assistant.`);
  }
}
