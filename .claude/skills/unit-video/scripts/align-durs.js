#!/usr/bin/env node
/* 领读视频 · 单元管线 ③.5 对齐（align）—— 在「分镜 → 渲染」之间插的一道闸。
 *
 * 分镜写好后(beats 有 narr、有 tpl，但 durs 还空 / 是旧值)，用 gen-tts 产出的【时间轴】
 * 把每个 beat 的【真实时长】回填进 durs[]，并就地强校验关键规则——尤其
 *   「T0 模板不得越过卷轴铺好的时刻」：越界直接报错、非零退出，而不是默默渲出尬白片。
 *
 * 用法： node scripts/align-durs.js <分镜.js 路径>
 *        T0_BUFFER_MS=800 node ...           # 调 T0 校验缓冲(默认 800ms)
 *
 * 读同目录的【口播时间轴.json】(gen-tts 的产物)，依次：
 *   0a. 口播稿陈旧检测：口播稿指纹(narrHash)与时间轴不符 → 报错(先重跑 gen-tts)
 *   0b. schema lint：tpl 合法性、各模板必填字段、sent/hi 引用完整性
 *   a.  把 beats[].narr 沿字符流与时间轴(cues[])对齐、回填 durs[]（毫秒整数）；
 *       整句 beat 落在句边界 → bit-exact 取 cue 起止；句中切点 → 按字比例插值估时
 *   b.  校验 narr 顺序拼接 == 整条领读（覆盖契约），对不上 → 报错指出是哪个 beat
 *   c.  校验 T0 硬规则：任何 T0 的结束时刻不得越过 scrollReadyMs+buffer，否则报错
 *
 * 向后兼容：同目录【没有】口播时间轴.json → 跳过(沿用分镜已有 durs)，零退出。
 *
 * 时间轴 schema（见 gen-tts.js）：
 *   { totalMs, scrollReadyMs, engine, voice, rate, granularity:"sentence|block",
 *     cues:[{t,startMs,endMs}],     // 句级；say 离线引擎(granularity:"block")时为 []
 *     blocks:[{idx,text,startMs,endMs}] }   // 各旁白段，必有
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { parseScript, norm, hashNarr, buildCharStream } = require("./parse-script.js");

// ── 入参 ─────────────────────────────────────────────────────────────────────
const SB_IN = process.argv[2];
if (!SB_IN) {
  console.error("用法: node scripts/align-durs.js <分镜.js 路径>");
  process.exit(1);
}
const SB_ABS = path.resolve(SB_IN);
if (!fs.existsSync(SB_ABS)) {
  console.error("找不到分镜: " + SB_ABS);
  process.exit(1);
}
const CH_DIR = path.dirname(SB_ABS);
const TIMELINE_ABS = path.join(CH_DIR, "口播时间轴.json");
const T0_BUFFER_MS = parseInt(process.env.T0_BUFFER_MS || "800", 10);

const rel = p => path.relative(process.cwd(), p);

// ── 向后兼容：无时间轴 → 跳过 ───────────────────────────────────────────────
if (!fs.existsSync(TIMELINE_ABS)) {
  console.log(`· 无时间轴(${rel(TIMELINE_ABS)} 不存在)，跳过 align(沿用现有 durs)`);
  process.exit(0);
}

// ── 载入分镜 + 时间轴 ────────────────────────────────────────────────────────
let SB;
try {
  SB = require(SB_ABS);
} catch (e) {
  console.error("无法 require 分镜: " + SB_ABS + "\n  " + e.message);
  process.exit(1);
}
let timeline;
try {
  timeline = JSON.parse(fs.readFileSync(TIMELINE_ABS, "utf8"));
} catch (e) {
  console.error("无法解析时间轴 JSON: " + TIMELINE_ABS + "\n  " + e.message);
  process.exit(1);
}

const beats = Array.isArray(SB.beats) ? SB.beats : null;
if (!beats || !beats.length) {
  console.error("分镜里没有 beats[]");
  process.exit(1);
}

// 句级单元 cues(gen-tts 句级产物)；cues 为空(say 离线=段级)→ 降级用 blocks 作匹配单元
const cues = Array.isArray(timeline.cues) ? timeline.cues : [];
const blocks = Array.isArray(timeline.blocks) ? timeline.blocks : [];
const totalMs = timeline.totalMs;

const isBlockLevel = timeline.granularity === "block" || cues.length === 0;
const units = isBlockLevel
  ? blocks.map(b => ({ t: b.text, startMs: b.startMs, endMs: b.endMs }))
  : cues;
const unitLabel = isBlockLevel ? "段级(blocks)" : "句级(cues)";

if (!units.length) {
  console.error("时间轴里既无 cues 也无可用 blocks，无法对齐");
  process.exit(1);
}
if (isBlockLevel) {
  console.log("· 时间轴为段级降级(granularity=block)：以 blocks[] 作匹配单元，句中切点仍可用，但插值按整段字比例、精度较粗");
}

function fail(msg) {
  console.error("\n✗ align 失败：" + msg);
  process.exit(1);
}

// ── 0a. 口播稿陈旧检测：改了口播稿但没重跑 gen-tts → 音轨/时间轴是旧的，直接喊停 ──
const SCRIPT_MD = path.join(CH_DIR, "口播稿.md");
if (timeline.narrHash && fs.existsSync(SCRIPT_MD)) {
  const h = hashNarr(parseScript(fs.readFileSync(SCRIPT_MD, "utf8")));
  if (h !== timeline.narrHash) {
    fail(
      `口播稿.md 已改动，但配音/时间轴还是旧的。\n` +
      `   → 先 node scripts/gen-tts.js 重出音轨+时间轴，再写/改分镜、重跑 align。`
    );
  }
}

// ── 0b. schema lint：模板/必填字段/引用完整性。渲染器对这些是静默崩（且崩在
//    逐帧截图 5 分钟之后），渲染前在这里拦住。tpl 不合法也兜住 draft 骨架里没填的 TODO。──
{
  const TPLS = new Set(["T0", "T1", "T2", "T3", "T4"]);
  const errs = [];
  const jingKeys = new Map(); const ids = new Set();
  (SB.jing || []).forEach(s => {
    if (ids.has(s.id)) errs.push(`jing 句 id 重复：「${s.id}」`);
    ids.add(s.id);
    jingKeys.set(s.id, new Set((s.parts || []).filter(p => p.k !== undefined).map(p => String(p.k))));
  });
  beats.forEach((b, i) => {
    const at = `第 ${i} 拍(${b.tpl || "?"}${b.seg ? ` · ${b.seg}` : ""})`;
    if (!TPLS.has(b.tpl)) { errs.push(`${at}：tpl「${b.tpl}」不是 T0–T4（draft 骨架的 TODO 还没填？）`); return; }
    if (b.tpl === "T1") {
      if (!b.sent) errs.push(`${at}：T1 必须有 sent（经文句 id）`);
      else if (!jingKeys.has(b.sent)) errs.push(`${at}：sent「${b.sent}」在 jing 里不存在`);
      else if (Array.isArray(b.hi)) {
        const ks = jingKeys.get(b.sent);
        b.hi.filter(k => !ks.has(String(k))).forEach(k => errs.push(`${at}：hi key「${k}」不在句「${b.sent}」里`));
      }
    } else {
      if (b.sent) errs.push(`${at}：${b.tpl} 不该有 sent`);
      if (b.hi) errs.push(`${at}：${b.tpl} 不该有 hi`);
      if (b.tpl === "T2" && !b.title) errs.push(`${at}：T2 缺 title`);
      if (b.tpl === "T3" && !b.glyph) errs.push(`${at}：T3 缺 glyph`);
      else if (b.tpl === "T3") {   // 8cqw 字号下的几何极限：每行 ≤4 字、最多两行，超 4 字必须 <br> 自断
        const lines = String(b.glyph).split(/<br\s*\/?>/i).map(s => s.replace(/<[^>]+>/g, ""));
        if (lines.length > 2 || lines.some(l => [...l].length > 4))
          errs.push(`${at}：T3 glyph 超限（每行 ≤4 字、最多两行；超 4 字用 <br> 在语义断点分行）`);
      }
      if (b.tpl === "T4" && !b.big) errs.push(`${at}：T4 缺 big`);
    }
  });
  if (errs.length) fail("分镜 schema 不合法：\n   · " + errs.join("\n   · "));
}

// ── a/b. 字符流对齐：把所有 unit 文本归一化拼成一条字符流 G（见 parse-script.js）。
//    每个 beat.narr 必须是 G 从游标处起的一段连续切片；整句 beat 的边界落在 unit 边界
//    上 → 取该 unit 的 start/end（bit-exact）；句中切点 → 按字比例插值估时。
const { G, cuOf, leftEdge, rightEdge } = buildCharStream(units);
const Gn = G.length;

const durs = [];
const beatSpan = []; // {startMs,endMs}
let gc = 0;          // 全局字符游标

for (let bi = 0; bi < beats.length; bi++) {
  const want = norm(beats[bi].narr);
  if (!want) {
    // narr 为空：给 0 时长、不前进游标（异常但不致命地处理）
    const last = beatSpan.length ? beatSpan[beatSpan.length - 1].endMs
      : (gc < Gn ? Math.round(leftEdge(gc)) : (units.length ? units[units.length - 1].endMs : 0));
    durs.push(0);
    beatSpan.push({ startMs: last, endMs: last });
    continue;
  }
  if (gc >= Gn) {
    fail(`第 ${bi} 拍 narr「${headOf(beats[bi].narr)}」无对应配音——` +
      `整条领读已被前面的 beats 认领完，narr 比领读多出来了。`);
  }
  const got = G.slice(gc, gc + want.length);
  if (got !== want) {
    let d = 0; while (d < want.length && got[d] === want[d]) d++;
    fail(
      `第 ${bi} 拍 narr 接不上领读（按字符流校验，切点可落句中，但文字须逐字一致）。\n` +
      `   该拍 narr 前十几字：「${headOf(beats[bi].narr)}」\n` +
      `   领读从第 ${gc} 字起期望：「${G.slice(gc, gc + Math.min(want.length, 24))}${want.length > 24 ? "…" : ""}」\n` +
      `   narr 归一化实际为：「${want.slice(0, 24)}${want.length > 24 ? "…" : ""}」\n` +
      `   第 ${d} 字开始对不上（领读「${G[gc + d] || "∅"}」↔ narr「${want[d] || "∅"}」）。\n` +
      `   → 检查这条 narr 是否漏字 / 多字 / 改字（注音括号「字(pinyin)」会被剥掉，可留）。`
    );
  }
  const startMs = Math.round(leftEdge(gc));
  const endMs = Math.round(rightEdge(gc + want.length));
  durs.push(Math.max(0, endMs - startMs));
  beatSpan.push({ startMs, endMs });
  gc += want.length;
}

// b. 覆盖契约：字符流必须被 beats 全部认领（切片逐一精确相等 + 游标走到底 ⇒ 拼接 == 整条领读）。
if (gc < Gn) {
  const ui = cuOf[gc];
  fail(
    `narr 没覆盖完整条领读：还剩 ${Gn - gc} 个字没被任何 beat 认领。\n` +
    `   第一处没认领的大致在第 ${ui} 句(${unitLabel})：「${headOf(units[ui] && units[ui].t)}」附近\n` +
    `   → 分镜结尾少了对应的 beat。`
  );
}

// ── c. T0 硬规则校验 ─────────────────────────────────────────────────────────
// scrollReadyMs 单一来源是素材套的 配置.js；分镜可显式覆盖，旧时间轴值作向后兼容。
// 取值优先级：分镜 > SKILL/assets/<素材id>/配置.js > 时间轴 > 6200（与渲染器一致）。
let BOOK_CFG = {};
const ASSET_ID = SB.assets || SB.book;
if (ASSET_ID) {
  const f = path.join(__dirname, "..", "assets", String(ASSET_ID), "配置.js");
  if (fs.existsSync(f)) { try { BOOK_CFG = require(f); } catch (_) { } }
}
const scrollReadyMs =
  (typeof SB.scrollReadyMs === "number" ? SB.scrollReadyMs : null) ??
  (typeof BOOK_CFG.scrollReadyMs === "number" ? BOOK_CFG.scrollReadyMs : null) ??
  (typeof timeline.scrollReadyMs === "number" ? timeline.scrollReadyMs : null) ??
  6200;
const scrollReadySrc =
  typeof SB.scrollReadyMs === "number" ? "分镜.scrollReadyMs"
    : typeof BOOK_CFG.scrollReadyMs === "number" ? "配置.js"
      : typeof timeline.scrollReadyMs === "number" ? "时间轴.scrollReadyMs"
        : "默认 6200";
const threshold = scrollReadyMs + T0_BUFFER_MS;
const sr = (scrollReadyMs / 1000).toFixed(1);

for (let bi = 0; bi < beats.length; bi++) {
  if (beats[bi].tpl !== "T0") continue;
  const end = beatSpan[bi].endMs;
  if (end > threshold) {
    const gap = (end - scrollReadyMs) / 1000;
    fail(
      `T0 越过卷轴铺好时刻。\n` +
      `   第 ${bi} 拍是 T0(纯字幕浮在片头上)，念到 ${(end / 1000).toFixed(1)}s 才结束；\n` +
      `   卷轴 scrollReadyMs(${sr}s，来源 ${scrollReadySrc})此时已铺好 → 中间空窗 ${gap.toFixed(1)}s。\n` +
      `   阈值 = ${sr}s + 缓冲 ${(T0_BUFFER_MS / 1000).toFixed(1)}s = ${(threshold / 1000).toFixed(1)}s。\n` +
      `   → 把第 ${bi} 拍从 ~${sr}s 处切成非 T0(T1/T2/T4)，让卷轴铺好就有内容。`
    );
  }
}
// 等价检查：第一个非 T0 的 beat 起点不该晚于阈值（卷轴铺好却还没内容上场）
const firstNonT0 = beats.findIndex(b => b.tpl !== "T0");
if (firstNonT0 >= 0) {
  const start = beatSpan[firstNonT0].startMs;
  if (start > threshold) {
    const gap = (start - scrollReadyMs) / 1000;
    fail(
      `卷轴铺好后仍空窗：第一个非 T0 的拍(第 ${firstNonT0} 拍 ${beats[firstNonT0].tpl})` +
      `要到 ${(start / 1000).toFixed(1)}s 才起。\n` +
      `   卷轴 ${sr}s(来源 ${scrollReadySrc})已铺好 → 空窗 ${gap.toFixed(1)}s。\n` +
      `   → 把前面的 T0 提前收，让非 T0 在 ~${sr}s 接上。`
    );
  }
}

// ── d. 字幕粒度软提醒（不挡渲染）：字幕按标点切完整子句、与模板/beat 切换解耦，
//    所以 beat 的句中切点应落在标点(子句边界)上；若某拍 narr 不以标点收尾，说明切在
//    词中间了——字幕会冒出半截短语。这里只提醒、由 ③审分镜定夺，不报错。 ──
const enderRe = /(——|[。.！!？?；;，,、：:…」』""）)】])\s*$/;
const midClause = [];
for (let bi = 0; bi < beats.length; bi++) {
  const raw = String(beats[bi].narr == null ? "" : beats[bi].narr).trim();
  if (raw && !enderRe.test(raw)) midClause.push({ bi, tail: raw.slice(-12) });
}
if (midClause.length) {
  console.log("\n⚠ 字幕粒度提醒：以下 beat 的 narr 不以标点收尾，切点可能落在子句中间——");
  console.log("   字幕按标点走完整子句，beat 切在词中会让字幕冒出半截短语；建议把切点挪到最近的标点(，：；。——)。");
  midClause.forEach(m => console.log(`   · 第 ${m.bi} 拍 narr 结尾「…${m.tail}」`));
  console.log("   （软提醒、不挡渲染；③审分镜时确认这些切点是否可接受）");
}

// ── 回写 durs[] ──────────────────────────────────────────────────────────────
const src = fs.readFileSync(SB_ABS, "utf8");
const durArr = "[" + durs.join(",") + "]";
let replaced = false;
const out = src.replace(/(\n\s*durs:\s*)\[[^\]]*\]/, (m, p1) => {
  replaced = true;
  return p1 + durArr;
});
if (!replaced) {
  fail(
    `分镜里找不到可回写的 durs: [...] 行。\n` +
    `   请在 STORYBOARD 里保留一行形如 \`  durs: [],\` 供 align 回填。`
  );
}
fs.writeFileSync(SB_ABS, out);

// ── 通过：打印简表 ───────────────────────────────────────────────────────────
const sumDur = durs.reduce((a, b) => a + b, 0);
console.log(`✓ align 通过 · 匹配单元=${unitLabel} · scrollReadyMs=${sr}s(来源 ${scrollReadySrc}) · 缓冲=${(T0_BUFFER_MS / 1000).toFixed(1)}s`);
console.log(`  已回填 durs[] 共 ${durs.length} 拍，总时长 ${(sumDur / 1000).toFixed(1)}s（时间轴 totalMs=${(totalMs / 1000).toFixed(1)}s）`);
if (Math.abs(sumDur - totalMs) > 1500) {
  console.log(`  ⚠ durs 之和与 totalMs 差 ${((sumDur - totalMs) / 1000).toFixed(1)}s（>1.5s，留意是否漏拍/对齐偏移）`);
}
console.log("");
console.log("  #   tpl   起(s)   止(s)   seg");
console.log("  ──  ────  ──────  ──────  ────────");
beats.forEach((b, i) => {
  const s = (beatSpan[i].startMs / 1000).toFixed(2).padStart(6);
  const e = (beatSpan[i].endMs / 1000).toFixed(2).padStart(6);
  console.log(`  ${String(i).padStart(2)}  ${String(b.tpl || "").padEnd(4)}  ${s}  ${e}  ${b.seg || ""}`);
});

// ── 工具 ─────────────────────────────────────────────────────────────────────
function headOf(s) {
  const t = String(s == null ? "" : s).replace(/\s+/g, "");
  return t.length > 14 ? t.slice(0, 14) + "…" : t;
}
