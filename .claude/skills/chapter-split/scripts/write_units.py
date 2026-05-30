#!/usr/bin/env python3
"""按 spec 里定好的落缝，把一章原文切成阅读单元骨架 + 导读 + 改 progress.md，并回装校验。

落缝（切在哪、各单元叫什么、导读写什么）由 stdin 的 spec 带进来；本脚本只做
机械搬运 + 自检，不改写原文一个字。

切分由【锚点原句】定，不是行号（行号一改就失效）。每个单元给它开头那一段的
原句前缀，脚本在原文里定位、按锚点区间切片，最后把所有切片拼回跟原文逐字比对
——零差异才算成功。

spec（stdin JSON）:
{
  "chapter_title": "第一卷",
  "intro_md": "## 场景\\n……\\n## 人物\\n……",   # 导读正文(H1 和来源行脚本自动加)
  "units": [
    {"title": "序场·港口与“被留下”", "start_anchor": "［苏格拉底：昨天，我跟阿里斯同"},
    {"title": "老年、财富与正义的引子", "start_anchor": "［于是，我们去了玻勒马霍斯家"},
    ...
  ]
}
units 必须按原文出现顺序排列；第 1 个单元的锚点应落在原文最开头那一段。
单元一律写进 books/<书>/chNN/ 目录（原文 raw.md 就在里面）：
  单元数 == 1（短章）：只写 chNN/01.md，不建导读。
  单元数 > 1（长章）：写 chNN/00-导读.md + 01.md … NN.md。

原文从 chNN/raw.md 取。

用法:
    cat spec.json | python3 write_units.py --book 理想国 --chapter ch01 --root . [--force]
"""
import argparse
import json
import os
import re
import sys

# 复用 extract_source 的取原文逻辑
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract_source import extract_body, paragraphs  # noqa: E402


def unit_skeleton(book, chapter_title, n, total, title, body, is_first):
    if total == 1:
        conn = "## 五、与前章的连接"
        head = title if "《" in title else f"《{book}》{chapter_title}"
        src = f"> 来自 [[{book}/CHID/raw|《{book}》{chapter_title}]] · 整章一个阅读单元"
    else:
        conn = ("## 五、与前章的连接（本单元为本章卷首）" if is_first
                else "## 五、与上一单元的连接")
        head = f"《{book}》{chapter_title} · 单元{n}：{title}"
        src = f"> 来自 [[{book}/CHID/raw|《{book}》{chapter_title}]] · 阅读单元 {n}/{total}"
    return f"""# {head}

{src}

## 一、原文

{body}

## 二、字词注

<!-- 待生成:关键字逐个解 -->

## 三、白话直译

<!-- 待生成:尽量贴字面 -->

## 四、注家对照

<!-- 待生成:至少三家观点对比 -->

{conn}

<!-- 待生成 -->

## 六、三个值得停下来想一想的问题

<!-- 待生成 -->

## 七、与生活的关联

<!-- 待生成:把抽象拉回经验 -->

## 八、你的理解 / 疑问

<!-- 留白给你 -->

## 九、回看批注

<!-- 留白,读完后续单元后回头补 -->
"""


def normalize(s):
    return re.sub(r"\s+", "", s)


def locate_anchors(paras, units):
    """把每个单元的 start_anchor 定位到自然段下标，返回 [(idx, unit), ...]。"""
    located = []
    for u in units:
        anchor = normalize(u["start_anchor"])
        hits = [i for i, p in enumerate(paras) if normalize(p).startswith(anchor)]
        if not hits:
            # 放宽：锚点出现在段开头附近
            hits = [i for i, p in enumerate(paras) if normalize(p)[:60].find(anchor) == 0]
        if not hits:
            sys.exit(f"✗ 锚点定位失败，原文里没有以此开头的段：{u['start_anchor']!r}\n"
                     f"  （用 extract_source.py 看一眼真实段首）")
        if len(hits) > 1:
            sys.exit(f"✗ 锚点不唯一（命中段 {hits}）：{u['start_anchor']!r}\n  请加长锚点。")
        located.append((hits[0], u))
    idxs = [i for i, _ in located]
    if idxs != sorted(idxs):
        sys.exit(f"✗ 锚点未按原文顺序排列：段下标 {idxs}。units 要按出现顺序写。")
    if idxs[0] != 0:
        print(f"⚠ 第 1 个单元锚点不在原文最开头（落在第 {idxs[0]} 段）——"
              f"前面 {idxs[0]} 段会被漏掉。确认这是你要的。", file=sys.stderr)
    return located


