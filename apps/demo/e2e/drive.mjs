// Phase 0: drive the demo in headless Chromium and report what happened.
// Needs the dev server (SMARTTHINGS_DEV_TOKEN set) and the agent running.
//   node e2e/drive.mjs "Turn on AG-UI Spike Switch" [screenshot.png]
import { chromium } from "playwright";

const [prompt = "Turn on AG-UI Spike Switch", shot] = process.argv.slice(2);
const DEMO = process.env.DEMO_URL ?? "http://localhost:5173/";

const browser = await chromium.launch();
const page = await browser.newPage();
const log = [];
page.on("console", (m) => m.type() !== "debug" && log.push(`console.${m.type()}: ${m.text().slice(0, 200)}`));
page.on("requestfailed", (r) => log.push(`FAILED ${r.method()} ${r.url()} ${r.failure()?.errorText}`));
page.on("response", (r) => {
  const u = new URL(r.url());
  if (u.host === "api.smartthings.com" || u.pathname === "/run") {
    log.push(`${r.request().method()} ${u.host}${u.pathname} -> ${r.status()}`);
  }
});

await page.goto(DEMO);
await page.getByRole("button", { name: "Connect" }).click();
const input = page.locator("textarea").first();
await input.waitFor();
await input.fill(prompt);
await input.press("Enter");

// A run is finished when the agent has answered after the last tool result;
// wait for network to go quiet rather than for any particular text.
const started = Date.now();
await page.waitForTimeout(1000);
await page.waitForLoadState("networkidle", { timeout: 300_000 });
let quietSince = Date.now();
let last = log.length;
while (Date.now() - quietSince < 5000 && Date.now() - started < 300_000) {
  await page.waitForTimeout(500);
  if (log.length !== last) { last = log.length; quietSince = Date.now(); }
}

const transcript = await page.locator("main, body").first().innerText();
console.log(log.join("\n"));
console.log(`--- page text (${((Date.now() - started) / 1000).toFixed(1)} s) ---\n${transcript.slice(-1500)}`);
if (shot) await page.screenshot({ path: shot, fullPage: true });
await browser.close();
