import { expect, it } from "vitest";
import { capabilityToTools } from "../../src/capabilityTools";
import { SmartThingsClient } from "../../src/client";

/** Opt-in: generate tools for every capability on the account's devices.
 *  Run with SMARTTHINGS_TOKEN set (never commit it):
 *    source ~/.zsh_secrets && npx vitest run --project live
 */
const token = process.env.SMARTTHINGS_TOKEN;

it.skipIf(!token)("generates a tool schema for every capability in the home", async () => {
  const client = new SmartThingsClient(token!);
  const devices = await client.listDevices();
  const ids = [...new Set(devices.flatMap((d) => d.capabilities))].sort();

  const rows: string[] = [];
  let tools = 0;
  for (const id of ids) {
    try {
      const generated = capabilityToTools(await client.getCapability(id));
      tools += generated.length;
      rows.push(`ok   ${id}: ${generated.map((t) => t.name).join(", ") || "(no commands)"}`);
    } catch (error) {
      rows.push(`FAIL ${id}: ${(error as Error).message}`);
    }
  }
  console.log(`${ids.length} capabilities on ${devices.length} devices, ${tools} tools\n${rows.join("\n")}`);
  expect(rows.filter((r) => r.startsWith("FAIL"))).toEqual([]);
}, 60_000);
