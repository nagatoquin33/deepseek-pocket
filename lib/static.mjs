/**
 * 静态资源服务（public/ 目录）。
 *
 * 负责：MIME、SPA 回退、防路径穿越（含 %2e%2e 与 Windows 反斜杠）、
 * ETag/Last-Modified 304、缓存策略（HTML/sw.js no-cache，其余可缓存）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { MIME_TYPES, CACHEABLE_EXTENSIONS } from './config.mjs';

/**
 * 创建静态处理器。
 * @param {{rootDir: string, logger: {warn: Function}}} options
 */
export function createStaticHandler({ rootDir, logger }) {
  const root = path.resolve(rootDir);
  const indexFile = path.join(root, 'index.html');

  /**
   * 安全解析 URL 路径为绝对文件路径；越界/畸形返回 null。
   * @param {string} pathname
   * @returns {{filePath: string, decoded: string} | {error: 400 | 403 | 404, reason: string}}
   */
  function resolvePath(pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return { error: 400, reason: '路径编码非法' };
    }
    if (decoded.includes('\0')) return { error: 400, reason: '路径包含空字节' };

    // Windows 反斜杠统一按分隔符处理，再拦截 .. 段，防止 %5c..%5c 绕过
    const normalized = decoded.replace(/\\/g, '/');
    const segments = normalized.split('/');
    for (const segment of segments) {
      if (segment === '..') return { error: 403, reason: '禁止路径穿越' };
      // 拦截盘符与 NTFS 数据流（C: / file.txt:stream）
      if (/^[a-zA-Z]:$/.test(segment) || segment.includes(':')) {
        return { error: 403, reason: '非法路径段' };
      }
    }

    const relative = normalized.replace(/^\/+/, '');
    const filePath = path.resolve(root, relative);
    const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (filePath !== root && !filePath.startsWith(rootWithSep)) {
      return { error: 403, reason: '越出静态目录' };
    }
    if (filePath === root) {
      return { ok: true, filePath: indexFile, decoded: '/' };
    }
    return { ok: true, filePath, decoded: normalized };
  }

  /** 判断请求路径是否有“资源扩展名”，有则不回退 SPA。 */
  function hasAssetExtension(pathname) {
    const base = pathname.split('/').pop() || '';
    return base.includes('.');
  }

  /**
   * 尝试以静态文件响应。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} pathname
   * @param {{spaFallback?: boolean}} [options]
   * @returns {Promise<boolean>} true 表示已处理
   */
  async function handle(req, res, pathname, options = {}) {
    const { spaFallback = true } = options;
    const resolved = resolvePath(pathname);
    if (resolved.error) {
      // 路径穿越统一 403（测试接受 403/404）
      res.writeHead(resolved.error, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`403/404: ${resolved.reason}`);
      return true;
    }
    if (resolved.filePath === indexFile) {
      return serveFile(req, res, indexFile, '/index.html');
    }

    let stat = null;
    try {
      stat = await fsp.stat(resolved.filePath);
    } catch {
      stat = null;
    }
    if (stat && stat.isDirectory()) {
      const nestedIndex = path.join(resolved.filePath, 'index.html');
      try {
        const nested = await fsp.stat(nestedIndex);
        if (nested.isFile()) return serveFile(req, res, nestedIndex, `${pathname.replace(/\/$/, '')}/index.html`);
      } catch {
        /* 无嵌套 index */
      }
      stat = null;
    }

    if (stat && stat.isFile()) {
      return serveFile(req, res, resolved.filePath, pathname);
    }

    // 未命中：无扩展名的路径回退 index.html（SPA 路由）；有扩展名返回 404
    if (spaFallback && !hasAssetExtension(pathname)) {
      return serveFile(req, res, indexFile, '/index.html');
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('404 Not Found');
    return true;
  }

  /**
   * 输出单个文件（含 ETag / Last-Modified / 304）。
   * @returns {Promise<boolean>}
   */
  async function serveFile(req, res, filePath, displayPath) {
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('404 Not Found');
      return true;
    }
    if (!stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('404 Not Found');
      return true;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const lastModified = new Date(stat.mtimeMs).toUTCString();
    const isIndex = filePath === indexFile || path.basename(filePath) === 'index.html';
    const cacheControl = isIndex || path.basename(filePath) === 'sw.js'
      ? 'no-cache'
      : CACHEABLE_EXTENSIONS.has(ext)
        ? 'public, max-age=3600'
        : 'no-cache';

    const headers = {
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      ETag: etag,
      'Last-Modified': lastModified,
    };

    // 304 命中判断：If-None-Match 优先
    const ifNoneMatch = req.headers['if-none-match'];
    let notModified = false;
    if (typeof ifNoneMatch === 'string' && ifNoneMatch.trim() !== '') {
      const candidates = ifNoneMatch.split(',').map((s) => s.trim());
      notModified = candidates.includes(etag) || candidates.includes('*');
    } else {
      const ifModifiedSince = req.headers['if-modified-since'];
      if (typeof ifModifiedSince === 'string') {
        const since = Date.parse(ifModifiedSince);
        if (Number.isFinite(since)) notModified = Math.floor(stat.mtimeMs / 1000) * 1000 <= since;
      }
    }

    if (notModified) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }

    headers['Content-Length'] = String(stat.size);
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }

    const stream = fs.createReadStream(filePath);
    stream.on('error', (error) => {
      logger.warn('静态文件读取失败：', displayPath, error.code || error.message);
      if (!res.writableEnded) res.destroy();
    });
    // 客户端中途断开时销毁文件流，避免句柄泄漏
    res.on('close', () => {
      if (!res.writableEnded) stream.destroy();
    });
    stream.pipe(res);
    return true;
  }

  return { handle, resolvePath, root };
}
