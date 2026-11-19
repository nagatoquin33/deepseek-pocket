/**
 * 上游代理核心。
 *
 * 设计要点（对应契约硬性要求）：
 * - 请求体、响应体全程流式转发，绝不把整个 SSE/文件读进内存。
 * - 响应逐块 write + flushHeaders，保证手机端看到“打字机”效果。
 * - 客户端断开 -> AbortController abort 上游请求，避免上游继续计费。
 * - 上游错误状态码与 JSON 体原样透传（401/402/429 等）。
 * - 网络层错误统一 502 {error:{message,type}}；超时 504。
 * - 所有 API 响应带 Cache-Control: no-store。
 */
import http from 'node:http';
import https from 'node:https';
import { sendError, discardBody, isEventStream } from './http-utils.mjs';

/** 从客户端转发给上游的白名单请求头（其余一律不复用，尤其不转发 x-ds-key）。 */
const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'accept-language', 'content-length', 'user-agent'];

/** 从上游回传给浏览器的白名单响应头。 */
const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'content-encoding',
  'content-length',
  'content-disposition',
  'x-request-id',
];

/**
 * 解析本次请求使用的 API Key。
 * 优先级：x-ds-key > Authorization: Bearer > 环境变量 DEEPSEEK_API_KEY。
 * @param {import('node:http').IncomingMessage} req
 * @param {string} [envKey]
 * @returns {string | null}
 */
export function resolveApiKey(req, envKey) {
  const header = req.headers['x-ds-key'];
  const rawHeader = Array.isArray(header) ? header[0] : header;
  const fromCustom = normalizeKey(rawHeader);
  if (fromCustom) return fromCustom;

  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const match = /^\s*Bearer\s+(.+)\s*$/i.exec(auth);
    if (match) {
      const fromBearer = normalizeKey(match[1]);
      if (fromBearer) return fromBearer;
    }
  }

  return normalizeKey(envKey);
}

/** 去掉空白与可能误带的 Bearer 前缀；非法形态返回 null。 */
function normalizeKey(value) {
  if (typeof value !== 'string') return null;
  let key = value.trim();
  if (!key) return null;
  const bearer = /^Bearer\s+(.+)$/i.exec(key);
  if (bearer) key = bearer[1].trim();
  if (!key) return null;
  // API Key 不可能包含控制字符；过长直接视为非法，避免头部注入
  if (key.length > 4096 || /[\r\n\0]/.test(key)) return null;
  return key;
}

/**
 * 创建代理实例。
 * @param {{baseUrl: string, logger: {warn: Function, info: Function}}} options
 */
