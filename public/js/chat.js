/* =========================================================================
 * chat.js —— 对话引擎：请求组装、SSE 增量归一化、消息渲染与操作
 * ========================================================================= */

import { renderMarkdown } from './render.js';
import { ensureVariants, currentVariant } from './branch.js';
import {
  esc, icon, uid, copyText, toast, formatTime, formatTokens, formatCost,
  estimateCost, throttleRaf, isNearBottom, scrollToBottom, haptic,
} from './ui.js';

/* ------------------------------ 请求组装 ------------------------------ */

const WEEKDAY_ZH = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const WEEKDAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function reminderText(settings, ts = Date.now()) {
  const d = new Date(ts);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const isZh = /[\u4e00-\u9fa5]/.test(settings.language || '');
  const weekday = isZh ? WEEKDAY_ZH[d.getDay()] : WEEKDAY_EN[d.getDay()];
  const loc = (settings.location || '').replace(/,/g, ' ');
  return `${ymd},${weekday},${loc},${settings.platform || 'App'},${settings.language || '中文'}`;
}

/** 会话消息 → 开放平台 messages 数组（含 latest_reminder） */
export function toApiMessages(session, settings) {
  const out = [];
  for (const m of session.messages) {
    if (m.role === 'user') {
      out.push({ role: 'latest_reminder', content: reminderText(settings, m.createdAt) });
      if (m.attachments && m.attachments.length) {
        const parts = [];
        if (m.content) parts.push({ type: 'text', text: m.content });
        for (const a of m.attachments) {
          if (a.kind === 'image' && a.dataUrl) {
            parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
          } else if (a.fileId) {
            parts.push({ type: 'file', file_id: a.fileId });
          }
        }
        out.push({ role: 'user', content: parts });
      } else {
        out.push({ role: 'user', content: m.content });
      }
    } else if (m.role === 'assistant' && m.content && !m.error) {
      const msg = { role: 'assistant', content: m.content };
      if (Array.isArray(m.serverToolCalls) && m.serverToolCalls.length) msg.server_tool_calls = m.serverToolCalls;
      if (Array.isArray(m.annotations) && m.annotations.length) msg.annotations = m.annotations;
      out.push(msg);
    }
  }
  return out;
}

/** 组装一次 /chat/completions 请求体 */
export function composeRequestBody({ session, settings, forContinue = false }) {
  const hasImages = session.messages.some((m) => m.attachments?.some((a) => a.kind === 'image'));
  let model = settings.model;
  if (hasImages && model !== 'deepseek-flash') model = 'deepseek-flash';

  const messages = toApiMessages(session, settings);
  const sysPrompt = String(settings.systemPrompt || '').trim();
  if (sysPrompt) messages.unshift({ role: 'system', content: sysPrompt });
  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (settings.thinking) {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = settings.effort || 'high';
  } else {
    body.thinking = { type: 'disabled' };
  }

  const tools = [];
  if (settings.webSearch) {
    tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' });
    tools.push({ type: 'deepseek_read_url', name: 'deepseek_read_url' });
  }
  if (tools.length) body.tools = tools;

  if (settings.safety) body.safety_check = { level: 'high' };

  const bodyMsgCount = messages.filter((m) => m.role === 'assistant').length;
  if (!forContinue && !session.titleGenerated && bodyMsgCount === 0) {
    body.title = { enabled: true };
  }
  return body;
}

/* ---------------------------- 增量归一化 ---------------------------- */

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function fireIco(url) {
  const h = hostOf(url);
  if (!h) return '';
  return `https://cdn.deepseek.com/site-icons/${encodeURIComponent(h)}`;
}

