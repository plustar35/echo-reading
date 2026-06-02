#!/usr/bin/env bash
# Codex PostToolUse hook for apply_patch:
# When Codex updates books/<book>/progress.md, inject a quiet reminder to review
# whether the just-finished reading produced a natural insight to record.

input=$(cat 2>/dev/null) || exit 0

tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)
case "$tool_name" in
  apply_patch|Edit|Write|MultiEdit) ;;
  *) exit 0 ;;
esac

session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)

paths=()
direct_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
if [ -n "$direct_path" ]; then
  paths+=("$direct_path")
fi

patch_text=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
if [ -n "$patch_text" ]; then
  while IFS= read -r path; do
    [ -n "$path" ] && paths+=("$path")
  done < <(
    printf '%s\n' "$patch_text" |
      sed -nE 's/^\*\*\* (Add|Update|Delete) File: (.*)$/\2/p'
  )
fi

[ "${#paths[@]}" -gt 0 ] || exit 0

guard_dir="/tmp/codex-insight-guard"
mkdir -p "$guard_dir" 2>/dev/null
marker="${guard_dir}/${session_id:-default}"
last=""
[ -f "$marker" ] && last=$(cat "$marker" 2>/dev/null)

contexts=()
for file_path in "${paths[@]}"; do
  if [[ "$file_path" != /* && -n "$cwd" ]]; then
    file_path="${cwd}/${file_path}"
  fi

  if [[ "$file_path" =~ /books/([^/]+)/progress\.md$ ]]; then
    book="${BASH_REMATCH[1]}"
  else
    continue
  fi

  hash=$(shasum "$file_path" 2>/dev/null | cut -d' ' -f1)
  if [ -n "$hash" ]; then
    key="${book}|${hash}"
    if [ "$last" = "$key" ]; then
      continue
    fi
    printf '%s' "$key" > "$marker" 2>/dev/null
    last="$key"
  fi

  progress_disp="books/${book}/progress.md"
  contexts+=("【Insight 副线·勿打断主线】刚写入 ${progress_disp}——通常意味着一个阅读单元/章刚读完。请回看本轮对话里这个刚完成单元的讨论,对照 insight 写入判断(概念/你的故事/闪回/共振/悬题):是否自然冒出了值得沉淀的概念理解、经历连接、情感共鸣或悬题?若有,静默提炼写入对应 insight/<维度>/*.md(新建或追加),正文标明来源 [[书名/chNN/NN|显示名]] 与日期 YYYY-MM-DD,并同步更新 insight/INDEX.md;写完简短告知。若没有自然流露的内容,别为凑数强行归纳——直接忽略本提示。")
done

[ "${#contexts[@]}" -gt 0 ] || exit 0

ctx=$(printf '%s\n' "${contexts[@]}")
jq -n --arg ctx "$ctx" \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}' 2>/dev/null

exit 0
