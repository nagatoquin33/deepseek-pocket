/**
 * 后端契约测试（node:test + 随机端口 + fetch）。
 *
 * 覆盖 docs/CONTRACTS.md 第二节：
 * - 健康检查 / server-info / 静态站点与安全头 / SPA 回退 / 路径穿越 / 304 缓存
 * - 无密钥 401 / 同源校验 / 限流 429 / 体积上限 413
 * - Mock SSE 的 thinking、搜索、引用、标题、usage、[DONE]，且确认真流式
 * - TTS（RIFF/WAV）、ASR、文件上传、检索、抓取、OCR、余额、模型
 * - /api/qr 合法与非法目标
 * - 上游 401/429 原样透传、网络错误 502、密钥优先级、日志不泄密
 *
 * 测试自行 spawn server.mjs，随机端口，不依赖外网与真实 API Key。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = path.join(ROOT, 'server.mjs');
const ENV_KEY_SENTINEL = 'sk-ENVKEY-SENTINEL-0123456789';
const HEADER_KEY_SENTINEL = 'sk-HEADERKEY-SENTINEL-9876543210';

/** @type {Set<import('node:child_process').ChildProcess>} */
const children = new Set();
/** @type {string[]} */
const tempDirs = [];

/** 清理环境变量，保证测试不读取到开发机上的真实 Key 等配置。 */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'MOCK', 'PORT', 'HOST', 'PUBLIC_DIR']) {
    delete env[key];
  }
  return { ...env, ...extra };
}

/**
 * 启动 server.mjs，等待它打印 [ready] 行。
 * @returns {Promise<{child, port, base, logs: () => string, info: any}>}
 */
function startServer({ args = [], env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_ENTRY, '--port', '0', ...args], {
      cwd: ROOT,
      env: cleanEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    children.add(child);

    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`启动超时：\n${output}`));
    }, 20_000);
    timer.unref?.();

    const onData = (buffer) => {
      output += buffer.toString('utf8');
      const match = /^\[ready\] (\{.*\})$/m.exec(output);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        const info = JSON.parse(match[1]);
        resolve({
          child,
          port: info.port,
          base: `http://127.0.0.1:${info.port}`,
          info,
          logs: () => output,
        });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`服务提前退出（code=${code}）：\n${output}`));
    });
  });
}

async function stopServer(server) {
  if (!server) return;
  const { child } = server;
  if (child.exitCode !== null || child.signalCode !== null) {
    children.delete(child);
    return;
  }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 忽略 */
      }
    }, 4000);
    timer.unref?.();
    child.once('exit', () => {
      clearTimeout(timer);
      children.delete(child);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      children.delete(child);
      resolve();
    }
  });
}

/** 读取 SSE 响应，返回事件文本与到达时间。 */
async function readSse(res, { maxEvents = 500 } = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const start = Date.now();
  const events = [];
  const times = [];
  let buffer = '';
  while (events.length < maxEvents) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of raw.split('\n')) {
        if (line.startsWith('data:')) {
          events.push(line.slice(5).trim());
          times.push(Date.now() - start);
        }
      }
    }
  }
  return { events, times };
}

/** JSON 请求辅助 */
async function requestJson(url, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { res, text, json };
}

/** 创建带各种静态资源的最小 public 目录（测试与 Lead 的前端解耦） */
function makePublicFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-public-'));
  tempDirs.push(dir);
  const write = (name, content) => {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write('index.html', '<!doctype html><html lang="zh-CN"><head><title>首页</title></head><body><h1>DeepSeek 随身版</h1></body></html>');
  write('app.js', 'export const answer = 42;\n');
  write('style.css', 'body{background:#0b1220;color:#e6edf3}\n');
  write('icon.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"></svg>');
  write(
    'manifest.webmanifest',
    JSON.stringify({ name: 'DeepSeek 随身版', short_name: 'DeepSeek', start_url: '/', display: 'standalone' }),
  );
  write('sw.js', 'self.addEventListener("install", () => self.skipWaiting());\n');
  return dir;
}

