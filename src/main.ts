import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { parseJoin, type Join } from "./join";
// Imported rather than hard-coded as a path: the bundler has to see it, or the
// mark is missing in the built app and present only in dev.
import markUrl from "./mark.svg?url";

/**
 * The launcher window.
 *
 * An icon rail on the left, one page at a time on the right. Four pages, in the
 * order a player needs them: Play (get the game running), Servers (where to
 * play), Build (type a mod), Settings. Every page has one obvious next action,
 * and every status on it is read from the machine rather than guessed.
 */

// --- shapes the Rust side hands us ----------------------------------------

interface Account {
  name: string;
  uuid: string;
  selected: boolean;
}

interface GameStatus {
  binary: string | null;
  installed: string[];
  selected: string | null;
  accounts: Account[];
  owner: boolean;
}

interface Overview {
  site: string;
  paired: boolean;
  email: string | null;
  name: string | null;
  plan: string | null;
  game: GameStatus;
  prepared: boolean;
}

interface Server {
  id: string;
  name: string;
  address: string;
  engine: string;
  kind: "yours" | "public";
  up: boolean;
  players: number;
  /** Who is on it right now, by name. */
  playing?: string[];
  mods: number;
}

interface ModView {
  id: string;
  name: string;
  summary: string;
  enabled: boolean;
  rules: number;
}

interface BuildOutcome {
  note: string;
  seconds: number;
  next_ideas: string[];
  name: string | null;
  summary: string | null;
}

interface FriendWorld {
  id: string;
  name: string;
  address: string;
  up: boolean;
  players: number;
}

interface Friend {
  id: string;
  account_id: string;
  name: string;
  email: string;
  mc_name: string | null;
  status: "pending" | "accepted";
  waiting_on_them: boolean;
  /** The name of the world they are standing in, if we can see it. */
  playing_in: string | null;
  worlds: FriendWorld[];
}

interface FriendsBody {
  friends: Friend[];
  me: { mc_name: string | null; email: string } | null;
}

type PageId = "play" | "servers" | "friends" | "build" | "settings";

// --- state ----------------------------------------------------------------

let view: Overview | null = null;
let servers: Server[] = [];
let mods: ModView[] = [];
let friends: Friend[] = [];
let myMcName: string | null = null;
let page: PageId = "play";
let chosenWorld: string | null = null;
/** The mod idea saved on their account, and whatever they typed over it. */
let myIdea: string | null = null;
let localPrompt: string | null = null;
/** Showing the firewall guide while the game starts, until Windows has an answer. */
let firewallGuide = false;
let effort = "standard";
/**
 * What is running right now, by job name.
 *
 * This used to be one string, which meant one job at a time for the whole
 * window: while the engine downloaded, every other button silently did
 * nothing — including Connect with Google, which looked broken rather than
 * busy. Jobs are independent, so the state is too.
 */
const running = new Set<string>();
const progress = new Map<string, { label: string; pct: number }>();
let lastBuild: BuildOutcome | null = null;
let buildStartedAt = 0;
let deviceCode: { url: string; code: string } | null = null;
/**
 * Back on the setup page. "Set it up" runs the engine, then Microsoft; Back
 * stops that chain where it is. The engine download keeps going quietly (it is
 * needed anyway and stopping it half way would leave a broken copy), but the
 * Microsoft page no longer opens by itself. A sign-in waiting for its code is
 * stopped outright.
 */
let setupHeld = false;
let signInCancelled = false;
/** A world a Join button on the site sent us to, until the game opens on it. */
let joining: Join | null = null;
/** What stopped the last job, kept on screen while a join waits on it. */
let lastProblem: string | null = null;
/** Refreshes the live world while a page that shows it is open. */
let watching: number | null = null;

const STARTERS = [
  "Make it rain chickens that drop diamonds",
  "Give me a grappling hook that pulls me where I aim",
  "A boss fight in the sky with a health bar and real loot",
];

const EFFORTS = [
  ["quick", "Fast"],
  ["standard", "Normal"],
  ["deep", "Deep"],
  ["epic", "Epic"],
] as const;

