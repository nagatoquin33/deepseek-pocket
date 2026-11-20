#!/usr/bin/env node
/**
 * doctor —— 一键环境体检。
 *
 * 用法：
 *   node tools/doctor.mjs             # 人类可读报告
 *   node tools/doctor.mjs --json      # 机器可读（CI / 脚本）
 *   node tools/doctor.mjs --network   # 额外检查 api.deepseek.com 可达性（可选、离线时别加）
 *
 * 检查项：
 *   1. Node 版本（>= 20）
 *   2. openssl 可用性（生成 HTTPS 自签证书需要）
 *   3. .tls 证书是否存在、SAN 是否覆盖本机局域网 IP、是否临期/过期
 *   4. 端口 8787 / 8899 占用情况
 *   5. JDK（java / javac / keytool，打包 APK 需要）
 *   6. Android SDK（build-tools 的 aapt2/d8/zipalign/apksigner + platforms 的 android.jar）
 *   7. android/debug.keystore 签名文件
 *   8. （可选 --network）api.deepseek.com 可达性
 *
 * 输出分级：OK / WARN / FAIL，并附修复建议。
 * 退出码：0 = 没有 FAIL；1 = 存在 FAIL；2 = 脚本自身异常。
 *
 * 设计：零依赖、不运行 git；纯函数（版本判断、端口结果解析、证书解析、汇总、报告格式化）
 * 全部导出，便于 test/doctor.test.mjs 直接单测。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

import { findOpenssl } from './gen-cert.mjs';
import { listLanIPv4 } from '../lib/net.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WINDOWS = process.platform === 'win32';
const CHECKED_PORTS = [8787, 8899];
const MIN_NODE_MAJOR = 20;
const CERT_MIN_DAYS = 30;

/** 体检等级 */
export const LEVELS = Object.freeze({ OK: 'OK', WARN: 'WARN', FAIL: 'FAIL' });

// ===========================================================================
// 纯函数：版本判断
// ===========================================================================

/**
 * 解析 Node 风格版本号（"v22.23.4" / "22.23" / "20"）。
 * @param {unknown} raw
 * @returns {{major: number, minor: number, patch: number} | null}
 */
export function parseNodeVersion(raw) {
  if (typeof raw !== 'string') return null;
  const match = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?([-+].*)?\s*$/.exec(raw);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2] || 0),
    patch: Number(match[3] || 0),
  };
}

/** 把各种版本输入统一成 [major, minor, patch] */
function normalizeVersion(value) {
  if (Array.isArray(value)) {
    const nums = value.map(Number);
    return nums.length >= 1 && nums.every(Number.isFinite) ? [...nums, 0, 0, 0].slice(0, 3) : null;
  }
  if (typeof value === 'object' && value !== null) {
    const nums = [value.major, value.minor || 0, value.patch || 0].map(Number);
    return nums.every(Number.isFinite) ? nums : null;
  }
  const parsed = parseNodeVersion(value);
  return parsed ? [parsed.major, parsed.minor, parsed.patch] : null;
}

/**
 * 比较两个版本：a > b 返回 1，a < b 返回 -1，相等返回 0。
 * @param {string | number[] | {major:number, minor?:number, patch?:number}} a
 * @param {string | number[] | {major:number, minor?:number, patch?:number}} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const left = normalizeVersion(a);
  const right = normalizeVersion(b);
  if (!left || !right) throw new TypeError('compareVersions 需要可解析的版本号');
  for (let i = 0; i < 3; i += 1) {
    if (left[i] > right[i]) return 1;
    if (left[i] < right[i]) return -1;
  }
  return 0;
}

/**
 * 评估 Node 版本是否满足最低要求。
 * @param {string} version 例如 process.version
 * @param {{minMajor?: number}} [options]
 * @returns {{level: string, message: string, hint: string}}
 */