/** 最小假上游：用于验证“原样透传状态码 + JSON 体”与密钥优先级。 */
function startFakeUpstream() {
  /** @type {Array<{url: string, headers: Record<string, any>}>} */
  const captured = [];
  const server = http.createServer((req, res) => {
    captured.push({ url: req.url, headers: req.headers });
    const send = (status, payload) => {
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length });
      res.end(body);
    };
    if (req.url === '/chat/completions') {
      send(401, { error: { message: 'Authentication Fails, Your api key is invalid', type: 'authentication_error' } });
      return;
    }
    if (req.url === '/v1/tools/search') {
      send(429, { error: { message: 'Rate limit reached for requests', type: 'rate_limit_error' } });
      return;
    }
    if (req.url === '/user/balance') {
      send(200, { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '88.00' }] });
      return;
    }
    send(404, { error: { message: 'not found', type: 'not_found_error' } });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: address.port, captured });
    });
  });
}

// ---------------------------------------------------------------------------
// 全局准备：三个基础服务实例 + 静态目录
// ---------------------------------------------------------------------------
let mockServer; // --mock + 环境预置密钥
let plainServer; // 无 Key、无 Mock，用小体积静态目录
let upstreamServer; // 指向假上游
let fakeUpstream;
let qrAvailable = false;
let publicFixture;

before(async () => {
  publicFixture = makePublicFixture();
  fakeUpstream = await startFakeUpstream();
  try {
    const mod = await import('qrcode');
    const api = mod && typeof mod.toBuffer === 'function' ? mod : mod?.default;
    qrAvailable = Boolean(api && typeof api.toBuffer === 'function');
  } catch {
    qrAvailable = false;
  }

  // 并行启动，节省总耗时
  [mockServer, plainServer, upstreamServer] = await Promise.all([
    startServer({ args: ['--mock'], env: { DEEPSEEK_API_KEY: ENV_KEY_SENTINEL } }),
    startServer({ env: { PUBLIC_DIR: publicFixture } }),
    startServer({ env: { DEEPSEEK_BASE_URL: `http://127.0.0.1:${fakeUpstream.port}` } }),
  ]);
});

after(async () => {
  await Promise.all([stopServer(mockServer), stopServer(plainServer), stopServer(upstreamServer)]);
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 忽略 */
    }
  }
  children.clear();
  if (fakeUpstream) await new Promise((resolve) => fakeUpstream.server.close(resolve));
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
});

// ---------------------------------------------------------------------------
// 健康检查与 server-info
// ---------------------------------------------------------------------------
test('GET /healthz 返回健康信息', async () => {
  const { res, json } = await requestJson(`${mockServer.base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(typeof json.name, 'string');
  assert.match(json.version, /^\d+\.\d+\.\d+/);
  assert.equal(typeof json.uptime, 'number');
  assert.equal(json.mock, true);

  const plain = await requestJson(`${plainServer.base}/healthz`);
  assert.equal(plain.res.status, 200);
  assert.equal(plain.json.mock, false);
});

test('GET /api/server-info 字段完整且 hasEnvKey 正确', async () => {
  const { res, json } = await requestJson(`${mockServer.base}/api/server-info`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(json.version, /^\d+\.\d+\.\d+/);
  assert.equal(json.https, false);
  assert.equal(json.port, mockServer.port);
  assert.equal(json.hasEnvKey, true);
  assert.equal(json.mock, true);
  assert.equal(json.platform, process.platform);
  assert.ok(Array.isArray(json.urls) && json.urls.length > 0);
  for (const item of json.urls) {
    assert.equal(typeof item.ip, 'string');
    assert.match(item.url, /^https?:\/\/.+/);
  }

  const plain = await requestJson(`${plainServer.base}/api/server-info`);
  assert.equal(plain.json.hasEnvKey, false);
  assert.equal(plain.json.mock, false);
});

test('同源校验：非法 Origin 403，合法 Origin 放行', async () => {
  const bad = await requestJson(`${plainServer.base}/api/server-info`, {
    headers: { Origin: 'https://evil.example.com' },
  });
  assert.equal(bad.res.status, 403);
  assert.equal(bad.json.error.type, 'forbidden_error');

  const good = await requestJson(`${plainServer.base}/api/server-info`, {
    headers: { Origin: `http://127.0.0.1:${plainServer.port}` },
  });
  assert.equal(good.res.status, 200);
});