// --- helpers --------------------------------------------------------------

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function esc(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function toast(text: string, kind: "" | "good" | "bad" = ""): void {
  const node = document.createElement("div");
  node.className = `toast ${kind}`.trim();
  node.textContent = text;
  el("toasts").append(node);
  window.setTimeout(() => node.remove(), 5200);
}

const isBusy = (key: string): boolean => running.has(key);
const anyBusy = (): boolean => running.size > 0;

/**
 * Runs one job. Other jobs carry on; pressing the same button twice does not
 * start it twice. A job that is already running says so rather than ignoring
 * the press, because a button that does nothing reads as a broken button.
 */
async function act<T>(key: string, label: string, job: () => Promise<T>): Promise<T | null> {
  if (running.has(key)) {
    toast("That one is already going.");
    return null;
  }
  running.add(key);
  render();
  try {
    return await job();
  } catch (error) {
    if (key === "microsoft_sign_in" && signInCancelled) {
      // They pressed Back. Nothing went wrong, so say nothing.
      signInCancelled = false;
      return null;
    }
    lastProblem = `${label}: ${String(error).replace(/^Error:\s*/, "")}`;
    toast(lastProblem, "bad");
    return null;
  } finally {
    running.delete(key);
    progress.delete(key);
    render();
  }
}

const ICONS: Record<string, string> = {
  play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.52.85l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 8 5.5Z"/></svg>`,
  servers: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><circle cx="7" cy="7" r="1" fill="currentColor"/><circle cx="7" cy="17" r="1" fill="currentColor"/></svg>`,
  build: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3l1.9 4.6 4.6 1.9-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3Z"/><path d="M18 15l.9 2.1 2.1.9-2.1.9L18 21l-.9-2.1-2.1-.9 2.1-.9L18 15Z"/></svg>`,
  friends: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><path d="M16.5 5.6a3.2 3.2 0 0 1 0 6.3M17 14.8c2.4.4 4 2.3 4 4.7"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.2M12 18.8V21M4.2 7.5l1.9 1.1M17.9 15.4l1.9 1.1M4.2 16.5l1.9-1.1M17.9 8.6l1.9-1.1"/></svg>`,
  // The mark itself, not a line-drawn stand-in for it.
  mark: `<img src="${markUrl}" alt="Anything in Minecraft" width="26" height="26" />`,
};

// --- rail -----------------------------------------------------------------

const PAGES: Array<{ id: PageId; label: string }> = [
  { id: "play", label: "Play" },
  { id: "servers", label: "Worlds" },
  { id: "friends", label: "Friends" },
  { id: "build", label: "Build" },
];

function renderRail(): void {
  el("mark").innerHTML = ICONS["mark"]!;

  el("rail-pages").innerHTML = PAGES.map(
    (entry) => `
      <button class="rail-btn" data-page="${entry.id}" data-tip="${entry.label}"
        aria-current="${page === entry.id ? "page" : "false"}" aria-label="${entry.label}">
        ${ICONS[entry.id]}
        ${entry.id === "play" && !ready() ? '<span class="dot"></span>' : ""}
      </button>`,
  ).join("");

  const initial = (view?.name ?? view?.email ?? "").trim().slice(0, 1).toUpperCase();
  const signedIn = Boolean(view?.paired && initial);
  el("rail-foot").innerHTML = `
    <button class="rail-btn" data-page="settings"
      data-tip="${esc(signedIn ? (view?.email ?? "Settings") : "Settings · not connected")}"
      aria-current="${page === "settings" ? "page" : "false"}"
      aria-label="${signedIn ? `Settings, signed in as ${esc(view?.email ?? "")}` : "Settings"}">
      ${signedIn ? `<span class="avatar">${initial}</span>` : ICONS["settings"]}
      ${view && !view.paired ? '<span class="dot"></span>' : ""}
    </button>`;

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-page]")) {
    button.onclick = () => {
      page = button.dataset["page"] as PageId;
      render();
      el("page").focus();
    };
  }
}

/** Everything needed before Play does something useful. */
function ready(): boolean {
  return Boolean(view?.game.binary && view.game.installed.length && view.game.owner && view.prepared);
}

// --- pages ----------------------------------------------------------------

/**
 * "Play your mod": the idea they typed on the website (or here) is built into
 * the single-player world, and the game opens in it. One button.
 */
/**
 * Windows asks about the firewall the first time each game version starts.
 * Shown while that question can be on screen; it goes away by itself once
 * Windows has the answer, or after a few minutes if it never asked.
 */
function firewallCard(): string {
  if (!firewallGuide) return "";
  return `<div class="section guide" role="status">
    <div class="section-head"><h2>Windows may ask one question</h2></div>
    <p>A box called <b>Windows Security</b> may pop up about Horizon. Press <b>Cancel</b>. Your game works the same, and you will not need a grown-up&rsquo;s password.</p>
    <div class="mock" aria-hidden="true">
      <div class="mock-title">Windows Security</div>
      <div class="mock-body">Windows Defender Firewall has blocked some features of this app</div>
      <div class="mock-buttons"><span class="mock-btn">Allow access</span><span class="mock-btn mock-pick">Cancel</span><span class="mock-arrow">&larr; press this</span></div>
    </div>
    <p class="dim" style="margin-top:8px">This goes away by itself when you have answered.</p>
  </div>`;
}

/** Starts watching for Windows' firewall answer after the game is launched. */
async function watchFirewall(): Promise<void> {
  if (await invoke<boolean>("firewall_answered").catch(() => true)) return;
  firewallGuide = true;
  render();
  const until = Date.now() + 3 * 60_000;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (await invoke<boolean>("firewall_answered").catch(() => true)) {
      toast("Thanks, that's done", "good");
      break;
    }
  }
  firewallGuide = false;
  render();
}

function yourModCard(): string {
  if (!view?.paired) {
    return `<div class="section">
      <div class="section-head"><h2>Your mod</h2></div>
      <p class="dim">Connect your Anything account once, and the mod you typed on the website is built into your world.</p>
      <div style="margin-top:12px"><button class="btn" data-do="pair" ${isBusy("pair") ? "disabled" : ""}>Connect your account</button></div>
    </div>`;
  }
  const busy = isBusy("play_mod");
  const value = localPrompt ?? myIdea ?? "";
  return `<div class="section">
    <div class="section-head"><h2>Your mod</h2></div>
    <div class="inline-form">
      <input id="localPrompt" class="input" maxlength="500" placeholder="Type a mod, like: make pigs fly" value="${esc(value)}" ${busy ? "disabled" : ""}>
      <button class="btn btn-play" data-do="play_mod" ${busy ? "disabled" : ""}>${busy ? "Building..." : "Play your mod"}</button>
    </div>
    <p class="dim" style="margin-top:8px">${
      busy
        ? "Building it now. This takes a few minutes; the game opens in your world when it is ready."
        : "It builds the mod into your world &ldquo;Anything&rdquo; and opens the game there."
    }</p>
  </div>`;
}

