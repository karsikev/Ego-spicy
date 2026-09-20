(() => {
  const CUSTOM = 'Anonyme Fragen';
  const CUSTOM_PER_PLAYER = 5;
  const $ = (id) => document.getElementById(id);
  const cfg = window.NO_LIMITS_SUPABASE || {};
  const configured = !!(cfg.url && cfg.publishableKey);

  let sb = null, channel = null, uid = null, myName = '', lobbyCode = '', isHost = false;
  let players = new Map(), state = null, guesses = new Map(), ownerAnswer = null, tick = null;
  let selectedRoundSeconds = 30, selectedQuestionCount = 10, usedQuestions = new Set();
  let customSubmissions = new Map();
  let customDraft = freshCustomDraft(), customStep = 0, customSubmissionId = null, customSending = false;

  function freshCustomDraft(){ return Array.from({length:CUSTOM_PER_PLAYER},()=>['','','','']); }
  const hideAll = () => ['mpHome','mpLobby','mpSubmit','mpGame'].forEach(id => $(id)?.classList.add('hidden'));
  const show = id => { hideAll(); $(id)?.classList.remove('hidden'); };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const code = () => Math.random().toString(36).slice(2,7).toUpperCase().replace(/[01OI]/g,'X');
  const now = () => Date.now();
  const t = (key,vars={}) => window.NLI18N?.t(key,vars) || key;
  const lang = () => window.NLI18N?.lang || 'de';
  const currentPlayers = () => [...players.values()].sort((a,b)=>(a.joinedAt||0)-(b.joinedAt||0));

  function gamePlayers(){
    if(!state?.playerOrder?.length) return currentPlayers();
    return state.playerOrder.map((id,index)=>players.get(id) || {
      uid:id,
      name:state.playerNames?.[id] || t('player'),
      host:id===state.hostUid,
      joinedAt:index
    });
  }

  function deckFor(category){
    if(category===CUSTOM) return state?.customDeck || [];
    return window.NLI18N?.getDeck(category,state?.language||lang()) || window.decks?.[category] || [];
  }

  function nextRandomQuestion(category){
    const deck=deckFor(category);
    if(!deck?.length) return 0;
    if(usedQuestions.size>=deck.length) usedQuestions.clear();
    const available=[];
    for(let i=0;i<deck.length;i++) if(!usedQuestions.has(i)) available.push(i);
    const idx=available[Math.floor(Math.random()*available.length)];
    usedQuestions.add(idx);
    return idx;
  }

  function shuffleDeck(list){
    const a=list.map(q=>[...q]);
    for(let i=a.length-1;i>0;i--){
      const j=Math.floor(Math.random()*(i+1));
      [a[i],a[j]]=[a[j],a[i]];
    }
    return a;
  }

  async function ensureAuth(){
    if(!configured) throw new Error(t('supabaseMissing'));
    if(!sb) sb = window.supabase.createClient(cfg.url, cfg.publishableKey);
    const { data:{session} } = await sb.auth.getSession();
    if(session){ uid=session.user.id; return; }
    const {data,error}=await sb.auth.signInAnonymously();
    if(error) throw error;
    uid=data.user.id;
  }

  function setHint(msg){ if($('mpConfigHint')) $('mpConfigHint').textContent=msg; }

  function updateLobbyModeUI(){
    const sel=$('mpCategory');
    if(!sel) return;
    const custom=sel.value===CUSTOM;
    $('questionCountBlock')?.classList.toggle('hidden',custom);
    $('customModeNote')?.classList.toggle('hidden',!custom);
    if(custom && $('customModeNote')) $('customModeNote').textContent=t('customCountNote',{count:currentPlayers().length*CUSTOM_PER_PLAYER});
    if($('mpStartGame')) $('mpStartGame').textContent=custom?t('collectQuestions'):t('startGame');
  }

  function renderPlayers(){
    const arr=currentPlayers();
    if($('mpPlayers')) $('mpPlayers').innerHTML=arr.map(p=>`<div class="playerChip"><span>${esc(p.name)}${p.uid===uid?' · '+t('you'):''}${p.host?' 👑':''}</span><b>${state?.scores?.[p.uid]||0} ${t('points')}</b></div>`).join('');
    if($('lobbyStatus')) $('lobbyStatus').textContent = t('playersConnected',{count:arr.length});
    updateLobbyModeUI();
  }

  function syncPresence(){
    if(!channel) return;
    const ps=channel.presenceState();
    players.clear();
    Object.values(ps).flat().forEach(p=>{ if(p?.uid) players.set(p.uid,p); });
    renderPlayers();
    if(isHost && state && state.phase==='lobby') broadcastState();
  }

  async function connect(room, host){
    await ensureAuth();
    lobbyCode=room;
    isHost=host;
    channel = sb.channel(`no-limits:${room}`, {config:{presence:{key:uid}, broadcast:{self:true}}});
    channel
      .on('presence',{event:'sync'},syncPresence)
      .on('broadcast',{event:'state'},({payload})=>receiveState(payload))
      .on('broadcast',{event:'guess'},({payload})=>{if(isHost) receiveGuess(payload)})
      .on('broadcast',{event:'owner_answer'},({payload})=>{if(isHost) receiveOwnerAnswer(payload)})
      .on('broadcast',{event:'custom_submit'},({payload})=>{if(isHost) receiveCustomSubmission(payload)})
      .on('broadcast',{event:'sync_request'},()=>{if(isHost && state) broadcastState()})
      .on('broadcast',{event:'session_end'},()=>{ if(!isHost) endLocalSession(false,t('hostEnded')); })
      .subscribe(async status=>{
        if(status==='SUBSCRIBED'){
          await channel.track({uid,name:myName,host:isHost,joinedAt:now()});
          if(isHost){
            state={
              phase:'lobby',category:'18+',language:lang(),roundSeconds:selectedRoundSeconds,
              totalQuestions:selectedQuestionCount,turnUid:null,questionIndex:0,round:0,deadline:null,
              scores:{[uid]:0},reveal:null,hostUid:uid
            };
            show('mpLobby');
            $('hostControls')?.classList.remove('hidden');
            if($('lobbyCodeDisplay')) $('lobbyCodeDisplay').textContent=lobbyCode;
            updateLobbyModeUI();
            broadcastState();
          } else {
            show('mpLobby');
            $('hostControls')?.classList.add('hidden');
            if($('lobbyCodeDisplay')) $('lobbyCodeDisplay').textContent=lobbyCode;
            send('sync_request',{});
          }
        }
      });
  }

  function send(event,payload){ return channel?.send({type:'broadcast',event,payload}); }

  function broadcastState(){
    if(!isHost || !state) return;
    currentPlayers().forEach(p=>{ if(state.scores[p.uid] == null) state.scores[p.uid]=0; });
    send('state',state);
    receiveState(state);
  }

  function receiveState(s){
    state=s;
    if(s?.language && window.NLI18N?.lang!==s.language) window.NLI18N.setLanguage(s.language,false);
    if(s.phase==='lobby'){
      show('mpLobby');
      if(isHost){
        $('hostControls')?.classList.remove('hidden');
        const sel=$('mpCategory');
        if(sel && [...sel.options].some(o=>o.value===s.category)) sel.value=s.category;
      } else $('hostControls')?.classList.add('hidden');
      renderPlayers();
      return;
    }
    if(s.phase==='submitting'){
      show('mpSubmit');
      renderSubmission();
      return;
    }
    show('mpGame');
    renderGame();
  }

  function questionForState(){
    const deck=deckFor(state.category);
    return deck?.[state.questionIndex] || null;
  }

  function renderScores(final=false){
    const scores=state?.scores||{};
    const list=gamePlayers().sort((a,b)=>(scores[b.uid]||0)-(scores[a.uid]||0));
    if($('mpScores')) $('mpScores').innerHTML=list.map((p,i)=>`<div class="scoreLine"><span>${final&&i===0?'👑 ':''}${esc(p.name)}</span><b>${scores[p.uid]||0} ${t('points')}</b></div>`).join('');
  }

  function renderGame(){
    if(!state) return;
    if(state.phase==='finished'){
      $('mpWho').textContent=t('gameFinished');
      $('mpTimer').textContent='🏆';
      $('mpQuestion').textContent=t('questionsPlayed',{count:state.totalQuestions||state.round});
      $('mpAnswers').innerHTML='';
      $('mpReveal').classList.add('hidden');
      $('mpContinueBtn').classList.toggle('hidden',!isHost);
      if(isHost) $('mpContinueBtn').textContent=t('backLobby');
      renderScores(true);
      $('mpStatus').textContent=isHost?t('finalHost'):t('finalGuest');
      $('mpGameMainMenu')?.classList.toggle('hidden',!isHost);
      clearInterval(tick); tick=null;
      return;
    }

    const q=questionForState();
    if(!q) return;
    const turnName=players.get(state.turnUid)?.name || state.playerNames?.[state.turnUid] || t('player');
    $('mpWho').textContent=t('turnQuestion',{name:turnName,round:state.round,total:state.totalQuestions||'?'});
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
    renderScores(false);

    if(state.phase==='reveal'){
      const ans=state.reveal?.answer||'?';
      const correct=state.reveal?.correctNames||[];
      $('mpReveal').innerHTML=t('correctAnswer',{answer:esc(ans),names:correct.length?correct.map(esc).join(', '):t('nobody')});
      $('mpStatus').textContent=isHost?t('discussHost'):t('discussGuest');
      $('mpContinueBtn')?.classList.toggle('hidden',!isHost);
      if(isHost) $('mpContinueBtn').textContent=(state.round>=state.totalQuestions)?t('showResults'):t('continue');
    } else {
      $('mpStatus').textContent=isOwner?t('ownerPrompt'):t('guessPrompt');
      $('mpContinueBtn')?.classList.add('hidden');
    }
    $('mpGameMainMenu')?.classList.toggle('hidden',!isHost);
    startTimer();
  }

  function startTimer(){
    clearInterval(tick); tick=null;
    if(!state || state.phase!=='answering'){ if($('mpTimer')) $('mpTimer').textContent='✓'; return; }
    const update=()=>{
      const sec=Math.max(0,Math.ceil((state.deadline-now())/1000));
      $('mpTimer').textContent=sec;
      if(sec<=0 && isHost){ clearInterval(tick); finishRound(); }
    };
    update();
    tick=setInterval(update,250);
  }

  function submitChoice(letter,isOwner){
    if(!state || state.phase!=='answering') return;
    state.clientSelections=state.clientSelections||{};
    if(state.clientSelections[uid]) return;
    state.clientSelections[uid]=letter;
    renderGame();
    if(isOwner) send('owner_answer',{uid,letter,round:state.round});
    else send('guess',{uid,letter,round:state.round});
  }

  function receiveGuess(p){
    if(!state || p.round!==state.round || state.phase!=='answering') return;
    if(!state.playerOrder?.includes(p.uid) || p.uid===state.turnUid) return;
    guesses.set(p.uid,p.letter);
    checkEarlyFinish();
  }

  function receiveOwnerAnswer(p){
    if(!state || p.round!==state.round || p.uid!==state.turnUid || state.phase!=='answering') return;
    ownerAnswer=p.letter;
    checkEarlyFinish();
  }

  function checkEarlyFinish(){
    if(!isHost || !ownerAnswer) return;
    const others=gamePlayers().filter(p=>p.uid!==state.turnUid);
    if(others.length && others.every(p=>guesses.has(p.uid))) finishRound();
  }

  function finishRound(){
    if(!isHost || !state || state.phase!=='answering') return;
    const answer=ownerAnswer || '—';
    let correct=0, names=[];
    if(ownerAnswer){
      for(const [pid,g] of guesses){
        if(g===ownerAnswer){
          state.scores[pid]=(state.scores[pid]||0)+1;
          correct++;
          names.push(players.get(pid)?.name || state.playerNames?.[pid] || t('player'));
        }
      }
      state.scores[state.turnUid]=(state.scores[state.turnUid]||0)+correct;
    }
    state.phase='reveal';
    state.reveal={answer,correctNames:names};
    state.deadline=null;
    broadcastState();
  }

  function nextRound(){
    if(!isHost || !state) return;
    if((state.round||0)>=(state.totalQuestions||10)){
      state.phase='finished'; state.deadline=null; state.reveal=null; state.clientSelections={};
      broadcastState();
      return;
    }
    const arr=gamePlayers();
    if(arr.length<2) return;
    const currentIndex=Math.max(0,arr.findIndex(p=>p.uid===state.turnUid));
    const next=arr[(currentIndex+1)%arr.length];
    state.round=(state.round||0)+1;
    state.turnUid=next.uid;
    state.questionIndex=state.category===CUSTOM ? state.round-1 : nextRandomQuestion(state.category);
    state.phase='answering';
    state.deadline=now()+((state.roundSeconds||30)*1000);
    state.reveal=null;
    state.clientSelections={};
    guesses.clear(); ownerAnswer=null;
    broadcastState();
  }

  function cleanCustomQuestions(input){
    if(!Array.isArray(input) || input.length!==CUSTOM_PER_PLAYER) return null;
    const out=[];
    for(const row of input){
      if(!Array.isArray(row) || row.length<4) return null;
      const q=String(row[0]??'').trim().slice(0,180);
      const a=String(row[1]??'').trim().slice(0,80);
      const b=String(row[2]??'').trim().slice(0,80);
      const c=String(row[3]??'').trim().slice(0,80);
      if(q.length<5 || !a || !b || !c) return null;
      const unique=new Set([a,b,c].map(x=>x.toLocaleLowerCase()));
      if(unique.size!==3) return null;
      out.push([q,a,b,c]);
    }
    return out;
  }

  function resetCustomLocal(submissionId=null){
    customDraft=freshCustomDraft();
    customStep=0;
    customSubmissionId=submissionId;
    customSending=false;
    if($('customError')) $('customError').textContent='';
  }

  function readCustomInputs(rawOnly=false){
    const q=$('customQuestionInput')?.value.trim()||'';
    const a=$('customAnswerA')?.value.trim()||'';
    const b=$('customAnswerB')?.value.trim()||'';
    const c=$('customAnswerC')?.value.trim()||'';
    if(!rawOnly){
      if(q.length<5){ $('customError').textContent=t('customValidationQuestion'); return false; }
      if(!a||!b||!c){ $('customError').textContent=t('customValidationAnswers'); return false; }
      if(new Set([a,b,c].map(x=>x.toLocaleLowerCase())).size!==3){ $('customError').textContent=t('customValidationDistinct'); return false; }
    }
    customDraft[customStep]=[q,a,b,c];
    if($('customError')) $('customError').textContent='';
    return true;
  }

  function renderCustomStep(){
    if(!$('customEditor')) return;
    const row=customDraft[customStep]||['','','',''];
    $('customStepPill').textContent=`${customStep+1} / ${CUSTOM_PER_PLAYER}`;
    $('customQuestionInput').value=row[0]||'';
    $('customAnswerA').value=row[1]||'';
    $('customAnswerB').value=row[2]||'';
    $('customAnswerC').value=row[3]||'';
    $('customPrevBtn').disabled=customStep===0 || customSending;
    $('customNextBtn').disabled=customSending;
    $('customNextBtn').textContent=customStep===CUSTOM_PER_PLAYER-1?t('customSubmitAll'):t('customNext');
  }

  function customProgress(){
    const total=state?.customTotalPlayers || state?.playerOrder?.length || 0;
    const ready=Object.values(state?.customSubmitted||{}).filter(Boolean).length;
    return {ready,total,all:total>0 && ready>=total};
  }

  function renderSubmission(){
    if(!state || state.phase!=='submitting') return;
    if(customSubmissionId!==state.submissionId) resetCustomLocal(state.submissionId);

    $('mpSubmitMainMenu')?.classList.toggle('hidden',!isHost);
    const participant=state.playerOrder?.includes(uid);
    const submitted=!!state.customSubmitted?.[uid];
    const prog=customProgress();

    $('customReadyProgress').textContent=t('customReady',{ready:prog.ready,total:prog.total});
    $('customStartDeckBtn').classList.toggle('hidden',!(isHost && prog.all));

    if(!participant){
      $('customEditor').classList.add('hidden');
      $('customWaiting').classList.remove('hidden');
      $('customWaitingTitle').textContent=t('customNotParticipant');
      $('customWaitingText').textContent=t('customAllReadyGuest');
      return;
    }

    if(submitted){
      customSending=false;
      $('customEditor').classList.add('hidden');
      $('customWaiting').classList.remove('hidden');
      if(prog.all){
        $('customWaitingTitle').textContent=t('customWaitingTitle');
        $('customWaitingText').textContent=isHost?t('customAllReadyHost'):t('customAllReadyGuest');
      } else {
        $('customWaitingTitle').textContent=t('customWaitingTitle');
        $('customWaitingText').textContent=t('customWaitingText');
      }
      return;
    }

    $('customEditor').classList.remove('hidden');
    $('customWaiting').classList.add('hidden');
    renderCustomStep();
  }

  async function customNext(){
    if(!state || state.phase!=='submitting' || customSending || state.customSubmitted?.[uid]) return;
    if(!readCustomInputs(false)) return;
    if(customStep<CUSTOM_PER_PLAYER-1){
      customStep++;
      renderCustomStep();
      $('customQuestionInput')?.focus();
      return;
    }
    const cleaned=cleanCustomQuestions(customDraft);
    if(!cleaned){ $('customError').textContent=t('customValidationAnswers'); return; }
    customSending=true;
    $('customError').textContent=t('customSubmitting');
    renderCustomStep();
    try{
      await send('custom_submit',{uid,submissionId:state.submissionId,questions:cleaned});
    }catch(e){
      customSending=false;
      $('customError').textContent=e?.message||String(e);
      renderCustomStep();
    }
  }

  function customPrev(){
    if(customSending || customStep<=0) return;
    readCustomInputs(true);
    customStep--;
    renderCustomStep();
  }

  function receiveCustomSubmission(p){
    if(!isHost || !state || state.phase!=='submitting') return;
    if(p?.submissionId!==state.submissionId || !state.playerOrder?.includes(p.uid)) return;
    if(state.customSubmitted?.[p.uid]) return;
    const cleaned=cleanCustomQuestions(p.questions);
    if(!cleaned) return;
    customSubmissions.set(p.uid,cleaned);
    state.customSubmitted=state.customSubmitted||{};
    state.customSubmitted[p.uid]=true;
    state.customReady=Object.values(state.customSubmitted).filter(Boolean).length;
    broadcastState();
  }

  function startCustomDeck(){
    if(!isHost || !state || state.phase!=='submitting') return;
    const ids=state.playerOrder||[];
    if(!ids.length || !ids.every(id=>state.customSubmitted?.[id] && customSubmissions.get(id)?.length===CUSTOM_PER_PLAYER)){
      if($('customReadyProgress')) $('customReadyProgress').textContent=t('customNeedAll');
      return;
    }
    const all=[];
    ids.forEach(id=>customSubmissions.get(id).forEach(q=>all.push(q)));
    const deck=shuffleDeck(all);
    state.customDeck=deck;
    state.totalQuestions=deck.length;
    state.round=1;
    state.turnUid=ids[0];
    state.questionIndex=0;
    state.phase='answering';
    state.deadline=now()+((state.roundSeconds||30)*1000);
    state.clientSelections={};
    state.reveal=null;
    guesses.clear(); ownerAnswer=null; usedQuestions.clear();
    broadcastState();
  }

  function startGame(){
    if(!isHost) return;
    const arr=currentPlayers();
    if(arr.length<2){ $('lobbyStatus').textContent=t('minPlayers'); return; }

    state.category=$('mpCategory').value;
    state.language=lang();
    state.roundSeconds=selectedRoundSeconds;
    state.hostUid=uid;
    state.playerOrder=arr.map(p=>p.uid);
    state.playerNames=Object.fromEntries(arr.map(p=>[p.uid,p.name]));
    state.scores=Object.fromEntries(arr.map(p=>[p.uid,0]));
    state.turnUid=null;
    state.round=0;
    state.reveal=null;
    state.clientSelections={};
    guesses.clear(); ownerAnswer=null; usedQuestions.clear();

    if(state.category===CUSTOM){
      customSubmissions.clear();
      state.customSubmitted={};
      state.customReady=0;
      state.customTotalPlayers=arr.length;
      state.totalQuestions=arr.length*CUSTOM_PER_PLAYER;
      state.customDeck=[];
      state.submissionId=`${code()}-${now()}`;
      state.phase='submitting';
      state.deadline=null;
      resetCustomLocal(state.submissionId);
      broadcastState();
      return;
    }

    selectedQuestionCount=Math.max(1,Math.min(200,Number($('mpQuestionCount')?.value)||10));
    state.totalQuestions=selectedQuestionCount;
    state.round=1;
    state.turnUid=arr[0].uid;
    state.questionIndex=nextRandomQuestion(state.category);
    state.phase='answering';
    state.deadline=now()+(state.roundSeconds*1000);
    broadcastState();
  }

  async function endLocalSession(hostInitiated=false,message=''){
    const wasHost=isHost;
    clearInterval(tick); tick=null;
    if(hostInitiated && channel){ try{ await send('session_end',{}); }catch(e){} }
    try{ if(channel){ await channel.untrack(); await channel.unsubscribe(); if(sb?.removeChannel) await sb.removeChannel(channel); } }catch(e){}
    channel=null; lobbyCode=''; isHost=false; players.clear(); state=null; guesses.clear(); ownerAnswer=null; usedQuestions.clear(); customSubmissions.clear(); resetCustomLocal(null);
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
    try{
      myName=$('mpName').value.trim();
      if(!myName) return setHint(t('enterName'));
      setHint(t('connecting'));
      await connect(code(),true);
    }catch(e){ setHint(e.message||String(e)); }
  }

  async function joinLobby(){
    try{
      myName=$('mpName').value.trim();
      const c=$('joinCode').value.trim().toUpperCase();
      if(!myName) return setHint(t('enterName'));
      if(c.length<4) return setHint(t('enterCode'));
      setHint(t('connecting'));
      await connect(c,false);
    }catch(e){ setHint(e.message||String(e)); }
  }

  function clearRoundSpecificStateForLobby(){
    state.phase='lobby';
    state.round=0; state.turnUid=null; state.reveal=null; state.deadline=null; state.clientSelections={};
    state.customDeck=[]; state.customSubmitted={}; state.customReady=0; state.customTotalPlayers=0; state.submissionId=null;
    state.playerOrder=[]; state.playerNames={};
    state.scores=Object.fromEntries(currentPlayers().map(p=>[p.uid,0]));
    usedQuestions.clear(); guesses.clear(); ownerAnswer=null; customSubmissions.clear(); resetCustomLocal(null);
  }

  function init(){
    if($('mpConfigHint')) $('mpConfigHint').textContent=configured?t('mpReady'):t('mpMissing');
    updateLobbyModeUI();
  }

  $('createLobbyBtn')?.addEventListener('click',createLobby);
  $('showJoinBtn')?.addEventListener('click',()=>$('joinArea')?.classList.toggle('hidden'));
  $('joinLobbyBtn')?.addEventListener('click',joinLobby);
  $('mpStartGame')?.addEventListener('click',startGame);
  $('mpContinueBtn')?.addEventListener('click',()=>{
    if(!isHost || !state) return;
    if(state.phase==='reveal') nextRound();
    else if(state.phase==='finished'){
      clearRoundSpecificStateForLobby();
      broadcastState();
    }
  });
  $('mpLobbyMainMenu')?.addEventListener('click',hostMainMenu);
  $('mpSubmitMainMenu')?.addEventListener('click',hostMainMenu);
  $('mpGameMainMenu')?.addEventListener('click',hostMainMenu);
  $('customPrevBtn')?.addEventListener('click',customPrev);
  $('customNextBtn')?.addEventListener('click',customNext);
  $('customStartDeckBtn')?.addEventListener('click',startCustomDeck);
  $('mpCategory')?.addEventListener('change',()=>{
    if(!isHost) return;
    if(state?.phase==='lobby') state.category=$('mpCategory').value;
    updateLobbyModeUI();
  });

  document.querySelectorAll('#mpTimePicker .timeBtn').forEach(btn=>btn.addEventListener('click',()=>{
    if(!isHost) return;
    selectedRoundSeconds=Number(btn.dataset.time)||30;
    document.querySelectorAll('#mpTimePicker .timeBtn').forEach(b=>b.classList.toggle('active',b===btn));
    if(state?.phase==='lobby') state.roundSeconds=selectedRoundSeconds;
  }));

  $('mpQuestionCount')?.addEventListener('change',e=>{
    if(!isHost) return;
    selectedQuestionCount=Math.max(1,Math.min(200,Number(e.target.value)||10));
    if(state?.phase==='lobby') state.totalQuestions=selectedQuestionCount;
  });

  function refreshLanguage(){
    updateLobbyModeUI();
    if(state?.phase==='submitting') renderSubmission();
    else if(state?.phase && state.phase!=='lobby') renderGame();
    else if(state?.phase==='lobby') renderPlayers();
    else init();
  }

  function onLanguageChange(newLang){
    if(!state){ refreshLanguage(); return; }
    if(isHost && state.phase==='lobby'){ state.language=newLang; broadcastState(); return; }
    if(state.language && window.NLI18N?.lang!==state.language) window.NLI18N.setLanguage(state.language,false);
    refreshLanguage();
  }

  window.addEventListener('nolimits-language-change',e=>onLanguageChange(e.detail?.lang||lang()));
  window.NLMP={init,refreshLanguage};
})();
