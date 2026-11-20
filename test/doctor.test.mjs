/**
 * doctor 体检脚本单测。
 *
 * 分两部分：
 * 1. 纯函数单测：版本判断、端口结果解析、证书解析/评估、JDK/SDK/keystore 分级、汇总与报告格式化；
 * 2. CLI 集成：spawn `node tools/doctor.mjs --json`，验证结构合法、无崩溃、退出码与 FAIL 数量一致。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LEVELS,
  compareVersions,
  evaluateAndroidSdk,
  evaluateCertificate,
  evaluateJdk,
  evaluateKeystore,
  evaluateNetworkResult,
  evaluateNodeVersion,
  evaluateOpenSsl,
  formatHumanReport,
  interpretPortProbe,
  parseCertificateInfo,
  parseJavaVersion,
  parseNodeVersion,
  parseOpenSslVersion,
  summarizeResults,
} from '../tools/doctor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCTOR = path.join(ROOT, 'tools', 'doctor.mjs');

/** 一段典型的 `openssl x509 -text` 输出，供纯函数解析 */
const CERT_TEXT = `Certificate:
    Data:
        Version: 3 (0x2)
        Serial Number: 1 (0x1)
    Signature Algorithm: sha256WithRSAEncryption
        Issuer: CN = DeepSeek Mobile Local Dev
        Validity
            Not Before: Nov 19 03:20:48 2026 GMT
            Not After : Feb 21 03:20:48 2029 GMT
        Subject: CN = DeepSeek Mobile Local Dev
        Subject Public Key Info:
            Public Key Algorithm: rsaEncryption
        X509v3 extensions:
            X509v3 Subject Alternative Name: 
                DNS:localhost, DNS:nagatoyuki, IP Address:127.0.0.1, IP Address:192.168.31.41
            X509v3 Basic Constraints: 
                CA:FALSE
`;

/** 生成一个已解析的证书信息对象，便于 evaluateCertificate 单测 */
function certInfo({ notAfter = '2029-02-21T03:20:48.000Z', dns = ['localhost'], ips = ['127.0.0.1'] } = {}) {
  return {
    subject: 'CN = DeepSeek Mobile Local Dev',
    notBefore: new Date('2026-11-19T03:20:48.000Z'),
    notAfter: new Date(notAfter),
    sanLine: '',
    dns,
    ips,
  };
}

const NOW = Date.parse('2026-11-20T00:00:00.000Z');

// ===========================================================================
// 版本判断
// ===========================================================================
test('parseNodeVersion 解析常见版本写法', () => {
  assert.deepEqual(parseNodeVersion('v22.23.4'), { major: 22, minor: 23, patch: 4 });
  assert.deepEqual(parseNodeVersion('22.23.4'), { major: 22, minor: 23, patch: 4 });
  assert.deepEqual(parseNodeVersion('v20.0.0-rc.1'), { major: 20, minor: 0, patch: 0 });
  assert.deepEqual(parseNodeVersion('20'), { major: 20, minor: 0, patch: 0 });
  assert.equal(parseNodeVersion('not-a-version'), null);
  assert.equal(parseNodeVersion(''), null);
  assert.equal(parseNodeVersion(null), null);
});

test('compareVersions 支持字符串/数组/对象', () => {
  assert.equal(compareVersions('v22.23.4', '22.23.4'), 0);
  assert.equal(compareVersions('22.23.4', '22.2.9'), 1);
  assert.equal(compareVersions('18.20.0', '20.0.0'), -1);
  assert.equal(compareVersions([20, 1, 0], [20, 0, 9]), 1);
  assert.equal(compareVersions({ major: 21 }, { major: 21, minor: 0, patch: 1 }), -1);
  assert.throws(() => compareVersions('bad', '20.0.0'), TypeError);
});

test('evaluateNodeVersion 分级正确（Node 20 为界）', () => {
  const ok = evaluateNodeVersion('v22.23.4');
  assert.equal(ok.level, LEVELS.OK);
  assert.match(ok.message, /22\.23\.4/);

  const boundary = evaluateNodeVersion('v20.0.0');
  assert.equal(boundary.level, LEVELS.OK);

  const old = evaluateNodeVersion('v18.20.0');
  assert.equal(old.level, LEVELS.FAIL);
  assert.match(old.message, /低于最低要求/);
  assert.match(old.hint, /nodejs\.org|安装 Node/);

  const broken = evaluateNodeVersion('garbage');
  assert.equal(broken.level, LEVELS.FAIL);
  assert.match(broken.message, /无法解析/);
});