/** 统一各种可能的工具事件形状 → {kind:'call'|'result', ...} */
export function normalizeToolEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // 形式 A：调用
  const input = raw.input || raw.arguments || null;
  const id = raw.id || raw.tool_use_id || raw.tool_call_id || raw.server_tool_call_id || '';
  const name = raw.name || raw.tool_name || raw.function?.name || '';
  const looksLikeCall = !!input || (name && !raw.content && !raw.results);
  if (looksLikeCall) {
    let parsed = input;
    if (typeof input === 'string') { try { parsed = JSON.parse(input); } catch { parsed = { raw: input }; } }
    const action = parsed?.action || parsed?.type || (parsed?.queries ? 'search' : parsed?.url ? 'open_page' : 'search');
    return {
      type: 'call',
      id,
      name: name || (action === 'read_link' ? 'deepseek_read_url' : 'deepseek_web_search'),
      action,
      queries: Array.isArray(parsed?.queries) ? parsed.queries.filter(Boolean) : (parsed?.query ? [parsed.query] : []),
      url: parsed?.url || '',
      pattern: parsed?.pattern || '',
      kind: raw.kind || (action === 'read_link' ? 'read_link' : action === 'search' ? 'search' : 'deep_search'),
    };
  }

  // 形式 B：结果
  const content = raw.content ?? raw.results ?? raw.result ?? null;
  if (content !== null || raw.tool_use_id) {
    let results = [];
    let error = '';
    if (Array.isArray(content)) {
      for (const it of content) {
        if (!it || typeof it !== 'object') continue;
        if (it.type === 'web_search_tool_result_error' || it.type === 'web_fetch_tool_result_error') {
          error = it.error_code || 'unavailable';
          continue;
        }
        const item = it.type === 'web_fetch_result' ? {
          url: it.url,
          title: it.content?.title || it.title || '',
          site: it.url ? hostOf(it.url) : '',
          icon: '',
          snippet: '',
          pageAge: it.published_at || null,
          kind: 'page',
        } : {
          url: it.url || '',
          title: it.title || '',
          site: it.site_name || hostOf(it.url),
          icon: it.site_icon || fireIco(it.url),
          snippet: it.snippet || '',
          pageAge: it.page_age || null,
          image: it.image_url || '',
          kind: 'search',
        };
        results.push(item);
      }
    } else if (content && typeof content === 'object') {
      if (content.type === 'web_fetch_result' || content.url) {
        results.push({
          url: content.url || '',
          title: content.content?.title || content.title || '',
          site: hostOf(content.url || ''),
          icon: '',
          snippet: '',
          pageAge: content.published_at || null,
          kind: 'page',
        });
      } else if (Array.isArray(content.content)) {
        results = content.content.map((it) => ({
          url: it.url || '',
          title: it.title || '',
          site: it.site_name || hostOf(it.url || ''),
          icon: it.site_icon || fireIco(it.url),
          snippet: it.snippet || '',
          pageAge: it.page_age || null,
          kind: 'search',
        }));
      }
      if (content.type === 'web_fetch_tool_result_error') error = content.error_code || 'unavailable';
      if (raw.error_code) error = raw.error_code;
    }
    return { type: 'result', id, results, error, kind: raw.kind || 'search', raw };
  }
  return null;
}

function newTextBlock() { return { type: 'text', text: '', citations: [] }; }
function newThinkBlock() { return { type: 'think', text: '', start: 0, end: 0 }; }

