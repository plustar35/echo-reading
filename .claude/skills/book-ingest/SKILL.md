---
name: book-ingest
description: >-
  把用户提供的书源文件(epub / mobi / azw / azw3 / prc / md / markdown / 文字型 pdf)提取并按章切分,
  在 echo-reading 项目里生成 books/书名/chNN/raw.md(**只灌纯原文**)和 progress.md,并把源文件留档进
  books/书名/。当用户给出电子书文件、Markdown、文字型 PDF、下载链接,或说「导入这本书 / 加一本书 /
  把这本书切好 / 读这本新书 / 这个文件能不能拆成章」时,务必使用本 skill。PDF 必须先探测;扫描型/图片型
  PDF 暂不支持,需停止并告知用户。入库只到原文就位为止。
---

# book-ingest - 书源提取并切分入库

把一个书源文件变成 `books/<书名>/` 下一章一个目录 `chNN/`,原文落进 `chNN/raw.md`,
**只灌纯原文**(H1 标题 + 正文),供 echo-reading 逐段深读。本 skill 的职责到原文就位为止。
9 段笔记骨架由 `chapter-split` 在用户读该章时铺进同一个 `chNN/`。`raw.md` 是这章的源头底本,
split 只读它、不改它。

## 支持范围

- `epub`
- `mobi / azw / azw3 / prc`
- `md / markdown / txt`
- 文字型 `pdf`

PDF 必须先跑 `inspect_book.py`。如果报告显示疑似扫描型/图片型 PDF,停止入库,告诉用户当前暂不支持,
需要先 OCR 或换文字版 PDF/epub/md。

## 最重要的一条:切分策略不写死

不同书结构天差地别。没有一套正则能通吃,所以本 skill 不提供"万能切分器"。流程是:

```text
inspect 看结构 -> agent 判断切法 -> 写这本书专用的一次性切分脚本 ->
agent 自检 chapters.json -> verify_chapters.py 机器校验 ->
校验不通过就修正并重跑 -> 校验通过后正式写 chNN/raw.md + progress.md
```

固化下来的只有三段确定性工作:

- `scripts/inspect_book.py`:探测格式、结构、PDF 是否文字型。
- `scripts/verify_chapters.py`:校验切分结果是否覆盖源文本。
- `scripts/write_chapters.py`:写 `books/<书名>/chNN/raw.md` 和 `progress.md`。

中间"怎么切"仍然是判断。每本书写一个专用的一次性切分脚本,输出 `[{"title","body"}, ...]` JSON。

## 依赖

需要一个装好依赖的 python3:

```bash
pip install EbookLib beautifulsoup4 mobi pypdf
```

`EbookLib` 用于 epub,`mobi` 用于 mobi/azw,`pypdf` 用于文字型 PDF。Markdown 不需要额外依赖。
脚本文件名 `inspect_book.py` 不要改成 `inspect.py`,否则会盖掉标准库 `inspect`。

## 工作流

记 `SKILL` 为本 skill 目录,`ROOT` 为 echo-reading 项目根。

### 第 0 步:拿到本地文件

- 用户直接给文件:记下路径,直接进第 1 步。
- 用户给下载链接:先下到临时目录。GitHub `blob` 链接要转成 raw:
  `https://github.com/<u>/<repo>/blob/<branch>/<path>` -> `https://github.com/<u>/<repo>/raw/<branch>/<path>`。
- 下载后用 `file <path>` 确认不是 HTML 错页。
- 最终源文件必须通过 `--save-source` 留档进 `books/<书名>/`。

### 第 1 步:探测格式和结构

```bash
python3 SKILL/scripts/inspect_book.py <书源文件>
```

读报告后判断:

- epub/mobi 多 spine 文档:多半一文档一章,但仍要看 TOC 和正文。
- epub/mobi 单文档 + TOC 锚点:可按锚点位置切。
- epub/mobi 单文档 + 正文标记:可按 `第N章`、`Chapter N` 等正则切。
- Markdown:优先按稳定标题层级切,常见是 H1=书名、H2=章。
- TXT/纯文本:先找目录、作品分界、章名序列;如果混入多部作品/导读/附录,识别深读主体并声明性排除非主体内容。
- 文字型 PDF + TOC/书签:优先按 TOC 页码范围切,再检查正文是否错页。
- 文字型 PDF 无可靠 TOC:按正文里的章节标记切,不要默认一页一章;特别注意页眉页脚、页码、断行、脚注错位。
- 扫描型 PDF:停止,告知用户暂不支持。
- 都不干净:agent 可列章节边界或混合策略;只有无法判断版本/粒度时才问用户。

