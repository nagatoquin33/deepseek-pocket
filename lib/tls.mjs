/**
 * HTTPS 证书准备：优先复用 .tls/cert.pem + .tls/key.pem；
 * 缺失时调用 tools/gen-cert.mjs 用系统 openssl 生成自签证书。
 * 生成失败由调用方决定是否回退 HTTP（本模块只抛出错误，不退出进程）。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {{rootDir: string, lanIps?: string[], logger?: {info: Function, warn: Function}}} options
 * @returns {Promise<{cert: Buffer, key: Buffer, certPath: string, keyPath: string, generated: boolean}>}
 */
export async function ensureCertificates({ rootDir, lanIps = [], logger }) {
  const tlsDir = path.join(rootDir, '.tls');
  const certPath = path.join(tlsDir, 'cert.pem');
  const keyPath = path.join(tlsDir, 'key.pem');

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    logger?.info(`复用已有证书：${path.relative(rootDir, certPath)}`);
    return {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
      certPath,
      keyPath,
      generated: false,
    };
  }

  logger?.info('未找到 .tls 证书，正在用 openssl 生成自签证书……');
  const { generateCertificate } = await import('../tools/gen-cert.mjs');
  await generateCertificate({ dir: tlsDir, ips: lanIps, log: logger?.info?.bind(logger) });
  return {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
    certPath,
    keyPath,
    generated: true,
  };
}
