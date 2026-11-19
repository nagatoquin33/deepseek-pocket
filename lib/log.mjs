/**
 * 安全日志。
 *
 * 原则：任何日志、错误体都不得包含 API Key。调用方应尽量不把请求头交给日志，
 * 本模块再做一层兜底脱敏，保证即使误传整段 JSON / 头部字符串也不会泄漏。
 */

/** 常见密钥形态（DeepSeek 的 sk- 前缀 + 各种 Bearer / 头部片段） */
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_\-]{4,}/g,
  /(bearer\s+)[A-Za-z0-9._\-]{4,}/gi,
  /((?:x-ds-key|authorization|api[_-]?key)["'\s:=]+)[^\s"',;}]+/gi,
];

/**
 * 把一段文本里的疑似密钥替换为 ***。
 * @param {unknown} value
 * @returns {string}
 */
export function redact(value) {
  let text;
  if (typeof value === 'string') {
    text = value;
  } else if (value instanceof Error) {
    text = value.stack || value.message;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (!text) return '';
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m, prefix) => `${prefix ?? ''}***`);
  return out;
}

function stamp() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

/**
 * 创建一个日志器。所有输出都经过 redact，避免密钥泄漏。
 * @param {{silent?: boolean, prefix?: string}} [options]
 */
export function createLogger(options = {}) {
  const { silent = false, prefix = 'server' } = options;

  const write = (stream, level, args) => {
    if (silent) return;
    const line = `${stamp()} [${prefix}] ${level} ${args.map(redact).join(' ')}`;
    stream.write(`${line}\n`);
  };

  return {
    info: (...args) => write(process.stdout, '信息', args),
    warn: (...args) => write(process.stderr, '警告', args),
    error: (...args) => write(process.stderr, '错误', args),
  };
}

/** 供无 logger 依赖的小模块使用的默认日志器 */
export const defaultLogger = createLogger();
