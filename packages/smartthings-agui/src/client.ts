/** A minimal browser-side SmartThings API client.
 *
 *  Runs in the browser and talks to api.smartthings.com directly: the API
 *  answers CORS preflight with `Access-Control-Allow-Origin: *` and allows
 *  `Authorization` (checked with curl, 13 Oct 2026). The token stays here; the
 *  agent only ever sees tool arguments and results.
 *
 *  SmartThings rate-limits per token, so the device list (with room names) and
 *  capability definitions are cached; nothing here polls.
 */

export const SMARTTHINGS_API = "https://api.smartthings.com/v1";

/** How long a device list is reused before it's fetched again. */
const DEVICE_CACHE_MS = 30_000;

export interface DeviceSummary {
  deviceId: string;
  label: string;
  room?: string;
  locationId?: string;
  /** Capability ids on the `main` component. */
  capabilities: string[];
}

export interface SceneSummary {
  sceneId: string;
  name: string;
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

/** `GET /devices/{id}/components/main/status`: capability → attribute → value. */
export type ComponentStatus = Record<string, Record<string, { value: unknown; unit?: string }>>;

export class SmartThingsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type RawDevice = {
  deviceId: string;
  label?: string;
  name?: string;
  roomId?: string;
  locationId?: string;
  components: { id: string; capabilities: CapabilityRef[] }[];
};

type Page<T> = { items: T[]; _links?: { next?: { href?: string } | null } };

/** A personal access token, or a function returning a current access token
 *  (an OAuth session refreshes behind it). */
export type TokenSource = string | (() => Promise<string>);

export class SmartThingsClient {
  private devices?: { at: number; value: Promise<DeviceSummary[]> };
  private readonly capabilities = new Map<string, Promise<CapabilityDefinition>>();

  constructor(
    private readonly token: TokenSource,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  private async request<T>(pathOrUrl: string, init?: RequestInit): Promise<T> {
    const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${SMARTTHINGS_API}${pathOrUrl}`;
    const token = typeof this.token === "string" ? this.token : await this.token();
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    if (!response.ok) {
      // 401 is the common one: personal tokens expire 24 h after creation.
      // 422 means SmartThings rejected the command's arguments.
      throw new SmartThingsError(response.status, `SmartThings ${response.status} on ${new URL(url).pathname}`);
    }
    return (await response.json()) as T;
  }

  /** Every item across pages. The API's `next` link is absolute (and, as of
   *  13 Oct 2026, omits `/v1`; both forms answer 200). */
  private async all<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined = path;
    while (next) {
      const page: Page<T> = await this.request<Page<T>>(next);
      items.push(...page.items);
      next = page._links?.next?.href ?? undefined;
    }
    return items;
  }

  /** Devices with room names, cached for 30 s. `refresh` forces a fetch. */
  listDevices(refresh = false): Promise<DeviceSummary[]> {
    if (refresh || !this.devices || Date.now() - this.devices.at > DEVICE_CACHE_MS) {
      const value = this.fetchDevices();
      this.devices = { at: Date.now(), value };
      value.catch(() => (this.devices = undefined));
    }
    return this.devices.value;
  }

  private async fetchDevices(): Promise<DeviceSummary[]> {
    const devices = await this.all<RawDevice>("/devices");
    const locations = [...new Set(devices.map((d) => d.locationId).filter((l): l is string => !!l))];
    const rooms = new Map<string, string>();
    for (const locationId of locations) {
      for (const room of await this.all<{ roomId: string; name: string }>(`/locations/${locationId}/rooms`)) {
        rooms.set(room.roomId, room.name);
      }
    }
    return devices.map((d) => ({
      deviceId: d.deviceId,
      label: d.label ?? d.name ?? d.deviceId,
      room: d.roomId ? rooms.get(d.roomId) : undefined,
      locationId: d.locationId,
      capabilities: (d.components.find((c) => c.id === "main")?.capabilities ?? []).map((c) => c.id),
    }));
  }

  async getDevice(deviceId: string): Promise<DeviceSummary> {
    let device = (await this.listDevices()).find((d) => d.deviceId === deviceId);
    // A device added since the last fetch: look once more before giving up.
    device ??= (await this.listDevices(true)).find((d) => d.deviceId === deviceId);
    if (!device) throw new SmartThingsError(404, `No device with id ${deviceId}. Call list_devices for valid ids.`);
    return device;
  }

  getStatus(deviceId: string, component = "main") {
    return this.request<ComponentStatus>(`/devices/${encodeURIComponent(deviceId)}/components/${component}/status`);
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

  async listScenes(): Promise<SceneSummary[]> {
    const scenes = await this.all<{ sceneId: string; sceneName?: string }>("/scenes");
    return scenes.map((s) => ({ sceneId: s.sceneId, name: s.sceneName ?? s.sceneId }));
  }

  executeScene(sceneId: string) {
    return this.request<{ status: string }>(`/scenes/${encodeURIComponent(sceneId)}/execute`, { method: "POST" });
  }

  /** Capability definitions never change for a given version: cached for the session. */
  getCapability(id: string, version = 1): Promise<CapabilityDefinition> {
    const key = `${id}/${version}`;
    let definition = this.capabilities.get(key);
    if (!definition) {
      definition = this.request<CapabilityDefinition>(`/capabilities/${encodeURIComponent(id)}/${version}`);
      definition.catch(() => this.capabilities.delete(key));
      this.capabilities.set(key, definition);
    }
    return definition;
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
