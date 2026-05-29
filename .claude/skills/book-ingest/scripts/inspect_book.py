#!/usr/bin/env python3
"""读一本电子书的结构并打印 —— 不做任何切分。

用法:
    python inspect_book.py <book.epub|book.mobi>

输出:格式、元数据书名、spine 文档数、TOC、正文取样、章节标记候选。
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ebook_lib import load, plain

# 常见章节标记候选
MARKERS = {
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
        sys.exit("用法: python inspect_book.py <book.epub|book.mobi>")
    path = sys.argv[1]
    title, docs, toc = load(path)

    print(f"文件:      {os.path.basename(path)}")
    print(f"格式:      {os.path.splitext(path)[1].lower()}")
    print(f"元数据书名: {title or '<空 / 不可靠,需向用户确认>'}")
    print(f"spine 文档: {len(docs)} 个")
    print(f"TOC 条目:   {len(toc)} 条")

    if toc:
        print("\n--- TOC（最多前 40 条）---")
        anchored = 0
        for label, doc, anchor in toc[:40]:
            tail = f"#{anchor}" if anchor else ""
            print(f"  {label[:36]:38s} -> {doc}{tail}")
        anchored = sum(1 for _, _, a in toc if a)
        print(f"  ……带锚点(#…)的条目: {anchored}/{len(toc)}")

    if len(docs) == 1:
        lines = plain(docs[0][1])
        print(f"\n--- 单文档,正文 {len(lines)} 行,前 18 行 ---")
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
    if len(docs) > 1:
        print("   · 多文档:多半「一个文档 = 一章」,用 docs 顺序切;TOC 给每章标题。")
    if toc and sum(1 for _, _, a in toc if a) >= 2 and len(docs) == 1:
        print("   · 单文档 + TOC 带锚点:按 <a id=\"锚点\"> 在 HTML 里的位置切(如金刚经)。")
    if len(docs) == 1:
        print("   · 单文档 + 正文有规律标记:按上面命中的 pattern 用正则切(如道德经)。")
    print("   · 都不干净:可能要人工列章节边界,或混合策略。别硬套。")


if __name__ == "__main__":
    main()
