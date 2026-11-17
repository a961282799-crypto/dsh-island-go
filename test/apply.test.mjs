import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

/** 一个够用的假宿主：事件、注入、插槽注册都记下来，方便断言。 */
function fakeHost() {
  const handlers = new Map();
  const effects = [];
  const slots = { panels: new Map(), strips: new Map(), notes: new Map() };
  const dshGo = {
    panel: (id, spec) => slots.panels.set(id, spec),
    strip: (id, fn) => slots.strips.set(id, fn),
    turnNote: (id, fn) => slots.notes.set(id, fn),
    refresh: () => {},
  };
  const ctx = {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
      return () => {};
    },
    inject(names, fn) {
      if (names.includes('dshGo')) fn(Object.assign(Object.create(ctx), { dshGo }));
    },
    get() {
      return undefined;
    },
    effect(fn) {
      effects.push(fn());
    },
  };
  return { ctx, handlers, slots, emit: (name, ...args) => (handlers.get(name) ?? []).forEach((fn) => fn(...args)) };
}

const usage = { inputTokens: 1200, cacheReadTokens: 3000, cacheWriteTokens: 0, outputTokens: 800 };
const at = Date.UTC(2026, 10, 17, 19, 0, 0);

test('装上后注册三个插槽，且都能立刻给出数据', () => {
  const host = fakeHost();
  apply(host.ctx, { ledgerPath: null, now: () => at });
  assert.deepEqual([...host.slots.panels.keys()], ['island']);
  assert.deepEqual([...host.slots.strips.keys()], ['status']);
  assert.deepEqual([...host.slots.notes.keys()], ['cost']);

  const out = [];
  host.slots.strips.get('status')({ sessionId: 's1' }, (data) => out.push(data), { locale: 'zh' });
  assert.equal(out.at(-1).text, '空闲 · 今日 ¥0.00');
});

test('一轮跑完后状态条变为已完成、带上下文与费用，面板同源', () => {
  const host = fakeHost();
  apply(host.ctx, { ledgerPath: null, now: () => at + 5000 });
  const session = { id: 's1' };
  host.emit('session/event', session, { seq: 1, time: at, type: 'turn/start', data: { turn: 1 } });
  host.emit('session/event', session, { seq: 2, time: at, type: 'request/context', data: { contextWindow: 1000000 } });
  host.emit('session/event', session, { seq: 3, time: at + 1, type: 'model/selection', data: { model: 'deepseek-flash' } });
  host.emit('session/event', session, { seq: 4, time: at + 2, type: 'assistant/message', data: { usage } });
  host.emit('session/event', session, { seq: 5, time: at + 3, type: 'turn/end', data: { reason: { kind: 'completed' } } });

  const strip = [];
  host.slots.strips.get('status')({ sessionId: 's1' }, (data) => strip.push(data), { locale: 'zh' });
  const last = strip.at(-1);
  assert.match(last.text, /^已完成/);
  assert.match(last.text, /¥0\.004$/);
  assert.equal(last.icon, 'check');

  const data = [];
  host.slots.panels.get('island').data({ sessionId: 's1' }, (d) => data.push(d), { locale: 'zh' });
  const panel = data.at(-1);
  assert.equal(panel.stateLabel, '已完成');
  assert.equal(panel.today.turns, '1');
  assert.equal(panel.today.tokens, '5K');
  assert.equal(panel.ctx.caption, '4.2K / 1M');
  assert.equal(panel.models[0].title, 'deepseek-flash');

  const notes = [];
  host.slots.notes.get('cost')({ sessionId: 's1' }, (n) => notes.push(n), { locale: 'zh' });
  assert.ok(notes.at(-1)['1']);
  assert.match(notes.at(-1)['1'].text, /^¥0\.0/);
});

test('没有对话时面板也拿得到数据（全部功能页）', () => {
  const host = fakeHost();
  apply(host.ctx, { ledgerPath: null, now: () => at });
  const data = [];
  host.slots.panels.get('island').data({}, (d) => data.push(d), { locale: 'en' });
  assert.equal(data.at(-1).stateLabel, 'Idle');
  assert.equal(data.at(-1).today.cost, '¥0.00');
});
