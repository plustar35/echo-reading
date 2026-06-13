# T2 title-lead — 标题 + 引

用途：引子、过渡、结构转场。标题和 lead / 结构提示按 step 渐进出现。

层级槽位固定为：

```text
title
lead / note
```

reveal 只决定内容何时出现，不决定层级位置。

字段：

- `base.title`：可选，进入 beat 时显示的标题；如果标题还没讲到，就放到 `step.show.title`。
- `step.show.title`：随 step reveal 的标题。
- `step.show.lead` / `step.show.note`：随 step reveal 的下层引句或结构提示。
- `step.show.center`：可选，等价中心项；只在需要明确 `{kind,text}` 时使用。

约束：

- 一个 step 最多追加 1–2 条中心内容。
- 每个 T2 beat 必须有 1 个 title，可以在 base 或 step 中出现。
- reveal 顺序必须是 `title → lead/note`；不能先出下层，再补标题。
- 文本应是结构提示或关键词，不复述口播。
- 候选最大容量：一页最多 1 个标题 + 2 条 lead/note，合计最多 5 个视觉行。
- 超过容量时拆成下一个 T2 beat，不继续追加 center 项。
