import type { DeviceResult } from "./tools";

type Listener = (device: DeviceResult) => void;

/** The latest state of every device a tool or a card has read, shared by all
 *  cards on screen: when one card (or the agent) changes a lamp, every card
 *  showing that lamp updates. Fed only by reads that already happen; it never
 *  polls (SmartThings rate-limits per token). */
export class LiveDevices {
  private readonly latest = new Map<string, DeviceResult>();
  private readonly listeners = new Set<Listener>();

  set(device: DeviceResult): void {
    this.latest.set(device.deviceId, device);
    for (const listener of this.listeners) listener(device);
  }

  get(deviceId: string): DeviceResult | undefined {
    return this.latest.get(deviceId);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
