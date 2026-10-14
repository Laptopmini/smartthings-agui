import { describe, expect, it } from "vitest";
import { deviceIcon } from "../src/a2ui/icons";
import type { DeviceResult } from "../src/tools";

const d = (label: string, category: string | undefined, state: DeviceResult["state"], extra: Partial<DeviceResult> = {}) =>
  ({ deviceId: label, label, category, state, ...extra }) as DeviceResult;

describe("deviceIcon", () => {
  it("lights: a lit bulb when on, a crossed-out grey bulb when off, and the icon toggles", () => {
    expect(deviceIcon(d("Lamp", "Light", { switch: "on", level: 40 }))).toEqual({
      icon: "lightbulb",
      tone: "on",
      action: "toggle",
      actionLabel: "Turn off Lamp",
    });
    expect(deviceIcon(d("Lamp", "Light", { switch: "off" }))).toMatchObject({ icon: "lightbulb-off", tone: "off", actionLabel: "Turn on Lamp" });
  });

  it("plugs and switches use their own icons", () => {
    expect(deviceIcon(d("Tree", "SmartPlug", { switch: "on" })).icon).toBe("plug");
    expect(deviceIcon(d("Fan switch", "Switch", { switch: "off" })).icon).toBe("power");
  });

  it("locks: neutral when locked, alert when unlocked; a tap asks to unlock or lock", () => {
    const locked = deviceIcon(d("Front Door", "SmartLock", { lock: "locked" }, { confirmCapability: "lock" }));
    expect(locked).toMatchObject({ icon: "lock", tone: "neutral", action: "confirm", command: "unlock", actionLabel: "Unlock Front Door" });
    const open = deviceIcon(d("Front Door", "SmartLock", { lock: "unlocked" }, { confirmCapability: "lock" }));
    expect(open).toMatchObject({ icon: "lock-open", tone: "alert", command: "lock", actionLabel: "Lock Front Door" });
  });

  it("garage doors ask to open when closed", () => {
    expect(
      deviceIcon(d("Garage", "GarageDoor", { door: "closed", contact: "closed" }, { confirmCapability: "doorControl" })),
    ).toMatchObject({ icon: "garage", tone: "neutral", action: "confirm", capability: "doorControl", command: "open" });
  });

  it("security systems: Arm when disarmed, Disarm when armed", () => {
    const armed = d("Alarm", "SecurityPanel", { securitySystem: "armedAway" }, { confirmCapability: "securitySystem" });
    expect(deviceIcon(armed)).toMatchObject({ icon: "shield", command: "disarm", actionLabel: "Disarm Alarm" });
    const off = d("Alarm", "SecurityPanel", { securitySystem: "disarmed" }, { confirmCapability: "securitySystem" });
    expect(deviceIcon(off)).toMatchObject({ command: "armAway", actionLabel: "Arm Alarm" });
  });

  it("sensors show state and do nothing on tap", () => {
    expect(deviceIcon(d("Closet", "ContactSensor", { contact: "open" }))).toEqual({
      icon: "door-open",
      tone: "on",
      action: "none",
      actionLabel: "Closet",
    });
    expect(deviceIcon(d("Hall", "MotionSensor", { motion: "active" }))).toMatchObject({ icon: "radar", tone: "on", action: "none" });
    expect(deviceIcon(d("Thermostat", "Thermostat", { thermostatMode: "heat" }))).toMatchObject({ icon: "thermometer", action: "none" });
  });

  it("falls back to the state for unknown categories, then to a generic box", () => {
    expect(deviceIcon(d("Mystery", "SomethingNew", { switch: "on", level: 10 })).icon).toBe("lightbulb");
    expect(deviceIcon(d("Mystery", undefined, { lock: "locked" }, { needsConfirmation: true }))).toMatchObject({
      icon: "lock",
      action: "confirm",
      capability: "lock",
    });
    expect(deviceIcon(d("Box", undefined, {})).icon).toBe("box");
  });
});
