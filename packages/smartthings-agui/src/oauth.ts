/** SmartThings OAuth (authorization-code flow) for a browser app.
 *
 *  The browser does the redirect to SmartThings and back; the code-for-token
 *  exchange and refreshes go through a small server that holds the client
 *  secret (agent/token_exchange.py), because the documented token endpoint
 *  requires one. Tokens are kept in memory only: a reload means signing in
 *  again, which is the price of not leaving a 29-day refresh token in storage.
 */

/** Not the documented `https://api.smartthings.com/oauth/authorize`: that URL
 *  answered 403 Forbidden to every request on 13 Oct 2026 (our client id, a
 *  made-up one, browser user agent or not). This host, which the open-source
 *  SmartThings CLI uses for its own sign-in, redirects to the SmartThings
 *  login page as expected. Overridable with `OAuthConfig.authorizeUrl`. */
export const AUTHORIZE_URL = "https://oauthin-regional.api.smartthings.com/oauth/authorize";

/** Enough for the tools: read and control devices, read and run scenes,
 *  read locations (for room names). */
export const DEFAULT_SCOPES = ["r:devices:*", "x:devices:*", "r:scenes:*", "x:scenes:*", "r:locations:*"];

/** Refresh this long before expiry, so a command never races the deadline. */
const REFRESH_MARGIN_MS = 5 * 60_000;

const STATE_KEY = "smartthings-agui:oauth-state";

export interface OAuthConfig {
  clientId: string;
  redirectUri: string;
  /** The token-exchange service, e.g. http://127.0.0.1:8001 */
  exchangeUrl: string;
  scopes?: string[];
  authorizeUrl?: string;
}

interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

/** Start sign-in: returns the URL to send the browser to. The `state` is kept
 *  in sessionStorage (it must survive the redirect) and checked on return. */
export function beginSignIn(config: OAuthConfig, storage: Pick<Storage, "setItem"> = sessionStorage): string {
  const state = crypto.randomUUID();
  storage.setItem(STATE_KEY, state);
  const url = new URL(config.authorizeUrl ?? AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", (config.scopes ?? DEFAULT_SCOPES).join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

export class OAuthSession {
  private constructor(
    private readonly config: OAuthConfig,
    private tokens: Tokens,
    private expiresAt: number,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /** Finish sign-in from the redirect's query string. Returns null when the
   *  URL isn't an OAuth return; throws on a state mismatch or a failed exchange. */
  static async complete(
    config: OAuthConfig,
    search: string,
    storage: Pick<Storage, "getItem" | "removeItem"> = sessionStorage,
    fetchImpl: typeof fetch = (...args) => fetch(...args),
  ): Promise<OAuthSession | null> {
    const params = new URLSearchParams(search);
    const code = params.get("code");
    const error = params.get("error");
    if (!code && !error) return null;
    const expected = storage.getItem(STATE_KEY);
    storage.removeItem(STATE_KEY);
    if (error) throw new Error(`SmartThings sign-in failed: ${error}`);
    // CSRF guard: the code must come back to the sign-in this tab started.
    if (!expected || params.get("state") !== expected) throw new Error("Sign-in state didn't match; please try again.");
    const tokens = await post<Tokens>(fetchImpl, `${config.exchangeUrl}/oauth/token`, {
      code,
      redirect_uri: config.redirectUri,
    });
    return new OAuthSession(config, tokens, expiry(tokens), fetchImpl);
  }

  /** A current access token, refreshed first if it's about to expire. Pass
   *  `() => session.accessToken()` to SmartThingsClient. */
  async accessToken(): Promise<string> {
    if (Date.now() > this.expiresAt - REFRESH_MARGIN_MS && this.tokens.refresh_token) await this.refresh();
    return this.tokens.access_token;
  }

  /** Swap the refresh token for a new access token now. */
  async refresh(): Promise<void> {
    if (!this.tokens.refresh_token) throw new Error("No refresh token; sign in again.");
    const next = await post<Tokens>(this.fetchImpl, `${this.config.exchangeUrl}/oauth/refresh`, {
      refresh_token: this.tokens.refresh_token,
    });
    // SmartThings may or may not rotate the refresh token; keep the old one if not.
    this.tokens = { ...next, refresh_token: next.refresh_token ?? this.tokens.refresh_token };
    this.expiresAt = expiry(this.tokens);
  }
}

/** Access tokens last 24 h (public docs); assume that if `expires_in` is missing. */
const expiry = (tokens: Tokens) => Date.now() + (tokens.expires_in ?? 86_400) * 1000;

async function post<T>(fetchImpl: typeof fetch, url: string, body: unknown): Promise<T> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.json().then((b: { detail?: string }) => b.detail, () => undefined);
    throw new Error(`Token exchange failed (${response.status}${detail ? `: ${detail}` : ""})`);
  }
  return (await response.json()) as T;
}
