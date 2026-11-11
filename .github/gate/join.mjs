// The join page in a real (visible) Edge, the way a friend gets it: the page,
// the Join world press, and the link handed to Windows.
//   node .github/gate/join.mjs <out dir>
import { join } from "node:path";
import { chromium } from "playwright";

const out = process.argv[2];
const SITE = process.env.GATE_SITE ?? "https://minecraft.westwardconsulting.ai";
const ADDRESS = process.env.GATE_JOIN_ADDRESS ?? "136.80.15.145:25565";
const link = `${SITE}/join?address=${encodeURIComponent(ADDRESS)}&name=${encodeURIComponent("Westward test world")}`;

for (const [name, width, height] of [
  ["join-01-page-390", 390, 844],
]) {
  const headless = await chromium.launch({ channel: "msedge" });
  const page = await headless.newPage({ viewport: { width, height } });
  await page.goto(link, { waitUntil: "networkidle" });
  await page.screenshot({ path: join(out, `${name}.png`) });
  await headless.close();
}

const browser = await chromium.launch({ channel: "msedge", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(link, { waitUntil: "networkidle" });
await page.screenshot({ path: join(out, "join-01-page-1440.png") });
await page.getByRole("button", { name: /join world/i }).click();
await page.waitForTimeout(4000);
await page.screenshot({ path: join(out, "join-02-pressed-1440.png") });
console.log("pressed Join world on", link);
// Give Windows time to hand the link to Anything before this script ends.
await page.waitForTimeout(10000);
await browser.close();
