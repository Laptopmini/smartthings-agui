// Drive the demo in headless Chromium and report what happened.
// Needs the dev server (SMARTTHINGS_DEV_TOKEN set) and the agent running.
//
//   node e2e/drive.mjs "first prompt" "second prompt" ...
//
// Environment:
//   ENABLE=lock,doorControl   tick these in Safety settings first
//   CLICK=Unlock              press this button whenever a confirm card shows
//   TILE="Label:Button"       after each prompt, press that button on the device
//                             tile with exactly that label (the first such tile)
//   PRESS="Name"              after each prompt, press the card button with
//                             exactly this name (e.g. a scene's button)
//   SHOTS=dir                 save a screenshot after each prompt
//   VIDEO=dir                 record a video of the session
//   BROWSER=chromium|firefox|webkit|chrome   default chromium ("chrome" is the
//                             installed Google Chrome, via Playwright's channel)
//   HEADED=1                  show the browser window
//   DEVICE="iPhone 15"        emulate a Playwright device (viewport, touch, UA)
//   FILL_TOKEN=…              type this token into the sign-in form (for a
//                             production build, which has no dev pre-fill)
import { chromium, devices, firefox, webkit } from "playwright";

const prompts = process.argv.slice(2);
const DEMO = process.env.DEMO_URL ?? "http://localhost:5173/";
const enable = (process.env.ENABLE ?? "").split(",").filter(Boolean);
const LABELS = { lock: "Locks", garageDoorControl: "Garage doors", doorControl: "Doors", valve: "Valves", securitySystem: "Security system" };

const kind = process.env.BROWSER ?? "chromium";
const engine = { chromium, chrome: chromium, firefox, webkit }[kind];
if (!engine) throw new Error(`Unknown BROWSER ${kind}`);
const browser = await engine.launch({
  headless: !process.env.HEADED,
  ...(kind === "chrome" ? { channel: "chrome" } : {}),
});
const device = process.env.DEVICE ? devices[process.env.DEVICE] : undefined;
if (process.env.DEVICE && !device) throw new Error(`Unknown DEVICE ${process.env.DEVICE}`);
const size = device?.viewport ?? { width: 900, height: 820 };
const context = await browser.newContext({
  ...(device ?? { viewport: size }),
  ...(process.env.VIDEO ? { recordVideo: { dir: process.env.VIDEO, size } } : {}),
});
const page = await context.newPage();
const log = [];
const NOISE = /Lit is in dev|React DevTools|Enterprise Intelligence|no renderer is registered/;
const IGNORED_TYPES = new Set(["debug", "timeStamp"]); // Firefox logs React dev timing as console.timeStamp
page.on("console", (m) => !IGNORED_TYPES.has(m.type()) && !NOISE.test(m.text()) && log.push(`console.${m.type()}: ${m.text().slice(0, 300)}`));
page.on("requestfailed", (r) => log.push(`FAILED ${r.method()} ${r.url()} ${r.failure()?.errorText}`));
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
page.on("response", async (r) => {
  const u = new URL(r.url());
  if (u.host !== "api.smartthings.com" && u.pathname !== "/run") return;
  let line = `${r.request().method()} ${u.host}${u.pathname} -> ${r.status()}`;
  // DEBUG=1: timestamps and the switch value each status read returned.
  if (process.env.DEBUG && u.host === "api.smartthings.com" && u.pathname.endsWith("/status")) {
    const body = await r.text().catch(() => "");
    line += ` @${at()} switch=${/"switch":\{"switch":\{"value":"(\w+)"/.exec(body)?.[1] ?? "-"}`;
  } else if (process.env.DEBUG) line += ` @${at()}`;
  log.push(line);
});

await page.goto(DEMO);
// A production build has no dev pre-fill: type the token, as a person would.
if (process.env.FILL_TOKEN) await page.getByLabel("SmartThings personal access token").fill(process.env.FILL_TOKEN);
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
      // Only an enabled button: after a press, the card disables its buttons
      // while the command runs, and pressing again would wait forever.
      if ((await button.count()) && (await button.first().isEnabled())) {
        log.push(`(clicking "${process.env.CLICK}")`);
        // Long enough to read the card in a recording; short otherwise.
        await page.waitForTimeout(process.env.VIDEO ? 2000 : 800);
        await button.first().click();
      }
    }
    if (log.length !== last) {
      last = log.length;
      quietSince = Date.now();
    }
  }
}

// DEBUG=1 and TILE set: log every change to that tile's text, with timestamps.
if (process.env.DEBUG && process.env.TILE) {
  const label = process.env.TILE.split(":")[0];
  let last = "";
  const timer = setInterval(async () => {
    const tiles = page.locator(`[data-testid="device-tile"][data-label="${label}"]`);
    const texts = await tiles.allInnerTexts().catch(() => []);
    const now = texts.map((t) => t.replace(/\s+/g, " ")).join(" || ");
    if (now !== last) {
      last = now;
      log.push(`(watch @${at()}: ${texts.length} tile(s): ${now})`);
    }
  }, 200);
  page.on("close", () => clearInterval(timer));
}

for (const [i, prompt] of prompts.entries()) {
  const started = Date.now();
  log.push(`=== ${prompt}`);
  await input.fill(prompt);
  await input.press("Enter");
  await page.waitForTimeout(1000);
  await settle(started);
  log.push(`(${((Date.now() - started) / 1000).toFixed(1)} s)`);
  if (process.env.TILE) {
    const [label, name] = process.env.TILE.split(":");
    const button = page.locator(`[data-testid="device-tile"][data-label="${label}"]`).first().getByRole("button", { name });
    if (await button.count()) {
      log.push(`(tile "${label}": clicking "${name}")`);
      await button.click();
      if (process.env.DEBUG) {
        for (const ms of [300, 1000, 3000]) {
          await page.waitForTimeout(ms);
          const tile = page.locator(`[data-testid="device-tile"][data-label="${label}"]`).first();
          log.push(`(tile after click @${at()}: ${(await tile.innerText()).replace(/\s+/g, " ")})`);
        }
      }
      await settle(Date.now());
    }
  }
  if (process.env.PRESS) {
    const button = page.locator('[data-testid="surface"]').getByRole("button", { name: process.env.PRESS, exact: true });
    if (await button.count()) {
      log.push(`(card button: pressing "${process.env.PRESS}")`);
      await button.first().click();
      await settle(Date.now());
    }
  }
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/turn-${i + 1}.png` });
}

const transcript = await page.locator(".st-chat").innerText();
log.unshift(`browser: ${kind} ${browser.version()}${process.env.HEADED ? " (headed)" : ""}${device ? `, device ${process.env.DEVICE} ${size.width}x${size.height}` : ""}`);
console.log(log.join("\n"));
console.log(`--- chat text ---\n${transcript.slice(-3000)}`);
await context.close(); // flushes the video
await browser.close();
