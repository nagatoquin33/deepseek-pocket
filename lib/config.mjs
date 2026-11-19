/**
 * 全局常量与配置。
 * 后端契约见 docs/CONTRACTS.md 第二节；这里集中存放不随运行环境变化的常量，
 * 便于 server.mjs / lib / test 共用，避免魔法数字散落各处。
 */
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** 应用名（启动横幅、healthz、server-info 共用） */
export const APP_NAME = 'DeepSeek 随身版';

/** 版本号：以 package.json 为单一来源 */
export const VERSION = pkg.version || '1.0.0';

/** 默认监听端口 / 地址（可用 --port/--host 或 PORT/HOST 覆盖） */
export const DEFAULT_PORT = 8787;
export const DEFAULT_HOST = '0.0.0.0';

/** 上游 DeepSeek 开放平台默认地址（测试用 DEEPSEEK_BASE_URL 覆盖） */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com';

/** 请求体体积上限（字节）。未列出的 API 一律 2MB。 */
export const MiB = 1024 * 1024;
export const BODY_LIMITS = Object.freeze({
  '/api/chat': 64 * MiB,
  '/api/files': 110 * MiB,
  '/api/tools/asr': 10 * MiB,
  default: 2 * MiB,
});

/** 上游请求超时（等待响应头的毫秒数）。/api/files 允许较慢的上传，给 300s。 */
export const TIMEOUTS = Object.freeze({
  '/api/chat': 180_000,
  '/api/files': 300_000,
  '/api/tools/asr': 120_000,
  default: 60_000,
});

/** 限流：每 IP 每分钟 180 次 API 请求（静态资源不计入）。 */
export const RATE_LIMIT = Object.freeze({ windowMs: 60_000, max: 180 });

/** 安全头。CSP 里的 connect-src 同时允许同源与官方 API 域名（Mock 模式走同源 /api）。 */
export const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self' https://api.deepseek.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join('; ');

/** 服务端预置密钥的环境变量名 */
export const ENV_KEY_NAME = 'DEEPSEEK_API_KEY';

/**
 * 代理路由映射：浏览器侧同源路径 -> 上游路径。
 * 注意契约里联网/语音等工具挂在 /v1/tools/* 下，而对话与文件在根路径。
 */
export const UPSTREAM_ROUTES = Object.freeze({
  '/api/chat': '/chat/completions',
  '/api/tools/search': '/v1/tools/search',
  '/api/tools/fetch': '/v1/tools/fetch',
  '/api/tools/tts': '/v1/tools/tts',
  '/api/tools/asr': '/v1/tools/asr',
  '/api/tools/ocr': '/v1/tools/ocr',
  '/api/files': '/files',
  '/api/user/balance': '/user/balance',
  '/api/models': '/models',
});

/** 静态资源 MIME 表（含契约点名的 .webmanifest/.woff2/.svg/.png）。 */
export const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
});

/** 可缓存的静态扩展名（HTML 与 sw.js 永远 no-cache）。 */
export const CACHEABLE_EXTENSIONS = new Set([
  '.js', '.mjs', '.css', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg',
  '.ico', '.woff2', '.woff', '.ttf', '.otf', '.mp3', '.wav', '.webmanifest',
]);
