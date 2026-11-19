/* =========================================================================
 * ui.js —— 通用 UI 原语：图标、提示、对话框、剪贴板、时间与费用格式化
 * 零依赖。所有用户数据进入 DOM 前必须 esc()。
 * ========================================================================= */

/** HTML 转义（与 render.js 的 escapeHtml 行为一致） */
export function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function uid(prefix = 'id') {
  const rnd = (globalThis.crypto && crypto.getRandomValues)
    ? Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(36)).join('')
    : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rnd}`;
}

export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------- 图标（24px 线性） ----------------------------- */
const P = {
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
  speaker: '<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
  speakerOff: '<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="m16 9 5 6M21 9l-5 6"/>',
  thumbUp: '<path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3Z"/><path d="M7 10l4-7a2 2 0 0 1 3 2l-1 5h5a2 2 0 0 1 2 2.4l-1.5 7A2 2 0 0 1 16.5 21H7"/>',
  thumbDown: '<path d="M17 14V3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3Z"/><path d="M17 14l-4 7a2 2 0 0 1-3-2l1-5H6a2 2 0 0 1-2-2.4l1.5-7A2 2 0 0 1 7.5 3H17"/>',
  share: '<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  pin: '<path d="M12 17v5"/><path d="M8 3h8l-1 7 3 3H6l3-3-1-7Z"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  external: '<path d="M14 3h7v7"/><path d="M21 3 10 14"/><path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
  moon: '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z"/>',
  monitor: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3Z"/>',
  brain: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5.2A3 3 0 0 0 6 17a3 3 0 0 0 3 3h1V4H9Z"/><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5.2A3 3 0 0 1 18 17a3 3 0 0 1-3 3h-1V4h1Z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M17 6l3 3M14 9l3 3"/>',
  wallet: '<path d="M20 7H5a2 2 0 0 1 0-4h13v4"/><path d="M3 5v14a2 2 0 0 0 2 2h15V7"/><path d="M17 13h.01"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  upload: '<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  warn: '<path d="M12 3 2 21h20Z"/><path d="M12 9v5M12 18h.01"/>',
  play: '<path d="M7 4l13 8-13 8V4Z"/>',
};

export function icon(name, { size = 20, cls = '' } = {}) {
  const d = P[name];
  if (!d) return '';
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

/* ------------------------------- Toast ------------------------------- */
let toastBox = null;
export function toast(message, { type = 'info', ms = 2600 } = {}) {
  if (!toastBox) {
    toastBox = document.createElement('div');
    toastBox.className = 'toast-box';
    document.body.appendChild(toastBox);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `${type === 'error' ? icon('warn', { size: 18 }) : type === 'success' ? icon('check', { size: 18 }) : ''}<span>${esc(message)}</span>`;
  toastBox.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  const kill = () => {
    el.classList.remove('in');
    setTimeout(() => el.remove(), 220);
  };
  const timer = setTimeout(kill, ms);
  el.addEventListener('click', () => { clearTimeout(timer); kill(); });
  return kill;
}

/* ------------------------------ 对话框 ------------------------------- */
function dialogShell(inner, { onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal-mask"></div><div class="modal" role="dialog" aria-modal="true">${inner}</div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('in'));
  const close = (v) => {
    wrap.classList.remove('in');
    setTimeout(() => wrap.remove(), 180);
    onClose?.(v);
  };
  wrap.querySelector('.modal-mask').addEventListener('click', () => close(null));
  return { wrap, close };
}

export function confirmDialog({ title, message = '', okText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    const { wrap, close } = dialogShell(`
      <h3 class="modal-title">${esc(title)}</h3>
      ${message ? `<p class="modal-text">${esc(message)}</p>` : ''}
      <div class="modal-actions">
        <button class="btn ghost" data-v="0">${esc(cancelText)}</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-v="1">${esc(okText)}</button>
      </div>`, { onClose: () => resolve(false) });
    wrap.querySelectorAll('[data-v]').forEach((b) =>
      b.addEventListener('click', () => { const v = b.dataset.v === '1'; wrap.remove(); resolve(v); }));
    wrap.querySelector('[data-v="1"]')?.focus();
  });
}

export function promptDialog({ title, value = '', placeholder = '', okText = '保存', cancelText = '取消', multiline = false }) {
  return new Promise((resolve) => {
    const { wrap, close } = dialogShell(`
      <h3 class="modal-title">${esc(title)}</h3>
      ${multiline
        ? `<textarea class="input modal-input" rows="4" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
        : `<input class="input modal-input" value="${esc(value)}" placeholder="${esc(placeholder)}" />`}
      <div class="modal-actions">
        <button class="btn ghost" data-v="0">${esc(cancelText)}</button>
        <button class="btn primary" data-v="1">${esc(okText)}</button>
      </div>`, { onClose: () => resolve(null) });
    const field = wrap.querySelector('.modal-input');
    const ok = () => { const v = field.value.trim(); wrap.remove(); resolve(v || null); };
    wrap.querySelector('[data-v="0"]').addEventListener('click', () => { wrap.remove(); resolve(null); });
    wrap.querySelector('[data-v="1"]').addEventListener('click', ok);
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); ok(); }
      if (e.key === 'Escape') { wrap.remove(); resolve(null); }
    });
    setTimeout(() => { field.focus(); field.select?.(); }, 60);
  });
}