/** 把 SSE chunk 应用到 assistant 消息对象上 */
export function applyChunk(msg, chunk) {
  if (!chunk || typeof chunk !== 'object') return null;

  if (Array.isArray(chunk.annotations)) msg.annotations.push(...chunk.annotations);
  if (chunk.title) msg.title = chunk.title;
  if (chunk.usage) msg.usage = chunk.usage;
  if (chunk.refusal) msg.refusal = chunk.refusal;

  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  if (!choice) return null;
  const d = choice.delta || choice.message || {};
  let touched = null;

  /* 思考内容 */
  if (typeof d.reasoning_content === 'string' && d.reasoning_content) {
    let b = msg.blocks[msg.blocks.length - 1];
    if (!b || b.type !== 'think') { b = newThinkBlock(); b.start = Date.now(); msg.blocks.push(b); }
    b.text += d.reasoning_content;
    msg.reasoningContent += d.reasoning_content;
    touched = 'reasoning';
  }

  /* 正文 */
  if (typeof d.content === 'string' && d.content) {
    let b = msg.blocks[msg.blocks.length - 1];
    if (!b || b.type !== 'text') {
      // 正文开始 → 所有未收尾的思考块立即结束计时并自动折叠
      for (const prev of msg.blocks) {
        if (prev.type === 'think' && !prev.end) prev.end = Date.now();
      }
      b = newTextBlock();
      msg.blocks.push(b);
      // 第一个正文块出现 → 记录思考耗时
      if (!msg.reasoningEnd && msg.reasoningContent) msg.reasoningEnd = Date.now();
    }
    b.text += d.content;
    msg.content += d.content;
    touched = 'content';
  } else if (Array.isArray(d.content)) {
    for (const part of d.content) {
      if (part && typeof part.text === 'string') {
        let b = msg.blocks[msg.blocks.length - 1];
        if (!b || b.type !== 'text') { b = newTextBlock(); msg.blocks.push(b); }
        b.text += part.text;
        msg.content += part.text;
        touched = 'content';
      }
    }
  }

  /* 引用 */
  const anns = d.annotations || d.citations;
  if (Array.isArray(anns)) {
    for (const a of anns) {
      const item = a.citation || a;
      const url = item.url || item.source_url;
      if (!url) continue;
      const last = [...msg.blocks].reverse().find((b) => b.type === 'text');
      if (last && !last.citations.some((c) => c.url === url)) {
        last.citations.push({ url, title: item.title || '', cited: item.cited_text || '' });
      }
      if (!msg.annotations.some((x) => (x.url || x.citation?.url) === url)) msg.annotations.push(item);
    }
    touched = touched || 'citations';
  }

  /* 服务端工具调用/结果 */
  const toolEvents = [];
  if (Array.isArray(d.server_tool_calls)) toolEvents.push(...d.server_tool_calls);
  if (Array.isArray(d.server_tool_call)) toolEvents.push(d.server_tool_call);
  if (Array.isArray(d.tool_calls)) toolEvents.push(...d.tool_calls);
  if (choice.message && Array.isArray(choice.message.server_tool_calls)) toolEvents.push(...choice.message.server_tool_calls);

  for (const raw of toolEvents) {
    const ev = normalizeToolEvent(raw);
    if (!ev) continue;
    applyToolEvent(msg, ev);
    touched = 'tools';
  }

  if (choice.finish_reason) {
    msg.finishReason = choice.finish_reason;
    for (const b of msg.blocks) if (b.type === 'think' && !b.end) b.end = Date.now();
    if (msg.reasoningContent && !msg.reasoningEnd) msg.reasoningEnd = Date.now();
  }
  if (choice.message?.refusal) msg.refusal = choice.message.refusal;
  return touched;
}

function ensureToolBlock(msg) {
  let b = msg.blocks[msg.blocks.length - 1];
  if (!b || b.type !== 'tools') {
    b = { type: 'tools', steps: [] };
    msg.blocks.push(b);
  }
  return b;
}

function applyToolEvent(msg, ev) {
  const block = ensureToolBlock(msg);
  msg.serverToolCalls.push(ev.raw || ev);
  if (ev.type === 'call') {
    if (!block.steps.some((s) => s.id === ev.id)) {
      block.steps.push({
        id: ev.id, name: ev.name, action: ev.action, kind: ev.kind,
        queries: ev.queries, url: ev.url, pattern: ev.pattern,
        results: [], error: '', done: false,
      });
    }
  } else {
    const step = block.steps.find((s) => s.id === ev.id) || block.steps[block.steps.length - 1];
    if (step) {
      step.results = ev.results || [];
      step.error = ev.error || '';
      step.done = true;
    } else {
      block.steps.push({
        id: ev.id, name: 'deepseek_web_search', action: ev.kind === 'read_link' ? 'read_link' : 'search',
        kind: ev.kind, queries: [], url: '', pattern: '',
        results: ev.results || [], error: ev.error || '', done: true,
      });
    }
  }
}

