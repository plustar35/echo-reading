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

// 最近一条带回看的已读项（书卡上的"最近回看"）
function latestReview(chapters) {
  let last = null;
  for (const ch of chapters) {
    for (const u of ch.units) if (u.done && u.review) last = { label: u.label, review: u.review };
    if (ch.done && ch.review) last = { label: ch.label, review: ch.review };
  }
  return last;
}

/* ---------------- 阅读时长 ---------------- */
/* RT-BEGIN：纯 Node 逻辑，不依赖 Obsidian API，可单独跑测试 */

const RT_VERSION = 5; // 算法变更时 +1，作废旧缓存
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

// 一份 jsonl 会话全文 → { book, mins }（mins = 用户发消息的「分钟」时间戳，去重排序）；非阅读会话 → null
function rtParseSession(text, bookNames) {
  const minsSet = new Set();
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
      if (!isNaN(t)) minsSet.add(Math.floor(t / 60000));
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
  return { book, mins };
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
      if (c.book) sessions.push({ book: c.book, mins: c.mins || [] });
      return;
    }
    const entry = { mtime: st.mtimeMs, size: st.size, book: null, mins: null };
    try {
      const parsed = await parse(file);
      if (parsed) {
        entry.book = parsed.book;
        entry.mins = parsed.mins;
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

// 同一本书的所有会话先合并活动分钟再算时长：fork/resume 复制出的重复时间戳自然去重
function rtAggregate(sessions) {
  const byBook = new Map();
  for (const s of sessions) {
    let set = byBook.get(s.book);
    if (!set) byBook.set(s.book, (set = new Set()));
    for (const m of s.mins) set.add(m);
  }
  const perBook = new Map(); // 书 → Map(日期 → 秒)   维度 1
  const bookTotal = new Map(); // 书 → 秒              维度 2
  const perDay = new Map(); // 日期 → 秒（全部书）     维度 3
  let grand = 0; //                                    维度 4
  for (const [book, set] of byBook) {
    const mins = [...set].sort((a, b) => a - b);
    const days = new Map();
    let total = 0;
    for (let i = 1; i < mins.length; i++) {
      const d = (mins[i] - mins[i - 1]) * 60000;
      if (d > RT_GAP_MS) continue;
      const day = rtLocalDay(mins[i - 1] * 60000);
      days.set(day, (days.get(day) || 0) + d / 1000);
      total += d / 1000;
    }
    if (total < 60) continue;
    for (const [day, sec] of days) perDay.set(day, (perDay.get(day) || 0) + sec);
    perBook.set(book, days);
    bookTotal.set(book, total);
    grand += total;
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
    this.rtScope = null; // 阅读时长视角：null=全部书，否则书名
    this.data = null;
    this.rt = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "深读看板";
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
    const data = { books: [], insights: [], heat: new Map(), indexMeta: new Map() };

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
          lastReview: latestReview(chapters),
        });
      }
    }

    // INDEX.md 的摘要与 ★
    const indexFile = vault.getAbstractFileByPath("insight/INDEX.md");
    if (indexFile instanceof TFile) {
      const text = await vault.cachedRead(indexFile);
      for (const line of text.split("\n")) {
        const m = line.match(/^-\s*\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]\s*(★)?\s*—\s*(.+)$/);
        if (m) data.indexMeta.set(m[1].trim(), { starred: !!m[2], summary: m[3].trim() });
      }
    }

    // insight 条目 + 热力图日期
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
          data.insights.push({
            file: f,
            dim: dim.name,
            title: typeof fm.title === "string" ? fm.title : f.basename,
            updated,
            starred: !!meta.starred,
            summary: meta.summary || "",
          });
          // 正文里出现的日期 → 热力图（同文件同日只记一次）
          const body = await vault.cachedRead(f);
          const seen = new Set();
          for (const dm of body.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)) seen.add(dm[1]);
          for (const day of seen) data.heat.set(day, (data.heat.get(day) || 0) + 1);
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
    this.renderHeatmap(el);
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
    titleWrap.createEl("h1", { cls: "ed-title", text: "深读看板" });
    titleWrap.createDiv({
      cls: "ed-subtitle",
      text: new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" }),
    });

    const { books, insights } = this.data;
    let chDone = 0,
      chTotal = 0,
      uDone = 0;
    for (const b of books) {
      chDone += b.stats.done;
      chTotal += b.stats.total;
      uDone += b.stats.unitsDone;
    }
    const open = insights.filter((i) => i.dim === "悬题").length;

    const pills = header.createDiv({ cls: "ed-pills" });
    const pill = (icon, text) => {
      const p = pills.createDiv({ cls: "ed-pill" });
      setIcon(p.createSpan({ cls: "ed-pill-icon" }), icon);
      p.createSpan({ text });
    };
    pill("book-open", `${books.length} 本在读`);
    pill("check-circle-2", `已读 ${chDone}/${chTotal} 章 · ${uDone} 个单元`);
    pill("sparkles", `沉淀 ${insights.length} 条`);
    pill("circle-help", `悬题 ${open} 个`);
    if (this.rt && this.rt.ok && this.rt.agg.grand) pill("timer", `阅读 ${rtFmt(this.rt.agg.grand)}`);

    const refreshBtn = header.createDiv({ cls: "ed-refresh", attr: { "aria-label": "刷新" } });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => this.refresh());
  }

  renderBooks(parent) {
    const section = parent.createDiv({ cls: "ed-section" });
    section.createEl("h2", { cls: "ed-section-title", text: "书架" });
    const grid = section.createDiv({ cls: "ed-book-grid" });

    for (const book of this.data.books) {
      const card = grid.createDiv({ cls: "ed-book-card" });

      const top = card.createDiv({ cls: "ed-book-top" });
      this.renderRing(top, book.stats.percent);
      const info = top.createDiv({ cls: "ed-book-info" });

      if (book.pos) {
        const btn = top.createEl("button", { cls: "ed-continue-btn", attr: { "aria-label": `继续读《${book.name}》` } });
        setIcon(btn.createSpan({ cls: "ed-continue-icon" }), "play");
        btn.createSpan({ text: "继续阅读" });
        btn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          this.continueReading(book.name);
        });
      }

      const nameEl = info.createDiv({ cls: "ed-book-name", text: `《${book.name}》` });
      nameEl.addEventListener("click", () => this.openInTab(book.progressFile));
      this.hoverable(nameEl, book.progressFile);
      info.createDiv({
        cls: "ed-book-stat",
        text:
          `${book.stats.done}/${book.stats.total} 章` +
          (book.stats.unitsTotal ? ` · 单元 ${book.stats.unitsDone}/${book.stats.unitsTotal}` : ""),
      });

      if (book.pos) {
        const posEl = info.createDiv({ cls: "ed-book-pos" });
        setIcon(posEl.createSpan({ cls: "ed-pos-icon" }), "bookmark");
        const posLabel = book.pos.unit
          ? `${book.pos.chapter.label.split("—")[0].trim()} · ${book.pos.unit.label}`
          : book.pos.chapter.label;
        posEl.createSpan({ cls: "ed-pos-text", text: posLabel });
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
        const doneEl = info.createDiv({ cls: "ed-book-pos" });
        setIcon(doneEl.createSpan({ cls: "ed-pos-icon" }), "party-popper");
        doneEl.createSpan({ cls: "ed-pos-text", text: "全书读完" });
      }

      // 章节点阵
      const dots = card.createDiv({ cls: "ed-dots" });
      for (const ch of book.chapters) {
        const dot = dots.createDiv({ cls: "ed-dot" });
        let state = "todo";
        if (ch.done) state = "done";
        else if (ch.units.some((u) => u.done)) state = "partial";
        dot.addClass(`is-${state}`);
        const unitsNote = ch.units.length
          ? `（${ch.units.filter((u) => u.done).length}/${ch.units.length} 单元）`
          : "";
        dot.setAttribute("aria-label", ch.label + unitsNote);
        const target = this.resolveChapterFile(book.name, ch.chDir, null);
        if (target) {
          dot.addClass("is-clickable");
          dot.addEventListener("click", () => this.openInTab(target));
        }
      }

      if (book.lastReview) {
        const rv = card.createDiv({ cls: "ed-book-review" });
        rv.createSpan({ cls: "ed-review-tag", text: "最近回看" });
        rv.createSpan({ cls: "ed-review-text", text: book.lastReview.review });
        rv.setAttribute("aria-label", book.lastReview.label);
      }
    }
  }

  renderRing(parent, percent) {
    const size = 64;
    const stroke = 6;
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
    if (!grand) {
      section.createDiv({ cls: "ed-empty", text: "还没有可统计的阅读会话" });
      return;
    }
    if (this.rtScope && !perBook.has(this.rtScope)) this.rtScope = null;

    // 范围 chips：全部 + 每本书，chip 上直接带累计时长（维度 2 / 4）
    const chips = section.createDiv({ cls: "ed-chips" });
    const mkChip = (label, total, scope, hue) => {
      const chip = chips.createDiv({ cls: "ed-chip" });
      chip.style.setProperty("--dim-hue", String(hue));
      if (this.rtScope === scope) chip.addClass("is-active");
      chip.createSpan({ text: label });
      chip.createSpan({ cls: "ed-rt-chip-time", text: rtFmt(total) });
      chip.addEventListener("click", () => {
        if (this.rtScope === scope) return;
        this.rtScope = scope;
        this.refresh();
      });
    };
    mkChip("全部", grand, null, 210);
    const bookHue = (name) => [...name].reduce((a, c) => a + c.codePointAt(0), 0) % 360;
    for (const [book, total] of [...bookTotal.entries()].sort((a, b) => b[1] - a[1])) {
      mkChip(`《${book}》`, total, book, bookHue(book));
    }

    const source = this.rtScope ? perBook.get(this.rtScope) : perDay;

    // 近 30 天柱状图（维度 1 / 3：书或全部 × 日期）
    const dayKeys = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dayKeys.push(rtLocalDay(d.getTime()));
    }
    const vals = dayKeys.map((k) => source.get(k) || 0);
    const max = Math.max(...vals, 1);
    const chart = section.createDiv({ cls: "ed-rt-chart" });
    dayKeys.forEach((k, i) => {
      const col = chart.createDiv({ cls: "ed-rt-col" });
      col.setAttribute("aria-label", `${k} · ${rtFmt(vals[i])}`);
      const bar = col.createDiv({ cls: "ed-rt-bar" });
      if (vals[i]) bar.style.height = Math.max(6, Math.round((vals[i] / max) * 100)) + "%";
      else bar.addClass("is-zero");
      if (i % 7 === 1 || i === 29) col.createDiv({ cls: "ed-rt-xlabel", text: k.slice(5) });
    });

    // 当前范围的汇总行
    const recent = (n) => dayKeys.slice(30 - n).reduce((a, k) => a + (source.get(k) || 0), 0);
    const totalScope = this.rtScope ? bookTotal.get(this.rtScope) || 0 : grand;
    const summary = section.createDiv({ cls: "ed-rt-summary" });
    const sumItem = (label, sec) => {
      const it = summary.createDiv({ cls: "ed-rt-sum-item" });
      it.createSpan({ cls: "ed-rt-sum-label", text: label });
      it.createSpan({ cls: "ed-rt-sum-val", text: rtFmt(sec) });
    };
    sumItem("今日", recent(1));
    sumItem("近 7 天", recent(7));
    sumItem("近 30 天", recent(30));
    sumItem("累计", totalScope);
  }

  renderHeatmap(parent) {
    const section = parent.createDiv({ cls: "ed-section" });
    section.createEl("h2", { cls: "ed-section-title", text: "沉淀热力 · 近 16 周" });
    const wrap = section.createDiv({ cls: "ed-heat-wrap" });
    const grid = wrap.createDiv({ cls: "ed-heat" });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = 7 * 16;
    // 从 16 周前的周一开始
    const start = new Date(today);
    start.setDate(start.getDate() - (days - 1));
    const offset = (start.getDay() + 6) % 7; // 周一=0
    start.setDate(start.getDate() - offset);

    const fmt = (d) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
      const key = fmt(d);
      const n = this.data.heat.get(key) || 0;
      const cell = grid.createDiv({ cls: "ed-heat-cell" });
      const lvl = n === 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : 3;
      cell.addClass(`lv-${lvl}`);
      cell.setAttribute("aria-label", `${key} · ${n} 条`);
    }
  }

  renderInsights(parent) {
    const section = parent.createDiv({ cls: "ed-section" });
    const head = section.createDiv({ cls: "ed-insight-head" });
    head.createEl("h2", { cls: "ed-section-title", text: "Insight 沉淀" });

    // 维度筛选 chips
    const chips = section.createDiv({ cls: "ed-chips" });
    for (const dim of DIMENSIONS) {
      const count = this.data.insights.filter((i) => i.dim === dim.key).length;
      const chip = chips.createDiv({ cls: "ed-chip" });
      chip.style.setProperty("--dim-hue", String(dim.hue));
      if (this.dimFilter === dim.key) chip.addClass("is-active");
      setIcon(chip.createSpan({ cls: "ed-chip-icon" }), dim.icon);
      chip.createSpan({ text: `${dim.key} ${count}` });
      chip.addEventListener("click", () => {
        this.dimFilter = this.dimFilter === dim.key ? null : dim.key;
        this.refresh();
      });
    }

    const list = section.createDiv({ cls: "ed-insight-list" });
    const items = this.dimFilter
      ? this.data.insights.filter((i) => i.dim === this.dimFilter)
      : this.data.insights.slice(0, 14);

    if (this.dimFilter === null && this.data.insights.length > 14) {
      head.createSpan({ cls: "ed-insight-hint", text: "最近 14 条 · 点维度看全部" });
    }

    for (const item of items) {
      const dim = DIM_BY_KEY[item.dim];
      const row = list.createDiv({ cls: "ed-insight-row" });
      row.style.setProperty("--dim-hue", String(dim ? dim.hue : 0));
      const main = row.createDiv({ cls: "ed-insight-main" });
      const titleLine = main.createDiv({ cls: "ed-insight-title-line" });
      if (item.starred) titleLine.createSpan({ cls: "ed-star", text: "★" });
      titleLine.createSpan({ cls: "ed-insight-title", text: item.title });
      titleLine.createSpan({ cls: "ed-insight-dim", text: item.dim });
      if (item.summary) main.createDiv({ cls: "ed-insight-summary", text: item.summary });
      row.createDiv({ cls: "ed-insight-date", text: item.updated.slice(5) });
      row.addEventListener("click", () => this.openInTab(item.file));
      this.hoverable(row, item.file);
    }

    if (!items.length) list.createDiv({ cls: "ed-empty", text: "这个维度还没有沉淀" });
  }

  async onClose() {
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
