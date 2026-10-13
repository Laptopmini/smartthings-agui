import type { DeviceResult } from "./tools";

type Listener = (device: DeviceResult) => void;

/** The latest state of every device a tool or a card has read, shared by all
 *  cards on screen: when one card (or the agent) changes a lamp, every card
 *  showing that lamp updates. Fed only by reads that already happen; it never
 *  polls (SmartThings rate-limits per token). */
export class LiveDevices {
  private readonly states = new Map<string, DeviceResult>();
  private readonly listeners = new Set<Listener>();

  set(device: DeviceResult): void {
    this.states.set(device.deviceId, device);
    for (const listener of this.listeners) listener(device);
  }

  get(deviceId: string): DeviceResult | undefined {
    return this.states.get(deviceId);
  }

  /** Each device's latest known state, falling back to the one given. A card
   *  rebuilt from chat history starts from this rather than from the tool's
   *  original result, so it never shows a stale state first. */
  current(devices: DeviceResult[]): DeviceResult[] {
    return devices.map((d) => this.states.get(d.deviceId) ?? d);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
