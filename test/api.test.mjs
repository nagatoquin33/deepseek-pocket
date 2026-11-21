import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '../public/js/api.js';
import { createAssistantMessage, applyChunk, renderAssistantBody } from '../public/js/chat.js';

const fragment = { choices: [{ delta: { content: '半截回答' } }] };

test('收到结束信号即完成，不等待连接关闭', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(fragment)}\r\n\r\ndata: [DONE]\r\n\r\n`));
    },
  })));
  const events = [];
  await createClient().chat({}, { onEvent: (chunk) => events.push(chunk) });
  assert.deepEqual(events, [fragment, { done: true }]);
});

test('未收到结束信号则报告中断，保留已收到的部分回答', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(`data: ${JSON.stringify(fragment)}\n\n`));
  const message = createAssistantMessage();
  await assert.rejects(
    createClient().chat({}, { onEvent: (chunk) => applyChunk(message, chunk) }),
    (error) => {
      assert.equal(error.type, 'stream_interrupted');
      assert.equal(error.retryable, true);
      message.error = error.message;
      return true;
    },
  );
  const rendered = renderAssistantBody(message);
  assert.match(rendered, /半截回答/);
  assert.match(rendered, /连接中断/);
});

test('无换行的结束信号也能正常完成', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(fragment) + '\n\ndata: [DONE]'));
        controller.close();
      },
    }),
  ));
  const events = [];
  await createClient().chat({}, { onEvent: (chunk) => events.push(chunk) });
  assert.deepEqual(events, [fragment, { done: true }]);
});
