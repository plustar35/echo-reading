#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
往阅读单元旁车 NN.notes.md 追加一条批注笔记（echo-reading）。

确定性脏活固化在这里：锚点对原文精确校验、frontmatter、追加/新建、callout 格式、署名日期。
Agent 只决定「划线哪句 / 笔记写什么」，从 stdin 喂一段 JSON：

  {
    "book": "道德经",
    "chapter": "ch08",            # 或 "8"
    "unit": "01",                 # 或 "01.md"
    "anchor": "水善利万物而不争",   # 原文里的精确片段（可带 ** * ` 标记，脚本会剥）
    "body": "不争不是退让……\\n可多行，可放 [[概念/不争]]。",
    "author": "Claude",           # 选填，默认 Claude
    "date": "2026-06-05",         # 选填，默认今天
    "root": "/path/to/project"    # 选填，默认 $CLAUDE_PROJECT_DIR 或当前目录
  }

校验：anchor（剥标记后）必须是 NN.md（剥标记后）的子串，否则报错、不写。
用法：  python3 write_note.py < note.json     或用 heredoc 管道喂 JSON
"""
import sys, os, re, json, datetime

MARKERS = re.compile(r'[*`]')   # 渲染后的纯文本里不含的 markdown 强调/代码标记

def clean(s):
    return MARKERS.sub('', s)

def die(msg):
    print("✗ " + msg, file=sys.stderr)
    sys.exit(1)

def main():
    raw = sys.stdin.read()
    if not raw.strip():
        die("没有从 stdin 读到 JSON。把笔记内容作为 JSON 管道喂给本脚本。")
    try:
        d = json.loads(raw)
    except json.JSONDecodeError as e:
        die(f"JSON 解析失败：{e}")

    book    = (d.get("book") or "").strip()
    chapter = (d.get("chapter") or "").strip()
    unit    = (d.get("unit") or "").strip()
    anchor_in = d.get("anchor") or ""
    body    = (d.get("body") or "").rstrip("\n")
    author  = (d.get("author") or "Claude").strip()
    date    = (d.get("date") or datetime.date.today().isoformat()).strip()
    root    = (d.get("root") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()).rstrip("/")

    if not (book and chapter and unit and anchor_in.strip() and body.strip()):
        die("book / chapter / unit / anchor / body 都不能为空。")

    # 规范化：chapter -> chNN，unit -> NN
    if not chapter.startswith("ch"):
        chapter = "ch" + chapter.zfill(2)
    if unit.endswith(".md"):
        unit = unit[:-3]

    chdir = os.path.join(root, "books", book, chapter)
    nn_md = os.path.join(chdir, unit + ".md")
    notes = os.path.join(chdir, unit + ".notes.md")

    if not os.path.isfile(nn_md):
        die(f"找不到单元原文：{nn_md}\n   （确认 book / chapter / unit 与 root 对不对）")

    text = open(nn_md, encoding="utf-8").read()

    anchor = clean(anchor_in).strip()
    if not anchor:
        die("anchor 剥掉标记后是空的。")
    if anchor not in clean(text):
        die("锚点在原文里找不到——「划线」必须是 NN.md 的精确子串\n"
            "   （标点、全/半角要逐字一致；只锚同一个自然段内的一截）。\n"
            f"   你给的锚点：{anchor}")

    # 拼 callout 块
    body_lines = "\n".join(("> " + ln) if ln else ">" for ln in body.split("\n"))
    block = (f"> [!note] 划线：{anchor}\n"
             f"{body_lines}\n"
             f"> · {author} {date}")

    if os.path.isfile(notes):
        cur = open(notes, encoding="utf-8").read()
        cur = re.sub(r'(?m)^updated:.*$', f'updated: {date}', cur, count=1)  # 刷新 frontmatter 日期
        cur = cur.rstrip("\n") + "\n"                                        # 收尾成恰好一个换行
        new = cur + "\n" + block + "\n"                                      # 块间留一空行
        action = "追加到"
    else:
        new = f"---\ntype: 批注旁车\nupdated: {date}\n---\n\n{block}\n"
        action = "新建并写入"

    open(notes, "w", encoding="utf-8").write(new)

    rel = os.path.relpath(notes, root)
    print(f"✓ 批注已{action} {rel}")
    print(f"  划线：{anchor}")

if __name__ == "__main__":
    main()
