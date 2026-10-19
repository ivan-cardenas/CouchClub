(() => {
const $ = id => document.getElementById(id);
const CFG = window.CC_CONFIG || {};
const S = {uid:null,email:null,profiles:new Map(),titles:[],filter:'todo',kind:'movie',drafts:{},armed:null,
  pending:new Set(),editingName:false,loaded:false,channel:null,started:false,pick:null};
try { const f = localStorage.getItem('cc-filter'); if (f) S.filter = f; } catch(e){}

if (CFG.clubName && CFG.clubName !== 'Couch Club'){ $('brandName').textContent = CFG.clubName; document.title = CFG.clubName; }

/* ---------- helpers ---------- */
function h(tag, attrs, ...kids){
  const el = document.createElement(tag);
  for (const [k,v] of Object.entries(attrs||{})){
    if (v==null || v===false) continue;
    if (k==='class') el.className=v; else if (k==='text') el.textContent=v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2),v); else el.setAttribute(k,v===true?'':v);
  }
  for (const c of kids.flat()) if (c!=null && c!==false) el.append(c.nodeType?c:document.createTextNode(c));
  return el;
}
let toastT; function toast(msg){const t=$('toast');t.textContent=msg;t.hidden=false;clearTimeout(toastT);toastT=setTimeout(()=>t.hidden=true,2600);}
function setNotice(msg){ $('notice').textContent=msg||''; $('notice').hidden=!msg; }
function ago(ms){const s=(Date.now()-ms)/1000; if(s<60)return'just now'; const m=s/60; if(m<60)return Math.floor(m)+' min ago';
  const hr=m/60; if(hr<24)return Math.floor(hr)+' h ago'; const d=hr/24; if(d<30)return Math.floor(d)+(Math.floor(d)===1?' day ago':' days ago');
  return new Date(ms).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});}
const isSeen=(t,id)=>!!(t.seen&&t.seen[id]);
function nameOf(id){ return (S.profiles.get(id)||{}).nickname || 'Someone'; }
function hue(id){ let x=0; for (const c of String(id)) x=(x*31+c.charCodeAt(0))>>>0; return x%360; }
function avatar(id){
  const n=nameOf(id).trim(); const parts=n.split(/\s+/);
  const ini=(parts[0]?.[0]||'?')+(parts[1]?.[0]||'');
  return h('span',{class:'av',style:`background:hsl(${hue(id)} 45% 42%)`,'aria-hidden':'true',text:ini});
}
function chip(id,cls){ return h('span',{class:'chip '+cls},avatar(id),nameOf(id)+(id===S.uid?' (you)':'')); }
function show(view){ for (const v of ['signin','notMember','welcome','app']) $(v).hidden = v!==view; }

/* ---------- setup check ---------- */
if (!window.supabase || !CFG.url || CFG.url.includes('YOUR-PROJECT') || !CFG.key || CFG.key.includes('YOUR-')){
  setNotice(!window.supabase ? 'Could not load the Supabase library. Check your connection and reload.'
    : 'Setup needed: open config.js and paste your Supabase project URL and anon/publishable key. See the README.');
  return;
}
const sb = window.supabase.createClient(CFG.url, CFG.key);

/* ---------- data ---------- */
let loadT;
function scheduleLoad(){ clearTimeout(loadT); loadT=setTimeout(load,250); }
async function load(){
  const [p,t,v] = await Promise.all([
    sb.from('profiles').select('id,nickname,joined_at').order('joined_at'),
    sb.from('titles').select('*').order('added_at',{ascending:false}).limit(500),
    sb.from('views').select('title_id,user_id,seen,seen_at,take')
  ]);
  const err = p.error||t.error||v.error;
  if (err){ setNotice('Could not load the list: '+err.message); return; }
  S.profiles = new Map(p.data.map(r=>[r.id,r]));
  const byTitle = {};
  for (const r of v.data){ const b=byTitle[r.title_id] ||= {seen:{},takes:{}};
    if (r.seen) b.seen[r.user_id] = r.seen_at ? Date.parse(r.seen_at) : 1;
    if (r.take) b.takes[r.user_id] = r.take; }
  S.titles = t.data.map(r=>({id:r.id,title:r.title,kind:r.kind,year:r.year,where:r.where_to_watch,note:r.note,
    imdbId:r.imdb_id,poster:r.poster_url,rating:r.imdb_rating,addedBy:r.added_by,addedAt:Date.parse(r.added_at),...(byTitle[r.id]||{seen:{},takes:{}})}));
  S.loaded = true; render();
}
function subscribe(){
  if (S.channel) return;
  S.channel = sb.channel('couch-club')
    .on('postgres_changes',{event:'*',schema:'public',table:'titles'},scheduleLoad)
    .on('postgres_changes',{event:'*',schema:'public',table:'views'},scheduleLoad)
    .on('postgres_changes',{event:'*',schema:'public',table:'profiles'},scheduleLoad)
    .subscribe();
  // Catch up when the tab comes back (phones pause sockets in the background)
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden) scheduleLoad(); });
}

