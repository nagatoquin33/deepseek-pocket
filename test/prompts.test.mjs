import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizePrompts, promptsToMessages, addPrompt, updatePrompt, removePrompt,
  movePrompt, migrateLegacy, DEFAULT_PROMPTS, PROMPT_PRESETS,
} from '../public/js/prompts.js';

test('归一化：缺字段、非法 role、重复 id、非数组', () => {
  assert.equal(normalizePrompts(null).length, DEFAULT_PROMPTS.length);
  const list = normalizePrompts([
    { id: 'a', name: 'A', role: 'weird', content: 'x' },
    { id: 'a', name: 'dup', content: 'y' },
    null,
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].role, 'system');
  assert.equal(list[0].enabled, true);
});

test('promptsToMessages：按顺序、合并相邻 system、跳过禁用/空块', () => {
  const msgs = promptsToMessages([
    { id: '1', role: 'system', content: 'A', enabled: true },
    { id: '2', role: 'system', content: 'B', enabled: true },
    { id: '3', role: 'user', content: 'C', enabled: true },
    { id: '4', role: 'system', content: 'D', enabled: false },
    { id: '5', role: 'system', content: '   ', enabled: true },
  ]);
  assert.deepEqual(msgs, [
    { role: 'system', content: 'A\n\nB' },
    { role: 'user', content: 'C' },
  ]);
});

test('增删改与移动顺序', () => {
  let list = addPrompt([], { name: '甲', content: '1' });
  assert.equal(list.length, 1);
  list = updatePrompt(list, list[0].id, { enabled: false, content: '2' });
  assert.equal(list[0].enabled, false);
  assert.equal(list[0].content, '2');
  list = addPrompt(list, { name: '乙', content: '3' });
  const first = list[0].id;
  list = movePrompt(list, first, 1);
  assert.equal(list[1].id, first);
  assert.equal(movePrompt(list, first, 1)[1].id, first); // 越界不变
  list = removePrompt(list, first);
  assert.equal(list.some((p) => p.id === first), false);
});

test('旧 systemPrompt 迁移为第一块', () => {
  const list = migrateLegacy('自定义设定');
  assert.equal(list[0].content, '自定义设定');
  assert.equal(list[0].enabled, true);
  assert.ok(list.length >= 2);
  assert.equal(migrateLegacy('  ').length, DEFAULT_PROMPTS.length);
  assert.equal(PROMPT_PRESETS.length >= 3, true);
});