// ---------------------------------------------------------------------------
// 静态站点
// ---------------------------------------------------------------------------
test('静态首页：200 + 安全头 + CSP + no-cache', async () => {
  const res = await fetch(`${plainServer.base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp && csp.includes("default-src 'self'"));
  assert.ok(csp.includes("connect-src 'self' https://api.deepseek.com"));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.ok(res.headers.get('etag'));
  const html = await res.text();
  assert.ok(html.includes('DeepSeek 随身版'));
});

test('静态资源 MIME 与缓存策略', async () => {
  const cases = [
    ['/app.js', /text\/javascript/, /max-age=/],
    ['/style.css', /text\/css/, /max-age=/],
    ['/icon.svg', /image\/svg\+xml/, /max-age=/],
    ['/manifest.webmanifest', /application\/manifest\+json/, /max-age=/],
    ['/sw.js', /text\/javascript/, /no-cache/],
  ];
  for (const [url, typeRe, cacheRe] of cases) {
    const res = await fetch(`${plainServer.base}${url}`);
    assert.equal(res.status, 200, `${url} 应 200`);
    assert.match(res.headers.get('content-type'), typeRe, `${url} MIME`);
    assert.match(res.headers.get('cache-control'), cacheRe, `${url} 缓存策略`);
    await res.arrayBuffer();
  }
});

test('ETag 命中返回 304', async () => {
  const first = await fetch(`${plainServer.base}/app.js`);
  await first.arrayBuffer();
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const second = await fetch(`${plainServer.base}/app.js`, { headers: { 'If-None-Match': etag } });
  assert.equal(second.status, 304);
  assert.equal(second.headers.get('cache-control'), 'public, max-age=3600');
  const body = await second.arrayBuffer();
  assert.equal(body.byteLength, 0);
});

test('SPA 回退：无扩展名路径返回 index.html', async () => {
  const res = await fetch(`${plainServer.base}/chat/abc123`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.ok((await res.text()).includes('DeepSeek 随身版'));
});

test('路径穿越被阻止（%2e%2e / 反斜杠 / 越界）', async () => {
  const attacks = [
    `%2e%2e/%2e%2e/server.mjs`,
    `..%2f..%2fserver.mjs`,
    `%2e%2e%5c%2e%2e%5cpackage.json`,
    `..%5c..%5cpackage.json`,
    `%252e%252e/server.mjs`,
  ];
  for (const attack of attacks) {
    const res = await fetch(`${plainServer.base}/${attack}`);
    assert.ok([400, 403, 404].includes(res.status), `${attack} 应被拒绝，实际 ${res.status}`);
    const text = await res.text();
    assert.ok(!text.includes('createProxy'), `${attack} 不应泄漏 server.mjs 内容`);
    assert.ok(!text.includes('"optionalDependencies"'), `${attack} 不应泄漏 package.json 内容`);
  }
});

// ---------------------------------------------------------------------------
// 鉴权、限流、体积上限
// ---------------------------------------------------------------------------
test('无 API Key 时 /api/chat 返回 401 JSON', async () => {
  const { res, json, text } = await requestJson(`${plainServer.base}/api/chat`, {
    method: 'POST',
    body: { model: 'deepseek-flash', messages: [{ role: 'user', content: '你好' }], stream: true },
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(json.error.type, 'authentication_error');
  assert.ok(json.error.message.length > 0);
  assert.ok(!text.includes('sk-'), '错误体不得包含密钥片段');
});

test('未知 API 路径返回 404 JSON，方法错误返回 405', async () => {
  const unknown = await requestJson(`${mockServer.base}/api/not-exist`);
  assert.equal(unknown.res.status, 404);
  assert.equal(unknown.json.error.type, 'not_found_error');

  const wrongMethod = await requestJson(`${mockServer.base}/api/chat`);
  assert.equal(wrongMethod.res.status, 405);
});

test('API 限流：第 181 次返回 429', async () => {
  const server = await startServer({ env: { PUBLIC_DIR: publicFixture } });
  try {
    for (let i = 0; i < 180; i += 1) {
      const res = await fetch(`${server.base}/api/server-info`);
      assert.equal(res.status, 200, `第 ${i + 1} 次请求应 200`);
      await res.arrayBuffer();
    }
    const limited = await requestJson(`${server.base}/api/server-info`);
    assert.equal(limited.res.status, 429);
    assert.ok(Number(limited.res.headers.get('retry-after')) > 0);
    assert.equal(limited.json.error.type, 'rate_limit_error');
  } finally {
    await stopServer(server);
  }
});

test('请求体超限返回 413', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      `${mockServer.base}/api/tools/search`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(3 * 1024 * 1024),
          'x-ds-key': 'sk-test',
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 413);
});

// ---------------------------------------------------------------------------
// Mock SSE 对话
// ---------------------------------------------------------------------------
test('Mock SSE：thinking / search / citations / title / usage / [DONE] 且真流式', async () => {
  const res = await fetch(`${mockServer.base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ds-key': HEADER_KEY_SENTINEL },
    body: JSON.stringify({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: '今天上海天气怎么样？' }],
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
      tools: [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }],
      title: { enabled: true },
      stream: true,
    }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const { events, times } = await readSse(res);
  assert.ok(events.length > 20, `SSE 事件块应充足，实际 ${events.length}`);
  assert.equal(events.at(-1), '[DONE]');
  assert.ok(times[0] < 500, `首块应及时到达（${times[0]}ms）`);
  assert.ok(times.at(-1) - times[0] > 80, '各块应逐步到达，而不是一次性缓冲');

  const chunks = events.filter((event) => event !== '[DONE]').map((event) => JSON.parse(event));
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');

  const deltas = chunks.map((chunk) => chunk.choices?.[0]?.delta || {});
  assert.ok(deltas.some((delta) => typeof delta.reasoning_content === 'string'), '应包含 reasoning_content 增量');
  assert.ok(
    deltas.some((delta) => Array.isArray(delta.server_tool_calls) && delta.server_tool_calls.some((call) => call.kind === 'search')),
    '应包含服务端搜索工具调用',
  );
  assert.ok(
    deltas.some((delta) => Array.isArray(delta.server_tool_calls) && delta.server_tool_calls.some((call) => Array.isArray(call.content))),
    '应包含搜索结果内容',
  );
  const content = deltas.map((delta) => delta.content || '').join('');
  assert.ok(content.includes('[1]') && content.includes('[2]'), '正文应含引用角标');
  assert.ok(
    deltas.some((delta) => Array.isArray(delta.annotations) && delta.annotations.some((a) => a.type === 'web_search_result_location')),
    '应包含 annotations 引用',
  );
  assert.ok(deltas.some((delta) => typeof delta.title === 'string'), '应包含 delta.title');

  const finalChunk = chunks.find((chunk) => chunk.choices?.[0]?.finish_reason === 'stop');
  assert.ok(finalChunk, '应有 finish_reason=stop 的结束块');
  assert.equal(finalChunk.usage.prompt_tokens, 128);
  assert.equal(finalChunk.usage.total_tokens, 384);
  assert.equal(typeof finalChunk.usage.prompt_cache_hit_tokens, 'number');
});

