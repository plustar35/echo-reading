#!/usr/bin/env node
/* 领读视频 · 单元管线 ③ 的起手 —— 从 口播稿 + 时间轴 生成 分镜.js 骨架（draft）。
 *
 * 脚本管「机器能定的」：narr 按旁白段逐字切好（align 的字符流契约 by construction 满足）、
 * T0/非 T0 按 scrollReadyMs 预分、骑线段在最贴线的子句标点处句中切开（T0 贴边）、
 * 每拍标注真实起止秒。人/LLM 只填「要判断的」：选模板、拆经文、点亮锚、左看板。
 * 没填完的拍 tpl 是 "TODO"，align 会拒绝 → 半成品骨架渲不出去。
 *
 * 用法： node scripts/draft-storyboard.js <单元目录 或 口播稿.md 路径>
 * 前置： 同目录已有 口播时间轴.json（先跑 gen-tts.js）。
 * 产出： 同目录 分镜.js（已存在则拒绝覆盖，防止冲掉人审过的分镜）。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { parseScript, norm, hashNarr, buildCharStream } = require("./parse-script.js");

// ── 入参 ─────────────────────────────────────────────────────────────────────
const IN = process.argv[2];
if (!IN) { console.error("用法: node scripts/draft-storyboard.js <单元目录 或 口播稿.md>"); process.exit(1); }
let SCRIPT_ABS = path.resolve(IN);
if (fs.existsSync(SCRIPT_ABS) && fs.statSync(SCRIPT_ABS).isDirectory()) {
  SCRIPT_ABS = path.join(SCRIPT_ABS, "口播稿.md");
}
if (!fs.existsSync(SCRIPT_ABS)) { console.error("找不到口播稿: " + SCRIPT_ABS); process.exit(1); }
const DIR = path.dirname(SCRIPT_ABS);
const TIMELINE_ABS = path.join(DIR, "口播时间轴.json");
const SB_OUT = path.join(DIR, "分镜.js");
if (!fs.existsSync(TIMELINE_ABS)) {
  console.error("同目录没有 口播时间轴.json —— 先跑 node scripts/gen-tts.js " + DIR + "/");
  process.exit(1);
}
if (fs.existsSync(SB_OUT)) {
  console.error("分镜.js 已存在，拒绝覆盖（要重起骨架请先手动移走它）: " + SB_OUT);
  process.exit(1);
}

// ── 载入 + 陈旧检测 ──────────────────────────────────────────────────────────
const blocks = parseScript(fs.readFileSync(SCRIPT_ABS, "utf8"));
const timeline = JSON.parse(fs.readFileSync(TIMELINE_ABS, "utf8"));
if (timeline.narrHash && hashNarr(blocks) !== timeline.narrHash) {
  console.error("✗ 口播稿.md 与时间轴不一致（改了口播稿没重跑 gen-tts），先重出配音再起骨架。");
  process.exit(1);
}

// 书 / 章 / 单元从约定路径推：ROOT/video/<书>/chNN/NN/
const m = SCRIPT_ABS.match(/\/video\/([^/]+)\/(ch[^/]+)\/([^/]+)\//);
const BOOK = m ? m[1] : "TODO书名";
const CHAP = m ? m[2] : "chNN";
const UNIT = m ? m[3] : "NN";
// 素材套：env ASSETS 优先；没给则按书名自动解析（恰好一套用它、多套报错先问用户）
const { resolveAssetId, loadAssetConfig } = require("./resolve-assets.js");
let ASSET_ID;
try { ASSET_ID = resolveAssetId(m ? BOOK : null); }
catch (e) { console.error("✗ " + e.message); process.exit(1); }

// scrollReadyMs：素材套 配置.js > 时间轴 > 6200（与 align/renderer 一致；分镜骨架不写它）
const BOOK_CFG = loadAssetConfig(ASSET_ID);
const scrollReadyMs =
  (typeof BOOK_CFG.scrollReadyMs === "number" ? BOOK_CFG.scrollReadyMs : null) ??
  (typeof timeline.scrollReadyMs === "number" ? timeline.scrollReadyMs : null) ?? 6200;
const T0_BUFFER_MS = parseInt(process.env.T0_BUFFER_MS || "800", 10);
const threshold = scrollReadyMs + T0_BUFFER_MS;

// 时间轴匹配单元（句级 cues，say 兜底时段级 blocks）→ 字符流
const cues = Array.isArray(timeline.cues) ? timeline.cues : [];
const tblocks = Array.isArray(timeline.blocks) ? timeline.blocks : [];
const units = (timeline.granularity === "block" || cues.length === 0)
  ? tblocks.map(b => ({ t: b.text, startMs: b.startMs, endMs: b.endMs }))
  : cues;
if (!units.length) { console.error("时间轴里既无 cues 也无 blocks"); process.exit(1); }
const { G, leftEdge, rightEdge } = buildCharStream(units);

// ── 切 beats：每个旁白段一拍；骑过 scrollReadyMs 线的开场段在子句标点处句中切开 ──
const CLAUSE = new Set(["，", "。", "、", "；", "：", "！", "？", "…", ",", ";", ":", "!", "?"]);
const beats = [];   // {tpl, seg, narr, startMs, endMs, note}
const warns = [];
let gc = 0;          // 全局字符游标
let inOpening = true;

for (let bi = 0; bi < blocks.length; bi++) {
  const raw = blocks[bi];
  const len = norm(raw).length;
  if (!len) continue;
  const gStart = gc, gEnd = gc + len;
  if (G.slice(gStart, gEnd) !== norm(raw)) {
    console.error(`✗ 第 ${bi} 段旁白与时间轴字符流对不上（时间轴陈旧？）——重跑 gen-tts 再试。`);
    process.exit(1);
  }
  const startMs = Math.round(leftEdge(gStart)), endMs = Math.round(rightEdge(gEnd));

  if (inOpening && endMs <= threshold) {
    beats.push({ tpl: "T0", seg: "片头", narr: raw, startMs, endMs });
  } else if (inOpening && startMs < scrollReadyMs) {
    // 骑线段：找估时 ≤ 阈值、最贴线的子句标点切开（T0 贴边）；后半甩给卷轴首拍（建议 T3）
    let cut = -1, cutG = -1;
    let p = 0;                                     // 归一化前缀长度
    const chars = [...raw];
    for (let i = 0; i < chars.length - 1; i++) {   // 最后一个字符处不切（切了后半为空）
      if (norm(chars[i]).length) p++;
      if (CLAUSE.has(chars[i]) && p > 0 && p < len) {
        if (rightEdge(gStart + p) <= threshold) { cut = i; cutG = p; }
        else break;                                // 时间单调递增，越线即可停
      }
    }
    if (cut >= 0) {
      const head = chars.slice(0, cut + 1).join("");
      const tail = chars.slice(cut + 1).join("").trim();
      const midMs = Math.round(rightEdge(gStart + cutG));
      beats.push({ tpl: "T0", seg: "片头", narr: head, startMs, endMs: midMs });
      beats.push({
        tpl: "TODO", seg: "片头", narr: tail, startMs: midMs, endMs,
        note: "卷轴揭开的首拍——口播正落在题眼字上就用 T3(glyph)，否则 T2",
      });
    } else {
      beats.push({
        tpl: "TODO", seg: "片头", narr: raw, startMs, endMs,
        note: "这段骑过卷轴线但没找到可切的子句标点——考虑改口播稿或人工定切点",
      });
      warns.push(`第 ${bi} 段骑过 ${(scrollReadyMs / 1000).toFixed(1)}s 线但无合适切点，已整段标 TODO`);
    }
    inOpening = false;
  } else {
    inOpening = false;
    beats.push({ tpl: "TODO", seg: "TODO", narr: raw, startMs, endMs });
  }
  gc = gEnd;
}

// ── 生成 分镜.js 骨架 ────────────────────────────────────────────────────────
const srcUnit = `books/${BOOK}/${CHAP}/${UNIT}.md`;
const fmt = ms => (ms / 1000).toFixed(1) + "s";
const lines = [];
lines.push(`/* ${BOOK} · ${CHAP}/${UNIT} · 分镜（draft-storyboard.js 生成的骨架）`);
lines.push(` * narr 已按口播稿逐字切好（别改字——改字过不了 align；要改内容回口播稿重跑配音）。`);
lines.push(` * 待填：① jing 从 ${srcUnit} 第 1 段原文拆 {k,t}/{p}  ② 每拍 tpl 选 T1–T4 并补字段`);
lines.push(` *      ③ T1 拍给 hi 点亮锚 + aux 左看板  ④ seg 起段名。怎么填见 references/分镜与模板.md。`);
lines.push(` * 拍子可并可拆（拆点落子句标点）；tpl 留 "TODO" 的拍 align 会拒绝，填完才能渲。 */`);
lines.push(`const STORYBOARD = {`);
lines.push(`  book: ${JSON.stringify(BOOK)}, chapter: ${JSON.stringify(CHAP + "/" + UNIT)},`);
lines.push(`  assets: ${JSON.stringify(ASSET_ID || "TODO书名/素材id")},   // 素材套（SKILL/assets/ 下相对路径）`);
lines.push(`  scrollTitle: ${JSON.stringify(`《${BOOK}》·${CHAP}`)},   // TODO: 改成卷轴右缘竖排小字(如 道德經·第八章)`);
lines.push(`  audio: "口播.tts.m4a",`);
lines.push(``);
lines.push(`  jing: [   // TODO: 从 ${srcUnit} 原文拆句；{k,t}=可点亮短语，{p}=标点`);
lines.push(`    // { id:"s1", parts:[ {k:"a",t:"……"},{p:"。"} ] },`);
lines.push(`  ],`);
lines.push(``);
lines.push(`  beats: [`);
beats.forEach(b => {
  lines.push(`    // ${fmt(b.startMs)} → ${fmt(b.endMs)}${b.note ? "   ◀ " + b.note : ""}`);
  lines.push(`    { seg:${JSON.stringify(b.seg)}, tpl:${JSON.stringify(b.tpl)}, narr:${JSON.stringify(b.narr)} },`);
});
lines.push(`  ],`);
lines.push(`  durs: [],   // 留空，align-durs.js 回填`);
lines.push(`};`);
lines.push(`if (typeof window !== "undefined") window.STORYBOARD = STORYBOARD;`);
lines.push(`if (typeof module !== "undefined") module.exports = STORYBOARD;`);
fs.writeFileSync(SB_OUT, lines.join("\n") + "\n");

// ── 摘要 ─────────────────────────────────────────────────────────────────────
const rel = p => path.relative(process.cwd(), p);
console.log(`✓ 骨架已生成 → ${rel(SB_OUT)}`);
console.log(`  卷轴铺好 ${fmt(scrollReadyMs)}（阈值 +${T0_BUFFER_MS}ms）· 共 ${beats.length} 拍：` +
  `T0 ×${beats.filter(b => b.tpl === "T0").length}，TODO ×${beats.filter(b => b.tpl === "TODO").length}`);
warns.forEach(w => console.log(`  ⚠ ${w}`));
console.log("");
console.log("  #   tpl   起(s)   止(s)   narr 前十几字");
beats.forEach((b, i) => {
  const h = b.narr.replace(/\s+/g, "").slice(0, 14);
  console.log(`  ${String(i).padStart(2)}  ${b.tpl.padEnd(4)}  ${(b.startMs / 1000).toFixed(2).padStart(6)}  ${(b.endMs / 1000).toFixed(2).padStart(6)}  ${h}${b.narr.length > 14 ? "…" : ""}`);
});
console.log(`\n→ 接着照 references/分镜与模板.md 填模板/经文/点亮/看板，填完 node scripts/align-durs.js 校验。`);
