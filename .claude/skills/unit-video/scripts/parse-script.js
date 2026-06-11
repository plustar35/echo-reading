#!/usr/bin/env node
/* 口播稿共用解析层 —— gen-tts / align-durs / draft-storyboard 共用，
 * 保证同一份口播稿在每个脚本眼里都是同一串旁白。 */
"use strict";

// parse 契约（与 references/口播稿规范.md 一致）：
// 跳过首个 `---` 之前的全部内容；之后每组连续 `>` 引用行 = 一条旁白段；
// 空行 / `##` 标题行 / `---` 分隔线断段；`└` 行丢弃（旧格式遗留）。
function parseScript(md) {
  const lines = md.split(/\r?\n/);
  let started = false;
  const blocks = []; let buf = [];
  const flush = () => { if (buf.length) { blocks.push(buf.join("")); buf = []; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!started) { if (line === "---") started = true; continue; }
    if (line === "---") { flush(); continue; }
    if (line === "") { flush(); continue; }
    if (line.startsWith("##")) { flush(); continue; }
    if (line.startsWith(">")) {
      let body = line.replace(/^>\s?/, "");
      if (body.startsWith("└")) continue;
      if (body === "") { flush(); continue; }
      buf.push(body);
      continue;
    }
    flush();
  }
  flush();
  return blocks.map(t => t.trim()).filter(Boolean);
}

// 剥多音字注音「字（pinyin）」只留字（全角括号，与口播稿规范一致）；折叠空白。
// 送 TTS 的文本与口播稿指纹都用它。
const clean = s => String(s == null ? "" : s)
  .replace(/（[a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+）/gi, "")
  .replace(/\s+/g, " ").trim();

// 归一化成可比的「骨字」：剥注音（全/半角括号）、空白、全部标点。
// align 的字符流契约与 draft 的切点估时都用它。
const PINYIN = "a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüA-Z";
const reNote = new RegExp(`[（(][${PINYIN}]+[）)]`, "g");
function norm(s) {
  return String(s == null ? "" : s)
    .replace(reNote, "")
    .replace(/\s+/g, "")
    .replace(/[，。、；：？！,.;:?!…—–\-「」『』""''（）()《》〈〉【】\[\]~·∶]/g, "");
}

// 口播稿指纹：clean 后 djb2。gen-tts 写进时间轴，align 用它发现「改了口播稿没重跑配音」。
function hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}
const hashNarr = blocks => hashText(clean(blocks.join("")));

// 把时间轴单元（句级 cues 或段级 blocks，{t,startMs,endMs}）铺成一条归一化字符流，
// 任意字符位置可插值估时 —— align 对齐与 draft 切点共用。
function buildCharStream(units) {
  const cuOf = [], loOf = [];
  const Llen = units.map(u => norm(u.t).length);
  let G = "";
  units.forEach((u, ui) => {
    const nt = norm(u.t);
    for (let j = 0; j < nt.length; j++) { G += nt[j]; cuOf.push(ui); loOf.push(j); }
  });
  const leftEdge = g => {                      // 第 g 字开始的时刻
    const ui = cuOf[g], j = loOf[g], u = units[ui], L = Llen[ui] || 1;
    return u.startMs + (j / L) * (u.endMs - u.startMs);
  };
  const rightEdge = g => {                     // 第 g-1 字结束的时刻
    const ui = cuOf[g - 1], j = loOf[g - 1], u = units[ui], L = Llen[ui] || 1;
    return u.startMs + ((j + 1) / L) * (u.endMs - u.startMs);
  };
  return { G, cuOf, loOf, leftEdge, rightEdge };
}

module.exports = { parseScript, clean, norm, hashNarr, buildCharStream };