def default_source(bookdir, chid):
    """这章的原文：chNN/raw.md。"""
    return os.path.join(bookdir, chid, "raw.md")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--book", required=True)
    ap.add_argument("--chapter", required=True, help="如 ch01")
    ap.add_argument("--root", required=True)
    ap.add_argument("--source", default="", help="原文路径；省略则取 books/书/chNN/raw.md")
    ap.add_argument("--force", action="store_true", help="覆盖已存在的单元文件")
    args = ap.parse_args()

    spec = json.loads(sys.stdin.read())
    units = spec["units"]
    chapter_title = spec.get("chapter_title", args.chapter)
    intro_md = spec.get("intro_md", "").strip()

    bookdir = os.path.join(args.root, "books", args.book)
    source = args.source or default_source(bookdir, args.chapter)
    if not os.path.isfile(source):
        sys.exit(f"✗ 找不到原文文件：{source}")
    _, body = extract_body(open(source, encoding="utf-8").read())
    paras = paragraphs(body)

    located = locate_anchors(paras, units)
    idxs = [i for i, _ in located]
    bounds = idxs + [len(paras)]
    total = len(units)

    # 切片
    slices = []
    for k, (start, u) in enumerate(located):
        end = bounds[k + 1]
        seg = "\n\n".join(paras[start:end])
        slices.append((u, seg))

    chid = args.chapter
    unitdir = os.path.join(bookdir, chid)
    os.makedirs(unitdir, exist_ok=True)

    def finalize(tpl):
        return tpl.replace("CHID", chid)

    written = []
    if total == 1:
        # 短章：单单元，写 chNN/01.md（不建导读）
        u, seg = slices[0]
        out = os.path.join(unitdir, "01.md")
        if os.path.exists(out) and not args.force:
            sys.exit(f"✗ {out} 已存在；要重灌加 --force")
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(finalize(unit_skeleton(args.book, chapter_title, 1, 1,
                                            u["title"], seg, True)))
        written.append(out)
    else:
        # 导读
        intro_path = os.path.join(unitdir, "00-导读.md")
        toc = "\n".join(f"{i+1}. {u['title']}" for i, (u, _) in enumerate(slices))
        intro_full = (f"# 《{args.book}》{chapter_title} · 导读\n\n"
                      f"> 来自 [[{args.book}/{chid}/raw|《{args.book}》{chapter_title}]] · 卷层面的入口，读各单元前先看这里\n\n"
                      f"{intro_md}\n\n## 本章分成 {total} 个阅读单元\n\n{toc}\n")
        with open(intro_path, "w", encoding="utf-8") as fh:
            fh.write(intro_full)
        written.append(intro_path)
        pad = max(2, len(str(total)))
        for k, (u, seg) in enumerate(slices, 1):
            out = os.path.join(unitdir, f"{k:0{pad}d}.md")
            if os.path.exists(out) and not args.force:
                sys.exit(f"✗ {out} 已存在；要重灌加 --force")
            with open(out, "w", encoding="utf-8") as fh:
                fh.write(finalize(unit_skeleton(args.book, chapter_title, k, total,
                                                u["title"], seg, k == 1)))
            written.append(out)

    # 回装校验：拼回的原文必须跟原章逐字一致
    reassembled = normalize("".join(seg for _, seg in slices))
    if total > 1:
        original = normalize("".join(paras[idxs[0]:]))
    else:
        original = normalize("".join(paras))
    ok = reassembled == original
    update_progress(bookdir, chid, chapter_title, slices, total)

    print(f"章: {args.book} / {chid}（{chapter_title}）  单元 {total}")
    for k, (u, seg) in enumerate(slices, 1):
        c = len(normalize(seg))
        print(f"  {k:>2}. {u['title']}  —  {c} 字")
    print(f"写出 {len(written)} 个文件，在 {chid}/")
    print("回装校验: " + ("✓ 零差异，原文完整无损" if ok else "✗ 差异！原文有丢/重/串，别用，检查锚点"))
    if not ok:
        sys.exit(1)


def update_progress(bookdir, chid, chapter_title, slices, total):
    pf = os.path.join(bookdir, "progress.md")
    if not os.path.isfile(pf):
        return
    lines = open(pf, encoding="utf-8").read().splitlines()
    out, i = [], 0
    pat = re.compile(rf"^- \[[ x]\]\s*{re.escape(chid)}\s*—")
    while i < len(lines):
        ln = lines[i]
        if pat.match(ln):
            if total == 1:
                out.append(ln)  # 短章不展开
            else:
                base = ln.split("—", 1)
                title = base[1].strip() if len(base) > 1 else chapter_title
                # 去掉旧后缀，避免重跑时重复追加
                title = re.sub(r"（已切成.*?个阅读单元，见.*?/）", "", title).strip()
                out.append(f"- [ ] {chid} — {title}（已切成 {total} 个阅读单元，见 {chid}/）")
                pad = max(2, len(str(total)))
                for k, (u, _) in enumerate(slices, 1):
                    out.append(f"  - [ ] {k:0{pad}d} {u['title']}")
            i += 1
            # 吃掉紧跟的旧两层子项（重跑幂等）
            while i < len(lines) and re.match(r"^\s+- \[[ x]\]", lines[i]):
                i += 1
            continue
        out.append(ln)
        i += 1
    with open(pf, "w", encoding="utf-8") as fh:
        fh.write("\n".join(out) + "\n")


if __name__ == "__main__":
    main()