function renderPlay(): string {
  if (!view) return skeleton();
  const game = view.game;
  const who = game.accounts.find((a) => a.selected) ?? game.accounts[0];

  const steps: Array<{ done: boolean; title: string; body: string; action?: string; key?: string }> = [
    {
      done: Boolean(game.binary && game.installed.length),
      title: "Get the engine",
      body: "The open-source version of Minecraft 26.3 that runs your mods. One quick download, nothing else on your PC changes.",
      action: "Install it",
      key: "setup_engine",
    },
    {
      done: game.owner && view.prepared,
      title: "Sign in with Microsoft",
      body: "The account that owns Minecraft: Java Edition (a parent&rsquo;s is fine). We never see your password — Microsoft shows you a code to type. It then fetches the game files for you.",
      action: "Sign in",
      key: "microsoft_sign_in",
    },
  ];

  // Only shown when signing in worked but the files did not arrive — normally
  // the sign-in step fetches them itself and this never appears.
  if (game.owner && !view.prepared) {
    steps.push({
      done: false,
      title: "Finish fetching the game files",
      body: "The sign-in worked but the download did not finish. It picks up where it left off.",
      action: "Finish it",
      key: "prepare_game",
    });
  }

  const banner = joining ? joinBanner(joining) : "";

  if (ready()) {
    const target = servers.find((s) => s.id === chosenWorld);
    return `${banner}
      <div class="page-head">
        <div>
          <h1>Ready to play</h1>
          <p class="dim">Minecraft 26.3 on Horizon${who ? `, as ${esc(who.name)}` : ""}</p>
        </div>
      </div>

      ${firewallCard()}
      ${yourModCard()}

      <div class="instance">
        <div class="tile" aria-hidden="true"></div>
        <div>
          <h2>${esc(target?.name ?? "Your own world")}</h2>
          <div class="instance-meta">
            <span class="meta-item mono">${esc(target?.address ?? "single player")}</span>
            <span class="meta-item mono">${esc(game.selected ?? game.installed[0] ?? "26.3")}</span>
            ${target ? `<span class="meta-item mono">${target.mods} mods</span>` : ""}
          </div>
        </div>
        <div class="instance-play">
          <button class="btn btn-play" data-do="play" ${isBusy("play") ? "disabled" : ""}>
            ${isBusy("play") ? "Starting..." : "Play"}
          </button>
        </div>
      </div>

      ${
        servers.length
          ? `<div class="section">
               <div class="section-head"><h2>Play somewhere else</h2></div>
               <div class="play-target">${serverRows(true)}</div>
             </div>`
          : ""
      }`;
  }

  // Microsoft sign-in runs through the engine's own CLI, so the engine has to
  // land first. One button does both, in that order, and is the only green
  // one while it is on screen.
  const waiting = steps.filter((step) => !step.done && step.key);
  const canRunTogether = waiting.filter((step) => !isBusy(step.key!)).length > 1;
  const left = waiting.length;

  return `
    ${setupStep() > 0 ? `<button class="btn btn-sm btn-back" data-do="setup-back"><span aria-hidden="true">\u2039</span> Back</button>` : ""}
    <div class="page-head">
      <div>
        <h1>${left === 1 ? "One step to playing" : `${left} steps to playing`}</h1>
        <p class="dim">
          ${
            joining && !isBusy("play")
              ? "Do these once, then it joins on its own."
              : canRunTogether
              ? "Press Set it up. It does both, in order."
              : deviceCode
                ? "Type the code below on the Microsoft page."
                : waiting.some((step) => !isBusy(step.key!))
                  ? "Press the green button."
                  : "Working on it. Nothing to press."
          }
        </p>
      </div>
      ${
        canRunTogether && !joining
          ? `<button class="btn btn-primary" data-do="start-all">Set it up</button>`
          : ""
      }
    </div>
    ${banner}
    ${progressBar(["play"])}
    ${deviceCode ? codeBox() : ""}
    <div class="steps">
      ${steps
        .map(
          (step, index) => `
        <div class="step${step.done ? " done" : ""}${isBusy(step.key ?? "") ? " working" : ""}">
          <div class="step-top">
            <span class="step-num">${step.done ? "\u2713" : index + 1}</span>
            <div>
              <h2>${step.title}</h2>
              <p class="dim">${step.body}</p>
            </div>
            <div class="step-action">
              ${
                step.done
                  ? `<span class="pill pill-on">done</span>`
                  : `<button class="btn${canRunTogether ? "" : " btn-primary"}" data-do="${step.key}" ${isBusy(step.key!) ? "disabled" : ""}>
                       ${isBusy(step.key!) ? "Working..." : step.action}
                     </button>`
              }
            </div>
          </div>
          ${step.key ? progressBar([step.key]) : ""}
        </div>`,
        )
        .join("")}
    </div>`;
}

/**
 * Where the setup is, as screens: 0 the steps with Set it up, 1 the engine
 * installing on its way to Microsoft, 2 Microsoft waiting for its code. Every
 * screen after the first has a Back.
 */
function setupStep(): 0 | 1 | 2 {
  if (isBusy("microsoft_sign_in") && !isBusy("prepare_game")) return 2;
  if (isBusy("setup_engine") && !setupHeld) return 1;
  return 0;
}

const BUSY_LABEL: Record<string, string> = {
  setup_engine: "Installing the engine",
  microsoft_sign_in: "Waiting for the code. It carries on by itself once it is in.",
  prepare_game: "Fetching the game files",
  play: "Starting the game",
  build: "Building your mod",
};

/** Every job that is running, with whatever it last said about itself. */
function currentProgress(): Array<{ key: string; label: string; pct: number }> {
  const shown: Array<{ key: string; label: string; pct: number }> = [];
  for (const key of running) {
    const live = progress.get(key);
    if (live) shown.push({ key, ...live });
    else if (BUSY_LABEL[key]) shown.push({ key, label: BUSY_LABEL[key]!, pct: 0 });
  }
  return shown;
}

/** A bar per running job, so two installs at once read as two things. */
function progressBar(only?: string[]): string {
  const shown = currentProgress().filter((job) => !only || only.includes(job.key));
  if (shown.length === 0) return "";
  return shown
    .map(
      (job) => `
    <div class="progress" role="status" data-job="${esc(job.key)}">
      <span class="spinner" aria-hidden="true"></span>
      <span>${esc(job.label)}</span>
      ${job.pct > 0 && job.pct < 100 ? `<span class="mono dim">${job.pct}%</span>` : ""}
      ${job.pct > 0 && job.pct < 100 ? `<span class="meter"><i style="transform:scaleX(${job.pct / 100})"></i></span>` : ""}
    </div>`,
    )
    .join("");
}

