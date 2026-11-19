#!/usr/bin/env node
/**
 * DeepSeek 随身版 · 局域网代理服务。
 *
 * 用法：
 *   node server.mjs [--port 8787] [--host 0.0.0.0] [--https] [--mock] [--portable]
 *
 * 环境变量：
 *   DEEPSEEK_API_KEY   服务端预置密钥（手机端零输入一键登录）
 *   DEEPSEEK_BASE_URL  上游地址（测试用，默认 https://api.deepseek.com）
 *   PORT / HOST / MOCK=1
 *   PUBLIC_DIR         静态目录覆盖（测试用，默认 ./public）
 *
 * 设计：零框架、零构建；静态站点 + 上游 API 流式代理 + HTTPS + 终端二维码 + 离线 Mock。
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APP_NAME,
  BODY_LIMITS,
  DEFAULT_BASE_URL,
  DEFAULT_HOST,
  DEFAULT_PORT,
  ENV_KEY_NAME,
  RATE_LIMIT,
  TIMEOUTS,
  UPSTREAM_ROUTES,
  VERSION,
} from './lib/config.mjs';
import {
  HttpError,
  discardBody,
  getClientIp,
  parseRequestUrl,
  sendError,
  sendJson,
} from './lib/http-utils.mjs';
import { createLogger } from './lib/log.mjs';
import { buildUrls, listLanIPv4, pickPrimaryIPv4, validateQrTarget } from './lib/net.mjs';
import { createProxy, resolveApiKey } from './lib/proxy.mjs';
import { renderQrPng, renderQrTerminal } from './lib/qr.mjs';
import { RateLimiter, applySecurityHeaders, checkSameOrigin } from './lib/security.mjs';
import { createStaticHandler } from './lib/static.mjs';
import { ensureCertificates } from './lib/tls.mjs';
import { startMockUpstream } from './mock/deepseek-mock.mjs';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * 解析命令行参数。
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const options = {
    port: parseEnvPort(process.env.PORT),
    host: process.env.HOST || DEFAULT_HOST,
    https: false,
    mock: process.env.MOCK === '1' || process.env.MOCK === 'true',
    portable: false,
    publicDir: process.env.PUBLIC_DIR || path.join(ROOT_DIR, 'public'),
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inlineValue] = arg.includes('=') ? arg.split('=', 2) : [arg, undefined];
    const nextValue = () => inlineValue ?? argv[(i += 1)];
    switch (flag) {
      case '--port':
      case '-p': {
        const value = Number(nextValue());
        if (!Number.isInteger(value) || value < 0 || value > 65535) {
          throw new Error(`--port 需要一个 0-65535 的整数，收到：${argv[i]}`);
        }
        options.port = value;
        break;
      }
      case '--host':
      case '-H':
        options.host = nextValue() || DEFAULT_HOST;
        break;
      case '--https':
        options.https = true;
        break;
      case '--mock':
        options.mock = true;
        break;
      case '--portable':
        options.portable = true;
        break;
      case '--public':
        options.publicDir = path.resolve(nextValue() || options.publicDir);
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        if (flag.startsWith('-')) throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

function parseEnvPort(value) {
  if (!value) return DEFAULT_PORT;
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_PORT;
}

function printHelp() {
  console.log(`${APP_NAME} · 局域网代理服务 v${VERSION}

用法：node server.mjs [选项]

选项：
  --port, -p <端口>   监听端口（默认 ${DEFAULT_PORT}，0 表示随机）
  --host, -H <地址>   监听地址（默认 ${DEFAULT_HOST}）
  --https             启用 HTTPS（自动读取/生成 .tls/cert.pem + .tls/key.pem）
  --mock              离线 Mock 模式：内置模拟上游，无需密钥与外网
  --portable          便携模式：不自动生成证书、不写 .tls
  --public <目录>     静态资源目录（默认 ./public，测试用）
  --help, -h          显示帮助

环境变量：
  ${ENV_KEY_NAME}      服务端预置 API Key（手机端可一键登录）
  DEEPSEEK_BASE_URL    上游地址（默认 ${DEFAULT_BASE_URL}）
  PORT / HOST / MOCK=1 / PUBLIC_DIR

示例：
  node server.mjs --mock                 # 离线演示
  node server.mjs --https                # 手机可用的 HTTPS（麦克风需要）
  node server.mjs --port 8787 --mock     # 指定端口`);
}

/** @returns {Promise<number>} 实际监听端口 */
function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * 构建统一的请求处理器。
 * @param {object} ctx
 */