export function evaluateNodeVersion(version, options = {}) {
  const minMajor = options.minMajor ?? MIN_NODE_MAJOR;
  const parsed = parseNodeVersion(version);
  if (!parsed) {
    return {
      level: LEVELS.FAIL,
      message: `无法解析版本：${String(version)}`,
      hint: '运行 node -v 确认输出正常；若 Node 损坏请重新安装 Node 20 LTS 或更新版本',
    };
  }
  if (parsed.major < minMajor) {
    return {
      level: LEVELS.FAIL,
      message: `${version} 低于最低要求 v${minMajor}+`,
      hint: `安装 Node ${minMajor} LTS 或更新版本：https://nodejs.org/（本项目 package.json engines 要求 >=${minMajor}）`,
    };
  }
  return {
    level: LEVELS.OK,
    message: `${version}（要求 v${minMajor}+）`,
    hint: '',
  };
}

/**
 * 从 `java -version` / `javac -version` 的输出里解析主版本号。
 * 兼容 "openjdk version \"21.0.2\""、"java version \"1.8.0_402\""（→ 8）、"javac 17.0.9"。
 * @param {string} text
 * @returns {{major: number, raw: string} | null}
 */
export function parseJavaVersion(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const quoted = /version\s+"([^"]+)"/i.exec(text);
  const raw = quoted ? quoted[1] : (/(?:javac|openjdk|java)\s+([0-9][0-9._+-]*)/i.exec(text)?.[1] ?? null);
  if (!raw) return null;
  const parts = raw.split(/[._+-]/).map(Number).filter(Number.isFinite);
  if (parts.length === 0) return null;
  let major = parts[0];
  // 1.8.0_402 → 8
  if (major === 1 && parts.length > 1) major = parts[1];
  return { major, raw };
}

/**
 * 从 `openssl version` 输出里解析版本号。
 * @param {string} text
 * @returns {string | null}
 */
export function parseOpenSslVersion(text) {
  if (typeof text !== 'string') return null;
  const match = /OpenSSL\s+(\d+\.\d+(?:\.\d+)?[a-z]?)/i.exec(text);
  return match ? match[1] : null;
}

// ===========================================================================
// 纯函数：端口 / 网络 / 证书
// ===========================================================================

/**
 * 把端口探测结果翻译成体检结论（纯函数，便于单测）。
 * probe 结果约定：errorCode 为空表示端口空闲，否则为监听失败的 code。
 * @param {{port: number, errorCode?: string|null, errorMessage?: string}} probe
 * @returns {{level: string, message: string, hint: string}}
 */
export function interpretPortProbe(probe = {}) {
  const port = Number(probe.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return { level: LEVELS.WARN, message: `端口号非法：${String(probe.port)}`, hint: '端口应为 0-65535 的整数' };
  }
  if (!probe.errorCode) {
    return { level: LEVELS.OK, message: '空闲', hint: '' };
  }
  if (probe.errorCode === 'EADDRINUSE') {
    return {
      level: LEVELS.WARN,
      message: '已被占用',
      hint: `若已有 server.mjs 在运行，说明服务正常；否则换端口启动：node server.mjs --port ${port === 8787 ? 8899 : 8787}`,
    };
  }
  if (probe.errorCode === 'EACCES') {
    return {
      level: LEVELS.WARN,
      message: '无权限监听（EACCES）',
      hint: '改用 1024 以上端口，并检查防火墙/杀毒软件是否拦截 Node',
    };
  }
  return {
    level: LEVELS.WARN,
    message: `检测失败（${probe.errorCode}）`,
    hint: `检查本机网络栈与权限后重试${probe.errorMessage ? `：${probe.errorMessage}` : ''}`,
  };
}

/**
 * 从 `openssl x509 -in cert.pem -noout -text` 的输出里解析主题、有效期与 SAN。
 * @param {string} text
 * @returns {{subject: string|null, notBefore: Date|null, notAfter: Date|null, sanLine: string|null, dns: string[], ips: string[]} | null}
 */
