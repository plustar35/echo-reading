# T1 jing-aux — 原文 + 渐进注释

用途：逐句精讲。右侧经文可以先出现，highlight 和左侧注释必须随 step 推进。

层级槽位固定为：

```text
head
gloss / point
```

reveal 只决定内容何时出现，不决定层级位置。

字段：

- `base.sent`：进入 beat 时显示的经文句 id。
- `base.aux`：可选，只允许放 `head`；通常优先在第一个相关 step 里 reveal head，避免抢跑。
- `step.state.sent`：可选，切换当前经文句。
- `step.state.hi`：可选，点亮当前经文句里的 key，或 `"sweep"`。
- `step.show.aux`：可选，追加左侧板书。

`aux` 项：

- `{ "kind": "head", "text": "题眼" }`
- `{ "kind": "gloss", "z": "处", "p": "chǔ", "m": "安处、居于" }`
- `{ "kind": "point", "text": "成全，而不占有" }`

约束：

- 一个 step 最多追加 1–2 个 aux 项。
- 有 `gloss` / `point` 时，本 beat 必须有 1 个 `head`。
- reveal 顺序只要求 `head → gloss/point`；`gloss` 和 `point` 同层，没有先后顺序。
- 白板文字要摘要化，不复制口播原句。
- 候选最大容量：一页最多 1 个 head、2 个 gloss、3 个 point，合计最多 6 个 aux 项；总视觉行数不超过 6 行。
- 超过容量时拆成下一个 T1 beat；右侧可继续显示同一句经文和同一组 highlight，左侧注释重新开始。
