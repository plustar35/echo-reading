#!/usr/bin/env node
/* 领读视频 · 单元管线 ② 配音 + 时间轴（重排后的地基）
 *
 * 只依赖【口播稿.md】，不读分镜。把口播稿里的旁白连成一条领读 → 一次性送 TTS（韵律自然、无拼接缝）
 * → 同时拿回【时间轴】(每段/每句第几秒) → 落两份产物到口播稿同目录：
 *   口播.tts.m4a      —— 一条口播音轨
 *   口播时间轴.json   —— totalMs / scrollReadyMs / blocks[] / cues[]（下游 align/分镜 都吃这份）
 *                       cues[] = 最细可得单元(edge=句级 / say=空)，名字叫 cues 不叫 words：中文只到句级。
 * 不再回写 durs（那是后续 align 步骤的事）。
 *
 * 用法： node scripts/gen-tts.js <口播稿.md 路径 或 章节目录>
 *        node scripts/gen-tts.js <书>/chNN                   # 给目录 → 自动找其中的 口播稿.md
 *        VOICE=zh-CN-YunxiNeural node scripts/gen-tts.js ...  # 换嗓
 *        RATE=-12% node ...                                   # 放慢
 *        ENGINE=say VOICE="Grandpa (Chinese (China mainland))" node ...  # 离线兜底（降级段级）
 *        SCROLL_READY_MS=6200 node ...                        # 卷轴铺好时刻(默认 6200)
 *
 * 引擎(ENGINE,默认 edge)： edge=Microsoft edge-tts 神经网络嗓(在线/免费/免key) ｜ say=macOS 内置(离线兜底)
 * 默认嗓：云健(浑厚男) zh-CN-YunjianNeural。
 *
 * 时间轴粒度（granularity）：
 *   - edge 引擎：实测中文 edge-tts(7.x) 只吐 SentenceBoundary、【没有 WordBoundary】，
 *     所以词级(方案 A)对中文不可用 → 走【句级】(按中文标点切句)，已比"按旁白段"更细。granularity="sentence"。
 *   - say 引擎：拿不到边界 → 降级【段级】，每个旁白段单独合成量时长。granularity="block"。
 */
const fs=require("fs"), cp=require("child_process"), path=require("path");
const {parseScript,clean,hashNarr}=require("./parse-script.js");

// ── 入参：口播稿.md 路径 或 章节目录 ───────────────────────────────────────
const IN=process.argv[2];
if(!IN){console.error("用法: node scripts/gen-tts.js <口播稿.md 路径 或 章节目录>");process.exit(1);}
let SCRIPT_ABS=path.resolve(IN);
if(fs.existsSync(SCRIPT_ABS)&&fs.statSync(SCRIPT_ABS).isDirectory()){
  SCRIPT_ABS=path.join(SCRIPT_ABS,"口播稿.md");
}
if(!fs.existsSync(SCRIPT_ABS)){console.error("找不到口播稿: "+SCRIPT_ABS);process.exit(1);}
const OUT_DIR=path.dirname(SCRIPT_ABS);
const AUDIO_OUT=path.join(OUT_DIR,"口播.tts.m4a");
const TIMELINE_OUT=path.join(OUT_DIR,"口播时间轴.json");

