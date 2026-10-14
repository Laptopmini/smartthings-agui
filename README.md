# SmartThings AG-UI

Talk to your SmartThings home from any [AG-UI](https://docs.ag-ui.com) agent, with device cards in the chat, a confirmation step before anything security-sensitive moves, and a SmartThings token that never leaves your browser.

<p align="center">
  <img src="docs/demo.gif" />
</p>

## How it works

```
Browser (React + CopilotKit, direct connect)
  ├─ SmartThings token (personal token, or OAuth)      ← never sent to the agent
  ├─ frontend tools  → fetch api.smartthings.com        (CORS allows it)
  ├─ confirmation cards for locks, doors, valves, security, scenes
  ├─ device cards (A2UI surfaces built in the browser) with live state and controls
  └─ the home (devices, rooms, scenes) as agent context
        │  AG-UI over HTTP/SSE
        ▼
Any AG-UI agent. Reference: Python, FastAPI + the LlamaIndex AG-UI router.
It has no SmartThings code and no SmartThings credentials.
```

Device and scene cards are [A2UI](https://a2ui.org) v0.9 surfaces from a small catalog. The agent decides *what* to show; the browser builds the surface from live device data, so the model never writes UI JSON and never needs the catalog's schemas in its context.

SmartThings capabilities are registered with CopilotKit as **frontend tools**: the agent decides to call `set_level`, the browser runs it against `api.smartthings.com` with the user's token, and the agent gets the result back.

| Tool | What it does |
|---|---|
| `list_devices`, `get_device_status` | Read the home. The device and scene list is also sent as context, so most requests need no lookup. |
| `show_devices`, `show_scenes` | Show a room (or chosen devices) as cards with on/off and dimmer controls, or the scenes as buttons. The person can use them directly, without another agent turn. |
| `set_switch`, `set_level`, `set_color`, `set_thermostat` | Typed tools for the common capabilities. Small models call these much more reliably than a generic one. |
| `execute_command` | Anything else on an allowlist (lighting, climate, shades, fans, media), with arguments checked against the capability's definition from the public API. |
| `confirm_command` | Locks, doors, garage doors, valves and security systems. Off by default (the card says so and points at the settings); when on, asks the person before anything happens. |
| `run_scene` | Runs a scene after the person confirms. |

More detail: [docs/how-it-works.md](docs/how-it-works.md).

## Use it in your app

```sh
npm install smartthings-agui @copilotkit/react-core@1.79.0 @ag-ui/client@1.0.2
```

```tsx
import { HttpAgent } from "@ag-ui/client";
import { CopilotChat, CopilotKit } from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
import { SmartThingsClient, useSmartThingsTools } from "smartthings-agui";

const agent = new HttpAgent({ url: "http://localhost:8000/run" }); // any AG-UI agent
const client = new SmartThingsClient(token); // a personal access token, or () => session.accessToken()

function SmartThings() {
  useSmartThingsTools(client); // registers the tools, device cards and confirmation flow
  return null;
}

export function App() {
  return (
    <CopilotKit selfManagedAgents={{ default: agent }}>
      <SmartThings />
      <CopilotChat />
    </CopilotKit>
  );
}
```

Needs React 19 and a bundler (the package is ES modules only). Any AG-UI agent works, since the tools run in the browser. Locks, doors, valves, security are off by default. Turn them on per capability with `useSmartThingsTools(client, { confirmCapabilities: ["lock"] })`; each command still waits for the person's confirmation.

## Try the demo

You need Node 24, [uv](https://docs.astral.sh/uv/) (it fetches Python 3.14 itself if needed), a SmartThings account, and an API key for an OpenAI-compatible model that supports tool calling.

```sh
git clone https://github.com/Laptopmini/smartthings-agui.git
cd smartthings-agui
npm install
cp .env.example .env    # set AGENT_API_KEY and AGENT_MODEL (and AGENT_API_BASE if not OpenAI)
npm run dev             # starts the agent and the app: http://localhost:5173
```

The demo app lets you sign in with either a [personal access token](https://account.smartthings.com/tokens) or using an [OAuth-In App SmartThings app](https://developer.smartthings.com/docs/getting-started/quickstart#for-integration-development-oauth-20).

### Personal Access Token 

Create a new [personal access token](https://account.smartthings.com/tokens) and give it the Devices, Scenes and Locations permissions.

### OAuth Login

This allows you to login without having to renew your token manually:

1. Run `npx @smartthings/cli apps:create` (the first run signs you in to SmartThings in the browser) and choose **OAuth-In App**.
2. Enter any display name and description; leave the icon and target URL empty.
3. Scopes: `r:devices:*`, `x:devices:*`, `r:scenes:*`, `x:scenes:*`, `r:locations:*`.
4. Redirect URI: `http://localhost:5173/`
5. Put the client ID and secret it prints in `.env` as `SMARTTHINGS_CLIENT_ID` and `SMARTTHINGS_CLIENT_SECRET` (the secret is shown only once).
6. Restart `npm run dev`. The sign-in page now has **Sign in with SmartThings**.

## Security model

To prevent an agent from performing unwanted actions, there are a couple of limitations by design:

1. **Deny by default.** Commands for `lock`, `garageDoorControl`, `doorControl`, `securitySystem` and `valve` are refused unless the user turns that capability on in *Safety settings*. Until then, a request ends in a card saying the control is off, with a button that opens the settings; turning it on never runs anything by itself.
2. **A person confirms.** When it is on, the agent can only *ask*: a card shows what will happen, and the command runs only when the person presses the button. The policy is checked again at that moment.
3. **No side doors.** A device that has any of those capabilities can't be commanded through any other tool (some valves also expose `switch`), and `execute_command` only reaches an allowlist. `execute`, `ocf`, firmware updates, ovens and vendor-specific capabilities are out of reach.
4. **Scenes always ask**, because a scene can unlock a door and the public API doesn't reliably say what a scene contains. (When the agent runs one, a confirmation card asks; on a scene card the person's own press is the confirmation.)
5. **The token stays in the browser.** The agent sees tool arguments and results only. Tokens are kept in memory, not storage.
6. **Card controls follow the same rules.** A card's icon or slider runs through the same tool handlers as the agent. On a lock, door, valve or security system, tapping the icon only asks ("Unlock Front Door?"), and nothing happens until the person confirms.

What the model *does* see: with a hosted model, the conversation, device and room names, and device states go to that model provider, as with any cloud assistant. Never your SmartThings token. A local model would keep all of it at home, but local models are not yet tested (see [Versions tested](docs/how-it-works.md#versions-tested)).

The list of confirm-only capabilities is hard-coded on purpose: the API's per-command `sensitive` flag isn't a safety signal (`lock.unlock` reports `"sensitive": false`). The rules live in one small file, [`policy.ts`](packages/smartthings-agui/src/policy.ts), with tests in [`tools.test.ts`](packages/smartthings-agui/test/tools.test.ts) and the confirmation flow tested end to end in [`roundTrip.test.tsx`](packages/smartthings-agui/test/integration/roundTrip.test.tsx).

## Tests

```sh
npm test                    # vitest: unit + integration (starts the agent with --scripted)
(cd agent && uv run pytest) # agent, router shims, token exchange
```

The integration tests run real CopilotKit and `@ag-ui/client` against the real Python agent over HTTP, with only the model and `api.smartthings.com` replaced, and click through the confirmation card. `apps/demo/e2e/drive.mjs` drives the app in headless Chromium against registered SmartThings virtual devices.

## Background

Built by someone who worked on SmartThings at Samsung for ten years. This project is independent: it uses only the public SmartThings documentation and API.

> Not affiliated with or endorsed by Samsung. "SmartThings" is used only to describe what this works with.

## Licence

[Apache-2.0](LICENSE)