/** 新建一条 assistant 消息对象 */
export function createAssistantMessage(model) {
  return {
    id: uid('m'),
    role: 'assistant',
    content: '',
    reasoningContent: '',
    blocks: [],
    annotations: [],
    citations: [],
    serverToolCalls: [],
    usage: null,
    title: '',
    model,
    createdAt: Date.now(),
    reasoningStart: 0,
    reasoningEnd: 0,
    finishReason: '',
    refusal: '',
    status: 'streaming',
    error: '',
  };
}

/** 从消息中提取展示用引用列表（按首次出现顺序编号） */
export function collectCitations(msg) {
  const list = [];
  const seen = new Set();
  const add = (c) => {
    if (!c || !c.url || seen.has(c.url)) return;
    seen.add(c.url);
    list.push({ n: list.length + 1, url: c.url, title: c.title || hostOf(c.url), host: hostOf(c.url) });
  };
  for (const b of msg.blocks) {
    if (b.type === 'text' && b.citations?.length) b.citations.forEach(add);
  }
  for (const a of msg.annotations || []) add(a.citation ? { url: a.citation.url, title: a.citation.title } : a);
  return list;
}

/* ------------------------------- 渲染 ------------------------------- */

function thinkLabel(b, streaming) {
  if (streaming && !b.end) {
    const sec = b.start ? Math.max(1, Math.round((Date.now() - b.start) / 1000)) : 0;
    return { label: '正在深度思考', time: sec ? `${sec} 秒` : '' };
  }
  const ms = (b.end || Date.now()) - (b.start || Date.now());
  const sec = Math.max(1, Math.round(ms / 1000));
  return { label: '已深度思考', time: `用时 ${sec} 秒` };
}

function renderThinkBlock(b, idx, openSet) {
  const { label, time } = thinkLabel(b, !b.end);
  const open = openSet.has(idx) || !b.end;
  return `<div class="think ${open ? 'open' : ''} ${b.end ? '' : 'streaming'}" data-think="${idx}">
    <div class="think-head" role="button" tabindex="0">
      <span class="t-label">${label}</span>
      ${time ? `<span class="t-time">（${time}）</span>` : ''}
      <span class="t-caret">${icon('chevronDown', { size: 15 })}</span>
    </div>
    <div class="think-body">${esc(b.text)}</div>
  </div>`;
}