function joinBanner(join: Join): string {
  return `
    <div class="code-box" role="status">
      <p class="dim">Joining <strong>${esc(join.name)}</strong></p>
      <div class="mono faint">${esc(join.address)}</div>
      ${
        isBusy("play") || isBusy("setup_engine") || isBusy("microsoft_sign_in")
          ? ""
          : `${lastProblem ? `<p class="dim">Stopped: ${esc(lastProblem)}. Check the internet, then press Join now.</p>` : ""}
             <button class="btn btn-sm btn-primary" data-do="join-link">Join now</button>`
      }
    </div>`;
}

/**
 * A Join link from the site: get whatever is missing, then join. The only
 * stop is Microsoft's code if nobody has signed in yet, and it carries on by
 * itself once they have.
 */
async function joinFromLink(join: Join): Promise<void> {
  joining = join;
  lastProblem = null;
  page = "play";
  render();
  if (!view) await refresh();
  setupHeld = false;
  if (!view?.game.binary || !view.game.installed.length) await installEngine();
  if (!view?.game.binary || setupHeld) return;
  if (!view.game.owner || !view.prepared) await onMicrosoft();
  if (!ready()) return;
  const done = await act("play", "the game would not start", async () => {
    await invoke("play", { server: join.address, world: null });
    toast(`Joining ${join.name}`, "good");
    void watchFirewall();
    return true;
  });
  if (done) joining = null;
  render();
}

async function handleLinks(urls: string[] | null | undefined): Promise<void> {
  const join = (urls ?? []).map(parseJoin).find((found): found is Join => found !== null);
  if (join) await joinFromLink(join);
}

function codeBox(): string {
  return `
    <div class="code-box">
      <p class="dim">Microsoft is waiting. Type this code on the page that just opened in your browser:</p>
      <div class="code mono">${esc(deviceCode!.code)}</div>
      <button class="btn btn-sm" data-do="open-ms">Open the page again</button>
      <p class="dim">Account owner not here? Press Back. The engine stays installed, and you can sign in later.</p>
    </div>`;
}

function serverRows(forPlay = false): string {
  if (servers.length === 0) {
    return `<div class="empty"><p class="dim">No worlds yet. Get one from the website, or press Play for your own.</p>
      <button class="btn" data-do="open-site">Get a hosted world</button></div>`;
  }
  return `<div class="rows">${servers
    .map(
      (server) => `
      <div class="row-name mod" data-world="${esc(server.id)}">
        <span class="status-dot${server.up ? " up" : ""}" aria-hidden="true"></span>
        <div style="min-width:0">
          <div><strong>${esc(server.name)}</strong></div>
          <div class="mono faint">${esc(server.address)}</div>
        </div>
        <span class="row-stat mono dim">${server.mods} mods</span>
        <span class="row-stat mono dim">${server.up ? `${server.players} playing` : "offline"}</span>
        <button class="btn btn-sm" data-do="${forPlay ? "join" : "pick"}" data-address="${esc(server.address)}" data-id="${esc(server.id)}" ${forPlay && isBusy("play") ? "disabled" : ""}>
          ${forPlay ? "Join" : "Build here"}
        </button>
      </div>`,
    )
    .join("")}</div>`;
}

function renderServers(): string {
  if (!view) return skeleton();
  return `
    <div class="page-head">
      <div>
        <h1>Servers</h1>
        <p class="dim">Your worlds, and the public ones. One click to join.</p>
      </div>
      <button class="btn btn-sm" data-do="refresh" ${isBusy("refresh") ? "disabled" : ""}>Refresh</button>
    </div>
    ${serverRows(true)}`;
}

function renderBuild(): string {
  if (!view) return skeleton();
  if (!view.paired) {
    return `
      <div class="page-head"><div><h1>Build a mod</h1>
        <p class="dim">Connect your account first — it holds your worlds and what you build.</p></div></div>
      <button class="btn btn-primary" data-do="pair">Connect with Google</button>`;
  }
  const world = servers.find((s) => s.id === chosenWorld);
  if (!world) {
    return `
      <div class="page-head"><div><h1>Build a mod</h1>
        <p class="dim">Pick the world it should land in.</p></div></div>
      ${serverRows(false)}`;
  }

  const names = world.playing ?? [];
  const who = world.up
    ? names.length
      ? `${names.length} playing — ${names.map(esc).join(", ")}`
      : "nobody playing right now"
    : "offline";

  return `
    <div class="page-head">
      <div>
        <h1>Build a mod</h1>
        <p class="dim">
          It lands in <strong>${esc(world.name)}</strong> live, while you play. Nothing restarts.
        </p>
        <p class="mono dim" style="margin-top:6px">
          <span class="status-dot${world.up ? " up" : ""}"></span> ${esc(world.address)} · ${esc(who)} · ${world.mods} mods
        </p>
      </div>
      <button class="btn btn-sm" data-do="pick-other">Change world</button>
    </div>

    <div class="composer">
      <textarea class="input prompt" id="prompt" rows="3"
        placeholder="What should happen in ${esc(world.name)}?" ${isBusy("build") ? "disabled" : ""}></textarea>
      <div class="effort-row">
        <div class="segmented" role="group" aria-label="How hard to think">
          ${EFFORTS.map(
            ([id, label]) =>
              `<button type="button" data-effort="${id}" aria-pressed="${effort === id}">${label}</button>`,
          ).join("")}
        </div>
        <button class="btn btn-primary" data-do="build" ${isBusy("build") ? "disabled" : ""}>
          ${isBusy("build") ? "Building..." : "Build it"}
        </button>
      </div>
    </div>

    ${isBusy("build") ? buildingCard(world) : ""}

    ${
      !isBusy("build") && lastBuild
        ? `<div class="result">
             <div class="result-head">
               <span class="pill pill-new">live in ${lastBuild.seconds.toFixed(1)}s</span>
               <span class="label">in ${esc(world.name)}</span>
             </div>
             ${lastBuild.name ? `<h2>${esc(lastBuild.name)}</h2>` : ""}
             <p>${esc(lastBuild.note)}</p>
             <p class="hint dim">It is in the world now — press Play, or if you are already in,
               it is already there. Look for it under "Running in this world" below.</p>
             ${lastBuild.next_ideas.length ? `<p class="hint dim">Try next: ${esc(lastBuild.next_ideas[0] ?? "")}</p>` : ""}
           </div>`
        : ""
    }

    ${
      !isBusy("build") && !lastBuild
        ? `<div class="starters">
             <span class="field-label">Or start with one of these</span>
             ${STARTERS.map(
               (starter, index) =>
                 `<button class="btn${index === 0 ? " btn-ghost" : ""}" data-starter="${esc(starter)}">${esc(starter)}</button>`,
             ).join("")}
           </div>`
        : ""
    }

    <div class="section">
      <div class="section-head"><h2>Running in this world</h2></div>
      ${
        mods.length === 0
          ? `<div class="empty"><p class="dim">Nothing yet. Build the first one and it shows up here.</p></div>`
          : `<div class="rows">${mods
              .map(
                (mod) => `
          <div class="mod">
            <div style="min-width:0">
              <div><strong>${esc(mod.name)}</strong></div>
              <div class="dim">${esc(mod.summary)}</div>
            </div>
            <span class="row-stat mono dim">${mod.rules} rules</span>
            <span class="pill${mod.enabled ? " on" : ""}">${mod.enabled ? "on" : "off"}</span>
          </div>`,
              )
              .join("")}</div>`
      }
    </div>`;
}