/* ---------- auth ---------- */
async function handleSession(session){
  if (!session){ S.uid=null; show('signin'); $('me').replaceChildren(); return; }
  if (S.uid===session.user.id && (S.started || S.checking)) return;
  S.uid = session.user.id; S.email = session.user.email; S.checking = true;
  try { await checkMember(); } finally { S.checking = false; }
}
async function checkMember(){
  setNotice('');
  const {data:member, error} = await sb.rpc('is_member');
  if (error){ setNotice('Could not check the club list: '+error.message); return; }
  if (!member){
    // Open club (no code set): join straight away. Otherwise ask for the code.
    const {data:needsCode} = await sb.rpc('club_needs_code');
    if (needsCode === false){
      const {data:joined, error:jerr} = await sb.rpc('join_club',{code:null});
      if (jerr || !joined){ setNotice('Could not join the club: '+(jerr?jerr.message:'try again')); return; }
    } else {
      $('joinMsg').hidden = true; $('joinCode').value = '';
      show('notMember'); renderMe(); return;
    }
  }
  await afterJoin();
}
async function afterJoin(){
  const {data:prof} = await sb.from('profiles').select('id,nickname').eq('id',S.uid).maybeSingle();
  if (!prof){
    $('welcomeName').value = (S.email||'').split('@')[0].replace(/[._-]+/g,' ').replace(/\b\w/g,c=>c.toUpperCase()).slice(0,30);
    show('welcome'); renderMe(); return;
  }
  start();
}
function start(){
  S.started = true; show('app'); setWritable(true);
  load(); subscribe();
}
function setWritable(on){ for (const el of $('addForm').querySelectorAll('input,button')) el.disabled=!on; }

let authMode='in';
function setAuthMode(m){
  authMode=m;
  $('modeIn').setAttribute('aria-pressed',String(m==='in')); $('modeUp').setAttribute('aria-pressed',String(m==='up'));
  $('authBtn').textContent = m==='in' ? 'Sign in' : 'Create account';
  $('authPass').autocomplete = m==='in' ? 'current-password' : 'new-password';
  $('authHint').textContent = m==='in' ? 'Welcome back. Sign in with your email and password.'
    : 'New here? Pick a password. You’ll enter the club code right after.';
  $('signinMsg').hidden=true;
}
$('modeIn').onclick=()=>setAuthMode('in'); $('modeUp').onclick=()=>setAuthMode('up');
function authMsg(text){ const m=$('signinMsg'); m.hidden=false; m.textContent=text; }

$('pwForm').addEventListener('submit', async e=>{
  e.preventDefault();
  const email=$('authEmail').value.trim(), password=$('authPass').value;
  if(!email||password.length<6){ authMsg('Enter your email and a password of at least 6 characters.'); return; }
  $('authBtn').disabled=true;
  let res;
  if (authMode==='in') res = await sb.auth.signInWithPassword({email,password});
  else res = await sb.auth.signUp({email,password,options:{emailRedirectTo: location.origin+location.pathname}});
  $('authBtn').disabled=false;
  const {data,error}=res;
  if (error){
    if (/invalid login/i.test(error.message)) authMsg('Wrong email or password. New here? Choose “Create account”.');
    else if (/already registered/i.test(error.message)) authMsg('That email already has an account. Choose “Sign in”.');
    else authMsg(error.message);
    return;
  }
  if (authMode==='up' && !data.session){
    // Either email confirmation is still on in Supabase, or this email already has an account
    authMsg('Account created, but it needs confirming by email first. If you already have an account, choose “Sign in”.');
  }
  // With a session, onAuthStateChange takes over
});

