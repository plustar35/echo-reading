#!/usr/bin/env node
// @ts-nocheck
/* 领读视频 · 模板定义校验。
 *
 * 检查 src/templates/registry.ts 与 templates/<模板>/template.json 是否一致，
 * 并检查每个模板的 capacity 形状是否足够让 storyboard 校验执行。
 *
 * 用法： node dist/cli/validate-templates.js
 */
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const registry_1 = require("../templates/registry");
const SKILL_ROOT = path.join(__dirname, "..", "..");
const TEMPLATES_DIR = path.join(SKILL_ROOT, "templates");
const errors = [];
const jsonById = readTemplateJsons();
for (const id of (0, registry_1.templateIds)()) {
    const def = registry_1.TEMPLATE_REGISTRY[id];
    const json = jsonById.get(id);
    if (!json) {
        errors.push(`registry.${id} 缺少对应 templates/*/template.json`);
        continue;
    }
    const a = stable(canonicalTemplate(def));
    const b = stable(canonicalTemplate(json));
    if (JSON.stringify(a) !== JSON.stringify(b)) {
        errors.push(`模板 ${id} 的 registry.ts 与 template.json 不一致`);
    }
    validateTemplateShape(def, `registry.${id}`);
}
for (const id of jsonById.keys()) {
    if (!registry_1.TEMPLATE_REGISTRY[id])
        errors.push(`template.json 定义了未注册模板 ${id}`);
}
if (errors.length) {
    console.error("\n✗ templates 校验失败：\n   · " + errors.join("\n   · "));
    process.exit(1);
}
console.log(`✓ templates 校验通过 · ${(0, registry_1.templateIds)().length} 个模板定义一致`);
function readTemplateJsons() {
    const out = new Map();
    if (!fs.existsSync(TEMPLATES_DIR)) {
        errors.push("找不到模板目录: " + TEMPLATES_DIR);
        return out;
    }
    for (const name of fs.readdirSync(TEMPLATES_DIR)) {
        const file = path.join(TEMPLATES_DIR, name, "template.json");
        if (!fs.existsSync(file))
            continue;
        let json;
        try {
            json = JSON.parse(fs.readFileSync(file, "utf8"));
        }
        catch (e) {
            errors.push(`${file} 不是合法 JSON：${e.message}`);
            continue;
        }
        if (!json.id) {
            errors.push(`${file} 缺 id`);
            continue;
        }
        if (out.has(json.id))
            errors.push(`template id 重复：${json.id}`);
        out.set(json.id, json);
        validateTemplateShape(json, file);
    }
    return out;
}
function canonicalTemplate(t) {
    const out = {
        id: t.id,
        name: t.name,
        purpose: t.purpose,
        base: cleanObject(t.base || {}),
        stepState: cleanObject(t.stepState || {}),
        stepShow: cleanObject(t.stepShow || {}),
    };
    if (t.constraints)
        out.constraints = cleanObject(t.constraints);
    if (t.capacity)
        out.capacity = cleanObject(t.capacity);
    return out;
}
function cleanObject(value) {
    if (Array.isArray(value))
        return value.slice();
    if (!value || typeof value !== "object")
        return value;
    const out = {};
    for (const key of Object.keys(value).sort()) {
        if (value[key] !== undefined)
            out[key] = cleanObject(value[key]);
    }
    return out;
}
function stable(value) {
    if (Array.isArray(value))
        return value.map(stable);
    if (!value || typeof value !== "object")
        return value;
    const out = {};
    for (const k of Object.keys(value).sort())
        out[k] = stable(value[k]);
    return out;
}
function validateTemplateShape(t, at) {
    if (!t || typeof t !== "object") {
        errors.push(`${at}：模板定义必须是对象`);
        return;
    }
    for (const key of ["id", "name", "purpose"]) {
        if (typeof t[key] !== "string" || !t[key])
            errors.push(`${at}：${key} 必须是非空字符串`);
    }
    validateAllowed(t.base, `${at}.base`);
    validateAllowed(t.stepState, `${at}.stepState`);
    validateAllowed(t.stepShow, `${at}.stepShow`);
    validateCapacity(t, at);
}
function validateAllowed(section, at) {
    if (!section || typeof section !== "object" || !Array.isArray(section.allowed)) {
        errors.push(`${at}.allowed 必须是数组`);
        return;
    }
    section.allowed.forEach((x) => {
        if (typeof x !== "string" || !x)
            errors.push(`${at}.allowed 只能包含非空字符串`);
    });
    if (section.required != null && !Array.isArray(section.required)) {
        errors.push(`${at}.required 必须是数组`);
    }
}
function validateCapacity(t, at) {
    const cap = t.capacity;
    if (!cap || typeof cap !== "object") {
        errors.push(`${at}.capacity 必须存在`);
        return;
    }
    if (!["none", "aux", "center", "glyph"].includes(cap.area))
        errors.push(`${at}.capacity.area 不合法：${cap.area}`);
    if (typeof cap.basis !== "string" || !cap.basis)
        errors.push(`${at}.capacity.basis 必须说明测算依据`);
    const ps = cap.perStep || {};
    const pb = cap.perBeat || {};
    if (cap.area === "none") {
        requireNums(pb, ["maxWhiteboardItems"], `${at}.capacity.perBeat`);
    }
    else if (cap.area === "aux") {
        requireNums(ps, ["maxNewAuxItems", "maxTextChars", "maxVisualLines"], `${at}.capacity.perStep`);
        requireNums(pb, ["maxSteps", "maxAuxItems", "maxTextChars", "maxVisualLines"], `${at}.capacity.perBeat`);
    }
    else if (cap.area === "center") {
        if (t.id === "T4") {
            requireNums(ps, ["maxNewBigItems", "maxTextChars", "maxVisualLines"], `${at}.capacity.perStep`);
            requireNums(pb, ["maxSteps", "maxBigItems", "maxTextChars", "maxVisualLines"], `${at}.capacity.perBeat`);
        }
        else {
            requireNums(ps, ["maxNewCenterItems", "maxTextChars", "maxVisualLines"], `${at}.capacity.perStep`);
            requireNums(pb, ["maxSteps", "maxCenterItems", "maxTextChars", "maxVisualLines"], `${at}.capacity.perBeat`);
        }
    }
    else if (cap.area === "glyph") {
        requireNums(pb, ["maxGlyphLines", "maxGlyphCharsPerLine", "maxWhiteboardItems"], `${at}.capacity.perBeat`);
    }
}
function requireNums(obj, keys, at) {
    if (!obj || typeof obj !== "object") {
        errors.push(`${at} 必须是对象`);
        return;
    }
    for (const key of keys) {
        if (typeof obj[key] !== "number")
            errors.push(`${at}.${key} 必须是数字`);
    }
}