/**
 * What is happening while a mod is being built.
 *
 * A spinner and the word "Building..." told you nothing: not how far along it
 * was, not how long it usually takes, not where the thing would end up. The
 * stages are honest — they are what the warden does, in order — and the clock
 * is real.
 */
const BUILD_STAGES = [
  ["Reading what you asked for", 3],
  ["Designing it — rules, items, mobs", 12],
  ["Looking things up where it matters", 8],
  ["Writing it into the world", 10],
  ["Loading it in, live", 6],
] as const;

function buildingCard(world: Server): string {
  const elapsed = (Date.now() - buildStartedAt) / 1000;
  let passed = 0;
  let current = BUILD_STAGES.length - 1;
  for (let index = 0; index < BUILD_STAGES.length; index++) {
    passed += BUILD_STAGES[index]![1];
    if (elapsed < passed) {
      current = index;
      break;
    }
  }

  return `
    <div class="building" role="status" aria-live="polite" data-live="build">
      <div class="building-head">
        <span class="spinner" aria-hidden="true"></span>
        <strong>Building your mod</strong>
        <span class="mono dim">${elapsed.toFixed(0)}s</span>
      </div>
      <ol class="stages">
        ${BUILD_STAGES.map(
          ([label], index) => `
          <li class="${index < current ? "done" : index === current ? "now" : ""}">
            <span class="stage-mark" aria-hidden="true">${index < current ? "\u2713" : index === current ? "\u00b7" : ""}</span>
            ${esc(label)}
          </li>`,
        ).join("")}
      </ol>
      <p class="dim">
        It lands in <strong>${esc(world.name)}</strong> on its own — nobody is kicked and nothing
        restarts. You can leave this page; it keeps going.
      </p>
    </div>`;
}

function renderFriends(): string {
  if (!view) return skeleton();
  if (!view.paired) {
    return `
      <div class="page-head"><div><h1>Friends</h1>
        <p class="dim">Connect your account and your friends list comes with it.</p></div></div>
      <button class="btn btn-primary" data-do="pair">Connect with Google</button>`;
  }

  const waiting = friends.filter((f) => f.status === "pending" && !f.waiting_on_them);
  const crew = friends.filter((f) => f.status === "accepted");
  const asked = friends.filter((f) => f.status === "pending" && f.waiting_on_them);

  const row = (friend: Friend, actions: string) => `
    <div class="mod">
      <span class="status-dot${friend.playing_in ? " up" : ""}" aria-hidden="true"></span>
      <div style="min-width:0">
        <div><strong>${esc(friend.mc_name ?? friend.name)}</strong></div>
        <div class="mono faint">${esc(friend.playing_in ? `in ${friend.playing_in}` : friend.email)}</div>
      </div>
      <div class="row-actions">${actions}</div>
    </div>`;

  return `
    <div class="page-head">
      <div>
        <h1>Friends</h1>
        <p class="dim">Who is playing, and which world they are standing in.</p>
      </div>
      <button class="btn btn-sm" data-do="refresh-friends" ${isBusy("refresh-friends") ? "disabled" : ""}>Refresh</button>
    </div>

    <div class="settings">
    <div class="setting">
      <div class="setting-body">
        <h2>Your name in game</h2>
        <p class="dim">How friends see where you are, and how friends-only worlds let you in.</p>
        <div class="inline-form">
          <input class="input mono" id="mc-name" placeholder="Steve" value="${esc(myMcName ?? "")}" />
          <button class="btn btn-sm" data-do="save-mc-name">Save</button>
        </div>
      </div>
    </div>

    <div class="setting">
      <div class="setting-body">
        <h2>Add a friend</h2>
        <p class="dim">The email they sign in with. They have to have signed in here once.</p>
        <div class="inline-form">
          <input class="input" id="friend-email" type="email" placeholder="their@email.com" />
          <button class="btn btn-sm btn-primary" data-do="add-friend" ${isBusy("add-friend") ? "disabled" : ""}>Ask them</button>
        </div>
      </div>
    </div>
    </div>

    ${
      waiting.length
        ? `<div class="section">
             <div class="section-head"><h2>${waiting.length} waiting on you</h2></div>
             <div class="rows">${waiting
               .map((friend) =>
                 row(
                   friend,
                   `<button class="btn btn-sm btn-primary" data-do="accept-friend" data-id="${esc(friend.id)}">Accept</button>
                    <button class="btn btn-sm" data-do="remove-friend" data-id="${esc(friend.id)}">No</button>`,
                 ),
               )
               .join("")}</div>
           </div>`
        : ""
    }

    <div class="section">
      <div class="section-head"><h2>${crew.length ? `${crew.length} friends` : "Friends"}</h2></div>
      ${
        crew.length === 0
          ? `<div class="empty"><p class="dim">Nobody yet. Add someone above and their worlds show up here, with a Join on each one.</p></div>`
          : `<div class="rows">${crew
              .map((friend) => {
                const world = friend.worlds.find((w) => w.up) ?? friend.worlds[0];
                return row(
                  friend,
                  `${
                    world
                      ? `<span class="row-stat mono dim">${esc(world.name)}</span>
                         <button class="btn btn-sm btn-primary" data-do="join" data-address="${esc(world.address)}" data-id="${esc(world.id)}" ${isBusy("play") ? "disabled" : ""}>Join</button>`
                      : `<span class="row-stat mono faint">no shared worlds</span>`
                  }
                   <button class="btn btn-sm" data-do="remove-friend" data-id="${esc(friend.id)}">Remove</button>`,
                );
              })
              .join("")}</div>`
      }
    </div>

    ${
      asked.length
        ? `<div class="section">
             <div class="section-head"><h2>Asked, not answered</h2></div>
             <div class="rows">${asked
               .map((friend) =>
                 row(
                   friend,
                   `<span class="pill">waiting</span>
                    <button class="btn btn-sm" data-do="remove-friend" data-id="${esc(friend.id)}">Cancel</button>`,
                 ),
               )
               .join("")}</div>
           </div>`
        : ""
    }`;
}

