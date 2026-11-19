/* =========================================================================
 * api.js —— DeepSeek 开放平台客户端
 *
 * 两种运行模式：
 *   proxy  —— 浏览器 + 本机 server.mjs（解决 CORS、HTTPS 麦克风、密钥不落盘）
 *   direct —— Android APK 内 WebView（页面源 https://appassets.local，
 *             开放平台已支持 CORS，直接带 Authorization 调 api.deepseek.com）
 * ========================================================================= */

export class ApiError extends Error {
  constructor(message, { status = 0, type = 'api_error', code = '', retryable = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
    this.code = code;
    this.retryable = retryable;
  }
}

const NETWORK_HINT = '网络连接失败，请检查网络后重试。';
const PROXY_HINT = '网络连接失败，请检查手机与服务端是否在同一 Wi-Fi，或上游是否可达。';

export const NATIVE_HOST = 'appassets.local';
export const UPSTREAM = 'https://api.deepseek.com';

/** 当前是否运行在 Android 壳内 */
export function isNativeShell() {
  return typeof location !== 'undefined' && location.hostname === NATIVE_HOST;
}

/** 是否直连上游：APK 壳、GitHub Pages 等静态托管、或显式 ?direct=1 */
export function isDirectHost() {
  if (typeof location === 'undefined') return false;
  const h = location.hostname;
  if (h === NATIVE_HOST) return true;
  if (h === 'localhost' || h === '127.0.0.1') {
    return new URLSearchParams(location.search).has('direct');
  }
  if (h.endsWith('.github.io')) return true;
  return new URLSearchParams(location.search).has('direct');
}

/** 端点映射：代理路径 与 上游真实路径 一一对应 */
const ROUTES = {
  chat: { proxy: '/chat', direct: '/chat/completions' },
  search: { proxy: '/tools/search', direct: '/v1/tools/search' },
  fetch: { proxy: '/tools/fetch', direct: '/v1/tools/fetch' },
  ocr: { proxy: '/tools/ocr', direct: '/v1/tools/ocr' },
  tts: { proxy: '/tools/tts', direct: '/v1/tools/tts' },
  asr: { proxy: '/tools/asr', direct: '/v1/tools/asr' },
  files: { proxy: '/files', direct: '/files' },
  balance: { proxy: '/user/balance', direct: '/user/balance' },
  models: { proxy: '/models', direct: '/models' },
  serverInfo: { proxy: '/server-info', direct: '' },
};

async function readError(res) {
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON */ }
  const msg = body?.error?.message || body?.message || `HTTP ${res.status}`;
  return new ApiError(msg, {
    status: res.status,
    type: body?.error?.type || 'api_error',
    code: body?.error?.code || '',
    retryable: res.status === 429 || res.status === 503 || res.status === 504 || res.status >= 500,
  });
}

/** 把 SSE 字节流拆成事件回调 */
async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') { onEvent({ done: true }); continue; }
        let json;
        try { json = JSON.parse(payload); } catch { continue; }
        if (json && json.error) {
          throw new ApiError(json.error.message || '请求失败', {
            status: json.error.status || 400,
            type: json.error.type || 'api_error',
            code: json.error.code || '',
          });
        }
        onEvent(json);
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

