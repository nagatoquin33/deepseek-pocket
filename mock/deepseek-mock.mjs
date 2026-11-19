/**
 * 离线 Mock 上游：完整模拟 DeepSeek 开放平台的相关端点。
 *
 * 用途：
 * - `node server.mjs --mock` 时由 server.mjs 在本机随机端口启动，代理层仍走真实转发逻辑，
 *   因此流式透传、鉴权、限流、错误处理都能离线联调；
 * - e2e / 截图 / 演示不依赖外网与真实 API Key。
 *
 * 覆盖端点：
 *   POST /chat/completions（SSE 与普通 JSON）
 *   POST /v1/tools/search、/v1/tools/fetch、/v1/tools/tts、/v1/tools/asr、/v1/tools/ocr
 *   POST /files
 *   GET  /user/balance、/models
 *
 * 特殊开关：请求体 model 为 "mock-slow" 时，每个 SSE 块延时 120ms，便于肉眼观察流式效果。
 */
import http from 'node:http';
import {
  ASR_TEXT,
  ANSWER_CHUNKS,
  OCR_TEXT,
  REASONING_CHUNKS,
  SAMPLE_TITLE,
  createSineWav,
  sampleAnnotations,
  sampleFetchedPage,
  sampleSearchResults,
} from './data.mjs';

const MAX_BODY = 110 * 1024 * 1024; // 与契约里 /api/files 上限一致
const SILENT = { info() {}, warn() {}, error() {} };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 读取请求体前缀（最多 8KB），其余流式丢弃。
 * Mock 只需要判断 model/stream/format 等小字段，不必缓冲大文件。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<{prefix: string, bytes: number, tooLarge: boolean}>}
 */
function readPrefix(req) {
  return new Promise((resolve) => {
    let prefix = '';
    let bytes = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY) tooLarge = true;
      if (prefix.length < 8192) {
        prefix += chunk.toString('utf8', 0, Math.min(chunk.length, 8192 - prefix.length));
      }
    });
    req.on('end', () => resolve({ prefix, bytes, tooLarge }));
    req.on('error', () => resolve({ prefix, bytes, tooLarge }));
    req.on('aborted', () => resolve({ prefix, bytes, tooLarge }));
  });
}

/** 从 JSON 文本前缀里宽容地抠出字段 */
function pickString(text, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  return match ? match[1] : undefined;
}