function renderSettings(): string {
  if (!view) return skeleton();
  const game = view.game;
  const theme = localStorage.getItem("theme") ?? "system";

  return `
    <div class="page-head"><div><h1>Settings</h1><p class="dim">Your account, the game, and how this looks.</p></div></div>

    <div class="settings">
      <div class="setting">
        <div class="setting-body">
          <h2>Anything account</h2>
          <p class="dim">${
            view.paired
              ? `${esc(view.email ?? "")}${view.plan ? ` · ${esc(view.plan)} plan` : ""}`
              : "Not connected. This is what holds your worlds and your mods."
          }</p>
        </div>
        ${
          view.paired
            ? `<button class="btn" data-do="unpair">Sign out</button>`
            : `<button class="btn btn-primary" data-do="pair">Connect with Google</button>`
        }
      </div>

      <div class="setting">
        <div class="setting-body">
          <h2>Minecraft account</h2>
          <p class="dim">${
            game.accounts.length
              ? game.accounts.map((a) => esc(a.name)).join(", ") + (game.owner ? "" : " — does not own Java Edition")
              : "None signed in."
          }</p>
        </div>
        ${
          game.accounts.length
            ? `<button class="btn" data-do="ms-out" data-who="${esc(game.accounts[0]!.name)}">Sign out</button>`
            : `<button class="btn btn-primary" data-do="microsoft_sign_in">Sign in</button>`
        }
      </div>

      <div class="setting">
        <div class="setting-body">
          <h2>Engine</h2>
          <p class="dim mono">${esc(game.binary ?? "not installed")}</p>
          ${game.installed.length ? `<p class="dim mono">${esc(game.installed.join(", "))}</p>` : ""}
        </div>
        ${
          game.binary
            ? `<span class="pill">found</span>`
            : `<button class="btn btn-primary" data-do="setup_engine">Install</button>`
        }
      </div>

      <div class="setting">
        <div class="setting-body">
          <h2>Point at your own Horizon</h2>
          <p class="dim">Only if you installed it yourself somewhere unusual.</p>
          <div class="inline-form">
            <input class="input mono" id="horizon-path" placeholder="path to horizon-launcher" />
            <button class="btn btn-sm" data-do="save-path">Use it</button>
          </div>
        </div>
      </div>

      <div class="setting">
        <div class="setting-body">
          <h2>Appearance</h2>
          <p class="dim">Follows your system unless you pick one.</p>
        </div>
        <div class="segmented" role="group" aria-label="Theme">
          ${["system", "light", "dark"]
            .map((id) => `<button type="button" data-theme="${id}" aria-pressed="${theme === id}">${id}</button>`)
            .join("")}
        </div>
      </div>

      <div class="setting">
        <div class="setting-body">
          <h2>The website</h2>
          <p class="dim mono">${esc(view.site)}</p>
        </div>
        <button class="btn" data-do="open-site">Open it</button>
      </div>
    </div>`;
}

function skeleton(): string {
  return `<div class="skeleton" aria-hidden="true"></div><div class="skeleton" aria-hidden="true"></div>`;
}

// --- render ---------------------------------------------------------------

/** While Play, Servers or Build is open, keep the world's state current. */
function watchWorld(): void {
  if (watching !== null) {
    window.clearInterval(watching);
    watching = null;
  }
  if (!view?.paired || page === "settings") return;
  watching = window.setInterval(() => {
    if (anyBusy()) return;
    void (async () => {
      // The friends page watches people, not worlds.
      if (page === "friends") {
        await loadFriends();
        return;
      }
      await loadServers();
      if (page === "build" && chosenWorld) await loadMods();
      else render();
    })();
  }, 12_000);
}

/**
 * Redrawing the page throws the DOM away and builds it again, which is fine
 * for a button and awful for anything the person is using: a prompt half
 * typed vanishes, the caret jumps to the start, the page scrolls to the top.
 * Progress events arrive several times a second, so that read as the whole
 * window glitching. Carry the living bits across.
 */
function render(): void {
  const page_ = el("page");
  const active = document.activeElement as HTMLElement | null;
  const focusedId = active && page_.contains(active) ? active.id : null;
  const scroll = page_.scrollTop;
  const text = el<HTMLTextAreaElement>("prompt");
  const kept = text
    ? { value: text.value, start: text.selectionStart, end: text.selectionEnd }
    : null;
  const inputs = new Map<string, string>();
  for (const input of page_.querySelectorAll<HTMLInputElement>("input[id]")) {
    if (input.value) inputs.set(input.id, input.value);
  }

  renderRail();
  const body =
    page === "play"
      ? renderPlay()
      : page === "servers"
        ? renderServers()
        : page === "friends"
          ? renderFriends()
          : page === "build"
            ? renderBuild()
            : renderSettings();
  page_.innerHTML = `<div class="page-inner">${body}</div>`;
  wire();

  const again = el<HTMLTextAreaElement>("prompt");
  if (again && kept) {
    again.value = kept.value;
    if (focusedId === "prompt") {
      again.focus();
      again.setSelectionRange(kept.start, kept.end);
    }
  }
  for (const [id, value] of inputs) {
    const input = el<HTMLInputElement>(id);
    // Settings fields are rendered with a value; do not undo a fresh one.
    if (input && !input.value) input.value = value;
  }
  if (focusedId && focusedId !== "prompt") el(focusedId)?.focus();
  page_.scrollTop = scroll;

  watchWorld();
  keepTicking();
}

