import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateTokens, messagesTokens, contextUsage, formatTokens } from '../public/js/tokens.js';
import { sessionToJSONL, sessionToTXT, messageToMarkdown, safeFilename } from '../public/js/exporter.js';

const session = {
  title: '天气 / 测试',
  messages: [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好！', reasoningContent: '思考一下', citations: [{ n: 1, title: '来源', url: 'https://a.b' }] },
    { role: 'system', content: '系统' },
  ],
};

test('token 估算：中文按字、英文按 4 字，预算与格式化', () => {
  assert.equal(estimateTokens('你好'), 2);
  assert.equal(estimateTokens('abcd'), 1);
  assert.ok(estimateTokens('hello 世界') >= 3);
  assert.ok(messagesTokens(session.messages) > 0);
  const u = contextUsage(session.messages, 1000, 900);
  assert.equal(u.used, 900);
  assert.ok(u.ratio > 0 && u.ratio <= 1);
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1500), '1.5k');
  assert.equal(formatTokens(128000), '128k');
});

test('导出：JSONL 逐行合法、TXT 跳过 system、Markdown 含引用', () => {
  const jsonl = sessionToJSONL(session);
  const lines = jsonl.split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) JSON.parse(line);
  const txt = sessionToTXT(session);
  assert.match(txt, /天气 \/ 测试/);
  assert.match(txt, /你好/);
  assert.doesNotMatch(txt, /^系统$/m);
  const md = messageToMarkdown(session.messages[1]);
  assert.match(md, /思考过程/);
  assert.match(md, /参考来源/);
  assert.equal(safeFilename('a/b:c*?"<>|'), 'a b c');
});
