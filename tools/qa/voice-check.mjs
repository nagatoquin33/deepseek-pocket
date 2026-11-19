/* 语音链路自检：假麦克风 → 录音 → ASR 回填；朗读按钮就地切换（无浮动条） */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.QA_URL || 'http://127.0.0.1:8899';
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox', '--disable-gpu',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--lang=zh-CN',
  ],
  defaultViewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
});

const page = await browser.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(BASE + '/?demo=1&seed=1', { waitUntil: 'networkidle2' });
await sleep(900);

/* 1) 语音输入 */
await page.evaluate(() => document.querySelector('#btn-voice').click());
await sleep(2400);
const overlayOpen = await page.evaluate(() => !document.querySelector('#recorder').hidden);
const timer = await page.evaluate(() => document.querySelector('#rec-time').textContent);
await page.evaluate(() => document.querySelector('#rec-done').click());
await sleep(2400);
const inputValue = await page.evaluate(() => document.querySelector('#input').value);
const overlayClosed = await page.evaluate(() => document.querySelector('#recorder').hidden);

/* 2) 朗读：按钮就地切换，不出现浮动播放条 */
await page.evaluate(() => {
  const list = document.querySelectorAll('.msg.assistant');
  const last = list[list.length - 1];
  last.querySelector('[data-act="speak"]')?.click();
});
let speaking = false;
for (let i = 0; i < 20; i += 1) {
  await sleep(200);
  speaking = await page.evaluate(() => {
    const list = document.querySelectorAll('.msg.assistant');
    const last = list[list.length - 1];
    return last?.querySelector('[data-act="speak"]')?.classList.contains('on') || false;
  });
  if (speaking) break;
}
const floatingBar = await page.evaluate(() => !!document.querySelector('#ttsbar'));
await page.evaluate(() => {
  const list = document.querySelectorAll('.msg.assistant');
  const last = list[list.length - 1];
  last.querySelector('[data-act="speak"]')?.click();
});
await sleep(500);
const stopped = await page.evaluate(() => {
  const list = document.querySelectorAll('.msg.assistant');
  const last = list[list.length - 1];
  return !last?.querySelector('[data-act="speak"]')?.classList.contains('on');
});

console.log(JSON.stringify({ overlayOpen, timer, inputValue, overlayClosed, speaking, floatingBar, stopped, errors }, null, 2));
await browser.close();
