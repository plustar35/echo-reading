#!/usr/bin/env python3
"""读出某章的【原文】，按自然段编号列出 + 报字数，给落缝判断当底图。

切在哪是读懂之后的判断，本脚本不替你切（见 references/segmentation-principle.md）。
原文取自 chNN/raw.md：H1 标题后直接是纯原文。

用法:
    python3 extract_source.py books/理想国/ch01/raw.md
"""
import re
import signal
import sys

# 被 head / less 截断管道时安静退出，不喷 BrokenPipeError
try:
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
except (AttributeError, ValueError):
    pass


def extract_body(text):
    """从 raw.md 取出 (chapter_title, body)：第一个 H1 是标题，其后全是纯原文。"""
    lines = text.splitlines()
    title = ""
    h1 = -1
    for i, ln in enumerate(lines):
        m = re.match(r"^#\s+(.*)", ln)
        if m:
            title = m.group(1).strip()
            h1 = i
            break
    body = "\n".join(lines[h1 + 1:]).strip()
    return title, body


def paragraphs(body):
    return [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]


def main():
    if len(sys.argv) != 2:
        sys.exit("用法: python3 extract_source.py <chNN/raw.md>")
    text = open(sys.argv[1], encoding="utf-8").read()
    title, body = extract_body(text)
    paras = paragraphs(body)
    total = len(body.replace("\n", "").replace(" ", ""))

    print(f"章标题: {title}")
    print(f"原文: {len(paras)} 个自然段, 约 {total} 字")
    print("=" * 60)
    for i, p in enumerate(paras):
        head = p[:40].replace("\n", " ")
        print(f"[{i:>3}] {len(p.replace(chr(10),'')):>4}字 | {head}{'…' if len(p) > 40 else ''}")
    print("=" * 60)
    print("提示: 落缝锚点用某段开头原句（前 15-25 字足够唯一），喂给 write_units.py。")


if __name__ == "__main__":
    main()