$('linkInstead').addEventListener('click', async ()=>{
  const email=$('authEmail').value.trim();
  if(!email){ authMsg('Type your email first, then tap the link option again.'); $('authEmail').focus(); return; }
  const {error} = await sb.auth.signInWithOtp({email, options:{emailRedirectTo: location.origin+location.pathname, shouldCreateUser:true}});
  authMsg(error ? (/rate limit/i.test(error.message)
      ? 'Too many sign-in emails were sent recently. Use your password instead, or try the link again in an hour.'
      : 'Could not send the link: '+error.message)
    : `Check ${email} for a sign-in link and open it in this browser.`);
});
$('joinForm').addEventListener('submit', async e=>{
  e.preventDefault();
  const code=$('joinCode').value.trim(); if(!code) return;
  $('joinBtn').disabled=true;
  const {data:joined, error} = await sb.rpc('join_club',{code});
  $('joinBtn').disabled=false;
  const msg=$('joinMsg');
  if (error){ msg.hidden=false; msg.textContent='Could not join: '+error.message; return; }
  if (!joined){ msg.hidden=false; msg.textContent='That code doesn’t match. Check it with the friend who sent it.'; return; }
  await afterJoin();
});
$('welcomeForm').addEventListener('submit', async e=>{
  e.preventDefault();
  const nickname=$('welcomeName').value.trim().slice(0,30); if(!nickname) return;
  const {error} = await sb.from('profiles').upsert({id:S.uid,nickname});
  if (error){ toast('Could not save your name: '+error.message); return; }
  start();
});
document.addEventListener('click', async e=>{
  if (!e.target.closest('[data-signout]')) return;
  if (S.channel){ sb.removeChannel(S.channel); S.channel=null; }
  S.started=false; S.loaded=false; S.titles=[]; S.profiles=new Map();
  await sb.auth.signOut();
});

/* ---------- render ---------- */
function groupIds(){
  const ids=new Set(S.profiles.keys());
  if (S.uid && S.profiles.has(S.uid)) ids.add(S.uid);
  return [...ids];
}
function render(){ renderMe(); renderFilters(); renderList(); }

function renderMe(){
  const box=$('me'); box.replaceChildren();
  if (!S.uid) return;
  const ids=groupIds();
  if (S.started && ids.length) box.append(h('div',{class:'club'},h('div',{class:'stack'},ids.slice(0,6).map(avatar)),ids.length+' in the club'));
  if (S.started){
    if (S.editingName){
      const inp=h('input',{id:'nickInput',maxlength:'30',value:nameOf(S.uid),'aria-label':'Your name'});
      const save=async()=>{ S.editingName=false; const v=inp.value.trim().slice(0,30); render();
        if (v && v!==nameOf(S.uid)){ const {error}=await sb.from('profiles').update({nickname:v}).eq('id',S.uid);
          if (error) toast('Could not save your name. Try again.'); else { toast('Name updated'); scheduleLoad(); } } };
      inp.addEventListener('keydown',e=>{ if(e.key==='Enter'){e.preventDefault();save();} if(e.key==='Escape'){S.editingName=false;render();} });
      box.append(h('div',{class:'nameedit'},inp,h('button',{class:'primary',type:'button',onclick:save,text:'Save'})));
      setTimeout(()=>inp.focus(),0);
    } else {
      box.append(h('button',{class:'namebtn',type:'button',title:'Change the name your friends see',onclick:()=>{S.editingName=true;render();}},
        avatar(S.uid),nameOf(S.uid),h('small',{text:'edit'})));
    }
  }
  box.append(h('button',{class:'signout',type:'button','data-signout':true,text:'Sign out'}));
}

