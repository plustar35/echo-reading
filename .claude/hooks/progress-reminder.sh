#!/usr/bin/env bash
# PostToolUse 钩子(matcher: Edit|Write|MultiEdit)：
# 当「首次写入某个阅读单元 books/<书>/chNN/NN.md(即填它的 2-7 段)」时，
# 向上下文注入一句副线提醒，让主线核对该书 progress.md。
#
# 为什么只认 Edit/Write、不认 Read：
#   备读一个新单元 = 往它的 2-7 段写内容(Edit/Write)，这是「上一个单元已读完、
#   现在开始读新单元」的确定信号。而 Read 是模糊的——会话开头 Agent 常先 Read
#   NN.md 只为确认进度，那不该触发；更糟的是按单元去重时，这种开头的 Read 会
#   «用掉» 该单元唯一一次提醒，把后面真正有意义的 Edit 静默掉。所以排除 Read。
#
# 触发条件(全部满足才注入提醒，否则静默退出)：
#   1. 工具是 Edit/Write/MultiEdit(脚本内再防一道，双保险)
#   2. 操作的是单元文件： books/<书名>/ch<NN>/<NN>.md
#      (排除 raw.md / 00-导读.md / progress.md —— 非「数字.md」)
#   3. 这个单元在本会话还没提醒过 —— 同一单元反复 Edit 只响一次
#
# 任何异常一律 exit 0，绝不阻断读书主线。

input=$(cat 2>/dev/null) || exit 0

tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)
case "$tool_name" in
  Edit|Write|MultiEdit) ;;          # 只在写入类工具上工作
  *) exit 0 ;;
esac

file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
[ -n "$file_path" ] || exit 0

# 只认 books/<书名>/chNN/NN.md（文件名必须是纯数字 + .md）
if [[ "$file_path" =~ /books/([^/]+)/(ch[0-9]+)/([0-9]+\.md)$ ]]; then
  book="${BASH_REMATCH[1]}"
  chap="${BASH_REMATCH[2]}"
  unit="${BASH_REMATCH[3]}"
else
  exit 0
fi

unit_key="${book}/${chap}/${unit}"            # 去重键，如 道德经/ch06/01.md
unit_disp="books/${unit_key}"                 # 展示用相对路径
progress_disp="books/${book}/progress.md"     # 该书进度文件（相对项目根）

# 「同一单元只响一次」去重：按 session 记住上次提醒的单元
guard_dir="/tmp/cc-progress-guard"
mkdir -p "$guard_dir" 2>/dev/null
marker="${guard_dir}/${session_id:-default}"
last=""
[ -f "$marker" ] && last=$(cat "$marker" 2>/dev/null)
if [ "$last" = "$unit_key" ]; then
  exit 0          # 还在同一个单元里，别重复打扰
fi
printf '%s' "$unit_key" > "$marker" 2>/dev/null

ctx="【进度核对·副线，勿打断主线】刚开始备读新阅读单元 ${unit_disp}(写入其 2-7 段)——通常意味着上一个单元已读完。请据本轮对话核对：上一个阅读单元/章是否该在 ${progress_disp} 里勾选并补一句回看(多单元章先勾单元行，整章读完再勾章行)。若进度无变化或判断不出，忽略本提示。"

jq -n --arg ctx "$ctx" \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}' 2>/dev/null

exit 0
