#!/usr/bin/env bash
# PostToolUse 钩子(matcher: Read)：
# 读到某个阅读单元 books/<书>/chNN/NN.md 时，自动把同目录的批注旁车 NN.notes.md
# 内容注入上下文——让新会话(或任何时候)一打开单元，就「看见」该单元已有的批注
# (人在界面里写的、或 Claude 写的)，不必专门去找。批注是局部的、不进全局索引，
# 就靠这条「进单元即带出」来发现。
#
# 触发条件(全部满足才注入，否则静默退出)：
#   1. 工具是 Read
#   2. 读的是单元文件 books/<书名>/chNN/NN.md(文件名纯数字 + .md；
#      排除 raw.md / 00-导读.md / *.notes.md 自身)
#   3. 同目录存在 NN.notes.md 且确有批注(含 [!note] 块)
#
# 任何异常一律 exit 0，绝不阻断读书主线。

input=$(cat 2>/dev/null) || exit 0

tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)
[ "$tool_name" = "Read" ] || exit 0

file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0
[ -n "$file_path" ] || exit 0

# 只认 books/<书>/chNN/NN.md（纯数字.md）
[[ "$file_path" =~ /books/[^/]+/ch[0-9]+/[0-9]+\.md$ ]] || exit 0

notes="${file_path%.md}.notes.md"
[ -f "$notes" ] || exit 0
grep -q '\[!note\]' "$notes" 2>/dev/null || exit 0   # 空旁车 / 只有 frontmatter，不打扰

content=$(cat "$notes" 2>/dev/null)
disp="books/${notes#*/books/}"

ctx="【本单元已有批注·页边层，读这个单元时一并纳入；勿与 insight 混；来源 ${disp}】
${content}"

jq -n --arg ctx "$ctx" \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}' 2>/dev/null

exit 0
