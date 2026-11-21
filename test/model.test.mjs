import assert from 'node:assert/strict';
import test from 'node:test';
import { composeRequestBody, trimConversation } from '../public/js/chat.js';

const settings = {
  model: 'deepseek-flash',
  thinking: false,
  webSearch: false,
  safety: false,
  language: '中文',
  location: '上海',
  systemPrompt: '',
  prompts: [],
};

test('会话模型优先于全局默认模型', () => {
  const session = { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }], thinking: false, webSearch: false };
  const body = composeRequestBody({ session, settings });
  assert.equal(body.model, 'deepseek-v4-pro');
});

test('没有会话模型时回落到设置', () => {
  const session = { messages: [{ role: 'user', content: 'hi' }], thinking: false, webSearch: false };
  const body = composeRequestBody({ session, settings });
  assert.equal(body.model, 'deepseek-flash');
});

test('带图片的会话自动使用 Flash', () => {
  const session = {
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: '看图', attachments: [{ kind: 'image', url: 'data:image/png;base64,AAA' }] }],
  };
  const body = composeRequestBody({ session, settings });
  assert.equal(body.model, 'deepseek-flash');
});

test('上下文预算：短对话不裁剪，超限保留最近消息', () => {
  const short = [{ role: 'user', content: 'hi' }];
  assert.equal(trimConversation(short, 1000000).trimmed, 0);
  const big = [];
  for (let i = 0; i < 400; i++) big.push({ role: 'user', content: '长'.repeat(3000) });
  const { trimmed, messages } = trimConversation(big, 1000000);
  assert.ok(trimmed > 0);
  assert.ok(messages.length < big.length);
  assert.equal(messages[messages.length - 1].content, big[big.length - 1].content);
});