export function createProxy({ baseUrl, logger }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  let parsedBase;
  try {
    parsedBase = new URL(base);
  } catch {
    throw new Error(`DEEPSEEK_BASE_URL 不是合法 URL：${base}`);
  }
  const transport = parsedBase.protocol === 'https:' ? https : http;

  /**
   * 转发一个请求到上游。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {{path: string, key: string, timeoutMs: number, maxBytes: number, label?: string}} options
   * @returns {Promise<void>}
   */
  function forward(req, res, options) {
    const { path, key, timeoutMs, maxBytes, label = 'upstream' } = options;
    const target = `${base}${path}`;

    return new Promise((resolve) => {
      const controller = new AbortController();
      let settled = false;
      let clientGone = false;
      let overflow = false;
      let timedOut = false;
      let upstream = null;
      let timer = null;
      let received = 0;

      /** 幂等收尾（监听器留着不拆：req/res 会随请求回收，保留可避免收尾后的 error 事件变成未捕获异常） */
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        timer = null;
        resolve();
      };

      const abortUpstream = () => {
        controller.abort();
        if (upstream && !upstream.destroyed) {
          try {
            upstream.destroy();
          } catch {
            /* 忽略销毁异常 */
          }
        }
      };

      /** 客户端断开：立即中止上游，防止继续消耗额度 */
      const onResClose = () => {
        if (!res.writableEnded) {
          clientGone = true;
          abortUpstream();
        }
        finish();
      };

      const onReqAborted = () => {
        clientGone = true;
        abortUpstream();
        finish();
      };

      /** 客户端连接异常（与 aborted 等价处理，避免未捕获的 error 事件） */
      const onReqError = () => {
        clientGone = true;
        abortUpstream();
        finish();
      };

      const onResError = () => {
        clientGone = true;
        abortUpstream();
        finish();
      };

      const onRequestData = (chunk) => {
        if (settled || overflow) return;
        received += chunk.length;
        if (received > maxBytes) {
          overflow = true;
          if (timer) clearTimeout(timer);
          abortUpstream();
          if (!res.headersSent) {
            sendError(
              res,
              413,
              `请求体超过上限（${maxBytes} 字节）`,
              'invalid_request_error',
              { Connection: 'close' },
            );
          }
          discardBody(req);
          res.once('finish', () => finish());
          if (res.writableEnded) finish();
          return;
        }
        if (!upstream || upstream.destroyed) return;
        try {
          const ok = upstream.write(chunk);
          if (!ok) {
            req.pause();
            upstream.once('drain', () => {
              if (!settled) req.resume();
            });
          }
        } catch {
          /* 上游已销毁时忽略写入错误，错误处理交给 error 事件 */
        }
      };

      const onRequestEnd = () => {
        if (settled) return;
        if (upstream && !upstream.destroyed) {
          try {
            upstream.end();
          } catch {
            /* 忽略 */
          }
        }
      };

      // ---- 组装上游请求头 ----
      const headers = {};
      for (const name of FORWARD_REQUEST_HEADERS) {
        const value = req.headers[name];
        if (value !== undefined) headers[name] = value;
      }
      headers['Authorization'] = `Bearer ${key}`;
      const isStream = path === '/chat/completions';
      headers['Accept'] = isStream ? 'text/event-stream' : 'application/json';
      if (!headers['content-type']) headers['content-type'] = 'application/json';

      res.on('close', onResClose);
      res.on('error', onResError);
      req.on('aborted', onReqAborted);
      req.on('error', onReqError);
      req.on('data', onRequestData);
      req.on('end', onRequestEnd);

      // 超时只约束“拿到上游响应头”之前，SSE 长连接不设总时长限制
      timer = setTimeout(() => {
        timedOut = true;
        abortUpstream();
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      try {
        upstream = transport.request(target, {
          method: req.method === 'POST' ? 'POST' : req.method || 'GET',
          headers,
          signal: controller.signal,
        });
      } catch (error) {
        logger.warn(`${label} 创建上游请求失败：`, error.message);
        if (!res.headersSent) sendError(res, 502, '无法连接上游服务', 'upstream_error');
        finish();
        return;
      }

      upstream.on('error', (error) => {
        if (settled) return;
        if (clientGone) {
          finish();
          return;
        }
        if (timedOut) {
          logger.warn(`${label} 上游响应超时（${timeoutMs}ms）`);
          if (!res.headersSent) sendError(res, 504, '上游响应超时', 'upstream_timeout');
          else res.destroy();
          finish();
          return;
        }
        if (overflow) {
          finish();
          return;
        }
        logger.warn(`${label} 上游网络错误：`, error.code || error.message);
        if (!res.headersSent) {
          sendError(res, 502, `无法连接上游服务（${error.code || 'network_error'}）`, 'upstream_error');
        } else {
          res.destroy();
        }
        finish();
      });

      upstream.on('response', (upstreamRes) => {
        if (settled) {
          upstreamRes.destroy();
          return;
        }
        if (timer) clearTimeout(timer);
        timer = null;

        const responseHeaders = {};
        for (const name of FORWARD_RESPONSE_HEADERS) {
          const value = upstreamRes.headers[name];
          if (value !== undefined) responseHeaders[name] = value;
        }
        responseHeaders['Cache-Control'] = 'no-store';
        const streaming = isEventStream(upstreamRes.headers['content-type']);
        if (streaming) {
          responseHeaders['X-Accel-Buffering'] = 'no'; // 关掉 nginx 类反代的缓冲
          if (typeof res.socket?.setNoDelay === 'function') res.socket.setNoDelay(true);
        }

        if (!res.headersSent) {
          res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
          if (typeof res.flushHeaders === 'function') res.flushHeaders();
        }

        upstreamRes.on('data', (chunk) => {
          if (settled || res.writableEnded || res.destroyed) {
            upstreamRes.destroy();
            return;
          }
          if (!res.write(chunk)) {
            upstreamRes.pause();
            res.once('drain', () => {
              if (!settled && !res.writableEnded) upstreamRes.resume();
            });
          }
        });
        upstreamRes.on('end', () => {
          if (!res.writableEnded) res.end();
          finish();
        });
        upstreamRes.on('error', (error) => {
          if (settled) return;
          logger.warn(`${label} 上游响应流中断：`, error.code || error.message);
          if (!res.writableEnded) res.destroy();
          finish();
        });
      });

      upstream.on('close', () => {
        // 上游提前关闭且没有 response 事件时（例如连接被重置），交给 error 分支或这里兜底
        if (!settled) {
          // 等一个 tick 让 error 事件先到
          setImmediate(() => {
            if (!settled) {
              if (!res.headersSent) {
                if (!clientGone) sendError(res, 502, '上游连接意外关闭', 'upstream_error');
              } else if (!res.writableEnded) {
                res.end();
              }
              finish();
            }
          });
        }
      });
    });
  }

  return { forward };
}