export function parseCertificateInfo(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const grab = (re) => {
    const match = re.exec(text);
    return match ? match[1].trim() : null;
  };
  const subject = grab(/Subject:\s*(.+)/);
  const notBeforeText = grab(/Not Before\s*:\s*(.+)/);
  const notAfterText = grab(/Not After\s*:\s*(.+)/);
  const sanLine = grab(/X509v3 Subject Alternative Name:\s*\r?\n\s*([^\r\n]+)/);
  const dns = sanLine ? [...sanLine.matchAll(/DNS:([^,\s]+)/g)].map((item) => item[1]) : [];
  const ips = sanLine
    ? [...sanLine.matchAll(/IP(?:\s+Address)?\s*:\s*([^,\s]+)/g)].map((item) => item[1])
    : [];
  if (!subject && !notAfterText && !sanLine) return null;
  const notBefore = notBeforeText ? new Date(notBeforeText) : null;
  const notAfter = notAfterText ? new Date(notAfterText) : null;
  return {
    subject,
    notBefore: notBefore && !Number.isNaN(notBefore.getTime()) ? notBefore : null,
    notAfter: notAfter && !Number.isNaN(notAfter.getTime()) ? notAfter : null,
    sanLine,
    dns,
    ips,
  };
}

/**
 * 评估 HTTPS 证书状态（纯函数）。
 * @param {{exists: boolean, info: ReturnType<typeof parseCertificateInfo>|null, lanIps?: string[], now?: number, minDays?: number}} input
 * @returns {{level: string, message: string, hint: string}}
 */
export function evaluateCertificate(input = {}) {
  const { exists, info, lanIps = [], now = Date.now(), minDays = CERT_MIN_DAYS } = input;
  if (!exists) {
    return {
      level: LEVELS.WARN,
      message: '未找到 .tls/cert.pem + key.pem',
      hint: 'HTTPS 首次启动会自动生成；也可运行 npm run cert。仅用 HTTP 时可忽略（但手机麦克风需要 HTTPS）',
    };
  }
  if (!info) {
    return {
      level: LEVELS.WARN,
      message: '文件存在但无法解析（可能缺少 openssl）',
      hint: '安装 OpenSSL 或设置 OPENSSL_BIN；也可删除 .tls/ 后重新执行 npm run https',
    };
  }
  const notAfterMs = info.notAfter ? info.notAfter.getTime() : NaN;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(notAfterMs)) {
    return {
      level: LEVELS.WARN,
      message: '无法解析有效期',
      hint: '重新生成证书：npm run cert，或删除 .tls/ 后执行 npm run https',
    };
  }
  const dateText = new Date(notAfterMs).toISOString().slice(0, 10);
  const daysLeft = Math.floor((notAfterMs - nowMs) / 86_400_000);
  if (daysLeft <= 0) {
    return {
      level: LEVELS.FAIL,
      message: `已过期（有效期至 ${dateText}）`,
      hint: '删除 .tls/ 后重新执行 npm run https（或 npm run cert）生成新证书',
    };
  }
  const ips = Array.isArray(info.ips) ? info.ips : [];
  const dns = Array.isArray(info.dns) ? info.dns : [];
  const missingIps = lanIps.filter((ip) => !ips.includes(ip));
  const missingLocalhost = !dns.includes('localhost') || !ips.includes('127.0.0.1');
  if (daysLeft < minDays) {
    return {
      level: LEVELS.WARN,
      message: `将在 ${daysLeft} 天后过期（${dateText}）`,
      hint: '提前重新生成：npm run cert（SAN 会写入当前局域网 IP）',
    };
  }
  if (missingIps.length > 0 || missingLocalhost) {
    const parts = [];
    if (missingIps.length > 0) parts.push(`缺少局域网 IP：${missingIps.join('、')}`);
    if (missingLocalhost) parts.push('缺少 localhost/127.0.0.1');
    return {
      level: LEVELS.WARN,
      message: `SAN 不完整（${parts.join('；')}）`,
      hint: '删除 .tls/ 后重新执行 npm run https，或 npm run cert（会写入全部局域网 IP）',
    };
  }
  return {
    level: LEVELS.OK,
    message: `有效至 ${dateText}（还剩 ${daysLeft} 天），SAN 含 localhost 与 ${ips.length} 个 IP`,
    hint: '',
  };
}

