declare const __DEV_SMARTTHINGS_TOKEN__: string;
/** SMARTTHINGS_CLIENT_ID from the repo's .env (public; the secret is never read). */
declare const __SMARTTHINGS_CLIENT_ID__: string;

interface ImportMetaEnv {
  readonly VITE_AGENT_URL?: string;
  readonly VITE_SMARTTHINGS_CLIENT_ID?: string;
  readonly VITE_TOKEN_EXCHANGE_URL?: string;
  readonly VITE_OAUTH_REDIRECT_URI?: string;
}
