/* =========================================================================
 * store.js —— 本地持久化：设置（localStorage）、会话（IndexedDB，降级 localStorage）
 * 全部数据只保存在设备上，绝不上传。
 * ========================================================================= */

import { uid } from './ui.js';

const DB_NAME = 'deepseek-pocket';const DB_VER = 1;
const SS = 'sessions';
const KEY_API = 'ds.key';
const KEY_SETTINGS = 'ds.settings';
const KEY_UI = 'ds.ui';

export const DEFAULT_SETTINGS = {
  model: 'deepseek-flash',
  thinking: true,
  effort: 'high',
  webSearch: true,
  safety: false,
  theme: 'auto',            // auto | light | dark
  lang: 'zh',               // zh | en
  language: '中文',         // 传给模型的用户语言
  location: '上海',
  platform: 'App',
  ttsVoice: 'stella',
  ttsRate: 1,
  autoRead: false,          // 回答完成后自动朗读
  haptics: true,
  enterToSend: false,
  stream: true,
  fontSize: 'm',            // s | m | l
  showTokenUsage: true,
  mock: false,
  nickname: 'DeepSeek 用户',
  systemPrompt: '',
};

/* ------------------------------ localStorage ------------------------------ */
function lsGet(k, fallback) {
  try {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function lsSet(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 配额满时忽略 */ }
}

/* ------------------------------- IndexedDB -------------------------------- */
let dbPromise = null;
function openDB() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('no-idb'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SS)) {
        const os = db.createObjectStore(SS, { keyPath: 'id' });
        os.createIndex('updatedAt', 'updatedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('idb-open-failed'));
  });
  return dbPromise;
}

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const LS_SESSIONS = 'ds.sessions';
function lsSessions() { return lsGet(LS_SESSIONS, []); }
function lsSaveSessions(list) { lsSet(LS_SESSIONS, list); }

/* -------------------------------- 对外 API -------------------------------- */
export const store = {
  settings: { ...DEFAULT_SETTINGS },
  ui: { sidebarOpen: false, composerDraft: '' },
  ready: false,
  backend: 'idb',

  async init() {
    const rawSettings = lsGet(KEY_SETTINGS, {});
    this.settings = { ...DEFAULT_SETTINGS, ...rawSettings };
    // 兼容旧版本：安全审核改为默认关闭（只迁移一次，之后尊重用户开关）
    if (!rawSettings.migratedSafety) {
      this.settings.safety = false;
      this.settings.migratedSafety = true;
      lsSet(KEY_SETTINGS, this.settings);
    }
    this.ui = { ...this.ui, ...lsGet(KEY_UI, {}) };
    try {
      const db = await openDB();
      // 探测读写，确认真正可用
      const tx = db.transaction(SS, 'readonly');
      await idbReq(tx.objectStore(SS).getAll());
      this.backend = 'idb';
    } catch {
      this.backend = 'ls';
    }
    this.ready = true;
    return this;
  },

  saveSettings(patch = {}) {
    Object.assign(this.settings, patch);
    lsSet(KEY_SETTINGS, this.settings);
    return this.settings;
  },

  saveUi(patch = {}) {
    Object.assign(this.ui, patch);
    lsSet(KEY_UI, this.ui);
  },

  /* ------------------------------- API Key ------------------------------- */
  getKey() {
    try { return localStorage.getItem(KEY_API) || ''; } catch { return ''; }
  },
  setKey(key) {
    try {
      if (key) localStorage.setItem(KEY_API, key);
      else localStorage.removeItem(KEY_API);
    } catch { /* ignore */ }
  },

  /* -------------------------------- 会话 -------------------------------- */
  async listSessions() {
    let list;
    if (this.backend === 'idb') {
      try {
        const db = await openDB();
        list = await idbReq(db.transaction(SS, 'readonly').objectStore(SS).getAll());
      } catch { list = lsSessions(); }
    } else {
      list = lsSessions();
    }
    return (list || []).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt);
  },

  async getSession(id) {
    if (!id) return null;
    if (this.backend === 'idb') {
      try {
        const db = await openDB();
        return await idbReq(db.transaction(SS, 'readonly').objectStore(SS).get(id)) || null;
      } catch { /* fallthrough */ }
    }
    return lsSessions().find((s) => s.id === id) || null;
  },

  async saveSession(session) {
    session.updatedAt = Date.now();
    if (this.backend === 'idb') {
      try {
        const db = await openDB();
        await idbReq(db.transaction(SS, 'readwrite').objectStore(SS).put(session));
        return;
      } catch { this.backend = 'ls'; }
    }
    const list = lsSessions();
    const i = list.findIndex((s) => s.id === session.id);
    if (i >= 0) list[i] = session; else list.push(session);
    lsSaveSessions(list);
  },

  async deleteSession(id) {
    if (this.backend === 'idb') {
      try {
        const db = await openDB();
        await idbReq(db.transaction(SS, 'readwrite').objectStore(SS).delete(id));
        return;
      } catch { this.backend = 'ls'; }
    }
    lsSaveSessions(lsSessions().filter((s) => s.id !== id));
  },

  async deleteAllSessions() {
    if (this.backend === 'idb') {
      try {
        const db = await openDB();
        await idbReq(db.transaction(SS, 'readwrite').objectStore(SS).clear());
      } catch { this.backend = 'ls'; }
    }
    lsSaveSessions([]);
  },

  async importSessions(sessions, { replace = true } = {}) {
    if (replace) await this.deleteAllSessions();
    for (const s of sessions) await this.saveSession(s);
  },

  async exportAll() {
    const sessions = await this.listSessions();
    return {
      app: 'deepseek-pocket',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: this.settings,
      sessions,
    };
  },

  /** 读取导出的 JSON（兼容 DeepSeek Chat 导出的 conversations 数组） */
  normalizeImport(raw) {
    if (!raw) return { settings: null, sessions: [] };
    if (Array.isArray(raw)) return { settings: null, sessions: raw.map(normalizeSession).filter(Boolean) };
    if (Array.isArray(raw.sessions)) return { settings: raw.settings || null, sessions: raw.sessions.map(normalizeSession).filter(Boolean) };
    if (Array.isArray(raw.conversations)) {
      return { settings: null, sessions: raw.conversations.map(normalizeSession).filter(Boolean) };
    }
    return { settings: null, sessions: [] };
  },
};

