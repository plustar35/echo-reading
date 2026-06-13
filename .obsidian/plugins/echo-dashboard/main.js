"use strict";

const { Plugin, ItemView, TFile, TFolder, Notice, debounce, setIcon } = require("obsidian");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEW_TYPE = "echo-dashboard-view";

const DIMENSIONS = [
  { key: "概念", icon: "lightbulb", hue: 210 },
  { key: "延伸", icon: "compass", hue: 165 },
  { key: "你的故事", icon: "user", hue: 28 },
  { key: "闪回", icon: "zap", hue: 268 },
  { key: "共振", icon: "heart", hue: 338 },
  { key: "悬题", icon: "circle-help", hue: 48 },
];
const DIM_BY_KEY = Object.fromEntries(DIMENSIONS.map((d) => [d.key, d]));

// 暖色系书籍配色：赤陶 / 鼠尾草绿 / 赭金 / 灰蓝 / 豆沙玫瑰 / 橄榄褐，
// 与看板的米色底 + 赤陶强调色协调，避开扎眼的品红/荧光绿。按书名稳定排序取色，跨刷新不变。
const BOOK_PALETTE = ["#c0703f", "#7a9b6e", "#d8a24a", "#6f8c9c", "#b06a78", "#9b8252"];
function bookColorMap(names) {
  const order = [...names].sort();
  const m = new Map();
  order.forEach((n, i) => m.set(n, BOOK_PALETTE[i % BOOK_PALETTE.length]));
  return m;
}

/* ---------------- 数据解析 ---------------- */

// "ch02 — 第一卷" / "第 19 章 — 绝圣弃智…" → "ch02" / "ch19"
function chDirOf(label) {
  let m = label.match(/^ch(\d+)/i);
  if (!m) m = label.match(/第\s*(\d+)\s*章/);
  if (!m) return null;
  return "ch" + m[1].padStart(2, "0");
}

// 把一行勾选项拆成 { done, label, review }
function parseCheckLine(line) {
  const m = line.match(/^(\s*)- \[( |x|X)\]\s*(.+)$/);
  if (!m) return null;
  let body = m[3].trim();
  let review = null;
  const ri = body.indexOf("· 回看");
  if (ri >= 0) {
    review = body.slice(ri).replace(/^· 回看[：:]\s*/, "").trim();
    body = body.slice(0, ri).trim().replace(/·$/, "").trim();
  }
  return { indent: m[1].length, done: m[2].toLowerCase() === "x", label: body, review };
}

function parseProgress(text) {
  const chapters = [];
  let current = null;
  for (const line of text.split("\n")) {
    const item = parseCheckLine(line);
    if (!item) continue;
    if (item.indent === 0) {
      current = {
        done: item.done,
        label: item.label,
        review: item.review,
        chDir: chDirOf(item.label),
        units: [],
      };
      chapters.push(current);
    } else if (current) {
      const um = item.label.match(/^(\d+)\s*/);
      current.units.push({
        done: item.done,
        label: item.label,
        review: item.review,
        unitId: um ? um[1].padStart(2, "0") : null,
      });
    }
  }
  return chapters;
}

function bookStats(chapters) {
  let done = 0;
  let score = 0;
  let unitsDone = 0;
  let unitsTotal = 0;
  for (const ch of chapters) {
    if (ch.units.length) {
      const d = ch.units.filter((u) => u.done).length;
      unitsDone += d;
      unitsTotal += ch.units.length;
      if (ch.done) {
        done++;
        score += 1;
      } else {
        score += d / ch.units.length;
      }
    } else {
      if (ch.done) {
        done++;
        score += 1;
      }
    }
  }
  const total = chapters.length;
  return { done, total, unitsDone, unitsTotal, percent: total ? score / total : 0 };
}

// 当前读到哪：优先读了一半的章，其次第一个没读完的章
function currentPosition(chapters) {
  for (const ch of chapters) {
    if (!ch.done && ch.units.some((u) => u.done) && ch.units.some((u) => !u.done)) {
      return { chapter: ch, unit: ch.units.find((u) => !u.done) };
    }
  }
  for (const ch of chapters) {
    if (ch.done) continue;
    if (ch.units.length) {
      const u = ch.units.find((x) => !x.done);
      if (u) return { chapter: ch, unit: u };
    }
    return { chapter: ch, unit: null };
  }
  return null;
}

/* ---------------- 阅读时长 ---------------- */
/* RT-BEGIN：纯 Node 逻辑，不依赖 Obsidian API，可单独跑测试 */

const RT_VERSION = 6; // 算法变更时 +1，作废旧缓存
const RT_GAP_MS = 30 * 60 * 1000; // 用户超过 30min 没有回复 → 视为离开，该段不计
const RT_MIN_BOOK_HITS = 3; // 书籍被提及少于这个次数 → 不算阅读会话
// 判定 = 开场触发 ∨（行为佐证 ∧ 开场不是开发话术）。两条路任一即可：
// · 开场触发：前几条用户消息有触发语/划线提问。真阅读会话开场白就是「继续读X」；
//   开发会话要聊到第 4 条之后才带出这些词——位置本身就是判别器
// · 行为佐证：会话里写过该书单元/批注、insight 或 progress（备读/沉淀/勾进度是阅读的
//   确定性产物），或有划线提问。给触发语兜底——换个用户换种说法，只要走了阅读工作流就能命中。
//   但维护/开发会话（批量改 insight、批注调试、备读测试）也有写入，所以这条路要求
//   开场没有开发话术（功能/实现/skill/hook…开发词汇是领域稳定的，比阅读触发语好穷举）
const RT_TRIGGER_WITHIN = 2;
const RT_DEV_OPENING =
  /功能|实现|skill|hook|插件|脚本|代码|重构|优化|bug|修复|frontmatter|index|commit|git|录入|导入|入库|prototype|渲染|视频|看板|dashboard|批注|notes|统计|insight/i;
// 硬豁免：调试本看板的会话里书名/触发语全是样例数据，按插件 id 出现次数剔除
const RT_DEV_MARKER = "echo-dashboard";
const RT_DEV_HITS = 20;

