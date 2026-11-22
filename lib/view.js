// 折成 App 能画的三样东西：状态条一行字（≤ 24 字）、面板的视图与数据、每轮费用的尾注。
// 纯函数，不碰 ctx，方便单测：index.js 只负责把引擎侧的快照喂进来。

const SHORT = {
  idle: { zh: '空闲', en: 'Idle' },
  thinking: { zh: '思考中', en: 'Thinking' },
  streaming: { zh: '回答中', en: 'Replying' },
  tools: { zh: '执行中', en: 'Tools' },
  waiting: { zh: '待确认', en: 'Waiting' },
  completed: { zh: '已完成', en: 'Done' },
  paused: { zh: '已暂停', en: 'Paused' },
  error: { zh: '出错', en: 'Error' },
  reconnecting: { zh: '重试中', en: 'Retrying' },
  compacting: { zh: '整理中', en: 'Compacting' },
  offline: { zh: '已断开', en: 'Offline' },
};

const LONG = {
  idle: { zh: '随时待命', en: 'Idle' },
  thinking: { zh: '正在思考', en: 'Thinking' },
  streaming: { zh: '正在回答', en: 'Replying' },
  tools: { zh: '正在执行', en: 'Running tools' },
  waiting: { zh: '等待你确认', en: 'Waiting for you' },
  completed: { zh: '已完成', en: 'Done' },
  paused: { zh: '已暂停', en: 'Paused' },
  error: { zh: '需要留意', en: 'Needs attention' },
  reconnecting: { zh: '正在重试', en: 'Retrying' },
  compacting: { zh: '整理上下文', en: 'Compacting' },
  offline: { zh: '连接已断开', en: 'Offline' },
};

const ICON = {
  idle: 'clock',
  thinking: 'lightbulb',
  streaming: 'chat',
  tools: 'wrench',
  waiting: 'question',
  completed: 'check',
  paused: 'pause',
  error: 'warning',
  reconnecting: 'refresh',
  compacting: 'archive',
  offline: 'power',
};

const WORDS = {
  zh: {
    code: 'zh',
    status: '状态',
    active: '进行中',
    context: '上下文',
    today: '今日',
    costToday: '今日费用',
    tokens: 'tokens',
    output: '输出',
    hit: '缓存命中',
    turns: '轮次',
    week: '近 7 天 · tokens',
    models: '按模型',
    unknown: '未知模型',
    unpriced: '未定价',
    copy: '复制摘要',
    copied: '已复制',
    refresh: '刷新',
    empty: '暂无数据',
    offline: '连接已断开',
    desktop: '桌面悬浮窗是 DSH Desktop 版（dsh-island）；这里是同一个数据源的输入框状态条与面板。',
  },
  en: {
    code: 'en',
    status: 'Status',
    active: 'Active',
    context: 'Context',
    today: 'Today',
    costToday: 'Cost today',
    tokens: 'tokens',
    output: 'Output',
    hit: 'Cache hits',
    turns: 'Turns',
    week: 'Last 7 days · tokens',
    models: 'By model',
    unknown: 'Unknown model',
    unpriced: 'unpriced',
    copy: 'Copy summary',
    copied: 'Copied',
    refresh: 'Refresh',
    empty: 'No data',
    offline: 'Disconnected',
    desktop: 'The floating window is the DSH Desktop plugin (dsh-island); this is the same feed as a composer strip and a panel.',
  },
};

/** zh 除非 App 说是英文。 */
export function words(locale) {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('en') ? WORDS.en : WORDS.zh;
}

const clamp = (text, max) => {
  const chars = Array.from(String(text ?? ''));
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join('')}…` : chars.join('');
};

/** 1234 → 1.2K；1234567 → 1.23M；1000000 → 1M。 */
export function compact(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '0';
  const trim = (text) => text.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${trim((n / 1e3).toFixed(n < 1e4 ? 1 : 0))}K`;
  return `${trim((n / 1e6).toFixed(n < 1e7 ? 2 : 1))}M`;
}

/** 费用：不到一分钱时多留一位，免得全显示 ¥0.00。 */
export function yuan(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '¥0.00';
  if (n < 0.01) return `¥${n.toFixed(3)}`;
  if (n < 1000) return `¥${n.toFixed(2)}`;
  return `¥${Math.round(n)}`;
}

/** 有价才算钱；没价明确写「—」，不能显示成 ¥0.00 让人以为免费；模型是补估的加约等号。 */
const money = (value, priced, approx) => (priced === false ? '—' : approx ? `≈${yuan(value)}` : yuan(value));

/** 一段时间的费用文字：掺了没定价的调用时别写成确定数——全没价写「—」，部分没价或补估的加约等号。 */
const costText = (value, unpriced, approx) => {
  const n = Number(value) || 0, u = Number(unpriced) || 0, a = Number(approx) || 0;
  if (u > 0 && n <= 0) return '—';
  if (u > 0 || a > 0) return `≈${yuan(n)}`;
  return yuan(n);
};

const percent = (tokens, window) => {
  if (!Number.isFinite(tokens) || !Number.isFinite(window) || window <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((tokens / window) * 100)));
};

