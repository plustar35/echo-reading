#!/usr/bin/env bash
# Codex PostToolUse hook for Read:
# When Codex reads books/<book>/chNN/NN.md, surface the sibling
# NN.notes.md sidecar if it contains Obsidian note blocks.

input=$(cat 2>/dev/null) || exit 0

tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)
case "$tool_name" in
  Read|read|read_file) ;;
  *) exit 0 ;;
esac

cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.path // .tool_input.file // empty' 2>/dev/null) || exit 0
[ -n "$file_path" ] || exit 0

if [[ "$file_path" != /* && -n "$cwd" ]]; then
  file_path="${cwd}/${file_path}"
fi

# Only reading-unit files match: books/<book>/chNN/NN.md.
# This excludes raw.md, 00-导读.md, and *.notes.md.
[[ "$file_path" =~ /books/[^/]+/ch[0-9]+/[0-9]+\.md$ ]] || exit 0

notes="${file_path%.md}.notes.md"
[ -f "$notes" ] || exit 0
grep -q '\[!note\]' "$notes" 2>/dev/null || exit 0

content=$(cat "$notes" 2>/dev/null) || exit 0
if [[ "$notes" == */books/* ]]; then
  disp="books/${notes#*/books/}"
else
  disp="$notes"
fi

ctx="【本单元已有批注·页边层，读这个单元时一并纳入；勿与 insight 混；来源 ${disp}】
${content}"

jq -n --arg ctx "$ctx" \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}' 2>/dev/null

exit 0
