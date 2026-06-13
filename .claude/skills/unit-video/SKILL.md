---
name: unit-video
description: >-
  把一个阅读单元的「备读」做成「领读视频 / 备读视频 / 讲解视频」：
  作者第一人称、课件式讲解、16:9 横屏。从 books/<书>/chNN/NN.md 出发，
  经「口播稿 → TTS 时间轴 → 分镜 atoms/steps → 渐进渲染」产出
  video/<书>/chNN/NN/领读视频.mp4。用户要求把某章、某单元或备读内容做成视频、
  重渲视频、检查视频流程时，使用本 skill。
---

# unit-video — 备读变成领读视频

本 skill 是给 agent 使用的制作协议。它把一个阅读单元的备读内容，转成一条可听可看的「领读视频」：作者 / 主讲人以第一人称对「你」讲，画面像一块动态课堂白板。视频不是把笔记搬上屏幕，而是用配音、字幕、经文高亮和渐进板书，帮助观看者跟上这一段的理解节奏。

记：

- `ROOT` = 项目根目录。
- `SKILL` = `ROOT/.claude/skills/unit-video`。
- `<unit>` = `books/<书>/chNN/NN.md`。
- `<out>` = `ROOT/video/<书>/chNN/NN/`。
- `<assets>` = `SKILL/assets/<书>/<素材id>/`。

## 核心不变量

1. **配音是主时钟**
   整条视频只有一根时间轴：`口播.tts.m4a`。字幕、经文高亮、板书 reveal、片头后的背景循环，都对齐这根时间轴。口播改了必须重跑 TTS；分镜校验会用指纹拦住「改稿但没重配音」。

2. **备读文件是事实源头**
   视频从 `books/<书>/chNN/NN.md` 第 1–7 段提炼。第 8 段「你的理解 / 疑问」和第 9 段「回看批注」不进入视频。视频产物可随时删除重生，不反写备读。

3. **素材套与单元产物解耦**
   画面素材与配置放在 `SKILL/assets/<书>/<素材id>/`；单元产物固定放在 `ROOT/video/<书>/chNN/NN/`。分镜通过 `assets:"<书>/<素材id>"` 记录使用哪套素材，旧单元可以按原素材重渲。

4. **分镜不是字幕复读**
   字幕已经逐字承载口播；白板内容必须是观看辅助层：关键词、结构提示、概念压缩、判断句。白板文字要比口播短、准、能帮助观看者抓住「这一小段正在讲什么」。

5. **先看整体叙事，再用 atom 绑定时间**
   `atom` 是脚本生成的全局口播锚点；`beat` 是一页白板，必须用 `take` 引用一段连续 atoms；`step` 是这一页里的语义推进，也用 `take` 引用当前 beat 内的连续 atoms。agent 不手写 `beat.narr`，而是先理解完整口播稿的叙事结构，再拆 beat / step，最后用 atom id 绑定时间。

6. **正式制作管线由 agent 全自动执行**
   基础素材由用户预先准备并导入；新素材套第一次初始化 `配置.js` 时，需要用户在 HTML 配置台 review 和微调。除此之外，单元视频制作管线由 agent 完成：写口播、TTS、生成/完善分镜、静态校验、对齐、渲染成片，中间不设置用户处理节点。

## 架构层次

```text
事实源       books/<书>/chNN/NN.md 第 1–7 段
单元产物     video/<书>/chNN/NN/：口播稿、TTS、时间轴、分镜、成片
素材层       SKILL/assets/<书>/<素材id>/：片头、背景循环、底板、配置
模板层       SKILL/templates/* + src/templates/registry.ts：字段、容量、用途
协议层       references/分镜与模板.md：atoms / beat / step 的数据契约
执行层       dist/cli/* + runtime/*：TTS、骨架、校验、布局检查、渲染
```

核心依赖关系：

```text
口播稿 → TTS 时间轴 → atoms
完整口播叙事 → beats / steps
模板定义 → 静态字段与容量校验
素材配置 → 白板几何、字体、T0 时刻
validate-storyboard → align → layout-check → render-video
```

## 一单元管线

### 0. 解析素材套

先看 `SKILL/assets/<书>/`：

- 只有一套素材：直接使用。
- 有多套素材：必须由请求或环境变量 `ASSETS=<书>/<素材id>` 给出确定素材套；未给出时停止并报告缺少素材套前置条件。
- 没有素材或缺 `片头.mp4 / 背景循环.mp4 / 底板.png`：停止，报告需要先导入基础素材资产；素材准备不属于单元制作管线。
- 有素材但没有 `配置.js`：按 `references/资产层与新书.md` 启动配置台初始化。这是唯一需要用户 review 和微调的环节；完成后再进入单元制作。

