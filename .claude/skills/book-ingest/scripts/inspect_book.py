#!/usr/bin/env python3
"""读一本书源文件的结构并打印 —— 不做任何切分。

用法:
    python inspect_book.py <book.epub|book.mobi|book.md|book.pdf>

输出:格式、元数据书名、结构取样、章节标记候选、切分思路提示。
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from source_lib import compact_text, load_with_info, plain

# 常见章节标记候选
MARKERS = {
    "Markdown 标题 (# / ##)":      r"^#{1,6}\s+\S+",
    "第N章 (第一章 / 第55章)": r"^第\S{1,8}章",
    "第N回":                  r"^第\S{1,8}回",
    "第N节":                  r"^第\S{1,8}节",
    "卷N":                    r"^卷\S{1,6}",
    "分第N (…分第三十二)":     r"\S{0,8}分第\S{1,4}",
    "Chapter N":              r"^Chapter\s+\d+",
    "罗马/数字标题 (1. / 一、)": r"^(\d{1,3}[.、]|[一二三四五六七八九十百]{1,4}[、.])",
}


def main():
    if len(sys.argv) < 2:
        sys.exit("用法: python inspect_book.py <book.epub|book.mobi|book.md|book.pdf>")
    path = sys.argv[1]
    title, docs, toc, info = load_with_info(path)
    fmt = info.get("format") or os.path.splitext(path)[1].lower().lstrip(".")

    print(f"文件:      {os.path.basename(path)}")
    print(f"格式:      {fmt}")
    print(f"元数据书名: {title or '<空 / 不可靠,需向用户确认>'}")
    if fmt in ("epub", "mobi"):
        print(f"spine 文档: {len(docs)} 个")
    elif fmt in ("markdown", "text"):
        label = "Markdown" if fmt == "markdown" else "文本"
        print(f"{label}行数:   {info.get('line_count', 0)}")
        if info.get("heading_counts"):
            pairs = [f"H{k}:{v}" for k, v in sorted(info["heading_counts"].items())]
            print(f"标题层级:   {'  '.join(pairs)}")
    elif fmt == "pdf":
        print(f"PDF 页数:   {info.get('page_count', 0)}")
        print(f"有文字页:   {info.get('text_pages', 0)}")
        print(f"抽取字数:   {info.get('text_chars', 0)}")
        if info.get("scanned"):
            print("\n结论:疑似扫描型/图片型 PDF,当前 book-ingest 暂不支持。")
            print("处理:停止入库,告知用户需先 OCR 或换文字版 PDF/epub/md。")
            return
    print(f"TOC 条目:   {len(toc)} 条")

    if toc:
        print("\n--- TOC（最多前 40 条）---")
        for label, doc, anchor in toc[:40]:
            tail = f"#{anchor}" if anchor else ""
            print(f"  {label[:36]:38s} -> {doc}{tail}")
        anchored = sum(1 for _, _, a in toc if a)
        print(f"  ……带锚点(#…)的条目: {anchored}/{len(toc)}")

    single_text_source = len(docs) == 1 or fmt in ("markdown", "pdf")
    if single_text_source:
        lines = []
        for _, doc in docs:
            lines.extend(plain(doc))
        print(f"\n--- 正文 {len(lines)} 行 / {len(compact_text(''.join(lines)))} 字,前 18 行 ---")
        for ln in lines[:18]:
            print("   ", ln[:64])
        print("\n--- 章节标记候选(在正文里的命中行数)---")
        hit_any = False
        for name, pat in MARKERS.items():
            n = sum(1 for ln in lines if re.search(pat, ln))
            if n:
                hit_any = True
                print(f"   命中 {n:4d} 行  「{name}」  pattern = {pat}")
        if not hit_any:
            print("   (没命中常见标记 —— 可能要靠空行/特殊符号/人工判断切)")
    else:
        print(f"\n--- 多文档,每个 spine 文档首行(最多前 30 个）---")
        for did, html in docs[:30]:
            ls = plain(html)
            print(f"   [{did[:30]:32s}] {ls[0][:44] if ls else '<空>'}")

    print("\n--- 切分思路提示（仅供参考,最终你判断）---")
    if fmt == "markdown":
        print("   · Markdown:优先按稳定标题层级切,常见是 H1=书名、H2=章。")
        print("   · 若标题层级混乱,改用正文里的「第N章」等标记切。")
    elif fmt == "text":
        print("   · TXT/纯文本:优先寻找目录、作品分界、章名序列,再按稳定章节标记切。")
        print("   · 若同一文件混入多部作品/导读/附录,先判断深读主体;非主体用声明性排除校验。")
    elif fmt == "pdf":
        if toc:
            print("   · 文字型 PDF + TOC/书签:优先按 TOC 页码范围切,再检查正文是否错页。")
        print("   · 文字型 PDF:无可靠 TOC 时再按正文里的章节标记切,不要默认一页一章。")
        print("   · 注意页眉页脚、页码、断行、脚注错位;后续必须跑 verify_chapters.py。")
    if fmt in ("epub", "mobi") and len(docs) > 1:
        print("   · 多文档:多半「一个文档 = 一章」,用 docs 顺序切;TOC 给每章标题。")
    if fmt in ("epub", "mobi") and toc and sum(1 for _, _, a in toc if a) >= 2 and len(docs) == 1:
        print("   · 单文档 + TOC 带锚点:按 <a id=\"锚点\"> 在 HTML 里的位置切(如金刚经)。")
    if fmt in ("epub", "mobi") and len(docs) == 1:
        print("   · 单文档 + 正文有规律标记:按上面命中的 pattern 用正则切(如道德经)。")
    print("   · 都不干净:可能要人工列章节边界,或混合策略。别硬套。")


if __name__ == "__main__":
    main()
