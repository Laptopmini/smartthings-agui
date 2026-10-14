import { HttpAgent } from "@ag-ui/client";
import { CopilotChat, CopilotKit } from "@copilotkit/react-core/v2";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CONFIRM_COMMANDS,
  CONFIRM_LABELS,
  OAuthSession,
  SmartThingsClient,
  beginSignIn,
  useSmartThingsTools,
  type ConfirmCapability,
  type OAuthConfig,
} from "smartthings-agui";
import "./app.css";

/** Direct connect: the browser posts AG-UI runs to the Python agent (no Node
 *  runtime in between; the dev server only forwards the request), and calls
 *  api.smartthings.com itself for every tool. */
// Same-origin by default: vite.config.ts forwards /agent to the agent, so no
// agent URL or CORS settings are needed.
const AGENT_URL = import.meta.env.VITE_AGENT_URL ?? "/agent/run";

const agent = new HttpAgent({ url: AGENT_URL });

/** OAuth is offered when an OAuth-In app is configured (SMARTTHINGS_CLIENT_ID in
 *  the repo's .env; see the README); otherwise only the personal-token form
 *  shows. The token exchange is reached through the same-origin /exchange route. */
const CLIENT_ID = import.meta.env.VITE_SMARTTHINGS_CLIENT_ID || __SMARTTHINGS_CLIENT_ID__;
const OAUTH: OAuthConfig | null = CLIENT_ID
  ? {
      clientId: CLIENT_ID,
      exchangeUrl: import.meta.env.VITE_TOKEN_EXCHANGE_URL ?? "/exchange",
      redirectUri: import.meta.env.VITE_OAUTH_REDIRECT_URI ?? `${location.origin}/`,
    }
  : null;


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

/** CopilotKit's chat switches to its dark theme under a `.dark` ancestor; follow
 *  the system setting (the page's own colours follow it through CSS). */
function useDarkClass() {
  useEffect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
}

function Tools(props: { client: SmartThingsClient; confirm: ConfirmCapability[]; onOpenSettings: () => void }) {
  useSmartThingsTools(props.client, { confirmCapabilities: props.confirm, onOpenSettings: props.onOpenSettings });
  return null;
}

function Settings(props: {
  value: ConfirmCapability[];
  onChange: (v: ConfirmCapability[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { value, onChange } = props;
  return (
    <details
      className="st-settings"
      open={props.open}
      onToggle={(e) => props.onOpenChange((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>Safety settings</summary>
      {/* Floats below the header, so opening it never reflows the header
          (on a phone it squeezed the title and "Sign out" onto two lines). */}
      <div className="st-settings-panel">
      <p>
        Off by default. When on, the assistant can ask to control these, and nothing happens until you press the
        confirmation button.
      </p>
      {(Object.keys(CONFIRM_LABELS) as ConfirmCapability[]).map((capability) => (
        <label key={capability}>
          <input
            type="checkbox"
            checked={value.includes(capability)}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, capability] : value.filter((c) => c !== capability))
            }
          />{" "}
          {CONFIRM_LABELS[capability]}
        </label>
      ))}
      </div>
    </details>
  );
}

export default function App() {
  // A personal access token held in memory only (never storage): it's a
  // 24-hour credential for the whole account.
  const [token, setToken] = useState(__DEV_SMARTTHINGS_TOKEN__);
  const [signedIn, setSignedIn] = useState(false);
  const [session, setSession] = useState<OAuthSession | null>(null);
  const [authError, setAuthError] = useState<string>();
  const [confirm, setConfirm] = useState<ConfirmCapability[]>(loadOptIns);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Stable, so the tools don't re-register on every render.
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  useDarkClass();
  const client = useMemo(() => {
    if (session) return new SmartThingsClient(() => session.accessToken());
    return signedIn ? new SmartThingsClient(token) : null;
  }, [session, signedIn, token]);

  // Coming back from SmartThings' authorize page: finish the exchange, then
  // drop ?code=…&state=… from the address bar.
  useEffect(() => {
    if (!OAUTH) return;
    OAuthSession.complete(OAUTH, location.search)
      .then((s) => s && setSession(s))
      .catch((e: Error) => setAuthError(e.message))
      .finally(() => {
        if (location.search) history.replaceState(null, "", location.pathname);
      });
  }, []);

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
        {client && (
          <Settings value={confirm} onChange={updateConfirm} open={settingsOpen} onOpenChange={setSettingsOpen} />
        )}
        {session && import.meta.env.DEV && (
          // Dev only: exercise the refresh path without waiting ~24 h.
          <button
            className="st-link"
            onClick={() =>
              session.refresh().then(
                () => setAuthError("Token refreshed."),
                (e: Error) => setAuthError(e.message),
              )
            }
          >
            Refresh token
          </button>
        )}
        {client && (
          <button
            className="st-link"
            onClick={() => {
              setSignedIn(false);
              setSession(null);
            }}
          >
            Sign out
          </button>
        )}
      </header>

      {client ? (
        <CopilotKit selfManagedAgents={{ default: agent }} enableInspector={false}>
          <Tools client={client} confirm={confirm} onOpenSettings={openSettings} />
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
          {OAUTH && (
            <>
              <button type="button" onClick={() => location.assign(beginSignIn(OAUTH))}>
                Sign in with SmartThings
              </button>
              <small>or, for development, a personal access token:</small>
            </>
          )}
          {authError && <small role="alert">{authError}</small>}
          <label htmlFor="token">SmartThings personal access token</label>
          <input id="token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
          <button type="submit">Connect</button>
          <small>
            Kept in this tab's memory and sent only to api.smartthings.com, never to the agent. Personal tokens expire
            after 24 hours.
          </small>
        </form>
      )}

      {client && authError && (
        <small className="st-footer" role="status">
          {authError}
        </small>
      )}
      <footer className="st-footer">Not affiliated with or endorsed by Samsung.</footer>
    </div>
  );
}
