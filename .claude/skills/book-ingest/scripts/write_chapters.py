#!/usr/bin/env python3
"""把切好的章节写成 books/<书名>/chNN/raw.md（纯原文）+ progress.md。

**只输出纯原文**(H1 标题 + 正文)。

输入(stdin 或 --in 文件)是一个 JSON 数组:
    [
      {"title": "第一章", "body": "道可道，非常道……"},
      {"title": "第二章", "body": "天下皆知美之为美……"}
    ]
title 是这一章的人类可读标题(进度表和 H1 用);body 是纯原文。

用法:
    cat chapters.json | python write_chapters.py --book 道德经 --root /path/to/echo-reading --base "通行本(王弼本)"
    python write_chapters.py --book 道德经 --root . --in chapters.json [--force]

默认**不覆盖**已存在的 chNN/raw.md(保护已读/已切分的章节)。要重灌加 --force。
"""
import argparse
import json
import os
import shutil
import sys

# 只吐纯原文(H1 标题 + 正文)
CHAPTER_TEMPLATE = """# {heading}

{body}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--book", required=True, help="书名(= books/ 下的目录名)")
    ap.add_argument("--root", required=True, help="项目根目录(echo-reading)")
    ap.add_argument("--base", default="", help="底本说明,写进 progress.md")
    ap.add_argument("--source", default="", help="来源文件名,写进 progress.md")
    ap.add_argument("--save-source", dest="save_source", default="",
                    help="把这个源文件(epub/mobi,或下载到临时目录的文件)拷进 books/<书名>/ 留档")
    ap.add_argument("--in", dest="infile", default="", help="章节 JSON 文件;省略则读 stdin")
    ap.add_argument("--force", action="store_true", help="覆盖已存在的 chNN/raw.md")
    args = ap.parse_args()

    raw = open(args.infile, encoding="utf-8").read() if args.infile else sys.stdin.read()
    chapters = json.loads(raw)
    if not isinstance(chapters, list) or not chapters:
        sys.exit("章节 JSON 必须是非空数组,每项含 title / body")

    bookdir = os.path.join(args.root, "books", args.book)
    os.makedirs(bookdir, exist_ok=True)

    # 把源文件留档到 books/<书名>/,方便溯源 / 日后重切
    saved_source = ""
    if args.save_source:
        if not os.path.isfile(args.save_source):
            sys.exit(f"--save-source 指向的文件不存在:{args.save_source}")
        saved_source = os.path.basename(args.save_source)
        dest = os.path.join(bookdir, saved_source)
        if os.path.abspath(args.save_source) != os.path.abspath(dest):
            shutil.copy2(args.save_source, dest)
        if not args.source:
            args.source = saved_source

    n = len(chapters)
    pad = max(2, len(str(n)))

    written, skipped = 0, 0
    prog = [f"# 《{args.book}》阅读进度", ""]
    base_line = args.base or "(底本待补)"
    src = f" · 来源 {args.source}" if args.source else ""
    prog.append(f"底本:{base_line}（共 {n} 章,自动提取{src}）")
    prog.append("")

    for i, ch in enumerate(chapters, 1):
        cid = f"ch{i:0{pad}d}"
        title = (ch.get("title") or cid).strip()
        body = (ch.get("body") or "").strip() or "<原文提取为空,请检查切分脚本>"
        # H1:title 已自带书名(含《》)时直接用,否则补「《书名》」前缀,避免书名翻倍
        heading = title if "《" in title else f"《{args.book}》{title}"
        chdir = os.path.join(bookdir, cid)
        os.makedirs(chdir, exist_ok=True)
        fn = os.path.join(chdir, "raw.md")
        if os.path.exists(fn) and not args.force:
            skipped += 1
        else:
            with open(fn, "w", encoding="utf-8") as fh:
                fh.write(CHAPTER_TEMPLATE.format(heading=heading, body=body))
            written += 1
        prog.append(f"- [ ] {cid} — {title}")

    pf = os.path.join(bookdir, "progress.md")
    if not os.path.exists(pf) or args.force:
        with open(pf, "w", encoding="utf-8") as fh:
            fh.write("\n".join(prog) + "\n")

    print(f"目录: {bookdir}")
    print(f"章节: {n}  新写 {written}  跳过(已存在) {skipped}")
    print(f"进度: {pf}")
    if saved_source:
        print(f"源文件: {os.path.join(bookdir, saved_source)}")


if __name__ == "__main__":
    main()
