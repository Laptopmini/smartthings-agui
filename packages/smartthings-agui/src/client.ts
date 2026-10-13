/** A minimal browser-side SmartThings API client.
 *
 *  Runs in the browser and talks to api.smartthings.com directly: the API
 *  answers CORS preflight with `Access-Control-Allow-Origin: *` and allows
 *  `Authorization` (checked with curl, 13 Oct 2026). The token stays here; the
 *  agent only ever sees tool arguments and results.
 */

export const SMARTTHINGS_API = "https://api.smartthings.com/v1";

export interface DeviceSummary {
  deviceId: string;
  label: string;
  roomId?: string;
  /** Capability ids on the `main` component. */
  capabilities: string[];
}

export interface CapabilityRef {
  id: string;
  version: number;
}

export interface Command {
  component?: string;
  capability: string;
  command: string;
  arguments?: unknown[];
}

export class SmartThingsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class SmartThingsClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${SMARTTHINGS_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    if (!response.ok) {
      // 401 is the common one: personal tokens expire 24 h after creation.
      throw new SmartThingsError(response.status, `SmartThings ${response.status} on ${path}`);
    }
    return (await response.json()) as T;
  }

  async listDevices(): Promise<DeviceSummary[]> {
    type Raw = {
      items: {
        deviceId: string;
        label?: string;
        name?: string;
        roomId?: string;
        components: { id: string; capabilities: CapabilityRef[] }[];
      }[];
    };
    // One page (the API's default page size covers a typical home); paging is Phase 1.
    const { items } = await this.request<Raw>("/devices");
    return items.map((d) => ({
      deviceId: d.deviceId,
      label: d.label ?? d.name ?? d.deviceId,
      roomId: d.roomId,
      capabilities: (d.components.find((c) => c.id === "main")?.capabilities ?? []).map((c) => c.id),
    }));
  }

  getCapabilityStatus(deviceId: string, capability: string, component = "main") {
    return this.request<Record<string, { value: unknown }>>(
      `/devices/${encodeURIComponent(deviceId)}/components/${component}/capabilities/${capability}/status`,
    );
  }

  executeCommands(deviceId: string, commands: Command[]) {
    return this.request<{ results: { id: string; status: string }[] }>(
      `/devices/${encodeURIComponent(deviceId)}/commands`,
      {
        method: "POST",
        body: JSON.stringify({ commands: commands.map((c) => ({ component: "main", ...c })) }),
      },
    );
  }

  getCapability(id: string, version = 1) {
    return this.request<CapabilityDefinition>(`/capabilities/${encodeURIComponent(id)}/${version}`);
  }
}

/** The part of `GET /capabilities/{id}/{version}` the tool generator reads. */
export interface CapabilityDefinition {
  id: string;
  version: number;
  status?: string;
  attributes?: Record<string, { schema?: JsonSchema; enumCommands?: { command: string; value: string }[] }>;
  commands?: Record<
    string,
    { name: string; sensitive?: boolean; arguments?: { name: string; optional?: boolean; schema: JsonSchema }[] }
  >;
}

export type JsonSchema = { [key: string]: unknown };