test('parseJavaVersion 兼容 OpenJDK 21 与 1.8 老格式', () => {
  assert.equal(parseJavaVersion('openjdk version "21.0.2" 2024-01-16')?.major, 21);
  assert.equal(parseJavaVersion('java version "1.8.0_402"')?.major, 8);
  assert.equal(parseJavaVersion('javac 17.0.9')?.major, 17);
  assert.equal(parseJavaVersion(''), null);
  assert.equal(parseJavaVersion(undefined), null);
});

test('parseOpenSslVersion 解析版本号', () => {
  assert.equal(parseOpenSslVersion('OpenSSL 3.6.0 1 Oct 2025 (Library: OpenSSL 3.6.0)'), '3.6.0');
  assert.equal(parseOpenSslVersion('OpenSSL 1.1.1w  11 Sep 2023'), '1.1.1w');
  assert.equal(parseOpenSslVersion('LibreSSL 3.3.6'), null);
});

// ===========================================================================
// 端口 / 网络
// ===========================================================================
test('interpretPortProbe 解析空闲/占用/异常', () => {
  const free = interpretPortProbe({ port: 8787, errorCode: null });
  assert.equal(free.level, LEVELS.OK);
  assert.equal(free.message, '空闲');

  const used = interpretPortProbe({ port: 8899, errorCode: 'EADDRINUSE' });
  assert.equal(used.level, LEVELS.WARN);
  assert.match(used.message, /已被占用/);
  assert.match(used.hint, /--port 8787/);

  const denied = interpretPortProbe({ port: 80, errorCode: 'EACCES' });
  assert.equal(denied.level, LEVELS.WARN);
  assert.match(denied.message, /无权限/);

  const unknown = interpretPortProbe({ port: 8787, errorCode: 'UNKNOWN', errorMessage: 'boom' });
  assert.equal(unknown.level, LEVELS.WARN);
  assert.match(unknown.message, /UNKNOWN/);
  assert.match(unknown.hint, /boom/);

  const badPort = interpretPortProbe({ port: 70000, errorCode: null });
  assert.equal(badPort.level, LEVELS.WARN);
  assert.match(badPort.message, /端口号非法/);
});

test('evaluateNetworkResult 分级正确', () => {
  const ok = evaluateNetworkResult({ statusCode: 401 });
  assert.equal(ok.level, LEVELS.OK);
  assert.match(ok.message, /401/);

  const httpOk = evaluateNetworkResult({ statusCode: 200 });
  assert.equal(httpOk.level, LEVELS.OK);

  const serverError = evaluateNetworkResult({ statusCode: 503 });
  assert.equal(serverError.level, LEVELS.WARN);
  assert.match(serverError.message, /503/);

  const offline = evaluateNetworkResult({ error: { code: 'ENOTFOUND' } });
  assert.equal(offline.level, LEVELS.WARN);
  assert.match(offline.message, /ENOTFOUND/);
  assert.match(offline.hint, /--mock/);
});

// ===========================================================================
// 证书解析与评估
// ===========================================================================
test('parseCertificateInfo 解析 Subject/有效期/SAN', () => {
  const info = parseCertificateInfo(CERT_TEXT);
  assert.ok(info);
  assert.match(info.subject, /DeepSeek Mobile Local Dev/);
  assert.equal(info.notAfter.toISOString(), '2029-02-21T03:20:48.000Z');
  assert.deepEqual(info.dns, ['localhost', 'nagatoyuki']);
  assert.deepEqual(info.ips, ['127.0.0.1', '192.168.31.41']);
  assert.equal(parseCertificateInfo(''), null);
  assert.equal(parseCertificateInfo('random text'), null);
});

