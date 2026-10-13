import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { DeviceSummary } from "./client";
import type { DeviceState } from "./status";
import { isToolError, type DeviceResult, type ToolResult } from "./tools";

/** Inline styles keep the package free of a stylesheet the host app would have
 *  to import. Colours inherit from the chat, with translucent fills, so the
 *  cards read in light and dark themes alike. */
const card: CSSProperties = {
  border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
  borderRadius: 12,
  padding: "10px 12px",
  margin: "6px 0",
  maxWidth: 420,
  fontSize: 14,
  lineHeight: 1.4,
};
const muted: CSSProperties = { opacity: 0.65, fontSize: 12 };
const chip: CSSProperties = {
  display: "inline-block",
  padding: "1px 8px",
  borderRadius: 999,
  background: "color-mix(in srgb, currentColor 10%, transparent)",
  margin: "4px 6px 0 0",
  fontSize: 12,
};
const button: CSSProperties = {
  padding: "6px 14px",
  borderRadius: 8,
  border: "1px solid color-mix(in srgb, currentColor 30%, transparent)",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  font: "inherit",
};

/** Tool results reach a renderer as the JSON string the agent saw. */
export function parseResult<T>(result: string | undefined): ToolResult<T> | undefined {
  if (result === undefined) return undefined;
  try {
    return JSON.parse(result) as ToolResult<T>;
  } catch {
    return { error: result };
  }
}

const hsl = (hue: number, saturation: number) => `hsl(${(hue * 3.6).toFixed(0)} ${saturation}% 50%)`;

function stateChips(state: DeviceState): ReactNode[] {
  const chips: ReactNode[] = [];
  const add = (key: string, text: ReactNode) => chips.push(<span key={key} style={chip} data-testid={`state-${key}`}>{text}</span>);
  if (state.switch) add("switch", state.switch === "on" ? "On" : "Off");
  if (state.level !== undefined) add("level", `${state.level}%`);
  if (state.hue !== undefined && state.saturation !== undefined) {
    add(
      "color",
      <>
        <span
          aria-hidden
          style={{ display: "inline-block", width: 10, height: 10, borderRadius: 5, marginRight: 4, background: hsl(state.hue, state.saturation) }}
        />
        colour
      </>,
    );
  }
  if (state.colorTemperature !== undefined) add("colorTemperature", `${state.colorTemperature} K`);
  if (state.temperature) add("temperature", `${state.temperature.value}°${state.temperature.unit ?? ""}`);
  if (state.thermostatMode) add("thermostatMode", `mode ${state.thermostatMode}`);
  if (state.heatingSetpoint) add("heatingSetpoint", `heat to ${state.heatingSetpoint.value}°${state.heatingSetpoint.unit ?? ""}`);
  if (state.coolingSetpoint) add("coolingSetpoint", `cool to ${state.coolingSetpoint.value}°${state.coolingSetpoint.unit ?? ""}`);
  if (state.thermostatOperatingState) add("thermostatOperatingState", state.thermostatOperatingState);
  if (state.lock) add("lock", state.lock);
  if (state.door) add("door", `door ${state.door}`);
  if (state.valve) add("valve", `valve ${state.valve}`);
  if (state.securitySystem) add("securitySystem", state.securitySystem);
  if (state.contact) add("contact", state.contact);
  if (state.motion) add("motion", state.motion === "active" ? "motion" : "no motion");
  if (state.windowShade) add("windowShade", state.windowShade);
  if (state.shadeLevel !== undefined) add("shadeLevel", `shade ${state.shadeLevel}%`);
  if (state.battery !== undefined) add("battery", `battery ${state.battery}%`);
  return chips;
}

export function DeviceCard({ device }: { device: DeviceResult }) {
  return (
    <div style={card} data-testid="device-card">
      <div style={{ fontWeight: 600 }}>{device.label}</div>
      {device.room && <div style={muted}>{device.room}</div>}
      <div>{stateChips(device.state)}</div>
    </div>
  );
}

export function ErrorCard({ message }: { message: string }) {
  return (
    <div style={{ ...card, borderColor: "color-mix(in srgb, #d33 60%, transparent)" }} role="status" data-testid="error-card">
      {message}
    </div>
  );
}

export function PendingCard({ text }: { text: string }) {
  return (
    <div style={{ ...card, ...muted }} aria-busy>
      {text}
    </div>
  );
}

export function DeviceListCard({ devices }: { devices: Pick<DeviceSummary, "deviceId" | "label" | "room">[] }) {
  return (
    <div style={card} data-testid="device-list">
      <div style={muted}>{devices.length} devices</div>
      {devices.slice(0, 12).map((d) => (
        <span key={d.deviceId} style={chip}>
          {d.label}
        </span>
      ))}
      {devices.length > 12 && <span style={muted}> and {devices.length - 12} more</span>}
    </div>
  );
}

/** The human-in-the-loop card: validate, ask, then run only on "Confirm". */
export function ConfirmCard<A extends Record<string, unknown>>(props: {
  args: Partial<A>;
  status: "inProgress" | "executing" | "complete";
  result?: string;
  respond?: (result: unknown) => Promise<void>;
  prepare: (args: Partial<A>) => Promise<ToolResult<{ summary: string }>>;
  execute: (args: A) => Promise<unknown>;
  confirmLabel: string;
}) {
  const { args, status, result, respond, prepare, execute, confirmLabel } = props;
  const [prepared, setPrepared] = useState<ToolResult<{ summary: string }>>();
  const [busy, setBusy] = useState(false);
  const answered = useRef(false);

  const answer = async (value: unknown) => {
    if (answered.current || !respond) return;
    answered.current = true;
    await respond(value);
  };

  useEffect(() => {
    if (status !== "executing") return;
    let live = true;
    prepare(args).then((p) => {
      if (!live) return;
      setPrepared(p);
      // Nothing to confirm (unknown device, capability turned off...): tell
      // the agent why instead of showing a button that can't work.
      if (isToolError(p)) void answer(p);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, JSON.stringify(args)]);

  if (status === "complete") {
    const done = parseResult<Record<string, unknown>>(result);
    if (!done || isToolError(done)) return <ErrorCard message={done?.error ?? "No result"} />;
    if ("declined" in done) return <PendingCard text="Cancelled." />;
    if ("state" in done) return <DeviceCard device={done as unknown as DeviceResult} />;
    return <PendingCard text="Done." />;
  }
  if (status === "inProgress" || !prepared) return <PendingCard text="Preparing…" />;
  if (isToolError(prepared)) return <ErrorCard message={prepared.error} />;

  return (
    <div style={card} data-testid="confirm-card">
      <div style={{ fontWeight: 600, marginBottom: 8 }}>{prepared.summary}?</div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          style={{ ...button, fontWeight: 600 }}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await answer(await execute(args as A));
          }}
        >
          {confirmLabel}
        </button>
        <button
          style={button}
          disabled={busy}
          onClick={() => answer({ declined: true, message: "The user declined. Don't retry unless they ask again." })}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