/**
 * 评估 openssl 可用性（纯函数）。
 * @param {{path?: string|null, versionText?: string}} input
 */
export function evaluateOpenSsl(input = {}) {
  const opensslPath = input.path || null;
  if (!opensslPath) {
    return {
      level: LEVELS.WARN,
      message: '未检测到 openssl（HTTPS 证书生成会失败并回退 HTTP）',
      hint: '安装 OpenSSL，或设置环境变量 OPENSSL_BIN 指向 openssl 可执行文件',
    };
  }
  const version = parseOpenSslVersion(input.versionText || '');
  return {
    level: LEVELS.OK,
    message: `${version || '已安装'}（${opensslPath}）`,
    hint: '',
  };
}

/**
 * 评估 --network 探测结果（纯函数）。
 * @param {{statusCode?: number|null, error?: {code?: string, message?: string}|null, url?: string}} input
 */
export function evaluateNetworkResult(input = {}) {
  const url = input.url || 'https://api.deepseek.com';
  if (input.error) {
    return {
      level: LEVELS.WARN,
      message: `无法连接 ${url}（${input.error.code || input.error.message || '网络错误'}）`,
      hint: '检查网络/代理/防火墙；离线开发可用 node server.mjs --mock，不依赖外网',
    };
  }
  const status = Number(input.statusCode);
  if (!Number.isFinite(status)) {
    return { level: LEVELS.WARN, message: `${url} 未返回有效状态码`, hint: '稍后重试，或检查系统代理设置' };
  }
  if (status >= 500) {
    return {
      level: LEVELS.WARN,
      message: `${url} 返回 HTTP ${status}（可达，但上游异常）`,
      hint: '稍后重试；也可先用 --mock 离线开发',
    };
  }
  return {
    level: LEVELS.OK,
    message: `可达（HTTP ${status}${status === 401 ? '，未鉴权返回 401 属正常' : ''}）`,
    hint: '',
  };
}

// ===========================================================================
// 纯函数：JDK / Android SDK / 签名文件
// ===========================================================================

/**
 * @param {{present?: boolean, javacPath?: string|null, keytoolPath?: string|null, major?: number|null}} input
 */
export function evaluateJdk(input = {}) {
  const { present, javacPath, keytoolPath, major = null } = input;
  if (!present) {
    return {
      level: LEVELS.WARN,
      message: '未找到 java（仅打包 APK 需要；PWA 与服务端不受影响）',
      hint: '安装 JDK 17/21 并配置 JAVA_HOME，或使用 Android Studio 自带的 JDK',
    };
  }
  const versionLabel = major ? `${major}` : '版本未知';
  const missing = [];
  if (!javacPath) missing.push('javac');
  if (!keytoolPath) missing.push('keytool');
  if (major && major < 11) {
    return {
      level: LEVELS.WARN,
      message: `${versionLabel} 版本偏低${missing.length ? `，且缺少 ${missing.join('/')}` : ''}`,
      hint: '建议升级到 JDK 17 或 21（build-tools 36 的 d8 对新 JDK 兼容更好）',
    };
  }
  if (missing.length > 0) {
    return {
      level: LEVELS.WARN,
      message: `${versionLabel} 可用，但缺少 ${missing.join('/')}`,
      hint: '确认 JDK 的 bin 目录在 PATH 中（javac/keytool 应与 java 同目录）',
    };
  }
  return { level: LEVELS.OK, message: `${versionLabel}（java/javac/keytool 可用）`, hint: '' };
}

