#!/usr/bin/env node
// @ts-nocheck
/* 领读视频 · 单元管线 ③.5 对齐。
 *
 * 分镜静态校验由 core/validate-storyboard 执行；本命令在校验通过后，
 * 根据 TTS 时间轴回填 durs[] / stepDurs[]。
 *
 * 用法： node dist/cli/align-durs.js <分镜.js 路径>
 */
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const path = require("path");
const { validateStoryboard } = require("../core/validate-storyboard");
const SB_IN = process.argv[2];
if (!SB_IN) {
    console.error("用法: node dist/cli/align-durs.js <分镜.js 路径>");
    process.exit(1);
}
const SB_ABS = path.resolve(SB_IN);
if (!fs.existsSync(SB_ABS)) {
    console.error("找不到分镜: " + SB_ABS);
    process.exit(1);
}
const CH_DIR = path.dirname(SB_ABS);
const TIMELINE_ABS = path.join(CH_DIR, "口播时间轴.json");
const SCRIPT_MD = path.join(CH_DIR, "口播稿.md");
const T0_BUFFER_MS = parseInt(process.env.T0_BUFFER_MS || "800", 10);
const rel = p => path.relative(process.cwd(), p);
if (!fs.existsSync(TIMELINE_ABS)) {
    console.log(`· 无时间轴(${rel(TIMELINE_ABS)} 不存在)，跳过 align(沿用现有 durs)`);
    process.exit(0);
}
let SB;
try {
    SB = require(SB_ABS);
}
catch (e) {
    console.error("无法 require 分镜: " + SB_ABS + "\n  " + e.message);
    process.exit(1);
}
let timeline;
try {
    timeline = JSON.parse(fs.readFileSync(TIMELINE_ABS, "utf8"));
}
catch (e) {
    console.error("无法解析时间轴 JSON: " + TIMELINE_ABS + "\n  " + e.message);
    process.exit(1);
}
const result = validateStoryboard({
    storyboard: SB,
    storyboardPath: SB_ABS,
    timeline,
    scriptText: fs.existsSync(SCRIPT_MD) ? fs.readFileSync(SCRIPT_MD, "utf8") : undefined,
    t0BufferMs: T0_BUFFER_MS,
});
if (result.isBlockLevel)
    console.log("· 时间轴为段级降级(granularity=block)：句中切点按整段字比例估时，精度较粗");
if (result.errors.length)
    fail("分镜校验失败：\n   · " + result.errors.join("\n   · "));
printWarnings(result.warnings);
writeDurArrays(result.durs, result.stepDurs);
printSummary(result);
function fail(msg) {
    console.error("\n✗ align 失败：" + msg);
    process.exit(1);
}
function printWarnings(warnings) {
    if (!warnings.length)
        return;
    console.log("\n⚠ 白板内容提醒：");
    warnings.forEach(w => console.log("   · " + w));
    console.log("   （软提醒、不挡渲染；建议继续压缩为关键词/结构提示）");
}
function findArrayProp(src, prop) {
    const re = new RegExp(`((?:^|[\\n,])\\s*${prop}\\s*:\\s*)\\[`);
    const m = re.exec(src);
    if (!m)
        return null;
    const start = m.index + m[1].length;
    let depth = 0, quote = null, esc = false;
    for (let i = start; i < src.length; i++) {
        const ch = src[i];
        if (quote) {
            if (esc) {
                esc = false;
                continue;
            }
            if (ch === "\\") {
                esc = true;
                continue;
            }
            if (ch === quote)
                quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
            quote = ch;
            continue;
        }
        if (ch === "[")
            depth++;
        else if (ch === "]") {
            depth--;
            if (depth === 0)
                return { valueStart: start, valueEnd: i + 1, propEnd: i + 1 };
        }
    }
    return null;
}
function replaceArrayProp(src, prop, value) {
    const loc = findArrayProp(src, prop);
    if (!loc)
        return { text: src, replaced: false };
    return { text: src.slice(0, loc.valueStart) + value + src.slice(loc.valueEnd), replaced: true };
}
function insertArrayPropAfter(src, afterProp, prop, value) {
    const loc = findArrayProp(src, afterProp);
    if (!loc)
        return { text: src, inserted: false };
    return { text: src.slice(0, loc.propEnd) + `,\n  ${prop}: ${value}` + src.slice(loc.propEnd), inserted: true };
}
function writeDurArrays(durs, stepDurs) {
    if (!durs.length || !stepDurs.length)
        fail("没有可回填的时长；请检查时间轴和 beat/step.take。");
    let src = fs.readFileSync(SB_ABS, "utf8");
    let r = replaceArrayProp(src, "durs", "[" + durs.join(",") + "]");
    if (!r.replaced)
        fail("分镜里找不到 durs: []，无法回填。");
    src = r.text;
    r = replaceArrayProp(src, "stepDurs", JSON.stringify(stepDurs));
    if (!r.replaced) {
        const ins = insertArrayPropAfter(src, "durs", "stepDurs", JSON.stringify(stepDurs));
        if (!ins.inserted)
            fail("分镜里找不到 durs，无法插入 stepDurs。");
        src = ins.text;
    }
    else
        src = r.text;
    fs.writeFileSync(SB_ABS, src);
}
function printSummary(result) {
    const sumDur = result.durs.reduce((a, b) => a + (b || 0), 0);
    const sr = ((result.scrollReadyMs || 6200) / 1000).toFixed(1);
    console.log(`✓ align 通过 · atoms=${result.atoms.length} · 匹配单元=${result.unitLabel} · scrollReadyMs=${sr}s(来源 ${result.scrollReadySrc || "?"})`);
    console.log(`  已回填 durs[] 共 ${result.durs.length} 拍、stepDurs[] 共 ${result.stepDurs.reduce((a, b) => a + b.length, 0)} 个 step，总时长 ${(sumDur / 1000).toFixed(1)}s（时间轴 totalMs=${((result.timelineTotalMs || 0) / 1000).toFixed(1)}s）`);
    console.log("");
    console.log("  #   tpl   起(s)   止(s)   take");
    console.log("  --  ----  ------  ------  -----------");
    (SB.beats || []).forEach((b, i) => {
        const span = result.beatSpan[i] || { startMs: 0, endMs: 0 };
        const first = b.take && b.take[0], last = b.take && b.take[b.take.length - 1];
        console.log(`  ${String(i).padStart(2)}  ${String(b.tpl || "").padEnd(4)}  ${(span.startMs / 1000).toFixed(2).padStart(6)}  ${(span.endMs / 1000).toFixed(2).padStart(6)}  ${first}${first !== last ? ".." + last : ""}`);
    });
}
