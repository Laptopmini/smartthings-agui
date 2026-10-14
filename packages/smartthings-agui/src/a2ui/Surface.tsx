/** Renders a built surface with the catalog, and keeps device tiles live.
 *
 *  One A2UIProvider per surface, operations fed in
 *  once per distinct list (StrictMode and chat re-renders would otherwise
 *  re-send createSurface, which the processor rejects for an existing surface).
 *  No `a2ui` prop on <CopilotKit>: it would send the agent every catalog
 *  component's JSON schema on every run (CopilotKit #7802), and these surfaces
 *  are built in the browser, not by the agent.
 */
import {
  A2UIProvider,
  A2UIRenderer,
  useA2UIActions,
  useA2UIError,
  viewerTheme,
  type A2UIClientEventMessage,
} from "@copilotkit/a2ui-renderer";
import { useEffect, useRef, useState } from "react";
import type { LiveDevices } from "../liveDevices.js";
import type { DeviceResult } from "../tools.js";
import { catalog } from "./catalog.js";
import { updateTile, type Operation } from "./surfaces.js";

export type UserAction = NonNullable<A2UIClientEventMessage["userAction"]>;

/** What a card action leads to: nothing, a message (optionally with a button
 *  to open the app's settings), or a confirmation to show before running. */
export type CardOutcome =
  | string
  | undefined
  | { message: string; openSettings?: boolean }
  | { confirm: { summary: string; confirmLabel: string; run: () => Promise<CardOutcome> } };

function Feeder({ surfaceId, operations }: { surfaceId: string; operations: Operation[] }) {
  const { processMessages, getSurface } = useA2UIActions();
  const lastHash = useRef("");
  useEffect(() => {
    const hash = JSON.stringify(operations);
    if (hash === lastHash.current) return;
    lastHash.current = hash;
    processMessages((getSurface(surfaceId) ? operations.filter((op) => !op.createSurface) : operations) as never);
  }, [processMessages, getSurface, surfaceId, operations]);
  return null;
}

/** Pushes the latest known state of each shown device into the surface: once
 *  on mount (a card re-rendered from chat history may be older than what's
 *  known now) and on every later change. */
function LiveTiles(props: { surfaceId: string; deviceIds: string[]; live: LiveDevices; title: string }) {
  const { surfaceId, deviceIds, live, title } = props;
  const { processMessages } = useA2UIActions();
  const key = deviceIds.join(",");
  useEffect(() => {
    const ids = key.split(",");
    const push = (device: DeviceResult) => {
      const index = ids.indexOf(device.deviceId);
      if (index >= 0) processMessages([updateTile(surfaceId, index, device, title)] as never);
    };
    for (const id of ids) {
      const known = live.get(id);
      if (known) push(known);
    }
    return live.subscribe(push);
  }, [processMessages, surfaceId, key, live, title]);
  return null;
}

const small: React.CSSProperties = { fontSize: 12 };
const pill: React.CSSProperties = {
  padding: "4px 12px",
  borderRadius: 999,
  border: "1px solid color-mix(in srgb, currentColor 30%, transparent)",
  background: "transparent",
  color: "inherit",
  font: "inherit",
  fontSize: 13,
  cursor: "pointer",
};

/** Under the cards: a message, or the confirmation a card's tap asked for
 *  (locks, doors, valves, security). Nothing runs until its button is pressed. */
function Outcome(props: {
  outcome: CardOutcome;
  busy: boolean;
  onOpenSettings?: () => void;
  onConfirm: (run: () => Promise<CardOutcome>) => void;
  onCancel: () => void;
}) {
  const { outcome, busy, onOpenSettings, onConfirm, onCancel } = props;
  if (!outcome) return null;
  if (typeof outcome === "string") {
    return (
      <div role="status" style={{ ...small, opacity: 0.8 }} data-testid="surface-message">
        {outcome}
      </div>
    );
  }
  if ("confirm" in outcome) {
    const { summary, confirmLabel, run } = outcome.confirm;
    return (
      <div role="group" aria-label="Confirm" data-testid="tile-confirm" style={{ display: "grid", gap: 6, margin: "6px 0" }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{summary}?</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={{ ...pill, fontWeight: 600 }} disabled={busy} onClick={() => onConfirm(run)}>
            {confirmLabel}
          </button>
          <button style={pill} disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  return (
    <div role="status" data-testid="surface-message" style={{ display: "grid", gap: 6, margin: "6px 0", ...small }}>
      <div>{outcome.message}</div>
      {outcome.openSettings && onOpenSettings && (
        <button style={{ ...pill, justifySelf: "start" }} onClick={onOpenSettings}>
          Open settings
        </button>
      )}
    </div>
  );
}

function RendererOrError({ surfaceId }: { surfaceId: string }) {
  const error = useA2UIError();
  if (error) return <div data-testid="surface-error">Couldn't show this card: {error}</div>;
  return <A2UIRenderer surfaceId={surfaceId} />;
}

export function Surface(props: {
  surfaceId: string;
  operations: Operation[];
  /** Device ids in tile order, for live updates; omit for scene surfaces. */
  deviceIds?: string[];
  /** The card's title (live tiles hide a room equal to it). */
  title?: string;
  live: LiveDevices;
  /** Runs a card's action; resolves to what to show next, if anything. */
  onAction: (action: UserAction) => Promise<CardOutcome>;
  /** Opens the app's settings, offered when a control is turned off. */
  onOpenSettings?: () => void;
}) {
  const { surfaceId, operations, deviceIds, live, onAction, onOpenSettings, title = "" } = props;
  const [outcome, setOutcome] = useState<CardOutcome>();
  const [busy, setBusy] = useState(false);
  return (
    <div data-testid="surface" data-surface-id={surfaceId}>
      <A2UIProvider
        catalog={catalog}
        theme={viewerTheme}
        onAction={async (event) => {
          if (!event.userAction) return;
          setOutcome(undefined);
          setOutcome(await onAction(event.userAction));
        }}
      >
        <Feeder surfaceId={surfaceId} operations={operations} />
        {deviceIds && <LiveTiles surfaceId={surfaceId} deviceIds={deviceIds} live={live} title={title} />}
        <RendererOrError surfaceId={surfaceId} />
      </A2UIProvider>
      <Outcome
        outcome={outcome}
        busy={busy}
        onOpenSettings={onOpenSettings}
        onConfirm={async (run) => {
          setBusy(true);
          try {
            setOutcome(await run());
          } finally {
            setBusy(false);
          }
        }}
        onCancel={() => setOutcome(undefined)}
      />
    </div>
  );
}