/**
 * @param {{found?: boolean, path?: string, buildToolsPath?: string|null, androidJarPath?: string|null, missing?: string[]}} input
 */
export function evaluateAndroidSdk(input = {}) {
  if (!input.found) {
    return {
      level: LEVELS.WARN,
      message: '未找到（仅打包 APK 需要）',
      hint: '设置 ANDROID_HOME，或按 android/build.ps1 里的 $sdk 路径准备 build-tools（aapt2、lib/d8.jar、zipalign、apksigner）与 platforms/*/android.jar',
    };
  }
  const missing = Array.isArray(input.missing) ? input.missing : [];
  if (missing.length > 0) {
    return {
      level: LEVELS.WARN,
      message: `缺少组件：${missing.join('、')}（${input.path}）`,
      hint: '补齐 build-tools 与 platform 后重试；也可用 Android Studio SDK Manager 安装',
    };
  }
  return {
    level: LEVELS.OK,
    message: `可用 ${input.buildToolsPath} · android.jar: ${input.androidJarPath}`,
    hint: '',
  };
}

/**
 * @param {{exists?: boolean, size?: number, filePath?: string}} input
 */
export function evaluateKeystore(input = {}) {
  const filePath = input.filePath || 'android/debug.keystore';
  if (!input.exists) {
    return {
      level: LEVELS.WARN,
      message: `未找到（${filePath}）`,
      hint: '首次执行 android/build.ps1 会自动用 keytool 生成（需 JDK）；也可手动 keytool -genkeypair 生成',
    };
  }
  const size = Number(input.size || 0);
  if (size <= 0) {
    return { level: LEVELS.WARN, message: '是空文件', hint: '删除后重新打包，build 脚本会自动生成' };
  }
  return { level: LEVELS.OK, message: `存在（${size} 字节）`, hint: '' };
}

// ===========================================================================
// 纯函数：汇总与格式化
// ===========================================================================

/**
 * 汇总体检结果。
 * @param {{level: string}[]} checks
 * @returns {{ok: number, warn: number, fail: number, total: number, worst: string}}
 */
export function summarizeResults(checks = []) {
  const summary = { ok: 0, warn: 0, fail: 0, total: Array.isArray(checks) ? checks.length : 0, worst: LEVELS.OK };
  for (const check of checks || []) {
    if (check?.level === LEVELS.OK) summary.ok += 1;
    else if (check?.level === LEVELS.WARN) summary.warn += 1;
    else if (check?.level === LEVELS.FAIL) summary.fail += 1;
  }
  summary.worst = summary.fail > 0 ? LEVELS.FAIL : summary.warn > 0 ? LEVELS.WARN : LEVELS.OK;
  return summary;
}

