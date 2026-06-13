#!/usr/bin/env bash
# 领读视频 · 单元管线 ④ 渲染
# 把一章的 分镜.js 渲成成片：透明叠层(renderer.html?record=1 经 CDP 虚拟时间逐帧截图)
# 叠到背景视频(片头.mp4 → 背景循环.mp4 循环到全长) + 挂【一条】口播 TTS 音轨。
# 一根时间轴：叠层与音轨都从 0 跑到 TTS 全长，片头视频只是前 ~8s 的视觉、不再钳位内容。
#
#   用法： runtime/render-video.sh ROOT/video/<书>/chNN/NN/分镜.js
#   前置： node(内置 WebSocket,≥21) · Google Chrome · ffmpeg；先跑 dist/cli/gen-tts.js 出音轨+时长。
#   产物： 分镜.js 同目录下的 领读视频.mp4
set -e
RUNTIME_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_ROOT="$(cd "$RUNTIME_DIR/.." && pwd)"
DIST_CLI="$SKILL_ROOT/dist/cli"
SB="$1"
[ -z "$SB" ] && { echo "用法: runtime/render-video.sh <分镜.js 路径>"; exit 1; }
SB_ABS="$(cd "$(dirname "$SB")" && pwd)/$(basename "$SB")"
CH_DIR="$(dirname "$SB_ABS")"

FPS=24

# ▸ 0/6 模板定义：registry 与 template.json 必须一致，capacity 必须可被程序校验。
echo "▸ 0/6 模板定义校验 (validate-templates)…"
if ! node "$DIST_CLI/validate-templates.js"; then
  echo "✗ 模板定义校验未过，已中止渲染（修好模板定义再重渲）" >&2
  exit 1
fi

# ▸ 1/6 分镜静态校验：不写文件，先拦住 take/schema/capacity 等确定性错误。
echo "▸ 1/6 分镜静态校验 (validate-storyboard)…"
if ! node "$DIST_CLI/validate-storyboard.js" "$SB_ABS"; then
  echo "✗ 分镜静态校验未过，已中止渲染（修好分镜再重渲）" >&2
  exit 1
fi

# ▸ 2/6 对齐：用 gen-tts 的时间轴回填 durs[] / stepDurs[]。
echo "▸ 2/6 对齐时长 (align)…"
if ! node "$DIST_CLI/align-durs.js" "$SB_ABS"; then
  echo "✗ align 未过，已中止渲染（修好分镜再重渲）" >&2
  exit 1
fi

# 素材套从 skill 内解析(按 分镜.assets 定位 SKILL/assets/<素材id>/，缺省用 book 同名套)；
# 音轨是本章产物,相对分镜文件解析(分镜旁边)。
read -r ASSET_ID AUDIO < <(node -e '
  const p=require("path"),sb=require(process.argv[1]),d=p.dirname(process.argv[1]);
  console.log([sb.assets||sb.book, p.resolve(d, sb.audio)].join("\t"));
' "$SB_ABS")
ASSETS_DIR="$SKILL_ROOT/assets/$ASSET_ID"
INTRO_MP4="$ASSETS_DIR/片头.mp4"
LOOP_MP4="$ASSETS_DIR/背景循环.mp4"
# 书级资产缺失 → 明确报错、别带半套资产硬渲。提示去备资产(见 references/资产层与新书.md)。
for f in "$INTRO_MP4" "$LOOP_MP4" "$ASSETS_DIR/底板.png"; do
  [ -f "$f" ] || { echo "✗ 素材套缺件：$f" >&2; echo "  素材套 SKILL/assets/$ASSET_ID/ 不齐(片头.mp4 / 背景循环.mp4 / 底板.png)。先按 references/资产层与新书.md 备齐再渲。" >&2; exit 1; }
done
OUT="$CH_DIR/领读视频.mp4"
DUR() { ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$1"; }
INTRO_VID=$(DUR "$INTRO_MP4")              # 片头视频真实时长(纯视觉,通常 ~8.04s)
AUDIO_DUR=$(DUR "$AUDIO")                  # 口播音轨全长 = 整条时间轴
# 背景循环要补的时长 = 音轨全长 − 片头视频(不足则为 0)
LOOP_DUR=$(awk -v a="$AUDIO_DUR" -v i="$INTRO_VID" 'BEGIN{d=a-i; print (d>0?d:0)}')
FRAMES=/tmp/overlay-frames

# renderer URL：data 用相对 runtime/ 的路径，经 Node 编码中文/特殊字符
URL=$(node -e '
  const p=require("path");
  const rel=p.relative(process.argv[1],process.argv[2]);
  const u=new URL("file://"+process.argv[1]+"/renderer.html");
  u.searchParams.set("data",rel); u.searchParams.set("record","1");
  process.stdout.write(u.href);
' "$RUNTIME_DIR" "$SB_ABS")

echo "▸ 3/6 真实布局检查 (layout-check)…"
if ! node "$DIST_CLI/layout-check.js" "$SB_ABS"; then
  echo "✗ layout-check 未过，已中止渲染（拆 beat 或压缩模板内容后重渲）" >&2
  exit 1
fi

echo "▸ 4/6 离屏渲染透明叠层 (~5min)…  data=$(basename "$CH_DIR")/分镜.js  全长 ${AUDIO_DUR}s"
OUT="$FRAMES" FPS=$FPS node "$DIST_CLI/render-overlay.js" "$URL"

echo "▸ 5/6 背景层视频 (片头 ${INTRO_VID}s → 背景循环补 ${LOOP_DUR}s)…"
ffmpeg -y -i "$INTRO_MP4" -an -r $FPS -vf scale=1280:720 -c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 20 /tmp/bg_intro.mp4 2>/dev/null
ffmpeg -y -stream_loop -1 -i "$LOOP_MP4" -t "$LOOP_DUR" -an -r $FPS -vf scale=1280:720 -c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 20 /tmp/bg_body.mp4 2>/dev/null
printf "file '/tmp/bg_intro.mp4'\nfile '/tmp/bg_body.mp4'\n" > /tmp/bglist.txt
ffmpeg -y -f concat -safe 0 -i /tmp/bglist.txt -c copy /tmp/bg_full.mp4 2>/dev/null

echo "▸ 6/6 合成 overlay + 口播音轨 → 领读视频.mp4…"
ffmpeg -y -i /tmp/bg_full.mp4 -framerate $FPS -start_number 0 -i "$FRAMES/%05d.png" -i "$AUDIO" \
  -filter_complex "[0:v][1:v]overlay=shortest=1:format=auto[v]" \
  -map "[v]" -map 2:a -c:v libx264 -pix_fmt yuv420p -crf 19 -preset medium \
  -c:a aac -b:a 160k -ar 44100 -ac 1 -movflags +faststart -shortest "$OUT" 2>/dev/null

rm -rf "$FRAMES" /tmp/bg_intro.mp4 /tmp/bg_body.mp4 /tmp/bg_full.mp4 /tmp/bglist.txt
echo "✓ 完成 → $OUT  ($(DUR "$OUT")s)"
