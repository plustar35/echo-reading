"use strict";

const { Plugin, ItemView, TFile, TFolder, debounce, setIcon } = require("obsidian");

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

/* ---------------- 视图 ---------------- */

class EchoDashboardView extends ItemView {
  constructor(leaf) {
    super(leaf);
    this.dimFilter = null; // 当前维度筛选
    this.data = null;
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
    const el = this.contentEl;
    el.empty();

    this.renderHeader(el);
    this.renderBooks(el);
    this.renderHeatmap(el);
    this.renderInsights(el);
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
    this.registerView(VIEW_TYPE, (leaf) => new EchoDashboardView(leaf));

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
