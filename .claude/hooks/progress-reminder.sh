#!/usr/bin/env bash
# PostToolUse 钩子：进入「新的阅读单元」时，提醒主线核对该书 progress.md。
#
# 触发条件（全部满足才注入提醒，否则静默退出）：
#   1. 本次工具操作的是单元文件： books/<书名>/ch<NN>/<NN>.md
#      （排除 raw.md / 00-导读.md / progress.md —— 它们不是「数字.md」单元文件）
#   2. 这个单元和「本会话上次提醒过的单元」不同 —— 即真的换到了新单元。
#      （同一单元反复 Read/Edit 不会重复打扰。）
#
# 任何异常一律 exit 0，绝不阻断读书主线。

input=$(cat 2>/dev/null) || exit 0

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

# 「换单元才响」去重：按 session 记住上次提醒的单元
guard_dir="/tmp/cc-progress-guard"
mkdir -p "$guard_dir" 2>/dev/null
marker="${guard_dir}/${session_id:-default}"
last=""
[ -f "$marker" ] && last=$(cat "$marker" 2>/dev/null)
if [ "$last" = "$unit_key" ]; then
  exit 0          # 还在同一个单元里，别重复打扰
fi
printf '%s' "$unit_key" > "$marker" 2>/dev/null

ctx="【进度核对·副线，勿打断主线】刚进入新阅读单元 ${unit_disp}。请据本轮对话判断：上一个阅读单元是否已读完？若是，按 CLAUDE.md 规则更新 ${progress_disp}——勾选对应行并补一句回看（多单元章先勾单元行，整章读完再勾章行）。若进度无变化或判断不出，忽略本提示。"

jq -n --arg ctx "$ctx" \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}' 2>/dev/null

exit 0