export function createClient({ key = '', base = '/api', direct = (typeof location !== 'undefined' && isDirectHost()) } = {}) {
  const authHeaders = () => (key
    ? (direct ? { Authorization: `Bearer ${key.trim()}` } : { 'x-ds-key': key.trim() })
    : {});
  const url = (name) => {
    const route = ROUTES[name];
    if (!route) throw new Error(`未知端点 ${name}`);
    return direct ? UPSTREAM + route.direct : base + route.proxy;
  };
  const netHint = direct ? NETWORK_HINT : PROXY_HINT;

  async function jsonRequest(name, { method = 'POST', body, signal } = {}) {
    let res;
    try {
      res = await fetch(url(name), {
        method,
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        cache: 'no-store',
        mode: 'cors',
      });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      throw new ApiError(netHint, { status: 0, type: 'network_error', retryable: true });
    }
    if (!res.ok) throw await readError(res);
    if (res.status === 204) return null;
    return res.json();
  }

  const client = {
    key,
    direct,
    get base() { return direct ? UPSTREAM : base; },
    setKey(k) { key = k; client.key = k; },

    /** 流式对话：onEvent 收到原始 chunk 与 {done:true} */
    async chat(body, { signal, onEvent } = {}) {
      let res;
      try {
        res = await fetch(url('chat'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify(body),
          signal,
          cache: 'no-store',
          mode: 'cors',
        });
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        throw new ApiError(netHint, { status: 0, type: 'network_error', retryable: true });
      }
      if (!res.ok) throw await readError(res);
      await readSSE(res, onEvent);
    },

    search({ query, count = 10, oriQuestion, needContent = false, localization = '' }, { signal } = {}) {
      return jsonRequest('search', {
        body: { query, count, ori_question: oriQuestion, need_content: needContent, localization },
        signal,
      });
    },

    fetchPage(u, { signal } = {}) {
      return jsonRequest('fetch', { body: { url: u }, signal });
    },

    ocr(body, { signal } = {}) {
      return jsonRequest('ocr', { body, signal });
    },

    balance({ signal } = {}) {
      return jsonRequest('balance', { method: 'GET', signal });
    },

    models({ signal } = {}) {
      return jsonRequest('models', { method: 'GET', signal });
    },

    /** 服务端信息：APK 内没有代理，返回本地事实 */
    async serverInfo({ signal } = {}) {
      if (direct) {
        return {
          native: true,
          version: (typeof window !== 'undefined' && window.DSAndroid?.version?.()) || '1.0.0',
          https: true,
          hasEnvKey: false,
          mock: false,
          urls: [],
          platform: 'android',
        };
      }
      return fetch(url('serverInfo'), { signal, cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    },

    /** TTS：返回 Blob（audio/wav） */
    async tts({ text, voiceId = 'stella', format = 'wav', filterMarkdown = true }, { signal } = {}) {
      let res;
      try {
        res = await fetch(url('tts'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ text, voice_id: voiceId, format, filter_markdown: filterMarkdown }),
          signal,
          cache: 'no-store',
          mode: 'cors',
        });
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        throw new ApiError(netHint, { status: 0, type: 'network_error', retryable: true });
      }
      if (!res.ok) throw await readError(res);
      const type = res.headers.get('content-type') || 'audio/wav';
      if (type.includes('application/json')) throw await readError(res);
      return res.blob();
    },

    /** ASR：multipart 上传 WAV/OGG，返回 {text, duration_ms} */
    async asr(blob, { signal, filename = 'speech.wav' } = {}) {
      const fd = new FormData();
      fd.append('file', blob, filename);
      let res;
      try {
        res = await fetch(url('asr'), { method: 'POST', headers: authHeaders(), body: fd, signal, cache: 'no-store', mode: 'cors' });
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        throw new ApiError(netHint, { status: 0, type: 'network_error', retryable: true });
      }
      if (!res.ok) throw await readError(res);
      return res.json();
    },

    /** 文件上传（文档解析）。purpose 必须排在 file 前面。 */
    async uploadFile(file, { purpose = 'text_recognition', signal } = {}) {
      const fd = new FormData();
      fd.append('purpose', purpose);
      fd.append('file', file, file.name || 'upload.bin');
      let res;
      try {
        res = await fetch(url('files'), { method: 'POST', headers: authHeaders(), body: fd, signal, cache: 'no-store', mode: 'cors' });
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        throw new ApiError(netHint, { status: 0, type: 'network_error', retryable: true });
      }
      if (!res.ok) throw await readError(res);
      return res.json();
    },
  };

  return client;
}

/** 规范化余额返回，兼容 CNY/USD 多币种 */
export function normalizeBalance(raw) {
  if (!raw) return null;
  const infos = Array.isArray(raw.balance_infos) ? raw.balance_infos : [];
  const cny = infos.find((i) => i.currency === 'CNY') || infos[0];
  return {
    available: raw.is_available !== false,
    currency: cny?.currency || 'CNY',
    total: cny?.total_balance ?? '0',
    granted: cny?.granted_balance ?? '0',
    toppedUp: cny?.topped_up_balance ?? '0',
    all: infos,
  };
}
