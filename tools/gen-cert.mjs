/**
 * 自签 HTTPS 证书生成工具。
 *
 * 证书 SAN 覆盖：localhost、127.0.0.1、全部局域网 IPv4（可选本机主机名）。
 * 用途：手机通过 HTTPS 访问局域网服务时，浏览器才允许使用麦克风（安全上下文）。
 *
 * 单独运行：node tools/gen-cert.mjs [--dir .tls]
 * 由 lib/tls.mjs 在 --https 启动时自动调用。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listLanIPv4 } from '../lib/net.mjs';

const IS_WINDOWS = process.platform === 'win32';

/**
 * 探测系统 openssl：优先 PATH（where/which，Windows 等价于 PowerShell Get-Command），
 * 再尝试常见安装路径（本机 Anaconda、Git for Windows、OpenSSL 官方安装包等）。
 * @returns {string | null}
 */
export function findOpenssl() {
  const fromEnv = process.env.OPENSSL_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  // 1) PATH 探测：where.exe openssl（Windows）/ which openssl（类 Unix）
  try {
    const finder = IS_WINDOWS ? 'where.exe' : 'which';
    const output = execFileSync(finder, ['openssl'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && fs.existsSync(line));
    if (first) return first;
  } catch {
    /* 继续尝试其它方式 */
  }

  // 2) Windows 下再用 PowerShell Get-Command 探测一次（覆盖 where 被策略限制的情况）
  if (IS_WINDOWS) {
    try {
      const ps = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', '(Get-Command openssl -ErrorAction SilentlyContinue).Source'],
        { encoding: 'utf8', timeout: 15_000, windowsHide: true },
      );
      const found = (ps.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (found && fs.existsSync(found)) return found;
    } catch {
      /* 继续尝试常见路径 */
    }
  }

  // 3) 常见安装路径
  const candidates = IS_WINDOWS
    ? [
        'C:\\Users\\nagatoquin\\anaconda3\\Library\\bin\\openssl.exe',
        'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
        'C:\\Program Files\\Git\\bin\\openssl.exe',
        'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
        'C:\\Program Files\\OpenSSL\\bin\\openssl.exe',
        'C:\\ProgramData\\chocolatey\\bin\\openssl.exe',
        'C:\\msys64\\usr\\bin\\openssl.exe',
      ]
    : ['/usr/bin/openssl', '/usr/local/bin/openssl', '/opt/homebrew/bin/openssl'];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 生成自签证书。
 * @param {{dir: string, ips?: string[], log?: (msg: string) => void, days?: number}} options
 * @returns {Promise<{certPath: string, keyPath: string, san: string}>}
 */
export async function generateCertificate({ dir, ips = [], log = () => {}, days = 825 }) {
  const openssl = findOpenssl();
  if (!openssl) {
    throw new Error(
      '未找到 openssl。请安装 OpenSSL，或把可执行文件路径写入环境变量 OPENSSL_BIN；也可手动把证书放到 .tls/cert.pem 与 .tls/key.pem。',
    );
  }
  log(`使用 openssl：${openssl}`);

  const tlsDir = path.resolve(dir);
  fs.mkdirSync(tlsDir, { recursive: true });
  const certPath = path.join(tlsDir, 'cert.pem');
  const keyPath = path.join(tlsDir, 'key.pem');

  // SAN：localhost + 回环 + 全部局域网 IPv4（去重）
  const ipSet = new Set(['127.0.0.1', ...ips.filter(Boolean)]);
  const dnsNames = new Set(['localhost']);
  const hostname = safeHostname();
  if (hostname) dnsNames.add(hostname);
  const sanParts = [...[...dnsNames].map((name) => `DNS:${name}`), ...[...ipSet].map((ip) => `IP:${ip}`)];
  const san = sanParts.join(',');

  const commonArgs = [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-days',
    String(days),
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-subj',
    '/CN=DeepSeek Mobile Local Dev',
  ];

  // 首选显式配置文件：Windows 版 OpenSSL（如 Anaconda 自带）默认 OPENSSL_CONF 指向不存在的
  // 路径，直接 -addext 会因加载默认配置失败；显式 -config 最稳。
  const cnfPath = path.join(tlsDir, 'openssl.cnf');
  const altNameLines = [
    ...[...dnsNames].map((name, i) => `DNS.${i + 1} = ${name}`),
    ...[...ipSet].map((ip, i) => `IP.${i + 1} = ${ip}`),
  ].join('\n');
  fs.writeFileSync(
    cnfPath,
    [
      '[req]',
      'distinguished_name = dn',
      'x509_extensions = v3_req',
      'prompt = no',
      '[dn]',
      'CN = DeepSeek Mobile Local Dev',
      '[v3_req]',
      'basicConstraints = CA:FALSE',
      'keyUsage = digitalSignature, keyEncipherment',
      'extendedKeyUsage = serverAuth',
      'subjectAltName = @alt_names',
      '[alt_names]',
      altNameLines,
      '',
    ].join('\n'),
    'utf8',
  );

  let result = spawnSync(openssl, [...commonArgs, '-config', cnfPath], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });

  if (result.status !== 0) {
    // 兜底：某些 OpenSSL 构建（如 macOS LibreSSL）对 config 支持不同，退回 -addext
    log('openssl 配置文件方式失败，改用 -addext 重试……');
    result = spawnSync(openssl, [...commonArgs, '-addext', `subjectAltName=${san}`], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
  }
  try {
    fs.unlinkSync(cnfPath);
  } catch {
    /* 清理失败无妨 */
  }

  if (result.status !== 0) {
    const details = `${result.stderr || ''}\n${result.stdout || ''}`.trim().slice(0, 1200);
    throw new Error(`openssl 生成证书失败（退出码 ${result.status ?? '未知'}）：${details}`);
  }

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    throw new Error('openssl 执行完成但证书文件不存在，请检查 .tls 目录权限。');
  }

  // 私钥权限收紧（Windows 上 chmod 语义有限，失败忽略）
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    /* 忽略 */
  }

  log(`证书已生成：${certPath}`);
  log(`私钥已生成：${keyPath}`);
  log(`SAN：${san}`);
  return { certPath, keyPath, san };
}

function safeHostname() {
  try {
    const name = os.hostname();
    // 只接受可做 DNS 名的简单主机名
    return /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

/** 判断当前文件是否被直接执行（而非被 import） */
function isMain() {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = process.argv.slice(2);
  const dirIndex = args.indexOf('--dir');
  const dir = dirIndex !== -1 && args[dirIndex + 1] ? args[dirIndex + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.tls');
  const ips = listLanIPv4().map((item) => item.address);
  generateCertificate({ dir, ips, log: (msg) => console.log(msg) })
    .then(({ san }) => {
      console.log('证书生成完成，可用 --https 启动。');
      console.log(`SAN：${san}`);
    })
    .catch((error) => {
      console.error(`证书生成失败：${error.message}`);
      console.error('可先手动生成证书放到 .tls/cert.pem 与 .tls/key.pem，或去掉 --https 用 HTTP 启动。');
      process.exitCode = 1;
    });
}