/* ------------------------------ 底部抽屉 ------------------------------ */
export function openSheet(el) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet-mask"></div>`;
  wrap.appendChild(el);
  el.classList.add('sheet');
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('in'));
  const close = () => {
    wrap.classList.remove('in');
    setTimeout(() => { wrap.remove(); el.classList.remove('sheet'); }, 220);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.querySelector('.sheet-mask').addEventListener('click', close);
  return { close, wrap };
}

/* ----------------------------- 杂项工具 ------------------------------ */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

export function haptic(pattern = 8) {
  if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch { /* ignore */ } }
}

export function formatTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function formatDayLabel(ts) {
  const now = new Date();
  const d = new Date(ts);
  const diff = (new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000;
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff < 7) return `${diff} 天前`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function formatRelative(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return formatDayLabel(ts);
}

export function formatNumber(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '0';
  return n.toLocaleString('zh-CN');
}

export function formatTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}K`;
  return `${(n / 1000000).toFixed(2)}M`;
}

/** 估算费用（USD），按 deepseek-flash 非高峰价：输入 $0.15/M、输出 $0.60/M */
export function estimateCost(usage, model = 'deepseek-flash') {
  if (!usage) return 0;
  const pro = model === 'deepseek-v4-pro';
  const inRate = pro ? 0.66 : 0.15;
  const outRate = pro ? 1.98 : 0.6;
  const cacheHit = (usage.prompt_cache_hit_tokens || usage.prompt_tokens_details?.cached_tokens || 0);
  const prompt = usage.prompt_tokens || 0;
  const miss = Math.max(0, prompt - cacheHit);
  const out = usage.completion_tokens || 0;
  return (miss * inRate + cacheHit * (pro ? 0.022 : 0.003) + out * outRate) / 1e6;
}

export function formatCost(usd) {
  if (!usd) return '$0';
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function debounce(fn, ms = 200) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export function throttleRaf(fn) {
  let scheduled = false;
  let lastArgs;
  return (...args) => {
    lastArgs = args;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn(...lastArgs);
    });
  };
}

/** 自动撑高 textarea，最大高度 max 像素 */
export function autoGrow(el, max = 160) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(max, el.scrollHeight)}px`;
}

/** 校准移动端 100vh（地址栏/键盘） */
export function installViewportFix() {
  const apply = () => {
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-h', `${vh}px`);
  };
  apply();
  window.visualViewport?.addEventListener('resize', apply);
  window.addEventListener('orientationchange', () => setTimeout(apply, 120));
  window.addEventListener('resize', apply);
}

export function isNearBottom(el, threshold = 120) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

export function scrollToBottom(el, smooth = false) {
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}
