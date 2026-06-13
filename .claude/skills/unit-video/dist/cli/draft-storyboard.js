#!/usr/bin/env node
/* 领读视频 · 单元管线 ③ 起手 —— 从 口播稿 + 时间轴 生成新版 分镜.js 骨架。
 *
 * 脚本只做确定性工作：
 *   1. 读取口播稿和 TTS 时间轴。
 *   2. 生成全局 atoms[]，每个 atom 都是不可改写的口播文本锚点。
 *   3. 给出粗略 beats[] 骨架，beats/steps 都只通过 take 引用 atom id。
 *
 * agent 的工作不是从 atom 局部往上凑结构，而是先理解完整口播稿的叙事逻辑，
 * 再重拆 beat（白板页）和 step（语义推进），最后用 atom id 绑定时间。
 *
 * 用法： node dist/cli/draft-storyboard.js <单元目录 或 口播稿.md 路径>
 * 前置： 同目录已有 口播时间轴.json（先跑 gen-tts）。
 * 产出： 同目录 分镜.js（已存在则拒绝覆盖）。
 */
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const path = require("path");
const { parseScript, norm, hashNarr, buildCharStream } = require("../core/parse-script");
const { resolveAssetId, loadAssetConfig } = require("../core/assets");
const IN = process.argv[2];
if (!IN) {
    console.error("用法: node dist/cli/draft-storyboard.js <单元目录 或 口播稿.md>");
    process.exit(1);
}
let SCRIPT_ABS = path.resolve(IN);
if (fs.existsSync(SCRIPT_ABS) && fs.statSync(SCRIPT_ABS).isDirectory()) {
    SCRIPT_ABS = path.join(SCRIPT_ABS, "口播稿.md");
}
if (!fs.existsSync(SCRIPT_ABS)) {
    console.error("找不到口播稿: " + SCRIPT_ABS);
    process.exit(1);
}
const DIR = path.dirname(SCRIPT_ABS);
const TIMELINE_ABS = path.join(DIR, "口播时间轴.json");
const SB_OUT = path.join(DIR, "分镜.js");
if (!fs.existsSync(TIMELINE_ABS)) {
    console.error("同目录没有 口播时间轴.json —— 先跑 node dist/cli/gen-tts.js " + DIR + "/");
    process.exit(1);
}
if (fs.existsSync(SB_OUT)) {
    console.error("分镜.js 已存在，拒绝覆盖（要重起骨架请先移走或删除旧文件）: " + SB_OUT);
    process.exit(1);
}
const blocks = parseScript(fs.readFileSync(SCRIPT_ABS, "utf8"));
const timeline = JSON.parse(fs.readFileSync(TIMELINE_ABS, "utf8"));
if (timeline.narrHash && hashNarr(blocks) !== timeline.narrHash) {
    console.error("✗ 口播稿.md 与时间轴不一致（改了口播稿没重跑 gen-tts），先重出配音再起骨架。");
    process.exit(1);
}
const m = SCRIPT_ABS.match(/\/video\/([^/]+)\/(ch[^/]+)\/([^/]+)\//);
const BOOK = m ? m[1] : "TODO书名";
const CHAP = m ? m[2] : "chNN";
const UNIT = m ? m[3] : "NN";
let ASSET_ID;
try {
    ASSET_ID = resolveAssetId(m ? BOOK : null);
}
catch (e) {
    console.error("✗ " + e.message);
    process.exit(1);
}
const BOOK_CFG = loadAssetConfig(ASSET_ID);
const scrollReadyMs = (typeof BOOK_CFG.scrollReadyMs === "number" ? BOOK_CFG.scrollReadyMs : null) ??
    (typeof timeline.scrollReadyMs === "number" ? timeline.scrollReadyMs : null) ?? 6200;
const T0_BUFFER_MS = parseInt(process.env.T0_BUFFER_MS || "800", 10);
const threshold = scrollReadyMs + T0_BUFFER_MS;
const cues = Array.isArray(timeline.cues) ? timeline.cues : [];
const tblocks = Array.isArray(timeline.blocks) ? timeline.blocks : [];
const units = (timeline.granularity === "block" || cues.length === 0)
    ? tblocks.map(b => ({ t: b.text, startMs: b.startMs, endMs: b.endMs }))
    : cues;
if (!units.length) {
    console.error("时间轴里既无 cues 也无 blocks");
    process.exit(1);
}
const { G, leftEdge, rightEdge } = buildCharStream(units);
const CLAUSE = new Set(["，", "。", "、", "；", "：", "！", "？", "…", ",", ";", ":", "!", "?"]);
const ATOM_MIN_MS = parseInt(process.env.ATOM_MIN_MS || "2200", 10);
const ATOM_TARGET_MS = parseInt(process.env.ATOM_TARGET_MS || "6200", 10);
const ATOM_MAX_MS = parseInt(process.env.ATOM_MAX_MS || "9000", 10);
const PIECE_BREAKS = new Set(["。", "！", "？", "!", "?", "；", ";", "：", ":", "，", "、", ",", "…"]);
const STRONG_END = /[。！？!?；;：:…]\s*$/;
function msOf(g0, nlen) {
    if (!nlen)
        return 0;
    return Math.max(0, Math.round(rightEdge(g0 + nlen) - leftEdge(g0)));
}
function splitPieces(raw) {
    const pieces = [];
    let buf = "";
    for (const ch of [...raw]) {
        buf += ch;
        if (PIECE_BREAKS.has(ch)) {
            pieces.push(buf);
            buf = "";
        }
    }
    if (buf)
        pieces.push(buf);
    return pieces.length ? pieces : [raw];
}
function makeLocalAtoms(raw, gStart) {
    const pieces = splitPieces(raw).filter(Boolean);
    const atoms = [];
    let text = "";
    let nlen = 0;
    let localStart = 0;
    let consumed = 0;
    const flush = () => {
        if (!text)
            return;
        atoms.push({ narr: text, gStart: gStart + localStart, gLen: nlen });
        consumed += nlen;
        localStart = consumed;
        text = "";
        nlen = 0;
    };
    for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i];
        text += p;
        nlen += norm(p).length;
        const curDur = msOf(gStart + localStart, nlen);
        const nextLen = pieces[i + 1] ? norm(pieces[i + 1]).length : 0;
        const withNextDur = nextLen ? msOf(gStart + localStart, nlen + nextLen) : curDur;
        const shouldFlush = i === pieces.length - 1 ||
            (curDur >= ATOM_MIN_MS && STRONG_END.test(text)) ||
            curDur >= ATOM_TARGET_MS ||
            (curDur >= ATOM_MIN_MS && withNextDur > ATOM_MAX_MS);
        if (shouldFlush)
            flush();
    }
    if (text)
        flush();
    if (!atoms.length)
        atoms.push({ narr: raw, gStart, gLen: norm(raw).length });
    const merged = [];
    let mText = "";
    let mStart = atoms[0] ? atoms[0].gStart : gStart;
    let mLen = 0;
    const pushMerged = () => {
        if (!mText)
            return;
        merged.push({ narr: mText, gStart: mStart, gLen: mLen });
        mText = "";
        mLen = 0;
    };
    for (const a of atoms) {
        if (!mText) {
            mText = a.narr;
            mStart = a.gStart;
            mLen = a.gLen;
            continue;
        }
        const short = msOf(mStart, mLen) < ATOM_MIN_MS;
        if (short) {
            mText += a.narr;
            mLen += a.gLen;
        }
        else {
            pushMerged();
            mText = a.narr;
            mStart = a.gStart;
            mLen = a.gLen;
        }
    }
    pushMerged();
    return merged.length ? merged : atoms;
}
const globalAtoms = [];
function addAtoms(raw, gStart) {
    const local = makeLocalAtoms(raw, gStart);
    return local.map(a => {
        const id = "a" + String(globalAtoms.length + 1).padStart(3, "0");
        globalAtoms.push({ id, narr: a.narr, startMs: Math.round(leftEdge(a.gStart)), endMs: Math.round(rightEdge(a.gStart + a.gLen)) });
        return id;
    });
}
function makeBeat(tpl, seg, narr, startMs, endMs, gStart, note) {
    const ids = addAtoms(narr, gStart);
    const step = tpl === "T0" ? { take: ids } : { take: ids, state: {}, show: {} };
    return { tpl, seg, take: ids, startMs, endMs, note, steps: [step] };
}
const beats = [];
const warns = [];
let gc = 0;
let inOpening = true;
for (let bi = 0; bi < blocks.length; bi++) {
    const raw = blocks[bi];
    const len = norm(raw).length;
    if (!len)
        continue;
    const gStart = gc, gEnd = gc + len;
    if (G.slice(gStart, gEnd) !== norm(raw)) {
        console.error(`✗ 第 ${bi} 段旁白与时间轴字符流对不上（时间轴陈旧？）——重跑 gen-tts 再试。`);
        process.exit(1);
    }
    const startMs = Math.round(leftEdge(gStart)), endMs = Math.round(rightEdge(gEnd));
    if (inOpening && endMs <= threshold) {
        beats.push(makeBeat("T0", "片头", raw, startMs, endMs, gStart));
    }
    else if (inOpening && startMs < scrollReadyMs) {
        let cut = -1, cutG = -1;
        let p = 0;
        const chars = [...raw];
        for (let i = 0; i < chars.length - 1; i++) {
            if (norm(chars[i]).length)
                p++;
            if (CLAUSE.has(chars[i]) && p > 0 && p < len) {
                if (rightEdge(gStart + p) <= threshold) {
                    cut = i;
                    cutG = p;
                }
                else
                    break;
            }
        }
        if (cut >= 0) {
            const head = chars.slice(0, cut + 1).join("");
            const tail = chars.slice(cut + 1).join("").trim();
            const midMs = Math.round(rightEdge(gStart + cutG));
            beats.push(makeBeat("T0", "片头", head, startMs, midMs, gStart));
            beats.push(makeBeat("TODO", "片头", tail, midMs, endMs, gStart + cutG, "卷轴揭开的首拍；agent 先理解整体叙事，再选 T3/T2/T1 等模板"));
        }
        else {
            beats.push(makeBeat("TODO", "片头", raw, startMs, endMs, gStart, "这段骑过卷轴线但没找到可切的子句标点；改口播稿或在分镜中定切点"));
            warns.push(`第 ${bi} 段骑过 ${(scrollReadyMs / 1000).toFixed(1)}s 线但无合适切点，已整段标 TODO`);
        }
        inOpening = false;
    }
    else {
        inOpening = false;
        beats.push(makeBeat("TODO", "TODO", raw, startMs, endMs, gStart));
    }
    gc = gEnd;
}
const srcUnit = `books/${BOOK}/${CHAP}/${UNIT}.md`;
const fmt = ms => (ms / 1000).toFixed(1) + "s";
const lines = [];
lines.push(`/* ${BOOK} · ${CHAP}/${UNIT} · 分镜（draft-storyboard.js 生成的新版骨架）`);
lines.push(` * atoms[] 是机器生成的全局口播锚点，不要改 atoms[].narr。`);
lines.push(` * agent 必须先读完整口播稿，理解叙事结构，再重拆 beats/steps：`);
lines.push(` *   beat = 一页白板；step = 一页内的语义推进；take = 引用连续 atom id。`);
lines.push(` * 不要按 atom 粒度机械切 step；模板容量见 templates/<模板>/template.json。 */`);
lines.push(`const STORYBOARD = {`);
lines.push(`  book: ${JSON.stringify(BOOK)}, chapter: ${JSON.stringify(CHAP + "/" + UNIT)},`);
lines.push(`  assets: ${JSON.stringify(ASSET_ID || "TODO书名/素材id")},`);
lines.push(`  scrollTitle: ${JSON.stringify(`《${BOOK}》·${CHAP}`)},   // TODO: 改成卷轴右缘竖排小字`);
lines.push(`  audio: "口播.tts.m4a",`);
lines.push(``);
lines.push(`  jing: [   // TODO: 从 ${srcUnit} 原文拆句；{k,t}=可点亮短语，{p}=标点`);
lines.push(`    // { id:"s1", parts:[ {k:"a",t:"……"},{p:"。"} ] },`);
lines.push(`  ],`);
lines.push(``);
lines.push(`  atoms: [`);
globalAtoms.forEach(a => {
    lines.push(`    // ${fmt(a.startMs)} → ${fmt(a.endMs)}`);
    lines.push(`    { id:${JSON.stringify(a.id)}, narr:${JSON.stringify(a.narr)} },`);
});
lines.push(`  ],`);
lines.push(``);
lines.push(`  beats: [`);
beats.forEach(b => {
    lines.push(`    // ${fmt(b.startMs)} → ${fmt(b.endMs)} · ${b.take[0]}..${b.take[b.take.length - 1]}${b.note ? "   ◀ " + b.note : ""}`);
    lines.push(`    {`);
    lines.push(`      seg:${JSON.stringify(b.seg)}, tpl:${JSON.stringify(b.tpl)},`);
    lines.push(`      take:${JSON.stringify(b.take)},`);
    if (b.tpl !== "T0") {
        lines.push(`      base:{},   // TODO: T1 {sent:"s1"}；T2 {title:"..."}；T3 {glyph:"..."}；T4 {big:"..."}`);
    }
    lines.push(`      steps:[`);
    b.steps.forEach(s => {
        const body = `take:${JSON.stringify(s.take)}`;
        if (b.tpl === "T0")
            lines.push(`        { ${body} },`);
        else
            lines.push(`        { ${body}, state:{}, show:{} },   // TODO: 按语义结构重拆/合并；填高亮和摘要板书`);
    });
    lines.push(`      ],`);
    lines.push(`    },`);
});
lines.push(`  ],`);
lines.push(`  durs: [],`);
lines.push(`  stepDurs: [],`);
lines.push(`};`);
lines.push(`if (typeof window !== "undefined") window.STORYBOARD = STORYBOARD;`);
lines.push(`if (typeof module !== "undefined") module.exports = STORYBOARD;`);
fs.writeFileSync(SB_OUT, lines.join("\n") + "\n");
const rel = p => path.relative(process.cwd(), p);
console.log(`✓ 新版分镜骨架已生成 → ${rel(SB_OUT)}`);
console.log(`  atoms ×${globalAtoms.length} · 粗 beats ×${beats.length}：` +
    `T0 ×${beats.filter(b => b.tpl === "T0").length}，TODO ×${beats.filter(b => b.tpl === "TODO").length}`);
warns.forEach(w => console.log(`  ⚠ ${w}`));
console.log("");
console.log("  #   tpl   起(s)   止(s)   take");
beats.forEach((b, i) => {
    console.log(`  ${String(i).padStart(2)}  ${b.tpl.padEnd(4)}  ${(b.startMs / 1000).toFixed(2).padStart(6)}  ${(b.endMs / 1000).toFixed(2).padStart(6)}  ${b.take[0]}..${b.take[b.take.length - 1]}`);
});
console.log(`\n→ 接着先理解完整口播稿的叙事，再重拆 beats/steps，填完 node dist/cli/align-durs.js 校验。`);