function fmtDur(ms) {
  if (!ms || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

/** 消息底部：↑输入 ↓输出 · 缓存命中 · 首字延迟 · 速度 · 估算费用 */
function buildUsageFoot(msg) {
  const u = msg.usage || {};
  const input = u.prompt_tokens || 0;
  const output = u.completion_tokens || 0;
  const cache = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoning = u.completion_tokens_details?.reasoning_tokens || 0;
  const cachePct = input ? Math.round((cache / input) * 100) : 0;
  const secs = msg.durationMs ? msg.durationMs / 1000 : 0;
  const speed = secs > 0 ? Math.round(output / secs) : 0;
  const cost = estimateCost(u, msg.model);
  const parts = [
    `<span class="usage" title="输入 ${input} tokens">↑${formatTokens(input)}</span>`,
    `<span class="usage" title="输出 ${output} tokens">↓${formatTokens(output)}</span>`,
  ];
  if (input) parts.push(`<span class="usage" title="缓存命中 ${cache} / ${input}（prompt_cache_hit_tokens）">缓存${cachePct}%</span>`);
  if (reasoning) parts.push(`<span class="usage" title="思考 token">思考${formatTokens(reasoning)}</span>`);
  if (msg.firstTokenMs) parts.push(`<span class="usage" title="首字延迟">首字${fmtDur(msg.firstTokenMs)}</span>`);
  if (speed) parts.push(`<span class="usage" title="输出速度">${speed} tok/s</span>`);
  if (msg.durationMs) parts.push(`<span class="usage">${fmtDur(msg.durationMs)}</span>`);
  if (cost) parts.push(`<span class="usage" title="按非高峰价估算">≈${formatCost(cost)}</span>`);
  return parts.join(`<span class="dot">·</span>`);
}

function actionTitle(s) {
  if (s.error) return '搜索失败';
  if (s.action === 'read_link') return '阅读链接';
  if (s.action === 'open_page') return '打开网页';
  if (s.action === 'find_in_page') return `在页面中查找「${s.pattern || ''}」`;
  if (s.action === 'search') {
    if (s.kind === 'image_search' || s.kind === 'deep_image_search') return '图片搜索';
    return s.kind === 'deep_search' ? '深度搜索' : '搜索网页';
  }
  return '联网检索';
}

function renderToolBlock(b, streaming) {
  const steps = b.steps || [];
  if (!steps.length) return '';
  const rows = steps.map((s) => {
    const results = (s.results || []).slice(0, 5);
    const cards = results.map((r) => `
      <a class="ts-result" href="${esc(r.url || '#')}" target="_blank" rel="noopener noreferrer nofollow" data-src="${esc(r.url || '')}">
        ${r.icon ? `<img class="ts-fav" src="${esc(r.icon)}" alt="" loading="lazy">` : `<span class="ts-fav ts-fav-ph">${icon('globe', { size: 11 })}</span>`}
        <span class="ts-title">${esc(r.title || r.url)}</span>
        <span class="ts-site">${esc(r.site || '')}</span>
      </a>`).join('');
    const more = (s.results || []).length > 5 ? `<span class="ts-more">共 ${s.results.length} 条结果</span>` : '';
    const pending = !s.done && !s.error;
    return `<div class="tool-step">
      <div class="ts-head">
        <span class="ts-ico">${pending ? '<span class="spinner"></span>' : icon(s.kind === 'read_link' ? 'link' : 'globe', { size: 15 })}</span>
        <span class="ts-title">${esc(actionTitle(s))}</span>
        <span class="ts-count">${pending ? '检索中…' : s.error ? s.error : `${s.results?.length || 0} 条`}</span>
      </div>
      ${s.queries?.length ? `<div class="ts-queries">${s.queries.map((q) => `<span class="ts-query">${esc(q)}</span>`).join('')}</div>` : ''}
      ${s.url && !s.queries?.length ? `<div class="ts-queries"><span class="ts-query">${esc(s.url)}</span></div>` : ''}
      ${cards ? `<div class="ts-results">${cards}${more}</div>` : ''}
      ${s.error ? `<div class="ts-failed">未获取到结果（${esc(s.error)}）</div>` : ''}
    </div>`;
  }).join('');
  return `<div class="tool-steps">${rows}</div>`;
}

function renderSources(citations, openSet) {
  if (!citations.length) return '';
  return `<div class="sources">
    <div class="sources-title">${icon('link', { size: 14 })} 参考来源 · ${citations.length}</div>
    <div class="source-list">
      ${citations.map((c) => `<a class="source" id="ref-${c.n}" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer nofollow" data-src="${esc(c.url)}">
        <span class="source-idx">${c.n}</span>
        <span class="source-body">
          <span class="source-name">${esc(c.title)}</span>
          <span class="source-host">${esc(c.host)}</span>
        </span>
      </a>`).join('')}
    </div>
  </div>`;
}

/**
 * 渲染 assistant 消息主体。
 * @param msg 消息对象
 * @param opts.openThink 已展开的思考块索引集合（保持用户交互状态）
 */
export function renderAssistantBody(msg, { openThink = new Set(), streaming = false } = {}) {
  if (msg.error) {
    return `<div class="md"><p class="msg-error">${esc(msg.error)}</p></div>`;
  }
  const parts = [];
  const citations = collectCitations(msg);
  const citeNumbers = new Set(citations.map((c) => c.n));
  msg.blocks.forEach((b, i) => {
    if (b.type === 'think') parts.push(renderThinkBlock(b, i, openThink));
    else if (b.type === 'tools') parts.push(renderToolBlock(b, streaming));
    else if (b.type === 'text' && b.text) {
      const html = renderMarkdown(b.text, { citeNumbers });
      parts.push(`<div class="md">${html}</div>`);
    }
  });

  if (msg.refusal) {
    parts.push(`<div class="md"><p class="msg-error">该问题涉及敏感内容，模型拒绝回答。请调整后重试。</p></div>`);
  }
  if (streaming && !msg.content && !msg.refusal) {
    parts.push(`<div class="typing"><i></i><i></i><i></i></div>`);
  }
  if (streaming && msg.content) parts.push('<span class="streaming-caret"></span>');
  if (!streaming) parts.push(renderSources(collectCitations(msg)));
  return parts.join('');
}

/* ------------------------------ Mermaid ------------------------------- */

let mermaidReady = false;

function ensureMermaid() {
  const m = window.mermaid;
  if (!m) return null;
  if (!mermaidReady) {
    try {
      m.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default',
        fontFamily: 'inherit',
      });
    } catch { /* 旧版本差异 */ }
    mermaidReady = true;
  }
  return m;
}

