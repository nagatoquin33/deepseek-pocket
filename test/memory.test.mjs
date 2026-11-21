import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeMemories, addMemory, updateMemory, removeMemory, memoriesToMessage,
} from '../public/js/memory.js';

test('记忆：归一化、去重、空文本过滤', () => {
  assert.deepEqual(normalizeMemories(null), []);
  const list = normalizeMemories([
    { id: 'a', text: ' 喜欢简洁回答 ' },
    { id: 'a', text: '重复 id' },
    { id: 'b', text: '   ' },
    { id: 'c', text: '中文' },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[0].text, '喜欢简洁回答');
  assert.equal(list[0].enabled, true);
});

test('记忆：增删改与注入消息', () => {
  let list = addMemory([], '我在上海');
  list = addMemory(list, '偏好中文');
  assert.equal(list.length, 2);
  const msg = memoriesToMessage(list);
  assert.match(msg.content, /我在上海/);
  assert.match(msg.content, /偏好中文/);
  list = updateMemory(list, list[0].id, { enabled: false });
  assert.doesNotMatch(memoriesToMessage(list).content, /我在上海/);
  list = removeMemory(list, list[0].id);
  assert.equal(list.length, 1);
  assert.equal(memoriesToMessage([]), null);
});
