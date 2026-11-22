// dsh-island-go：灵动岛在 DSH Go（Android App）里的原生形态。
//
// 桌面版（dsh-island）靠 Electron 画一个置顶悬浮窗；这里不画窗口，只把同一份
// 引擎侧数据接到 App 的原生插槽上：
//   composer.strip  输入框上方一行（状态 · 上下文 · 费用）
//   panels          对话详情 › 插件 / 全部功能 里的用量面板
//   turn.note       每轮脚注末尾的估算费用
// 没有 dsh-go 桥接的主机（DSH 网页版、SSH、中转）上，这里只累积账本，不显示任何东西。
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ActivityStore } from './state.js';
import { UsageLedger } from './usage.js';
import { panelData, panelView, stripData, summaryText, turnNotes, words } from './view.js';

export const name = 'dsh-island-go';

const ACTIVE = ['thinking', 'streaming', 'tools', 'waiting', 'compacting', 'reconnecting'];

/** 每轮统计 / 近 7 天桶：每分钟或账本变了才重算，别每条事件都重扫。 */
function memoStats(ledger, now) {
  let cache;
  return (range) => {
    const stamp = Math.floor(now() / 60000);
    if (!cache || cache.version !== ledger.version || cache.stamp !== stamp) {
      const week = ledger.stats('7d');
      const today = ledger.stats('today');
      cache = { version: ledger.version, stamp, week, today };
    }
    return range === 'today' ? cache.today : cache.week;
  };
}