/** 把 ```mermaid 代码块替换为渲染后的图（仅在消息定稿后调用，避免流式抖动） */
export function enhanceMermaid(root) {
  const m = ensureMermaid();
  if (!m || !root) return;
  const blocks = Array.from(root.querySelectorAll('.code-block[data-lang="mermaid"]'));
  blocks.forEach(async (block, i) => {
    const code = block.querySelector('pre code')?.textContent || '';
    if (!code.trim()) return;
    const box = document.createElement('div');
    box.className = 'mermaid-box';
    box.innerHTML = '<span class="mermaid-loading">正在绘制图表…</span>';
    block.replaceWith(box);
    try {
      const id = `mmd_${Date.now().toString(36)}_${i}`;
      const { svg } = await m.render(id, code);
      box.innerHTML = svg;
    } catch (e) {
      box.className = 'mermaid-box error';
      const pre = document.createElement('pre');
      pre.className = 'mermaid-src';
      pre.textContent = code;
      box.innerHTML = `<div class="mermaid-err">图表渲染失败，已显示源码</div>`;
      box.appendChild(pre);
    }
  });
}

/* ------------------------------ 会话视图 ------------------------------ */

export class ChatView {
  constructor({ container, onEvent = {} }) {
    this.el = container;
    this.onEvent = onEvent;
    this.session = null;
    this.openThink = new Set();       // 当前流式消息展开的思考块
    this.busy = false;
    this._bindActions();

    this._flush = throttleRaf(() => this._renderStreaming());
    this._flush.fast = () => this._renderStreaming();
  }

  setSession(session) {
    if (session && Array.isArray(session.messages)) {
      // 旧会话数据在这里迁移成单版本，视图与持久化读到的是同一份结构
      session.messages = session.messages.map((m) => ensureVariants(m));
    }
    this.session = session;
    this.openThink.clear();
    this.streamingMsg = null;
    this.renderAll();
  }

  get messages() { return this.session?.messages || []; }

  /* ---------------------------- 渲染入口 ---------------------------- */

  renderAll() {
    if (!this.session) { this.el.innerHTML = ''; return; }
    const html = this.session.messages.map((m) => this.renderMessageHTML(m)).join('');
    this.el.innerHTML = html;
    enhanceMermaid(this.el);
  }