function formatTimestamp(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

/**
 * 把体检报告格式化成人类可读文本（纯函数）。
 * @param {{checks?: {level:string,title:string,message:string,hint?:string}[], summary?: ReturnType<typeof summarizeResults>, generatedAt?: string, platform?: string, node?: string}} report
 * @returns {string}
 */
export function formatHumanReport(report = {}) {
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const summary = report.summary || summarizeResults(checks);
  const lines = [];
  lines.push('DeepSeek 随身版 · 环境体检');
  lines.push(
    `时间：${formatTimestamp(report.generatedAt)} · 平台：${report.platform || process.platform} · Node ${report.node || process.version}`,
  );
  lines.push('');
  if (checks.length === 0) {
    lines.push('（没有可执行的检查项）');
  } else {
    for (const check of checks) {
      lines.push(`[${check.level}] ${check.title}：${check.message}`);
      if (check.hint) lines.push(`         建议：${check.hint}`);
    }
  }
  lines.push('');
  const verdict =
    summary.fail > 0
      ? '存在 FAIL，请按建议修复'
      : summary.warn > 0
        ? '可以使用，WARN 项按需处理'
        : '全部通过';
  lines.push(`汇总：OK ${summary.ok} · WARN ${summary.warn} · FAIL ${summary.fail}（共 ${summary.total} 项）→ ${verdict}`);
  if (report.networkChecked === false) {
    lines.push('提示：本次未检查外网。需要时加 --network（或离线用 --mock）。');
  }
  return `${lines.join('\n')}\n`;
}

// ===========================================================================
// 实际检查（带 IO）
// ===========================================================================

/** PATH 探测可执行文件（Windows 用 where.exe，类 Unix 用 which） */
function which(command) {
  try {
    const finder = IS_WINDOWS ? 'where.exe' : 'which';
    const output = execFileSync(finder, [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && fs.existsSync(line)) || null;
  } catch {
    return null;
  }
}

/** 在 PATH 与 JAVA_HOME 中查找 JDK 工具 */
function findJavaTool(name) {
  const exe = IS_WINDOWS ? `${name}.exe` : name;
  const fromPath = which(name);
  if (fromPath) return fromPath;
  if (process.env.JAVA_HOME) {
    const candidate = path.join(process.env.JAVA_HOME, 'bin', exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** 运行命令并把 stdout/stderr 合并返回（java -version 走 stderr） */
function runVersionCommand(command, args = []) {
  if (!command) return '';
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    return `${result.stdout || ''}${result.stderr || ''}`.trim();
  } catch {
    return '';
  }
}

function inspectJdk() {
  const javaPath = findJavaTool('java');
  const javacPath = findJavaTool('javac');
  const keytoolPath = findJavaTool('keytool');
  const versionText = javaPath ? runVersionCommand(javaPath, ['-version']) : '';
  const parsed = versionText ? parseJavaVersion(versionText) : null;
  return {
    present: Boolean(javaPath),
    javaPath,
    javacPath,
    keytoolPath,
    versionText,
    major: parsed ? parsed.major : null,
  };
}

/** 从 android/build.ps1 里读出 $sdk 路径，保证 doctor 与打包脚本一致 */
function readSdkFromBuildScript(rootDir) {
  const scriptPath = path.join(rootDir, 'android', 'build.ps1');
  try {
    const text = fs.readFileSync(scriptPath, 'utf8');
    const match = /\$sdk\s*=\s*['"]([^'"]+)['"]/.exec(text);
    if (match) return path.resolve(rootDir, match[1]);
  } catch {
    /* 没有 build.ps1 时忽略 */
  }
  return null;
}

function sdkCandidates(rootDir) {
  const candidates = [];
  const fromScript = readSdkFromBuildScript(rootDir);
  if (fromScript) candidates.push(fromScript);
  for (const envName of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    if (process.env[envName]) candidates.push(process.env[envName]);
  }
  if (IS_WINDOWS && process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'));
  }
  candidates.push(path.join(rootDir, 'android', 'sdk'), path.join(rootDir, '.android-sdk'));
  if (!IS_WINDOWS) {
    candidates.push('/opt/android-sdk', path.join(os.homedir(), 'Android', 'Sdk'));
  }
  return [...new Set(candidates.filter(Boolean))];
}

function existsAny(baseDir, names) {
  return names.some((name) => fs.existsSync(path.join(baseDir, name)));
}

/** 检查某个 SDK 目录：build-tools 可能在根下或嵌套一层（如 build-tools-36/android-16） */
function inspectSdkAt(sdkPath) {
  const buildToolDirs = [];
  for (const rootName of ['build-tools-36', 'build-tools']) {
    const root = path.join(sdkPath, rootName);
    if (!fs.existsSync(root)) continue;
    if (fs.existsSync(path.join(root, 'lib', 'd8.jar'))) buildToolDirs.push(root);
    let children = [];
    try {
      children = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(root, entry.name));
    } catch {
      children = [];
    }
    for (const child of children) {
      if (fs.existsSync(path.join(child, 'lib', 'd8.jar'))) buildToolDirs.push(child);
    }
  }
  let androidJars = [];
  try {
    const platformRoot = path.join(sdkPath, 'platforms');
    androidJars = fs
      .readdirSync(platformRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(platformRoot, entry.name))
      .filter((dir) => fs.existsSync(path.join(dir, 'android.jar')));
  } catch {
    androidJars = [];
  }

  const buildToolsPath = buildToolDirs[0] || null;
  const androidJarPath = androidJars[0] || null;
  if (!buildToolsPath && !androidJarPath) return null;

  const missing = [];
  if (!buildToolsPath) missing.push('build-tools/lib/d8.jar');
  if (!androidJarPath) missing.push('platforms/*/android.jar');
  if (buildToolsPath) {
    if (!existsAny(buildToolsPath, ['aapt2.exe', 'aapt2'])) missing.push('aapt2');
    if (!existsAny(buildToolsPath, ['zipalign.exe', 'zipalign'])) missing.push('zipalign');
    if (!existsAny(buildToolsPath, ['apksigner.bat', 'apksigner', 'apksigner.jar'])) missing.push('apksigner');
  }
  return { found: true, path: sdkPath, buildToolsPath, androidJarPath, missing };
}

function inspectAndroidSdk(rootDir) {
  const candidates = sdkCandidates(rootDir);
  let best = null;
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const info = inspectSdkAt(candidate);
    if (!info) continue;
    if (!best || info.missing.length < best.missing.length) best = info;
    if (best.missing.length === 0) break;
  }
  return best || { found: false, candidates };
}

/** 读取证书并解析 SAN / 有效期 */
function inspectCertificates(rootDir, opensslPath) {
  const certPath = path.join(rootDir, '.tls', 'cert.pem');
  const keyPath = path.join(rootDir, '.tls', 'key.pem');
  const certExists = fs.existsSync(certPath);
  const keyExists = fs.existsSync(keyPath);
  const result = { exists: certExists && keyExists, certExists, keyExists, certPath, keyPath, info: null };
  if (!result.exists || !opensslPath) return result;
  try {
    const text = execFileSync(opensslPath, ['x509', '-in', certPath, '-noout', '-text'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    result.info = parseCertificateInfo(text);
  } catch {
    result.info = null;
  }
  return result;
}

/** 端口探测：尝试监听 127.0.0.1，EADDRINUSE 表示已被占用 */
function probePort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const done = (errorCode = null, errorMessage = '') => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        /* 忽略 */
      }
      resolve({ port, errorCode, errorMessage });
    };
    server.once('error', (error) => done(error.code || 'UNKNOWN', error.message));
    server.listen(port, host, () => done(null));
  });
}

