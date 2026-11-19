/**
 * HTTP 小工具：JSON 响应、错误体、请求体读取/丢弃、客户端 IP。
 * 不依赖任何框架，全部基于 node:http 的原生 req/res。
 */

/** 统一的 HTTP 错误对象，server 顶层 catch 会把它翻译成 JSON 响应。 */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {string} [type]
   */
  constructor(status, message, type = 'invalid_request_error') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.type = type;
  }
}

/** API 响应统一禁止缓存。 */
export function setNoStore(res) {
  if (!res.headersSent) res.setHeader('Cache-Control', 'no-store');
}

/**
 * 发送 JSON 响应。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 * @param {Record<string,string>} [extraHeaders]
 */
export function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (!res.headersSent) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
  }
  res.end(body);
}

/**
 * 统一的错误 JSON：{ error: { message, type } }。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} message
 * @param {string} [type]
 * @param {Record<string,string>} [extraHeaders]
 */
export function sendError(res, status, message, type = 'invalid_request_error', extraHeaders = {}) {
  sendJson(res, status, { error: { message, type } }, extraHeaders);
}

/**
 * 丢弃请求体（发送错误响应前防止连接挂起）。
 * @param {import('node:http').IncomingMessage} req
 */
export function discardBody(req) {
  try {
    req.resume();
  } catch {
    /* 已销毁则忽略 */
  }
}

/**
 * 读取整个请求体（仅用于小体积 JSON；大文件走流式代理）。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<Buffer>}
 */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, `请求体超过上限（${limit} 字节）`, 'invalid_request_error'));
        discardBody(req);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, size));
    });
    req.on('error', (error) => fail(error));
    req.on('aborted', () => fail(new HttpError(499, '客户端已断开', 'aborted')));
  });
}

/**
 * 读取 JSON 请求体；解析失败返回空对象（Mock 用，宽容解析）。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<any>}
 */
export async function readJsonLoose(req, limit = 2 * 1024 * 1024) {
  try {
    const buf = await readBody(req, limit);
    if (buf.length === 0) return {};
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return {};
  }
}

/**
 * 从请求中取客户端 IP（去掉 IPv4-mapped IPv6 前缀）。
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
export function getClientIp(req) {
  const raw = req.socket?.remoteAddress || '';
  return raw.replace(/^::ffff:/i, '') || 'unknown';
}

/**
 * 解析 URL（容错：畸形 req.url 也能返回路径）。
 * @param {import('node:http').IncomingMessage} req
 * @returns {{pathname: string, searchParams: URLSearchParams}}
 */
export function parseRequestUrl(req) {
  const raw = req.url || '/';
  try {
    const url = new URL(raw, 'http://localhost');
    return { pathname: url.pathname, searchParams: url.searchParams };
  } catch {
    const idx = raw.indexOf('?');
    return {
      pathname: idx === -1 ? raw : raw.slice(0, idx),
      searchParams: new URLSearchParams(idx === -1 ? '' : raw.slice(idx + 1)),
    };
  }
}

/** 是否 SSE/流式响应类型 */
export function isEventStream(contentType) {
  return typeof contentType === 'string' && contentType.toLowerCase().includes('text/event-stream');
}
