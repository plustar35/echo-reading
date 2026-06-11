#!/usr/bin/env node
/* 素材套初始化 · 可视化配置台（server）
 *
 * 起一个本地配置台：在真实底板上拖拽看板框/字幕带/章名位、滚片头视频标 scrollReadyMs、
 * 调配色与模板字体字号——预览用成片同一个 renderer.html（所见即所得），保存写回
 * SKILL/assets/<素材id>/配置.js（旧文件备份 .bak）。一套素材一份配置、初始化一次；
 * 换新素材 = 新素材套目录 = 重新初始化。
 *
 * 用法： node scripts/init-studio.js <素材id> [端口]   # 默认 8765，打开 http://localhost:8765
 * 前置： SKILL/assets/<素材id>/ 已有 底板.png + 片头.mp4（配置.js 可以还没有，保存时生成）
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const BOOK = process.argv[2];                  // 素材套（SKILL/assets/ 下相对路径，如 道德经/水墨卷轴）
const PORT = +(process.argv[3] || 8765);
if (!BOOK) { console.error("用法: node scripts/init-studio.js <书名>/<素材id> [端口]"); process.exit(1); }

const SCRIPTS = __dirname;
const ASSETS = path.join(SCRIPTS, "..", "assets", BOOK);
const CFG_PATH = path.join(ASSETS, "配置.js");
if (!fs.existsSync(path.join(ASSETS, "底板.png"))) {
  console.error(`✗ ${path.relative(process.cwd(), ASSETS)}/底板.png 不存在——先把画面素材放进去（见 references/资产层与新书.md）`);
  process.exit(1);
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".mp4": "video/mp4", ".m4a": "audio/mp4", ".css": "text/css" };

// 种子默认值（中性居中框——初始化的第一步就是把它拖到这本书底板的看板上）
const DEFAULTS = {
  scrollReadyMs: 6200, introVideoMs: 8000, voice: "zh-CN-YunjianNeural", rate: "-8%",
  board: { left: 27, top: 28, width: 46, height: 44 },
  titlePos: { left: 80, top: 50 },
  subtitle: { side: 8, bottom: 3.8 },
  palette: { paper: "#ece4d2", ink: "#3a3322", ink2: "#5a4f37", accent: "#b3401f", gold: "#9a7b2e" },
  tplVars: {},
};

function readConfig() {
  if (!fs.existsSync(CFG_PATH)) return { ...DEFAULTS };
  delete require.cache[require.resolve(CFG_PATH)];
  const c = require(CFG_PATH);
  return Object.assign({}, DEFAULTS, c,
    { board: { ...DEFAULTS.board, ...(c.board || {}) },
      titlePos: { ...DEFAULTS.titlePos, ...(c.titlePos || {}) },
      subtitle: { ...DEFAULTS.subtitle, ...(c.subtitle || {}) },
      palette: { ...DEFAULTS.palette, ...(c.palette || {}) },
      tplVars: { ...(c.tplVars || {}) } });
}

function configToJs(c) {
  const j = o => JSON.stringify(o);
  return `/* 素材套「${BOOK}」的配置 —— 一套素材一份配置，描述这套画面素材的参数，单一来源。
 * gen-tts（默认嗓 / 看板时刻）、align-durs（T0 校验线）、renderer（几何 / 配色 / 淡出）都读这里。
 * 可视化修改：node SKILL/scripts/init-studio.js ${BOOK}
 * 字段：scrollReadyMs=片头里看板就绪时刻(ms,T0 截止线)；introVideoMs=片头时长(ms,预览淡出用)；
 *       board/titlePos/subtitle=几何(% of 16:9)；palette=配色；tplVars=模板字体字号微调(CSS 变量)。 */
