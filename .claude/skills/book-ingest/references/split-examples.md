# 一次性切分脚本范例

这里的脚本是起点,不是通用模板。每本书都先跑 `inspect_book.py`,再按结构改出这本书专用脚本。
切分脚本唯一产出是 `[{"title","body"}, ...]` JSON,写到 stdout。一次性脚本和中间产物放在
`SKILL.md` 规定的 `$WORK` 临时目录里,不要放进 `SKILL/scripts/`。

公共开头:

```python
import sys, re, json, os
sys.path.insert(0, "<skill>/scripts")
from source_lib import load, plain, source_text
```

生成后必须跑:

```bash
python3 "$WORK/split_this_book.py" > "$WORK/chapters.json"
python3 <skill>/scripts/verify_chapters.py /path/to/book --chapters "$WORK/chapters.json"
```

校验不通过就修正切分脚本或登记声明性排除项后重跑。成功导入并保存源文件后,按 `SKILL.md`
删除整个 `$WORK`。

---

## 范例 A:单文档 + 正文规律标记

适用:epub/mobi/Markdown/PDF 抽出的全文里有稳定章节行,如 `第一章`、`第55章`。

```python
import sys, re, json
sys.path.insert(0, "<skill>/scripts")
from source_lib import load, plain

_, docs, _ = load("/path/to/book.epub")
lines = []
for _, doc in docs:
    lines.extend(plain(doc))

HEAD = re.compile(r"^第\S{1,8}章")
chapters, title, body = [], None, []
for ln in lines:
    if HEAD.match(ln):
        if title is not None:
            chapters.append({"title": title, "body": "\n\n".join(body).strip()})
        title = re.sub(r"[：:\s]+$", "", ln)
        body = []
    elif title is not None:
        body.append(ln)

if title is not None:
    chapters.append({"title": title, "body": "\n\n".join(body).strip()})

print(json.dumps(chapters, ensure_ascii=False))
```

---

## 范例 B:单文档 + TOC 带锚点

适用:单 HTML 文档,TOC 多数条目带 `#锚点`。必须从标签结束后取正文,避免半个 HTML 标签漏进正文。

```python
import sys, re, json
sys.path.insert(0, "<skill>/scripts")
from source_lib import load, plain

_, docs, toc = load("/path/to/book.mobi")
html = docs[0][1]

pts = []
for label, doc, anchor in toc:
    if not anchor:
        continue
    m = re.search(r'<[^>]*id="%s"[^>]*>' % re.escape(anchor), html)
    if m:
        pts.append((m.start(), m.end(), label))
pts.sort()

chapters = []
for i, (start, tagend, label) in enumerate(pts):
    end = pts[i + 1][0] if i + 1 < len(pts) else len(html)
    lines = plain(html[tagend:end])
    if lines and lines[0].strip().strip("《》") in label:
        lines = lines[1:]
    chapters.append({"title": label, "body": "\n\n".join(lines).strip()})

print(json.dumps(chapters, ensure_ascii=False))
```

---

## 范例 C:多文档 epub/mobi

适用:规范 epub 常见,spine 多文档且基本一章一个 xhtml。

```python
import sys, json, os
sys.path.insert(0, "<skill>/scripts")
from source_lib import load, plain

_, docs, toc = load("/path/to/book.epub")
doc2title = {}
for label, doc, anchor in toc:
    doc2title.setdefault(doc, label)
    doc2title.setdefault(os.path.basename(doc), label)

chapters = []
for did, html in docs:
    title = doc2title.get(did) or doc2title.get(os.path.basename(did)) or did
    chapters.append({"title": title, "body": "\n\n".join(plain(html)).strip()})

print(json.dumps(chapters, ensure_ascii=False))
```

---

## 范例 D:Markdown 按标题层级切

适用:H1 是书名,H2 是章。若 H1 也是章,把 `LEVEL = 1`。

```python
import sys, re, json
sys.path.insert(0, "<skill>/scripts")
from source_lib import source_text

text = source_text("/path/to/book.md")
LEVEL = 2
HEAD = re.compile(r"^#{%d}\s+(.+?)\s*$" % LEVEL)

chapters, title, body = [], None, []
for ln in text.splitlines():
    m = HEAD.match(ln)
    if m:
        if title is not None:
            chapters.append({"title": title, "body": "\n".join(body).strip()})
        title = m.group(1).strip()
        body = []
    elif title is not None:
        body.append(ln)

if title is not None:
    chapters.append({"title": title, "body": "\n".join(body).strip()})

print(json.dumps(chapters, ensure_ascii=False))
```

---

## 范例 E:文字型 PDF 按章节标记切

适用:PDF 已由 `inspect_book.py` 判定为文字型,没有可靠 TOC/书签,正文里有稳定章节标题。

```python
import sys, re, json
sys.path.insert(0, "<skill>/scripts")
from source_lib import source_text

text = source_text("/path/to/book.pdf")

# PDF 常见噪声:单独页码。不要过度清洗,清洗后必须 verify。
lines = []
for ln in text.splitlines():
    s = ln.strip()
    if re.fullmatch(r"\d{1,4}", s):
        continue
    lines.append(s)

HEAD = re.compile(r"^第\S{1,8}章")
chapters, title, body = [], None, []
for ln in lines:
    if HEAD.match(ln):
        if title is not None:
            chapters.append({"title": title, "body": "\n\n".join(body).strip()})
        title = ln
        body = []
    elif title is not None:
        body.append(ln)

if title is not None:
    chapters.append({"title": title, "body": "\n\n".join(body).strip()})

print(json.dumps(chapters, ensure_ascii=False))
```

---

## 范例 F:文字型 PDF 按 TOC/书签页码切

适用:PDF 已由 `inspect_book.py` 判定为文字型,TOC/书签有稳定页码范围。先用 TOC 标题和页码切,
再抽查每章开头是否落在正确正文页。PDF 页码和正文印刷页码可能不同,以 `inspect_book.py` 报告的
`page-00NN` 为准。

```python
import sys, json
sys.path.insert(0, "<skill>/scripts")
from source_lib import load, pdf_page_texts

_, docs, toc = load("/path/to/book.pdf")
page2text = pdf_page_texts("/path/to/book.pdf")

# 从 inspect 报告里选择深读主体的 TOC 条目,不要机械包含版权页/目录页/广告页。
selected = [
    ("第一章", "page-0012"),
    ("第二章", "page-0041"),
    ("第三章", "page-0055"),
]

chapters = []
for i, (title, start_page) in enumerate(selected):
    end_page = selected[i + 1][1] if i + 1 < len(selected) else None
    start = int(start_page.split("-")[1])
    end = int(end_page.split("-")[1]) if end_page else len(docs) + 1
    body = []
    for page_no in range(start, end):
        body.append(page2text.get(page_no, ""))
    chapters.append({"title": title, "body": "\n\n".join(body).strip()})

print(json.dumps(chapters, ensure_ascii=False))
```

---

## 都不干净怎么办

- 标记不规律、TOC 缺失、正文混了页眉页脚:agent 可以人工列章节边界或混合策略。
- 文件里有多个版本/译本/附录且无法判断用户要读哪部分:先问用户。
- 版权页、目录页、广告页、译者说明等不作为深读正文时,不要在脚本里偷偷丢掉;在 `verify_chapters.py` 命令里登记声明性排除项。