test('Mock model=mock-slow 时逐块延时（约 120ms）', async () => {
  const controller = new AbortController();
  const res = await fetch(`${mockServer.base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ds-key': HEADER_KEY_SENTINEL },
    body: JSON.stringify({ model: 'mock-slow', messages: [{ role: 'user', content: '慢速测试' }], stream: true }),
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const arrivals = [];
  let buffer = '';
  while (arrivals.length < 2) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (buffer.includes('\n\n') && arrivals.length < 2) {
      const index = buffer.indexOf('\n\n');
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (raw.includes('data:')) arrivals.push(Date.now());
    }
  }
  assert.equal(arrivals.length, 2);
  assert.ok(arrivals[1] - arrivals[0] >= 80, `相邻块应约 120ms，实际 ${arrivals[1] - arrivals[0]}ms`);
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 200));

  // 客户端断开后服务仍健康（说明 abort 处理没有拖垮进程）
  const health = await requestJson(`${mockServer.base}/healthz`);
  assert.equal(health.res.status, 200);
});

// ---------------------------------------------------------------------------
// Mock 工具端点
// ---------------------------------------------------------------------------
test('POST /api/tools/search 返回 5 条带图标的检索结果', async () => {
  const { res, json } = await requestJson(`${mockServer.base}/api/tools/search`, {
    method: 'POST',
    headers: { 'x-ds-key': HEADER_KEY_SENTINEL },
    body: { query: '上海今天天气', count: 5, need_content: true },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.ok(Array.isArray(json.results));
  assert.equal(json.results.length, 5);
  assert.ok(json.results[0].url.startsWith('https://'));
  assert.ok(json.results[0].site_icon.startsWith('data:image/svg+xml'));
  assert.equal(typeof json.results[0].site_name, 'string');
});

test('POST /api/tools/fetch 返回 Markdown 正文', async () => {
  const { res, json } = await requestJson(`${mockServer.base}/api/tools/fetch`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${HEADER_KEY_SENTINEL}` },
    body: { url: 'https://example.com/weather' },
  });
  assert.equal(res.status, 200);
  assert.equal(json.title, '上海天气与出行指南（Mock）');
  assert.ok(json.content.includes('# 上海天气与出行指南'));
});

