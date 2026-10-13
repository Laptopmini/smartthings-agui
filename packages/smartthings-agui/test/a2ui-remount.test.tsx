import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Surface } from "../src/a2ui/Surface";
import { deviceSurface } from "../src/a2ui/surfaces";
import { LiveDevices } from "../src/liveDevices";
import type { DeviceResult } from "../src/tools";

afterEach(cleanup);

const lamp: DeviceResult = { deviceId: "lamp", label: "Desk Lamp", room: "Office", state: { switch: "off", level: 60 } };

it("a card remounted from history shows the latest known state, not its original result", async () => {
  const live = new LiveDevices();
  const ui = () => (
    <Surface surfaceId="s1" operations={deviceSurface("s1", "Office", [lamp])} deviceIds={["lamp"]} live={live} onAction={async () => undefined} />
  );
  const { unmount } = render(ui());
  await screen.findByTestId("device-tile");
  act(() => live.set({ ...lamp, state: { switch: "on", level: 60 } }));
  await waitFor(() => expect(screen.getByTestId("tile-state").textContent).toBe("On · 60%"));

  // A virtualized chat list unmounts cards scrolled out of view, then remounts them.
  unmount();
  render(ui());
  await screen.findByTestId("device-tile");
  await waitFor(() => expect(screen.getByTestId("tile-state").textContent).toBe("On · 60%"), { timeout: 2000 });
});

it("live.current() gives each device's latest known state, else the original", () => {
  const live = new LiveDevices();
  const bulb: DeviceResult = { deviceId: "bulb", label: "Bulb", state: { switch: "off" } };
  live.set({ ...lamp, state: { switch: "on", level: 60 } });
  expect(live.current([lamp, bulb]).map((d) => d.state.switch)).toEqual(["on", "off"]);
});
