# 一次性切分脚本范例

这里是两个**真实验证过**的一次性切分脚本,对应两种最常见的结构。
它们是**起点不是模板**——每本书先 `inspect_book.py` 看清结构,再照着最接近的那个改。
切分脚本唯一的产出:一个 `[{"title","body"}, ...]` 的 JSON,打到 stdout,
管道喂给 `write_chapters.py`。解包和写骨架都不在切分脚本里。

公共开头(让一次性脚本能 import 归一化层):

```python
import sys, re, json
sys.path.insert(0, "<skill>/scripts")   # 换成本 skill 的 scripts 绝对路径
from ebook_lib import load, plain
```

---

## 范例 A:单文档 + 正文规律文本标记 → 正则切(道德经 epub)

结构特征:`inspect_book.py` 显示 **spine 文档 = 1**、**TOC 无锚点/无用**、
正文里某个 pattern 命中 N 行(如 `^第\S{1,8}章` 命中 81 行)。
注意 `\S` 同时吃中文数字和阿拉伯数字——道德经第 55 章正文写成「第55章」,
纯 `[一-龥]` 的正则会漏掉它。

```python
import sys, re, json
sys.path.insert(0, "<skill>/scripts")
from ebook_lib import load, plain

_, docs, _ = load("/path/to/book.epub")
lines = plain(docs[0][1])

HEAD = re.compile(r'^第\S{1,8}章')          # ← 用 inspect 报告里命中的那个 pattern
chapters, title, body = [], None, []
for ln in lines:
    if HEAD.match(ln):
        if title is not None:
            chapters.append({"title": title, "body": "\n\n".join(body).strip()})
        title = re.sub(r'[：:\s]+$', '', ln)  # 去掉标题行尾的「：」
        body = []
    elif title is not None:
        body.append(ln)
if title is not None:
    chapters.append({"title": title, "body": "\n\n".join(body).strip()})

print(json.dumps(chapters, ensure_ascii=False))
```

---

## 范例 B:单文档 + TOC 带锚点 → 按锚点位置切(金刚经 mobi)

结构特征:`inspect_book.py` 显示 **spine 文档 = 1**、**TOC 多数条目带 `#锚点`**。
做法:在 HTML 里定位每个锚点 `<a id="锚点"/>` 的位置,相邻两个之间就是一章。

**踩过的坑**:必须从 `<a` 标签的**起始 `<`** 切、从标签**结束 `>`** 之后取正文。
若从 `id="..."` 属性中间切,半个标签会漏成正文(出现 `id="filepos37130" />`)。

```python
import sys, re, json
sys.path.insert(0, "<skill>/scripts")
from ebook_lib import load, plain

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
    lines = plain(html[tagend:end])              # 从标签结束之后取正文
    if lines and lines[0].strip().strip("《》") in label:
        lines = lines[1:]                        # 丢掉与标题重复的首行
    chapters.append({"title": label, "body": "\n\n".join(lines).strip()})

print(json.dumps(chapters, ensure_ascii=False))
```

---

## 范例 C:多文档(一文档一章)→ 按 spine 顺序切

结构特征:`inspect_book.py` 显示 **spine 文档 > 1**(规范 epub 常见,一章一 xhtml)。
做法:每个文档就是一章;标题优先从 TOC 里取(TOC 的 doc 字段对上文档名)。

```python
import sys, json, os
sys.path.insert(0, "<skill>/scripts")
from ebook_lib import load, plain

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

## 都不干净怎么办

- 标记不规律、TOC 缺失、正文混了页眉页脚 → 别硬套上面三种。
- 可以先 `plain()` 出全文,人工(你+用户)定几个章节边界的特征行,按特征切。
- 实在不行,把 inspect 报告端给用户,一起决定单元怎么分——切分单元是内容判断,不只是机械活。
