/* 素材套「道德经/水墨卷轴」的配置 —— 一套素材一份配置，描述这套画面素材的参数，单一来源。
 * gen-tts（默认嗓 / 看板时刻）、align-durs（T0 校验线）、renderer（几何 / 配色 / 淡出）都读这里。
 * 可视化修改：node SKILL/scripts/init-studio.js 道德经/水墨卷轴
 * 字段：scrollReadyMs=片头里看板就绪时刻(ms,T0 截止线)；introVideoMs=片头时长(ms,预览淡出用)；
 *       board/titlePos/subtitle=几何(% of 16:9)；palette=配色；tplVars=模板字体字号微调(CSS 变量)。 */
const BOOK_CONFIG = {
  scrollReadyMs: 6200,
  introVideoMs: 8042,
  voice: "zh-CN-YunjianNeural",
  rate: "-8%",
  board:    {"left":40.5,"top":46.5,"width":48.5,"height":37},
  titlePos: {"left":85.5,"top":50},
  subtitle: {"side":8,"bottom":3.8},
  palette:  {"paper":"#e6d7c7","ink":"#3a3322","ink2":"#5a4f37","accent":"#b3401f","gold":"#9a7b2e"},
  tplVars:  {"--glyph-size":"6cqw"},
};
if (typeof window !== "undefined") window.BOOK_CONFIG = BOOK_CONFIG;
if (typeof module !== "undefined") module.exports = BOOK_CONFIG;