/* ============================ 外部数据归一化 ============================ */
/** 把任意来源（本应用导出 / DeepSeek Chat 导出 / 数组）的会话归一化 */
export function normalizeSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || raw.conversation_id || uid('s'));
  const createdAt = toTime(raw.createdAt || raw.created_at || raw.created || raw.inserted_at) || Date.now();
  const updatedAt = toTime(raw.updatedAt || raw.updated_at || raw.updated || createdAt) || createdAt;
  let messages = [];

  if (Array.isArray(raw.messages)) {
    messages = raw.messages.map(normalizeMessage).filter(Boolean);
  } else if (raw.mapping && typeof raw.mapping === 'object') {
    // ChatGPT 风格 mapping 树 → 线性消息
    const nodes = Object.values(raw.mapping);
    nodes.sort((a, b) => (a.message?.create_time || 0) - (b.message?.create_time || 0));
    messages = nodes
      .map((n) => n.message)
      .filter((m) => m && (m.author?.role === 'user' || m.author?.role === 'assistant') && m.content?.parts)
      .map((m) => normalizeMessage({
        role: m.author.role,
        content: m.content.parts.filter((p) => typeof p === 'string').join('\n'),
        createdAt: (m.create_time || 0) * 1000,
      }))
      .filter(Boolean);
  }

  const title = String(raw.title || raw.name || firstTitle(messages) || '未命名对话').slice(0, 120);
  return {
    id,
    title,
    createdAt,
    updatedAt,
    pinned: !!raw.pinned,
    model: raw.model || DEFAULT_SETTINGS.model,
    thinking: raw.thinking ?? true,
    webSearch: raw.webSearch ?? true,
    effort: raw.effort || 'high',
    titleGenerated: !!raw.titleGenerated,
    messages,
  };
}

function normalizeMessage(m) {
  if (!m || !m.role) return null;
  const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null;
  if (!role) return null;
  const content = typeof m.content === 'string'
    ? m.content
    : Array.isArray(m.content)
      ? m.content.filter((p) => p && (p.type === 'text' || typeof p.text === 'string')).map((p) => p.text || '').join('\n')
      : '';
  return {
    id: m.id || uid('m'),
    role,
    content,
    attachments: Array.isArray(m.attachments) ? m.attachments : undefined,
    createdAt: toTime(m.createdAt || m.create_time || m.created) || Date.now(),
    model: m.model,
    usage: m.usage,
    status: 'done',
  };
}

function toTime(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

function firstTitle(messages) {
  const m = messages.find((x) => x.role === 'user');
  return m ? m.content.replace(/\s+/g, ' ').slice(0, 30) : '';
}
