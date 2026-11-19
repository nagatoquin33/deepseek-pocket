/* 生成一套干净的文档截图（浏览器版，390×844 @2x），命名与 README 对应 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.QA_URL || 'http://127.0.0.1:8899';
const OUT = 'D:/ai/deepseek-mobile/docs/screenshots';
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--lang=zh-CN'],
  defaultViewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
});

const shot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log('shot', name);
};

/* 1. 登录 */
{
  const p = await browser.newPage();
  await p.goto(BASE + '/', { waitUntil: 'networkidle2' });
  await sleep(900);
  await shot(p, '01-login');
  await p.close();
}

/* 2. 欢迎 */
{
  const p = await browser.newPage();
  await p.goto(BASE + '/?demo=1', { waitUntil: 'networkidle2' });
  await sleep(900);
  await shot(p, '02-welcome');
  await p.close();
}

/* 3. 种子会话：思考 / 代码表格 / 图表 */
{
  const p = await browser.newPage();
  await p.goto(BASE + '/?demo=1&seed=1', { waitUntil: 'networkidle2' });
  await sleep(1500);
  await shot(p, '03-chat');

  const head = await p.$('.think-head');
  if (head) { await head.click(); await sleep(500); await shot(p, '04-thinking'); }

  await p.evaluate(() => {
    const m = document.querySelector('#messages');
    const code = document.querySelector('.code-block[data-lang="python"]');
    if (code) m.scrollTop = code.offsetTop - 120;
  });
  await sleep(500);
  await shot(p, '05-markdown');

  await p.evaluate(() => {
    const m = document.querySelector('#messages');
    const box = document.querySelector('.mermaid-box');
    if (box) m.scrollTop = box.offsetTop - 140;
  });
  await sleep(500);
  await shot(p, '06-mermaid');
  await p.close();
}

/* 4. 侧栏 / 设置 / 系统提示词 / 模型 / 搜索 / 深色 */
{
  const p = await browser.newPage();
  await p.goto(BASE + '/?demo=1&seed=1', { waitUntil: 'networkidle2' });
  await sleep(1200);
  await p.evaluate(() => document.querySelector('#btn-menu').click());
  await sleep(600);
  await shot(p, '07-sidebar');

  await p.evaluate(() => document.querySelector('#btn-account').click());
  await sleep(700);
  await shot(p, '08-settings');

  await p.evaluate(() => { document.querySelector('[data-go="system"]')?.click(); });
  await sleep(600);
  await shot(p, '09-system-prompt');
  await p.evaluate(() => document.querySelector('[data-back]').click());
  await sleep(300);
  await p.evaluate(() => document.querySelector('[data-back]').click());
  await sleep(400);

  await p.evaluate(() => document.querySelector('#btn-model').click());
  await sleep(600);
  await shot(p, '10-model');
  await p.keyboard.press('Escape');
  await sleep(300);
  await p.close();
}

/* 5. 搜索 */
{
  const p = await browser.newPage();
  await p.goto(BASE + '/?demo=1&screen=search', { waitUntil: 'networkidle2' });
  await sleep(900);
  await p.type('#sp-input', '上海天气');
  await p.evaluate(() => document.querySelector('[data-go]').click());
  await sleep(1200);
  await shot(p, '11-search');
  await p.close();
}

/* 6. 深色 */
{
  const p = await browser.newPage();
  await p.goto(BASE + '/?demo=1&seed=1&theme=dark', { waitUntil: 'networkidle2' });
  await sleep(1300);
  await shot(p, '12-dark');
  await p.close();
}

await browser.close();
console.log('done');