test('evaluateCertificate 覆盖缺失/过期/临期/SAN 不完整/正常', () => {
  const missing = evaluateCertificate({ exists: false, info: null, now: NOW });
  assert.equal(missing.level, LEVELS.WARN);
  assert.match(missing.message, /\.tls\/cert\.pem/);

  const unparsable = evaluateCertificate({ exists: true, info: null, now: NOW });
  assert.equal(unparsable.level, LEVELS.WARN);

  const expired = evaluateCertificate({
    exists: true,
    info: certInfo({ notAfter: '2026-01-01T00:00:00.000Z' }),
    now: NOW,
  });
  assert.equal(expired.level, LEVELS.FAIL);
  assert.match(expired.message, /已过期/);
  assert.match(expired.hint, /npm run cert/);

  const expiring = evaluateCertificate({
    exists: true,
    info: certInfo({ notAfter: '2026-12-01T00:00:00.000Z' }),
    now: NOW,
  });
  assert.equal(expiring.level, LEVELS.WARN);
  assert.match(expiring.message, /天后过期/);

  const missingLan = evaluateCertificate({
    exists: true,
    info: certInfo({ ips: ['127.0.0.1'] }),
    lanIps: ['192.168.31.41'],
    now: NOW,
  });
  assert.equal(missingLan.level, LEVELS.WARN);
  assert.match(missingLan.message, /192\.168\.31\.41/);
  assert.match(missingLan.hint, /npm run cert|npm run https/);

  const missingLocalhost = evaluateCertificate({
    exists: true,
    info: certInfo({ dns: ['nagatoyuki'], ips: ['127.0.0.1', '192.168.31.41'] }),
    lanIps: ['192.168.31.41'],
    now: NOW,
  });
  assert.equal(missingLocalhost.level, LEVELS.WARN);
  assert.match(missingLocalhost.message, /localhost/);

  const healthy = evaluateCertificate({
    exists: true,
    info: certInfo({ ips: ['127.0.0.1', '192.168.31.41'] }),
    lanIps: ['192.168.31.41'],
    now: NOW,
  });
  assert.equal(healthy.level, LEVELS.OK);
  assert.match(healthy.message, /有效至 2029-02-21/);
});

test('evaluateOpenSsl 分级正确', () => {
  const missing = evaluateOpenSsl({ path: null });
  assert.equal(missing.level, LEVELS.WARN);
  assert.match(missing.hint, /OPENSSL_BIN/);
  const ok = evaluateOpenSsl({ path: 'C:\\bin\\openssl.exe', versionText: 'OpenSSL 3.6.0' });
  assert.equal(ok.level, LEVELS.OK);
  assert.match(ok.message, /3\.6\.0/);
});

// ===========================================================================
// JDK / Android SDK / keystore
// ===========================================================================
test('evaluateJdk：无 SDK 机器只 WARN，不 FAIL', () => {
  const missing = evaluateJdk({ present: false });
  assert.equal(missing.level, LEVELS.WARN);
  assert.match(missing.message, /仅打包 APK 需要/);
  assert.match(missing.hint, /JDK/);

  const ok = evaluateJdk({ present: true, javacPath: 'javac', keytoolPath: 'keytool', major: 21 });
  assert.equal(ok.level, LEVELS.OK);
  assert.match(ok.message, /21/);

  const old = evaluateJdk({ present: true, javacPath: 'javac', keytoolPath: 'keytool', major: 8 });
  assert.equal(old.level, LEVELS.WARN);
  assert.match(old.message, /版本偏低/);

  const partial = evaluateJdk({ present: true, javacPath: null, keytoolPath: null, major: 17 });
  assert.equal(partial.level, LEVELS.WARN);
  assert.match(partial.message, /javac/);
});

test('evaluateAndroidSdk：缺失只 WARN，组件缺失给出清单', () => {
  const missing = evaluateAndroidSdk({ found: false });
  assert.equal(missing.level, LEVELS.WARN);
  assert.match(missing.message, /未找到/);
  assert.match(missing.hint, /ANDROID_HOME/);

  const incomplete = evaluateAndroidSdk({
    found: true,
    path: 'D:\\sdk',
    buildToolsPath: 'D:\\sdk\\build-tools\\34',
    androidJarPath: null,
    missing: ['platforms/*/android.jar'],
  });
  assert.equal(incomplete.level, LEVELS.WARN);
  assert.match(incomplete.message, /android\.jar/);

  const ok = evaluateAndroidSdk({
    found: true,
    path: 'D:\\sdk',
    buildToolsPath: 'D:\\sdk\\build-tools\\36\\android-16',
    androidJarPath: 'D:\\sdk\\platforms\\android-34-ext12\\android.jar',
    missing: [],
  });
  assert.equal(ok.level, LEVELS.OK);
  assert.match(ok.message, /可用/);
});

test('evaluateKeystore 覆盖缺失/空文件/正常', () => {
  const missing = evaluateKeystore({ exists: false });
  assert.equal(missing.level, LEVELS.WARN);
  assert.match(missing.message, /android\/debug\.keystore/);

  const empty = evaluateKeystore({ exists: true, size: 0 });
  assert.equal(empty.level, LEVELS.WARN);

  const ok = evaluateKeystore({ exists: true, size: 2732 });
  assert.equal(ok.level, LEVELS.OK);
  assert.match(ok.message, /2732/);
});

