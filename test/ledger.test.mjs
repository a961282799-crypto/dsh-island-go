import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnFold, UsageLedger } from '../lib/usage.js';
import { estimateCost, useCatalog } from '../lib/pricing.js';

// 北京时间周三 03:00（空闲时段），避免早晚高峰影响断言。
const T = Date.UTC(2026, 10, 17, 19, 0, 0);
const usage = { inputTokens: 1000, cacheReadTokens: 2000, cacheWriteTokens: 0, outputTokens: 500 };
const events = [
  { seq: 1, time: T, type: 'turn/start', data: { turn: 1 } },
  { seq: 2, time: T, type: 'model/selection', data: { model: 'deepseek-flash' } },
  { seq: 3, time: T + 1000, type: 'assistant/message', data: { usage } },
  { seq: 4, time: T + 2000, type: 'turn/end', data: { reason: { kind: 'completed' } } },
];

test('一轮事件折成一条带费用的记录', () => {
  const fold = new TurnFold();
  for (const event of events) fold.push(event);
  assert.equal(fold.turns.length, 1);
  const [turn] = fold.turns;
  assert.equal(turn.state, 'completed');
  assert.equal(turn.model, 'deepseek-flash');
  assert.equal(turn.calls, 1);
  const expected = estimateCost({ model: 'deepseek-flash', time: T + 1000, ...usage });
  assert.ok(Math.abs(turn.cost - expected) < 1e-12);
});

test('重复 seq 不会把同一轮算两次', () => {
  const fold = new TurnFold();
  for (const event of events) fold.push(event);
  for (const event of events) fold.push(event);
  assert.equal(fold.turns.length, 1);
  assert.equal(fold.turns[0].calls, 1);
});

test('没有官方价格的模型不计费，但 tokens 照记', () => {
  const fold = new TurnFold();
  fold.push({ seq: 1, time: T, type: 'turn/start', data: { turn: 1 } });
  fold.push({ seq: 2, time: T, type: 'model/selection', data: { model: 'some-other-model' } });
  fold.push({ seq: 3, time: T + 1, type: 'assistant/message', data: { usage } });
  fold.push({ seq: 4, time: T + 2, type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(fold.turns[0].cost, 0);
  assert.equal(fold.turns[0].priced, false);
});

test('账本按模型与会话汇总，并给出成本', () => {
  const ledger = new UsageLedger({ now: () => T + 5000 });
  for (const event of events) ledger.ingest('s1', event);
  const week = ledger.stats('7d');
  assert.equal(week.models.length, 1);
  assert.equal(week.models[0].model, 'deepseek-flash');
  assert.equal(week.sessions.length, 1);
  assert.equal(week.totals.turns, 1);
  assert.equal(week.totals.completed, 1);
  assert.ok(week.totals.cost > 0);
  assert.equal(week.totals.tokens, 3500);
});

test('中断的轮次记为 paused，不计入 completed', () => {
  const ledger = new UsageLedger({ now: () => T + 5000 });
  ledger.ingest('s1', { seq: 1, time: T, type: 'turn/start', data: { turn: 1 } });
  ledger.ingest('s1', { seq: 2, time: T, type: 'turn/end', data: { reason: { kind: 'aborted' } } });
  const week = ledger.stats('7d');
  assert.equal(week.totals.turns, 1);
  assert.equal(week.totals.completed, 0);
  assert.equal(week.sessions[0].items[0].state, 'paused');
});

// —— 回归：模型名只出现在 assistant/message 的 message.source 里（0.1.0 的 bug）——
const turnWithSource = (model, extra = []) => [
  { seq: 1, time: T, type: 'turn/start', data: { turn: 1 } },
  ...extra,
  { seq: 9, time: T + 1000, type: 'assistant/message', data: {
    message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model } }, usage } },
  { seq: 10, time: T + 2000, type: 'turn/end', data: { reason: { kind: 'completed' } } },
];

test('模型只写在 assistant/message 的 message.source 里也能认出来', () => {
  const fold = new TurnFold();
  for (const event of turnWithSource('deepseek-flash')) fold.push(event);
  const [turn] = fold.turns;
  assert.equal(turn.model, 'deepseek-flash');
  assert.equal(turn.priced, true);
  assert.ok(Math.abs(turn.cost - estimateCost({ model: 'deepseek-flash', time: T + 1000, ...usage })) < 1e-12);
});