function pickBoolean(text, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*(true|false)`).exec(text);
  return match ? match[1] === 'true' : undefined;
}

/**
 * 流式 multipart 消费：只统计字节数并抓取 filename，不把文件读进内存。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<{filename: string, bytes: number, contentType: string}>}
 */
function consumeMultipart(req) {
  return new Promise((resolve) => {
    let prefix = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (prefix.length < 8192) {
        prefix += chunk.toString('utf8', 0, Math.min(chunk.length, 8192 - prefix.length));
      }
    });
    const done = () => {
      const filenameMatch = /filename="([^"]*)"/i.exec(prefix);
      const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(prefix);
      // 从首个 8KB 里抠出简单的文本字段（例如 purpose=assistants）
      const fields = {};
      const fieldRe = /name="([^"]+)"\r\n(?:[^\r\n]*\r\n)*?\r\n([^\r\n]*)/g;
      let match;
      while ((match = fieldRe.exec(prefix)) !== null) {
        if (match[1] !== 'file') fields[match[1]] = match[2];
      }
      resolve({
        filename: filenameMatch ? filenameMatch[1] : 'upload.bin',
        bytes,
        contentType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
        fields,
      });
    };
    req.on('end', done);
    req.on('error', done);
    req.on('aborted', done);
  });
}

function sendJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 创建一个带 send 能力的 SSE 响应对象 */
function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  if (typeof res.socket?.setNoDelay === 'function') res.socket.setNoDelay(true);

  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  return {
    get closed() {
      return closed;
    },
    /** 发送一个 data: {...} 事件块 */
    send(payload) {
      if (closed || res.writableEnded) return false;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      return true;
    },
    /** 发送原始 data 行（用于 [DONE]） */
    sendRaw(text) {
      if (closed || res.writableEnded) return false;
      res.write(`data: ${text}\n\n`);
      return true;
    },
    end() {
      if (!closed && !res.writableEnded) res.end();
    },
  };
}

/** 构造一个 OpenAI 兼容的流式 chunk */
function chunkFrame(state, delta, extra = {}) {
  return {
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: null }],
    ...extra,
  };
}

/**
 * /chat/completions：流式输出完整演示序列。
 * 顺序：role -> reasoning_content 多块 -> server_tool_calls(search) -> 搜索结果
 *      -> 正文（含 [1][2][3]）-> annotations -> delta.title -> usage -> [DONE]
 */
async function streamChat(req, res, model) {
  const state = {
    id: `chatcmpl-mock-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    created: Math.floor(Date.now() / 1000),
    model: model === 'mock-slow' ? 'deepseek-flash' : model,
  };
  const slow = model === 'mock-slow';
  const delay = () => (slow ? 120 : 15 + Math.floor(Math.random() * 16));
  const sse = openSse(res);
  const results = sampleSearchResults();
  const toolCallId = 'call_search_1';

  const step = async (delta, extra) => {
    if (sse.closed) return false;
    sse.send(chunkFrame(state, delta, extra));
    await sleep(delay());
    return !sse.closed;
  };

  // 1) 角色
  if (!(await step({ role: 'assistant', content: '' }))) return;

  // 2) 思考增量
  for (const piece of REASONING_CHUNKS) {
    if (!(await step({ reasoning_content: piece }))) return;
  }

  // 3) 服务端工具调用（搜索）
  if (
    !(await step({
      server_tool_calls: [
        {
          id: toolCallId,
          name: 'deepseek_web_search',
          input: { action: 'search', queries: ['上海今天天气 2026-11-19'] },
          kind: 'search',
        },
      ],
    }))
  ) {
    return;
  }

  // 4) 搜索结果（同一 tool_use_id 的结果块）
  if (
    !(await step({
      server_tool_calls: [
        {
          id: toolCallId,
          tool_use_id: toolCallId,
          name: 'deepseek_web_search',
          kind: 'search',
          content: results,
        },
      ],
    }))
  ) {
    return;
  }

  // 5) 正文增量（含引用角标）
  for (const piece of ANSWER_CHUNKS) {
    if (!(await step({ content: piece }))) return;
  }

  // 6) 引用信息
  if (!(await step({ annotations: sampleAnnotations() }))) return;

  // 7) 会话标题
  if (!(await step({ title: SAMPLE_TITLE }))) return;

  // 8) 结束块 + 用量
  if (sse.closed) return;
  sse.send({
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 128,
      completion_tokens: 256,
      total_tokens: 384,
      prompt_cache_hit_tokens: 96,
      prompt_cache_miss_tokens: 32,
      prompt_tokens_details: { cached_tokens: 96 },
    },
  });
  sse.sendRaw('[DONE]');
  sse.end();
}

