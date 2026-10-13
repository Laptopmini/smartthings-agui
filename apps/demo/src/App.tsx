import { HttpAgent } from "@ag-ui/client";
import { CopilotChat, CopilotKit } from "@copilotkit/react-core/v2";
import { useMemo, useState } from "react";
import { CONFIRM_COMMANDS, SmartThingsClient, useSmartThingsTools, type ConfirmCapability } from "smartthings-agui";
import "./app.css";

/** Direct connect: the browser posts AG-UI runs straight to the Python agent
 *  (cross-origin, no Node runtime, no proxy), and calls api.smartthings.com
 *  itself for every tool. */
const AGENT_URL = import.meta.env.VITE_AGENT_URL ?? "http://127.0.0.1:8000/run";

const agent = new HttpAgent({ url: AGENT_URL });

const CAPABILITY_LABELS: Record<ConfirmCapability, string> = {
  lock: "Locks",
  garageDoorControl: "Garage doors",
  doorControl: "Doors",
  valve: "Valves",
  securitySystem: "Security system",
};

const SETTINGS_KEY = "smartthings-agui:confirm-capabilities";

/** The opt-ins are a preference, not a secret, so they survive a reload.
 *  Storage can be unavailable (private windows); then they start off. */
function loadOptIns(): ConfirmCapability[] {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "[]") as string[];
    return saved.filter((c): c is ConfirmCapability => c in CONFIRM_COMMANDS);
  } catch {
    return [];
  }
}

function Tools({ client, confirm }: { client: SmartThingsClient; confirm: ConfirmCapability[] }) {
  useSmartThingsTools(client, { confirmCapabilities: confirm });
  return null;
}

function Settings({ value, onChange }: { value: ConfirmCapability[]; onChange: (v: ConfirmCapability[]) => void }) {
  return (
    <details className="st-settings">
      <summary>Safety settings</summary>
      <p>
        Off by default. When on, the assistant can ask to control these, and nothing happens until you press the
        confirmation button.
      </p>
      {(Object.keys(CAPABILITY_LABELS) as ConfirmCapability[]).map((capability) => (
        <label key={capability}>
          <input
            type="checkbox"
            checked={value.includes(capability)}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, capability] : value.filter((c) => c !== capability))
            }
          />{" "}
          {CAPABILITY_LABELS[capability]}
        </label>
      ))}
    </details>
  );
}

export default function App() {
  // A personal access token held in memory only (never storage): it's a
  // 24-hour credential for the whole account.
  const [token, setToken] = useState(__DEV_SMARTTHINGS_TOKEN__);
  const [signedIn, setSignedIn] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmCapability[]>(loadOptIns);
  const client = useMemo(() => (signedIn ? new SmartThingsClient(token) : null), [signedIn, token]);

  const updateConfirm = (next: ConfirmCapability[]) => {
    setConfirm(next);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      // not persisted; still applies for this session
    }
  };

  return (
    <div className="st-app">
      <header className="st-header">
        <strong>SmartThings AG-UI</strong>
        {client && <Settings value={confirm} onChange={updateConfirm} />}
        {client && (
          <button className="st-link" onClick={() => setSignedIn(false)}>
            Sign out
          </button>
        )}
      </header>

      {client ? (
        <CopilotKit selfManagedAgents={{ default: agent }} enableInspector={false}>
          <Tools client={client} confirm={confirm} />
          <main className="st-chat">
            <CopilotChat
              labels={{
                chatInputPlaceholder: "Try: dim the desk lamp to 30%",
                welcomeMessageText: "Ask about your devices, or tell me what to change.",
              }}
            />
          </main>
        </CopilotKit>
      ) : (
        <form
          className="st-signin"
          onSubmit={(e) => {
            e.preventDefault();
            if (token) setSignedIn(true);
          }}
        >
          <label htmlFor="token">SmartThings personal access token</label>
          <input id="token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
          <button type="submit">Connect</button>
          <small>
            Kept in this tab's memory and sent only to api.smartthings.com, never to the agent. Personal tokens expire
            after 24 hours.
          </small>
        </form>
      )}

      <footer className="st-footer">Not affiliated with or endorsed by Samsung.</footer>
    </div>
  );
}
