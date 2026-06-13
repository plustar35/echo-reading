#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
/* 离屏渲染叠层：用 CDP 虚拟时间逐帧推进 renderer.html?record=1 页面，截透明 PNG 序列。
 * 之后在 ffmpeg 里把这套 PNG 叠到背景视频上。一般由 render-video.sh 调用。
 * 用法： node dist/cli/render-overlay.js "<runtime/renderer.html?...&record=1 的 file:// URL>"
 * env:  OUT(输出目录) FPS(默认24) MAXF(限制帧数,调试用,0=全部) PORT */
const { spawn } = require('child_process');
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = +(process.env.PORT || 9333);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FILE = process.argv[2];
if (!FILE) {
    console.error('用法: node render-overlay.js "<renderer URL ?...&record=1>"');
    process.exit(1);
}
const OUT = process.env.OUT || "/tmp/overlay-frames";
const FPS = +(process.env.FPS || 24);
const FRAME_MS = 1000 / FPS;
const MAXF = process.env.MAXF ? +process.env.MAXF : 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = url => new Promise((res, rej) => { http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try {
    res(JSON.parse(d));
}
catch (e) {
    rej(e);
} }); }).on('error', rej); });
let ws, msgId = 0;
const pending = new Map();
let evWaiters = [];
function connect(url) {
    return new Promise((res, rej) => {
        ws = new WebSocket(url);
        ws.onopen = () => res();
        ws.onerror = e => rej(new Error('ws err'));
        ws.onmessage = ev => {
            const m = JSON.parse(ev.data);
            if (m.id && pending.has(m.id)) {
                const { resolve, reject } = pending.get(m.id);
                pending.delete(m.id);
                m.error ? reject(new Error(m.method + ': ' + JSON.stringify(m.error))) : resolve(m.result);
            }
            else if (m.method) {
                evWaiters = evWaiters.filter(w => { if (w.method === m.method) {
                    w.resolve(m.params);
                    return false;
                } return true; });
            }
        };
    });
}
function send(method, params = {}, sessionId) { return new Promise((resolve, reject) => { const id = ++msgId; pending.set(id, { resolve, reject }); const msg = { id, method, params }; if (sessionId)
    msg.sessionId = sessionId; ws.send(JSON.stringify(msg)); }); }
function waitEvent(method) { return new Promise(resolve => evWaiters.push({ method, resolve })); }
function withTO(p, ms, label) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT ' + label)), ms))]); }
(async () => {
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
    const userDir = fs.mkdtempSync('/tmp/chrome-rec-');
    const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--hide-scrollbars',
        '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--force-color-profile=srgb',
        '--run-all-compositor-stages-before-draw', '--disable-new-content-rendering-timeout',
        '--disable-threaded-animation', '--disable-threaded-scrolling', '--disable-checker-imaging',
        '--user-data-dir=' + userDir, '--window-size=1280,720', 'about:blank'], { stdio: 'ignore' });
    let wsurl;
    for (let i = 0; i < 60 && !wsurl; i++) {
        try {
            const v = await getJSON(`http://127.0.0.1:${PORT}/json/version`);
            wsurl = v.webSocketDebuggerUrl;
        }
        catch (e) {
            await sleep(100);
        }
    }
    if (!wsurl)
        throw new Error('chrome not up');
    await connect(wsurl);
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });
    const sendS = (m, p) => send(m, p, S);
    await sendS('Page.enable');
    await sendS('Runtime.enable');
    await sendS('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await sendS('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    const loaded = waitEvent('Page.loadEventFired');
    await sendS('Page.navigate', { url: FILE });
    await loaded;
    await sendS('Runtime.evaluate', { expression: 'document.fonts.ready.then(()=>true)', awaitPromise: true });
    let totalMs = 0; // 分镜/配置.js 是动态脚本，init 可能晚于 load 事件——轮询等它就绪
    for (let i = 0; i < 100 && !totalMs; i++) {
        const tot = await sendS('Runtime.evaluate', { expression: 'window.__RENDER_TOTAL_MS', returnByValue: true });
        totalMs = tot.result.value || 0;
        if (!totalMs)
            await sleep(100);
    }
    if (!totalMs)
        throw new Error('no __RENDER_TOTAL_MS (record mode not active?)');
    let frames = Math.ceil(totalMs / FRAME_MS) + 1;
    if (MAXF)
        frames = Math.min(frames, MAXF);
    console.error(`total ${(totalMs / 1000).toFixed(1)}s -> ${frames} frames @${FPS}fps`);
    await sendS('Emulation.setVirtualTimePolicy', { policy: 'pause' });
    await sendS('Runtime.evaluate', { expression: '__startRec()' });
    const VERBOSE = process.env.VERBOSE === '1';
    const t0 = Date.now();
    for (let f = 0; f < frames; f++) {
        const exp = waitEvent('Emulation.virtualTimeBudgetExpired');
        await sendS('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: FRAME_MS, maxVirtualTimeTaskStarvationCount: 1000000 });
        if (VERBOSE)
            process.stderr.write(`f${f} adv-sent `);
        await withTO(exp, 8000, 'budgetExpired f' + f);
        if (VERBOSE)
            process.stderr.write('expired ');
        const shot = await withTO(sendS('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1280, height: 720, scale: 1 }, captureBeyondViewport: false }), 8000, 'screenshot f' + f);
        if (VERBOSE)
            process.stderr.write('shot\n');
        fs.writeFileSync(path.join(OUT, String(f).padStart(5, '0') + '.png'), Buffer.from(shot.data, 'base64'));
        if (f % 200 === 0 || f === frames - 1) {
            const el = (Date.now() - t0) / 1000;
            process.stderr.write(`  frame ${f + 1}/${frames}  ${el.toFixed(0)}s\n`);
        }
    }
    try {
        await send('Target.closeTarget', { targetId });
    }
    catch (e) { }
    try {
        ws.close();
    }
    catch (e) { }
    try {
        chrome.kill();
    }
    catch (e) { }
    try {
        fs.rmSync(userDir, { recursive: true, force: true });
    }
    catch (e) { }
    console.error('done -> ' + OUT);
    process.exit(0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