const FILTERS=[['todo','To watch'],['talk','Ready to talk'],['seen','Seen'],['all','All']];
function matches(t,f){ const me=isSeen(t,S.uid);
  if (f==='todo') return !me; if (f==='seen') return me;
  if (f==='talk') return me && Object.keys(t.seen||{}).some(k=>k!==S.uid&&t.seen[k]); return true; }
function renderFilters(){
  const nav=$('filters'); nav.replaceChildren();
  for (const [k,label] of FILTERS){
    const n=S.titles.filter(t=>matches(t,k)).length;
    nav.append(h('button',{type:'button','aria-pressed':String(S.filter===k),
      onclick:()=>{S.filter=k;try{localStorage.setItem('cc-filter',k)}catch(e){};render();}},label,h('b',{text:String(n)})));
  }
}

function renderList(){
  const list=$('list');
  const ae=document.activeElement, keep=ae&&list.contains(ae)?ae.id:null, caret=keep?ae.selectionStart:null;
  list.replaceChildren();
  if (!S.loaded){ list.append(h('div',{class:'emptystate'},h('h2',{text:'Loading the club'}),h('p',{text:'Your group’s watchlist will appear here.'}))); return; }
  const rows=S.titles.filter(t=>matches(t,S.filter));
  if (!rows.length){
    const msg = S.titles.length===0
      ? ['Nothing on the list yet','Add the first movie or series your friends should see. Everyone in the club can tick it off when they’ve watched it.']
      : ({todo:['You’re all caught up','Everything on the list is marked as seen by you. Add something new for the others.'],
          talk:['Nobody to talk to yet','Titles show up here once you and at least one friend have both seen them.'],
          seen:['Nothing ticked off yet','Tap “I’ve seen it” on a title once you’ve watched it.']}[S.filter]||['Nothing here','']);
    list.append(h('div',{class:'emptystate'},h('h2',{text:msg[0]}),h('p',{text:msg[1]})));
    return;
  }
  const ids=groupIds();
  for (const t of rows) list.append(card(t,ids));
  if (keep){ const el=$(keep); if(el){ el.focus(); try{ if(caret!=null) el.setSelectionRange(caret,caret);}catch(e){} } }
}

