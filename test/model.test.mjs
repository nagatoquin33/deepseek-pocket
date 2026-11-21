import assert from 'node:assert/strict';
import test from 'node:test';
import { composeRequestBody } from '../public/js/chat.js';

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