// ===========================================================================
// 汇总与格式化
// ===========================================================================
test('summarizeResults 汇总计数与 worst', () => {
  assert.deepEqual(summarizeResults([]), { ok: 0, warn: 0, fail: 0, total: 0, worst: LEVELS.OK });

  const mixed = summarizeResults([
    { level: 'OK' },
    { level: 'OK' },
    { level: 'WARN' },
    { level: 'FAIL' },
    { level: 'OK' },
  ]);
  assert.deepEqual(mixed, { ok: 3, warn: 1, fail: 1, total: 5, worst: LEVELS.FAIL });

  const warnOnly = summarizeResults([{ level: 'OK' }, { level: 'WARN' }]);
  assert.equal(warnOnly.worst, LEVELS.WARN);
  assert.equal(warnOnly.fail, 0);
});

test('formatHumanReport 输出等级、建议、汇总与外网提示', () => {
  const checks = [
    { level: 'OK', title: 'Node 版本', message: 'v22.23.4（要求 v20+）', hint: '' },
    { level: 'WARN', title: 'Android SDK', message: '未找到（仅打包 APK 需要）', hint: '设置 ANDROID_HOME' },
  ];
  const text = formatHumanReport({
    generatedAt: '2026-11-20T00:00:00.000Z',
    platform: 'win32',
    node: 'v22.23.4',
    networkChecked: false,
    checks,
    summary: summarizeResults(checks),
  });
  assert.match(text, /环境体检/);
  assert.match(text, /\[OK\] Node 版本：v22\.23\.4/);
  assert.match(text, /\[WARN\] Android SDK：未找到/);
  assert.match(text, /建议：设置 ANDROID_HOME/);
  assert.match(text, /汇总：OK 1 · WARN 1 · FAIL 0/);
  assert.match(text, /本次未检查外网/);
});

// ===========================================================================
// CLI 集成
// ===========================================================================
function runCli(args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DOCTOR, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`doctor 超时：\n${stdout}\n${stderr}`));
    }, 40_000);
    timer.unref?.();
    child.stdout.on('data', (buffer) => {
      stdout += buffer.toString('utf8');
    });
    child.stderr.on('data', (buffer) => {
      stderr += buffer.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('CLI --json 输出结构合法，且退出码与 FAIL 数一致', async () => {
  const { code, stdout, stderr } = await runCli(['--json']);
  assert.ok([0, 1, 2].includes(code), `退出码异常：${code}\n${stderr}`);
  assert.ok(stderr === '' || code === 2, `正常路径不应写 stderr：${stderr}`);

  const report = JSON.parse(stdout);
  assert.equal(typeof report.ok, 'boolean');
  assert.equal(report.platform, process.platform);
  assert.ok(report.checks.length >= 8, `检查项应 >= 8，实际 ${report.checks.length}`);

  const ids = report.checks.map((check) => check.id);
  for (const expected of ['node', 'openssl', 'tls', 'port-8787', 'port-8899', 'jdk', 'android-sdk', 'keystore']) {
    assert.ok(ids.includes(expected), `缺少检查项 ${expected}`);
  }
  assert.equal(report.networkChecked, false);
  assert.ok(!ids.includes('network'), '未加 --network 时不应检查网络');

  for (const check of report.checks) {
    assert.ok([LEVELS.OK, LEVELS.WARN, LEVELS.FAIL].includes(check.level), `非法等级：${check.level}`);
    assert.equal(typeof check.title, 'string');
    assert.ok(check.title.length > 0);
    assert.equal(typeof check.message, 'string');
    assert.ok(check.message.length > 0);
    assert.equal(typeof check.hint, 'string');
  }

  // 稳定约束：Node 满足 engines，所以必须是 OK；没有 SDK 的机器上 Android 项必须是 WARN 而不是 FAIL/崩溃。
  assert.equal(report.checks.find((check) => check.id === 'node').level, LEVELS.OK);
  assert.notEqual(report.checks.find((check) => check.id === 'android-sdk').level, LEVELS.FAIL);
  assert.notEqual(report.checks.find((check) => check.id === 'keystore').level, LEVELS.FAIL);

  const summary = report.summary;
  assert.equal(summary.total, report.checks.length);
  assert.equal(summary.ok + summary.warn + summary.fail, summary.total);
  assert.equal(summary.fail > 0, !report.ok);
  assert.equal(code, summary.fail > 0 ? 1 : 0, '退出码应与 FAIL 数一致');
});

test('CLI --help 快速返回；未知参数退出码 2', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /用法/);
  assert.match(help.stdout, /--network/);

  const bad = await runCli(['--bogus']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /未知参数/);
});
