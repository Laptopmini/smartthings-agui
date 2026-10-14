import type { ConfirmCapability } from "./policy.js";

/** The confirm-only capabilities the user has turned on, readable live.
 *
 *  One instance lives as long as the hook. Tools and confirmation cards hold
 *  this object rather than a snapshot of the settings: CopilotKit keeps
 *  rendering an in-flight confirmation card with the render function it
 *  started with, so a snapshot taken when Locks was off stayed "off" after the
 *  user turned Locks on (seen in the integration test, 13 Oct 2026). */
export class ConfirmSettings {
  private enabled = new Set<ConfirmCapability>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(initial: Iterable<ConfirmCapability> = []) {
    this.enabled = new Set(initial);
  }

  has(capability: ConfirmCapability): boolean {
    return this.enabled.has(capability);
  }

  /** Replace the set; notifies only when it actually changed. */
  set(capabilities: Iterable<ConfirmCapability>): void {
    const next = new Set(capabilities);
    if (next.size === this.enabled.size && [...next].every((c) => this.enabled.has(c))) return;
    this.enabled = next;
    this.version++;
    for (const listener of this.listeners) listener();
  }

  /** For useSyncExternalStore. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;
}
