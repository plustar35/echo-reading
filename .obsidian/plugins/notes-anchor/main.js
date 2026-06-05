'use strict';

const { Plugin, TFile, MarkdownRenderer, Modal, Notice } = require('obsidian');

/* 写笔记的输入弹框：划线自动取选中文字，只让用户填正文 */
class NoteModal extends Modal {
  constructor(app, anchor, onSubmit, initial = '', heading = '写笔记') {
    super(app);
    this.anchor = anchor;
    this.onSubmit = onSubmit;
    this.initial = initial;
    this.heading = heading;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.heading });
    const a = contentEl.createDiv({ cls: 'annot-modal-anchor' });
    a.setText('划线：' + this.anchor);
    const ta = contentEl.createEl('textarea', { cls: 'annot-modal-textarea' });
    ta.rows = 5;
    ta.value = this.initial || '';
    ta.placeholder = '写下你的批注…（Cmd/Ctrl+Enter 保存）';
    const row = contentEl.createDiv({ cls: 'annot-modal-buttons' });
    const save = row.createEl('button', { text: '保存', cls: 'mod-cta' });
    const cancel = row.createEl('button', { text: '取消' });
    const doSave = () => {
      const v = ta.value.trim();
      if (!v) {
        new Notice('笔记内容是空的');
        return;
      }
      this.onSubmit(v);
      this.close();
    };
    save.onclick = doSave;
    cancel.onclick = () => this.close();
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        doSave();
      }
    });
    setTimeout(() => ta.focus(), 0);
  }
  onClose() {
    this.contentEl.empty();
  }
}

/* 署名行约定：`· 作者 YYYY-MM-DD`，可独占一行，也可缀在正文末行（如 [[链接]] 之后）。
   解析时抽成结构化 sign 给弹窗单独渲染；旁车文件里原样保留，改/删逻辑不受影响。 */
const SIGN_RE = /[·•∙]\s*(我|Claude|[^\s·•∙]+?)\s+(\d{4})-(\d{2})-(\d{2})\s*$/;
function deriveSign(body) {
  const clean = body.slice();
  let sign = null;
  for (let i = clean.length - 1; i >= 0; i--) {
    if (clean[i].trim() === '') continue; // 跳过末尾空行
    const m = clean[i].match(SIGN_RE);
    if (m) {
      sign = { author: m[1], y: m[2], mo: m[3], d: m[4] };
      const rest = clean[i].replace(SIGN_RE, '').replace(/\s+$/, '');
      if (rest.trim() === '') clean.splice(i, 1); // 署名独占一行 → 整行删
      else clean[i] = rest; // 署名缀在正文后 → 只剥掉署名段
    }
    break; // 只看最后一个非空行
  }
  while (clean.length && clean[clean.length - 1].trim() === '') clean.pop();
  return { sign, bodyClean: clean };
}

/* 解析 *.notes.md：抓出每个  > [!type] 划线：xxx  的 callout，
   把后面的 > 行收成 body。原文/旁车都不改，只是读。 */
function parseAnnotations(md) {
  const lines = md.split('\n');
  const anns = [];
  let cur = null;
  const anchorRe = /^>\s*\[!(\w+)\]\s*划线\s*[:：]\s*(.+?)\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(anchorRe);
    if (m) {
      if (cur) anns.push(cur);
      cur = {
        type: m[1].toLowerCase(),
        anchor: m[2].trim(),
        body: [],
        startLine: i, // 这条批注在文件里的起止行（改/删时用）
        endLine: i + 1,
      };
    } else if (cur && /^>/.test(line)) {
      cur.body.push(line.replace(/^>\s?/, ''));
      cur.endLine = i + 1;
    } else if (cur) {
      anns.push(cur);
      cur = null;
    }
  }
  if (cur) anns.push(cur);
  // 去掉 body 末尾空行；再把署名抽成结构化 sign + 去署名的 bodyClean（供弹窗显示）
  for (const a of anns) {
    while (a.body.length && a.body[a.body.length - 1].trim() === '') a.body.pop();
    const { sign, bodyClean } = deriveSign(a.body); // a.body 保持原样（改/删按它定位）
    a.sign = sign;
    a.bodyClean = bodyClean;
  }
  return anns;
}

