// DeepSeek 官方 API 价格（人民币 / 百万 tokens），用于估算费用。
// 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing （2026-11-22 核对）。价格可能调整，估算仅供参考。
// 空闲时段价格是高峰时段的一半。高峰时段＝北京时间周一至周五（不含法定节假日）9:00–12:00、14:00–18:00；
// 其余时段（含周末、法定节假日全天）都是空闲时段。
export const PRICES_AS_OF = '2026-11-22';
export const PRICE_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing';

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

/**
 * The priced model id for a model name, or null when no official price is known.
 * Accepts a bare id, a provider-qualified route (`deepseek-official/deepseek-flash`), or any case.
 */
export function pricedModel(model) {
  if (typeof model !== 'string') return null;
  const id = model.trim().toLowerCase();
  if (!id) return null;
  const short = id.slice(id.lastIndexOf('/') + 1);
  if (TABLE[id]) return id;
  if (TABLE[short]) return short;
  if (ALIASES[id]) return ALIASES[id];
  if (ALIASES[short]) return ALIASES[short];
  return null;
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
  const id = pricedModel(model);
  if (!id) return null;
  const p = TABLE[id][isPeak(time) ? 'peak' : 'offPeak'];
  return ((inputTokens + cacheWriteTokens) * p.miss + cacheReadTokens * p.hit + outputTokens * p.out) / 1e6;
}