function card(t,ids){
  const me=isSeen(t,S.uid);
  const seenIds=ids.filter(id=>isSeen(t,id)).sort((a,b)=>t.seen[a]-t.seen[b]);
  const notIds=ids.filter(id=>!isSeen(t,id));
  const others=seenIds.filter(id=>id!==S.uid);
  const meta=h('div',{class:'meta'},
    h('span',{class:'kind '+(t.kind==='series'?'series':''),text:t.kind==='series'?'Series':'Movie'}),
    t.year?h('span',{text:String(t.year)}):null,
    t.rating!=null?(t.imdbId?h('a',{class:'score',href:imdbUrl(t.imdbId),target:'_blank',rel:'noopener',title:'IMDb rating',text:fmtRating(t.rating)})
      :h('span',{class:'score',text:fmtRating(t.rating)})):null,
    t.where?h('span',{text:t.where}):null,
    me&&others.length?h('span',{class:'talk',text:'Talk with '+others.length}):null);
  const people=h('div',{class:'people'},
    h('div',{class:'prow'},h('span',{class:'plabel',text:'Seen'}),seenIds.length?seenIds.map(id=>chip(id,'seen')):h('span',{class:'empty-row',text:'No one yet'})),
    h('div',{class:'prow'},h('span',{class:'plabel',text:'Not yet'}),notIds.length?notIds.map(id=>chip(id,'none')):h('span',{class:'empty-row',text:'Everyone has seen it'})));

  const takeIds=Object.keys(t.takes||{}).filter(id=>t.takes[id]&&isSeen(t,id));
  let takes=null;
  if (me){
    const mine=(t.takes||{})[S.uid]||'';
    const inp=h('input',{id:'take-'+t.id,maxlength:'280',placeholder:'Your take, in a line',value:S.drafts[t.id]??mine,'aria-label':'Your take on '+t.title});
    const save=async()=>{ const v=inp.value.trim().slice(0,280); if (v===mine){ delete S.drafts[t.id]; return; }
      const key='take'+t.id; if (S.pending.has(key)) return; S.pending.add(key);
      const {error}=await sb.from('views').upsert({title_id:t.id,user_id:S.uid,take:v||null},{onConflict:'title_id,user_id'});
      S.pending.delete(key);
      if (error) toast('Could not save your take. Try again.'); else { delete S.drafts[t.id]; toast(v?'Take saved':'Take removed'); scheduleLoad(); } };
    inp.addEventListener('input',()=>{S.drafts[t.id]=inp.value;});
    inp.addEventListener('keydown',e=>{ if(e.key==='Enter'){e.preventDefault();inp.blur();} });
    inp.addEventListener('change',save);
    takes=h('div',{class:'takes'},
      takeIds.filter(id=>id!==S.uid).map(id=>h('div',{class:'take'},avatar(id),h('p',{},h('b',{text:nameOf(id)+': '}),t.takes[id]))),
      h('div',{class:'takein'},inp));
  } else if (takeIds.length){
    takes=h('div',{class:'takes'},h('span',{class:'hidden-takes',text:takeIds.length+(takeIds.length===1?' take':' takes')+' hidden until you’ve seen it'}));
  }

  const armed=S.armed===t.id;
  const foot=t.addedBy===S.uid?h('div',{class:'cardfoot'},h('button',{type:'button',class:'remove'+(armed?' armed':''),
    text:armed?'Tap again to remove':'Remove',onclick:async()=>{
      if(!armed){ S.armed=t.id; render(); setTimeout(()=>{ if(S.armed===t.id){S.armed=null;render();} },4000); return; }
      S.armed=null; const {error}=await sb.from('titles').delete().eq('id',t.id);
      if (error) toast('Could not remove it. Try again.'); else { toast('Removed “'+t.title+'”'); scheduleLoad(); } }})):null;

  const head=h('div',{class:'head'},
    t.poster?h('img',{class:'poster',src:sizedPoster(t.poster,200),alt:'',loading:'lazy'}):null,
    h('div',{class:'headtxt'},meta,h('h3',{class:'ttl',text:t.title})));
  const main=h('div',{class:'main'},head,
    t.note?h('p',{class:'note',text:t.note}):null,
    h('p',{class:'added',text:'Added by '+nameOf(t.addedBy)+(t.addedBy===S.uid?' (you)':'')+' · '+ago(t.addedAt)}),
    people,takes,foot);
  const busy=S.pending.has('seen'+t.id);
  const stub=h('div',{class:'stub'},
    h('div',{class:'countbox'},h('div',{class:'count'},String(seenIds.length),h('small',{text:'/'+ids.length})),h('div',{class:'countlbl',text:'have seen'})),
    h('button',{type:'button',class:'seenbtn'+(me?' on':''),'aria-pressed':String(me),disabled:busy||null,
      text:me?'✓ You’ve seen it':'I’ve seen it',onclick:()=>toggleSeen(t,!me)}));
  return h('article',{class:'card'},main,stub);
}

async function toggleSeen(t,on){
  const key='seen'+t.id; if (S.pending.has(key)) return; S.pending.add(key);
  // Optimistic update so the tap feels instant
  t.seen={...t.seen}; if (on) t.seen[S.uid]=Date.now(); else delete t.seen[S.uid]; render();
  const {error}=await sb.from('views').upsert({title_id:t.id,user_id:S.uid,seen:on,seen_at:on?new Date().toISOString():null},{onConflict:'title_id,user_id'});
  S.pending.delete(key);
  if (error) toast('Could not update. Try again.'); else if (on) toast('Marked “'+t.title+'” as seen');
  scheduleLoad();
}

/* ---------- IMDb lookup ---------- */
// The suggestion endpoint gives title, year, type and cover; ratings come from IMDb's GraphQL API in one batched call.
// Both allow browser requests. IMDb permits this for personal, non-commercial use only.
const IMDB_KINDS={movie:'movie',tvMovie:'movie',short:'movie',video:'movie',tvSpecial:'movie',tvSeries:'series',tvMiniSeries:'series'};
const imdbUrl=id=>'https://www.imdb.com/title/'+id+'/';
const fmtRating=r=>Number(r).toFixed(1);
// Amazon image URLs take a size suffix; ask for a small one instead of the full-size original
const sizedPoster=(url,w)=>url.replace(/\._V1_.*\.jpg$/,'._V1_UX'+w+'_.jpg');

