/* =========================================================================
 * sidebar.js —— 会话抽屉：分组列表、搜索、长按菜单
 * ========================================================================= */

import { esc, icon, formatDayLabel, dayKey } from './ui.js';

const GROUP_ORDER = ['置顶', '今天', '昨天', '7 天内', '30 天内', '更早'];

function groupOf(s) {
  if (s.pinned) return '置顶';
  const now = new Date();
  const d = new Date(s.updatedAt || s.createdAt);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((today - day) / 86400000);
  if (diff <= 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff < 7) return '7 天内';
  if (diff < 30) return '30 天内';
  return '更早';
}

export function groupSessions(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const g = groupOf(s);
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(s);
  }
  return GROUP_ORDER.filter((g) => map.has(g)).map((g) => [g, map.get(g)]);
}

export class Sidebar {
  constructor({ root, listEl, onSelect, onMenu, onNew }) {
    this.root = root;
    this.listEl = listEl;
    this.onSelect = onSelect;
    this.onMenu = onMenu;
    this.onNew = onNew;
    this.query = '';
    this.sessions = [];
    this.currentId = '';
    this._pressTimer = null;
    this._bind();
  }

  _bind() {
    this.listEl.addEventListener('click', (e) => {
      const item = e.target.closest('.sess');
      if (!item) return;
      e.preventDefault();
      this.onSelect(item.dataset.id);
    });

    this.listEl.addEventListener('contextmenu', (e) => {
      const item = e.target.closest('.sess');
      if (!item) return;
      e.preventDefault();
      this.onMenu(item.dataset.id);
    });

    // 长按（移动端）
    const start = (e) => {
      const item = e.target.closest('.sess');
      if (!item) return;
      this._pressTimer = setTimeout(() => {
        this._pressTimer = null;
        navigator.vibrate?.(10);
        this.onMenu(item.dataset.id);
      }, 520);
    };
    const cancel = () => { if (this._pressTimer) { clearTimeout(this._pressTimer); this._pressTimer = null; } };
    this.listEl.addEventListener('touchstart', start, { passive: true });
    this.listEl.addEventListener('touchend', cancel);
    this.listEl.addEventListener('touchmove', cancel, { passive: true });
    this.listEl.addEventListener('touchcancel', cancel);
    this.listEl.addEventListener('mousedown', start);
    this.listEl.addEventListener('mouseup', cancel);
    this.listEl.addEventListener('mouseleave', cancel);

    document.getElementById('history-search')?.addEventListener('input', (e) => {
      this.query = e.target.value.trim().toLowerCase();
      this.render(this.sessions, this.currentId);
    });
  }

  render(sessions, currentId) {
    this.sessions = sessions || [];
    this.currentId = currentId || '';
    const q = this.query;
    const filtered = q
      ? this.sessions.filter((s) => {
        if ((s.title || '').toLowerCase().includes(q)) return true;
        return (s.messages || []).some((m) => (m.content || '').toLowerCase().includes(q));
      })
      : this.sessions;

    if (!filtered.length) {
      this.listEl.innerHTML = `<div class="sess-empty">${q ? '没有匹配的对话' : '还没有对话，开始第一次提问吧'}</div>`;
      return;
    }

    const groups = groupSessions(filtered);
    this.listEl.innerHTML = groups.map(([name, list]) => `
      <div class="sess-group-label">${esc(name)}</div>
      ${list.map((s) => `
        <button class="sess ${s.id === currentId ? 'active' : ''}" data-id="${esc(s.id)}" title="${esc(s.title)}">
          ${s.pinned ? `<span class="sess-pin">${icon('pin', { size: 13 })}</span>` : ''}
          <span class="sess-title">${esc(s.title || '未命名对话')}</span>
        </button>`).join('')}
    `).join('');
  }
}