test('请求头里的路由模型也能兜底', () => {
  const fold = new TurnFold();
  fold.push({ seq: 1, time: T, type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } } });
  fold.push({ seq: 2, time: T, type: 'turn/start', data: { turn: 1 } });
  fold.push({ seq: 3, time: T + 1, type: 'assistant/message', data: { usage } });
  fold.push({ seq: 4, time: T + 2, type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(fold.turns[0].model, 'deepseek-flash');
  assert.ok(fold.turns[0].cost > 0);
});

test('一轮里换模型时按每次调用自己的模型计费', () => {
  const fold = new TurnFold();
  fold.push({ seq: 1, time: T, type: 'turn/start', data: { turn: 1 } });
  fold.push({ seq: 2, time: T, type: 'assistant/message', data: { usage, message: { content: [], source: { model: 'deepseek-flash' } } } });
  fold.push({ seq: 3, time: T + 1, type: 'assistant/message', data: { usage, message: { content: [], source: { model: 'deepseek-v4-pro' } } } });
  fold.push({ seq: 4, time: T + 2, type: 'turn/end', data: { reason: { kind: 'completed' } } });
  const [turn] = fold.turns;
  const expected = estimateCost({ model: 'deepseek-flash', time: T, ...usage }) + estimateCost({ model: 'deepseek-v4-pro', time: T + 1, ...usage });
  assert.ok(Math.abs(turn.cost - expected) < 1e-12, `cost=${turn.cost} expected=${expected}`);
  assert.equal(turn.model, 'deepseek-v4-pro');
});

test('压缩上下文的摘要用量也计费', () => {
  const fold = new TurnFold();
  fold.push({ seq: 1, time: T, type: 'turn/start', data: { turn: 1 } });
  fold.push({ seq: 2, time: T + 1, type: 'compaction/summary', data: { provider: 'deepseek-official', model: 'deepseek-flash', usage } });
  fold.push({ seq: 3, time: T + 2, type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.ok(fold.turns[0].cost > 0);
});

test('旧版本账本加载后会被标成待补算', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'island-'));
  const file = join(dir, 'usage.json');
  const legacy = { version: 1, sessions: { s1: { createdAt: T, scanned: true, title: '', model: '', lastSeq: 4, turns: [
    { turn: 1, start: T, end: T + 2000, state: 'completed', model: '', calls: 1, tools: 0, inputTokens: 1000, cacheReadTokens: 2000, cacheWriteTokens: 0, outputTokens: 500, cost: 0, priced: false },
  ] } } };
  await writeFile(file, JSON.stringify(legacy));
  try {
    const ledger = new UsageLedger({ file, now: () => T + 5000 }).load();
    assert.equal(ledger.sessions.get('s1').scanned, false);
    const fixed = ledger.reprice('deepseek-flash');
    assert.equal(fixed, 1);
    const turn = ledger.sessions.get('s1').fold.turns[0];
    assert.equal(turn.model, 'deepseek-flash');
    assert.equal(turn.approx, true);
    assert.ok(turn.cost > 0);
    assert.equal(ledger.stats('7d').totals.unpricedTokens, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// —— 回归：后来才有价格的模型会把之前没算的轮次补上 ——
test('接入模型库之后，之前没定价的轮次会被补算', () => {
  const ledger = new UsageLedger({ now: () => T + 5000 });
  for (const event of turnWithSource('mimo-v2.6-flash')) ledger.ingest('s1', event);
  assert.equal(ledger.sessions.get('s1').fold.turns[0].priced, false);

  useCatalog(new Map([['mimo-v2.6-flash', { input: 0.14, output: 0.28, cacheRead: 0.0028 }]]));
  try {
    assert.equal(ledger.reprice(), 1);
    const turn = ledger.sessions.get('s1').fold.turns[0];
    assert.equal(turn.priced, true);
    assert.ok(turn.cost > 0);
    assert.equal(turn.approx, undefined); // 是按官方价算的，不是补估
    assert.equal(ledger.stats('7d').totals.unpricedTokens, 0);
    // 已经有价的轮次不会被重算
    const before = turn.cost;
    assert.equal(ledger.reprice(), 0);
    assert.equal(turn.cost, before);
  } finally { useCatalog(null); }
});
