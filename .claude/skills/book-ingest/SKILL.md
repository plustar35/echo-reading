---
name: book-ingest
description: >-
  把用户提供的电子书(epub / mobi / azw3)提取并按章切分,在 echo-reading 项目里生成
  books/<书名>/chNN/raw.md(**只灌纯原文**)和 progress.md,并把源文件留档进 books/<书名>/。
  当用户给出一个电子书文件、给出电子书的下载链接(如 GitHub blob/raw 链接)、或说「导入这本书 /
  加一本书 / 把这本书切好 / 读这本新书 / 这个 epub(mobi) 能不能拆成章」时,务必使用本 skill。
  属于 echo-reading 项目的入库环节,入库只到原文就位为止。
---

# book-ingest — 电子书提取并切分入库

把一个电子书文件变成 `books/<书名>/` 下一章一个目录 `chNN/`,原文落进 `chNN/raw.md`,
**只灌纯原文**(H1 标题 + 正文),供 echo-reading 逐段深读。本 skill 的职责到原文就位为止
——9 段笔记骨架由 `chapter-split` 在用户读该章时铺进同一个 `chNN/`(短章 `01.md`;长章
`00-导读.md` + `01.md…`)。`raw.md` 是这章的源头底本,split 只读它、不改它。

## 最重要的一条:切分策略不写死

不同书结构天差地别——有的整本塞在一个 HTML 里靠 `第N章` 文本标记,有的是规范 TOC 带锚点,有的一章一个 xhtml 文件,有的脏得要人工定边界。**没有一套正则能通吃**,所以本 skill 不提供"万能切分器"。流程是:

```
inspect 看结构  →  你当场判断这本怎么切  →  写一个【针对这本书】的一次性脚本  →
dry-run 抽查质检  →  确认无误再正式写 chNN/raw.md + progress.md
```

固化下来的只有**两头确定性的脏活**:读结构(`inspect_book.py`)、写骨架(`write_chapters.py`)。中间"怎么切"是判断,每本书写新的一次性脚本——别想着复用上一本的。

## 依赖

需要一个装了这些包的 python3:`EbookLib`、`beautifulsoup4`(epub)、`mobi`(mobi/azw)。缺了 `ebook_lib.py` 会直接报安装命令。装:

```bash
pip install EbookLib beautifulsoup4 mobi
```

下面命令里的 `python3` 请用装好上述包的那个解释器(本机是 `/opt/miniconda3/bin/python3`)。脚本文件名 `inspect_book.py`(**不叫 inspect.py**,否则会盖掉标准库 `inspect`,导致 lxml / loguru 连环报错)。

## 工作流

记 `SKILL` 为本 skill 目录,`ROOT` 为 echo-reading 项目根。

### 第 0 步 · 拿到本地文件(用户给的是链接时)

- 用户**直接给文件**:记下它的路径,直接进第 1 步。
- 用户**给的是下载链接**(常见 GitHub):先下到临时目录再处理。 GitHub 的 `blob` 页面链接不是文件本体,要转成 raw 才能下:
  - `https://github.com/<u>/<repo>/blob/<branch>/<path>` → 把 `/blob/` 换成 `/raw/`
  - 路径里的中文/特殊字符已是 %XX 转义的,保持原样即可
  ```bash
  curl -sL -o /tmp/<原文件名> "<raw 链接>"
  file /tmp/<原文件名>   # 确认确实是 EPUB / Mobipocket,别下成了 HTML 页面
  ```

源文件会在第 5 步用 `--save-source` 留档进 `books/<书名>/`,所以无论文件还是链接,最终都让源文件落到 `books/<书名>/` 里,方便溯源和日后重切。

### 第 1 步 · 看结构

```bash
python3 SKILL/scripts/inspect_book.py <电子书文件>
```

报告会给你:格式、元数据书名(常不可靠)、spine 文档数、TOC(含每条是否带 `#锚点`)、单文档时的正文取样 + 章节标记候选(各 pattern 命中行数)、几句切分思路提示。

**读这份报告,判断属于哪种结构**:
- spine 文档 = 1 且正文有规律标记命中很多行 → 文本正则切(范例 A)
- spine 文档 = 1 且 TOC 多数带锚点 → 按锚点位置切(范例 B)
- spine 文档 > 1 → 一文档一章,按顺序切(范例 C)
- 都不干净 → 看范例文末"都不干净怎么办",必要时把报告端给用户一起定

### 第 2 步 · 定书名,问深读单元

- **书名**别信元数据(常是哈希乱码)。从正文/TOC 认,或直接问用户。书名 = `books/` 下的目录名。
- **切分单元是内容判断,不只是机械活**。机械层能把文件切成它自带的结构段,但"按什么读"有时要问用户。典型:一部经书平铺了好几个版本/译本 + 前言 + 版权,这些不是好的深读单元。这种情况先问用户「按哪个版本、什么粒度读」,再决定切什么——别默默把"版权信息"也切成一章。

### 第 3 步 · 写一次性切分脚本

读 `SKILL/references/split-examples.md`,挑最接近的范例改成**这本书专用**的脚本。脚本只干一件事:`load()` 出文档 → 按你定的逻辑切 → 输出 `[{"title","body"}, ...]` 的 JSON 到 stdout。`title` 是这章人类可读标题,`body` 是纯原文。

注音处理:像道德经那样正文夹 `观其徼(jiao:四声)` 的拼音注音,**默认原样保留** (对照着读方便)。用户要剥离才剥离。

### 第 4 步 · dry-run 抽查

先只跑切分脚本看 JSON,别急着写文件。抽查:
- 章数对不对(对照 inspect 报告里的命中数 / TOC 条数)
- 首章、尾章、和任何异常处(如编号断裂的那章)的 title 和 body 首句对不对
- body 里有没有漏进标签碎片(如 `id="filepos…" />`)、页眉页脚、目录残留

有问题改脚本重切。**这一步是质量闸,别跳。**

### 第 5 步 · 写原文

确认无误,管道喂给写入器:

```bash
python3 SKILL/scripts/split_this_book.py \
  | python3 SKILL/scripts/write_chapters.py \
      --book <书名> --root ROOT \
      --base "<底本说明>" --save-source <源文件路径>
```

(一次性脚本放哪都行,`/tmp` 也可;上面只是示意管道。)

`write_chapters.py` 会:
- 在 `ROOT/books/<书名>/` 下为每章建目录 `ch01/ … chNN/`(章号按总章数补零),原文写进 `chNN/raw.md`
- 每个 `raw.md` = **纯原文**(H1 标题 + 正文),不铺 9 段结构
- 写 `progress.md`(全部未读的 checklist + 底本说明)
- `--save-source <源文件路径>` 会把源 epub/mobi 拷进 `books/<书名>/` 留档,并把它的文件名记进 progress.md 的来源行(省去再写 `--source`)
- **默认不覆盖已存在的 chNN/raw.md**(保护已读/已切分的章节);要重灌加 `--force`

### 第 6 步 · 回报

简短告诉用户:书名、共几章、写到哪、**原文已就位**、可以开始读第几章了。之后用户说「读第 N 章」,由 `chapter-split` 接手(见项目 CLAUDE.md)。
