#!/usr/bin/env node
// @ts-nocheck
/* 领读视频 · 分镜静态校验。
 *
 * 不写文件。用于 agent 编辑 分镜.js 后立即检查：
 * atoms/take 连续性、模板字段、jing/hi、capacity、口播时间轴一致性。
 *
 * 用法： node dist/cli/validate-storyboard.js <分镜.js 路径>
 */
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const path = require("path");
const { validateStoryboard } = require("../core/validate-storyboard");
const SB_IN = process.argv[2];
if (!SB_IN) {
    console.error("用法: node dist/cli/validate-storyboard.js <分镜.js 路径>");
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
let SB;
try {
    SB = require(SB_ABS);
}
catch (e) {
    console.error("无法 require 分镜: " + SB_ABS + "\n  " + e.message);
    process.exit(1);
}
let timeline;
if (fs.existsSync(TIMELINE_ABS)) {
    try {
        timeline = JSON.parse(fs.readFileSync(TIMELINE_ABS, "utf8"));
    }
    catch (e) {
        console.error("无法解析时间轴 JSON: " + TIMELINE_ABS + "\n  " + e.message);
        process.exit(1);
    }
}
const result = validateStoryboard({
    storyboard: SB,
    storyboardPath: SB_ABS,
    timeline,
    scriptText: fs.existsSync(SCRIPT_MD) ? fs.readFileSync(SCRIPT_MD, "utf8") : undefined,
    t0BufferMs: T0_BUFFER_MS,
});
if (result.errors.length) {
    console.error("\n✗ storyboard 校验失败：\n   · " + result.errors.join("\n   · "));
    process.exit(1);
}
if (result.warnings.length) {
    console.log("\n⚠ 白板内容提醒：");
    result.warnings.forEach(w => console.log("   · " + w));
    console.log("   （软提醒、不挡后续命令；建议继续压缩为关键词/结构提示）");
}
const beats = Array.isArray(SB.beats) ? SB.beats.length : 0;
if (result.hasTimeline) {
    const total = ((result.timelineTotalMs || 0) / 1000).toFixed(1);
    console.log(`✓ storyboard 校验通过 · atoms=${result.atoms.length} · beats=${beats} · 时间轴=${result.unitLabel} · total=${total}s`);
}
else {
    console.log(`✓ storyboard 校验通过 · atoms=${result.atoms.length} · beats=${beats} · 未发现时间轴，只做结构/模板/capacity 校验`);
}