function rtCount(text, needle) {
  let n = 0,
    i = 0;
  while ((i = text.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

function rtLocalDay(ms) {
  const d = new Date(ms);
  return (
    d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0")
  );
}

const RT_SELECTION_MARK = '<editor_selection path="books/'; // 在原文上划线提问 → 强阅读信号

function rtEscapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 阅读触发语：只认用户亲手输入的文本（"继续读 / 陪读 / 读《X》/ 读道德经 / 读What…"）
function rtTriggerRe(bookNames) {
  const names = bookNames.map(rtEscapeRe).join("|");
  return new RegExp(`(继续|接着|开始|一起|往下)\\s*阅?读|陪读|读.{0,2}《|下一章|下一个?单元|读\\s*[A-Za-z]|读\\s*(${names})`);
}

// 写入类工具调用行（Claude 的 Edit/Write/MultiEdit、filesystem MCP、Codex 的 apply_patch）
function rtIsWriteLine(line) {
  return (
    line.includes('"name":"Edit"') ||
    line.includes('"name":"Write"') ||
    line.includes('"name":"MultiEdit"') ||
    line.includes('"name":"mcp__filesystem__edit_file"') ||
    line.includes('"name":"mcp__filesystem__write_file"') ||
    line.includes("apply_patch")
  );
}

// 从一行 jsonl 提取「用户亲手输入」的消息文本，不是用户消息 → null
// Claude：type:user 且 content 为字符串（skill 展开是 text 块数组、工具结果是 tool_result 数组，天然排除）
// Codex：event_msg 的 user_message
function rtUserText(line) {
  if (line.length > 500000) return null;
  try {
    const d = JSON.parse(line);
    if (d.type === "user" && !d.isSidechain && d.message && typeof d.message.content === "string") {
      const s = d.message.content;
      if (s.startsWith("<") && !s.includes(RT_SELECTION_MARK)) return null; // command 展开等注入
      if (s.startsWith("Caveat") || s.startsWith("This session is being continued")) return null;
      return s;
    }
    if (d.type === "event_msg" && d.payload && d.payload.type === "user_message" && typeof d.payload.message === "string")
      return d.payload.message;
  } catch (e) {}
  return null;
}

// 一份 jsonl 会话全文 → { book, mins, times }；mins=用户发消息的「分钟」时间戳（去重排序），
// times=每条用户消息的毫秒时间戳（算「对话次数」用，按毫秒去重可消掉 fork/resume 的复制）；非阅读会话 → null
function rtParseSession(text, bookNames) {
  const minsSet = new Set();
  const timesSet = new Set();
  const hits = new Map();
  const unitWrites = new Map(); // 书 → 写该书单元/批注文件的次数
  const progWrites = new Map(); // 书 → 写该书 progress.md 的次数
  let insightWrites = 0;
  let devHits = 0;
  let userMsgN = 0;
  let trigger = false;
  let devOpening = false;
  let selection = false;
  const tsRe = /"timestamp"\s*:\s*"([^"]+)"/;
  const trigRe = rtTriggerRe(bookNames);
  const unitRes = bookNames.map((b) => new RegExp(`books/${rtEscapeRe(b)}/ch\\d+/[^"]*\\.md`));
  for (const line of text.split("\n")) {
    if (line.length < 2) continue;
    for (const b of bookNames) {
      const c = rtCount(line, "books/" + b + "/") + rtCount(line, "《" + b + "》");
      if (c) hits.set(b, (hits.get(b) || 0) + c);
    }
    devHits += rtCount(line, RT_DEV_MARKER);
    if (rtIsWriteLine(line)) {
      bookNames.forEach((b, i) => {
        if (unitRes[i].test(line)) unitWrites.set(b, (unitWrites.get(b) || 0) + 1);
        if (line.includes(`books/${b}/progress.md`)) progWrites.set(b, (progWrites.get(b) || 0) + 1);
      });
      if (line.includes("insight/")) insightWrites++;
    }
    if (!line.includes('"type":"user"') && !line.includes('"user_message"')) continue;
    const s = rtUserText(line);
    if (s === null) continue;
    userMsgN++;
    const m = tsRe.exec(line);
    if (m) {
      const t = Date.parse(m[1]);
      if (!isNaN(t)) {
        minsSet.add(Math.floor(t / 60000));
        timesSet.add(t);
      }
    }
    if (s.includes(RT_SELECTION_MARK)) selection = true;
    if (userMsgN <= RT_TRIGGER_WITHIN) {
      if (!trigger && (trigRe.test(s) || s.includes(RT_SELECTION_MARK))) trigger = true;
      if (!devOpening && RT_DEV_OPENING.test(s)) devOpening = true;
    }
  }
  let book = null,
    best = 0;
  for (const [b, c] of hits) {
    if (c > best) {
      best = c;
      book = b;
    }
  }
  if (!book || best < RT_MIN_BOOK_HITS || devHits >= RT_DEV_HITS) return null;
  const confirmed = selection || (unitWrites.get(book) || 0) > 0 || (progWrites.get(book) || 0) > 0 || insightWrites > 0;
  if (!trigger && !(confirmed && !devOpening)) return null;
  const mins = [...minsSet].sort((a, b) => a - b);
  if (mins.length < 2) return null;
  return { book, mins, times: [...timesSet] };
}

async function rtReadHead(fsp, file, n) {
  const fh = await fsp.open(file, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    await fh.close();
  }
}

// 增量扫描 Claude Code + Codex 会话记录；cache: { 文件路径: { mtime, size, book, mins } }
async function rtScan(vaultPath, bookNames, cache) {
  let fsp, path, os;
  try {
    fsp = require("fs").promises;
    path = require("path");
    os = require("os");
  } catch (e) {
    return { ok: false, sessions: [], changed: false };
  }
  const home = os.homedir();
  const base = path.basename(vaultPath);
  const sessions = [];
  const seen = new Set();
  let changed = false;

  const handle = async (file, parse) => {
    let st;
    try {
      st = await fsp.stat(file);
    } catch (e) {
      return;
    }
    seen.add(file);
    const c = cache[file];
    if (c && c.mtime === st.mtimeMs && c.size === st.size) {
      if (c.book) sessions.push({ book: c.book, mins: c.mins || [], times: c.times || [] });
      return;
    }
    const entry = { mtime: st.mtimeMs, size: st.size, book: null, mins: null, times: null };
    try {
      const parsed = await parse(file);
      if (parsed) {
        entry.book = parsed.book;
        entry.mins = parsed.mins;
        entry.times = parsed.times;
        sessions.push(parsed);
      }
    } catch (e) {
      console.error("echo-dashboard: 会话解析失败", file, e);
    }
    cache[file] = entry;
    changed = true;
  };

  // Claude Code：~/.claude/projects/<路径 slug>/*.jsonl（-<vault 名> 后缀兼容 worktree 目录）
  const slug = vaultPath.replace(/[^A-Za-z0-9-]/g, "-");
  const baseSlug = base.replace(/[^A-Za-z0-9-]/g, "-");
  const projRoot = path.join(home, ".claude", "projects");
  let projDirs = [];
  try {
    projDirs = await fsp.readdir(projRoot);
  } catch (e) {}
  for (const d of projDirs) {
    if (d !== slug && !d.endsWith("-" + baseSlug)) continue;
    let entries = [];
    try {
      entries = await fsp.readdir(path.join(projRoot, d), { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const f of entries) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      await handle(path.join(projRoot, d, f.name), async (p) =>
        rtParseSession(await fsp.readFile(p, "utf8"), bookNames)
      );
    }
  }

  // Codex：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl，先读头部 cwd 判断是否本项目（含 worktree）
  const codexRoot = path.join(home, ".codex", "sessions");
  const dayDirs = [];
  try {
    for (const y of await fsp.readdir(codexRoot, { withFileTypes: true })) {
      if (!y.isDirectory()) continue;
      const yDir = path.join(codexRoot, y.name);
      let months = [];
      try {
        months = await fsp.readdir(yDir, { withFileTypes: true });
      } catch (e) {
        continue;
      }
      for (const mo of months) {
        if (!mo.isDirectory()) continue;
        const moDir = path.join(yDir, mo.name);
        let ds = [];
        try {
          ds = await fsp.readdir(moDir, { withFileTypes: true });
        } catch (e) {
          continue;
        }
        for (const dd of ds) if (dd.isDirectory()) dayDirs.push(path.join(moDir, dd.name));
      }
    }
  } catch (e) {}
  for (const dir of dayDirs) {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const f of entries) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      await handle(path.join(dir, f.name), async (p) => {
        const head = await rtReadHead(fsp, p, 8192);
        const cm = head.match(/"cwd":"([^"]+)"/);
        if (!cm || (cm[1] !== vaultPath && !cm[1].endsWith("/" + base))) return null;
        return rtParseSession(await fsp.readFile(p, "utf8"), bookNames);
      });
    }
  }

  // 清掉已删除文件的缓存
  for (const k of Object.keys(cache)) {
    if (!seen.has(k)) {
      delete cache[k];
      changed = true;
    }
  }
  return { ok: true, sessions, changed };
}

