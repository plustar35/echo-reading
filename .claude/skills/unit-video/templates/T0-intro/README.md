# T0 intro — 开场字幕

用途：卷轴或白板就绪前的片头引入。只走字幕，不往白板写内容。

字段：

- `tpl: "T0"`
- `base` 通常省略。
- `steps` 只需要覆盖 atoms，不写 `state/show`。

约束：

- T0 结束时间不得越过 `scrollReadyMs + 800ms`。
- 如果卷轴已经就绪，就应该切到非 T0 模板。
- 白板容量为 0；`base`、`state`、`show` 都必须为空。