// 素材套配置：默认嗓 / 语速 / 看板时刻的单一来源（见 resolve-assets.js——env ASSETS 优先，
// 没给则按书名自动解析：恰好一套用它、多套报错让 agent 先问用户）。env VOICE/RATE 永远最优先。
let BOOK_CFG={};
{
  const {resolveAssetId,loadAssetConfig}=require("./resolve-assets.js");
  const m=SCRIPT_ABS.match(/\/video\/([^/]+)\//);
  try{ BOOK_CFG=loadAssetConfig(resolveAssetId(m&&m[1])); }
  catch(e){ console.error("✗ "+e.message); process.exit(1); }
}
const ENGINE=process.env.ENGINE||"edge";
const VOICE=process.env.VOICE||(ENGINE==="say"?"Grandpa (Chinese (China mainland))":(BOOK_CFG.voice||"zh-CN-YunjianNeural"));  // 浑厚男
const RATE=process.env.RATE||(ENGINE==="say"?"165":(BOOK_CFG.rate||"-8%"));
const PITCH=process.env.PITCH||"+0Hz";
const PAD=process.env.PAD||"0.18";
const SCROLL_READY_MS=parseInt(process.env.SCROLL_READY_MS||BOOK_CFG.scrollReadyMs||"6200",10);
const tmp=fs.mkdtempSync("/tmp/tts-");
const sh=c=>cp.execSync(c,{stdio:["ignore","pipe","pipe"]}).toString();
const durMs=f=>Math.round(parseFloat(sh(`ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "${f}"`))*1000);

// 口播稿 parse 契约：见 parse-script.js（gen-tts / align / draft 共用同一实现）。

// 中文切句：只在【终止标点 。！？!?】处断开，与 edge-tts 的 SentenceBoundary 切法一致
//（edge 不在 ； … —— ：处断句）。用于数出每段含几句，好把 edge 句级 cue 按数量贴回各段。
function splitSentences(text){
  const out=[]; let cur="";
  const enders=new Set(["。","！","？","!","?"]);
  for(const ch of text){
    cur+=ch;
    if(enders.has(ch)){ out.push(cur); cur=""; }
  }
  if(cur.trim()) out.push(cur);
  return out.map(s=>s.trim()).filter(Boolean);
}

// ── TTS 合成 ───────────────────────────────────────────────────────────────
function edgeSynth(text,base){            // 一次性合成整条领读 + 句级时间戳
  fs.writeFileSync(base+".txt",text);
  let ok=false;
  for(let a=1;a<=5&&!ok;a++){
    try{
      sh(`python3 - "${VOICE}" "${RATE}" "${PITCH}" "${base}.txt" "${base}.mp3" "${base}.subs.json" <<'PYEOF'
import sys, json, asyncio, edge_tts
voice, rate, pitch, txtf, mediaf, subf = sys.argv[1:7]
text = open(txtf, encoding="utf-8").read()
async def main():
    comm = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
    subs=[]
    with open(mediaf, "wb") as f:
        async for chunk in comm.stream():
            if chunk["type"]=="audio":
                f.write(chunk["data"])
            elif chunk["type"]=="SentenceBoundary":
                subs.append({"startMs": round(chunk["offset"]/10000),
                             "endMs": round((chunk["offset"]+chunk["duration"])/10000),
                             "text": chunk["text"]})
            elif chunk["type"]=="WordBoundary":
                subs.append({"startMs": round(chunk["offset"]/10000),
                             "endMs": round((chunk["offset"]+chunk["duration"])/10000),
                             "text": chunk["text"], "word": True})
    json.dump(subs, open(subf,"w",encoding="utf-8"), ensure_ascii=False)
asyncio.run(main())
PYEOF`);
      if(fs.existsSync(base+".mp3")&&fs.statSync(base+".mp3").size>0)ok=true;
    }catch(e){ process.stderr.write(`  retry ${a} (edge)\n`); try{sh(`sleep ${a}`);}catch(_){}}
  }
  if(!ok)throw new Error("edge-tts 反复失败");
  try{sh("sleep 0.3");}catch(_){}
  const subs=JSON.parse(fs.readFileSync(base+".subs.json","utf8"));
  return subs;
}
function saySynth(text,base){             // 离线兜底：单段合成，无边界
  fs.writeFileSync(base+".txt",text);
  sh(`say -v "${VOICE}" -r ${RATE} -f "${base}.txt" -o "${base}.aiff"`);
  // 统一成 mp3 便于后续，避免再开一格式分支
  sh(`ffmpeg -y -i "${base}.aiff" -ar 44100 -ac 1 "${base}.mp3" 2>/dev/null`);
}
function toM4a(srcMp3,outFile){
  sh(`ffmpeg -y -i "${srcMp3}" -af "apad=pad_dur=${PAD}" -ar 44100 -ac 1 -c:a aac -b:a 128k "${outFile}" 2>/dev/null`);
}
function concatMp3(mp3s,outMp3){
  const lst=path.join(tmp,"list.txt");
  fs.writeFileSync(lst,mp3s.map(f=>`file '${f}'`).join("\n"));
  sh(`ffmpeg -y -f concat -safe 0 -i "${lst}" -c copy "${outMp3}" 2>/dev/null`);
}

// 把 edge 句级 cue 按【句数】顺序贴回各旁白段：每段含 N 句(本地按终止标点数出)，就从 cue 列表里
// 取走 N 条；该段 start=首句 start，end=末句 end。比按字符数对齐稳——edge 偶尔吞掉引号字符，
// 句数却不变(它跟我们一样只在 。！？ 处断)。若 cue 数与句数总和不等，退而求其次按比例兜底。
function mapSentencesToBlocks(blocks,subs){
  const counts=blocks.map(b=>Math.max(1,splitSentences(clean(b)).length));
  const totalCount=counts.reduce((a,b)=>a+b,0);
  const out=[]; let si=0;
  // cue 总数与句数总和一致 → 干净的按数消费
  if(totalCount===subs.length){
    for(let bi=0;bi<blocks.length;bi++){
      const n=counts[bi];
      const first=subs[si], last=subs[si+n-1];
      out.push({idx:bi,text:blocks[bi],startMs:first.startMs,endMs:last.endMs});
      si+=n;
    }
    return out;
  }
  // 不一致(异常)→ 按"占总句数比例"切 cue 列表，保证单调不交叉
  process.stderr.write(`  ⚠ 句数(${totalCount})≠cue数(${subs.length})，改用比例对齐\n`);
  let acc=0;
  for(let bi=0;bi<blocks.length;bi++){
    const start=Math.round(acc/totalCount*subs.length);
    acc+=counts[bi];
    const end=Math.round(acc/totalCount*subs.length);
    const slice=subs.slice(Math.min(start,subs.length-1),Math.max(end,start+1));
    out.push({idx:bi,text:blocks[bi],
              startMs:slice[0]?slice[0].startMs:(out.length?out[out.length-1].endMs:0),
              endMs:slice[slice.length-1]?slice[slice.length-1].endMs:(out.length?out[out.length-1].endMs:0)});
  }
  return out;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
const md=fs.readFileSync(SCRIPT_ABS,"utf8");
const blocks=parseScript(md);
if(!blocks.length){console.error("口播稿里没解析到任何旁白段（首个 --- 之后的 > 行）");process.exit(1);}

// 每段旁白必须以句末标点收尾——各段直接相接送 TTS，缺句号会让句子跨段粘连、时间轴归属错位。
{
  const badEnd=blocks.map((t,i)=>({i,t})).filter(x=>!/[。！？!?]\s*$/.test(x.t));
  if(badEnd.length){
    console.error("✗ 以下旁白段不以句末标点（。！？）收尾，句子会跨段粘连、时间轴错位——补上标点再重跑：");
    badEnd.forEach(x=>console.error(`   · 第 ${x.i} 段结尾「…${x.t.slice(-12)}」`));
    process.exit(1);
  }
}

let granularity, cues=[], blockTimes, totalMs;

if(ENGINE==="say"){
  // 降级段级：逐段合成、量时长、累加成时间轴
  granularity="block";
  const mp3s=[]; const durs=[];
  blocks.forEach((txt,i)=>{
    const base=`${tmp}/blk_${String(i).padStart(2,"0")}`;
    saySynth(clean(txt),base);
    durs.push(durMs(base+".mp3")); mp3s.push(base+".mp3");
  });
  const combined=`${tmp}/combined.mp3`; concatMp3(mp3s,combined);
  toM4a(combined,AUDIO_OUT);
  let t=0; blockTimes=blocks.map((txt,i)=>{const startMs=t; t+=durs[i]; return {idx:i,text:txt,startMs,endMs:t};});
  totalMs=durMs(AUDIO_OUT);
}else{
  // edge：整条一次性合成 + 句级边界
  granularity="sentence";
  const wholeRaw=blocks.join("");            // 旁白连成一条（旁白本身已含句末标点，直接相接）
  const whole=clean(wholeRaw);
  const base=`${tmp}/whole`;
  const subs=edgeSynth(whole,base);
  toM4a(base+".mp3",AUDIO_OUT);
  totalMs=durMs(AUDIO_OUT);
  if(subs.length && !subs.some(s=>s.word)){
    // 句级：cues[] 装句级单元，blocks 从句对齐
    cues=subs.map(s=>({t:s.text,startMs:s.startMs,endMs:s.endMs}));
    blockTimes=mapSentencesToBlocks(blocks,subs);
  }else if(subs.length && subs.some(s=>s.word)){
    // 万一某天 edge 真给词级
    granularity="word";
    cues=subs.map(s=>({t:s.text,startMs:s.startMs,endMs:s.endMs}));
    blockTimes=mapSentencesToBlocks(blocks,subs);
  }else{
    // edge 没给边界（异常）→ 退成单块，整条一段
    granularity="block";
    blockTimes=[{idx:0,text:blocks.join(""),startMs:0,endMs:totalMs}];
  }
}

fs.rmSync(tmp,{recursive:true,force:true});

const timeline={
  totalMs,
  scrollReadyMs:SCROLL_READY_MS,
  narrHash:hashNarr(blocks),       // 口播稿指纹：align 用它发现「改了口播稿没重跑配音」
  engine:ENGINE, voice:VOICE, rate:RATE, granularity,
  cues,
  blocks:blockTimes,
};
fs.writeFileSync(TIMELINE_OUT,JSON.stringify(timeline,null,2));

// ── 控制台时间轴表 ─────────────────────────────────────────────────────────
const rel=p=>path.relative(process.cwd(),p);
const head=s=>{const t=s.replace(/\s+/g,"");return t.length>16?t.slice(0,16)+"…":t;};
console.log(`ENGINE=${ENGINE} VOICE="${VOICE}" RATE=${RATE}  粒度=${granularity}`);
console.log(`→ 音轨 ${rel(AUDIO_OUT)}   总时长 ${(totalMs/1000).toFixed(1)}s`);
console.log(`→ 时间轴 ${rel(TIMELINE_OUT)}   旁白 ${blockTimes.length} 段 / 句级单元 ${cues.length}`);
console.log("");
console.log("  #   起(s)   止(s)   旁白前十几字");
console.log("  ──  ──────  ──────  ──────────────────");
let scrollBlk=-1;
blockTimes.forEach(b=>{
  const cross=(b.startMs<SCROLL_READY_MS && b.endMs>=SCROLL_READY_MS);
  if(cross) scrollBlk=b.idx;
  console.log(`  ${String(b.idx).padStart(2)}  ${(b.startMs/1000).toFixed(2).padStart(6)}  ${(b.endMs/1000).toFixed(2).padStart(6)}  ${head(b.text)}${cross?"   ← scrollReadyMs 落在此段内":""}`);
});
console.log("");
const sr=(SCROLL_READY_MS/1000).toFixed(1);
if(scrollBlk>=0){
  const b=blockTimes[scrollBlk];
  console.log(`★ scrollReadyMs(${sr}s) 落在第 ${scrollBlk} 段内（该段 ${(b.startMs/1000).toFixed(2)}s → ${(b.endMs/1000).toFixed(2)}s，跨过它）`);
  console.log(`  → 卷轴 ${sr}s 铺好，但该段念到 ${(b.endMs/1000).toFixed(2)}s 才结束：中间 ${((b.endMs-SCROLL_READY_MS)/1000).toFixed(1)}s 卷轴空着（写分镜时要避开此空窗）`);
}else{
  const after=blockTimes.find(b=>b.startMs>=SCROLL_READY_MS);
  console.log(`★ scrollReadyMs(${sr}s) 落在段与段之间${after?`，下一段是第 ${after.idx} 段（${(after.startMs/1000).toFixed(2)}s 起）`:""}`);
}