  renderMessageHTML(msg) {
    if (msg.role === 'user') {
      const imgs = (msg.attachments || []).filter((a) => a.kind === 'image' && a.dataUrl)
        .map((a) => `<img src="${esc(a.dataUrl)}" alt="附图" data-zoom="${esc(a.dataUrl)}">`).join('');
      const files = (msg.attachments || []).filter((a) => a.kind === 'file')
        .map((a) => `<span class="att-preview att-file">${icon('file', { size: 14 })} ${esc(a.name || '文件')}</span>`).join('');
      return `<div class="msg user" data-id="${msg.id}">
        <div class="user-col">
          <div class="bubble-user">${imgs ? `<div class="att-imgs">${imgs}</div>` : ''}${files ? `<div class="msg-images">${files}</div>` : ''}${esc(msg.content)}</div>
          <div class="msg-actions user-actions">
            <button class="act" data-act="copy" title="复制">${icon('copy', { size: 14 })}</button>
            <button class="act" data-act="edit" title="编辑">${icon('edit', { size: 14 })}</button>
          </div>
        </div>
      </div>`;
    }

    const streaming = msg.status === 'streaming';
    const body = renderAssistantBody(msg, { openThink: this.openThink, streaming });
    const citations = collectCitations(msg);
    const usage = msg.usage;
    const cost = usage ? formatCost(estimateCost(usage, msg.model)) : '';
    const foot = usage ? buildUsageFoot(msg) : '';
    const variant = currentVariant(msg);
    const variantBar = variant.total > 1 ? `<div class="variants" role="group" aria-label="回答版本">
        <button class="act var-btn" data-act="variant-prev" title="上一个版本" aria-label="上一个版本">${icon('chevronLeft', { size: 15 })}</button>
        <span class="var-count">${variant.index + 1}/${variant.total}</span>
        <button class="act var-btn" data-act="variant-next" title="下一个版本" aria-label="下一个版本">${icon('chevronRight', { size: 15 })}</button>
      </div>` : '';
    return `<div class="msg assistant" data-id="${msg.id}" data-streaming="${streaming ? '1' : '0'}">

      <div class="asst-body">${body}</div>
      <div class="msg-actions" data-id="${msg.id}" ${streaming ? 'style="display:none"' : ''}>
        ${variantBar}
        <button class="act" data-act="copy" title="复制">${icon('copy', { size: 15 })}<span>复制</span></button>
        <button class="act" data-act="regen" title="重新生成">${icon('refresh', { size: 15 })}</button>
        <button class="act" data-act="speak" title="朗读">${icon('speaker', { size: 15 })}</button>
        <button class="act" data-act="like" title="有帮助">${icon('thumbUp', { size: 15 })}</button>
        <button class="act" data-act="dislike" title="没帮助">${icon('thumbDown', { size: 15 })}</button>
        <button class="act" data-act="more" title="更多">${icon('more', { size: 15 })}</button>
      </div>
      <div class="msg-foot">
        <span>${formatTime(msg.createdAt)}</span>
        ${usage && msg.status !== 'streaming' ? `<span class="dot">·</span>${foot}` : ''}
      </div>
    </div>`;
  }

  /* --------------------------- 流式渲染 --------------------------- */

  /** 增量更新：只重绘正在流式输出的那一条 */
  _renderStreaming() {
    const msg = this.streamingMsg;
    if (!msg) return;
    const node = this.el.querySelector(`[data-id="${msg.id}"]`);
    if (!node) return;
    const bodyEl = node.querySelector('.asst-body');
    const stick = isNearBottom(this.el, 160);
    if (!bodyEl) return;
    bodyEl.innerHTML = renderAssistantBody(msg, { openThink: this.openThink, streaming: true });
    // 流式时隐藏操作栏与用量
    const actions = node.querySelector('.msg-actions');
    if (actions) actions.style.display = 'none';
    if (stick) scrollToBottom(this.el);
    this.onEvent.onStream?.(msg);
  }

  scheduleStreamRender() { this._flush(); }

  /* ------------------------------ 生命周期 ------------------------------ */

  beginAssistant(model) {
    const msg = createAssistantMessage(model);
    this.session.messages.push(msg);
    this.streamingMsg = msg;
    this.openThink.clear();
    const wrap = document.createElement('div');
    wrap.innerHTML = this.renderMessageHTML(msg);
    const node = wrap.firstElementChild;
    this.el.appendChild(node);
    scrollToBottom(this.el);
    return msg;
  }

  finishAssistant(msg, { error = '' } = {}) {
    msg.status = error ? 'error' : 'done';
    if (error) msg.error = error;
    this.streamingMsg = null;
    const node = this.el.querySelector(`[data-id="${msg.id}"]`);
    if (node) {
      const wrap = document.createElement('div');
      wrap.innerHTML = this.renderMessageHTML(msg);
      const fresh = wrap.firstElementChild;
      node.replaceWith(fresh);
      enhanceMermaid(fresh);
    }
    this.onEvent.onDone?.(msg);
  }