test('POST /api/tools/tts 返回合法 24kHz 单声道 16-bit RIFF/WAV', async () => {
  const res = await fetch(`${mockServer.base}/api/tools/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ds-key': HEADER_KEY_SENTINEL },
    body: JSON.stringify({ text: '你好，我是 DeepSeek。', voice_id: 'stella', format: 'wav', filter_markdown: true }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /audio\/wav/);
  const buffer = Buffer.from(await res.arrayBuffer());
  assert.ok(buffer.length > 44);
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buffer.readUInt16LE(20), 1, 'PCM 格式');
  assert.equal(buffer.readUInt16LE(22), 1, '单声道');
  assert.equal(buffer.readUInt32LE(24), 24_000, '24kHz 采样率');
  assert.equal(buffer.readUInt16LE(34), 16, '16-bit');
  assert.equal(buffer.readUInt32LE(4) + 8, buffer.length, 'RIFF 长度字段应匹配');
});

test('POST /api/tools/asr multipart 返回中文文本', async () => {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('RIFF....WAVEfmt ')], { type: 'audio/wav' }), 'voice.wav');
  const res = await fetch(`${mockServer.base}/api/tools/asr`, {
    method: 'POST',
    headers: { 'x-ds-key': HEADER_KEY_SENTINEL },
    body: form,
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.text, '今天上海天气怎么样？');
  assert.equal(typeof json.duration_ms, 'number');
});

test('POST /api/files multipart 返回 file-api-mock', async () => {
  const form = new FormData();
  form.append('purpose', 'assistants');
  form.append('file', new Blob([Buffer.from('hello deepseek')], { type: 'text/plain' }), 'note.txt');
  const res = await fetch(`${mockServer.base}/api/files`, {
    method: 'POST',
    headers: { 'x-ds-key': HEADER_KEY_SENTINEL },
    body: form,
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.id, 'file-api-mock');
  assert.equal(json.filename, 'note.txt');
});

test('POST /api/tools/ocr 返回识别文本', async () => {
  const { res, json } = await requestJson(`${mockServer.base}/api/tools/ocr`, {
    method: 'POST',
    headers: { 'x-ds-key': HEADER_KEY_SENTINEL },
    body: { image: 'data:image/png;base64,AAAA' },
  });
  assert.equal(res.status, 200);
  assert.ok(json.text.includes('上海'));
});

test('GET /api/user/balance 与 /api/models 透传', async () => {
  const balance = await requestJson(`${mockServer.base}/api/user/balance`, {
    headers: { 'x-ds-key': HEADER_KEY_SENTINEL },
  });
  assert.equal(balance.res.status, 200);
  assert.equal(balance.res.headers.get('cache-control'), 'no-store');
  assert.equal(balance.json.is_available, true);
  assert.equal(balance.json.balance_infos[0].currency, 'CNY');
  assert.equal(balance.json.balance_infos[0].total_balance, '110.00');

  const models = await requestJson(`${mockServer.base}/api/models`, {
    headers: { 'x-ds-key': HEADER_KEY_SENTINEL },
  });
  assert.equal(models.res.status, 200);
  assert.ok(Array.isArray(models.json.data));
  assert.ok(models.json.data.some((model) => model.id === 'deepseek-flash'));
  assert.ok(models.json.data.some((model) => model.id === 'deepseek-v4-pro'));
});

// ---------------------------------------------------------------------------
// 二维码
// ---------------------------------------------------------------------------
test('GET /api/qr：本站 URL 合法，外部域名/非法参数 400', async () => {
  if (qrAvailable) {
    const res = await fetch(
      `${mockServer.base}/api/qr?data=${encodeURIComponent(`http://127.0.0.1:${mockServer.port}/`)}`,
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /image\/png/);
    const png = Buffer.from(await res.arrayBuffer());
    assert.ok(png.length > 100);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG 魔数');
  } else {
    // 未安装可选依赖时的降级契约：明确 503，而不是 500
    const res = await fetch(
      `${mockServer.base}/api/qr?data=${encodeURIComponent(`http://127.0.0.1:${mockServer.port}/`)}`,
    );
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.type, 'dependency_missing');
  }

  for (const data of ['https://evil.example.com/x', 'file:///etc/passwd', 'javascript:alert(1)', '']) {
    const res = await fetch(`${mockServer.base}/api/qr?data=${encodeURIComponent(data)}`);
    assert.equal(res.status, 400, `非法二维码目标应 400：${data}`);
  }
  const missing = await fetch(`${mockServer.base}/api/qr`);
  assert.equal(missing.status, 400);
});

// ---------------------------------------------------------------------------
// 上游错误透传 / 网络错误 / 密钥优先级
// ---------------------------------------------------------------------------
test('上游 401/429 原样透传状态码与 JSON 体', async () => {
  const chat = await requestJson(`${upstreamServer.base}/api/chat`, {
    method: 'POST',
    headers: {
      'x-ds-key': 'sk-header-wins',
      Authorization: 'Bearer sk-bearer-loses',
    },
    body: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], stream: true },
  });
  assert.equal(chat.res.status, 401);
  assert.equal(chat.json.error.type, 'authentication_error');
  assert.equal(chat.json.error.message, 'Authentication Fails, Your api key is invalid');
  assert.equal(chat.res.headers.get('cache-control'), 'no-store');

  const search = await requestJson(`${upstreamServer.base}/api/tools/search`, {
    method: 'POST',
    headers: { Authorization: 'Bearer sk-bearer-priority' },
    body: { query: 'x' },
  });
  assert.equal(search.res.status, 429);
  assert.equal(search.json.error.message, 'Rate limit reached for requests');

  // 密钥优先级：x-ds-key > Authorization
  const chatCall = fakeUpstream.captured.find((entry) => entry.url === '/chat/completions');
  assert.ok(chatCall);
  assert.equal(chatCall.headers.authorization, 'Bearer sk-header-wins');
  const searchCall = fakeUpstream.captured.find((entry) => entry.url === '/v1/tools/search');
  assert.ok(searchCall);
  assert.equal(searchCall.headers.authorization, 'Bearer sk-bearer-priority');
});

test('环境变量密钥兜底：无请求头也可转发；畸形 Authorization 不生效', async () => {
  // mockServer 启动时设置了 DEEPSEEK_API_KEY，请求不带任何密钥头也应能转发成功
  const fallback = await requestJson(`${mockServer.base}/api/tools/fetch`, {
    method: 'POST',
    body: { url: 'https://example.com/env-key' },
  });
  assert.equal(fallback.res.status, 200);
  assert.ok(fallback.json.content.includes('上海天气'));

  // 非 Bearer 的 Authorization 不算密钥；plainServer 无环境变量密钥 -> 401
  const malformed = await requestJson(`${plainServer.base}/api/tools/fetch`, {
    method: 'POST',
    headers: { Authorization: 'Basic abc123' },
    body: { url: 'https://example.com/' },
  });
  assert.equal(malformed.res.status, 401);
  assert.equal(malformed.json.error.type, 'authentication_error');
});

test('上游网络错误返回 502 JSON', async () => {
  await new Promise((resolve) => fakeUpstream.server.close(resolve));
  const { res, json } = await requestJson(`${upstreamServer.base}/api/chat`, {
    method: 'POST',
    headers: { 'x-ds-key': 'sk-test' },
    body: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], stream: true },
  });
  assert.equal(res.status, 502);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(typeof json.error.message, 'string');
  assert.ok(json.error.message.length > 0);
  assert.equal(typeof json.error.type, 'string');
});

// ---------------------------------------------------------------------------
// 日志安全
// ---------------------------------------------------------------------------
test('运行日志不包含任何密钥', async () => {
  // 触发一批请求，确保日志缓冲里包含请求记录
  await fetch(`${mockServer.base}/healthz`);
  await requestJson(`${mockServer.base}/api/server-info`);
  await new Promise((resolve) => setTimeout(resolve, 150));

  const logs = mockServer.logs();
  assert.ok(logs.includes('GET /healthz'), '日志应记录请求（证明日志在工作）');
  assert.ok(!logs.includes(ENV_KEY_SENTINEL), '日志不得包含环境变量密钥');
  assert.ok(!logs.includes(HEADER_KEY_SENTINEL), '日志不得包含请求头密钥');
  assert.ok(!logs.includes('sk-ENVKEY'), '日志不得包含密钥前缀片段');
  assert.ok(!logs.includes('sk-HEADERKEY'), '日志不得包含密钥前缀片段');
});
