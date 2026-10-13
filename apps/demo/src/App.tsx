import { HttpAgent } from "@ag-ui/client";
import { CopilotChat, CopilotKit } from "@copilotkit/react-core/v2";
import { useMemo, useState } from "react";
import { SmartThingsClient, useSmartThingsTools } from "smartthings-agui";

/** Direct connect: the browser posts AG-UI runs straight to the Python agent
 *  (cross-origin, no Node runtime, no proxy), and calls api.smartthings.com
 *  itself for every tool. */
const AGENT_URL = import.meta.env.VITE_AGENT_URL ?? "http://127.0.0.1:8000/run";

const agent = new HttpAgent({ url: AGENT_URL });

function Tools({ client }: { client: SmartThingsClient }) {
  useSmartThingsTools(client);
  return null;
}

export default function App() {
  // Phase 0: a personal access token, held in memory only. OAuth is Phase 1.
  const [token, setToken] = useState(__DEV_SMARTTHINGS_TOKEN__);
  const [signedIn, setSignedIn] = useState(false);
  const client = useMemo(() => (signedIn ? new SmartThingsClient(token) : null), [signedIn, token]);

  if (!client) {
    return (
      <form
        style={{ maxWidth: 420, margin: "4rem auto", display: "grid", gap: 8, fontFamily: "system-ui" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (token) setSignedIn(true);
        }}
      >
        <label htmlFor="token">SmartThings personal access token</label>
        <input id="token" type="password" value={token} onChange={(e) => setToken(e.target.value)} />
        <button type="submit">Connect</button>
        <small>Kept in this tab's memory. Sent only to api.smartthings.com, never to the agent.</small>
      </form>
    );
  }

  return (
    // selfManagedAgents is the documented direct-connect prop; in 1.79.0 it
    // logs an "Enterprise Intelligence tier" console.warn that isn't enforced.
    <CopilotKit selfManagedAgents={{ default: agent }} enableInspector={false}>
      <Tools client={client} />
      <div style={{ height: "100vh" }}>
        <CopilotChat labels={{ chatInputPlaceholder: "Try: turn on AG-UI Spike Switch" }} />
      </div>
    </CopilotKit>
  );
}
