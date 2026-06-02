#!/usr/bin/env bash
# Codex PostToolUse hook for apply_patch:
# When Codex starts preparing a new reading unit by editing books/<book>/chNN/NN.md,
# inject a quiet reminder to check the previous unit's progress.

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

guard_dir="/tmp/codex-progress-guard"
mkdir -p "$guard_dir" 2>/dev/null
marker="${guard_dir}/${session_id:-default}"
last=""
[ -f "$marker" ] && last=$(cat "$marker" 2>/dev/null)

contexts=()
for file_path in "${paths[@]}"; do
  if [[ "$file_path" != /* && -n "$cwd" ]]; then
    file_path="${cwd}/${file_path}"
  fi

  if [[ "$file_path" =~ /books/([^/]+)/(ch[0-9]+)/([0-9]+\.md)$ ]]; then
    book="${BASH_REMATCH[1]}"
    chap="${BASH_REMATCH[2]}"
    unit="${BASH_REMATCH[3]}"
  else
    continue
  fi

  unit_key="${book}/${chap}/${unit}"
  if [ "$last" = "$unit_key" ]; then
    continue
  fi
  printf '%s' "$unit_key" > "$marker" 2>/dev/null
  last="$unit_key"

  unit_disp="books/${unit_key}"
  progress_disp="books/${book}/progress.md"
  contexts+=("【进度核对·副线，勿打断主线】刚开始备读新阅读单元 ${unit_disp}(写入其 2-7 段)——通常意味着上一个单元已读完。请据本轮对话核对：上一个阅读单元/章是否该在 ${progress_disp} 里勾选并补一句回看(多单元章先勾单元行，整章读完再勾章行)。若进度无变化或判断不出，忽略本提示。")
done

[ "${#contexts[@]}" -gt 0 ] || exit 0

ctx=$(printf '%s\n' "${contexts[@]}")
jq -n --arg ctx "$ctx" \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}' 2>/dev/null

exit 0