/** 面板的视图：结构固定，数字都是对 data 的绑定，桥接只推增量。 */
export function panelView(w, inChat) {
  const lead = inChat
    ? [{ type: 'metric', label: w.status, value: { $: 'data.stateLabel' } }]
    : [
        { type: 'metric', label: w.status, value: { $: 'data.stateLabel' } },
        { type: 'metric', label: w.active, value: { $: 'data.activeCount' } },
      ];
  return {
    type: 'stack',
    children: [
      {
        type: 'row',
        children: [
          ...lead,
          { type: 'metric', label: w.context, value: { $: 'data.ctx.text' } },
          { type: 'metric', label: w.costToday, value: { $: 'data.today.cost' } },
        ],
      },
      {
        type: 'progress',
        label: w.context,
        value: { $: 'data.ctx.percent' },
        caption: { $: 'data.ctx.caption' },
      },
      {
        type: 'chart',
        kind: 'bar',
        categories: { $: 'data.week.labels' },
        series: [{ name: 'tokens', values: { $: 'data.week.values' } }],
        caption: w.week,
      },
      { type: 'text', text: w.models, tone: 'muted' },
      { type: 'list', items: { $: 'data.models' } },
      { type: 'text', text: w.today, tone: 'muted' },
      {
        type: 'keyValue',
        items: [
          [w.tokens, { $: 'data.today.tokens' }],
          [w.output, { $: 'data.today.output' }],
          [w.hit, { $: 'data.today.hit' }],
          [w.turns, { $: 'data.today.turns' }],
        ],
      },
      {
        type: 'actions',
        items: [
          { label: w.copy, icon: 'summary', action: 'copy' },
          { label: w.refresh, icon: 'refresh', action: 'refresh' },
        ],
      },
      { type: 'callout', tone: 'info', text: w.desktop },
    ],
  };
}

const keyOf = (state) => (typeof state === 'string' && SHORT[state] ? state : 'idle');

/** 面板绑的数据：数字和模型名，文字按 App 的语言取。 */
export function panelData(snap, locale) {
  const w = words(locale);
  const state = keyOf(snap?.state);
  const { tokens, window } = snap?.ctx ?? {};
  const today = snap?.today ?? {};
  const week = snap?.week ?? {};
  const models = Array.isArray(snap?.models) ? snap.models : [];
  return {
    stateLabel: LONG[state][w.code],
    activeCount: String(snap?.activeCount ?? 0),
    ctx: {
      percent: percent(tokens, window),
      text: percent(tokens, window) ? `${percent(tokens, window)}%` : '—',
      caption: window > 0 ? `${compact(tokens)} / ${compact(window)}` : compact(tokens),
    },
    today: {
      cost: costText(today.cost, today.unpricedTokens, today.approxTokens),
      tokens: compact(today.tokens),
      output: compact(today.output),
      hit: Number.isFinite(today.cacheRate) ? `${today.cacheRate}%` : '—',
      turns: String(today.turns ?? 0),
    },
    week: {
      labels: Array.isArray(week.labels) ? week.labels : [],
      values: Array.isArray(week.values) ? week.values : [],
    },
    models: models.slice(0, 8).map((m) => ({
      title: String(m.model || w.unknown),
      trailing: `${compact(m.tokens)} · ${m.priced === false ? w.unpriced : money(m.cost, true, Number(m.approx) > 0)}`,
      icon: 'model',
    })),
  };
}

/**
 * 状态条这一行（≤ 24 字）。
 * 有任务：`思考中 · 上下文 38% · ¥0.42`；空闲：`空闲 · 今日 ¥1.20`。
 */
export function stripData(snap, locale) {
  const w = words(locale);
  const state = keyOf(snap?.state);
  const { tokens, window } = snap?.ctx ?? {};
  const pct = percent(tokens, window);
  const cost = costText(snap?.today?.cost, snap?.today?.unpricedTokens, snap?.today?.approxTokens);
  // 一行只有 24 字：放不下就先省掉上下文百分比，也不要截断费用数字。
  const line = (withContext) => {
    const parts = [SHORT[state][w.code]];
    if (withContext && pct > 0) parts.push(`${w.context} ${pct}%`);
    parts.push(state === 'idle' ? `${w.today} ${cost}` : cost);
    return parts.join(' · ');
  };
  const full = line(true);
  return { text: clamp(Array.from(full).length > 24 ? line(false) : full, 24), icon: ICON[state] ?? 'chart' };
}

/** 每轮费用尾注：{ 轮次: { text } }，≤ 16 字。 */
export function turnNotes(snap, locale) {
  const w = words(locale);
  const turns = Array.isArray(snap?.turns) ? snap.turns : [];
  const out = {};
  for (const turn of turns.slice(-64)) {
    const n = Number.isFinite(turn?.turn) ? turn.turn : null;
    if (n === null || n <= 0) continue;
    out[String(n)] = { text: clamp(money(turn.cost, turn.priced, turn.approx), 16) };
  }
  return out;
}

/** 复制按钮写进剪贴板的纯文本。 */
export function summaryText(snap, data, locale) {
  const w = words(locale);
  const lines = [
    `${w.status}: ${data.stateLabel}`,
    `${w.context}: ${data.ctx.caption}`,
    `${w.today}: ${data.today.tokens} tokens · ${data.today.cost} · ${w.hit} ${data.today.hit} · ${w.turns} ${data.today.turns}`,
  ];
  for (const m of data.models) lines.push(`- ${m.title}: ${m.trailing}`);
  return lines.join('\n');
}