  /** 丢弃一条消息（重新生成落空时的临时消息）：从消息数组与 DOM 中移除 */
  discardMessage(msg) {
    if (!msg) return;
    if (this.streamingMsg === msg) this.streamingMsg = null;
    const node = this.el.querySelector(`[data-id="${msg.id}"]`);
    if (node) node.remove();
    if (this.session) this.session.messages = this.session.messages.filter((m) => m.id !== msg.id);
  }

  /** 重绘单条消息（用于展开思考面板、切换回答版本等交互） */
  refreshMessage(msg) {
    const node = this.el.querySelector(`[data-id="${msg.id}"]`);
    if (!node) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = this.renderMessageHTML(msg);
    const fresh = wrap.firstElementChild;
    node.replaceWith(fresh);
    enhanceMermaid(fresh);
  }

  scrollToBottom(smooth = false) { scrollToBottom(this.el, smooth); }

  /* ----------------------------- 事件绑定 ----------------------------- */

  _bindActions() {
    this.el.addEventListener('click', async (e) => {
      const thinkHead = e.target.closest('.think-head');
      if (thinkHead) {
        const box = thinkHead.closest('.think');
        const idx = Number(box.dataset.think);
        box.classList.toggle('open');
        if (this.openThink.has(idx)) this.openThink.delete(idx); else this.openThink.add(idx);
        return;
      }

      const zoom = e.target.closest('[data-zoom]');
      if (zoom) { this.onEvent.onZoom?.(zoom.dataset.zoom); return; }

      const codeCopy = e.target.closest('.code-copy');
      if (codeCopy) {
        const block = codeCopy.closest('.code-block');
        const text = block?.querySelector('pre code')?.textContent || '';
        const ok = await copyText(text);
        codeCopy.classList.toggle('copied', ok);
        codeCopy.textContent = ok ? '已复制' : '复制失败';
        setTimeout(() => { codeCopy.classList.remove('copied'); codeCopy.textContent = '复制'; }, 1600);
        return;
      }

      const cite = e.target.closest('a.cite');
      if (cite) { e.preventDefault(); this.onEvent.onCite?.(cite.dataset.cite); return; }

      const srcLink = e.target.closest('[data-src]');
      if (srcLink && this.onEvent.onOpenSource) {
        // 统一交给外部处理（可在应用内打开阅读器）
        e.preventDefault();
        this.onEvent.onOpenSource(srcLink.dataset.src);
        return;
      }

      const act = e.target.closest('.act');
      if (!act) return;
      const msgId = act.closest('[data-id]')?.dataset.id;
      const msg = this.session?.messages.find((m) => m.id === msgId);
      if (!msg) return;
      const kind = act.dataset.act;
      if (kind === 'variant-prev' || kind === 'variant-next') {
        this.onEvent.onSwitchVariant?.(msg, kind === 'variant-next' ? 'next' : 'prev');
        return;
      }
      if (kind === 'copy') {
        const text = msg.role === 'user' ? msg.content : msg.content;
        const ok = await copyText(text);
        toast(ok ? '已复制' : '复制失败', { type: ok ? 'success' : 'error' });
        haptic(6);
      } else if (kind === 'regen') {
        this.onEvent.onRegenerate?.(msg);
      } else if (kind === 'speak') {
        this.onEvent.onSpeak?.(msg);
      } else if (kind === 'like' || kind === 'dislike') {
        msg.feedback = msg.feedback === kind ? '' : kind;
        act.parentElement.querySelectorAll('.act').forEach((a) => {
          if (a.dataset.act === 'like' || a.dataset.act === 'dislike') a.classList.remove('on');
        });
        if (msg.feedback) act.classList.add('on');
        this.onEvent.onFeedback?.(msg, msg.feedback);
      } else if (kind === 'more') {
        this.onEvent.onMore?.(msg, act);
      } else if (kind === 'edit') {
        this.onEvent.onEdit?.(msg);
      }
    });
  }
}