/** 非流式对话响应 */
function nonStreamChat(res, model) {
  const content = ANSWER_CHUNKS.join('');
  sendJson(res, 200, {
    id: `chatcmpl-mock-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model === 'mock-slow' ? 'deepseek-flash' : model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          reasoning_content: REASONING_CHUNKS.join(''),
          annotations: sampleAnnotations(),
          server_tool_calls: [
            {
              id: 'call_search_1',
              name: 'deepseek_web_search',
              kind: 'search',
              content: sampleSearchResults(),
            },
          ],
          title: SAMPLE_TITLE,
        },
        logprobs: null,
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 128,
      completion_tokens: 256,
      total_tokens: 384,
      prompt_cache_hit_tokens: 96,
      prompt_cache_miss_tokens: 32,
      prompt_tokens_details: { cached_tokens: 96 },
    },
  });
}

/**
 * 路由并处理一个 Mock 请求。
 */
async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://mock.local');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method || 'GET';

  // 对话
  if ((pathname === '/chat/completions' || pathname === '/v1/chat/completions') && method === 'POST') {
    const { prefix } = await readPrefix(req);
    const model = pickString(prefix, 'model') || 'deepseek-flash';
    const stream = pickBoolean(prefix, 'stream');
    if (stream === false) nonStreamChat(res, model);
    else await streamChat(req, res, model);
    return;
  }

  // 联网检索
  if (pathname === '/v1/tools/search' && method === 'POST') {
    const { prefix } = await readPrefix(req);
    const query = pickString(prefix, 'query') || '上海天气';
    const results = sampleSearchResults().map((item) => ({ ...item, summary: `${query}：${item.summary}` }));
    sendJson(res, 200, { query, results, request_id: `mock-search-${Date.now().toString(36)}` });
    return;
  }

  // 抓取网页
  if (pathname === '/v1/tools/fetch' && method === 'POST') {
    const { prefix } = await readPrefix(req);
    const target = pickString(prefix, 'url') || 'https://example.com/';
    sendJson(res, 200, sampleFetchedPage(target));
    return;
  }

  // 语音合成
  if (pathname === '/v1/tools/tts' && method === 'POST') {
    const { prefix } = await readPrefix(req);
    const format = (pickString(prefix, 'format') || 'wav').toLowerCase();
    const voice = pickString(prefix, 'voice_id') || 'stella';
    const frequency = voice === 'tide' ? 329.63 : 440;
    const wav = createSineWav({ seconds: 1, sampleRate: 24_000, frequency });
    if (format === 'pcm') {
      // 裸 PCM：去掉 44 字节 WAV 头
      const pcm = wav.subarray(44);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(pcm.length),
        'Cache-Control': 'no-store',
      });
      res.end(pcm);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': String(wav.length),
      'Cache-Control': 'no-store',
    });
    res.end(wav);
    return;
  }

  // 语音识别（multipart 流式消费）
  if (pathname === '/v1/tools/asr' && method === 'POST') {
    const file = await consumeMultipart(req);
    sendJson(res, 200, {
      text: ASR_TEXT,
      duration_ms: 1800,
      request_id: `mock-asr-${Date.now().toString(36)}`,
      mock_file: { name: file.filename, bytes: file.bytes, content_type: file.contentType },
    });
    return;
  }

  // OCR（multipart 或 JSON 都接受，只读取前缀后丢弃）
  if (pathname === '/v1/tools/ocr' && method === 'POST') {
    await readPrefix(req);
    sendJson(res, 200, {
      text: OCR_TEXT,
      engine: 'mock-ocr',
      duration_ms: 120,
      request_id: `mock-ocr-${Date.now().toString(36)}`,
    });
    return;
  }

  // 文件上传
  if ((pathname === '/files' || pathname === '/v1/files') && method === 'POST') {
    const file = await consumeMultipart(req);
    sendJson(res, 200, {
      id: 'file-api-mock',
      object: 'file',
      bytes: file.bytes,
      created_at: Math.floor(Date.now() / 1000),
      filename: file.filename,
      purpose: file.fields?.purpose || 'assistants',
      status: 'processed',
    });
    return;
  }

  // 余额
  if (pathname === '/user/balance' && method === 'GET') {
    sendJson(res, 200, {
      is_available: true,
      balance_infos: [
        {
          currency: 'CNY',
          total_balance: '110.00',
          granted_balance: '10.00',
          topped_up_balance: '100.00',
        },
      ],
    });
    return;
  }

  // 模型列表
  if (pathname === '/models' && method === 'GET') {
    sendJson(res, 200, {
      object: 'list',
      data: [
        { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek', created: 1_760_000_000, vision: true },
        { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek', created: 1_760_000_000, vision: true },
        { id: 'mock-slow', object: 'model', owned_by: 'mock', created: 1_760_000_000, vision: false },
      ],
    });
    return;
  }

  // 健康检查（便于直接 curl Mock 上游）
  if (pathname === '/healthz') {
    sendJson(res, 200, { ok: true, mock: true });
    return;
  }

  sendJson(res, 404, { error: { message: `Mock 上游没有该端点：${method} ${pathname}`, type: 'not_found_error' } });
}

/**
 * 启动 Mock 上游 HTTP 服务（默认只监听 127.0.0.1 随机端口）。
 * @param {{host?: string, port?: number, logger?: {info: Function, warn: Function}}} [options]
 * @returns {Promise<{server: import('node:http').Server, port: number, url: string, close: () => Promise<void>}>}
 */
export async function startMockUpstream(options = {}) {
  const { host = '127.0.0.1', port = 0, logger = SILENT } = options;

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      logger.warn('Mock 上游处理异常：', error?.message || error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: { message: 'Mock 上游内部错误', type: 'server_error' } });
      } else if (!res.writableEnded) {
        res.destroy();
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host}:${actualPort}`;
  logger.info(`Mock 上游已启动：${url}`);

  return {
    server,
    port: actualPort,
    url,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