async function imdbSearch(q,signal){
  const first=/^[a-z0-9]/i.test(q)?q[0].toLowerCase():'x';
  const res=await fetch('https://v3.sg.media-imdb.com/suggestion/'+first+'/'+encodeURIComponent(q.toLowerCase())+'.json',{signal});
  if (!res.ok) throw new Error('IMDb search failed');
  const {d=[]}=await res.json();
  return d.filter(x=>x.id?.startsWith('tt')&&IMDB_KINDS[x.qid]).slice(0,8).map(x=>({
    imdbId:x.id,title:x.l,year:x.y||null,kind:IMDB_KINDS[x.qid],cast:x.s||'',poster:x.i?.imageUrl||null,rating:null}));
}
async function imdbRatings(ids,signal){
  if (!ids.length) return {};
  const res=await fetch('https://caching.graphql.imdb.com/',{method:'POST',signal,
    headers:{'content-type':'application/json','x-imdb-client-name':'imdb-web-next'},
    body:JSON.stringify({query:'query($ids:[ID!]!){titles(ids:$ids){id ratingsSummary{aggregateRating}}}',variables:{ids}})});
  if (!res.ok) return {};
  const {data}=await res.json(); const out={};
  for (const t of data?.titles||[]) if (t?.ratingsSummary?.aggregateRating!=null) out[t.id]=t.ratingsSummary.aggregateRating;
  return out;
}

const SG={items:[],active:-1,ctl:null,timer:null};
function closeSuggest(){ SG.items=[]; SG.active=-1; $('imdbList').hidden=true; $('fTitle').setAttribute('aria-expanded','false'); $('fTitle').removeAttribute('aria-activedescendant'); }
function renderSuggest(status){
  const ul=$('imdbList'); ul.replaceChildren();
  if (status) ul.append(h('li',{class:'status',role:'presentation',text:status}));
  SG.items.forEach((it,i)=>ul.append(h('li',{id:'sg-'+i,role:'option','aria-selected':String(i===SG.active),
      onmousedown:e=>{e.preventDefault();choose(it);}},
    it.poster?h('img',{class:'poster',src:sizedPoster(it.poster,80),alt:''}):h('span',{class:'poster'}),
    h('span',{class:'sinfo'},h('b',{text:it.title}),h('small',{text:[it.year,it.kind==='series'?'Series':'Movie',it.cast].filter(Boolean).join(' · ')})),
    it.rating!=null?h('span',{class:'srate score',text:fmtRating(it.rating)}):null)));
  ul.hidden=!ul.children.length; $('fTitle').setAttribute('aria-expanded',String(!ul.hidden));
  if (SG.active>=0) $('fTitle').setAttribute('aria-activedescendant','sg-'+SG.active); else $('fTitle').removeAttribute('aria-activedescendant');
}
async function runSearch(q){
  SG.ctl?.abort(); const ctl=SG.ctl=new AbortController();
  try {
    SG.items=await imdbSearch(q,ctl.signal); SG.active=-1;
    renderSuggest(SG.items.length?null:'No IMDb matches. You can still add it as typed.');
    const ratings=await imdbRatings(SG.items.map(x=>x.imdbId),ctl.signal);
    for (const it of SG.items) it.rating=ratings[it.imdbId]??null;
    if (SG.ctl===ctl && !$('imdbList').hidden) renderSuggest();
  } catch(e){ if (e.name!=='AbortError'){ SG.items=[]; renderSuggest('Could not reach IMDb. You can still add it as typed.'); } }
}
function setPick(p){
  S.pick=p; const box=$('picked'); box.replaceChildren(); box.hidden=!p;
  if (!p) return;
  box.append(p.poster?h('img',{class:'poster',src:sizedPoster(p.poster,80),alt:''}):null,
    h('span',{},'IMDb: ',h('a',{href:imdbUrl(p.imdbId),target:'_blank',rel:'noopener',text:p.title+(p.year?' ('+p.year+')':'')}),
      p.rating!=null?' · ★ '+fmtRating(p.rating):''),
    h('button',{type:'button',class:'linkbtn',text:'Unlink',onclick:()=>{setPick(null);$('fTitle').focus();}}));
}
function choose(it){
  $('fTitle').value=it.title; setKind(it.kind);
  if (it.year) $('fYear').value=it.year;
  setPick(it); closeSuggest();
}
$('fTitle').addEventListener('input',()=>{
  if (S.pick && $('fTitle').value!==S.pick.title) setPick(null);
  clearTimeout(SG.timer); const q=$('fTitle').value.trim();
  if (q.length<2){ SG.ctl?.abort(); closeSuggest(); return; }
  SG.timer=setTimeout(()=>runSearch(q),250);
});
$('fTitle').addEventListener('keydown',e=>{
  if ($('imdbList').hidden || !SG.items.length) return;
  if (e.key==='ArrowDown'||e.key==='ArrowUp'){ e.preventDefault();
    const n=SG.items.length; SG.active=(SG.active+(e.key==='ArrowDown'?1:-1)+n+1)%(n+1)-1; renderSuggest(); }
  else if (e.key==='Enter' && SG.active>=0){ e.preventDefault(); choose(SG.items[SG.active]); }
  else if (e.key==='Escape'){ e.preventDefault(); closeSuggest(); }
});
$('fTitle').addEventListener('blur',()=>setTimeout(closeSuggest,100));

