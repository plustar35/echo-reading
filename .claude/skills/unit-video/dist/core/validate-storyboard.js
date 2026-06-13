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
exports.validateStoryboard = validateStoryboard;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const parse_script_1 = require("./parse-script");
const registry_1 = require("../templates/registry");
function validateStoryboard(options) {
    const SB = options.storyboard || {};
    const timeline = options.timeline || null;
    const errors = [];
    const warnings = [];
    const durs = [];
    const stepDurs = [];
    const beatSpan = [];
    const atomInfos = [];
    const atomMap = new Map();
    const atoms = Array.isArray(SB.atoms) ? SB.atoms : [];
    const beats = Array.isArray(SB.beats) ? SB.beats : [];
    if (!atoms.length) {
        errors.push("新版分镜必须有顶层 atoms[]。请重新运行 draft-storyboard，并按新版协议用 beat.take / step.take 引用 atom id。");
    }
    if (!beats.length)
        errors.push("分镜里没有 beats[]。");
    if (!Array.isArray(SB.jing))
        errors.push("顶层 jing 必须是数组；不用经文模板时可写 jing: []。");
    const cues = Array.isArray(timeline?.cues) ? timeline.cues : [];
    const blocks = Array.isArray(timeline?.blocks) ? timeline.blocks : [];
    const isBlockLevel = !!timeline && (timeline.granularity === "block" || cues.length === 0);
    const units = timeline
        ? (isBlockLevel ? blocks.map((b) => ({ t: b.text, startMs: b.startMs, endMs: b.endMs })) : cues)
        : [];
    const unitLabel = timeline ? (isBlockLevel ? "段级(blocks)" : "句级(cues)") : "无时间轴";
    let charStream = null;
    if (timeline) {
        if (!units.length) {
            errors.push("时间轴里既无 cues 也无可用 blocks，无法对齐。");
        }
        else {
            charStream = (0, parse_script_1.buildCharStream)(units);
        }
        if (timeline.narrHash && options.scriptText != null) {
            const h = (0, parse_script_1.hashNarr)((0, parse_script_1.parseScript)(options.scriptText));
            if (h !== timeline.narrHash) {
                errors.push("口播稿.md 已改动，但配音/时间轴还是旧的。先重跑 gen-tts.js，再写/改分镜。");
            }
        }
    }
    buildAtomInfos(SB, atoms, atomInfos, atomMap, charStream, units, unitLabel, errors);
    const templateSet = new Set((0, registry_1.templateIds)());
    const jingKeys = buildJingKeyMap(SB, errors);
    let beatCursor = 0;
    beats.forEach((b, bi) => {
        const atBeat = `第 ${bi} 拍(${b?.tpl || "?"}${b?.seg ? ` · ${b.seg}` : ""})`;
        const def = (0, registry_1.getTemplateDefinition)(String(b?.tpl || ""));
        if (!templateSet.has(b?.tpl) || !def) {
            errors.push(`${atBeat}：tpl「${b?.tpl}」不是已注册模板`);
            return;
        }
        validateObjectKeys(b.base || {}, def.base.allowed || [], `${atBeat} base`, errors);
        for (const req of def.base.required || []) {
            if ((b.base || {})[req] == null && !hasStepState(b, req))
                errors.push(`${atBeat}：${b.tpl} 缺 base.${req}`);
        }
        const take = Array.isArray(b.take) ? b.take.map(String) : [];
        if (!take.length) {
            errors.push(`${atBeat}：take 不能为空`);
            return;
        }
        const beatAtoms = consumeExpectedAtoms(take, atomInfos, beatCursor, `${atBeat}.take`, errors);
        beatCursor += take.length;
        if (!beatAtoms.length)
            return;
        const timedBeatAtoms = beatAtoms.filter(a => Number.isFinite(a.startMs) && Number.isFinite(a.endMs));
        if (timedBeatAtoms.length === beatAtoms.length) {
            const startMs = timedBeatAtoms[0].startMs;
            const endMs = timedBeatAtoms[timedBeatAtoms.length - 1].endMs;
            beatSpan[bi] = { startMs, endMs };
            durs[bi] = Math.max(0, endMs - startMs);
        }
        validateTemplateSpecific(b, def, jingKeys, atBeat, errors);
        validateRevealHierarchy(b, atBeat, errors);
        const steps = Array.isArray(b.steps) ? b.steps : [];
        if (!steps.length) {
            errors.push(`${atBeat}：steps 不能为空；无 reveal 的模板也要用一个 step 覆盖 beat.take`);
            return;
        }
        let stepCursor = 0;
        let currentSent = (b.base && b.base.sent) || null;
        const sds = [];
        steps.forEach((s, si) => {
            const atStep = `${atBeat} / step ${si}`;
            validateObjectKeys((s && s.state) || {}, def.stepState.allowed || [], `${atStep}.state`, errors);
            validateObjectKeys((s && s.show) || {}, def.stepShow.allowed || [], `${atStep}.show`, errors);
            const stepTake = Array.isArray(s && s.take) ? s.take.map(String) : [];
            if (!stepTake.length) {
                errors.push(`${atStep}：take 不能为空`);
                return;
            }
            const stepAtoms = consumeExpectedIds(stepTake, take, stepCursor, `${atStep}.take`, errors)
                .map(id => atomMap.get(id))
                .filter(Boolean);
            stepCursor += stepTake.length;
            if (!stepAtoms.length)
                return;
            if (stepAtoms.every(a => Number.isFinite(a.startMs) && Number.isFinite(a.endMs))) {
                const st = stepAtoms[0].startMs;
                const en = stepAtoms[stepAtoms.length - 1].endMs;
                sds.push(Math.max(0, en - st));
            }
            const state = (s && s.state) || {};
            if (state.sent)
                currentSent = state.sent;
            validateHi(state.hi, currentSent, jingKeys, atStep, errors);
            warnSimilarToStepNarr(s && s.show, stepAtoms.map(a => a.narr).join(""), atStep, warnings);
        });
        if (stepCursor !== take.length) {
            const left = take.slice(stepCursor).join(", ");
            errors.push(`${atBeat}：steps 没有覆盖全部 beat.take，剩余：${left}`);
        }
        if (sds.length)
            stepDurs[bi] = sds;
        else if (Number.isFinite(durs[bi]))
            stepDurs[bi] = [durs[bi]];
        validateCapacity(b, def, atBeat, errors);
    });
    if (beatCursor !== atomInfos.length) {
        const left = atomInfos.slice(beatCursor).map(a => a.id).join(", ");
        errors.push(`beats[].take 没有覆盖全部 atoms，剩余：${left}`);
    }
    const t0 = validateT0Timing(SB, timeline, beatSpan, options, errors);
    validateSubtitleCut(beats, atomMap, warnings);
    return {
        errors,
        warnings,
        atoms: atomInfos,
        atomMap,
        durs,
        stepDurs,
        beatSpan,
        hasTimeline: !!timeline,
        isBlockLevel,
        unitLabel,
        timelineTotalMs: Number(timeline?.totalMs || 0),
        scrollReadyMs: t0.scrollReadyMs,
        scrollReadySrc: t0.scrollReadySrc,
    };
}
function buildAtomInfos(SB, atoms, atomInfos, atomMap, charStream, units, unitLabel, errors) {
    let gc = 0;
    const G = charStream?.G || "";
    const Gn = G.length;
    for (let ai = 0; ai < atoms.length; ai++) {
        const a = atoms[ai] || {};
        if (!a.id)
            errors.push(`第 ${ai} 个 atom 缺 id。`);
        if (a.id && atomMap.has(String(a.id)))
            errors.push(`atom id 重复：「${a.id}」。`);
        const want = (0, parse_script_1.norm)(a.narr || "");
        if (!want)
            errors.push(`atom「${a.id || ai}」narr 为空。`);
        let startMs;
        let endMs;
        if (charStream && want) {
            const got = G.slice(gc, gc + want.length);
            if (got !== want) {
                let d = 0;
                while (d < want.length && got[d] === want[d])
                    d++;
                errors.push(`atom「${a.id}」接不上口播时间轴。\n` +
                    `   时间轴从第 ${gc} 字起是：「${G.slice(gc, gc + Math.min(want.length, 24))}${want.length > 24 ? "..." : ""}」\n` +
                    `   atom 实际是：「${want.slice(0, 24)}${want.length > 24 ? "..." : ""}」\n` +
                    `   第 ${d} 字开始对不上（时间轴「${G[gc + d] || "∅"}」↔ atom「${want[d] || "∅"}」）。\n` +
                    `   不要改 atoms[].narr；要改讲法回口播稿重跑 TTS 和 draft。`);
            }
            if (gc < Gn && gc + want.length <= Gn) {
                startMs = Math.round(charStream.leftEdge(gc));
                endMs = Math.round(charStream.rightEdge(gc + want.length));
            }
        }
        const id = String(a.id || `atom-${ai}`);
        const info = {
            id,
            narr: String(a.narr || ""),
            index: ai,
            gStart: charStream ? gc : undefined,
            gEnd: charStream ? gc + want.length : undefined,
            startMs,
            endMs,
        };
        atomInfos.push(info);
        if (!atomMap.has(id))
            atomMap.set(id, info);
        gc += want.length;
    }
    if (charStream) {
        if (gc < Gn) {
            const ui = charStream.cuOf[gc];
            errors.push(`atoms[] 没覆盖完整条领读：还剩 ${Gn - gc} 个字，第一处在第 ${ui} 句(${unitLabel})「${headOf(units[ui] && units[ui].t)}」附近。`);
        }
        if (gc > Gn)
            errors.push("atoms[] 比口播时间轴更长。");
    }
    if (SB.atoms && !Array.isArray(SB.atoms))
        errors.push("顶层 atoms 必须是数组。");
}
function buildJingKeyMap(SB, errors) {
    const m = new Map();
    const ids = new Set();
    for (const s of Array.isArray(SB.jing) ? SB.jing : []) {
        if (!s || typeof s !== "object") {
            errors.push("jing 中存在非对象句子。");
            continue;
        }
        if (!s.id) {
            errors.push("jing 句缺 id。");
            continue;
        }
        if (ids.has(String(s.id)))
            errors.push(`jing 句 id 重复：「${s.id}」`);
        ids.add(String(s.id));
        const keys = new Set();
        for (const p of Array.isArray(s.parts) ? s.parts : []) {
            if (p && p.k !== undefined)
                keys.add(String(p.k));
        }
        m.set(String(s.id), keys);
    }
    return m;
}
function validateObjectKeys(obj, allowed, at, errors) {
    if (obj == null)
        return;
    if (typeof obj !== "object" || Array.isArray(obj)) {
        errors.push(`${at}：必须是对象`);
        return;
    }
    const allowedSet = new Set(allowed || []);
    Object.keys(obj).forEach(k => {
        if (!allowedSet.has(k))
            errors.push(`${at}：字段「${k}」不被模板允许`);
    });
}
function hasStepState(b, key) {
    return (b.steps || []).some((s) => s && s.state && s.state[key] != null);
}
function consumeExpectedAtoms(ids, source, cursor, at, errors) {
    const out = [];
    ids.forEach((id, offset) => {
        const expected = source[cursor + offset];
        if (!expected) {
            errors.push(`${at}：take 超出 atoms 范围，多用了「${id}」`);
            return;
        }
        if (String(id) !== String(expected.id)) {
            errors.push(`${at}：必须按全局 atoms 顺序连续引用；当前位置应为「${expected.id}」，实际是「${id}」`);
            return;
        }
        out.push(expected);
    });
    return out;
}
function consumeExpectedIds(ids, sourceIds, cursor, at, errors) {
    const out = [];
    ids.forEach((id, offset) => {
        const expected = sourceIds[cursor + offset];
        if (!expected) {
            errors.push(`${at}：take 超出当前 beat.take 范围，多用了「${id}」`);
            return;
        }
        if (String(id) !== String(expected)) {
            errors.push(`${at}：必须按当前 beat.take 顺序连续引用；当前位置应为「${expected}」，实际是「${id}」`);
            return;
        }
        out.push(String(id));
    });
    return out;
}
function validateTemplateSpecific(b, def, keys, at, errors) {
    const base = b.base || {};
    if (b.tpl === "T1") {
        const sent = base.sent;
        if (sent && !keys.has(String(sent)))
            errors.push(`${at}：sent「${sent}」在 jing 里不存在`);
        validateHi(base.hi, sent, keys, `${at}.base`, errors);
    }
    else if (b.tpl === "T2") {
        if (!hasT2Title(b))
            errors.push(`${at}：T2 必须有一个 title，可放在 base.title 或 step.show.title`);
    }
    else if (b.tpl === "T3") {
        const glyph = base.glyph || "";
        if (!glyph)
            errors.push(`${at}：T3 缺 base.glyph`);
        const lines = String(glyph).split(/<br\s*\/?>/i).map(s => stripTags(s));
        const cap = (def.capacity && def.capacity.perBeat) || {};
        if (lines.length > (cap.maxGlyphLines || 2) || lines.some(l => [...l].length > (cap.maxGlyphCharsPerLine || 4))) {
            errors.push(`${at}：T3 base.glyph 超容量（最多 ${cap.maxGlyphLines || 2} 行，每行 ${cap.maxGlyphCharsPerLine || 4} 字）`);
        }
    }
}
function validateRevealHierarchy(b, at, errors) {
    if (b.tpl === "T1")
        validateT1RevealHierarchy(b, at, errors);
    if (b.tpl === "T2")
        validateT2RevealHierarchy(b, at, errors);
}
function auxLevel(it) {
    const kind = it && (it.kind || it.type || (it.z ? "gloss" : it.head ? "head" : "point"));
    if (kind === "head")
        return 0;
    if (kind === "gloss" || kind === "point")
        return 1;
    return 1;
}
function validateT1RevealHierarchy(b, at, errors) {
    const baseItems = auxItems((b.base || {}).aux);
    const steps = Array.isArray(b.steps) ? b.steps : [];
    let seenHead = baseItems.some(x => auxLevel(x) === 0);
    let maxLevel = seenHead ? 0 : -1;
    let lowerCount = 0;
    let headCount = seenHead ? 1 : 0;
    baseItems.forEach((it, i) => {
        const level = auxLevel(it);
        if (level > 0) {
            lowerCount++;
            errors.push(`${at}.base.aux：base 只能放 head；gloss/point 必须通过 step.show.aux 渐进出现`);
        }
        if (level === 0 && i > 0)
            errors.push(`${at}.base.aux：head 必须是 base.aux 的第一项`);
    });
    steps.forEach((s, si) => {
        auxItems(s && s.show && s.show.aux).forEach((it, ii) => {
            const level = auxLevel(it);
            const label = `${at} / step ${si}.show.aux[${ii}]`;
            if (level > 0)
                lowerCount++;
            if (level > 0 && !seenHead)
                errors.push(`${label}：不能先 reveal gloss/point；本 T1 beat 必须先 reveal 一个 head`);
            if (level < maxLevel)
                errors.push(`${label}：reveal 层级倒退；顺序必须是 head → gloss/point`);
            if (level === 0) {
                headCount++;
                seenHead = true;
            }
            maxLevel = Math.max(maxLevel, level);
        });
    });
    if (lowerCount > 0 && headCount === 0)
        errors.push(`${at}：有 gloss/point 时必须有 1 个 head 作为上层题眼`);
}
function centerLevel(it) {
    const kind = it && (it.kind || it.type || "lead");
    return kind === "title" ? 0 : 1;
}
function t2RevealItems(show) {
    const titleItems = [];
    const leadItems = [];
    if (!show)
        return [];
    arr(show.center).forEach((x) => {
        const obj = typeof x === "string" ? { kind: "lead", text: x } : x;
        if ((obj && (obj.kind || obj.type)) === "title")
            titleItems.push(obj);
        else
            leadItems.push(obj);
    });
    if (show.title)
        titleItems.push({ kind: "title", text: show.title });
    arr(show.lead).forEach((x) => leadItems.push({ kind: "lead", text: x }));
    if (show.note)
        leadItems.push({ kind: "lead", text: show.note });
    return [...titleItems, ...leadItems];
}
function hasT2Title(b) {
    if ((b.base || {}).title)
        return true;
    return (Array.isArray(b.steps) ? b.steps : []).some((s) => t2RevealItems(s && s.show).some(x => centerLevel(x) === 0));
}
function validateT2RevealHierarchy(b, at, errors) {
    const base = b.base || {};
    let seenTitle = !!base.title;
    let maxLevel = seenTitle ? 0 : -1;
    if (base.lead != null)
        errors.push(`${at}.base.lead：T2 的 lead 属于下层内容，必须放在 step.show.lead 或 step.show.note`);
    (Array.isArray(b.steps) ? b.steps : []).forEach((s, si) => {
        t2RevealItems(s && s.show).forEach((it, ii) => {
            const level = centerLevel(it);
            const label = `${at} / step ${si}.show[${ii}]`;
            if (level > 0 && !seenTitle)
                errors.push(`${label}：不能先 reveal lead/note；本 T2 beat 必须先 reveal title`);
            if (level < maxLevel)
                errors.push(`${label}：reveal 层级倒退；顺序必须是 title → lead/note`);
            if (level === 0)
                seenTitle = true;
            maxLevel = Math.max(maxLevel, level);
        });
    });
}
function validateHi(hi, sent, keys, at, errors) {
    if (hi == null || hi === "sweep")
        return;
    if (!Array.isArray(hi)) {
        errors.push(`${at}：hi 必须是 key 数组或 "sweep"`);
        return;
    }
    if (!sent) {
        errors.push(`${at}：有 hi 但没有当前 sent`);
        return;
    }
    const ks = keys.get(String(sent));
    if (!ks) {
        errors.push(`${at}：sent「${sent}」在 jing 里不存在`);
        return;
    }
    hi.filter(k => !ks.has(String(k))).forEach(k => errors.push(`${at}：hi key「${k}」不在句「${sent}」里`));
}
function warnSimilarToStepNarr(show, stepNarr, at, warnings) {
    const stepNorm = (0, parse_script_1.norm)(stepNarr || "");
    visualTextsFromShow(show).forEach(txt => {
        const plain = stripTags(txt);
        const glyphs = [...plain].length;
        const vn = (0, parse_script_1.norm)(plain);
        if (glyphs > 24)
            warnings.push(`${at}：白板文字偏长「${plain.slice(0, 24)}${glyphs > 24 ? "..." : ""}」`);
        if (vn.length >= 6 && stepNorm.includes(vn))
            warnings.push(`${at}：白板文字疑似复述口播「${plain.slice(0, 24)}${glyphs > 24 ? "..." : ""}」`);
    });
}
function visualTextsFromShow(show) {
    const out = [];
    if (!show)
        return out;
    auxItems(show.aux).forEach(it => out.push(textOfAux(it)));
    centerItemsFromShow(show).forEach(it => out.push(textOfCenter(it)));
    return out.map(s => s.trim()).filter(Boolean);
}
function arr(x) {
    return Array.isArray(x) ? x : (x == null ? [] : [x]);
}
function stripTags(s) {
    return String(s == null ? "" : s).replace(/<[^>]+>/g, "");
}
function textLen(s) {
    return [...stripTags(s).replace(/\s+/g, "")].length;
}
function visualLinesOf(s) {
    return Math.max(1, String(s == null ? "" : s).split(/<br\s*\/?>/i).length);
}
function textOfAux(it) {
    return stripTags([it && it.z, it && it.p, it && (it.m || it.text || it.head)].filter(Boolean).join(""));
}
function textOfCenter(it) {
    return stripTags(typeof it === "string" ? it : (it && (it.text || it.value || it.title || it.big || it.glyph || it.note)) || "");
}
function auxItems(value) {
    if (!value)
        return [];
    if (Array.isArray(value))
        return value.filter(Boolean);
    const out = [];
    if (value.head)
        out.push({ kind: "head", text: value.head });
    arr(value.gloss).forEach((g) => out.push({ kind: "gloss", z: g.z, p: g.p, m: g.m }));
    arr(value.points).forEach((p) => out.push({ kind: "point", text: p }));
    if (!out.length && typeof value === "object")
        out.push(value);
    return out;
}
function centerItemsFromShow(show) {
    const out = [];
    if (!show)
        return out;
    arr(show.center).forEach((x) => out.push(typeof x === "string" ? { kind: "lead", text: x } : x));
    if (show.title)
        out.push({ kind: "title", text: show.title });
    if (show.glyph)
        out.push({ kind: "glyph", text: show.glyph });
    arr(show.lead).forEach((x) => out.push({ kind: "lead", text: x }));
    if (show.note)
        out.push({ kind: "lead", text: show.note });
    arr(show.big).forEach((x) => out.push(typeof x === "string" ? { kind: "big", text: x } : x));
    return out.filter(Boolean);
}
function baseCenterItems(b) {
    const base = b.base || {};
    const out = [];
    if (b.tpl === "T2") {
        if (base.title)
            out.push({ kind: "title", text: base.title });
    }
    else if (b.tpl === "T3") {
        if (base.glyph)
            out.push({ kind: "glyph", text: base.glyph });
    }
    else if (b.tpl === "T4") {
        if (base.big)
            out.push({ kind: "big", text: base.big });
    }
    return out;
}
function validateCapacity(b, def, at, errors) {
    const cap = def.capacity || {};
    const perStep = cap.perStep || {};
    const perBeat = cap.perBeat || {};
    const steps = Array.isArray(b.steps) ? b.steps : [];
    checkMax(steps.length, perBeat.maxSteps, `${at}：steps 数`, errors);
    if (cap.area === "none") {
        if (Object.keys(b.base || {}).length)
            errors.push(`${at}：T0 白板容量为 0，不允许 base`);
        steps.forEach((s, si) => {
            if (s.state && Object.keys(s.state).length)
                errors.push(`${at} / step ${si}：T0 不允许 state`);
            if (s.show && Object.keys(s.show).length)
                errors.push(`${at} / step ${si}：T0 不允许 show`);
        });
        return;
    }
    if (cap.area === "glyph")
        return;
    if (cap.area === "aux") {
        const all = [...auxItems((b.base || {}).aux)];
        steps.forEach((s, si) => {
            const added = auxItems(s && s.show && s.show.aux);
            checkStepItems(added, perStep.maxNewAuxItems, perStep.maxTextChars, perStep.maxVisualLines, `${at} / step ${si}`, errors);
            all.push(...added);
        });
        const head = all.filter(x => (x.kind || (x.head ? "head" : "")) === "head").length;
        const gloss = all.filter(x => (x.kind || (x.z ? "gloss" : "")) === "gloss").length;
        const point = all.filter(x => (x.kind || "point") === "point").length;
        checkMax(all.length, perBeat.maxAuxItems, `${at}：aux 总数`, errors);
        checkMax(head, perBeat.maxHeadItems, `${at}：head 数`, errors);
        checkMax(gloss, perBeat.maxGlossItems, `${at}：gloss 数`, errors);
        checkMax(point, perBeat.maxPointItems, `${at}：point 数`, errors);
        checkMax(all.reduce((a, x) => a + textLen(textOfAux(x)), 0), perBeat.maxTextChars, `${at}：白板总字数`, errors);
        checkMax(all.reduce((a, x) => a + visualLinesOf(textOfAux(x)), 0), perBeat.maxVisualLines, `${at}：视觉行数`, errors);
    }
    if (cap.area === "center") {
        const all = [...baseCenterItems(b)];
        steps.forEach((s, si) => {
            const added = centerItemsFromShow(s && s.show);
            const maxItems = b.tpl === "T4" ? perStep.maxNewBigItems : perStep.maxNewCenterItems;
            checkStepItems(added, maxItems, perStep.maxTextChars, perStep.maxVisualLines, `${at} / step ${si}`, errors);
            all.push(...added);
        });
        if (b.tpl === "T4") {
            const big = all.filter(x => (x.kind || "big") === "big" || (x.kind || "") === "lead").length;
            checkMax(big, perBeat.maxBigItems, `${at}：big 数`, errors);
        }
        else {
            const title = all.filter(x => x.kind === "title").length;
            const lead = all.filter(x => x.kind !== "title").length;
            checkMax(all.length, perBeat.maxCenterItems, `${at}：center 总数`, errors);
            checkMax(title, perBeat.maxTitleItems, `${at}：title 数`, errors);
            checkMax(lead, perBeat.maxLeadItems, `${at}：lead/note 数`, errors);
        }
        checkMax(all.reduce((a, x) => a + textLen(textOfCenter(x)), 0), perBeat.maxTextChars, `${at}：白板总字数`, errors);
        checkMax(all.reduce((a, x) => a + visualLinesOf(textOfCenter(x)), 0), perBeat.maxVisualLines, `${at}：视觉行数`, errors);
    }
}
function checkStepItems(items, maxItems, maxChars, maxLines, at, errors) {
    checkMax(items.length, maxItems, `${at}：本 step 新增项数`, errors);
    items.forEach((it, i) => {
        const text = it && (it.kind === "head" || it.kind === "gloss" || it.kind === "point" || it.z || it.m) ? textOfAux(it) : textOfCenter(it);
        checkMax(textLen(text), maxChars, `${at}：第 ${i + 1} 项字数`, errors);
        checkMax(visualLinesOf(text), maxLines, `${at}：第 ${i + 1} 项视觉行数`, errors);
    });
}
function checkMax(value, max, label, errors) {
    if (typeof max === "number" && value > max)
        errors.push(`${label} ${value} > ${max}，请压缩板书或拆成下一个 beat`);
}
function validateT0Timing(SB, timeline, beatSpan, options, errors) {
    if (!timeline)
        return {};
    let BOOK_CFG = {};
    const ASSET_ID = SB.assets || SB.book;
    if (ASSET_ID) {
        const skillRoot = options.skillRoot || path.join(__dirname, "..", "..");
        const f = path.join(skillRoot, "assets", String(ASSET_ID), "配置.js");
        if (fs.existsSync(f)) {
            try {
                BOOK_CFG = require(f);
            }
            catch (_) { /* ignore bad optional config here */ }
        }
    }
    const scrollReadyMs = (typeof SB.scrollReadyMs === "number" ? SB.scrollReadyMs : null) ??
        (typeof BOOK_CFG.scrollReadyMs === "number" ? BOOK_CFG.scrollReadyMs : null) ??
        (typeof timeline.scrollReadyMs === "number" ? timeline.scrollReadyMs : null) ??
        6200;
    const scrollReadySrc = typeof SB.scrollReadyMs === "number" ? "分镜.scrollReadyMs"
        : typeof BOOK_CFG.scrollReadyMs === "number" ? "配置.js"
            : typeof timeline.scrollReadyMs === "number" ? "时间轴.scrollReadyMs"
                : "默认 6200";
    const threshold = scrollReadyMs + (options.t0BufferMs ?? 800);
    const sr = (scrollReadyMs / 1000).toFixed(1);
    (SB.beats || []).forEach((b, bi) => {
        if (b.tpl !== "T0")
            return;
        const span = beatSpan[bi];
        if (!span)
            return;
        if (span.endMs > threshold) {
            errors.push(`第 ${bi} 拍 T0 越过卷轴铺好时刻：结束 ${(span.endMs / 1000).toFixed(1)}s，scrollReadyMs=${sr}s(来源 ${scrollReadySrc})`);
        }
    });
    const firstNonT0 = (SB.beats || []).findIndex((b) => b.tpl !== "T0");
    if (firstNonT0 >= 0 && beatSpan[firstNonT0] && beatSpan[firstNonT0].startMs > threshold) {
        errors.push(`卷轴铺好后仍空窗：第一个非 T0 的拍要到 ${(beatSpan[firstNonT0].startMs / 1000).toFixed(1)}s 才起，scrollReadyMs=${sr}s(来源 ${scrollReadySrc})`);
    }
    return { scrollReadyMs, scrollReadySrc };
}
function validateSubtitleCut(beats, atomMap, warnings) {
    const enderRe = /(——|[。.！!？?；;，,、：:…」』""）)】])\s*$/;
    beats.forEach((b, bi) => {
        const text = (b.take || [])
            .map((id) => atomMap.get(String(id)))
            .filter(Boolean)
            .map((a) => a.narr)
            .join("")
            .trim();
        if (text && !enderRe.test(text))
            warnings.push(`第 ${bi} 拍 narr 不以标点收尾，切点可能落在子句中间「...${text.slice(-12)}」`);
    });
}
function headOf(s) {
    const t = String(s == null ? "" : s).replace(/\s+/g, "");
    return t.length > 14 ? t.slice(0, 14) + "..." : t;
}
