#!/usr/bin/env node
// @ts-nocheck
/* 领读视频 · 布局检查。
 *
 * 用 Chrome 打开 runtime/renderer.html 的每个 beat/step 静帧，检查可见内容是否跑出模板容器。
 * 这是模板 capacity 静态校验后的第二道保险，专门挡住真实字体、素材配置、DOM 布局导致的溢出。
 *
 * 用法： node dist/cli/layout-check.js <分镜.js 路径>
 */
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");
const SB_IN = process.argv[2];
if (!SB_IN) {
    console.error("用法: node dist/cli/layout-check.js <分镜.js 路径>");
    process.exit(1);
}
const SB_ABS = path.resolve(SB_IN);
if (!fs.existsSync(SB_ABS)) {
    console.error("找不到分镜: " + SB_ABS);
    process.exit(1);
}
let SB;
try {
    SB = require(SB_ABS);
}
catch (e) {
    console.error("无法 require 分镜: " + SB_ABS + "\n  " + e.message);
    process.exit(1);
}
const beats = Array.isArray(SB.beats) ? SB.beats : [];
if (!beats.length) {
    console.error("分镜里没有 beats[]");
    process.exit(1);
}
const SKILL_ROOT = path.resolve(__dirname, "..", "..");
const RUNTIME_DIR = path.join(SKILL_ROOT, "runtime");
const RENDERER = path.join(RUNTIME_DIR, "renderer.html");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = +(process.env.PORT || Math.floor(9400 + Math.random() * 400));
const TOL = +(process.env.LAYOUT_TOL || 2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = url => new Promise((res, rej) => {
    http.get(url, r => {
        let d = "";
        r.on("data", c => d += c);
        r.on("end", () => { try {
            res(JSON.parse(d));
        }
        catch (e) {
            rej(e);
        } });
    }).on("error", rej);
});
let ws, msgId = 0, evWaiters = [];
const pending = new Map();
function connect(url) {
    return new Promise((res, rej) => {
        ws = new WebSocket(url);
        ws.onopen = () => res();
        ws.onerror = () => rej(new Error("ws err"));
        ws.onmessage = ev => {
            const m = JSON.parse(ev.data);
            if (m.id && pending.has(m.id)) {
                const { resolve, reject } = pending.get(m.id);
                pending.delete(m.id);
                m.error ? reject(new Error(m.method + ": " + JSON.stringify(m.error))) : resolve(m.result);
            }
            else if (m.method) {
                evWaiters = evWaiters.filter(w => {
                    if (w.method === m.method) {
                        w.resolve(m.params);
                        return false;
                    }
                    return true;
                });
            }
        };
    });
}
function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, { resolve, reject });
        const msg = { id, method, params };
        if (sessionId)
            msg.sessionId = sessionId;
        ws.send(JSON.stringify(msg));
    });
}
function waitEvent(method) { return new Promise(resolve => evWaiters.push({ method, resolve })); }
function frameUrl(beatIndex, stepIndex) {
    const u = new URL(pathToFileURL(RENDERER).href);
    u.searchParams.set("data", path.relative(RUNTIME_DIR, SB_ABS));
    u.searchParams.set("record", "1");
    u.searchParams.set("beat", String(beatIndex));
    if (stepIndex != null)
        u.searchParams.set("step", String(stepIndex));
    return u.href;
}
const expr = (beatIndex, stepIndex) => `(() => {
  const beatIndex=${beatIndex}, stepIndex=${stepIndex == null ? "null" : stepIndex};
  const b=window.STORYBOARD&&window.STORYBOARD.beats&&window.STORYBOARD.beats[beatIndex];
  function rectOf(el){const r=el.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};}
  function visible(el){
    const cs=getComputedStyle(el);
    const r=el.getBoundingClientRect();
    return cs.display!=='none'&&cs.visibility!=='hidden'&&Number(cs.opacity)!==0&&r.width>0&&r.height>0;
  }
  function union(nodes){
    let u=null;
    nodes.filter(visible).forEach(n=>{
      const r=n.getBoundingClientRect();
      if(!u)u={left:r.left,top:r.top,right:r.right,bottom:r.bottom};
      else{u.left=Math.min(u.left,r.left);u.top=Math.min(u.top,r.top);u.right=Math.max(u.right,r.right);u.bottom=Math.max(u.bottom,r.bottom);}
    });
    return u;
  }
  function check(name,containerSel,itemSel){
    const c=document.querySelector(containerSel);
    if(!c||!visible(c))return null;
    const cr=c.getBoundingClientRect();
    const items=[...c.querySelectorAll(itemSel||'*')];
    const u=union(items.length?items:[c])||rectOf(c);
    const overflow=c.scrollHeight>c.clientHeight+${TOL}||c.scrollWidth>c.clientWidth+${TOL}||
      u.left<cr.left-${TOL}||u.top<cr.top-${TOL}||u.right>cr.right+${TOL}||u.bottom>cr.bottom+${TOL};
    return {name,overflow,container:rectOf(c),content:u,scroll:{w:c.scrollWidth,h:c.scrollHeight,cw:c.clientWidth,ch:c.clientHeight}};
  }
  const checks=[];
  if(b&&b.tpl==='T1'){checks.push(check('aux','#aux','.aux-item'));checks.push(check('jing','#jing','.cols'));}
  if(b&&['T2','T3','T4'].includes(b.tpl)){checks.push(check('center','#center','#center > *'));}
  return {beat:beatIndex,step:stepIndex,tpl:b&&b.tpl,seg:b&&b.seg,checks:checks.filter(Boolean)};
})()`;
(async () => {
    let chrome, userDir, targetId;
    try {
        userDir = fs.mkdtempSync("/tmp/chrome-layout-");
        chrome = spawn(CHROME, [
            "--headless=new", "--remote-debugging-port=" + PORT, "--hide-scrollbars",
            "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--force-color-profile=srgb",
            "--user-data-dir=" + userDir, "--window-size=1280,720", "about:blank"
        ], { stdio: "ignore" });
        let wsurl;
        for (let i = 0; i < 80 && !wsurl; i++) {
            try {
                const v = await getJSON(`http://127.0.0.1:${PORT}/json/version`);
                wsurl = v.webSocketDebuggerUrl;
            }
            catch (_) {
                await sleep(100);
            }
        }
        if (!wsurl)
            throw new Error("chrome not up");
        await connect(wsurl);
        ({ targetId } = await send("Target.createTarget", { url: "about:blank" }));
        const { sessionId: S } = await send("Target.attachToTarget", { targetId, flatten: true });
        const sendS = (m, p) => send(m, p, S);
        await sendS("Page.enable");
        await sendS("Runtime.enable");
        await sendS("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
        await sendS("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
        const failures = [];
        for (let bi = 0; bi < beats.length; bi++) {
            const steps = Array.isArray(beats[bi].steps) && beats[bi].steps.length ? beats[bi].steps : [null];
            for (let si = 0; si < steps.length; si++) {
                const loaded = waitEvent("Page.loadEventFired");
                await sendS("Page.navigate", { url: frameUrl(bi, steps[0] === null ? null : si) });
                await loaded;
                await sendS("Runtime.evaluate", { expression: "document.fonts.ready.then(()=>true)", awaitPromise: true });
                for (let tries = 0; tries < 60; tries++) {
                    const ready = await sendS("Runtime.evaluate", { expression: "!!(window.STORYBOARD&&document.querySelector('#stage'))", returnByValue: true });
                    if (ready.result.value)
                        break;
                    await sleep(50);
                }
                const r = await sendS("Runtime.evaluate", { expression: expr(bi, steps[0] === null ? null : si), returnByValue: true });
                const snap = r.result.value;
                for (const c of (snap.checks || [])) {
                    if (c.overflow)
                        failures.push(`${snap.beat}/${snap.step == null ? "-" : snap.step} ${snap.tpl} ${snap.seg || ""}：${c.name} 溢出`);
                }
            }
        }
        if (failures.length) {
            console.error("\n✗ layout-check 失败：");
            failures.forEach(f => console.error("   · " + f));
            process.exitCode = 1;
        }
        else {
            console.log(`✓ layout-check 通过 · ${beats.length} 拍`);
        }
        try {
            await send("Target.closeTarget", { targetId });
        }
        catch (_) { }
    }
    catch (e) {
        console.error("ERROR", e && e.message || e);
        process.exitCode = 1;
    }
    finally {
        try {
            if (ws)
                ws.close();
        }
        catch (_) { }
        try {
            if (chrome)
                chrome.kill();
        }
        catch (_) { }
        try {
            if (userDir)
                fs.rmSync(userDir, { recursive: true, force: true });
        }
        catch (_) { }
    }
})();
