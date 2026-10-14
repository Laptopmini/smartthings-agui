import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Surface, type CardOutcome, type UserAction } from "../src/a2ui/Surface";
import { describeState, deviceSurface, sceneSurface, tileModel } from "../src/a2ui/surfaces";
import { LiveDevices } from "../src/liveDevices";
import type { DeviceResult } from "../src/tools";

afterEach(cleanup);

const lamp: DeviceResult = { deviceId: "lamp", label: "Desk Lamp", room: "Office", state: { switch: "off", level: 40 } };
const bulb: DeviceResult = {
  deviceId: "bulb",
  label: "Color Bulb",
  room: "Office",
  state: { switch: "on", level: 20, hue: 0, saturation: 100 },
};
const lock: DeviceResult = {
  deviceId: "lock",
  label: "Front Door",
  room: "Hall",
  state: { lock: "locked", battery: 90 },
  needsConfirmation: true,
};
const valve: DeviceResult = {
  deviceId: "valve",
  label: "Water Valve",
  state: { valve: "open", switch: "on" },
  needsConfirmation: true,
};

describe("tile models", () => {
  it("summarises state in one line", () => {
    expect(describeState(bulb.state)).toBe("On · 20%");
    expect(describeState(lamp.state)).toBe("Off");
    expect(describeState({ temperature: { value: 21.5, unit: "C" }, battery: 80 })).toBe("21.5°C · battery 80%");
  });

  it("offers controls only where the policy allows them", () => {
    expect(tileModel(lamp)).toMatchObject({ action: "toggle", canDim: true, isOn: false, level: 40, color: "" });
    expect(tileModel(bulb).color).toBe("hsl(0 100% 50%)");
    // A room card doesn't repeat its room on every tile.
    expect(tileModel(lamp, true).room).toBe("");
    expect(tileModel(lamp).room).toBe("Office");
    // Confirm-only devices: the icon asks first; no dimmer.
    expect(tileModel(lock)).toMatchObject({ action: "confirm", capability: "lock", command: "unlock", canDim: false });
    // A valve that also exposes switch still never toggles (policy.ts rule 2).
    expect(tileModel(valve)).toMatchObject({ action: "confirm", capability: "valve", command: "close" });
  });
});

function mount(devices: DeviceResult[], onAction = vi.fn(async (_a: UserAction) => undefined as string | undefined)) {
  const live = new LiveDevices();
  render(
    <Surface
      surfaceId="s1"
      operations={deviceSurface("s1", "Office", devices)}
      deviceIds={devices.map((d) => d.deviceId)}
      live={live}
      onAction={onAction}
    />,
  );
  return { live, onAction };
}

describe("device surface", () => {
  it("renders one tile per device from the template", async () => {
    mount([lamp, bulb, lock]);
    const tiles = await screen.findAllByTestId("device-tile");
    expect(tiles.map((t) => t.dataset.label)).toEqual(["Desk Lamp", "Color Bulb", "Front Door"]);
    expect(screen.getByTestId("tile-grid").firstElementChild?.textContent).toBe("Office"); // title
    expect(tiles[2].textContent).toContain("locked · battery 90%");
    // The lock's icon asks first; there's no direct on/off button anywhere.
    expect(tiles[2].querySelector("button")?.getAttribute("aria-label")).toBe("Unlock Front Door");
    expect(screen.queryByRole("button", { name: /^Turn (on|off)$/ })).toBeNull();
  });

  it("dispatches toggle with the tile's device id and current state", async () => {
    const { onAction } = mount([lamp]);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on Desk Lamp" }));
    await waitFor(() => expect(onAction).toHaveBeenCalled());
    expect(onAction.mock.calls[0][0]).toMatchObject({
      name: "press",
      context: { deviceId: "lamp", action: "toggle", isOn: false },
    });
  });

  it("sends the slider's new level, once, on release", async () => {
    const { onAction } = mount([lamp]);
    const slider = await screen.findByRole("slider", { name: "Desk Lamp level" });
    fireEvent.change(slider, { target: { value: "75" } });
    fireEvent.pointerUp(slider);
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
    expect(onAction.mock.calls[0][0]).toMatchObject({ name: "setLevel", context: { deviceId: "lamp", level: 75 } });
  });

  it("updates a tile when the live store learns a new state", async () => {
    const { live } = mount([lamp, bulb]);
    await screen.findAllByTestId("device-tile");
    act(() => live.set({ ...lamp, state: { switch: "on", level: 60 } }));
    await waitFor(() => expect(screen.getAllByTestId("tile-state")[0].textContent).toBe("On · 60%"));
    const icon = screen.getAllByTestId("device-tile")[0].querySelector("button");
    expect(icon?.getAttribute("aria-label")).toBe("Turn off Desk Lamp");
    expect(icon?.getAttribute("aria-pressed")).toBe("true");
    expect(icon?.dataset.tone).toBe("on");
    expect(screen.getAllByTestId("tile-state")[1].textContent).toBe("On · 20%"); // others untouched
  });

  it("shows the message an action resolves to", async () => {
    mount([lamp], vi.fn(async () => "Desk Lamp has lock, so it can only be controlled through confirm_command."));
    fireEvent.click(await screen.findByRole("button", { name: "Turn on Desk Lamp" }));
    expect((await screen.findByTestId("surface-message")).textContent).toMatch(/confirm_command/);
  });
});

describe("scene surface", () => {
  it("runs a scene from its button", async () => {
    const onAction = vi.fn(async (_a: UserAction) => "Scene started." as string | undefined);
    render(
      <Surface
        surfaceId="s2"
        operations={sceneSurface("s2", [{ sceneId: "night", name: "Good night" }])}
        live={new LiveDevices()}
        onAction={onAction}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Good night" }));
    await waitFor(() => expect(onAction).toHaveBeenCalled());
    expect(onAction.mock.calls[0][0]).toMatchObject({ name: "runScene", context: { sceneId: "night" } });
  });
});

describe("tapping a confirm-only device's icon", () => {
  it("asks first, and runs only on the second press", async () => {
    const run = vi.fn(async () => undefined);
    const onAction = vi.fn(async (_a: UserAction): Promise<CardOutcome> => ({
      confirm: { summary: "unlock Front Door (Hall)", confirmLabel: "Unlock", run },
    }));
    const live = new LiveDevices();
    render(<Surface surfaceId="s3" operations={deviceSurface("s3", "Hall", [lock])} deviceIds={["lock"]} live={live} onAction={onAction} />);
    fireEvent.click(await screen.findByRole("button", { name: "Unlock Front Door" }));
    await waitFor(() => expect(onAction).toHaveBeenCalled());
    expect(onAction.mock.calls[0][0]).toMatchObject({
      name: "press",
      context: { deviceId: "lock", action: "confirm", capability: "lock", command: "unlock" },
    });
    expect((await screen.findByTestId("tile-confirm")).textContent).toContain("unlock Front Door (Hall)?");
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });

  it("explains a turned-off control and offers the settings", async () => {
    const openSettings = vi.fn();
    render(
      <Surface
        surfaceId="s4"
        operations={deviceSurface("s4", "Hall", [lock])}
        deviceIds={["lock"]}
        live={new LiveDevices()}
        onAction={async () => ({ message: "Locks are turned off in this app's settings.", openSettings: true })}
        onOpenSettings={openSettings}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Unlock Front Door" }));
    expect((await screen.findByTestId("surface-message")).textContent).toMatch(/turned off/);
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(openSettings).toHaveBeenCalledTimes(1);
  });
});