export function apply(ctx, options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const dataDir = options.dataDir ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-island-go');
  const file = options.ledgerPath === undefined ? join(dataDir, 'usage.json') : options.ledgerPath;
  const store = new ActivityStore(now);
  const ledger = new UsageLedger({ file, now }).load();
  const stats = memoStats(ledger, now);

  /** 面板 / 状态条 / 尾注的订阅者，收到通知就重推一次。 */
  const listeners = new Set();
  const notify = () => {
    for (const fn of listeners) {
      try { fn(); } catch { /* 一个订阅出错不能拖累别的 */ }
    }
  };
  const watch = (push) => {
    push();
    listeners.add(push);
    return () => listeners.delete(push);
  };

  /** 当前对话的上下文占用：优先用宿主的 token-meter 投影，退回本插件自己数的数。 */
  function contextOf(id, entry) {
    const tokens = Number(entry?.contextTokens) || 0;
    const window = Number(entry?.contextWindow) || 0;
    try {
      const agents = ctx.get?.('agents');
      const session = agents?.get?.(id)?.session;
      const view = session && ctx.get?.('sessionProjections')?.stateOf?.(session, 'contextPressure');
      if (view && Number(view.contextWindow) > 0) {
        return {
          tokens: Number(view.projectedTokens ?? view.pressureTokens ?? tokens) || 0,
          window: Number(view.contextWindow),
        };
      }
    } catch { /* 没有这个服务就用自己的数 */ }
    return { tokens, window };
  }

  /** 把一个 App 请求折成 view.js 要的形状。 */
  function snapshot(scope) {
    const id = typeof scope?.sessionId === 'string' ? scope.sessionId : null;
    const entry = id ? store.sessions.get(id) : undefined;
    const running = [...store.sessions.values()].filter((e) => ACTIVE.includes(e.state));
    const latest = entry ?? [...store.sessions.values()].sort((a, b) => b.updated - a.updated)[0];
    const week = stats('7d');
    const today = stats('today');
    const fold = id ? ledger.sessions.get(id)?.fold : undefined;
    // 正在跑的这一轮还没进 turns，费用要算进「今日」，否则一轮结束前一直显示 ¥0.00。
    const open = fold?.open;
    const openCost = Number(open?.cost) || 0;
    const openTokens = open ? (open.inputTokens || 0) + (open.cacheReadTokens || 0) + (open.cacheWriteTokens || 0) + (open.outputTokens || 0) : 0;
    const openUnpriced = open && open.priced === false ? openTokens : 0;
    return {
      sessionId: id,
      state: latest?.state ?? 'idle',
      activeCount: running.length,
      ctx: contextOf(id ?? latest?.id, latest),
      today: {
        ...today.totals,
        cost: (Number(today.totals?.cost) || 0) + openCost,
        unpricedTokens: (Number(today.totals?.unpricedTokens) || 0) + openUnpriced,
      },
      week: {
        labels: week.buckets.map((b) => b.label),
        values: week.buckets.map((b) => Math.round(b.cacheRead + b.input + b.output)),
      },
      models: week.models,
      turns: fold ? fold.turns.slice(-64).map((t) => ({ turn: t.turn, cost: t.cost, state: t.state, priced: t.priced, approx: t.approx })) : [],
    };
  }

  // —— 引擎侧：跟着会话事件累计状态与账本 ——
  ctx.on('session/event', (session, event) => {
    const id = session?.id;
    if (!id || !event) return;
    store.event(id, event);
    ledger.ingest(id, event);
    notify();
  }, { global: true });

  ctx.on('agent/assistant-stream', ({ agent, frame } = {}) => {
    const id = agent?.session?.id;
    if (!id || !frame) return;
    store.stream(id, frame);
    notify();
  }, { global: true });

  ctx.on('agent/status', ({ agent, status } = {}) => {
    const id = agent?.session?.id;
    if (!id) return;
    store.entry(id);
    if (status === 'running') store.set(id, 'thinking', { started: now() });
    notify();
  }, { global: true });

  ctx.on('agent/error', ({ agent } = {}) => {
    const id = agent?.session?.id;
    if (!id) return;
    store.set(id, 'error', { ended: now() });
    notify();
  }, { global: true });

  ctx.on('agent/disposed', ({ agent } = {}) => {
    const id = agent?.session?.id;
    const entry = id && store.sessions.get(id);
    if (entry && ACTIVE.includes(entry.state)) store.set(id, 'paused', { ended: now() });
    notify();
  }, { global: true });

  /** 宿主当前默认模型：会话日志已被删除、没记下模型名的历史轮次只能按它估价。 */
  const defaultModel = () => {
    try { return ctx.get?.('agentDefaultModel')?.currentSelection?.()?.model || ''; } catch { return ''; }
  };

  // 装上之前就发生的会话，用宿主自己的会话库补算一次（和桌面版同一套逻辑）。
  const backfillAbort = new AbortController();
  const backfill = () => {
    let query;
    try { query = ctx.get?.('sessionQuery'); } catch { query = undefined; }
    if (!query) { ledger.repriceMissing(defaultModel()); return; }
    ledger.backfill(query, { signal: backfillAbort.signal })
      .then((n) => { const fixed = ledger.repriceMissing(defaultModel()); if (n || fixed) notify(); }, () => {});
  };
  const firstBackfill = setTimeout(backfill, 8000);
  firstBackfill.unref?.();
  const backfillTimer = setInterval(backfill, 30 * 60000);
  backfillTimer.unref?.();

  // —— App 侧：只在有 dsh-go 桥接的主机上注册插槽 ——
  ctx.inject(['dshGo'], (child) => {
    const go = child.dshGo;
    if (!go) return;

    go.panel('island', {
      view: (scope, caps) => panelView(words(caps?.locale), typeof scope?.sessionId === 'string'),
      data: (scope, emit, caps) => watch(() => emit(panelData(snapshot(scope), caps?.locale))),
      actions: {
        copy: (scope, event) => {
          const locale = event?.locale;
          const data = panelData(snapshot(scope), locale);
          return { copy: summaryText(snapshot(scope), data, locale), toast: words(locale).copied };
        },
        refresh: () => ({ refresh: 'island' }),
      },
    });

    go.strip('status', (scope, emit, caps) => watch(() => emit(stripData(snapshot(scope), caps?.locale))));

    // 旧桥接没有 turnNote：先判断，否则后面的注册都走不到。
    if (typeof go.turnNote === 'function') {
      go.turnNote('cost', (scope, emit, caps) => watch(() => emit(turnNotes(snapshot(scope), caps?.locale))));
    }
  });

  // 账本落盘与清理。
  ctx.effect(() => () => {
    backfillAbort.abort();
    clearTimeout(firstBackfill);
    clearInterval(backfillTimer);
    listeners.clear();
    ledger.save();
  });
}
