// 引擎自带的模型目录（@earendil-works/pi-ai 的 provider 数据）里记录着各家模型的
// 官方单价，单位是「美元 / 百万 tokens」。这里把它读成一张 id → 单价的映射，
// 让没写死在内置表里的模型（MIMO、KIMI、MiniMax、GLM、Qwen 等）也能估算费用。
//
// 读不到就返回空 Map：插件照样工作，只是那些模型继续显示「未定价」。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PKG = ['@earendil-works', 'pi-ai'];

// 同一模型在多个渠道里出现且价格不同时，优先取官方直连的目录。
const PRIORITY = ['xiaomi', 'moonshotai-cn', 'minimax-cn', 'zai', 'zai-coding-cn', 'qwen-token-plan-cn', 'deepseek'];

/** 从某个文件往上找 node_modules/<PKG>。 */
function findPackage(startFile) {
  if (typeof startFile !== 'string' || !startFile) return null;
  let dir = dirname(startFile);
  for (let i = 0; i < 16; i += 1) {
    const candidate = join(dir, 'node_modules', ...PKG);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const modelId = (value) => (typeof value?.id === 'string' ? value.id.trim().toLowerCase() : '');
const isModel = (value) => Boolean(value) && typeof value === 'object' && typeof value.id === 'string' && value.cost && typeof value.cost === 'object';
const isFree = (cost) => !(cost.input > 0) && !(cost.output > 0) && !(cost.cacheRead > 0) && !(cost.cacheWrite > 0);

/** 一份 provider 数据文件里有模型时直接取，否则再往里一层（文件按 api 分组）。 */
function collectModels(value, out) {
  if (isModel(value)) { out.push(value); return; }
  if (!value || typeof value !== 'object') return;
  for (const child of Object.values(value)) collectModels(child, out);
}

/**
 * 读引擎自带的模型目录。
 * @returns a Map from lowercase model id to `{ input, output, cacheRead, cacheWrite }` in USD / 1M tokens.
 *          Empty when the catalog cannot be found.
 */
export function loadCatalog({ startFiles = [process.argv[1], import.meta.url] } = {}) {
  const catalog = new Map();
  let dir = null;
  for (const start of startFiles) { dir = findPackage(start); if (dir) break; }
  if (!dir) return catalog;
  const dataDir = join(dir, 'dist', 'providers', 'data');
  if (!existsSync(dataDir)) return catalog;
  let files;
  try { files = readdirSync(dataDir).filter((f) => f.endsWith('.json') && !f.startsWith('.')); } catch { return catalog; }
  files.sort((a, b) => {
    const rank = (name) => { const i = PRIORITY.indexOf(name.replace(/\.json$/, '')); return i === -1 ? PRIORITY.length : i; };
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  for (const file of files) {
    let data;
    try { data = JSON.parse(readFileSync(join(dataDir, file), 'utf8')); } catch { continue; }
    const models = [];
    collectModels(data, models);
    for (const model of models) {
      const id = modelId(model);
      // 订阅制渠道会把单价写成 0，那不算「有价格」，否则会把免费套餐当成免费的。
      if (!id || isFree(model.cost) || catalog.has(id)) continue;
      catalog.set(id, {
        input: Number(model.cost.input) || 0,
        output: Number(model.cost.output) || 0,
        cacheRead: Number(model.cost.cacheRead) || 0,
        ...(model.cost.cacheWrite === undefined ? {} : { cacheWrite: Number(model.cost.cacheWrite) || 0 }),
      });
    }
  }
  return catalog;
}
