#!/usr/bin/env python3
"""Verify that split chapters cover the source text.

The check is deliberately conservative:

- Extract source text through source_lib.source_text().
- Apply declared exclusions to the source text.
- Compact source and chapter text by removing whitespace.
- Slide windows over the source and require most windows to appear in chapters.

Use declared exclusions for non-reading material such as copyright pages,
tables of contents, ads, and translator notes. Do not silently drop content in
the split script just to make this pass.
"""
import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from source_lib import compact_text, source_text


DEFAULT_THRESHOLD = 0.99
WINDOW = 160
STEP = 120
MIN_WINDOW = 60


def load_chapters(path):
    raw = open(path, encoding="utf-8").read() if path else sys.stdin.read()
    chapters = json.loads(raw)
    if not isinstance(chapters, list) or not chapters:
        raise SystemExit("章节 JSON 必须是非空数组")
    return chapters


def exclude_between(text, start, end):
    a = text.find(start)
    if a < 0:
        raise SystemExit(f"--exclude-between 找不到起点:{start[:40]}")
    b = text.find(end, a + len(start))
    if b < 0:
        raise SystemExit(f"--exclude-between 找不到终点:{end[:40]}")
    return text[:a] + "\n" + text[b + len(end):]


def apply_exclusions(text, args):
    for literal in args.exclude_literal:
        if literal not in text:
            raise SystemExit(f"--exclude-literal 找不到文本:{literal[:40]}")
        text = text.replace(literal, "\n")

    for start, end in args.exclude_between:
        text = exclude_between(text, start, end)

    for pattern in args.exclude_regex:
        text, n = re.subn(pattern, "\n", text, flags=re.S)
        if n == 0:
            raise SystemExit(f"--exclude-regex 没有命中:{pattern}")

    if args.exclude_file:
        for ln in open(args.exclude_file, encoding="utf-8"):
            line = ln.strip()
            if not line or line.startswith("#"):
                continue
            text, n = re.subn(line, "\n", text, flags=re.S)
            if n == 0:
                raise SystemExit(f"--exclude-file 里的规则没有命中:{line}")
    return text


def chapter_text(chapter):
    title = (chapter.get("title") or "").strip()
    body = (chapter.get("body") or "").strip()
    return f"{title}\n{body}"


def chapter_problems(chapters):
    problems = []
    seen_titles = {}
    seen_bodies = {}
    for i, ch in enumerate(chapters, 1):
        title = (ch.get("title") or "").strip()
        body = (ch.get("body") or "").strip()
        body_compact = compact_text(body)
        if not title:
            problems.append(f"ch{i:02d}:标题为空")
        if not body_compact:
            problems.append(f"ch{i:02d}:正文为空")
        if title:
            if title in seen_titles:
                problems.append(f"ch{i:02d}:标题与 ch{seen_titles[title]:02d} 重复:{title}")
            seen_titles[title] = i
        if len(body_compact) >= 200:
            key = body_compact[:240]
            if key in seen_bodies:
                problems.append(f"ch{i:02d}:正文开头与 ch{seen_bodies[key]:02d} 重复")
            seen_bodies[key] = i
    return problems


def coverage(source_compact, chapters_compact):
    if not source_compact:
        return 0.0, []
    if source_compact in chapters_compact:
        return 1.0, []
    if len(source_compact) < MIN_WINDOW:
        return 0.0, [(0, source_compact)]

    total = 0
    covered = 0
    missing = []
    for start in range(0, len(source_compact), STEP):
        chunk = source_compact[start:start + WINDOW]
        if len(chunk) < MIN_WINDOW:
            continue
        total += len(chunk)
        if chunk in chapters_compact:
            covered += len(chunk)
        elif len(missing) < 12:
            missing.append((start, chunk))
    if total == 0:
        return 1.0, []
    return covered / total, missing


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source", help="原始书源文件")
    ap.add_argument("--chapters", default="", help="章节 JSON 文件;省略则读 stdin")
    ap.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD,
                    help=f"覆盖率阈值,默认 {DEFAULT_THRESHOLD}")
    ap.add_argument("--exclude-literal", action="append", default=[],
                    help="声明性排除一段完全匹配文本,可重复")
    ap.add_argument("--exclude-between", nargs=2, action="append", default=[],
                    metavar=("START", "END"), help="声明性排除 START 到 END 之间的文本,可重复")
    ap.add_argument("--exclude-regex", action="append", default=[],
                    help="声明性排除一个正则命中的文本,可重复")
    ap.add_argument("--exclude-file", default="",
                    help="声明性排除规则文件:一行一个正则,# 开头为注释")
    args = ap.parse_args()

    chapters = load_chapters(args.chapters)
    problems = chapter_problems(chapters)

    src = source_text(args.source)
    if not compact_text(src):
        print("校验失败:源文件没有可抽取文字;如果是 PDF,很可能是扫描型/图片型。")
        sys.exit(2)

    src = apply_exclusions(src, args)
    src_compact = compact_text(src)
    ch_compact = compact_text("\n\n".join(chapter_text(ch) for ch in chapters))

    cov, missing = coverage(src_compact, ch_compact)
    print(f"源文本字数(归一化): {len(src_compact)}")
    print(f"章节字数(归一化):   {len(ch_compact)}")
    print(f"章节数:             {len(chapters)}")
    print(f"覆盖率:             {cov:.4%}")

    if args.exclude_literal or args.exclude_between or args.exclude_regex or args.exclude_file:
        print("声明性排除:         已应用")

    if problems:
        print("\n--- 章节结构问题 ---")
        for p in problems[:20]:
            print("  -", p)

    if missing:
        print("\n--- 缺失片段样例(归一化后) ---")
        for pos, chunk in missing:
            print(f"  @{pos}: {chunk[:180]}")

    if problems or cov < args.threshold:
        print("\n校验失败:请修正切分脚本或登记合理排除项后重跑。")
        sys.exit(1)

    print("\n校验通过:可以进入 write_chapters.py。")


if __name__ == "__main__":
    main()
