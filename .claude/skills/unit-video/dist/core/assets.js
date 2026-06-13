"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ASSETS_ROOT = exports.SKILL_ROOT = void 0;
exports.resolveAssetId = resolveAssetId;
exports.loadAssetConfig = loadAssetConfig;
/* 素材套解析 —— gen-tts / draft-storyboard 共用。
 * 结构统一为 SKILL/assets/<书名>/<素材id>/（素材 + 配置.js 同住一套一文件夹）。
 * 规则：env ASSETS 最优先（值 = assets/ 下相对路径，如 "道德经/水墨卷轴"）；
 *       没给则看 assets/<书名>/ 下的套目录——恰好一套 → 自动用它；多套 → 抛错并要求
 *       由请求或环境变量 ASSETS 显式指定；没有 → 返回 null（用内置缺省）。 */
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
exports.SKILL_ROOT = node_path_1.default.resolve(__dirname, "..", "..");
exports.ASSETS_ROOT = node_path_1.default.join(exports.SKILL_ROOT, "assets");
const isSet = (p) => node_fs_1.default.existsSync(node_path_1.default.join(p, "底板.png")) || node_fs_1.default.existsSync(node_path_1.default.join(p, "配置.js"));
// → 素材 id（assets/ 下相对路径）或 null；多套未指定时 throw
function resolveAssetId(book) {
    if (process.env.ASSETS)
        return process.env.ASSETS;
    if (!book)
        return null;
    const bookDir = node_path_1.default.join(exports.ASSETS_ROOT, book);
    if (!node_fs_1.default.existsSync(bookDir) || !node_fs_1.default.statSync(bookDir).isDirectory())
        return null;
    if (isSet(bookDir))
        return book; // 旧式平铺兼容（素材直接在书目录下）
    const sets = node_fs_1.default.readdirSync(bookDir)
        .filter(d => !d.startsWith(".") && node_fs_1.default.statSync(node_path_1.default.join(bookDir, d)).isDirectory() && isSet(node_path_1.default.join(bookDir, d)));
    if (sets.length === 1)
        return book + "/" + sets[0];
    if (sets.length > 1)
        throw new Error(`《${book}》有多个素材套（${sets.join(" / ")}）——请在请求或环境变量中指定 ASSETS=${book}/<素材id> 后重跑`);
    return null;
}
// → 该素材套的 配置.js 内容（无 → {}）
function loadAssetConfig(assetId) {
    if (!assetId)
        return {};
    const f = node_path_1.default.join(exports.ASSETS_ROOT, assetId, "配置.js");
    if (!node_fs_1.default.existsSync(f))
        return {};
    try {
        return require(f);
    }
    catch (_) {
        return {};
    }
}
