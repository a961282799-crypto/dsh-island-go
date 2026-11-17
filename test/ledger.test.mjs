import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnFold, UsageLedger } from '../lib/usage.js';
import { estimateCost } from '../lib/pricing.js';

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
