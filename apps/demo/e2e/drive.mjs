// Drive the demo in headless Chromium and report what happened.
// Needs the dev server (SMARTTHINGS_DEV_TOKEN set) and the agent running.
//
//   node e2e/drive.mjs "first prompt" "second prompt" ...
//
// Environment:
//   ENABLE=lock,doorControl   tick these in Safety settings first
//   CLICK=Unlock              press this button whenever a confirm card shows
//   SHOTS=dir                 save a screenshot after each prompt
//   VIDEO=dir                 record a video of the session
import { chromium } from "playwright";

const prompts = process.argv.slice(2);
const DEMO = process.env.DEMO_URL ?? "http://localhost:5173/";
const enable = (process.env.ENABLE ?? "").split(",").filter(Boolean);
const LABELS = { lock: "Locks", garageDoorControl: "Garage doors", doorControl: "Doors", valve: "Valves", securitySystem: "Security system" };

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 900, height: 820 },
  ...(process.env.VIDEO ? { recordVideo: { dir: process.env.VIDEO, size: { width: 900, height: 820 } } } : {}),
});
const page = await context.newPage();
const log = [];
const NOISE = /Lit is in dev|React DevTools|Enterprise Intelligence|no renderer is registered/;
page.on("console", (m) => m.type() !== "debug" && !NOISE.test(m.text()) && log.push(`console.${m.type()}: ${m.text().slice(0, 300)}`));
page.on("requestfailed", (r) => log.push(`FAILED ${r.method()} ${r.url()} ${r.failure()?.errorText}`));
page.on("response", (r) => {
  const u = new URL(r.url());
  if (u.host === "api.smartthings.com" || u.pathname === "/run") log.push(`${r.request().method()} ${u.host}${u.pathname} -> ${r.status()}`);
});

await page.goto(DEMO);
await page.getByRole("button", { name: "Connect" }).click();
if (enable.length) {
  await page.getByText("Safety settings").click();
  for (const c of enable) await page.getByLabel(LABELS[c]).check();
  await page.getByText("Safety settings").click();
}
const input = page.locator("textarea").first();
await input.waitFor();
await page.waitForTimeout(1500); // let the home context load before the first run

/** Settled = no SmartThings or agent traffic for 4 s, after any confirm card is answered. */
async function settle(started) {
  let last = log.length;
  let quietSince = Date.now();
  while (Date.now() - quietSince < 4000 && Date.now() - started < 300_000) {
    await page.waitForTimeout(500);
    if (process.env.CLICK) {
      const button = page.getByTestId("confirm-card").getByRole("button", { name: process.env.CLICK });
      if (await button.count()) {
        log.push(`(clicking "${process.env.CLICK}")`);
        await page.waitForTimeout(800); // visible in the recording
        await button.first().click();
      }
    }
    if (log.length !== last) {
      last = log.length;
      quietSince = Date.now();
    }
  }
}

for (const [i, prompt] of prompts.entries()) {
  const started = Date.now();
  log.push(`=== ${prompt}`);
  await input.fill(prompt);
  await input.press("Enter");
  await page.waitForTimeout(1000);
  await settle(started);
  log.push(`(${((Date.now() - started) / 1000).toFixed(1)} s)`);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/turn-${i + 1}.png` });
}

const transcript = await page.locator(".st-chat").innerText();
console.log(log.join("\n"));
console.log(`--- chat text ---\n${transcript.slice(-3000)}`);
await context.close(); // flushes the video
await browser.close();
