/* QA：用本机 Chrome 无头模式驱动真实页面，截屏并收集控制台错误 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.QA_URL || 'http://127.0.0.1:8899';
const OUT = process.env.QA_OUT || path.resolve('..', '..', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const logs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=2', '--lang=zh-CN'],
  defaultViewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
});

async function newPage(theme) {
  const page = await browser.newPage();
  page.on('console', (m) => {
    logs.push(`[${m.type()}] ${m.text()}`);
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (!u.includes('favicon')) errors.push(`requestfailed: ${u} ${r.failure()?.errorText}`);
  });
  return page;
}

const click = async (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) throw new Error('missing selector ' + s);
  el.click();
}, sel);

const shot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log('shot', name);
};

const waitGone = async (page, sel, timeout = 8000) => {
  await page.waitForFunction((s) => !document.querySelector(s), { timeout }, sel).catch(() => {});
};

/* 1. 登录页 */
{
  const page = await newPage();
  await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(900);
  await shot(page, '01-login');
  await page.close();
}

/* 2. 演示模式 → 欢迎页 → 流式对话 → 侧栏 → 设置 → 模型 */
{
  const page = await newPage();
  await page.goto(BASE + '/?demo=1', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(800);
  await shot(page, '02-welcome');

  await click(page, '.suggestion');
  await sleep(1100);
  await shot(page, '03-streaming');

  await page.waitForFunction(() => {
    const b = document.querySelector('#btn-send');
    return b && !b.classList.contains('stop');
  }, { timeout: 40000 }).catch(() => errors.push('等待回答结束超时'));
  await sleep(800);
  await shot(page, '04-chat');

  // 侧栏
  await click(page, '#btn-menu');
  await sleep(600);
  await shot(page, '05-sidebar');

  // 设置（侧栏保持打开）
  await click(page, '#btn-account');
  await sleep(700);
  await shot(page, '06-settings');
  await click(page, '[data-back]');
  await sleep(500);

  // 模型面板
  await click(page, '#btn-model');
  await sleep(600);
  await shot(page, '07-model');
  await click(page, '.sheet-mask');
  await sleep(400);
  await click(page, '#scrim');
  await sleep(400);
  await page.close();
}

/* 3. 种子会话（含思考/搜索/引用/代码/表格/公式） */
{
  const page = await newPage();
  await page.goto(BASE + '/?demo=1&seed=1', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(1000);
  await shot(page, '08-seed-chat');

  const thinkHead = await page.$('.think-head');
  if (thinkHead) { await thinkHead.click(); await sleep(600); await shot(page, '09-think-open'); }

  await page.evaluate(() => {
    const m = document.querySelector('#messages');
    const code = document.querySelector('.code-block');
    if (code) m.scrollTop = code.offsetTop - 80;
  });
  await sleep(600);
  await shot(page, '10-code-table');

  await page.evaluate(() => { const m = document.querySelector('#messages'); m.scrollTop = m.scrollHeight; });
  await sleep(600);
  await shot(page, '10c-bottom');
  await page.close();
}

/* 4. 深色主题 */
{
  const page = await newPage();
  await page.goto(BASE + '/?demo=1&seed=1&theme=dark', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(1000);
  await shot(page, '11-dark');
  await page.close();
}

/* 5. 搜索面板（含一次真实 Search API 调用） */
{
  const page = await newPage();
  await page.goto(BASE + '/?demo=1&screen=search', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(1000);
  await shot(page, '12-search');
  const hasInput = await page.$('#sp-input');
  if (hasInput) {
    await page.type('#sp-input', '上海天气');
    await click(page, '[data-go]');
    await sleep(1400);
    await shot(page, '13-search-results');
  }
  await page.close();
}

/* 6. 接口探测（mock 上游） */
{
  const page = await newPage();
  await page.goto(BASE + '/?demo=1', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(600);
  const report = await page.evaluate(async () => {
    const H = { 'x-ds-key': 'sk-qa-test-0123456789' };
    const j = async (url, opt = {}) => {
      const r = await fetch(url, opt);
      let body = null;
      try { body = await r.json(); } catch { body = null; }
      return { status: r.status, type: r.headers.get('content-type'), body };
    };
    const post = (url, body) => j(url, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const out = {};
    out.health = await j('/healthz');
    out.info = await j('/api/server-info');
    out.balance = await j('/api/user/balance', { headers: H });
    out.search = await post('/api/tools/search', { query: '上海天气' });
    out.fetch = await post('/api/tools/fetch', { url: 'https://www.weather.com.cn/shanghai' });
    out.ocr = await post('/api/tools/ocr', { url: 'https://example.com/a.png' });
    const tts = await fetch('/api/tools/tts', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ text: '你好' }) });
    out.tts = { status: tts.status, type: tts.headers.get('content-type'), bytes: (await tts.arrayBuffer()).byteLength };
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(44)], { type: 'audio/wav' }), 'a.wav');
    const ar = await fetch('/api/tools/asr', { method: 'POST', headers: H, body: fd });
    out.asr = { status: ar.status, body: await ar.json().catch(() => null) };
    return out;
  });
  fs.writeFileSync(path.join(OUT, 'api-report.json'), JSON.stringify(report, null, 2));
  console.log('api-status:', Object.fromEntries(Object.entries(report).map(([k, v]) => [k, v?.status])));
  await page.close();
}

await browser.close();
fs.writeFileSync(path.join(OUT, 'qa-report.json'), JSON.stringify({ errors, logs: logs.slice(-200) }, null, 2));
console.log('\n=== ERRORS ===');
console.log(errors.length ? errors.join('\n') : 'none');