function createRequestHandler(ctx) {
  const { proxy, staticHandler, rateLimiter, logger } = ctx;

  return (req, res) => {
    const startedAt = Date.now();
    const { pathname, searchParams } = parseRequestUrl(req);
    applySecurityHeaders(res);
    res.once('finish', () => {
      // 只记录路径不记录 query（/api/qr 的 data 可能很长），且经过脱敏日志器
      logger.info(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - startedAt}ms`);
    });

    handle(req, res, pathname, searchParams).catch((error) => {
      logger.error('请求处理异常：', error?.stack || error?.message || error);
      if (!res.headersSent) {
        sendError(res, error instanceof HttpError ? error.status : 500, error.message || '服务器内部错误', error.type || 'server_error');
      } else if (!res.writableEnded) {
        res.destroy();
      }
    });
  };

  async function handle(req, res, pathname, searchParams) {
    // 1) 同源校验（浏览器带 Origin 时必须与本站一致）
    const originError = checkSameOrigin(req, ctx.secure);
    if (originError) {
      discardBody(req);
      sendError(res, 403, originError, 'forbidden_error');
      return;
    }

    // 2) 健康检查（不占 API 限流额度）
    if (pathname === '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 405, 'healthz 仅支持 GET', 'method_not_allowed');
        return;
      }
      sendJson(res, 200, {
        ok: true,
        name: APP_NAME,
        version: VERSION,
        uptime: Number(process.uptime().toFixed(3)),
        mock: ctx.mock,
      });
      return;
    }

    // 3) API 限流：每 IP 每分钟 180 次
    if (pathname.startsWith('/api/')) {
      const limit = rateLimiter.hit(getClientIp(req));
      if (!limit.allowed) {
        discardBody(req);
        sendError(
          res,
          429,
          `请求过于频繁，请 ${limit.retryAfter} 秒后再试`,
          'rate_limit_error',
          { 'Retry-After': String(limit.retryAfter) },
        );
        return;
      }
    }

    // 4) 服务信息
    if (pathname === '/api/server-info') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 405, 'server-info 仅支持 GET', 'method_not_allowed');
        return;
      }
      sendJson(res, 200, {
        version: VERSION,
        https: ctx.secure,
        port: ctx.port,
        hasEnvKey: Boolean(ctx.envKey),
        mock: ctx.mock,
        urls: buildUrls(ctx.port, ctx.secure, ctx.lan).map((item) => ({ ip: item.ip, url: item.url })),
        platform: process.platform,
      });
      return;
    }

    // 5) 二维码
    if (pathname === '/api/qr') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 405, '二维码接口仅支持 GET', 'method_not_allowed');
        return;
      }
      const data = searchParams.get('data');
      const target = validateQrTarget(data, { hostHeader: req.headers.host, lan: ctx.lan });
      if (!target.ok) {
        sendError(res, 400, target.reason, 'invalid_request_error');
        return;
      }
      const png = await renderQrPng(target.url.href, { width: 320, margin: 2 });
      if (!png) {
        sendError(
          res,
          503,
          '未安装可选依赖 qrcode，无法生成二维码。请在项目目录执行 npm i qrcode 后重启。',
          'dependency_missing',
        );
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': String(png.length),
        'Cache-Control': 'no-store',
      });
      res.end(png);
      return;
    }

    // 6) 上游代理路由
    const upstreamPath = UPSTREAM_ROUTES[pathname];
    if (upstreamPath) {
      await handleProxyRoute(req, res, pathname, upstreamPath);
      return;
    }

    // 7) 未知 API
    if (pathname.startsWith('/api/')) {
      discardBody(req);
      sendError(res, 404, `没有该接口：${pathname}`, 'not_found_error');
      return;
    }

    // 8) 静态资源（GET/HEAD）
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      discardBody(req);
      sendError(res, 405, '静态资源仅支持 GET/HEAD', 'method_not_allowed');
      return;
    }
    await staticHandler.handle(req, res, pathname);
  }

  /** 处理 /api/* -> 上游的转发 */
  async function handleProxyRoute(req, res, pathname, upstreamPath) {
    // 余额与模型列表是 GET 透传，其余（对话/工具/文件）都是 POST
    const isGet = pathname === '/api/user/balance' || pathname === '/api/models';
    if (isGet && req.method !== 'GET' && req.method !== 'HEAD') {
      discardBody(req);
      sendError(res, 405, `${pathname} 仅支持 GET`, 'method_not_allowed');
      return;
    }
    if (!isGet && req.method !== 'POST') {
      discardBody(req);
      sendError(res, 405, `${pathname} 仅支持 POST`, 'method_not_allowed');
      return;
    }

    // 体积上限：先用 Content-Length 快速拒绝，流式超限在代理层兜底
    const maxBytes = BODY_LIMITS[pathname] ?? BODY_LIMITS.default;
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      discardBody(req);
      sendError(res, 413, `请求体超过上限（${maxBytes} 字节）`, 'invalid_request_error', { Connection: 'close' });
      return;
    }

    // Key 优先级：x-ds-key > Authorization Bearer > 环境变量
    const key = resolveApiKey(req, ctx.envKey);
    if (!key) {
      discardBody(req);
      sendError(
        res,
        401,
        '缺少 API Key：请在设置中填写，或为服务端配置 DEEPSEEK_API_KEY 环境变量',
        'authentication_error',
      );
      return;
    }

    const timeoutMs = TIMEOUTS[pathname] ?? TIMEOUTS.default;
    await proxy.forward(req, res, { path: upstreamPath, key, timeoutMs, maxBytes, label: pathname });
  }
}

/** 打印启动横幅（本地 URL / 手机 URL / HTTPS / 预置密钥 / Mock / 二维码） */
async function printBanner(ctx) {
  const { secure, mock, envKey, lan } = ctx;
  const actualPort = ctx.port;
  const scheme = secure ? 'https' : 'http';
  const primary = pickPrimaryIPv4(lan);
  const lanUrls = buildUrls(actualPort, secure, lan);
  const lines = [];
  const rule = '─'.repeat(52);
  lines.push('');
  lines.push(rule);
  lines.push(`  ${APP_NAME} · 局域网代理服务 v${VERSION}`);
  lines.push(rule);
  lines.push(`  本机访问： ${scheme}://localhost:${actualPort}`);
  lines.push(`  手机访问： ${lanUrls[0]?.url || `${scheme}://127.0.0.1:${actualPort}`}`);
  if (lanUrls.length > 1) {
    lines.push(`  其它网卡： ${lanUrls.slice(1, 4).map((item) => item.url).join('  ')}`);
  }
  lines.push(`  协议：     ${secure ? 'HTTPS（自签证书，浏览器需手动信任）' : 'HTTP（麦克风需改用 --https）'}`);
  lines.push(`  预置密钥： ${envKey ? '已配置（手机端可一键登录）' : '未配置（手机端需粘贴 API Key）'}`);
  lines.push(`  上游模式： ${mock ? 'Mock 离线模拟（无需联网与真实 Key）' : `真实 API（${ctx.baseUrl}）`}`);
  lines.push(`  运行平台： ${process.platform} · Node ${process.version}`);
  if (primary) {
    lines.push(`  主网卡：   ${primary.name} · ${primary.address}`);
  } else {
    lines.push('  主网卡：   未检测到局域网 IPv4（手机可能无法访问）');
  }
  lines.push(rule);
  lines.push('  提示：手机与电脑连接同一 Wi-Fi，用「手机访问」地址打开。');
  lines.push('  提示：语音输入（麦克风）需要 HTTPS 安全上下文，请用 --https 启动。');
  lines.push(rule);

  const qrTarget = lanUrls[0]?.url || `${scheme}://localhost:${actualPort}`;
  const qr = await renderQrTerminal(qrTarget);
  if (qr) {
    lines.push('');
    lines.push('  扫码在手机打开：');
    lines.push(qr.replace(/\n+$/, ''));
    lines.push('');
  } else {
    lines.push('  终端二维码：未安装可选依赖 qrcode，已跳过。可选执行：npm i qrcode');
  }
  lines.push(rule);
  lines.push('');
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`参数错误：${error.message}`);
    printHelp();
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    printHelp();
    return;
  }

  const logger = createLogger();
  const lan = listLanIPv4();
  const envKey = (process.env[ENV_KEY_NAME] || '').trim();
  const mockMode = options.mock;

  // 1) Mock 模式：先启动本机模拟上游，之后所有代理逻辑照常走真实转发
  let mockUpstream = null;
  let baseUrl = process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL;
  if (mockMode) {
    try {
      mockUpstream = await startMockUpstream({ logger });
      baseUrl = mockUpstream.url;
    } catch (error) {
      logger.error('Mock 上游启动失败：', error.message);
      process.exitCode = 1;
      return;
    }
  }

  // 2) HTTPS：读/生成证书，失败自动回退 HTTP（不退出）
  let secure = false;
  let tlsMaterial = null;
  if (options.https) {
    try {
      if (options.portable) {
        const certPath = path.join(ROOT_DIR, '.tls', 'cert.pem');
        const keyPath = path.join(ROOT_DIR, '.tls', 'key.pem');
        if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
          throw new Error('便携模式不自动生成证书，且 .tls/cert.pem 或 .tls/key.pem 不存在');
        }
      }
      tlsMaterial = await ensureCertificates({
        rootDir: ROOT_DIR,
        lanIps: lan.map((item) => item.address),
        logger,
      });
      secure = true;
    } catch (error) {
      logger.warn(`HTTPS 启用失败，已自动回退 HTTP：${error.message}`);
      logger.warn('手机端如需使用麦克风，请安装 OpenSSL 后重试，或手动放置 .tls/cert.pem 与 .tls/key.pem。');
      secure = false;
    }
  }

  // 3) 构建上下文与服务器
  const rateLimiter = new RateLimiter(RATE_LIMIT);
  const proxy = createProxy({ baseUrl, logger });
  const staticHandler = createStaticHandler({ rootDir: options.publicDir, logger });
  const ctx = {
    proxy,
    staticHandler,
    rateLimiter,
    logger,
    secure,
    port: options.port,
    mock: mockMode,
    envKey,
    lan,
    baseUrl,
  };

  const handler = createRequestHandler(ctx);
  const server = secure && tlsMaterial
    ? https.createServer({ cert: tlsMaterial.cert, key: tlsMaterial.key }, handler)
    : http.createServer(handler);

  let actualPort;
  try {
    actualPort = await listen(server, options.port, options.host);
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      logger.error(`端口 ${options.port} 已被占用，请换一个端口：node server.mjs --port 8788`);
    } else {
      logger.error(`监听 ${options.host}:${options.port} 失败：${error.message}`);
    }
    if (mockUpstream) await mockUpstream.close().catch(() => {});
    rateLimiter.dispose();
    process.exitCode = 1;
    return;
  }
  ctx.port = actualPort;

  // 4) 启动横幅（二维码尽力而为）
  try {
    await printBanner(ctx);
  } catch (error) {
    logger.warn('启动横幅打印失败（不影响服务）：', error.message);
  }

  // 5) 供测试/工具解析的就绪行；不参与业务
  process.stdout.write(`[ready] ${JSON.stringify({ port: actualPort, https: secure, mock: mockMode, host: options.host })}\n`);

  // 6) 优雅退出
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收到 ${signal}，正在关闭服务……`);
    const forceTimer = setTimeout(() => process.exit(0), 3000);
    if (typeof forceTimer.unref === 'function') forceTimer.unref();
    try {
      await new Promise((resolve) => server.close(resolve));
    } catch {
      /* 忽略关闭异常 */
    }
    if (mockUpstream) {
      try {
        await mockUpstream.close();
      } catch {
        /* 忽略 */
      }
    }
    rateLimiter.dispose();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 不吞异常：记录后退出，暴露问题
  process.on('uncaughtException', (error) => {
    logger.error('未捕获异常：', error?.stack || error);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝：', reason);
  });
}

main().catch((error) => {
  console.error('服务启动失败：', error?.stack || error);
  process.exitCode = 1;
});
