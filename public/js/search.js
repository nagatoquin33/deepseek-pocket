/* =========================================================================
 * search.js —— 独立搜索面板：调用 /v1/tools/search 找网页，/v1/tools/fetch 阅读
 * ========================================================================= */

import { esc, icon, toast } from './ui.js';
import { renderMarkdown } from './render.js';

const EXAMPLES = [
  'DeepSeek V4.1 更新了什么',
  '今天上海的天气',
  'site:github.com deepseek 开源项目',
  'after:2026-01-01 大模型 价格',
];

export function openSearchPanel(ctx) {
  const root = document.getElementById('overlay-root');
  const panel = document.createElement('div');
  panel.className = 'search-panel';
  panel.innerHTML = `
    <div class="search-head">
      <button class="icon-btn" data-back aria-label="返回">${icon('chevronLeft', { size: 22 })}</button>
      <div class="search-input-wrap">
        ${icon('search', { size: 17 })}
        <input id="sp-input" type="search" placeholder="搜索网页，支持 site: after: lang: 等语法" autocomplete="off" enterkeyhint="search" />
      </div>
      <button class="btn ghost sm" data-chat title="走对话的服务端 web 工具，检索不计费">对话联网</button>
      <button class="btn primary sm" data-go>搜索</button>
    </div>
    <div class="search-body" id="sp-body">
      <div class="search-hint">
        <b>计费说明</b><br>
        · 这里调用独立 <code>Search API</code>，按成功请求计费 <b>$0.75 / 千次</b>；<br>
        · 点右上「对话联网」或直接在对话里开启<b>联网搜索</b>，走服务端 web 工具，<b>检索不计费</b>，只算 token。<br><br>
        支持 <code>site:</code> <code>-site:</code> <code>"精确短语"</code> <code>lang:zh,en</code> <code>after:2025-01-01</code> 等语法。<br>
        试试：${EXAMPLES.map((e) => `「${esc(e)}」`).join(' ')}
      </div>
    </div>
  `;
  root.appendChild(panel);
  requestAnimationFrame(() => panel.classList.add('in'));

  const input = panel.querySelector('#sp-input');
  const body = panel.querySelector('#sp-body');
  const close = () => { panel.remove(); };
  panel.querySelector('[data-back]').addEventListener('click', close);

  let lastResults = [];
  let rawQuery = '';

  const run = async () => {
    const q = input.value.trim();
    if (!q) { input.focus(); return; }
    rawQuery = q;
    body.innerHTML = Array.from({ length: 4 }, () => '<div class="search-skeleton"></div>').join('');
    try {
      const res = await ctx.getClient().search({ query: q, count: 10, needContent: false });
      lastResults = (res?.results || []).filter((r) => r && r.url);
      if (!lastResults.length) {
        body.innerHTML = `<div class="search-hint">没有找到相关网页，换个说法试试。</div>`;
        return;
      }
      body.innerHTML = `
        <div class="search-actions">
          <button class="btn primary sm" data-ask>${icon('sparkle', { size: 15 })} 基于这些结果提问</button>
          <span style="align-self:center;font-size:12px;color:var(--text-3)">${lastResults.length} 条结果</span>
        </div>
        ${lastResults.map((r, i) => `
          <a class="search-result" href="${esc(r.url)}" data-idx="${i}">
            <div class="sr-site">
              ${r.site_icon ? `<img src="${esc(r.site_icon)}" alt="" loading="lazy">` : icon('globe', { size: 12 })}
              <span>${esc(r.site_name || hostOf(r.url))}</span>
              ${r.date ? `<span>· ${esc(String(r.date).slice(0, 10))}</span>` : ''}
              ${r.authority >= 3 ? '<span>· 权威来源</span>' : ''}
            </div>
            <div class="sr-title">${esc(r.title || r.url)}</div>
            <div class="sr-snippet">${esc(r.snippet || r.summary || '')}</div>
            <div class="sr-meta"><span>${esc(hostOf(r.url))}</span>${r.rerank_score ? `<span>相关度 ${Number(r.rerank_score).toFixed(2)}</span>` : ''}</div>
          </a>`).join('')}
        <div style="height:16px"></div>`;

      body.querySelector('[data-ask]')?.addEventListener('click', () => {
        close();
        ctx.onAsk(rawQuery, lastResults);
      });
      body.querySelectorAll('.search-result').forEach((a) => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const r = lastResults[Number(a.dataset.idx)];
          if (r) openReader(ctx, r);
        });
      });
    } catch (err) {
      body.innerHTML = `<div class="search-hint">搜索失败：${esc(err.message || '未知错误')}<br>请检查网络或额度。</div>`;
    }
  };

  panel.querySelector('[data-go]').addEventListener('click', run);
  panel.querySelector('[data-chat]').addEventListener('click', () => {
    const q = input.value.trim();
    if (!q) { input.focus(); toast('先输入要搜索的内容'); return; }
    close();
    // 对话内联网走服务端 web 工具：检索不计费，只计 token
    ctx.onAsk(q, []);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  input.addEventListener('search', () => { if (!input.value.trim()) body.innerHTML = ''; });
  setTimeout(() => input.focus(), 240);

  return { close, run };
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** 阅读器：抓取网页 Markdown 并在抽屉中阅读 */
export function openReader(ctx, result) {
  const root = document.getElementById('overlay-root');
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `
    <div class="modal-mask"></div>
    <div class="modal" style="max-width:640px;max-height:86vh;display:flex;flex-direction:column;padding:0">
      <div style="display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line);flex:none">
        <div style="flex:1;min-width:0">
          <div class="reader-title" id="rd-title">${esc(result.title || '加载中…')}</div>
          <div class="reader-src">${esc(hostOf(result.url))}</div>
        </div>
        <button class="icon-btn sm" data-close aria-label="关闭">${icon('close', { size: 20 })}</button>
      </div>
      <div style="flex:1;overflow-y:auto;padding:16px" id="rd-body">
        <div class="search-skeleton"></div><div class="search-skeleton"></div><div class="search-skeleton"></div>
      </div>
      <div style="display:flex;gap:10px;padding:12px 16px;border-top:1px solid var(--line);flex:none">
        <a class="btn ghost" style="flex:1" href="${esc(result.url)}" target="_blank" rel="noopener noreferrer">打开原网页</a>
        <button class="btn primary" style="flex:1" data-ask-page>基于此页提问</button>
      </div>
    </div>`;
  root.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('in'));
  const close = () => { wrap.classList.remove('in'); setTimeout(() => wrap.remove(), 180); };
  wrap.querySelector('.modal-mask').addEventListener('click', close);
  wrap.querySelector('[data-close]').addEventListener('click', close);
  wrap.querySelector('[data-ask-page]').addEventListener('click', () => {
    close();
    ctx.onAsk(`请阅读并总结这个网页的要点：${result.url}`, [result]);
  });

  (async () => {
    try {
      const page = await ctx.getClient().fetchPage(result.url);
      const titleEl = wrap.querySelector('#rd-title');
      titleEl.textContent = page?.title || result.title || result.url;
      const content = String(page?.content || '').trim();
      wrap.querySelector('#rd-body').innerHTML = content
        ? `<div class="reader-body md">${renderMarkdown(content.slice(0, 120000))}</div>`
        : `<div class="search-hint">该网页没有可提取的正文。</div>`;
    } catch (e) {
      wrap.querySelector('#rd-body').innerHTML = `<div class="search-hint">读取失败：${esc(e.message || '未知错误')}<br>可以点下方按钮打开原网页。</div>`;
      toast('网页读取失败', { type: 'error' });
    }
  })();

  return { close };
}
