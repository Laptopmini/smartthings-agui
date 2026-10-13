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
import type { LiveDevices } from "../liveDevices";
import type { DeviceResult } from "../tools";
import { catalog } from "./catalog";
import { updateTile, type Operation } from "./surfaces";

export type UserAction = NonNullable<A2UIClientEventMessage["userAction"]>;

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
  /** Runs a card's action; resolves to an error message to show, if any. */
  onAction: (action: UserAction) => Promise<string | undefined>;
}) {
  const { surfaceId, operations, deviceIds, live, onAction, title = "" } = props;
  const [message, setMessage] = useState<string>();
  return (
    <div data-testid="surface" data-surface-id={surfaceId}>
      <A2UIProvider
        catalog={catalog}
        theme={viewerTheme}
        onAction={async (event) => {
          if (!event.userAction) return;
          setMessage(undefined);
          setMessage(await onAction(event.userAction));
        }}
      >
        <Feeder surfaceId={surfaceId} operations={operations} />
        {deviceIds && <LiveTiles surfaceId={surfaceId} deviceIds={deviceIds} live={live} title={title} />}
        <RendererOrError surfaceId={surfaceId} />
      </A2UIProvider>
      {message && (
        <div role="status" style={{ fontSize: 12, opacity: 0.8 }} data-testid="surface-message">
          {message}
        </div>
      )}
    </div>
  );
}
