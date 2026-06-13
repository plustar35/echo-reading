/* 素材套解析 —— gen-tts / draft-storyboard 共用。
 * 结构统一为 SKILL/assets/<书名>/<素材id>/（素材 + 配置.js 同住一套一文件夹）。
 * 规则：env ASSETS 最优先（值 = assets/ 下相对路径，如 "道德经/水墨卷轴"）；
 *       没给则看 assets/<书名>/ 下的套目录——恰好一套 → 自动用它；多套 → 抛错并要求
 *       由请求或环境变量 ASSETS 显式指定；没有 → 返回 null（用内置缺省）。 */
import fs from "node:fs";
import path from "node:path";

export const SKILL_ROOT = path.resolve(__dirname, "..", "..");
export const ASSETS_ROOT = path.join(SKILL_ROOT, "assets");
const isSet = (p: string) => fs.existsSync(path.join(p, "底板.png")) || fs.existsSync(path.join(p, "配置.js"));

// → 素材 id（assets/ 下相对路径）或 null；多套未指定时 throw
export function resolveAssetId(book?: string | null): string | null {
  if (process.env.ASSETS) return process.env.ASSETS;
  if (!book) return null;
  const bookDir = path.join(ASSETS_ROOT, book);
  if (!fs.existsSync(bookDir) || !fs.statSync(bookDir).isDirectory()) return null;
  if (isSet(bookDir)) return book;             // 旧式平铺兼容（素材直接在书目录下）
  const sets = fs.readdirSync(bookDir)
    .filter(d => !d.startsWith(".") && fs.statSync(path.join(bookDir, d)).isDirectory() && isSet(path.join(bookDir, d)));
  if (sets.length === 1) return book + "/" + sets[0];
  if (sets.length > 1)
    throw new Error(`《${book}》有多个素材套（${sets.join(" / ")}）——请在请求或环境变量中指定 ASSETS=${book}/<素材id> 后重跑`);
  return null;
}

// → 该素材套的 配置.js 内容（无 → {}）
export function loadAssetConfig(assetId?: string | null): Record<string, unknown> {
  if (!assetId) return {};
  const f = path.join(ASSETS_ROOT, assetId, "配置.js");
  if (!fs.existsSync(f)) return {};
  try { return require(f); } catch (_) { return {}; }
}