### 1. 写口播稿

从 `<unit>` 的备读第 1–7 段提炼，写：

```text
<out>/口播稿.md
```

要求见 `references/口播稿规范.md`。口播稿只写要讲出口的话，不写画面指令、模板、秒数或 reveal 标记。

### 2. 配音并生成时间轴

```bash
node SKILL/dist/cli/gen-tts.js <out>/
```

默认嗓音、语速和看板时刻来自素材套 `配置.js`，必要时用环境变量覆盖：

```bash
VOICE=zh-CN-YunxiNeural RATE=-10% node SKILL/dist/cli/gen-tts.js <out>/
ENGINE=say node SKILL/dist/cli/gen-tts.js <out>/   # 离线兜底，时间轴降级为段级
```

### 3. 生成分镜骨架

```bash
node SKILL/dist/cli/draft-storyboard.js <out>/
```

脚本只产出新版 `分镜.js` 骨架：顶层 `atoms[]` + 粗 `beats[]`。它不决定最终叙事结构。接下来 agent 必须先理解完整口播稿，再照 `references/分镜与模板.md` 和对应 `templates/<模板>/README.md` 完成：

- 选定每个 beat 的模板。模板必须已在 `src/templates/registry.ts` 注册。
- 从原文拆 `jing`。
- 填 `base`：该模板开场即存在的对象，如经文句、标题、核心字。
- 重拆 `beats[].take`：一个 beat 是一页白板，覆盖一个完整小意思。
- 重拆 `steps[].take`：一个 step 是一页内的语义推进，不按句子或 atom 机械切。
- 按模板需要给 step 填摘要性板书和高亮：`state` + `show`；T0/T3 这类无 reveal 模板只覆盖 atoms。
- 保证每个模板的 `capacity` 不超限；超限就拆下一个 beat。

### 4. 静态校验、对齐、布局检查

```bash
node SKILL/dist/cli/validate-storyboard.js <out>/分镜.js
node SKILL/dist/cli/align-durs.js <out>/分镜.js
node SKILL/dist/cli/layout-check.js <out>/分镜.js
```

`validate-storyboard.js` 负责 atoms/take、模板字段、jing/hi、capacity 等硬校验；`align-durs.js` 只在校验通过后回填 `durs[] / stepDurs[]`；`layout-check.js` 负责真实 DOM 溢出检查。失败时按错误修分镜，不绕过。

### 5. 渲染成片

```bash
bash SKILL/runtime/render-video.sh <out>/分镜.js
```

`render-video.sh` 会先跑 `validate-templates`、`validate-storyboard`、align 和 layout-check，通过后输出 `<out>/领读视频.mp4`。

浏览器预览：

```text
SKILL/runtime/renderer.html?data=<分镜.js 相对 runtime 的路径>
```

常用参数：

- `&beat=N`：跳到第 N 个 beat 的静帧。
- `&step=N`：配合 `&beat=N` 跳到该 beat 的第 N 个 step 静帧。
- `&zone=1`：显示看板分区。
- `&auto=1`：打开后自动播放。

## 依赖

- Node.js ≥ 21。
- Google Chrome：`/Applications/Google Chrome.app`。
- `ffmpeg` / `ffprobe`。
- Python 包 `edge-tts`：`pip install edge-tts`。
- 离线兜底可用 macOS `say`，但时间轴只能到段级。

## 常见判断

- **白板抢跑**：不要把还没讲到的信息放在 `base` 或当前 step；按语义推进拆 step。
- **白板溢出**：不要继续加 step；拆成下一个 beat，让白板重新开始。
- **白板复述口播**：删掉近似原句，改成关键词、概念压缩、结构提示。
- **想精准卡点**：不要写秒数；调整 `beat.take` / `step.take` 的 atom 边界，让 align 从 TTS 时间轴推导。
- **分镜校验失败**：先看 `validate-storyboard` 的第一条错误。通常是改了 atom 文本、take 不连续、模板字段不合法、capacity 超限、hi key 不存在、T0 越线。
- **layout-check 失败**：说明真实 DOM 已溢出；压缩板书或拆 beat，不要调秒数绕过。
- **想改讲法**：回到 `口播稿.md`，重跑 TTS，再重跑 draft/调整分镜。不要只改 `atoms[].narr`。

## 不做的事

- 不做逐字 TTS 对齐；中文 edge-tts 当前主要是句级，step 内部用字符比例插值。
- 不在口播稿里写视觉 marker，避免污染旁白。
- 不为单章临时新增模板；优先用 `T0–T4` 和 step 编排解决节奏。
- 不去除素材自带水印。
