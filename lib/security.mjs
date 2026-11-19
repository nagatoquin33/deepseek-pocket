/**
 * 安全相关：安全头、同源校验、限流。
 */
import { CSP } from './config.mjs';

/**
 * 给所有响应加安全头（静态与 API 一视同仁）。
 * @param {import('node:http').ServerResponse} res
 */
export function applySecurityHeaders(res) {
  if (res.headersSent) return;
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(self), geolocation=()');
}

/**
 * 同源校验：浏览器带 Origin 时必须与请求 Host + 协议一致，否则拒绝（防 CSRF）。
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} secure 服务端是否 HTTPS
 * @returns {null | string} 通过返回 null，否则返回拒绝原因
 */
export function checkSameOrigin(req, secure) {
  const origin = req.headers.origin;
  if (!origin) return null; // 非浏览器 / 同源 GET 可能不带 Origin
  const host = req.headers.host;
  if (!host) return '缺少 Host 头';
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return 'Origin 头格式非法';
  }
  const expectedProtocol = secure ? 'https:' : 'http:';
  if (parsed.protocol !== expectedProtocol) return 'Origin 协议与本站不一致';
  if (parsed.host !== host) return 'Origin 与本站不同源';
  return null;
}

/**
 * 固定窗口限流器：每 IP 每分钟 N 次。
 */
export class RateLimiter {
  /**
   * @param {{windowMs: number, max: number}} options
   */
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    /** @type {Map<string, {count: number, resetAt: number}>} */
    this.buckets = new Map();
    // 定期清理过期桶，避免长时间运行内存增长；unref 不阻止进程退出
    this.cleaner = setInterval(() => this.prune(), Math.max(windowMs, 30_000));
    if (typeof this.cleaner.unref === 'function') this.cleaner.unref();
  }

  /**
   * 记一次请求。
   * @param {string} ip
   * @returns {{allowed: boolean, remaining: number, retryAfter: number}}
   */
  hit(ip) {
    const now = Date.now();
    let bucket = this.buckets.get(ip);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(ip, bucket);
    }
    bucket.count += 1;
    const allowed = bucket.count <= this.max;
    return {
      allowed,
      remaining: Math.max(0, this.max - bucket.count),
      retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  prune() {
    const now = Date.now();
    for (const [ip, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(ip);
    }
  }

  dispose() {
    clearInterval(this.cleaner);
    this.buckets.clear();
  }
}