/**
 * While something is running, redraw once a second so the clock and the
 * stages move even when no event arrives. Nothing running, nothing ticking.
 */
let ticker: number | null = null;
function keepTicking(): void {
  const wanted = anyBusy();
  if (wanted && ticker === null) {
    ticker = window.setInterval(() => {
      if (anyBusy()) render();
    }, 1000);
  } else if (!wanted && ticker !== null) {
    window.clearInterval(ticker);
    ticker = null;
  }
}

function wire(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-do]")) {
    button.onclick = () => void onAction(button);
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-effort]")) {
    button.onclick = () => {
      effort = button.dataset["effort"]!;
      render();
    };
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-starter]")) {
    button.onclick = () => {
      const box = el<HTMLTextAreaElement>("prompt");
      if (box) {
        box.value = button.dataset["starter"]!;
        box.focus();
      }
    };
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-theme]")) {
    button.onclick = () => {
      const pick = button.dataset["theme"]!;
      if (pick === "system") {
        delete document.documentElement.dataset["theme"];
        localStorage.removeItem("theme");
      } else {
        document.documentElement.dataset["theme"] = pick;
        localStorage.setItem("theme", pick);
      }
      render();
    };
  }
  const local = el<HTMLInputElement>("localPrompt");
  if (local) {
    local.oninput = () => {
      localPrompt = local.value;
    };
    local.onkeydown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const go = document.querySelector<HTMLButtonElement>('[data-do="play_mod"]');
        if (go) void onAction(go);
      }
    };
  }
  const box = el<HTMLTextAreaElement>("prompt");
  box?.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void onBuild();
    }
  });
}

async function onAction(button: HTMLButtonElement): Promise<void> {
  const what = button.dataset["do"]!;
  switch (what) {
    case "setup_engine":
      await installEngine();
      return;
    case "microsoft_sign_in":
      setupHeld = false;
      await onMicrosoft();
      return;
    case "join-link":
      if (joining) await joinFromLink(joining);
      return;
    case "start-all": {
      // In order: Microsoft sign-in needs the engine. Started together, the
      // sign-in failed on every new machine with "engine not installed".
      setupHeld = false;
      if (!view?.game.binary || !view.game.installed.length) await installEngine();
      if (setupHeld) return;
      if (!view?.game.owner || !view.prepared) await onMicrosoft();
      return;
    }
    case "setup-back": {
      setupHeld = true;
      joining = null;
      if (isBusy("microsoft_sign_in")) {
        signInCancelled = true;
        deviceCode = null;
        await invoke("cancel_sign_in").catch(() => undefined);
      }
      render();
      return;
    }
    case "prepare_game":
      await act("prepare_game", "could not fetch the game files", async () => {
        await invoke("prepare_game");
        toast("Game files ready", "good");
        await refresh();
      });
      return;
    case "play":
    case "join": {
      const address = button.dataset["address"] ?? null;
      const id = button.dataset["id"] ?? null;
      // Build should land where you are actually playing.
      if (id) {
        chosenWorld = id;
        localStorage.setItem("lastWorld", id);
      }
      await act("play", "the game would not start", async () => {
        await invoke("play", { server: address, world: address ? null : "Anything" });
        toast(address ? `Joining ${address}` : "Starting your world", "good");
        void watchFirewall();
      });
      if (id) await loadMods();
      return;
    }
    case "pick": {
      chosenWorld = button.dataset["id"] ?? null;
      page = "build";
      lastBuild = null;
      render();
      await loadMods();
      return;
    }
    case "pick-other":
      chosenWorld = null;
      lastBuild = null;
      render();
      return;
    case "refresh":
      await act("refresh", "could not reach the site", async () => {
        await loadServers();
      });
      return;
    case "refresh-friends":
      await act("refresh-friends", "could not reach the site", async () => {
        await loadFriends();
      });
      return;
    case "add-friend": {
      const box = el<HTMLInputElement>("friend-email");
      const email = box?.value.trim() ?? "";
      if (!email) return;
      await act("add-friend", "could not add them", async () => {
        await invoke("add_friend", { email });
        toast(`Asked ${email}`, "good");
        await loadFriends();
      });
      return;
    }
    case "accept-friend":
      await act("accept-friend", "could not accept that", async () => {
        await invoke("accept_friend", { id: button.dataset["id"] });
        toast("Added", "good");
        await loadFriends();
      });
      return;
    case "remove-friend":
      await act("remove-friend", "could not do that", async () => {
        await invoke("remove_friend", { id: button.dataset["id"] });
        await loadFriends();
      });
      return;
    case "save-mc-name": {
      const name = el<HTMLInputElement>("mc-name")?.value.trim() ?? "";
      await act("save-mc-name", "could not save that name", async () => {
        await invoke("set_mc_name", { name });
        myMcName = name || null;
        toast(name ? `Friends will see you as ${name}` : "Name cleared", "good");
        await loadFriends();
      });
      return;
    }
    case "build":
      await onBuild();
      return;
    case "play_mod": {
      const prompt = (el<HTMLInputElement>("localPrompt")?.value ?? "").trim() || myIdea || "";
      if (prompt.length < 3) {
        toast("Type what you want the mod to do first");
        return;
      }
      await act("play_mod", "that mod did not build", async () => {
        const out = await invoke<{ name: string; note: string }>("play_my_mod", { prompt });
        toast(`${out.name} is in your world. The game is opening.`, "good");
        void watchFirewall();
        myIdea = null;
        localPrompt = null;
      });
      return;
    }
    case "pair":
      await onPair();
      return;
    case "unpair":
      await invoke("sign_out");
      servers = [];
      mods = [];
      chosenWorld = null;
      await refresh();
      toast("Signed out");
      return;
    case "ms-out":
      await act("ms-out", "could not sign that account out", async () => {
        await invoke("microsoft_sign_out", { who: button.dataset["who"] });
        await refresh();
      });
      return;
    case "save-path": {
      const path = el<HTMLInputElement>("horizon-path")?.value.trim() ?? "";
      await invoke("set_horizon_path", { path });
      await refresh();
      toast(path ? "Using that copy of Horizon" : "Back to our own copy");
      return;
    }
    case "open-ms":
      if (deviceCode) await invoke("open_url", { url: deviceCode.url });
      return;
    case "open-site":
      await invoke("open_url", { url: view?.site ?? "https://minecraft.westwardconsulting.ai" });
      return;
    default:
      return;
  }
}