### 第 2 步:定书名、版本和深读粒度

- 书名别盲信元数据。从正文、封面、TOC 判断;无法可靠判断时问用户。
- 如果同一文件里有多个版本、译本、前言、附录、版权页、目录页、广告页、其他作品等,先判断哪些是深读正文。
- 无法从文本本身判断用户要读哪个版本/粒度时才问用户。
- 可排除非深读内容,但必须在 `verify_chapters.py` 命令里用声明性排除项登记,不能在切分脚本里静默吞掉。

### 第 3 步:写一次性切分脚本

读 `SKILL/references/split-examples.md`,挑最接近的范例改成这本书专用脚本。脚本只做一件事:

```text
load/source_text 出文本 -> 按这本书的结构切 -> 输出 [{"title","body"}, ...] JSON 到 stdout
```

优先从 `source_lib.py` 导入:

```python
import sys
sys.path.insert(0, "SKILL/scripts")
from source_lib import load, plain, source_text
```

旧脚本 `from ebook_lib import load, plain` 仍可用,但新脚本优先用 `source_lib`。

### 第 4 步:生成 chapters.json 并由 agent 自检

先把一次性脚本输出成 JSON,不要直接写入:

```bash
python3 /tmp/split_this_book.py > /tmp/chapters.json
```

agent 自行检查,不向用户停顿确认:

- 章节数是否合理。
- 首章、尾章、异常章节是否有标题和正文。
- 是否有空章节、目录残留、页眉页脚、HTML 标签碎片。
- 标题序号是否断裂或重复。
- PDF/Markdown 是否有明显断行、页码、脚注错位。

发现问题就改脚本重跑。只有版本/粒度无法判断时才问用户。

### 第 5 步:机器完整性校验,硬门槛

必须运行:

```bash
python3 SKILL/scripts/verify_chapters.py <书源文件> --chapters /tmp/chapters.json
```

校验不通过时,不得写入 `books/<书名>/`。agent 必须查看缺失/重复片段,判断原因:

- 切分脚本漏掉正文。
- 清洗过度。
- PDF 抽取导致断裂。
- 标题/正文顺序错乱。
- 缺失片段其实是版权页、目录页、广告页、译者说明等非深读内容。

如果是正文问题,修正切分脚本后重跑。如果是合理非深读内容,用声明性排除项后重跑:

```bash
python3 SKILL/scripts/verify_chapters.py <书源文件> --chapters /tmp/chapters.json \
  --exclude-regex "版权声明.*?版权所有" \
  --exclude-between "目录" "第一章"
```

允许的声明性排除:

- `--exclude-literal "<完整文本>"`
- `--exclude-between "<起点文本>" "<终点文本>"`
- `--exclude-regex "<正则>"`
- `--exclude-file <一行一个正则的文件>`

一直修正并重跑,直到 `verify_chapters.py` 通过。不得用降低阈值掩盖明显漏文;PDF 因抽取噪声需要调阈值时,
必须在回报里说明。

### 第 6 步:正式写原文

校验通过后再写:

```bash
python3 SKILL/scripts/write_chapters.py \
  --book <书名> --root ROOT \
  --base "<底本说明>" --save-source <源文件路径> \
  --in /tmp/chapters.json
```

`write_chapters.py` 会:

- 建 `ROOT/books/<书名>/ch01/ ... chNN/`。
- 写每章 `raw.md`:H1 标题 + 纯原文正文。
- 写 `progress.md`。
- 通过 `--save-source` 保存源文件。
- 遇到空正文会直接失败;不得写入占位原文。
- 默认不覆盖已存在的 `chNN/raw.md`;重灌才加 `--force`。

### 第 7 步:回报

简短告诉用户:

- 书名和格式。
- 共几章。
- 写入路径。
- 源文件留档路径。
- 校验结果和覆盖率。
- 声明排除了哪些非深读内容。
- 可以开始读第几章。
