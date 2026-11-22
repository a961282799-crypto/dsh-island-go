import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog } from '../lib/catalog.js';
import { USD_CNY, estimateCost, priceTableFor, pricedModel, useCatalog, useOverrides } from '../lib/pricing.js';

// 北京时间周三 03:00（空闲时段），避免早晚高峰影响断言。
const T = Date.UTC(2026, 10, 17, 19, 0, 0);

const reset = () => { useCatalog(null); useOverrides(null); };

test('内置的 DeepSeek 官方价照旧，分高峰与空闲', () => {
  reset();
  const table = priceTableFor('deepseek-flash');
  assert.deepEqual(table.offPeak, { hit: 0.02, miss: 1, out: 4 });
  assert.deepEqual(table.peak, { hit: 0.04, miss: 2, out: 8 });
  // 北京时间周三 10:00 是高峰
  const peak = Date.UTC(2026, 10, 18, 2, 0, 0);
  assert.ok(Math.abs(estimateCost({ model: 'deepseek-flash', time: peak, inputTokens: 1e6 }) - 2) < 1e-9);
  assert.ok(Math.abs(estimateCost({ model: 'deepseek-flash', time: T, inputTokens: 1e6 }) - 1) < 1e-9);
});

test('引擎模型库的美元单价会折成人民币', () => {
  reset();
  useCatalog(new Map([['mimo-v2.6-flash', { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 }]]));
  const table = priceTableFor('mimo-v2.6-flash');
  assert.ok(Math.abs(table.offPeak.miss - 0.14 * USD_CNY) < 1e-9);
  const cost = estimateCost({ model: 'mimo-v2.6-flash', time: T, inputTokens: 1e6, outputTokens: 1e6 });
  assert.ok(Math.abs(cost - (0.14 + 0.28) * USD_CNY) < 1e-9, String(cost));
});

test('用户自填的价格优先于内置表和模型库', () => {
  reset();
  useCatalog(new Map([['deepseek-flash', { input: 99, output: 99, cacheRead: 99 }]]));
  assert.equal(useOverrides({ models: { 'deepseek-flash': { input: 3, output: 6, cacheRead: 0.3 } } }), 1);
  const table = priceTableFor('deepseek-flash');
  assert.equal(table.offPeak.miss, 3);
  assert.equal(table.peak.miss, 3);
  assert.deepEqual(table.peak, table.offPeak);
  reset();
});

test('自填价格可以分高峰 / 空闲两档', () => {
  reset();
  useOverrides({ models: { 'my-model': { peak: { input: 2, output: 8 }, offPeak: { input: 1, output: 4 } } } });
  const peak = Date.UTC(2026, 10, 18, 2, 0, 0);
  assert.ok(Math.abs(estimateCost({ model: 'my-model', time: peak, inputTokens: 1e6 }) - 2) < 1e-9);
  assert.ok(Math.abs(estimateCost({ model: 'my-model', time: T, inputTokens: 1e6 }) - 1) < 1e-9);
  assert.ok(Math.abs(estimateCost({ model: 'my-model', time: T, outputTokens: 1e6 }) - 4) < 1e-9);
  reset();
});

test('价格表里有 cacheWrite 就按它算，没有就按未命中算', () => {
  reset();
  useOverrides({ models: {
    'a-model': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 5 },
    'b-model': { input: 1, output: 2, cacheRead: 0.1 },
  } });
  assert.ok(Math.abs(estimateCost({ model: 'a-model', time: T, cacheWriteTokens: 1e6 }) - 5) < 1e-9);
  assert.ok(Math.abs(estimateCost({ model: 'b-model', time: T, cacheWriteTokens: 1e6 }) - 1) < 1e-9);
  reset();
});

test('没有价格的模型仍然不估价', () => {
  reset();
  assert.equal(priceTableFor('no-such-model'), null);
  assert.equal(pricedModel('no-such-model'), null);
  assert.equal(estimateCost({ model: 'no-such-model', time: T, inputTokens: 1000 }), null);
  assert.equal(pricedModel(''), null);
  assert.equal(pricedModel(undefined), null);
});

test('模型名大小写与 provider 前缀都能对上', () => {
  reset();
  useCatalog(new Map([['glm-5.3', { input: 1.4, output: 4.4, cacheRead: 0.26 }]]));
  assert.ok(priceTableFor('GLM-5.3'));
  assert.ok(priceTableFor('custom-glm/glm-5.3'));
});

test('模型库里 0 价的订阅渠道不会被当成免费', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'island-catalog-'));
  const pkg = join(root, 'node_modules', '@earendil-works', 'pi-ai');
  const data = join(pkg, 'dist', 'providers', 'data');
  await mkdir(data, { recursive: true });
  await writeFile(join(pkg, 'package.json'), '{"name":"@earendil-works/pi-ai"}');
  await writeFile(join(data, 'plan.json'), JSON.stringify({ 'openai-completions': {
    'chat:paid': { id: 'paid-model', cost: { input: 2, output: 4, cacheRead: 0.2 } },
    'chat:free': { id: 'free-plan-model', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  } }));
  try {
    const catalog = loadCatalog({ startFiles: [join(root, 'index.js')] });
    assert.deepEqual([...catalog.keys()], ['paid-model']);
    reset();
    useCatalog(catalog);
    assert.ok(priceTableFor('paid-model'));
    assert.equal(priceTableFor('free-plan-model'), null);
  } finally { reset(); await rm(root, { recursive: true, force: true }); }
});

test('找不到模型库时返回空表，不抛错', () => {
  const catalog = loadCatalog({ startFiles: ['/definitely/not/here.js'] });
  assert.equal(catalog.size, 0);
});