const BOOK_CONFIG = {
  scrollReadyMs: ${c.scrollReadyMs},
  introVideoMs: ${c.introVideoMs},
  voice: ${j(c.voice)},
  rate: ${j(c.rate)},
  board:    ${j(c.board)},
  titlePos: ${j(c.titlePos)},
  subtitle: ${j(c.subtitle)},
  palette:  ${j(c.palette)},
  tplVars:  ${j(c.tplVars)},
};
if (typeof window !== "undefined") window.BOOK_CONFIG = BOOK_CONFIG;
if (typeof module !== "undefined") module.exports = BOOK_CONFIG;
`;
}

// 模板样例分镜：每套模板一拍，配置台 iframe 用 ?beat=N 逐套静帧预览（与成片同一渲染器）
function sampleStoryboard() {
  return `const STORYBOARD={book:${JSON.stringify(BOOK.split("/")[0])},assets:${JSON.stringify(BOOK)},chapter:"样例",scrollTitle:"样例",
audio:"无音轨.m4a",
jing:[{id:"s1",parts:[{k:"a",t:"示例原文短语"},{p:"，"},{k:"b",t:"再来一段短语"},{p:"。"}]}],
beats:[
 {seg:"T0",tpl:"T0",narr:"开场字幕样例，浮在片头画面上，看板就绪前只有这一行。"},
 {seg:"T3",tpl:"T3",glyph:"字",narr:"中央大字样例。"},
 {seg:"T2",tpl:"T2",title:"标题样例",lead:["引句样例一，铺垫一句。","引句样例二。"],narr:"标题加引样例。"},
 {seg:"T1",tpl:"T1",sent:"s1",hi:["a"],aux:{head:"看板标题样例",gloss:[{z:"字",p:"zì",m:"释义样例"}],points:["要点是完整短句的样例","第二条要点样例"]},narr:"逐句精讲样例，右侧点亮原文短语。"},
 {seg:"T4",tpl:"T4",big:"一句话大字样例，<br><em>朱砂强调半句</em>。",narr:"收束样例。"}],
durs:[4000,4000,4000,4000,4000]};
if(typeof window!=="undefined")window.STORYBOARD=STORYBOARD;
if(typeof module!=="undefined")module.exports=STORYBOARD;`;
}

function send(res, code, body, type) {
  res.writeHead(code, { "Content-Type": type || "text/plain; charset=utf-8" });
  res.end(body);
}

function serveFile(req, res, abs) {
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(res, 404, "not found: " + abs);
  const type = MIME[path.extname(abs).toLowerCase()] || "application/octet-stream";
  const size = fs.statSync(abs).size;
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {                                  // 视频拖进度条需要 Range
    const start = range[1] ? +range[1] : 0;
    const end = range[2] ? +range[2] : size - 1;
    res.writeHead(206, { "Content-Type": type, "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    fs.createReadStream(abs, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
    fs.createReadStream(abs).pipe(res);
  }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const p = decodeURIComponent(u.pathname);

  if (p === "/" || p === "/studio.html")
    return serveFile(req, res, path.join(SCRIPTS, "studio.html"));
  if (p === "/scripts/studio-sample.js")
    return send(res, 200, sampleStoryboard(), MIME[".js"]);
  if (p === "/api/meta")
    return send(res, 200, JSON.stringify({ book: BOOK }), MIME[".json"]);
  if (p === "/api/config")
    return send(res, 200, JSON.stringify(readConfig()), MIME[".json"]);
  if (p === "/api/save" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const cfg = Object.assign(readConfig(), JSON.parse(body));
        if (fs.existsSync(CFG_PATH)) fs.copyFileSync(CFG_PATH, CFG_PATH + ".bak");
        fs.writeFileSync(CFG_PATH, configToJs(cfg));
        console.log("✓ 已保存 " + path.relative(process.cwd(), CFG_PATH));
        send(res, 200, JSON.stringify({ ok: true }), MIME[".json"]);
      } catch (e) { send(res, 400, JSON.stringify({ ok: false, error: e.message }), MIME[".json"]); }
    });
    return;
  }
  if (p.startsWith("/scripts/"))               // renderer.html 等引擎文件
    return serveFile(req, res, path.join(SCRIPTS, p.slice("/scripts/".length)));
  if (p.startsWith("/assets/"))                // 书级资产（底板/片头/配置…）
    return serveFile(req, res, path.join(SCRIPTS, "..", "assets", p.slice("/assets/".length)));
  send(res, 404, "not found");
});

server.listen(PORT, () => {
  console.log(`《${BOOK}》配置台 → http://localhost:${PORT}`);
  console.log(`  资产目录 ${path.relative(process.cwd(), ASSETS)} · 保存写回 配置.js（旧文件备份 .bak）· Ctrl-C 退出`);
});