/** Sign in to Microsoft, then fetch the game files without a second click. */
let engineJob: Promise<unknown> | null = null;

/** Installs the engine once, however many buttons ask for it. */
function installEngine(): Promise<unknown> {
  engineJob ??= act("setup_engine", "could not install the engine", async () => {
    // One quiet retry: a dropped connection should not cost a press.
    await invoke("setup_engine").catch(async () => {
      await new Promise((done) => setTimeout(done, 3000));
      await invoke("setup_engine");
    });
    toast("Engine installed", "good");
    await refresh();
  }).finally(() => {
    engineJob = null;
  });
  return engineJob;
}

async function onMicrosoft(): Promise<void> {
  // The sign-in runs through the engine, so get the engine first rather than
  // fail with "not installed" (which every new machine did).
  if (!view?.game.binary) {
    await installEngine();
    if (!view?.game.binary || setupHeld) return;
  }
  await act("microsoft_sign_in", "Microsoft sign-in", async () => {
    await invoke("microsoft_sign_in");
    deviceCode = null;
    toast("Signed in to Minecraft", "good");
    // Nothing to decide between the two, so do not make them click twice.
    running.add("prepare_game");
    progress.set("prepare_game", { label: "Fetching the game files", pct: 0 });
    render();
    try {
      await invoke("prepare_game");
    } finally {
      running.delete("prepare_game");
      progress.delete("prepare_game");
    }
    toast("Game files ready", "good");
    await refresh();
  });
}

async function onBuild(): Promise<void> {
  const prompt = el<HTMLTextAreaElement>("prompt")?.value.trim() ?? "";
  if (!prompt || !chosenWorld) return;
  buildStartedAt = Date.now();
  await act("build", "that one did not land", async () => {
    const outcome = await invoke<BuildOutcome>("build_mod", {
      world: chosenWorld,
      prompt,
      effort,
    });
    lastBuild = outcome;
    toast(`${outcome.name ?? "Your mod"} is live`, "good");
    await loadMods();
  });
}

async function onPair(): Promise<void> {
  await act("pair", "could not start the sign-in", async () => {
    const start = await invoke<{ code: string; url: string; minutes: number }>("start_pairing");
    toast(`Finish in your browser. Code ${start.code}`);
    // Poll until the browser side confirms, or the code runs out.
    const until = Date.now() + start.minutes * 60_000;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const result = await invoke<{ paired: boolean; waiting: boolean; error: string | null }>(
        "poll_pairing",
        { code: start.code },
      );
      if (result.paired) {
        toast("Account connected", "good");
        await refresh();
        return;
      }
      if (result.error) throw new Error(result.error);
    }
    throw new Error("the code ran out — try again");
  });
}

// --- loading --------------------------------------------------------------

async function loadServers(): Promise<void> {
  if (!view?.paired) {
    servers = [];
    return;
  }
  servers = await invoke<Server[]>("servers").catch((error) => {
    toast(`Could not list your worlds: ${String(error)}`, "bad");
    return [];
  });
  if (!chosenWorld) {
    const remembered = localStorage.getItem("lastWorld");
    chosenWorld =
      (remembered && servers.find((s) => s.id === remembered)?.id) ??
      servers.find((s) => s.up && s.players > 0)?.id ??
      servers.find((s) => s.up)?.id ??
      servers[0]?.id ??
      null;
  }
}

async function loadFriends(): Promise<void> {
  if (!view?.paired) {
    friends = [];
    return;
  }
  const body = await invoke<FriendsBody>("friends").catch((error) => {
    toast(`Could not load your friends: ${String(error)}`, "bad");
    return null;
  });
  if (body) {
    friends = body.friends;
    myMcName = body.me?.mc_name ?? null;
  }
  render();
}

async function loadMods(): Promise<void> {
  if (!chosenWorld) {
    mods = [];
    return;
  }
  mods = await invoke<ModView[]>("world_mods", { world: chosenWorld }).catch(() => []);
  render();
}

async function refresh(): Promise<void> {
  view = await invoke<Overview>("overview");
  await loadServers();
  render();
  if (chosenWorld) await loadMods();
  if (view.paired) {
    myIdea = await invoke<string | null>("my_idea").catch(() => null);
    render();
    await loadFriends();
  }
}

// --- events from the Rust side -------------------------------------------

void listen<[string, number]>("setup-progress", (event) => {
  progress.set("setup_engine", { label: event.payload[0], pct: event.payload[1] });
  render();
});

void listen<{ url: string; code: string }>("ms-code", (event) => {
  deviceCode = event.payload;
  render();
});

void listen<string>("game-progress", (event) => {
  progress.set("prepare_game", { label: event.payload, pct: 0 });
  render();
});

void refresh();

// Opened by a Join link, or handed one while already open.
void getCurrent().then(handleLinks).catch(() => {});
void onOpenUrl((urls) => void handleLinks(urls)).catch(() => {});