/** 可选外网探测（HEAD，够判断可达性；不读取正文） */
function probeNetwork(url = 'https://api.deepseek.com/models', timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let request;
    try {
      request = https.request(
        url,
        {
          method: 'HEAD',
          timeout: timeoutMs,
          headers: { 'user-agent': 'deepseek-pocket-doctor', accept: 'application/json' },
        },
        (response) => {
          response.resume();
          response.on('end', () => done({ statusCode: response.statusCode }));
        },
      );
    } catch (error) {
      done({ error });
      return;
    }
    request.on('timeout', () => {
      request.destroy(Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' }));
    });
    request.on('error', (error) => done({ error }));
    request.end();
  });
}

// ===========================================================================
// 体检主流程
// ===========================================================================

/**
 * 执行所有检查并返回结构化报告。
 * @param {{network?: boolean, rootDir?: string, now?: number, lanIps?: string[]}} [options]
 */
export async function runDoctor(options = {}) {
  const {
    network = false,
    rootDir = ROOT_DIR,
    now = Date.now(),
    lanIps = listLanIPv4().map((item) => item.address),
  } = options;

  const checks = [];
  const push = (id, title, result) => {
    checks.push({ id, title, level: result.level, message: result.message, hint: result.hint || '' });
  };

  // 1) Node
  push('node', 'Node 版本', evaluateNodeVersion(process.version));

  // 2) openssl
  let opensslPath = null;
  try {
    opensslPath = findOpenssl();
  } catch {
    opensslPath = null;
  }
  const opensslVersionText = opensslPath ? runVersionCommand(opensslPath, ['version']) : '';
  push('openssl', 'openssl', evaluateOpenSsl({ path: opensslPath, versionText: opensslVersionText }));

  // 3) HTTPS 证书
  const certificate = inspectCertificates(rootDir, opensslPath);
  push(
    'tls',
    'HTTPS 证书',
    evaluateCertificate({ exists: certificate.exists, info: certificate.info, lanIps, now }),
  );

  // 4) 端口占用
  for (const port of CHECKED_PORTS) {
    const probe = await probePort(port);
    push(`port-${port}`, `端口 ${port}`, interpretPortProbe(probe));
  }

  // 5) JDK
  let jdk;
  try {
    jdk = inspectJdk();
  } catch {
    jdk = { present: false };
  }
  push('jdk', 'JDK', evaluateJdk(jdk));

  // 6) Android SDK
  let sdk;
  try {
    sdk = inspectAndroidSdk(rootDir);
  } catch {
    sdk = { found: false };
  }
  push('android-sdk', 'Android SDK', evaluateAndroidSdk(sdk));

  // 7) debug.keystore
  const keystorePath = path.join(rootDir, 'android', 'debug.keystore');
  let keystoreStat = null;
  try {
    keystoreStat = fs.statSync(keystorePath);
  } catch {
    keystoreStat = null;
  }
  push(
    'keystore',
    'debug.keystore',
    evaluateKeystore({
      exists: Boolean(keystoreStat) && keystoreStat.isFile(),
      size: keystoreStat ? keystoreStat.size : 0,
      filePath: 'android/debug.keystore',
    }),
  );

  // 8) 可选外网检查
  let networkChecked = false;
  if (network) {
    networkChecked = true;
    const probe = await probeNetwork();
    push('network', '上游网络', evaluateNetworkResult({ ...probe, url: 'https://api.deepseek.com' }));
  }

  const summary = summarizeResults(checks);
  return {
    ok: summary.fail === 0,
    generatedAt: new Date(now).toISOString(),
    platform: process.platform,
    node: process.version,
    networkChecked,
    summary,
    checks,
  };
}

