import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const source = readFileSync(join(root, 'lib/index.js'), 'utf8');

test('包名、bundle patch 与 patch 里的 id 完全一致', () => {
  assert.equal(pkg.name, 'dsh-island-go');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, new RegExp(`id: ${pkg.name}\\b`));
  assert.match(patch, new RegExp(`name: ${pkg.name}\\b`));
});

test('npm 包里带 lib、patch、README 与许可证', () => {
  for (const entry of ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(pkg.files.includes(entry), `files 缺少 ${entry}`);
  }
});

test('dshGo 清单是 v1，插槽 id 合规且唯一', () => {
  assert.equal(pkg.dshGo.v, 1);
  const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
  const seen = new Set();
  for (const [surface, items] of Object.entries(pkg.dshGo.contributes)) {
    assert.ok(Array.isArray(items) && items.length, `${surface} 为空`);
    for (const item of items) {
      assert.match(item.id, idPattern);
      assert.ok(!seen.has(item.id), `插槽 id 重复：${item.id}`);
      seen.add(item.id);
    }
  }
});

test('清单声明的位置，代码里都真的注册了', () => {
  for (const [surface, items] of Object.entries(pkg.dshGo.contributes)) {
    for (const item of items) {
      if (surface === 'composer.strip') assert.match(source, new RegExp(`\\.strip\\('${item.id}'`));
      else if (surface === 'panels') assert.match(source, new RegExp(`\\.panel\\('${item.id}'`));
      else if (surface === 'turn.note') assert.match(source, new RegExp(`\\.turnNote\\('${item.id}'`));
      else assert.fail(`测试没覆盖的新插槽：${surface}`);
    }
  }
});

test('strip 指向的面板存在', () => {
  const panels = new Set(pkg.dshGo.contributes.panels.map((p) => p.id));
  for (const item of pkg.dshGo.contributes['composer.strip']) {
    if (item.panel) assert.ok(panels.has(item.panel), `strip 指向不存在的面板 ${item.panel}`);
  }
});

test('兼容范围与 DSH Go 内置引擎（0.2.2-rc.1）相符', () => {
  assert.equal(pkg.engines.dsh, '>=0.2.2-rc.1 <0.3.0-0');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'lib/index.js');
});