module.exports = class NotesAnchorPlugin extends Plugin {
  async onload() {
    this.cache = new Map();

    // 旁车被新建 / 改动 / 删除 / 改名时：清缓存 + 命令对应原文页面重渲染（无需切文件）。
    // 必须同时听 create——新建旁车只触发 create，漏掉它，会话中途写的批注要等重载才高亮。
    const onSidecarChange = (path) => {
      if (!path) return;
      this.cache.delete(path);
      if (path.endsWith('.notes.md')) {
        const targetPath = path.replace(/\.notes\.md$/, '.md');
        this.rerenderViewsFor(targetPath);
      }
    };
    this.registerEvent(this.app.vault.on('modify', (f) => onSidecarChange(f && f.path)));
    this.registerEvent(this.app.vault.on('create', (f) => onSidecarChange(f && f.path)));
    this.registerEvent(this.app.vault.on('delete', (f) => onSidecarChange(f && f.path)));
    this.registerEvent(
      this.app.vault.on('rename', (f, oldPath) => {
        onSidecarChange(oldPath); // 旧名：清旧缓存 + 刷新旧原文
        onSidecarChange(f && f.path); // 新名：按新名字重新投影
      })
    );

    // 核心：阅读视图渲染每个区块时，找划线词、加高亮、挂点击
    this.registerMarkdownPostProcessor(async (el, ctx) => {
      const path = ctx && ctx.sourcePath;
      if (!path || path.endsWith('.notes.md')) return; // 旁车自己不标注
      if (el.closest && el.closest('.annot-popup')) return; // 别在弹窗里再标
      const notesPath = path.replace(/\.md$/, '.notes.md');
      const anns = await this.getAnnotations(notesPath);
      if (!anns.length) return;
      for (const ann of anns) this.decorate(el, ann, path);
    });

    // 编辑视图里选中文字 → 右键「写笔记」
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor, view) => {
        const file = view && view.file;
        if (!file || file.path.endsWith('.notes.md')) return;
        const sel = editor.getSelection();
        if (!sel || !sel.trim()) return;
        menu.addItem((item) => {
          item
            .setTitle('写笔记')
            .setIcon('pencil')
            .onClick(() => this.openNoteModal(file, sel));
        });
      })
    );

    // 命令（可在 设置 → 快捷键 里绑定/修改；默认 Cmd/Ctrl+Shift+N）
    this.addCommand({
      id: 'write-note',
      name: '写笔记（给选中文字加批注）',
      editorCallback: (editor, view) => {
        const file = view && view.file;
        if (!file || file.path.endsWith('.notes.md')) {
          new Notice('请在正文（非 .notes.md）里使用');
          return;
        }
        const sel = editor.getSelection();
        if (!sel || !sel.trim()) {
          new Notice('请先选中一段文字');
          return;
        }
        this.openNoteModal(file, sel);
      },
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'N' }],
    });

    // 点别处 / Esc 关弹窗
    this.registerDomEvent(document, 'click', (e) => {
      if (!e.target.closest('.annot-popup') && !e.target.closest('.annot-mark')) {
        this.closePopups();
      }
    });
    this.registerDomEvent(document, 'keydown', (e) => {
      if (e.key === 'Escape') this.closePopups();
    });

    // 阅读视图里划选文字 → 选区旁浮出「📝 写笔记」按钮（Medium / Hypothesis 式）
    this.selBtn = null;
    this.registerDomEvent(document, 'mouseup', () => {
      setTimeout(() => this.maybeShowSelButton(), 0); // 等一拍让选区落定
    });
    this.registerDomEvent(document, 'selectionchange', () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) this.hideSelButton(); // 选区清空就收起
    });
    this.registerDomEvent(document, 'scroll', () => this.hideSelButton(), true); // 滚动就收起（capture，预览内滚动也能收到）

    // 弹窗开着时：滚动 / 改窗大小都让它跟住划线位置（capture 捕到预览容器内部的滚动），
    // 否则长批注在偏下处点开，编辑/删除按钮会卡在视野外、又拖不进来。
    this.registerDomEvent(document, 'scroll', () => this.repositionActivePopup(), true);
    this.registerDomEvent(window, 'resize', () => this.repositionActivePopup());
  }

  // 跟随当前弹窗对应的划线重新定位；划线已不在 DOM（重渲染过）就直接收起弹窗
  repositionActivePopup() {
    const a = this._activePopup;
    if (!a) return;
    if (!a.span || !a.span.isConnected || !a.pop.isConnected) {
      this.closePopups();
      return;
    }
    this.repositionPopup(a.pop, a.span);
  }

  // 阅读视图选中文字时，在选区上方浮出「写笔记」按钮
  maybeShowSelButton() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return this.hideSelButton();
    const text = (sel.toString() || '').trim();
    if (!text) return this.hideSelButton();
    const node = sel.anchorNode;
    const el = node && (node.nodeType === 3 ? node.parentElement : node);
    if (!el) return this.hideSelButton();
    if (el.closest('.annot-popup') || el.closest('.annot-sel-btn')) return this.hideSelButton();
    // 阅读视图(markdown-preview) + 编辑/实时预览(cm-editor) 都出按钮；其它地方不出
    if (!el.closest('.markdown-preview-view, .markdown-reading-view, .cm-editor'))
      return this.hideSelButton();
    const file = this.fileForNode(node);
    if (!file || file.path.endsWith('.notes.md')) return this.hideSelButton();

    let rect;
    try {
      rect = sel.getRangeAt(0).getBoundingClientRect();
    } catch (e) {
      return this.hideSelButton();
    }
    if (!rect || (!rect.width && !rect.height)) return this.hideSelButton();

    this.hideSelButton();
    const btn = document.createElement('button');
    btn.className = 'annot-sel-btn';
    btn.textContent = '📝 写笔记';
    document.body.appendChild(btn);
    btn.style.top = rect.top + window.scrollY - btn.offsetHeight - 8 + 'px';
    let left = rect.left + window.scrollX + rect.width / 2 - btn.offsetWidth / 2;
    left = Math.max(window.scrollX + 8, left);
    btn.style.left = left + 'px';
    // 用 mousedown：点按钮前选区还在，先抓住文字再清理
    btn.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.hideSelButton();
      this.openNoteModal(file, text);
    });
    this.selBtn = btn;
  }

  hideSelButton() {
    if (this.selBtn) {
      this.selBtn.remove();
      this.selBtn = null;
    }
  }

  // 选区所在的 DOM 节点属于哪个 markdown 文件
  fileForNode(node) {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view && view.containerEl && view.containerEl.contains(node) && view.file) {
        return view.file;
      }
    }
    return null;
  }

  closePopups() {
    document.querySelectorAll('.annot-popup').forEach((p) => p.remove());
    this._activePopup = null;
  }

  /* 找到正在显示该原文的所有页面，强制重渲染，让新批注立刻高亮。
     重渲染会重置滚动位置，所以先存当前位置、渲染后再还原，阅读位置不动。 */
  rerenderViewsFor(targetPath) {
    this.app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
      const view = leaf.view;
      if (view && view.file && view.file.path === targetPath && view.previewMode) {
        const pm = view.previewMode;
        let scroll = null;
        try { scroll = pm.getScroll(); } catch (e) {} // 基于行号的滚动量，重排后仍有效
        pm.rerender(true);
        if (scroll != null) {
          const restore = () => { try { pm.applyScroll(scroll); } catch (e) {} };
          setTimeout(restore, 0); // 下一帧还原
          setTimeout(restore, 60); // 二次保险：等异步区块渲染落定再还原一次
        }
      }
    });
  }

  openNoteModal(file, selection) {
    const anchor = (selection || '')
      .replace(/\*\*|__|\*|_|`/g, '') // 剔掉划选时误带进来的 markdown 标记（**加粗** 之类）
      .replace(/\s+/g, ' ')
      .trim();
    if (!anchor) {
      new Notice('请先选中一段文字');
      return;
    }
    new NoteModal(this.app, anchor, async (content) => {
      await this.addNote(file, anchor, content);
    }).open();
  }

  async addNote(file, anchor, content) {
    if (!file) return;
    const notesPath = file.path.replace(/\.md$/, '.notes.md');
    const d = new Date();
    const date =
      d.getFullYear() +
      '-' +
      String(d.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(d.getDate()).padStart(2, '0');
    const body = content
      .split('\n')
      .map((l) => '> ' + l)
      .join('\n');
    const block = `\n> [!note] 划线：${anchor}\n${body}\n> · 我 ${date}\n`;

    const existing = this.app.vault.getAbstractFileByPath(notesPath);
    if (existing instanceof TFile) {
      await this.app.vault.append(existing, block);
    } else {
      const fm =
        `---\ntype: 批注旁车\nupdated: ${date}\n---\n\n` +
        `> 批注旁车。批注存这里，原文 \`${file.name}\` 一字不动。\n` +
        block;
      await this.app.vault.create(notesPath, fm);
    }
    this.cache.delete(notesPath);
    new Notice('已写入笔记 ✓');
  }

  notesFileFor(sourcePath) {
    const p = sourcePath.replace(/\.md$/, '.notes.md');
    const f = this.app.vault.getAbstractFileByPath(p);
    return f instanceof TFile ? f : null;
  }

  // 在最新文件内容里重新定位这条批注（按划线+正文匹配，避免行号过期）
  findBlock(content, ann) {
    return parseAnnotations(content).find(
      (a) => a.anchor === ann.anchor && a.body.join('\n') === ann.body.join('\n')
    );
  }

  async editNote(sourcePath, ann, newBody) {
    const file = this.notesFileFor(sourcePath);
    if (!file) return;
    const content = await this.app.vault.read(file);
    const lines = content.split('\n');
    const match = this.findBlock(content, ann);
    if (!match) {
      new Notice('没找到这条笔记，可能已被改动');
      return;
    }
    const titleLine = lines[match.startLine]; // 保留原标题（含划线）
    const block = [titleLine, ...newBody.split('\n').map((l) => '> ' + l)];
    if (ann.sign) {
      const s = ann.sign; // 原样补回署名（作者/日期不变，编辑只动正文）
      block.push(`> · ${s.author} ${s.y}-${s.mo}-${s.d}`);
    }
    const updated = [
      ...lines.slice(0, match.startLine),
      ...block,
      ...lines.slice(match.endLine),
    ];
    await this.app.vault.modify(file, updated.join('\n'));
    new Notice('笔记已更新 ✓');
  }

  async deleteNote(sourcePath, ann) {
    const file = this.notesFileFor(sourcePath);
    if (!file) return;
    const content = await this.app.vault.read(file);
    const lines = content.split('\n');
    const match = this.findBlock(content, ann);
    if (!match) {
      new Notice('没找到这条笔记');
      return;
    }
    let end = match.endLine;
    if (lines[end] !== undefined && lines[end].trim() === '') end++; // 顺带吃掉一个空行
    const updated = [...lines.slice(0, match.startLine), ...lines.slice(end)];
    await this.app.vault.modify(file, updated.join('\n'));
    this.closePopups();
    new Notice('笔记已删除');
  }

  async getAnnotations(notesPath) {
    if (this.cache.has(notesPath)) return this.cache.get(notesPath);
    const file = this.app.vault.getAbstractFileByPath(notesPath);
    if (!(file instanceof TFile)) {
      this.cache.set(notesPath, []);
      return [];
    }
    const content = await this.app.vault.read(file);
    const anns = parseAnnotations(content);
    this.cache.set(notesPath, anns);
    return anns;
  }

  decorate(el, ann, sourcePath) {
    // 在整个区块的纯文本里找划线段（可跨加粗/链接等行内格式）
    const full = el.textContent || '';
    let anchor = ann.anchor;
    let from = full.indexOf(anchor);
    if (from === -1) {
      // 容错：锚点里若带 markdown 标记（** __ * _ `），去掉再找——
      // 原文渲染后的纯文本本就不含这些标记（缓解「划线含 ** 不高亮」）
      const stripped = anchor.replace(/\*\*|__|\*|_|`/g, '');
      if (stripped && stripped !== anchor) {
        const p = full.indexOf(stripped);
        if (p !== -1) { from = p; anchor = stripped; }
      }
    }
    if (from === -1) return; // 这个区块里没有这段文字
    const to = from + anchor.length;

    // 收集所有文本节点及其在 textContent 中的全局区间
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    const segs = [];
    let pos = 0;
    let node;
    while ((node = walker.nextNode())) {
      const len = node.nodeValue.length;
      segs.push({ node, start: pos, end: pos + len });
      pos += len;
    }

    // 把划线区间 [from,to) 落到每个相交的文本节点上，分段包裹
    const spans = [];
    for (const seg of segs) {
      const s = Math.max(from, seg.start);
      const e = Math.min(to, seg.end);
      if (s >= e) continue;
      if (seg.node.parentElement && seg.node.parentElement.closest('.annot-mark')) continue;
      const range = document.createRange();
      range.setStart(seg.node, s - seg.start);
      range.setEnd(seg.node, e - seg.start);
      const span = document.createElement('span');
      span.className = 'annot-mark';
      span.dataset.type = ann.type || 'note';
      try {
        range.surroundContents(span);
      } catch (err) {
        continue;
      }
      this.registerDomEvent(span, 'click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.showPopup(span, ann, sourcePath);
      });
      spans.push(span);
    }
    // 只在最后一段挂 📝，避免跨节点时每段都冒一个
    if (spans.length) spans[spans.length - 1].classList.add('annot-end');
  }

  async showPopup(span, ann, sourcePath) {
    this.closePopups();
    const pop = document.createElement('div');
    pop.className = 'annot-popup';
    pop.dataset.type = ann.type || 'note';
    document.body.appendChild(pop);
    this._activePopup = { pop, span }; // 记下来，滚动 / 改窗时跟着划线动
    // 弹窗内的点击不冒泡到全局“点外面关弹窗”的监听（否则编辑按钮被重绘后会误关）
    pop.addEventListener('click', (e) => e.stopPropagation());

    // 锚点：只作顶部灰色小字 caption（指出批的是哪句），不再是弹窗主角。
    // 默认只显示一行、超出省略（见 styles.css）；悬停 title 看全句。
    if (ann.anchor) {
      const cap = pop.createDiv({ cls: 'annot-popup-anchor' });
      cap.setText(ann.anchor);
      cap.setAttr('title', ann.anchor);
    }
    const body = pop.createDiv({ cls: 'annot-popup-body' });
    const footer = pop.createDiv({ cls: 'annot-popup-footer' });

    const LONG = 240;     // 超过这个高度算「长批注」，收起到这个高度（与 CSS max-height 对应）
    let collapsed = true; // 长批注默认收起；短批注此值不起作用
    let isLong = false;   // 渲染后实测内容是否超长

    // 内容超长时在 footer 最左加「展开/收起」；查看/编辑两态都加 → 行构成一致，弹窗不跳
    const addToggle = (onToggle) => {
      if (!isLong) return;
      const t = footer.createEl('button', {
        cls: 'annot-popup-toggle',
        text: collapsed ? '展开 ⌄' : '收起 ⌃',
      });
      t.style.marginRight = 'auto'; // 浮到最左，编辑/删除/保存按钮仍靠右
      t.onclick = () => {
        collapsed = !collapsed;
        onToggle();
      };
    };

    // 署名：作者着色 + 图标 +「M月D日」，渲染在正文与按钮之间
    const renderSign = () => {
      const old = pop.querySelector('.annot-popup-sign');
      if (old) old.remove();
      if (!ann.sign) return;
      const s = ann.sign;
      const isMe = s.author === '我';
      const isClaude = s.author === 'Claude';
      const sign = document.createElement('div');
      sign.className = 'annot-popup-sign' + (isMe ? ' is-me' : isClaude ? ' is-claude' : '');
      const icon = isMe ? '🙋' : isClaude ? '🤖' : '✍️';
      sign.setText(`${icon} ${s.author} · ${parseInt(s.mo, 10)}月${parseInt(s.d, 10)}日`);
      pop.insertBefore(sign, footer);
    };

    // 查看态：渲染批注 + 编辑/删除
    const renderView = async () => {
      body.empty();
      body.removeClass('is-editing');
      body.removeClass('collapsed');
      body.style.height = '';
      footer.empty();
      const md = ann.bodyClean.join('\n'); // 去掉署名行的纯批注
      try {
        if (MarkdownRenderer.render) {
          await MarkdownRenderer.render(this.app, md, body, sourcePath, this);
        } else {
          await MarkdownRenderer.renderMarkdown(md, body, sourcePath, this);
        }
      } catch (e) {
        body.setText(md);
      }
      isLong = body.scrollHeight > LONG + 24; // 实测是否超长
      if (isLong && collapsed) body.addClass('collapsed');
      renderSign();
      addToggle(() => renderView()); // 切收起/展开 → 重渲染查看态
      const editBtn = footer.createEl('button', { text: '编辑', cls: 'annot-popup-btn' });
      const delBtn = footer.createEl('button', {
        text: '删除',
        cls: 'annot-popup-btn annot-popup-del',
      });
      editBtn.onclick = () => renderEdit();
      let armed = false;
      delBtn.onclick = () => {
        if (!armed) {
          armed = true;
          delBtn.textContent = '确认删除?';
          delBtn.classList.add('armed');
          return;
        }
        this.deleteNote(sourcePath, ann);
      };
      this.repositionPopup(pop, span);
    };

    // 编辑态：弹窗内就地改
    const renderEdit = () => {
      const lockW = pop.offsetWidth;
      const viewH = body.offsetHeight; // 当前查看态高度（收起=LONG / 展开或短=实际高）
      pop.style.width = lockW + 'px';
      const oldSign = pop.querySelector('.annot-popup-sign');
      if (oldSign) oldSign.remove();
      body.empty();
      body.addClass('is-editing');
      body.removeClass('collapsed');
      body.style.height = '';
      footer.empty();
      const ta = body.createEl('textarea', { cls: 'annot-popup-textarea' });
      ta.value = ann.bodyClean.join('\n'); // 显示=可编辑的纯批注（无署名行），所见即所改
      const fit = () => {
        ta.style.height = 'auto';
        return ta.scrollHeight + 2; // +2 抵掉上下边框，避免差几 px 触发滚动条
      };
      const applyHeight = () => {
        if (isLong && collapsed) ta.style.height = LONG + 'px'; // 收起：固定高，超出内部滚动
        else ta.style.height = Math.max(viewH, fit()) + 'px'; // 展开/短：贴合内容，且不低于查看态
      };
      applyHeight();
      addToggle(() => {
        applyHeight();
        this.repositionPopup(pop, span);
      });
      const saveBtn = footer.createEl('button', {
        text: '保存',
        cls: 'annot-popup-btn mod-cta',
      });
      const cancelBtn = footer.createEl('button', { text: '取消', cls: 'annot-popup-btn' });
      const doSave = async () => {
        const v = ta.value.trim();
        if (!v) {
          new Notice('笔记内容是空的');
          return;
        }
        await this.editNote(sourcePath, ann, v);
        this.closePopups(); // 文件改动会触发重渲染刷新高亮；再点开即新内容
      };
      saveBtn.onclick = doSave;
      cancelBtn.onclick = () => renderView();
      ta.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          doSave();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation(); // Esc 只取消编辑，不关整个弹窗
          renderView();
        }
      });
      // 光标移到开头并滚到顶部——避免设了 value 后默认停在末尾、显示成「后半段」
      setTimeout(() => {
        ta.focus();
        ta.setSelectionRange(0, 0);
        ta.scrollTop = 0;
      }, 0);
      this.repositionPopup(pop, span);
    };

    await renderView();
  }

  // 弹窗用 position: fixed（相对视口），坐标直接取划线的视口位置，无需叠加滚动偏移。
  repositionPopup(pop, span) {
    const rect = span.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const gap = 6;
    const ph = pop.offsetHeight;
    const pw = pop.offsetWidth;

    // 竖直：默认贴在划线下方；放不下就上提，保证整窗（含底部按钮）留在视野内
    let top = rect.bottom + gap;
    top = Math.min(top, vh - ph - 8);
    top = Math.max(8, top);

    // 水平：左对齐划线，右越界则左移，始终留在视野内
    let left = Math.min(rect.left, vw - pw - 12);
    left = Math.max(8, left);

    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
  }

  onunload() {
    this.closePopups();
    this.hideSelButton();
    document
      .querySelectorAll('.annot-mark')
      .forEach((s) => s.replaceWith(document.createTextNode(s.textContent)));
  }
};