/* ---------- add form ---------- */
function setKind(k){ S.kind=k; $('kMovie').setAttribute('aria-pressed',String(k==='movie')); $('kSeries').setAttribute('aria-pressed',String(k==='series')); }
$('kMovie').onclick=()=>setKind('movie'); $('kSeries').onclick=()=>setKind('series');
$('moreToggle').onclick=()=>{ const m=$('moreFields'); m.hidden=!m.hidden; $('moreToggle').textContent=m.hidden?'Add year, where to watch, note':'Hide details'; };
$('addForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const title=$('fTitle').value.trim().slice(0,120); if(!title){ $('fTitle').focus(); return; }
  const dup=S.titles.find(t=>t.title.toLowerCase()===title.toLowerCase());
  if (dup){ toast('“'+dup.title+'” is already on the list'); return; }
  const yr=parseInt($('fYear').value,10);
  const row={title,kind:S.kind,year:(yr>1880&&yr<2100)?yr:null,where_to_watch:$('fWhere').value.trim().slice(0,60)||null,
    note:$('fNote').value.trim().slice(0,200)||null,added_by:S.uid};
  const pick=S.pick&&S.pick.title===title?S.pick:null;
  const imdb=pick?{imdb_id:pick.imdbId,poster_url:pick.poster,imdb_rating:pick.rating}:null;
  const seenToo=$('fSeen').checked;
  $('addBtn').disabled=true;
  let {data,error}=await sb.from('titles').insert({...row,...imdb}).select('id').single();
  // Database not migrated for IMDb yet (supabase/imdb.sql): save the title without cover and score
  if (error && imdb && error.code==='PGRST204'){
    console.warn('IMDb columns missing on titles; run supabase/imdb.sql');
    ({data,error}=await sb.from('titles').insert(row).select('id').single());
  }
  if (!error && seenToo) await sb.from('views').upsert({title_id:data.id,user_id:S.uid,seen:true},{onConflict:'title_id,user_id'});
  $('addBtn').disabled=false;
  if (error){ toast(error.code==='23505'?'“'+title+'” is already on the list':'Could not add it: '+error.message); return; }
  for (const id of ['fTitle','fYear','fWhere','fNote']) $(id).value=''; $('fSeen').checked=false; setPick(null);
  toast('Added “'+title+'”');
  if (S.filter!=='all' && !(S.filter==='todo'&&!seenToo) && !(S.filter==='seen'&&seenToo)){ S.filter='all'; }
  scheduleLoad();
});

/* ---------- boot ---------- */
sb.auth.onAuthStateChange((_ev,session)=>{ setTimeout(()=>handleSession(session),0); });
sb.auth.getSession().then(({data})=>handleSession(data.session));
})();
