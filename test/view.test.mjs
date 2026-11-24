import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compact, yuan, panelData, panelView, stripData, summaryText, turnNotes, words } from '../lib/view.js';

const snap = (over = {}) => ({
  state: 'thinking',
  activeCount: 1,
  ctx: { tokens: 412000, window: 1000000 },
  today: { tokens: 1240000, output: 86000, cost: 1.234, cacheRate: 72, runs: 12 },
  week: { labels: ['11/11', '11/12'], values: [1000, 2000] },
  models: [
    { model: 'deepseek-flash', tokens: 900000, cost: 0.8 },
    { model: 'deepseek-v4-pro', tokens: 340000, cost: 0.434 },
  ],
  turns: [{ turn: 1, cost: 0.02, state: 'completed' }, { turn: 2, cost: 0, state: 'completed' }],
  ...over,
});

test('compact / yuan 的边界', () => {
  assert.equal(compact(0), '0');
  assert.equal(compact(999), '999');
  assert.equal(compact(1234), '1.2K');
  assert.equal(compact(12400), '12K');
  assert.equal(compact(1240000), '1.24M');
  assert.equal(yuan(0), '¥0.00');
  assert.equal(yuan(0.004), '¥0.004');
  assert.equal(yuan(1.234), '¥1.23');
  assert.equal(yuan(1234), '¥1234');
});

test('状态条一行 ≤ 24 字，带状态、上下文、费用', () => {
  const line = stripData(snap(), 'zh');
  assert.ok(Array.from(line.text).length <= 24, line.text);
  assert.match(line.text, /^思考中/);
  assert.match(line.text, /上下文 41%/);
  assert.match(line.text, /¥1\.23$/);
  assert.equal(line.icon, 'lightbulb');
});

test('空闲时状态条不显示上下文，显示今日费用', () => {
  const line = stripData(snap({ state: 'idle', ctx: { tokens: 0, window: 0 } }), 'zh');
  assert.equal(line.text, '空闲 · 今日 ¥1.23');
  assert.equal(line.icon, 'clock');
});

test('英文状态条同样 ≤ 24 字', () => {
  const line = stripData(snap(), 'en-US');
  assert.ok(Array.from(line.text).length <= 24, line.text);
  assert.match(line.text, /^Thinking/);
});

test('上下文未知时不假装有百分比', () => {
  const data = panelData(snap({ ctx: { tokens: 412000, window: 0 } }), 'zh');
  assert.equal(data.ctx.text, '—');
  assert.equal(data.ctx.percent, 0);
  assert.equal(data.ctx.caption, '412K');
});

test('面板数据 ≤ 32 KiB，且没有 undefined', () => {
  const data = panelData(snap(), 'zh');
  assert.ok(Buffer.byteLength(JSON.stringify(data)) <= 32 * 1024);
  assert.doesNotMatch(JSON.stringify(data), /undefined/);
  assert.equal(data.today.cost, '¥1.23');
  assert.equal(data.today.hit, '72%');
  assert.equal(data.models[0].title, 'deepseek-flash');
});

const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return;
  visit(node);
  if (Array.isArray(node.children)) node.children.forEach((child) => walk(child, visit));
};

const resolvePath = (data, path) =>
  path.replace(/^data\./, '').split('.').reduce((node, key) => (node == null ? undefined : node[key]), data);

test('面板视图的每个绑定都能在数据里取到', () => {
  for (const inChat of [true, false]) {
    const view = panelView(words('zh'), inChat);
    const data = panelData(snap(), 'zh');
    walk(view, (node) => {
      for (const value of Object.values(node)) {
        if (value && typeof value === 'object' && typeof value.$ === 'string') {
          assert.match(value.$, /^data\./);
          assert.notEqual(resolvePath(data, value.$), undefined, `绑定取不到：${value.$}`);
        }
      }
    });
  }
});

test('面板视图在 32 KiB / 120 组件 / 8 层以内', () => {
  const view = panelView(words('zh'), true);
  assert.ok(Buffer.byteLength(JSON.stringify(view)) <= 32 * 1024);
  let count = 0;
  const depth = (node) => {
    if (!node || typeof node !== 'object') return 0;
    count += 1;
    const kids = Array.isArray(node.children) ? node.children : [];
    return 1 + Math.max(0, ...kids.map(depth));
  };
  assert.ok(depth(view) <= 8);
  assert.ok(count <= 120);
});

test('尾注只给有轮次的对话，文字 ≤ 16 字', () => {
  const notes = turnNotes(snap(), 'zh');
  assert.deepEqual(Object.keys(notes).sort(), ['1', '2']);
  assert.equal(notes['1'].text, '¥0.02');
  for (const note of Object.values(notes)) assert.ok(Array.from(note.text).length <= 16);
  assert.deepEqual(turnNotes(snap({ turns: [] }), 'zh'), {});
});

test('复制摘要包含状态、上下文与模型', () => {
  const data = panelData(snap(), 'zh');
  const text = summaryText(snap(), data, 'zh');
  assert.match(text, /^状态: 正在思考/);
  assert.match(text, /deepseek-flash/);
});

// —— 回归：钱算不出来时不能显示成 ¥0.00 ——
test('没定价的模型写「未定价」，不写成 0 元', () => {
  const data = panelData(snap({ models: [{ model: '', tokens: 100000, cost: 0, priced: false }] }), 'zh');
  assert.equal(data.models[0].title, '未知模型');
  assert.match(data.models[0].trailing, /未定价/);
});

test('今日有没定价的调用时不写成确定的数', () => {
  assert.equal(panelData(snap(), 'zh').today.cost, '¥1.23');
  assert.equal(panelData(snap({ today: { ...snap().today, unpricedTokens: 1000 } }), 'zh').today.cost, '≈¥1.23');
  assert.equal(panelData(snap({ today: { ...snap().today, cost: 0, unpricedTokens: 1000 } }), 'zh').today.cost, '—');
});

test('补估的费用加约等号', () => {
  const notes = turnNotes(snap({ turns: [{ turn: 3, cost: 0.5, state: 'completed', priced: true, approx: true }] }), 'zh');
  assert.equal(notes['3'].text, '≈¥0.50');
});

test('英文状态条放不下时先省上下文，不截断金额', () => {
  const line = stripData(snap({ state: 'completed', ctx: { tokens: 40000, window: 1000000 } }), 'en-US');
  assert.ok(Array.from(line.text).length <= 24, line.text);
  assert.doesNotMatch(line.text, /¥0…/);
  assert.match(line.text, /¥1\.23$/);
});
