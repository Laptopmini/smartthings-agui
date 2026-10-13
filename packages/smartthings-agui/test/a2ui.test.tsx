import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Surface, type UserAction } from "../src/a2ui/Surface";
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
    expect(tileModel(lamp)).toMatchObject({ canToggle: true, canDim: true, isOn: false, level: 40, color: "" });
    expect(tileModel(bulb).color).toBe("hsl(0 100% 50%)");
    expect(tileModel(lock)).toMatchObject({ canToggle: false, canDim: false });
    // A valve that also exposes switch still gets no toggle (policy.ts rule 2).
    expect(tileModel(valve)).toMatchObject({ canToggle: false, note: "Controlled through the chat, with confirmation." });
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
    expect(tiles[2].querySelector("button")).toBeNull(); // no controls on a lock
  });

  it("dispatches toggle with the tile's device id and current state", async () => {
    const { onAction } = mount([lamp]);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(onAction).toHaveBeenCalled());
    expect(onAction.mock.calls[0][0]).toMatchObject({ name: "toggle", context: { deviceId: "lamp", isOn: false } });
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
    expect(screen.getAllByTestId("device-tile")[0].querySelector("button")?.textContent).toBe("Turn off");
    expect(screen.getAllByTestId("tile-state")[1].textContent).toBe("On · 20%"); // others untouched
  });

  it("shows the message an action resolves to", async () => {
    mount([lamp], vi.fn(async () => "Desk Lamp has lock, so it can only be controlled through confirm_command."));
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));
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