// ===========================================================================
// CLI
// ===========================================================================

function parseArgs(argv) {
  const options = { json: false, network: false, help: false };
  for (const arg of argv) {
    if (arg === '--json') options.json = true;
    else if (arg === '--network') options.network = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`);
  }
  return options;
}

function printHelp() {
  process.stdout.write(`doctor · DeepSeek 随身版环境体检

用法：node tools/doctor.mjs [选项]

选项：
  --json       以 JSON 输出（适合 CI / 脚本消费）
  --network    额外检查 api.deepseek.com 可达性（默认不联网）
  --help, -h   显示帮助

输出等级：
  OK    正常
  WARN  可选能力缺失或需要注意，不影响核心功能（如没有 Android SDK 时仍可跑 PWA）
  FAIL  必须修复（如 Node 版本过低、HTTPS 证书已过期）

退出码：0 = 无 FAIL；1 = 有 FAIL；2 = 脚本自身异常
`);
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`参数错误：${error.message}\n`);
    printHelp();
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    printHelp();
    return;
  }
  const report = await runDoctor({ network: options.network });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatHumanReport(report));
  }
  process.exitCode = report.summary.fail > 0 ? 1 : 0;
}

if (isMain()) {
  main().catch((error) => {
    process.stderr.write(`体检脚本异常：${error?.stack || error?.message || error}\n`);
    process.exitCode = 2;
  });
}
