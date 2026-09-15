(() => {
  const $ = (id) => document.getElementById(id);
  const cfg = window.NO_LIMITS_SUPABASE || {};
  const configured = !!(cfg.url && cfg.publishableKey);
  let sb = null, channel = null, uid = null, myName = '', lobbyCode = '', isHost = false;
  let players = new Map(), state = null, guesses = new Map(), ownerAnswer = null, tick = null;
  let selectedRoundSeconds = 30, selectedQuestionCount = 10, usedQuestions = new Set();

  const hideAll = () => ['mpHome','mpLobby','mpGame'].forEach(id => $(id)?.classList.add('hidden'));
  const show = id => { hideAll(); $(id)?.classList.remove('hidden'); };
  const esc = s => String(s ?? '').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
  const code = () => Math.random().toString(36).slice(2,7).toUpperCase().replace(/[01OI]/g,'X');
  const now = () => Date.now();
  const currentPlayers = () => [...players.values()].sort((a,b)=>(a.joinedAt||0)-(b.joinedAt||0));
  const me = () => players.get(uid);
  const deckFor = category => window.decks?.[category] || (typeof decks!=='undefined'?decks[category]:[]);
  function nextRandomQuestion(category){
    const deck=deckFor(category);
    if(!deck?.length) return 0;
    if(usedQuestions.size>=deck.length) usedQuestions.clear();
    const available=[]; for(let i=0;i<deck.length;i++) if(!usedQuestions.has(i)) available.push(i);
    const idx=available[Math.floor(Math.random()*available.length)];
    usedQuestions.add(idx); return idx;
  }

  async function ensureAuth(){
    if(!configured) throw new Error('Supabase ist noch nicht verbunden.');
    if(!sb) sb = window.supabase.createClient(cfg.url, cfg.publishableKey);
    const { data:{session} } = await sb.auth.getSession();
    if(session){ uid=session.user.id; return; }
    const {data,error}=await sb.auth.signInAnonymously();
    if(error) throw error;
    uid=data.user.id;
  }

  function setHint(msg){ $('mpConfigHint').textContent=msg; }
  function renderPlayers(){
    const arr=currentPlayers();
    $('mpPlayers').innerHTML=arr.map(p=>`<div class="playerChip"><span>${esc(p.name)}${p.uid===uid?' · du':''}${p.host?' 👑':''}</span><b>${state?.scores?.[p.uid]||0} P</b></div>`).join('');
    $('lobbyStatus').textContent = `${arr.length} Spieler verbunden`;
  }

  function syncPresence(){
    if(!channel) return;
    const ps=channel.presenceState(); players.clear();
    Object.values(ps).flat().forEach(p=>{ if(p?.uid) players.set(p.uid,p); });
    renderPlayers();
    if(isHost && state && state.phase==='lobby') broadcastState();
  }

  async function connect(room, host){
    await ensureAuth(); lobbyCode=room; isHost=host;
    channel = sb.channel(`no-limits:${room}`, {config:{presence:{key:uid}, broadcast:{self:true}}});
    channel
      .on('presence',{event:'sync'},syncPresence)
      .on('broadcast',{event:'state'},({payload})=>receiveState(payload))
      .on('broadcast',{event:'guess'},({payload})=>{if(isHost) receiveGuess(payload)})
      .on('broadcast',{event:'owner_answer'},({payload})=>{if(isHost) receiveOwnerAnswer(payload)})
      .on('broadcast',{event:'sync_request'},()=>{if(isHost && state) broadcastState()})
      .on('broadcast',{event:'session_end'},()=>{ if(!isHost) endLocalSession(false,'Der Host hat die Lobby beendet.'); })
      .subscribe(async status=>{
        if(status==='SUBSCRIBED'){
          await channel.track({uid,name:myName,host:isHost,joinedAt:now()});
          if(isHost){
            state={phase:'lobby',category:'18+',roundSeconds:selectedRoundSeconds,totalQuestions:selectedQuestionCount,turnUid:null,questionIndex:0,round:0,deadline:null,scores:{[uid]:0},reveal:null};
            show('mpLobby'); $('hostControls').classList.remove('hidden'); $('lobbyCodeDisplay').textContent=lobbyCode; broadcastState();
          } else {
            show('mpLobby'); $('hostControls').classList.add('hidden'); $('lobbyCodeDisplay').textContent=lobbyCode;
            send('sync_request',{});
          }
        }
      });
  }

  function send(event,payload){ return channel?.send({type:'broadcast',event,payload}); }
  function broadcastState(){
    if(!isHost || !state) return;
    currentPlayers().forEach(p=>{ if(state.scores[p.uid] == null) state.scores[p.uid]=0; });
    send('state',state); receiveState(state);
  }

  function receiveState(s){
    state=s;
    if(s.phase==='lobby'){ show('mpLobby'); renderPlayers(); return; }
    show('mpGame'); renderGame();
  }

  function questionForState(){
    const deck=deckFor(state.category);
    return deck?.[state.questionIndex] || null;
  }

  function renderGame(){
    if(!state) return;
    if(state.phase==='finished'){
      $('mpWho').textContent='Spiel beendet';
      $('mpTimer').textContent='🏆';
      $('mpQuestion').textContent=`${state.totalQuestions||state.round} Fragen gespielt`;
      $('mpAnswers').innerHTML='';
      $('mpReveal').classList.add('hidden');
      $('mpContinueBtn').classList.toggle('hidden',!isHost);
      if(isHost){ $('mpContinueBtn').textContent='Zurück zur Lobby →'; }
      const scores=state.scores||{};
      $('mpScores').innerHTML=currentPlayers().sort((a,b)=>(scores[b.uid]||0)-(scores[a.uid]||0)).map((p,i)=>`<div class="scoreLine"><span>${i===0?'👑 ':''}${esc(p.name)}</span><b>${scores[p.uid]||0} P</b></div>`).join('');
      $('mpStatus').textContent=isHost?'Finale Rangliste – ihr könnt zurück zur Lobby oder ins Main Menu.':'Finale Rangliste – der Host entscheidet, wie es weitergeht.';
      $('mpGameMainMenu')?.classList.toggle('hidden',!isHost);
      clearInterval(tick); tick=null;
      return;
    }
    const q=questionForState(); if(!q) return;
    const turn=players.get(state.turnUid);
    $('mpWho').textContent=`${turn?.name||'Spieler'} ist dran · Frage ${state.round}/${state.totalQuestions||'?'}`;
    $('mpQuestion').textContent=q[0];
    $('mpReveal').classList.toggle('hidden',state.phase!=='reveal');
    const isOwner=uid===state.turnUid;
    const myGuess=state.clientSelections?.[uid];
    $('mpAnswers').innerHTML='';
    const count = state.category==='Würdest du eher'?2:3;
    for(let i=0;i<count;i++){
      const letter='ABC'[i], btn=document.createElement('button');
      btn.className='mpAnswer'+(myGuess===letter?' selected':'');
      btn.textContent=`${letter} · ${q[i+1]}`;
      btn.disabled=state.phase!=='answering' || !!myGuess;
      btn.onclick=()=>submitChoice(letter,isOwner);
      $('mpAnswers').appendChild(btn);
    }
    const scores=state.scores||{};
    $('mpScores').innerHTML=currentPlayers().sort((a,b)=>(scores[b.uid]||0)-(scores[a.uid]||0)).map(p=>`<div class="scoreLine"><span>${esc(p.name)}</span><b>${scores[p.uid]||0} P</b></div>`).join('');
    if(state.phase==='reveal'){
      const ans=state.reveal?.answer||'?';
      const correct=state.reveal?.correctNames||[];
      $('mpReveal').innerHTML=`Richtige Antwort: <b>${ans}</b><br><span style="font-size:13px;color:#d9c9da">Richtig geraten: ${correct.length?correct.map(esc).join(', '):'niemand'}</span>`;
      $('mpStatus').textContent=isHost?'Zeit zum Diskutieren – starte die nächste Runde, wenn ihr bereit seid.':'Zeit zum Diskutieren – der Host startet gleich die nächste Runde.';
      $('mpContinueBtn')?.classList.toggle('hidden',!isHost);
      if(isHost) $('mpContinueBtn').textContent=(state.round>=state.totalQuestions)?'Ergebnis anzeigen →':'Weiter →';
    } else {
      $('mpStatus').textContent=isOwner?'Wähle deine echte Antwort. Die anderen tippen gleichzeitig.':'Was glaubst du, welche Antwort gewählt wird?';
      $('mpContinueBtn')?.classList.add('hidden');
    }
    $('mpGameMainMenu')?.classList.toggle('hidden',!isHost);
    startTimer();
  }

  function startTimer(){
    clearInterval(tick); tick=null;
    if(!state || state.phase!=='answering'){ $('mpTimer').textContent='✓'; return; }
    const update=()=>{
      const sec=Math.max(0,Math.ceil((state.deadline-now())/1000)); $('mpTimer').textContent=sec;
      if(sec<=0 && isHost){ clearInterval(tick); finishRound(); }
    };
    update(); tick=setInterval(update,250);
  }

  function submitChoice(letter,isOwner){
    if(!state || state.phase!=='answering') return;
    state.clientSelections=state.clientSelections||{};
    if(state.clientSelections[uid]) return;
    state.clientSelections[uid]=letter; renderGame();
    if(isOwner) send('owner_answer',{uid,letter,round:state.round});
    else send('guess',{uid,letter,round:state.round});
  }

  function receiveGuess(p){
    if(!state || p.round!==state.round || state.phase!=='answering') return;
    guesses.set(p.uid,p.letter); checkEarlyFinish();
  }
  function receiveOwnerAnswer(p){
    if(!state || p.round!==state.round || p.uid!==state.turnUid || state.phase!=='answering') return;
    ownerAnswer=p.letter; checkEarlyFinish();
  }
  function checkEarlyFinish(){
    if(!isHost || !ownerAnswer) return;
    const others=currentPlayers().filter(p=>p.uid!==state.turnUid);
    if(others.length && others.every(p=>guesses.has(p.uid))) finishRound();
  }

  function finishRound(){
    if(!isHost || !state || state.phase!=='answering') return;
    const answer=ownerAnswer || '—'; let correct=0, names=[];
    if(ownerAnswer){
      for(const [pid,g] of guesses){ if(g===ownerAnswer){ state.scores[pid]=(state.scores[pid]||0)+1; correct++; names.push(players.get(pid)?.name||'Spieler'); } }
      state.scores[state.turnUid]=(state.scores[state.turnUid]||0)+correct;
    }
    state.phase='reveal'; state.reveal={answer,correctNames:names}; state.deadline=null;
    broadcastState();
  }

  function nextRound(){
    if(!isHost) return;
    if((state.round||0)>=(state.totalQuestions||10)){
      state.phase='finished'; state.deadline=null; state.reveal=null; state.clientSelections={}; broadcastState(); return;
    }
    const arr=currentPlayers(); if(arr.length<2) return;
    const currentIndex=Math.max(0,arr.findIndex(p=>p.uid===state.turnUid));
    const next=arr[(currentIndex+1)%arr.length];
    state.round=(state.round||0)+1; state.turnUid=next.uid; state.questionIndex=nextRandomQuestion(state.category);
    state.phase='answering'; state.deadline=now()+((state.roundSeconds||30)*1000); state.reveal=null; state.clientSelections={}; guesses.clear(); ownerAnswer=null;
    broadcastState();
  }

  function startGame(){
    if(!isHost) return;
    const arr=currentPlayers(); if(arr.length<2){ $('lobbyStatus').textContent='Mindestens 2 Spieler benötigt.'; return; }
    state.category=$('mpCategory').value; state.roundSeconds=selectedRoundSeconds; selectedQuestionCount=Math.max(1,Math.min(200,Number($('mpQuestionCount')?.value)||10)); state.totalQuestions=selectedQuestionCount; state.round=1; state.turnUid=arr[0].uid;
    usedQuestions.clear(); state.questionIndex=nextRandomQuestion(state.category); state.phase='answering'; state.deadline=now()+(state.roundSeconds*1000); state.clientSelections={}; state.reveal=null;
    guesses.clear(); ownerAnswer=null; broadcastState();
  }


  async function endLocalSession(hostInitiated=false,message=''){
    const wasHost=isHost;
    clearInterval(tick); tick=null;
    if(hostInitiated && channel){ try{ await send('session_end',{}); }catch(e){} }
    try{ if(channel){ await channel.untrack(); await channel.unsubscribe(); if(sb?.removeChannel) await sb.removeChannel(channel); } }catch(e){}
    channel=null; lobbyCode=''; isHost=false; players.clear(); state=null; guesses.clear(); ownerAnswer=null; usedQuestions.clear();
    hideAll();
    if(wasHost || hostInitiated){
      $('modePanel')?.classList.remove('hidden');
    } else {
      $('mpHome')?.classList.remove('hidden');
      if(message) setHint(message);
    }
  }

  async function hostMainMenu(){ if(!isHost) return; await endLocalSession(true); }

  async function createLobby(){
    try{ myName=$('mpName').value.trim(); if(!myName) return setHint('Bitte zuerst deinen Namen eingeben.'); setHint('Verbinde …'); await connect(code(),true); }
    catch(e){ setHint(e.message||String(e)); }
  }
  async function joinLobby(){
    try{ myName=$('mpName').value.trim(); const c=$('joinCode').value.trim().toUpperCase(); if(!myName) return setHint('Bitte zuerst deinen Namen eingeben.'); if(c.length<4) return setHint('Bitte Lobby-Code eingeben.'); setHint('Verbinde …'); await connect(c,false); }
    catch(e){ setHint(e.message||String(e)); }
  }

  function init(){
    $('mpConfigHint').textContent=configured?'Mehrspieler bereit.':'Mehrspieler ist vorbereitet – Supabase URL + Publishable Key fehlen noch.';
  }
  $('createLobbyBtn')?.addEventListener('click',createLobby);
  $('showJoinBtn')?.addEventListener('click',()=>$('joinArea').classList.toggle('hidden'));
  $('joinLobbyBtn')?.addEventListener('click',joinLobby);
  $('mpStartGame')?.addEventListener('click',startGame);
  $('mpContinueBtn')?.addEventListener('click',()=>{
    if(!isHost || !state) return;
    if(state.phase==='reveal') nextRound();
    else if(state.phase==='finished'){
      state.phase='lobby'; state.round=0; state.turnUid=null; state.reveal=null; state.deadline=null; state.clientSelections={}; usedQuestions.clear(); guesses.clear(); ownerAnswer=null; broadcastState();
    }
  });
  $('mpLobbyMainMenu')?.addEventListener('click',hostMainMenu);
  $('mpGameMainMenu')?.addEventListener('click',hostMainMenu);
  document.querySelectorAll('#mpTimePicker .timeBtn').forEach(btn=>btn.addEventListener('click',()=>{
    if(!isHost) return; selectedRoundSeconds=Number(btn.dataset.time)||30;
    document.querySelectorAll('#mpTimePicker .timeBtn').forEach(b=>b.classList.toggle('active',b===btn));
    if(state?.phase==='lobby') state.roundSeconds=selectedRoundSeconds;
  }));
  $('mpQuestionCount')?.addEventListener('change',e=>{
    if(!isHost) return; selectedQuestionCount=Math.max(1,Math.min(200,Number(e.target.value)||10));
    if(state?.phase==='lobby') state.totalQuestions=selectedQuestionCount;
  });
  window.NLMP={init};
})();
