# smartthings-agui

Talk to your SmartThings home from any [AG-UI](https://docs.ag-ui.com) agent, with device cards in the chat, a confirmation step before anything security-sensitive moves, and a SmartThings token that never leaves the browser.

> Not affiliated with or endorsed by Samsung. "SmartThings" is used only to describe what this works with.

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

Locks, doors, garage doors, valves and security systems are off by default: turn them on per capability with `useSmartThingsTools(client, { confirmCapabilities: ["lock"] })`, and each command still waits for the person's confirmation.

The demo app, a reference Python agent, the security model and how it all works: [github.com/Laptopmini/smartthings-agui](https://github.com/Laptopmini/smartthings-agui).

Licence: Apache-2.0.
