// DeepSeek 官方 API 价格（人民币 / 百万 tokens），用于估算费用。
// 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing （2026-11-22 核对）。价格可能调整，估算仅供参考。
// 空闲时段价格是高峰时段的一半。高峰时段＝北京时间周一至周五（不含法定节假日）9:00–12:00、14:00–18:00；
// 其余时段（含周末、法定节假日全天）都是空闲时段。
import { readFileSync } from 'node:fs';

export const PRICES_AS_OF = '2026-11-22';
export const PRICE_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing';
/** 引擎模型库里是美元价，这里按固定汇率折成人民币，只作估算。 */
export const USD_CNY = 7.2;

const TABLE = {
  'deepseek-flash': { offPeak: { hit: 0.02, miss: 1, out: 4 }, peak: { hit: 0.04, miss: 2, out: 8 } },
  'deepseek-v4-pro': { offPeak: { hit: 0.15, miss: 4.5, out: 13.5 }, peak: { hit: 0.30, miss: 9, out: 27 } }
};
// 已下线、但仍按 Flash 计费的旧模型名。
const ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4.1-flash': 'deepseek-flash'
};

// 法定节假日全天算空闲时段：国务院办公厅《关于 2026 年部分节假日安排的通知》（国办发明电〔2025〕7 号）。
// 只收「放假」的日期；调休上班的周末仍按周末算空闲时段（官方计费口径是「周一至周五」）。
const HOLIDAY_RANGES = [
  ['2026-01-01', '2026-01-03'], // 元旦
  ['2026-02-15', '2026-02-23'], // 春节
  ['2026-04-04', '2026-04-06'], // 清明
  ['2026-05-01', '2026-05-05'], // 劳动节
  ['2026-06-19', '2026-06-21'], // 端午
  ['2026-09-25', '2026-09-27'], // 中秋
  ['2026-10-01', '2026-10-07']  // 国庆
];

function buildHolidays(ranges) {
  const days = new Set();
  for (const [from, to] of ranges) {
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400e3) {
      days.add(new Date(t).toISOString().slice(0, 10));
    }
  }
  return days;
}

const HOLIDAYS = buildHolidays(HOLIDAY_RANGES);

/** 北京时间的日期键（YYYY-MM-DD）。 */
const beijingDay = (time) => new Date(time + 8 * 3600e3).toISOString().slice(0, 10);

const num = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
/** 模型名规范化：小写、去掉 provider 前缀。 */
const normalizeId = (model) => (typeof model === 'string' ? model.trim().toLowerCase() : '');
const shortId = (id) => id.slice(id.lastIndexOf('/') + 1);

// 引擎模型库读进来的单价（美元），以及用户自己填的覆盖表。都由 apply() 装上。
let CATALOG = null;
let OVERRIDES = null;

/** 装上引擎模型库读到的单价表（见 catalog.js）；传 null 关掉。 */
export function useCatalog(catalog) { CATALOG = catalog instanceof Map ? catalog : null; }

/**
 * 装上用户自己的价格表（`$DSH_HOME/dsh-island-go/prices.json`），单位人民币 / 百万 tokens。
 * 支持两种写法：
 *   { "my-model": { "input": 1, "output": 4, "cacheRead": 0.02 } }                 全天同价
 *   { "my-model": { "peak": {...}, "offPeak": {...} } }                            分时段
 * @returns how many models were accepted.
 */
export function useOverrides(raw) {
  const models = raw?.models && typeof raw.models === 'object' ? raw.models : raw;
  if (!models || typeof models !== 'object') { OVERRIDES = null; return 0; }
  const table = new Map();
  const price = (p) => {
    const source = p && typeof p === 'object' ? p : {};
    const out = { miss: num(source.input ?? source.miss), out: num(source.output ?? source.out), hit: num(source.cacheRead ?? source.hit) };
    if (source.cacheWrite !== undefined) out.write = num(source.cacheWrite);
    return out;
  };
  for (const [name, value] of Object.entries(models)) {
    const id = normalizeId(name);
    if (!id || !value || typeof value !== 'object') continue;
    const flat = value.input !== undefined || value.output !== undefined || value.cacheRead !== undefined;
    const peak = price(flat ? value : value.peak ?? {});
    const offPeak = price(flat ? value : value.offPeak ?? value.peak ?? {});
    table.set(id, { peak, offPeak });
  }
  OVERRIDES = table;
  return table.size;
}

/**
 * 读用户自己的价格表文件（JSON）并装上；文件不存在或格式不对就当没有。
 * @returns how many models were accepted.
 */
export function setOverridesFile(file) {
  if (!file) return 0;
  try { return useOverrides(JSON.parse(readFileSync(file, 'utf8'))); } catch { return 0; }
}

/** 引擎模型库里的美元单价折成人民币，并补齐高峰/空闲两张表（同一价）。 */
function fromCatalog(cost) {
  const one = {
    miss: num(cost.input) * USD_CNY,
    out: num(cost.output) * USD_CNY,
    hit: num(cost.cacheRead) * USD_CNY,
    ...(cost.cacheWrite === undefined ? {} : { write: num(cost.cacheWrite) * USD_CNY }),
  };
  return { peak: one, offPeak: one };
}

/**
 * 一个模型的价格表（人民币 / 百万 tokens）：
 * 用户自填 > 内置 DeepSeek 官方价 > 引擎模型库；都没有就是 null（不估价）。
 */
export function priceTableFor(model) {
  const id = normalizeId(model);
  if (!id) return null;
  const short = shortId(id);
  const override = OVERRIDES?.get(id) ?? OVERRIDES?.get(short);
  if (override) return override;
  const key = TABLE[id] ? id : TABLE[short] ? short : ALIASES[id] ?? ALIASES[short];
  if (key && TABLE[key]) return TABLE[key];
  const fromLib = CATALOG?.get(id) ?? CATALOG?.get(short);
  if (fromLib) return fromCatalog(fromLib);
  return null;
}

/** The priced model id for a model name, or null when no price is known. */
export function pricedModel(model) {
  const id = normalizeId(model);
  if (!id) return null;
  return priceTableFor(id) ? id : null;
}

/** Whether a moment falls in DeepSeek's peak period (Beijing time, weekdays 9–12 and 14–18, holidays excluded). */
export function isPeak(time) {
  const beijing = new Date(time + 8 * 3600e3);
  const day = beijing.getUTCDay();
  if (day === 0 || day === 6) return false;
  if (HOLIDAYS.has(beijingDay(time))) return false;
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080);
}

/**
 * Estimated cost in CNY of one model call.
 * Harness usage: inputTokens are uncached prompt tokens, cacheReadTokens hit the cache,
 * cacheWriteTokens are billed as cache misses, outputTokens include reasoning.
 * @returns the cost, or null when the model has no official price.
 */
export function estimateCost({ model, time, inputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, outputTokens = 0 }) {
  const table = priceTableFor(model);
  if (!table) return null;
  const p = table[isPeak(time) ? 'peak' : 'offPeak'];
  const write = p.write ?? p.miss;
  return (inputTokens * p.miss + cacheWriteTokens * write + cacheReadTokens * p.hit + outputTokens * p.out) / 1e6;
}
