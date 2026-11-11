// Steps 1-2 of the customer gate: the live site in a fresh Edge, at desktop
// and phone sizes, and the Windows link a visitor would press.
//   node .github/gate/site.mjs <out dir>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const out = process.argv[2];
const SITE = process.env.GATE_SITE ?? "https://minecraft.westwardconsulting.ai";
const browser = await chromium.launch({ channel: "msedge" });

for (const [name, width, height] of [
  ["01-landing-1440", 1440, 900],
  ["01-landing-390", 390, 844],
]) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(SITE, { waitUntil: "networkidle" });
  await page.screenshot({ path: join(out, `${name}.png`) });
  await page.close();
}

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(SITE, { waitUntil: "networkidle" });
await page.getByRole("link", { name: /get the launcher/i }).first().click();
await page.waitForLoadState("networkidle");
await page.screenshot({ path: join(out, "02-download-1440.png") });
const link = page.getByRole("link", { name: /download for windows/i }).first();
const href = await link.getAttribute("href");
if (!href) throw new Error("no Windows download on the page");
writeFileSync(join(out, "download-url.txt"), new URL(href, page.url()).href);
console.log(`download page: ${page.url()} -> ${href}`);
await browser.close();
