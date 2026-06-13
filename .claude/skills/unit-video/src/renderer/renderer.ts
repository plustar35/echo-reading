interface Window {
  STORYBOARD: any;
  BOOK_CONFIG?: any;
  __RENDER_TOTAL_MS?: number;
  __startRec?: () => void;
}

// ── 通用渲染器：从 ?data=<分镜.js 路径> 载入 STORYBOARD，全部内容由它驱动。 ──
  const qp=new URLSearchParams(location.search);
  const dataPath=qp.get('data');
  if(!dataPath){
    document.body.innerHTML='<p style="color:#f4eede;padding:24px;font-size:14px">用 ?data=&lt;分镜.js 路径&gt; 打开预览，例如 renderer.html?data=../../../../video/&lt;书&gt;/chNN/NN/分镜.js</p>';
  }else{
    const s=document.createElement('script');
    s.src=dataPath; s.onload=loadBookConfig;
    s.onerror=()=>{document.body.innerHTML='<p style="color:#f4eede;padding:24px;font-size:14px">分镜数据加载失败：'+dataPath+'</p>';};
    document.head.appendChild(s);
  }

  // 素材套配置（SKILL/assets/<素材id>/配置.js → window.BOOK_CONFIG）：几何/配色/时刻的单一来源。
  // 没有配置文件也照常跑（用缺省值）。
  function loadBookConfig(){
    const sb=window.STORYBOARD;
    const c=document.createElement('script');
    c.src=new URL("../assets/"+(sb.assets||sb.book)+"/配置.js",location.href).href;
    c.onload=init; c.onerror=init;
    document.head.appendChild(c);
  }

  function init(){
  const SB=window.STORYBOARD;
  const ATOM_BY_ID={};
  (Array.isArray(SB.atoms)?SB.atoms:[]).forEach(a=>{if(a&&a.id)ATOM_BY_ID[a.id]=a;});
  const narrOfTake=take=>Array.isArray(take)?take.map(id=>ATOM_BY_ID[id]&&ATOM_BY_ID[id].narr||'').join(''):'';
  const dataAbs=new URL(dataPath,location.href).href;
  const R=p=>new URL(p,dataAbs).href;            // 本章产物(音轨)：相对分镜.js 解析
  // 素材套：相对【本渲染器】(SKILL/runtime/) 解析到 SKILL/assets/<素材id>/（assets 缺省=book 同名套）。
  const A=name=>new URL("../assets/"+(SB.assets||SB.book)+"/"+name,location.href).href;

  // ── 一根时间轴：beats[] 顺着口播稿走，durs[] 是逐段配音时长（gen-tts 写回），配音 = 主时钟。 ──
  const BEATS=SB.beats, DURS=SB.durs||[], STEP_DURS=SB.stepDurs||[];
  BEATS.forEach(b=>{if(!b.narr&&Array.isArray(b.take))b.narr=narrOfTake(b.take);});
  BEATS.forEach((b,i)=>{
    b.dur=DURS[i]||4000;
    const steps=Array.isArray(b.steps)?b.steps:[];
    let sd=Array.isArray(STEP_DURS[i])?STEP_DURS[i].slice():[];
    if(steps.length){
      if(sd.length!==steps.length || sd.some(x=>!Number.isFinite(+x))){
        const each=b.dur/steps.length;
        sd=steps.map(()=>each);
      }
    }else{
      sd=[b.dur];
    }
    const sum=sd.reduce((a,x)=>a+(+x||0),0);
    if(sum>0 && Math.abs(sum-b.dur)>2){
      const k=b.dur/sum; sd=sd.map(x=>Math.max(0,Math.round(x*k)));
    }
    b._stepDurs=sd;
    b._stepStarts=[];{let acc=0;for(const d of sd){b._stepStarts.push(acc);acc+=d;}}
  });
  const TOTAL=BEATS.reduce((a,b)=>a+b.dur,0);
  const starts=[];{let acc=0;for(const b of BEATS){starts.push(acc);acc+=b.dur;}}

  // 看板在片头里【就绪】的时刻(ms)：此前看板还没铺好，只能走字幕(T0)、不往看板上写字；
  // 之后才往看板填内容。来源：分镜显式覆盖 > 书级配置.js > 6200（与 align-durs.js 一致）。
  const CFG=window.BOOK_CONFIG||{};
  const SCROLL_READY=SB.scrollReadyMs||CFG.scrollReadyMs||6200;

  // ── 书级配置 → CSS 变量：看板几何/章名位/字幕带/配色/字体微调，全部即数据即样式。 ──
  function varsFromConfig(c){
    const v={};
    if(c.board){v['--board-left']=c.board.left+'%';v['--board-top']=c.board.top+'%';
                v['--board-w']=c.board.width+'%';v['--board-h']=c.board.height+'%';}
    if(c.titlePos){v['--title-left']=c.titlePos.left+'%';v['--title-top']=c.titlePos.top+'%';}
    if(c.subtitle){v['--sub-side']=c.subtitle.side+'%';v['--sub-bottom']=c.subtitle.bottom+'%';}
    if(c.palette){const m={paper:'--paper',ink:'--ink',ink2:'--ink2',accent:'--cinnabar',gold:'--gold'};
                  for(const k in m)if(c.palette[k])v[m[k]]=c.palette[k];}
    Object.assign(v,c.tplVars||{});
    return v;
  }
  function applyVars(vars){
    for(const k in vars){
      if(vars[k]==null||vars[k]==='')document.documentElement.style.removeProperty(k);
      else document.documentElement.style.setProperty(k,vars[k]);
    }
  }
  applyVars(varsFromConfig(CFG));
  if(qp.get('bare')==='1')document.body.classList.add('bare');
  // 片头视频时长(ms)：纯视觉——播完淡出露出背景循环，不参与内容时间轴（仅预览模式用）。
  const INTRO_VIDEO_MS=SB.introVideoMs||CFG.introVideoMs||8000;

  const recordMode=qp.get('record')==='1';

  const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
  const stage=$('#stage'),intro=$('#intro'),bgloop=$('#bgloop'),bodyLayer=$('#body'),fill=$('#fill');
  const playBtn=$('#play'),slabel=$('#slabel'),dotsWrap=$('#dots');
  const sub=$('#sub'),subTxt=$('#subtxt');
  const jingEl=$('#jing'),auxEl=$('#aux'),centerEl=$('#center');

  // 章节专属内容：章名、经文 DOM、媒体、音轨 —— 全部按 STORYBOARD 注入
  $('#title').innerHTML='<b>'+SB.book+'</b> · '+SB.chapter;
  $('#scrollTitle').textContent=SB.scrollTitle||'';
  $('#hint').innerHTML='通用渲染器 · 数据：<code>'+dataPath+'</code><br>右上「显示填字区」看卷轴分区；'
    +'<code>?beat=N</code> 跳分镜静帧、<code>?record=1</code> 离屏渲染模式。';
  SB.jing.forEach(sj=>{
    const sent=document.createElement('div');sent.className='sent';sent.dataset.s=sj.id;
    const cols=document.createElement('div');cols.className='cols';
    sj.parts.forEach(pt=>{const sp=document.createElement('span');
      if(pt.k!==undefined){sp.className='ph';sp.dataset.k=pt.k;sp.textContent=pt.t;}
      else{sp.className='punc';sp.textContent=pt.p;}
      cols.appendChild(sp);});
    sent.appendChild(cols);jingEl.appendChild(sent);
  });
  const sents={};$$('.sent').forEach(s=>sents[s.dataset.s]=s);

  if(!recordMode){                               // 播放模式才挂底图/视频；渲染模式保持透明
    intro.src=A("片头.mp4");
    bgloop.src=A("背景循环.mp4"); bgloop.poster=A("底板.png");
    stage.style.backgroundImage="url('"+A("底板.png")+"')";
  }
  const audio=new Audio(R(SB.audio));            // 单条口播音轨 = 主时钟

  // ── 字幕单行分段 ──
  function splitSubtitle(text,maxLen=18){
    const lines=[];
    const sentences=text.split(/(?<=[。！？；!?;])/).filter(s=>s.trim());
    for(const sent of sentences){
      const clauses=sent.split(/(?<=[，、：,:])|(?<=——)/).filter(s=>s.trim());
      let cur="";
      for(const c of clauses){
        if(c.length>maxLen){
          if(cur){lines.push(cur);cur="";}
          for(let j=0;j<c.length;j+=maxLen)lines.push(c.slice(j,j+maxLen));
        }else if(!cur){cur=c;}
        else if((cur+c).length<=maxLen){cur+=c;}
        else{lines.push(cur);cur=c;}
      }
      if(cur)lines.push(cur);
    }
    return lines.map(l=>l.replace(/(——|[，、；：,;:])$/,"")).filter(Boolean);
  }
  BEATS.forEach(b=>b._subs=splitSubtitle(b.narr));

  const segs=[];BEATS.forEach((b,i)=>{if(!segs.length||segs[segs.length-1].name!==b.seg)segs.push({name:b.seg,i});});
  segs.forEach(sg=>{const d=document.createElement('div');d.className='dot';d.textContent=sg.name;d.onclick=()=>playFrom(starts[sg.i]);dotsWrap.appendChild(d);});
  const dots=[...dotsWrap.children];

  let playing=false,t=0,cur=-1,curStep=-1,introGone=false,activeSent=null;

  function setSub(txt){subTxt.textContent=txt;sub.classList.remove('on');void sub.offsetWidth;sub.classList.add('on');}

  const asArr=x=>Array.isArray(x)?x:(x==null?[]:[x]);
  function popNodes(nodes,instant){
    if(!nodes.length)return;
    if(instant){nodes.forEach(n=>n.classList.add('in'));return;}
    void nodes[0].parentElement.offsetWidth;
    nodes.forEach(n=>n.classList.add('in'));
  }
  function showSent(sent,on=true){
    Object.values(sents).forEach((s:any)=>s.classList.toggle('on',on && s.dataset.s===sent));
    activeSent=on?sent:null;
  }
  function applyHighlight(sent,hi){
    $$('.ph').forEach(p=>{p.classList.remove('hi','dim');p.style.transitionDelay='0s';});
    if(!sent||!sents[sent]||hi==null)return;
    const lit=Array.isArray(hi)?hi:[];
    sents[sent].querySelectorAll('.ph').forEach((p,k)=>{
      if(hi==='sweep'){p.style.transitionDelay=(k*0.5)+'s';p.classList.add('hi');}
      else{const on=lit.includes(p.dataset.k);p.classList.toggle('hi',on);p.classList.toggle('dim',lit.length>0&&!on);}
    });
  }
  function auxItemsFromLegacy(a){
    if(!a)return[];
    if(Array.isArray(a))return a;
    const out=[];
    if(a.head)out.push({kind:'head',text:a.head});
    (a.gloss||[]).forEach(g=>out.push({kind:'gloss',z:g.z,p:g.p,m:g.m}));
    (a.points||[]).forEach(p=>out.push({kind:'point',text:p}));
    return out;
  }
  function ensureAuxSlots(){
    if(!auxEl.querySelector('.aux-head-slot')){
      auxEl.innerHTML='';
      ['head','body'].forEach(k=>{
        const slot=document.createElement('div');
        slot.className=`aux-slot aux-${k}-slot`;
        slot.dataset.slot=k;
        auxEl.appendChild(slot);
      });
    }
    return {
      head: auxEl.querySelector('.aux-head-slot'),
      body: auxEl.querySelector('.aux-body-slot')
    };
  }
  function appendAux(items,instant=false){
    const nodes=[];
    const slots=ensureAuxSlots();
    auxItemsFromLegacy(items).forEach((it,idx)=>{
      let el=document.createElement('div');el.className='aux-item';
      el.style.setProperty('--d',(idx*0.28).toFixed(2)+'s');
      const kind=it.kind||it.type||(it.z?'gloss':it.head?'head':'point');
      if(kind==='head'){
        el.classList.add('aux-head');el.innerHTML=it.text||it.head||'';
      }else if(kind==='gloss'){
        el.classList.add('aux-gloss');
        el.innerHTML=`<b>${it.z||''}</b>${it.p?`<small>${it.p}</small>`:""}<span class="m">${it.m||it.text||''}</span>`;
      }else{
        el.classList.add('aux-pt');el.innerHTML=it.text||it.m||'';
      }
      const slot=kind==='head'?slots.head:slots.body;
      slot.appendChild(el);nodes.push(el);
    });
    popNodes(nodes,instant);
  }
  function ensureCenterSlots(){
    if(!centerEl.querySelector('.center-title-slot')){
      centerEl.innerHTML='';
      ['title','lead'].forEach(k=>{
        const slot=document.createElement('div');
        slot.className=`center-${k}-slot`;
        slot.dataset.slot=k;
        centerEl.appendChild(slot);
      });
    }
    return {
      title: centerEl.querySelector('.center-title-slot'),
      lead: centerEl.querySelector('.center-lead-slot')
    };
  }
  function centerItem(kind,text,delay){
    const el=document.createElement('div');
    const k=kind||'lead';
    if(k==='title')el.className='c-title';
    else if(k==='glyph')el.className='c-glyph';
    else if(k==='big')el.className='c-big';
    else el.className='c-lead';
    el.style.setProperty('--d',(delay||0).toFixed(2)+'s');
    el.innerHTML=text||'';
    return el;
  }
  function appendCenter(items,instant=false,tpl=null){
    const nodes=[];
    const slots=tpl==='T2'?ensureCenterSlots():null;
    asArr(items).forEach((it,idx)=>{
      if(!it)return;
      const obj=typeof it==='string'?{kind:'lead',text:it}:it;
      const el=centerItem(obj.kind||obj.type,obj.text||obj.value||'',idx*0.32);
      if(slots){
        const kind=obj.kind||obj.type||'lead';
        const slot=kind==='title'?slots.title:slots.lead;
        slot.appendChild(el);
      }else{
        centerEl.appendChild(el);
      }
      nodes.push(el);
    });
    popNodes(nodes,instant);
  }
  function appendCenterShow(show,instant=false,tpl=null){
    if(!show)return;
    const items=[];
    if(tpl==='T2'){
      const titleItems=[], leadItems=[];
      asArr(show.center).forEach(x=>{
        const obj=typeof x==='string'?{kind:'lead',text:x}:x;
        if((obj.kind||obj.type)==='title')titleItems.push(obj);
        else leadItems.push(obj);
      });
      if(show.title)titleItems.push({kind:'title',text:show.title});
      asArr(show.lead).forEach(x=>leadItems.push({kind:'lead',text:x}));
      if(show.note)leadItems.push({kind:'lead',text:show.note});
      items.push(...titleItems,...leadItems);
    }else{
      asArr(show.center).forEach(x=>items.push(x));
      if(show.title)items.push({kind:'title',text:show.title});
      if(show.glyph)items.push({kind:'glyph',text:show.glyph});
      asArr(show.lead).forEach(x=>items.push({kind:'lead',text:x}));
      if(show.note)items.push({kind:'lead',text:show.note});
      asArr(show.big).forEach(x=>items.push({kind:'big',text:x}));
    }
    appendCenter(items,instant,tpl);
  }
  function resetBeatVisual(b){
    const base=b.base||{}, hasSteps=Array.isArray(b.steps)&&b.steps.length;
    const useScroll=b.tpl==='T1', useCenter=b.tpl==='T2'||b.tpl==='T3'||b.tpl==='T4';
    $('#jing').classList.toggle('show',useScroll);
    auxEl.classList.toggle('show',useScroll);
    centerEl.classList.toggle('show',useCenter);
    auxEl.innerHTML='';centerEl.innerHTML='';
    if(useScroll)ensureAuxSlots();
    if(b.tpl==='T2')ensureCenterSlots();
    $$('.ph').forEach(p=>p.classList.remove('hi','dim'));
    showSent(null,false);
    activeSent=null;
    if(useScroll){
      const sent=base.sent||b.sent;
      if(sent)showSent(sent,true);
      appendAux(base.aux, true);
      if(!hasSteps)appendAux(b.aux, true);
      applyHighlight(sent, base.hi!==undefined?base.hi:(!hasSteps?b.hi:null));
    }
    if(useCenter){
      const baseItems=[];
      if(b.tpl==='T2'){
        const title=base.title||b.title;
        if(title)baseItems.push({kind:'title',text:title});
      }else if(b.tpl==='T3'){
        const glyph=base.glyph||b.glyph;
        if(glyph)baseItems.push({kind:'glyph',text:glyph});
      }else if(b.tpl==='T4'){
        const big=base.big||(!hasSteps?b.big:null);
        if(big)baseItems.push({kind:'big',text:big});
      }
      appendCenter(baseItems,true,b.tpl);
    }
    curStep=-1;
  }
  function stepAt(i,time){
    const b=BEATS[i],local=Math.max(0,time-starts[i]),ss=b._stepStarts||[];
    let si=ss.length?0:-1;
    for(let k=0;k<ss.length;k++)if(local>=ss[k])si=k;
    return si;
  }
  function applyOneStep(b,s,instant=false){
    if(!s)return;
    const state=s.state||{},show=s.show||{};
    if(b.tpl==='T1'){
      if(state.sent)showSent(state.sent,true);
      if(state.sent && state.hi===undefined)applyHighlight(activeSent,null);
      if(state.hi!==undefined)applyHighlight(activeSent,state.hi);
      appendAux(show.aux,instant);
    }else if(b.tpl==='T2'||b.tpl==='T3'||b.tpl==='T4'){
      appendCenterShow(show,instant,b.tpl);
    }
  }
  function updateStep(){
    const b=BEATS[cur];if(!b)return;
    const steps=Array.isArray(b.steps)?b.steps:[];
    if(!steps.length)return;
    const si=stepAt(cur,t);
    if(si<0||si===curStep)return;
    if(si<curStep){resetBeatVisual(b);for(let k=0;k<=si;k++)applyOneStep(b,steps[k],true);}
    else{for(let k=curStep+1;k<=si;k++)applyOneStep(b,steps[k],k<si);}
    curStep=si;
    slabel.textContent=`${cur+1}/${BEATS.length} · ${b.tpl} · ${b.seg} · step ${si+1}/${steps.length}`;
  }

  // 切到第 i 个分镜：只放 base；具体板书由 updateStep 按 stepDurs 渐进推进。
  function applyBeat(i){
    if(i===cur)return;cur=i;const b=BEATS[i];
    resetBeatVisual(b);
    dots.forEach(d=>d.classList.remove('cur'));
    let sg=0;segs.forEach((s,k)=>{if(i>=s.i)sg=k;});dots[sg]&&dots[sg].classList.add('cur');
    slabel.textContent=`${i+1}/${BEATS.length} · ${b.tpl} · ${b.seg}`;
  }
  const beatAt=time=>{let i=0;for(let k=0;k<starts.length;k++)if(time>=starts[k])i=k;return i;};
  function subAt(time){
    const i=beatAt(time),b=BEATS[i],lines=b._subs;
    if(lines.length<=1)return{key:i+'#0',line:lines[0]||''};
    const te=time-starts[i],total=lines.reduce((a,l)=>a+l.length,0);
    let acc=0;
    for(let k=0;k<lines.length;k++){
      const w=b.dur*(lines[k].length/total);
      if(te<acc+w||k===lines.length-1)return{key:i+'#'+k,line:lines[k]};
      acc+=w;
    }
  }
  function updateSub(){const s=subAt(t);if(sub.dataset.key!==s.key){sub.dataset.key=s.key;setSub(s.line);}}
  // 卷轴可见性：当前分镜非 T0、且已过卷轴铺好时刻，才显出卷轴层（CSS .6s 淡入）。
  function updateScroll(){const b=BEATS[cur];bodyLayer.classList.toggle('show', !!b && b.tpl!=='T0' && t>=SCROLL_READY);}
  // 片头视频纯视觉：到点淡出露循环（渲染模式 intro 隐藏，无关紧要）。
  function updateIntro(){if(!introGone && t>=INTRO_VIDEO_MS){introGone=true;intro.classList.add('gone');}}
  function render(){applyBeat(beatAt(t));updateStep();updateSub();updateScroll();updateIntro();fill.style.width=(t/TOTAL*100)+'%';}

  // ── 播放（预览）：音轨是时钟；片头视频/循环只是并行播放的视觉。 ──
  function frame(){if(!playing)return;
    t=audio.currentTime*1000;
    if(t>=TOTAL){t=TOTAL;render();playing=false;intro.pause();bgloop.pause();playBtn.textContent='↺ 重播';return;}
    render();requestAnimationFrame(frame);}
  function playFrom(ms){
    t=Math.max(0,Math.min(TOTAL-1,ms||0));cur=-1;sub.dataset.key='';
    try{audio.currentTime=t/1000;}catch(e){}
    if(t<INTRO_VIDEO_MS){introGone=false;intro.classList.remove('gone');try{intro.currentTime=t/1000;}catch(e){}if(!recordMode)intro.play().catch(()=>{});}
    else{introGone=true;intro.classList.add('gone');}
    if(!recordMode)bgloop.play().catch(()=>{});
    audio.play();playing=true;playBtn.textContent='❚❚ 暂停';render();requestAnimationFrame(frame);
  }
  function pause(){playing=false;audio.pause();intro.pause();bgloop.pause();playBtn.textContent='▶ 继续';}

  audio.addEventListener('ended',()=>{t=TOTAL;render();playing=false;intro.pause();bgloop.pause();playBtn.textContent='↺ 重播';});

  playBtn.onclick=()=>{
    if(playing){pause();return;}
    if(t>=TOTAL){playFrom(0);return;}
    playFrom(t);
  };
  $('#restart').onclick=()=>playFrom(0);
  $('#zoneToggle').onchange=e=>stage.classList.toggle('show-zone',e.target.checked);

  // 配置台(init-studio)实时推参：iframe 嵌本渲染器时 postMessage 改 CSS 变量，即调即看。
  if(!recordMode){
    window.addEventListener('message',e=>{
      const d=e.data||{};
      if(d.type==='unitVideoVars')applyVars(d.vars||{});
    });
  }

  if(qp.get('zone')==='1'){$('#zoneToggle').checked=true;stage.classList.add('show-zone');}
  if(qp.get('auto')==='1')playFrom(0);
  if(qp.has('beat')){                            // 静帧预览：跳到某分镜（非 T0 的卷轴内容确保可见）
    const i=Math.max(0,Math.min(BEATS.length-1,+qp.get('beat')));
    const b=BEATS[i],steps=Array.isArray(b.steps)?b.steps:[];
    const stepParam=qp.get('step');
    let stepOffset=0;
    if(stepParam!=null&&steps.length){
      const si=stepParam==='last'?steps.length-1:Math.max(0,Math.min(steps.length-1,+stepParam));
      stepOffset=(b._stepStarts&&b._stepStarts[si]||0)+1;
    }
    introGone=true;intro.classList.add('gone');
    t=BEATS[i].tpl==='T0'?starts[i]+stepOffset:Math.max(starts[i]+stepOffset,SCROLL_READY);
    cur=-1;render();
    if(qp.get('play')==='1')playFrom(t);
  }

  // ── 渲染模式（?record=1）：纯叠层，时钟 = performance.now()（受 CDP 虚拟时间逐帧推进，
  //    所以点亮/注释/字幕/卷轴淡入都按虚拟时间演进，可被离屏逐帧截图捕捉）。不依赖音频/视频。
  //    整条只有一根时间轴 = TOTAL（= 口播 TTS 时长）；卷轴在 SCROLL_READY 自动揭开。 ──
  if(recordMode){
    document.body.classList.add('rec');
    intro.style.display='none';bgloop.style.display='none';
    window.__RENDER_TOTAL_MS=TOTAL;
    let t0=null;
    function recFrame(){
      const now=performance.now();if(t0===null)t0=now;
      t=Math.min(now-t0,TOTAL);render();
      requestAnimationFrame(recFrame);
    }
    window.__startRec=function(){t0=null;cur=-1;sub.dataset.key='';requestAnimationFrame(recFrame);};
  }
  } // init