// 同一本书的所有会话先合并再聚合（fork/resume 复制出的重复时间戳自然去重）。
// 每个 日期 / 书 / 累计 都是三元组 {sec, sessions, turns}：
//   sec      = 相邻活动分钟间隔 ≤30min 的累加（同旧口径）
//   sessions = 阅读会话（一份 jsonl 记一次），记到该会话首条消息那天
//   turns    = 用户消息条数，按毫秒去重（一次用户回复算一次对话）
function rtAggregate(sessions) {
  const minsByBook = new Map(); // 书 → Set(分钟)
  const timesByBook = new Map(); // 书 → Set(毫秒)
  const fileDaysByBook = new Map(); // 书 → [每个会话文件首条消息所在天]
  for (const s of sessions) {
    let mset = minsByBook.get(s.book);
    if (!mset) minsByBook.set(s.book, (mset = new Set()));
    for (const m of s.mins) mset.add(m);
    let tset = timesByBook.get(s.book);
    if (!tset) timesByBook.set(s.book, (tset = new Set()));
    for (const t of s.times || []) tset.add(t);
    if (s.mins && s.mins.length) {
      let arr = fileDaysByBook.get(s.book);
      if (!arr) fileDaysByBook.set(s.book, (arr = []));
      arr.push(rtLocalDay(s.mins[0] * 60000));
    }
  }
  const perBook = new Map(); // 书 → Map(日期 → {sec,sessions,turns})
  const bookTotal = new Map(); // 书 → {sec,sessions,turns}
  const perDay = new Map(); // 日期 → {sec,sessions,turns}（全部书）
  const grand = { sec: 0, sessions: 0, turns: 0 };
  for (const [book, mset] of minsByBook) {
    const mins = [...mset].sort((a, b) => a - b);
    const days = new Map();
    const dayOf = (key) => {
      let o = days.get(key);
      if (!o) days.set(key, (o = { sec: 0, sessions: 0, turns: 0 }));
      return o;
    };
    const total = { sec: 0, sessions: 0, turns: 0 };
    for (let i = 1; i < mins.length; i++) {
      const d = (mins[i] - mins[i - 1]) * 60000;
      if (d > RT_GAP_MS) continue;
      dayOf(rtLocalDay(mins[i - 1] * 60000)).sec += d / 1000;
      total.sec += d / 1000;
    }
    for (const day of fileDaysByBook.get(book) || []) {
      dayOf(day).sessions++;
      total.sessions++;
    }
    for (const ms of timesByBook.get(book) || []) {
      dayOf(rtLocalDay(ms)).turns++;
      total.turns++;
    }
    if (total.sec < 60) continue;
    for (const [day, o] of days) {
      let pd = perDay.get(day);
      if (!pd) perDay.set(day, (pd = { sec: 0, sessions: 0, turns: 0 }));
      pd.sec += o.sec;
      pd.sessions += o.sessions;
      pd.turns += o.turns;
    }
    perBook.set(book, days);
    bookTotal.set(book, total);
    grand.sec += total.sec;
    grand.sessions += total.sessions;
    grand.turns += total.turns;
  }
  return { perBook, bookTotal, perDay, grand };
}

function rtFmt(sec) {
  const m = Math.round(sec / 60);
  if (m < 1) return sec > 0 ? "<1m" : "0m";
  if (m < 60) return m + "m";
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
}

/* RT-END */

/* ---------------- 视图 ---------------- */

