#!/usr/bin/env bash
# PostToolUse 钩子(matcher: Edit|Write|MultiEdit)：
# 当「写入某本书的 books/<书>/progress.md」时——通常意味着一个阅读单元/章
# 刚被标记读完——向上下文注入一句副线提醒：回看刚读完那个单元的对话，对照
# insight 写入判断，有值得沉淀的就直接提炼写入。
#
# 与 progress-reminder.sh 互补、互不重叠：
#   progress-reminder.sh 认 books/<书>/chNN/NN.md（开始备读新单元 → 提醒「核对进度」）
#   insight-reminder.sh  认 books/<书>/progress.md（进度刚更新 → 提醒「沉淀 insight」）
# 两者挂在同一个 PostToolUse 上，每次只会有一个命中。
#
# 触发条件(全部满足才注入提醒，否则静默退出)：
#   1. 工具是 Edit/Write/MultiEdit(脚本内再防一道，双保险)
#   2. 操作的是某本书的进度文件： books/<书名>/progress.md
#   3. 该进度文件这次写入后的内容，本会话还没就这个内容提醒过 —— 用内容哈希去重，
#      同一次「标记完成」可能拆成多次 Edit，避免连响多次；内容真变了(下一个单元
#      完成)才会再响。哈希取不到时不去重，宁可多提醒一次。
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

# 只认 books/<书名>/progress.md
if [[ "$file_path" =~ /books/([^/]+)/progress\.md$ ]]; then
  book="${BASH_REMATCH[1]}"
else
  exit 0
fi

progress_disp="books/${book}/progress.md"     # 展示用相对路径（即被编辑的文件）

# 「同一内容只响一次」去重：按 session 记住上次提醒时的 书名+内容哈希
guard_dir="/tmp/cc-insight-guard"
mkdir -p "$guard_dir" 2>/dev/null
marker="${guard_dir}/${session_id:-default}"
hash=$(shasum "$file_path" 2>/dev/null | cut -d' ' -f1)
if [ -n "$hash" ]; then                        # 哈希可用才去重；取不到就照常提醒
  key="${book}|${hash}"
  last=""
  [ -f "$marker" ] && last=$(cat "$marker" 2>/dev/null)
  if [ "$last" = "$key" ]; then
    exit 0        # 还是同一份内容，别重复打扰
  fi
  printf '%s' "$key" > "$marker" 2>/dev/null
fi

ctx="【Insight 副线·勿打断主线】刚写入 ${progress_disp}——通常意味着一个阅读单元/章刚读完。请回看本轮对话里这个刚完成单元的讨论,对照 insight 写入判断(概念/你的故事/闪回/共振/悬题):是否自然冒出了值得沉淀的概念理解、经历连接、情感共鸣或悬题?若有,静默提炼写入对应 insight/<维度>/*.md(新建或追加),正文标明来源 [[书名/chNN/NN|显示名]] 与日期 YYYY-MM-DD,并同步更新 insight/INDEX.md;写完简短告知。若没有自然流露的内容,别为凑数强行归纳——直接忽略本提示。"

jq -n --arg ctx "$ctx" \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}' 2>/dev/null

exit 0