class EchoDashboardView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.dimFilter = null; // 当前维度筛选
    this.insightBook = null; // insight 书筛选：null=全部书
    this.insightDate = null; // insight 日期筛选：null 或点热力图选中的某天
    this.rtScope = null; // 阅读时长视角：null=全部书，否则书名
    this.rtRange = "累计"; // 大字指标的时间范围：今天/本周/本月/上月/累计
    this.data = null;
    this.rt = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "ai陪读看板";
  }
  getIcon() {
    return "layout-dashboard";
  }

  async onOpen() {
    this.contentEl.addClass("echo-dash");
    const trigger = debounce(() => this.refresh(), 800, true);
    const watch = (f) => {
      if (f && f.path && (f.path.startsWith("books/") || f.path.startsWith("insight/"))) trigger();
    };
    this.registerEvent(this.app.vault.on("modify", watch));
    this.registerEvent(this.app.vault.on("create", watch));
    this.registerEvent(this.app.vault.on("delete", watch));
    this.registerEvent(this.app.vault.on("rename", watch));
    await this.refresh();
  }

  /* ---------- 数据收集 ---------- */

  async collectData() {
    const vault = this.app.vault;
    const data = { books: [], insights: [], indexMeta: new Map() };

    // 书
    const booksFolder = vault.getAbstractFileByPath("books");
    if (booksFolder instanceof TFolder) {
      for (const child of booksFolder.children) {
        if (!(child instanceof TFolder)) continue;
        const pf = vault.getAbstractFileByPath(`books/${child.name}/progress.md`);
        if (!(pf instanceof TFile)) continue;
        const chapters = parseProgress(await vault.cachedRead(pf));
        if (!chapters.length) continue;
        data.books.push({
          name: child.name,
          progressFile: pf,
          chapters,
          stats: bookStats(chapters),
          pos: currentPosition(chapters),
        });
      }
    }

    // INDEX.md 的摘要与 ★
    const indexFile = vault.getAbstractFileByPath("insight/INDEX.md");
    if (indexFile instanceof TFile) {
      const text = await vault.cachedRead(indexFile);
      for (const line of text.split("\n")) {
        // `]]` 到首个 `—` 之间是「标记区」：含 ★ 即加星，其余状态字（待读/精读…）忽略，不再卡住摘要
        const m = line.match(/^-\s*\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]\s*([^—]*?)\s*—\s*(.+)$/);
        if (m) data.indexMeta.set(m[1].trim(), { starred: m[2].includes("★"), summary: m[3].trim() });
      }
    }

    // insight 条目（含归属书 + 涉及日期，供 维度×书×日期 三层筛选）
    const bookNames = new Set(data.books.map((b) => b.name));
    const insightFolder = vault.getAbstractFileByPath("insight");
    if (insightFolder instanceof TFolder) {
      for (const dim of insightFolder.children) {
        if (!(dim instanceof TFolder) || !DIM_BY_KEY[dim.name]) continue;
        for (const f of dim.children) {
          if (!(f instanceof TFile) || f.extension !== "md") continue;
          const fm = this.app.metadataCache.getFileCache(f)?.frontmatter || {};
          let updated = typeof fm.updated === "string" ? fm.updated : null;
          if (!updated) updated = new Date(f.stat.mtime).toISOString().slice(0, 10);
          const meta = data.indexMeta.get(`${dim.name}/${f.basename}`) || {};
          // 正文：溯源链 [[书名/chNN/…]] → 归属书（可多本）；YYYY-MM-DD → 涉及的日期
          const body = await vault.cachedRead(f);
          const books = new Set();
          for (const lm of body.matchAll(/\[\[([^\]|/#]+)\/ch\d+/g)) {
            if (bookNames.has(lm[1])) books.add(lm[1]);
          }
          const dates = new Set();
          for (const dm of body.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)) dates.add(dm[1]);
          dates.add(updated);
          data.insights.push({
            file: f,
            dim: dim.name,
            title: typeof fm.title === "string" ? fm.title : f.basename,
            updated,
            starred: !!meta.starred,
            summary: meta.summary || "",
            books: [...books],
            dates: [...dates],
          });
        }
      }
    }
    data.insights.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
    return data;
  }

  /* ---------- 渲染 ---------- */

  async refresh() {
    this.data = await this.collectData();
    this.rt = await this.collectReadingTime();
    const el = this.contentEl;
    el.empty();

    this.renderHeader(el);
    this.renderBooks(el);
    this.renderReadingTime(el);
    this.renderInsights(el);
  }

  // 扫描 Claude Code / Codex 会话记录，按 mtime+size 增量缓存到插件 data.json
  async collectReadingTime() {
    try {
      const adapter = this.app.vault.adapter;
      const vaultPath = adapter && adapter.basePath ? adapter.basePath : null;
      if (!vaultPath || !this.plugin) return { ok: false };
      const booksFolder = this.app.vault.getAbstractFileByPath("books");
      const bookNames =
        booksFolder instanceof TFolder
          ? booksFolder.children.filter((c) => c instanceof TFolder).map((c) => c.name)
          : [];
      if (!bookNames.length) return { ok: true, agg: rtAggregate([]) };
      const saved = (await this.plugin.loadData()) || {};
      if (!saved.rtCache || saved.rtVersion !== RT_VERSION) {
        saved.rtCache = {};
        saved.rtVersion = RT_VERSION;
      }
      const cache = (saved.rtCache[vaultPath] = saved.rtCache[vaultPath] || {});
      const res = await rtScan(vaultPath, bookNames, cache);
      if (res.changed) await this.plugin.saveData(saved);
      return { ok: res.ok, agg: rtAggregate(res.sessions) };
    } catch (e) {
      console.error("echo-dashboard: 阅读时长统计失败", e);
      return { ok: false };
    }
  }

  openInTab(file) {
    this.app.workspace.getLeaf("tab").openFile(file);
  }

  hoverable(el, file) {
    el.addEventListener("mouseover", (evt) => {
      this.app.workspace.trigger("hover-link", {
        event: evt,
        source: VIEW_TYPE,
        hoverParent: this,
        targetEl: el,
        linktext: file.path,
      });
    });
  }

  // 一键续读：打开 Claudian → 新会话 → 自动发送「继续读《X》」
  async continueReading(bookName) {
    const prompt = `继续读《${bookName}》`;
    const claudian = this.app.plugins.plugins["realclaudian"];
    if (!claudian) {
      new Notice("未找到 Claudian 插件（realclaudian）");
      return;
    }
    try {
      // 1. 确保 Claudian 视图已打开
      let view = typeof claudian.getView === "function" ? claudian.getView() : null;
      if (!view) {
        await claudian.activateView();
        for (let i = 0; i < 20 && !view; i++) {
          await sleep(100);
          view = claudian.getView();
        }
      }
      if (!view) throw new Error("Claudian 视图未能打开");
      this.app.workspace.revealLeaf(view.leaf);

      // 2. 新建会话（当前 tab 正在输出时不打断）
      const tabManager = view.getTabManager();
      if (!tabManager) throw new Error("Claudian 尚未就绪");
      const before = tabManager.getActiveTab();
      if (before && before.state && before.state.isStreaming) {
        new Notice("Claudian 正在回复中，等它说完再续读");
        return;
      }
      await tabManager.createNewConversation();
      await sleep(150);

      // 3. 填入指令并发送（与 Claudian 内部发送路径一致：写输入框 → sendMessage）
      const inputs = Array.from(view.containerEl.querySelectorAll("textarea.claudian-input, .claudian-input"));
      const inputEl = inputs.find((el) => el.offsetParent !== null) || inputs[0];
      if (!inputEl) throw new Error("找不到 Claudian 输入框");
      inputEl.value = prompt;
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      inputEl.focus();

      const tab = tabManager.getActiveTab();
      const inputController = tab && tab.controllers && tab.controllers.inputController;
      if (inputController && typeof inputController.sendMessage === "function") {
        await inputController.sendMessage();
      } else {
        new Notice("已填入「" + prompt + "」，按 Enter 发送");
      }
    } catch (e) {
      console.error("echo-dashboard: 续读失败", e);
      new Notice("打开 Claudian 会话失败：" + e.message);
    }
  }

  // 章目录下找最适合打开的文件
  resolveChapterFile(bookName, chDir, unitId) {
    if (!chDir) return null;
    const v = this.app.vault;
    const tryPaths = [];
    if (unitId) tryPaths.push(`books/${bookName}/${chDir}/${unitId}.md`);
    tryPaths.push(
      `books/${bookName}/${chDir}/01.md`,
      `books/${bookName}/${chDir}/00-导读.md`,
      `books/${bookName}/${chDir}/raw.md`
    );
    for (const p of tryPaths) {
      const f = v.getAbstractFileByPath(p);
      if (f instanceof TFile) return f;
    }
    return null;
  }

  renderHeader(parent) {
    const header = parent.createDiv({ cls: "ed-header" });
    const titleWrap = header.createDiv({ cls: "ed-title-wrap" });
    const h1 = titleWrap.createEl("h1", { cls: "ed-title" });
    h1.createSpan({ cls: "ed-title-ai", text: "ai" });
    h1.createSpan({ text: "陪读看板" });

    const { books, insights } = this.data;

    const pills = header.createDiv({ cls: "ed-pills" });
    const pill = (icon, value, label, color) => {
      const p = pills.createDiv({ cls: "ed-pill" });
      p.style.setProperty("--pc", color);
      setIcon(p.createSpan({ cls: "ed-pill-icon" }), icon);
      p.createSpan({ cls: "ed-pill-val", text: value });
      p.createSpan({ cls: "ed-pill-lab", text: label });
    };
    pill("book-open", String(books.length), "本在读", "#c0703f");
    if (this.rt && this.rt.ok && this.rt.agg.grand.sec)
      pill("timer", rtFmt(this.rt.agg.grand.sec), "阅读", "#7a9b6e");
    pill("sparkles", String(insights.length), "沉淀", "#d8a24a");

    const refreshBtn = header.createDiv({ cls: "ed-refresh", attr: { "aria-label": "刷新" } });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => this.refresh());
  }

  renderBooks(parent) {
    const section = parent.createDiv({ cls: "ed-section" });
    section.createEl("h2", { cls: "ed-section-title", text: "书架" });
    const grid = section.createDiv({ cls: "ed-book-grid" });

    // 排序：最近有沉淀的书排前面（insights 已按 updated 倒序，首见即最新）
    const latestInsight = new Map();
    for (const i of this.data.insights)
      for (const b of i.books) if (!latestInsight.has(b)) latestInsight.set(b, i.updated);
    const books = [...this.data.books].sort((a, b) => {
      const da = latestInsight.get(a.name) || "";
      const db = latestInsight.get(b.name) || "";
      return da === db ? 0 : da < db ? 1 : -1;
    });
    const colorMap = bookColorMap(books.map((b) => b.name));

    for (const book of books) {
      const card = grid.createDiv({ cls: "ed-book-card" });
      card.style.setProperty("--bk", colorMap.get(book.name));

      // 头：进度环（取书的签名色）+ 书名
      const head = card.createDiv({ cls: "ed-book-head" });
      this.renderRing(head, book.stats.percent, 44);
      const nameEl = head.createDiv({ cls: "ed-book-name", text: `《${book.name}》` });
      nameEl.addEventListener("click", () => this.openInTab(book.progressFile));
      this.hoverable(nameEl, book.progressFile);

      // 元信息：只剩 已读 x/x 章 + 正在读
      const meta = card.createDiv({ cls: "ed-book-meta" });
      meta.createDiv({
        cls: "ed-book-stat",
        text: `已读 ${book.stats.done}/${book.stats.total} 章`,
      });

      if (book.pos) {
        const posEl = meta.createDiv({ cls: "ed-book-pos" });
        const label = posEl.createDiv({ cls: "ed-pos-label" });
        setIcon(label.createSpan({ cls: "ed-pos-icon" }), "book-open");
        label.createSpan({ text: "正在读" });
        const posLabel = book.pos.unit
          ? `${book.pos.chapter.label.split("—")[0].trim()} · ${book.pos.unit.label}`
          : book.pos.chapter.label;
        posEl.createDiv({ cls: "ed-pos-text", text: posLabel });
        const target = this.resolveChapterFile(
          book.name,
          book.pos.chapter.chDir,
          book.pos.unit ? book.pos.unit.unitId : null
        );
        if (target) {
          posEl.addClass("is-clickable");
          posEl.addEventListener("click", () => this.openInTab(target));
          this.hoverable(posEl, target);
        }
      } else {
        const doneEl = meta.createDiv({ cls: "ed-book-pos ed-book-pos--done" });
        const label = doneEl.createDiv({ cls: "ed-pos-label" });
        setIcon(label.createSpan({ cls: "ed-pos-icon" }), "party-popper");
        label.createSpan({ text: "全书读完" });
      }

      // 继续阅读（整宽）
      if (book.pos) {
        const btn = card.createEl("button", {
          cls: "ed-continue-btn",
          attr: { "aria-label": `继续读《${book.name}》` },
        });
        setIcon(btn.createSpan({ cls: "ed-continue-icon" }), "play");
        btn.createSpan({ text: "继续阅读" });
        btn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          this.continueReading(book.name);
        });
      }

      // 最近 3 条 insight（这本书照见的；data.insights 已按 updated 倒序）
      const bookInsights = this.data.insights.filter((i) => i.books.includes(book.name)).slice(0, 3);
      if (bookInsights.length) {
        const ins = card.createDiv({ cls: "ed-book-insights" });
        ins.createDiv({ cls: "ed-bi-cap", text: "最近沉淀" });
        for (const it of bookInsights) {
          const dim = DIM_BY_KEY[it.dim];
          const r = ins.createDiv({ cls: "ed-bi-row" });
          r.style.setProperty("--dim-hue", String(dim ? dim.hue : 0));
          r.createSpan({ cls: "ed-bi-dot" });
          if (it.starred) r.createSpan({ cls: "ed-star", text: "★" });
          r.createSpan({ cls: "ed-bi-title", text: it.title });
          r.createSpan({ cls: "ed-bi-date", text: it.updated.slice(5) });
          r.setAttribute("aria-label", `${it.dim} · ${it.summary || it.title}`);
          r.addEventListener("click", (evt) => {
            evt.stopPropagation();
            this.openInTab(it.file);
          });
          this.hoverable(r, it.file);
        }
      }
    }
  }

  renderRing(parent, percent, size = 64) {
    const stroke = Math.max(4, Math.round(size * 0.1));
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const wrap = parent.createDiv({ cls: "ed-ring" });
    const svg = wrap.createSvg("svg", { attr: { width: size, height: size, viewBox: `0 0 ${size} ${size}` } });
    svg.createSvg("circle", {
      cls: "ed-ring-bg",
      attr: { cx: size / 2, cy: size / 2, r, "stroke-width": stroke, fill: "none" },
    });
    svg.createSvg("circle", {
      cls: "ed-ring-fg",
      attr: {
        cx: size / 2,
        cy: size / 2,
        r,
        "stroke-width": stroke,
        fill: "none",
        "stroke-dasharray": `${c * percent} ${c}`,
        "stroke-linecap": "round",
        transform: `rotate(-90 ${size / 2} ${size / 2})`,
      },
    });
    wrap.createDiv({ cls: "ed-ring-label", text: `${Math.round(percent * 100)}%` });
  }

  renderReadingTime(parent) {
    const section = parent.createDiv({ cls: "ed-section" });
    const head = section.createDiv({ cls: "ed-insight-head" });
    head.createEl("h2", { cls: "ed-section-title", text: "阅读时长" });
    head.createSpan({ cls: "ed-insight-hint", text: "Claude Code · Codex 会话 · 无回复超 30 分钟不计" });

    if (!this.rt || !this.rt.ok) {
      section.createDiv({ cls: "ed-empty", text: "无法读取会话记录（仅桌面端可用）" });
      return;
    }
    const { perBook, bookTotal, perDay, grand } = this.rt.agg;
    if (!grand.sec) {
      section.createDiv({ cls: "ed-empty", text: "还没有可统计的阅读会话" });
      return;
    }
    if (this.rtScope && !perBook.has(this.rtScope)) this.rtScope = null;

    const booksSorted = [...bookTotal.entries()].sort((a, b) => b[1].sec - a[1].sec).map((e) => e[0]);
    const bookColors = bookColorMap([...bookTotal.keys()]);

    // 当前视角的「日期 → {sec,sessions,turns}」源：全部=各书合计，单本=该书
    const source = this.rtScope ? perBook.get(this.rtScope) : perDay;
    const scopeTotal = this.rtScope ? bookTotal.get(this.rtScope) : grand;
    const secOf = (map, k) => (map.get(k) || {}).sec || 0;

    // —— 书选择条：色块即筛选，点一本切到单本视角、点「全部」回到按书堆叠 ——
    const picker = section.createDiv({ cls: "ed-rt-picker" });
    const mkPick = (label, scope, sec, color, swatch) => {
      const chip = picker.createDiv({ cls: "ed-rt-pick" });
      chip.style.setProperty("--bk", color);
      if (this.rtScope === scope) chip.addClass("is-active");
      swatch(chip.createSpan({ cls: "ed-rt-pick-sw" }));
      chip.createSpan({ cls: "ed-rt-pick-name", text: label });
      chip.createSpan({ cls: "ed-rt-pick-time", text: rtFmt(sec) });
      chip.addEventListener("click", () => {
        this.rtScope = scope;
        this.refresh();
      });
    };
    mkPick("全部", null, grand.sec, "var(--interactive-accent)", (sw) => {
      sw.addClass("is-all");
      for (const b of booksSorted) sw.createSpan({ cls: "ed-rt-pick-seg" }).style.background = bookColors.get(b);
    });
    for (const b of booksSorted)
      mkPick(`${b}`, b, bookTotal.get(b).sec, bookColors.get(b), (sw) => {
        sw.style.background = bookColors.get(b);
      });

    // —— 时间范围（点一个 tab）→ 三个大字指标：时长 / 会话 / 对话 ——
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7)); // 周一为界
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
    const sumRange = (from, to) => {
      const o = { sec: 0, sessions: 0, turns: 0 };
      for (const d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
        const v = source.get(rtLocalDay(d.getTime()));
        if (v) {
          o.sec += v.sec;
          o.sessions += v.sessions;
          o.turns += v.turns;
        }
      }
      return o;
    };
    // [label, 指标函数, 起, 止]；累计 = 全时段（不框选高亮）
    const ranges = [
      ["今天", () => sumRange(today, today), today, today],
      ["本周", () => sumRange(weekStart, today), weekStart, today],
      ["本月", () => sumRange(monthStart, today), monthStart, today],
      ["上月", () => sumRange(lastMonthStart, lastMonthEnd), lastMonthStart, lastMonthEnd],
      ["累计", () => scopeTotal, null, null],
    ];
    if (!ranges.some(([l]) => l === this.rtRange)) this.rtRange = "累计";

    const tabs = section.createDiv({ cls: "ed-rt-tabs" });
    for (const [label] of ranges) {
      const tab = tabs.createDiv({ cls: "ed-rt-tab" + (this.rtRange === label ? " is-active" : "") });
      tab.setText(label);
      tab.addEventListener("click", () => {
        this.rtRange = label;
        this.refresh();
      });
    }

    const sel = ranges.find(([l]) => l === this.rtRange);
    const cur = sel[1]();
    // 当前 tab 对应的高亮区间（用于柱状图框选 + 滚动定位）；累计为 null
    const hlFrom = sel[2] ? rtLocalDay(sel[2].getTime()) : null;
    const hlTo = sel[3] ? rtLocalDay(sel[3].getTime()) : null;
    const metrics = section.createDiv({ cls: "ed-rt-metrics" });
    const num = (el, t) => el.createSpan({ cls: "ed-rt-num", text: String(t) });
    const unit = (el, t) => el.createSpan({ cls: "ed-rt-unit", text: t });
    const metric = (primary, build, label) => {
      const mt = metrics.createDiv({ cls: "ed-rt-metric" + (primary ? " is-primary" : "") });
      build(mt.createDiv({ cls: "ed-rt-metric-val" }));
      mt.createDiv({ cls: "ed-rt-metric-lab", text: label });
    };
    metric(
      true,
      (el) => {
        const min = Math.round(cur.sec / 60);
        const h = Math.floor(min / 60);
        if (h > 0) {
          num(el, h);
          unit(el, "h");
          if (min % 60) {
            num(el, min % 60);
            unit(el, "m");
          }
        } else {
          num(el, min);
          unit(el, "m");
        }
      },
      "时长"
    );
    metric(false, (el) => (num(el, cur.sessions), unit(el, "次")), "会话");
    metric(false, (el) => (num(el, cur.turns), unit(el, "次")), "对话");

    // —— 柱状图（按天时长）：最早有数据那天 ~ 今天（至少 30 天）；超出宽度下方出滑块往前翻 ——
    let earliest = null;
    for (const k of perDay.keys()) if (!earliest || k < earliest) earliest = k;
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - 29);
    if (earliest) {
      const e = new Date(earliest + "T00:00:00");
      if (e < startDate) startDate.setTime(e.getTime());
    }
    const dayKeys = [];
    for (const d = new Date(startDate); d <= today; d.setDate(d.getDate() + 1)) dayKeys.push(rtLocalDay(d.getTime()));
    const dayTotals = dayKeys.map((k) => secOf(source, k));
    const max = Math.max(...dayTotals, 1);
    const stackBooks = this.rtScope ? [this.rtScope] : booksSorted;

    // 即时悬浮卡：挂到 document.body（避开 Obsidian 叶子容器的 transform/containment
    // 让 fixed 定位偏移），用 getBoundingClientRect 的视口坐标精确贴到柱子上方
    if (this._rtTip) this._rtTip.remove();
    const tip = document.body.createDiv({ cls: "echo-dash-rt-tip" });
    this._rtTip = tip;
    const fmtDay = (k) => {
      const p = k.split("-");
      return `${+p[1]} 月 ${+p[2]} 日`;
    };
    const showTip = (col, k, rows, total) => {
      tip.empty();
      tip.createDiv({ cls: "ed-rt-tip-date", text: fmtDay(k) });
      const list = tip.createDiv({ cls: "ed-rt-tip-list" });
      for (const r of rows) {
        const row = list.createDiv({ cls: "ed-rt-tip-row" });
        row.createSpan({ cls: "ed-rt-tip-dot" }).style.background = r.color;
        row.createSpan({ cls: "ed-rt-tip-name", text: r.name });
        row.createSpan({ cls: "ed-rt-tip-time", text: rtFmt(r.sec) });
      }
      if (rows.length > 1) {
        const f = tip.createDiv({ cls: "ed-rt-tip-foot" });
        f.createSpan({ cls: "ed-rt-tip-flabel", text: "合计" });
        f.createSpan({ cls: "ed-rt-tip-time", text: rtFmt(total) });
      }
      tip.addClass("is-show");
      const rect = col.getBoundingClientRect();
      tip.style.top = rect.top - 10 + "px";
      const half = tip.offsetWidth / 2;
      tip.style.left = Math.max(8 + half, Math.min(window.innerWidth - 8 - half, rect.left + rect.width / 2)) + "px";
    };
    const hideTip = () => tip.removeClass("is-show");

    const scroll = section.createDiv({ cls: "ed-rt-scroll" });
    const chart = scroll.createDiv({ cls: "ed-rt-chart" });
    chart.addEventListener("mouseleave", hideTip);
    let lastInRange = null; // 选中区间里最靠右那根柱，滚动时右对齐到它
    dayKeys.forEach((k, i) => {
      const col = chart.createDiv({ cls: "ed-rt-col" });
      const total = dayTotals[i];
      const inRange = !hlFrom || (k >= hlFrom && k <= hlTo);
      if (!inRange) col.addClass("is-dim");
      else lastInRange = col;
      const barbox = col.createDiv({ cls: "ed-rt-barbox" });
      const stack = barbox.createDiv({ cls: "ed-rt-stack" });
      const rows = [];
      if (total > 0) {
        stack.style.height = Math.max(4, Math.round((total / max) * 100)) + "%";
        for (const b of stackBooks) {
          const sec = secOf(perBook.get(b) || new Map(), k);
          if (sec <= 0) continue;
          const color = this.rtScope ? "var(--interactive-accent)" : bookColors.get(b);
          const seg = stack.createDiv({ cls: "ed-rt-seg" });
          seg.style.height = (sec / total) * 100 + "%";
          seg.style.background = color;
          rows.push({ name: b, sec, color });
        }
        col.addEventListener("mouseenter", () => showTip(col, k, rows, total));
      } else {
        stack.addClass("is-zero");
      }
      const lab = col.createDiv({ cls: "ed-rt-xlabel" });
      if (i % 7 === 0 || i === dayKeys.length - 1) lab.setText(k.slice(5));
    });
    // 选中区间完全落在柱图窗口之外（如月底看上月而数据更晚）→ 别把整图淡掉
    if (hlFrom && !lastInRange) for (const c of Array.from(chart.children)) c.removeClass("is-dim");
    // 把选中区间滚进视野：累计 / 区间不在窗口 → 停最右（最新）；其余 → 右对齐到区间末柱
    requestAnimationFrame(() => {
      if (!hlFrom || !lastInRange) {
        scroll.scrollLeft = scroll.scrollWidth;
        return;
      }
      const cRect = lastInRange.getBoundingClientRect();
      const sRect = scroll.getBoundingClientRect();
      scroll.scrollLeft += cRect.right - sRect.left - scroll.clientWidth + 6;
    });
  }

  // insight 日期轴：按当前 维度+书 过滤后逐日计数，做成一条暖色"沉淀脉络"；点亮处=选/取消那天
  renderInsightHeat(rail, heatSet) {
    const heat = new Map();
    for (const i of heatSet) for (const day of i.dates) heat.set(day, (heat.get(day) || 0) + 1);

    const row = rail.createDiv({ cls: "ed-ins-row ed-ins-row--heat" });
    row.createSpan({ cls: "ed-ins-label", text: "日" });
    const wrap = row.createDiv({ cls: "ed-heat-wrap" });
    const grid = wrap.createDiv({ cls: "ed-heat" });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - (7 * 16 - 1));
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // 对齐到周一

    for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
      const key = rtLocalDay(d.getTime());
      const n = heat.get(key) || 0;
      const cell = grid.createDiv({ cls: "ed-heat-cell" });
      const lvl = n === 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : 3;
      cell.addClass(`lv-${lvl}`);
      if (this.insightDate === key) cell.addClass("is-sel");
      cell.setAttribute("aria-label", `${key} · ${n} 条`);
      if (n > 0) {
        cell.addClass("is-clickable");
        cell.addEventListener("click", () => {
          this.insightDate = this.insightDate === key ? null : key;
          this.refresh();
        });
      }
    }

    if (this.insightDate) {
      const tag = row.createDiv({ cls: "ed-heat-sel" });
      tag.createSpan({ cls: "ed-heat-sel-d", text: this.insightDate.slice(5) });
      const x = tag.createSpan({ cls: "ed-heat-sel-x", text: "✕" });
      x.addEventListener("click", () => {
        this.insightDate = null;
        this.refresh();
      });
    } else {
      row.createSpan({ cls: "ed-heat-hint", text: "近 16 周 · 点亮处筛某天" });
    }
  }

  renderInsights(parent) {
    const section = parent.createDiv({ cls: "ed-section ed-ins" });
    const all = this.data.insights;
    const inBook = (i) => !this.insightBook || i.books.includes(this.insightBook);
    const inDate = (i) => !this.insightDate || i.dates.includes(this.insightDate);

    const head = section.createDiv({ cls: "ed-insight-head" });
    head.createEl("h2", { cls: "ed-section-title", text: "Insight 沉淀" });
    head.createSpan({ cls: "ed-ins-total", text: `共 ${all.length} 条` });

    // —— 筛选轨：维度 / 书 / 日，三行同一套视觉语言 ——
    const rail = section.createDiv({ cls: "ed-ins-rail" });

    // 维度行（计数反映当前 书+日期 过滤）
    const baseSet = all.filter((i) => inBook(i) && inDate(i));
    const dimRow = rail.createDiv({ cls: "ed-ins-row" });
    dimRow.createSpan({ cls: "ed-ins-label", text: "维度" });
    const dimChips = dimRow.createDiv({ cls: "ed-chips" });
    const allDim = dimChips.createDiv({ cls: "ed-chip ed-chip--all" });
    if (!this.dimFilter) allDim.addClass("is-active");
    allDim.createSpan({ text: `全部 ${baseSet.length}` });
    allDim.addEventListener("click", () => {
      this.dimFilter = null;
      this.refresh();
    });
    for (const dim of DIMENSIONS) {
      const count = baseSet.filter((i) => i.dim === dim.key).length;
      const chip = dimChips.createDiv({ cls: "ed-chip" });
      chip.style.setProperty("--dim-hue", String(dim.hue));
      if (this.dimFilter === dim.key) chip.addClass("is-active");
      setIcon(chip.createSpan({ cls: "ed-chip-icon" }), dim.icon);
      chip.createSpan({ text: `${dim.key} ${count}` });
      chip.addEventListener("click", () => {
        this.dimFilter = this.dimFilter === dim.key ? null : dim.key;
        this.refresh();
      });
    }

    // 书行（色块即筛选，配色与书架 / 阅读时长一致）
    const bookCount = new Map();
    for (const i of all) for (const b of i.books) bookCount.set(b, (bookCount.get(b) || 0) + 1);
    const colorMap = bookColorMap([...bookCount.keys()]);
    const bookRow = rail.createDiv({ cls: "ed-ins-row" });
    bookRow.createSpan({ cls: "ed-ins-label", text: "书" });
    const bookChips = bookRow.createDiv({ cls: "ed-chips" });
    const allBook = bookChips.createDiv({ cls: "ed-bchip ed-bchip--all" });
    if (!this.insightBook) allBook.addClass("is-active");
    allBook.createSpan({ text: `全部 ${all.length}` });
    allBook.addEventListener("click", () => {
      this.insightBook = null;
      this.refresh();
    });
    for (const [b, n] of [...bookCount.entries()].sort((a, b2) => b2[1] - a[1])) {
      const chip = bookChips.createDiv({ cls: "ed-bchip" });
      chip.style.setProperty("--bk", colorMap.get(b));
      if (this.insightBook === b) chip.addClass("is-active");
      chip.createDiv({ cls: "ed-bchip-sw" });
      chip.createSpan({ cls: "ed-bchip-name", text: `《${b}》` });
      chip.createSpan({ cls: "ed-bchip-n", text: String(n) });
      chip.addEventListener("click", () => {
        this.insightBook = this.insightBook === b ? null : b;
        this.refresh();
      });
    }

    // 日期行（暖色脉络；计数按 维度+书 过滤，不被已选日期收窄）
    const heatSet = all.filter((i) => inBook(i) && (!this.dimFilter || i.dim === this.dimFilter));
    this.renderInsightHeat(rail, heatSet);

    // —— 便签墙：每条沉淀一张便签，按维度着色；轮转分列＝横向阅读序 + 每列各自紧贴（无缝）——
    const items = baseSet.filter((i) => !this.dimFilter || i.dim === this.dimFilter);
    const board = section.createDiv({ cls: "ed-board" });
    if (!items.length) {
      board.createDiv({ cls: "ed-empty", text: "没有匹配的沉淀" });
      return;
    }
    const noteEls = items.map((item) => this.buildNote(item));
    this.mountBoard(board, noteEls);
  }

  // 单张便签元素（脱离文档构建，交给 mountBoard 分列）
  buildNote(item) {
    const dim = DIM_BY_KEY[item.dim];
    const note = document.createElement("div");
    note.addClass("ed-note");
    note.style.setProperty("--dim-hue", String(dim ? dim.hue : 0));
    note.createDiv({ cls: "ed-note-tape" });

    const top = note.createDiv({ cls: "ed-note-top" });
    const dimTag = top.createDiv({ cls: "ed-note-dim" });
    dimTag.createDiv({ cls: "ed-note-dot" });
    dimTag.createSpan({ text: item.dim });
    if (item.starred) top.createSpan({ cls: "ed-note-star", text: "★" });

    note.createDiv({ cls: "ed-note-title", text: item.title });
    if (item.summary) note.createDiv({ cls: "ed-note-summary", text: item.summary });

    const foot = note.createDiv({ cls: "ed-note-foot" });
    if (item.books.length) {
      const bl = item.books.length > 1 ? `跨 ${item.books.length} 书` : `《${item.books[0]}》`;
      foot.createSpan({ cls: "ed-note-book", text: bl });
    }
    foot.createSpan({ cls: "ed-note-date", text: item.updated.slice(5) });

    note.addEventListener("click", () => this.openInTab(item.file));
    this.hoverable(note, item.file);
    return note;
  }

  // 把便签轮转分进若干列：第 i 张 → 第 i%cols 列。列数随宽度变，resize 时重排。
  mountBoard(board, noteEls) {
    const GAP = 14; // 与 .ed-board 的列间距一致
    const TARGET = 232; // 目标列宽
    const MAXCOLS = 4;
    const distribute = () => {
      const w = board.clientWidth || 0;
      const cols = Math.max(1, Math.min(MAXCOLS, Math.floor((w + GAP) / (TARGET + GAP)) || 1));
      if (board._cols === cols && board.childElementCount) return; // 列数没变就不折腾
      board._cols = cols;
      board.empty();
      const colEls = [];
      for (let i = 0; i < cols; i++) colEls.push(board.createDiv({ cls: "ed-board-col" }));
      noteEls.forEach((n, i) => colEls[i % cols].appendChild(n));
    };
    distribute();
    if (this._boardRO) this._boardRO.disconnect();
    this._boardRO = new ResizeObserver(() => distribute());
    this._boardRO.observe(board);
  }

  async onClose() {
    if (this._rtTip) {
      this._rtTip.remove();
      this._rtTip = null;
    }
    if (this._boardRO) {
      this._boardRO.disconnect();
      this._boardRO = null;
    }
    this.contentEl.empty();
  }
}

/* ---------------- 插件入口 ---------------- */

class EchoDashboardPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE, (leaf) => new EchoDashboardView(leaf, this));

    if (this.app.workspace.registerHoverLinkSource) {
      this.app.workspace.registerHoverLinkSource(VIEW_TYPE, {
        display: "深读看板",
        defaultMod: false,
      });
    }

    this.addRibbonIcon("layout-dashboard", "打开深读看板", () => this.activateView());
    this.addCommand({
      id: "open-echo-dashboard",
      name: "打开深读看板",
      callback: () => this.activateView(),
    });
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  onunload() {
    if (this.app.workspace.unregisterHoverLinkSource) {
      this.app.workspace.unregisterHoverLinkSource(VIEW_TYPE);
    }
  }
}

module.exports = EchoDashboardPlugin;
