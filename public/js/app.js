/* =========================================================================
 * app.js —— 应用主控：登录、会话、流式对话、语音、侧栏、设置、PWA
 * ========================================================================= */

import { ApiError, createClient, normalizeBalance, isNativeShell, isDirectHost } from './api.js';
import { createMockClient } from './mock-client.js';
import { addChat, addTTS, addASR, summary, resetUsage } from './usage.js';
import { normalizePrompts, migrateLegacy } from './prompts.js';
import { normalizeMemories, addMemory, updateMemory, removeMemory } from './memory.js';
import { contextUsage, CONTEXT_LIMIT } from './tokens.js';
import { sessionToJSONL, sessionToTXT, messageToMarkdown, safeFilename } from './exporter.js';
import { store } from './store.js';
import { ChatView, composeRequestBody, applyChunk, reminderText } from './chat.js';
import { ensureVariants, addVariant, switchVariant } from './branch.js';
import { openSettings, openModelSheet, maskKey } from './settings.js';
import { openSearchPanel, openReader } from './search.js';
import { Sidebar } from './sidebar.js';
import { Recorder, TTSPlayer } from './voice.js';
import { buildDemoSession } from './demo.js';
import {
  esc, icon, uid, toast, confirmDialog, promptDialog, openSheet, copyText,
  haptic, autoGrow, installViewportFix, isNearBottom, scrollToBottom,
  formatTokens, formatCost, estimateCost, debounce, sleep,
} from './ui.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const VERSION = document.querySelector('meta[name="app-version"]')?.content || '1.0.0';
const MODEL_LABEL = {
  'deepseek-flash': 'DeepSeek V4.1',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
};

const S = {
  key: '',
  envKey: false,
  demoMode: false,
  native: isNativeShell(),
  directWeb: !isNativeShell() && isDirectHost(),
  settings: { ...store.settings },
  serverInfo: null,
  client: null,
  sessions: [],
  session: null,
  balance: null,
  streaming: false,
  abort: null,
  attachments: [],
  recorder: null,
  tts: null,
  booted: false,
  installedPrompt: null,
  speakingId: '',
};

/* ------------------------------- 主题 ---------------------------------- */
const mqlDark = window.matchMedia('(prefers-color-scheme: dark)');

function resolveTheme() {
  const t = S.settings.theme;
  if (t === 'dark') return 'dark';
  if (t === 'light') return 'light';
  return mqlDark.matches ? 'dark' : 'light';
}

function applyTheme() {
  const t = resolveTheme();
  document.documentElement.dataset.theme = t;
  document.documentElement.dataset.font = S.settings.fontSize || 'm';
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#141519' : '#F7F9FF');
  const label = { auto: '跟随系统', light: '浅色', dark: '深色' }[S.settings.theme] || '跟随系统';
  const el = $('#theme-label');
  if (el) el.textContent = `外观：${label}`;
  try { window.DSAndroid?.setTheme?.(t === 'dark'); } catch { /* 浏览器环境 */ }
}
mqlDark.addEventListener('change', () => { if (S.settings.theme === 'auto') applyTheme(); });

/* ------------------------------- 登录 ---------------------------------- */
function setLoginStatus(text, type = '') {
  const el = $('#login-status');
  if (!el) return;
  el.className = `login-status ${type}`;
  el.innerHTML = text || '';
}
function showLogin(message = '') {
  $('#login').hidden = false;
  $('#main').hidden = true;
  const hasEnv = !S.native && !S.directWeb && !!S.serverInfo?.hasEnvKey;
  $('#login-env').hidden = !hasEnv;
  $('#login-env-hint').hidden = !hasEnv || !!S.key;
  $('#login-demo').hidden = !S.serverInfo?.mock || S.directWeb;
  if (hasEnv && !S.key) {
    $('#login-manual').style.display = '';
    setLoginStatus('检测到本机已配置密钥，可直接一键登录，或输入你自己的 API Key。');
  }
  if (message) setLoginStatus(message, 'error');
  setTimeout(() => { if (!hasEnv) $('#login-key')?.focus(); }, 260);
}

async function validateAndEnter({ key, fromEnv = false } = {}) {
  const client = createClient({ key: fromEnv ? '' : key });
  setLoginStatus('<span class="spinner"></span>正在校验密钥与额度…');
  try {
    const raw = await client.balance();
    const bal = normalizeBalance(raw);
    S.key = fromEnv ? '' : key;
    S.envKey = fromEnv;
    S.demoMode = false;
    store.setKey(fromEnv ? '' : key);
    S.balance = bal;
    await enterMain({ silent: true });
    if (bal) toast(`登录成功 · 可用额度 ${bal.currency === 'USD' ? '$' : '¥'}${bal.total}`, { type: 'success' });
  } catch (e) {
    if (e.status === 401) setLoginStatus('密钥无效，请检查是否复制完整。', 'error');
    else if (e.status === 402) setLoginStatus('密钥有效，但账户余额不足，请先充值。', 'error');
    else if (e.status === 0) setLoginStatus('无法连接本机服务（server.mjs），请确认服务已启动。', 'error');
    else setLoginStatus(`校验失败：${esc(e.message || '未知错误')}`, 'error');
  }
}

function enterDemo() {
  S.demoMode = true;
  // Mock 上游同样校验鉴权头，演示模式用占位密钥，不落盘
  S.key = 'sk-demo-mode-not-real';
  S.envKey = false;
  enterMain({ silent: true });
  toast('已进入离线演示：响应来自本地 Mock 上游', { ms: 3200 });
}

/* --------------------------- 会话管理 ---------------------------------- */

function newSession({ silent = false } = {}) {
  if (S.streaming) stopStreaming();
  // 已在新对话时不再重复创建空会话，只把焦点交还输入框
  if (S.session && S.session.messages.length === 0) {
    chat.setSession(S.session);
    updateChrome();
    if (!silent) { haptic(6); $('#input')?.focus(); }
    return S.session;
  }
  const session = {
    id: uid('s'),
    title: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pinned: false,
    model: S.settings.model,
    thinking: S.settings.thinking,
    webSearch: S.settings.webSearch,
    effort: S.settings.effort,
    titleGenerated: false,
    messages: [],
  };
  S.session = session;
  S.sessions.unshift(session);
  chat.setSession(session);
  updateChrome();
  sidebar.render(S.sessions, session.id);
  if (!silent) haptic(8);
  return session;
}

function ensureSession() {
  if (!S.session) return newSession({ silent: true });
  return S.session;
}

/** 旧消息补一次 reminder 快照，之后改设置不会重写历史前缀 */
function ensureSessionReminders(session) {
  if (!session || !Array.isArray(session.messages)) return;
  let changed = false;
  for (const m of session.messages) {
    if (m.role === 'user' && !m.reminder) {
      m.reminder = reminderText(S.settings, m.createdAt);
      changed = true;
    }
  }
  if (changed) persistCurrent();
}

async function switchSession(id) {
  // 旧会话没有 model 字段时继承当前默认模型
  try {
    const target = S.sessions.find((s) => s.id === id);
    if (target && !target.model) target.model = S.settings.model;
  } catch { /* ignore */ }
  if (S.streaming) stopStreaming();
  const found = S.sessions.find((s) => s.id === id) || await store.getSession(id);
  if (!found) return;
  S.session = found;
  chat.setSession(found);
  updateChrome();
  sidebar.render(S.sessions, id);
  closeSidebar();
  requestAnimationFrame(() => slowScrollBottom());
}

async function deleteSession(id) {
  const s = S.sessions.find((x) => x.id === id);
  if (!s) return;
  const ok = await confirmDialog({ title: '删除这个对话？', message: s.title || '未命名对话', okText: '删除', danger: true });
  if (!ok) return;
  S.sessions = S.sessions.filter((x) => x.id !== id);
  if (S.session?.id === id && S.streaming) stopStreaming();
  await store.deleteSession(id);
  if (S.session?.id === id) {
    S.session = null;
    if (S.sessions[0]) await switchSession(S.sessions[0].id);
    else { chat.setSession(null); updateChrome(); }
  }
  sidebar.render(S.sessions, S.session?.id);
  toast('已删除');
}

async function renameSession(id) {
  const s = S.sessions.find((x) => x.id === id);
  if (!s) return;
  const title = await promptDialog({ title: '重命名对话', value: s.title || '', placeholder: '输入新的标题' });
  if (!title) return;
  s.title = title.slice(0, 120);
  s.titleGenerated = true;
  await store.saveSession(s);
  if (S.session?.id === id) updateChrome();
  sidebar.render(S.sessions, S.session?.id);
}

async function togglePin(id) {
  const s = S.sessions.find((x) => x.id === id);
  if (!s) return;
  s.pinned = !s.pinned;
  await store.saveSession(s);
  sidebar.render(S.sessions, S.session?.id);
  toast(s.pinned ? '已置顶' : '已取消置顶');
}

function sessionMenu(id) {
  const s = S.sessions.find((x) => x.id === id);
  if (!s) return;
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="sheet-grip"></div>
    <div class="sheet-head"><div class="sheet-title" style="font-size:15px">${esc(s.title || '未命名对话')}</div>
      <button class="icon-btn sm" data-close>${icon('close', { size: 20 })}</button></div>
    <div class="sheet-body" style="padding-bottom:8px">
      <button class="side-item" data-a="pin">${icon('pin', { size: 18 })} ${s.pinned ? '取消置顶' : '置顶对话'}</button>
      <button class="side-item" data-a="rename">${icon('edit', { size: 18 })} 重命名</button>
      <button class="side-item" data-a="export">${icon('download', { size: 18 })} 导出 JSON</button>
      <button class="side-item" data-a="export-jsonl">${icon('download', { size: 18 })} 导出 JSONL</button>
      <button class="side-item" data-a="export-txt">${icon('download', { size: 18 })} 导出 TXT</button>
      <button class="side-item set-danger" data-a="delete">${icon('trash', { size: 18 })} 删除对话</button>
    </div>`;
  const sheet = openSheet(el);
  el.querySelector('[data-close]').addEventListener('click', () => sheet.close());
  el.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', async () => {
    const a = b.dataset.a;
    sheet.close();
    if (a === 'pin') togglePin(id);
    else if (a === 'rename') renameSession(id);
    else if (a === 'export') exportSession(s, 'json');
    else if (a === 'export-jsonl') exportSession(s, 'jsonl');
    else if (a === 'export-txt') exportSession(s, 'txt');
    else if (a === 'delete') deleteSession(id);
  }));
}

/* --------------------------- 顶栏 / 欢迎页 ----------------------------- */

/** 输入区上方的上下文预算条：本地估算 + 上次真实 prompt_tokens 校准 */
function updateContextBar() {
  const bar = $('#context-bar');
  if (!bar) return;
  const session = S.session;
  const msgs = session ? session.messages.slice() : [];
  const draft = $('#input')?.value.trim();
  if (draft) msgs.push({ role: 'user', content: draft });
  const usage = contextUsage(msgs, CONTEXT_LIMIT, session?.lastPromptTokens || 0);
  bar.hidden = msgs.length === 0;
  if (bar.hidden) return;
  const text = $('#context-text');
  if (text) text.textContent = `≈${formatTokens(usage.used)} / ${formatTokens(usage.limit)}`;
  const meter = bar.querySelector('i');
  if (meter) meter.style.width = `${(usage.ratio * 100).toFixed(1)}%`;
  bar.classList.toggle('warn', usage.ratio >= 0.8 && usage.ratio < 0.9);
  bar.classList.toggle('danger', usage.ratio >= 0.9);
}

function updateChrome() {
  const session = S.session;
  const has = !!session && session.messages.length > 0;
  $('#chip-title').textContent = session?.title || '新对话';
  $('#chip-model').textContent = MODEL_LABEL[session?.model || S.settings.model] || 'DeepSeek';
  const composer = $('#composer');
  const hasText = !!$('#input').value.trim() || S.attachments.length > 0;
  composer.classList.toggle('has-text', hasText);
  syncSpeakerIcon();
  const nick = S.settings.nickname || 'DeepSeek 用户';
  const nameEl = $('#side-name');
  const avatarEl = $('#side-avatar');
  if (nameEl) nameEl.textContent = nick;
  if (avatarEl) avatarEl.textContent = nick.slice(0, 1).toUpperCase();
  $('#welcome').classList.toggle('hide', has);
  document.title = has && session.title ? `${session.title} · DeepSeek` : 'DeepSeek';
  syncToggles();
  const scrolled = $('#messages').scrollTop > 12;
  $('#topbar').classList.toggle('scrolled', has && scrolled);
  const send = $('#btn-send');
  send.disabled = !S.streaming && !$('#input').value.trim() && S.attachments.length === 0;
  updateContextBar();
}

function syncSpeakerIcon() {
  const btn = $('#btn-speaker');
  if (!btn) return;
  const on = !!S.settings.autoRead;
  btn.setAttribute('aria-pressed', String(on));
  btn.classList.toggle('on', on);
  btn.innerHTML = icon(on ? 'speaker' : 'speakerOff', { size: 22 });
  btn.setAttribute('aria-label', on ? '关闭自动朗读' : '开启自动朗读');
}

function syncToggles() {
  const eff = effectiveSettings();
  $('#btn-thinking').setAttribute('aria-pressed', String(!!eff.thinking));
  $('#btn-websearch').setAttribute('aria-pressed', String(!!eff.webSearch));
}

function effectiveSettings() {
  const s = { ...S.settings };
  if (S.session) {
    if (typeof S.session.thinking === 'boolean') s.thinking = S.session.thinking;
    if (typeof S.session.webSearch === 'boolean') s.webSearch = S.session.webSearch;
    if (S.session.model) s.model = S.session.model;
    if (S.session.effort) s.effort = S.session.effort;
  }
  return s;
}

function renderSuggestions() {
  const box = $('#suggestions');
  if (box) box.hidden = true;   // 官方 2.8 首页只保留问候语
  const items = [
    { icon: 'sparkle', text: '做一个贪吃蛇小游戏' },
    { icon: 'brain', text: '解释一下量子纠缠，要通俗一点' },
    { icon: 'edit', text: '写一首关于秋天的短诗' },
    { icon: 'globe', text: '帮我规划上海周末一日游' },
  ];
  $('#suggestions').innerHTML = items.map((it) => `
    <button class="suggestion" data-text="${esc(it.text)}">
      <span class="s-ico">${icon(it.icon, { size: 17 })}</span>
      <span class="txt">${esc(it.text)}</span>
      <span class="s-arrow">${icon('chevronRight', { size: 16 })}</span>
    </button>`).join('');
  $$('#suggestions .suggestion').forEach((b) => b.addEventListener('click', () => {
    if (S.streaming) { toast('正在生成，请稍候'); return; }
    sendMessage(b.dataset.text);
  }));
}

/* ------------------------------- 发送 ---------------------------------- */

function stopStreaming() {
  try { S.tts?.stop(); } catch { /* ignore */ }
  try { S.abort?.abort(); } catch { /* ignore */ }
}

function setBusy(busy) {
  S.streaming = busy;
  $('#composer').classList.toggle('is-generating', busy);
  const send = $('#btn-send');
  send.classList.toggle('stop', busy);
  send.disabled = !busy && !$('#input').value.trim() && !S.attachments.length;
  send.setAttribute('aria-label', busy ? '停止生成' : '发送');
}

function appendUserBubble(msg) {
  const wrap = document.createElement('div');
  wrap.innerHTML = chat.renderMessageHTML(msg);
  chat.el.appendChild(wrap.firstElementChild);
}

function slowScrollBottom() {
  scrollToBottom($('#messages'));
}

async function sendMessage(text, { attachments = [] } = {}) {
  if (S.streaming) return;
  const content = (text || '').trim();
  if (!content && !attachments.length) return;

  const session = ensureSession();
  if (!session.title) {
    session.title = content.slice(0, 24) || (attachments.length ? '图片对话' : '新对话');
    session.titleGenerated = false;
  }
  const userMsg = {
    id: uid('m'),
    role: 'user',
    content,
    attachments: attachments.length ? attachments : undefined,
    createdAt: Date.now(),
    reminder: reminderText(S.settings),
    status: 'done',
  };
  session.messages.push(userMsg);
  void persistSession(session, { ...session, messages: session.messages.slice() });
  appendUserBubble(userMsg);

  clearComposer();
  S.attachments = [];
  renderAttachments();
  updateChrome();
  $('#welcome').classList.add('hide');
  slowScrollBottom();
  sidebar.render(S.sessions, session.id);

  await runAssistant();
}

/**
 * 跑一轮助手生成。
 * @param context 本轮请求的上下文消息（重新生成时只到上一条用户消息）
 * @param mergeInto 重新生成的目标消息：结果作为新版本并入，而不是新消息
 */
async function runAssistant({ context = null, mergeInto = null } = {}) {
  const session = ensureSession();
  const eff = effectiveSettings();
  const requestSession = context ? { ...session, messages: context } : session;
  const asst = chat.beginAssistant(eff.model);
  const ctrl = new AbortController();
  S.abort = ctrl;
  setBusy(true);
  const startedAt = Date.now();

  chat.onEvent.onStream = () => { /* 滚动由 ChatView 内部处理 */ };

  /** 收尾：普通发送直接定稿；重新生成并入原消息成为新版本，空结果则丢弃临时消息 */
  const settle = () => {
    if (!mergeInto) { chat.finishAssistant(asst); return asst; }
    if (S.session !== session) {          // 生成期间切走了会话：不要改写当前画布
      chat.discardMessage(asst, session);
      return mergeInto;
    }
    const hasPayload = !!(asst.content || asst.reasoningContent || (asst.blocks && asst.blocks.length));
    if (hasPayload) {
      const merged = mergeRegenerated(mergeInto, asst);
      if (!merged) chat.discardMessage(asst);      // 原消息已被删除等异常：不要留下孤儿节点
      chat.setSession(session);
      return merged || mergeInto;
    }
    chat.discardMessage(asst);
    chat.setSession(session);
    if (asst.error) toast(asst.error, { type: 'error', ms: 4200 });
    return mergeInto;
  };

  const body = composeRequestBody({ session: requestSession, settings: eff });
  // 会话级开关写回消息请求；标题只取首轮
  try {
    await S.client.chat(body, {
      signal: ctrl.signal,
      onEvent: (chunk) => {
        if (chunk.done) return;
        const touched = applyChunk(asst, chunk);
        asst.durationMs = Date.now() - startedAt;
        if (!asst.firstTokenMs && (touched === 'content' || touched === 'reasoning')) {
          asst.firstTokenMs = Date.now() - startedAt;
        }
        if (asst.title && !session.titleGenerated) {
          session.title = String(asst.title).slice(0, 120);
          session.titleGenerated = true;
          if (S.session === session) {
            updateChrome();
            sidebar.render(S.sessions, session.id);
          }
        }
        chat.scheduleStreamRender();
      },
    });
    asst.status = 'done';
    if (asst.usage?.prompt_tokens) session.lastPromptTokens = asst.usage.prompt_tokens;
    if (!asst.content && !asst.reasoningContent && !asst.refusal) {
      throw new ApiError('模型没有返回内容，请重试。', { type: 'empty_response' });
    }
    settle();
    afterAnswer(session, asst);
  } catch (e) {
    if (e?.name === 'AbortError') {
      asst.status = 'done';
      asst.finishReason = 'aborted';
      if (!asst.content && !asst.reasoningContent && !mergeInto) asst.content = '（已停止生成）';
      settle();
      toast('已停止生成');
      afterAnswer(session, asst, { partial: true });
    } else {
      handleApiError(e, asst, { session, mergeInto });
    }
  } finally {
    setBusy(false);
    S.abort = null;
    await persistSession(session);
    setTimeout(() => refreshBalance(false), 1200);
  }
}

/** 把重新生成的结果并入原消息：旧回答保留为历史版本，新回答成为当前版本 */
function mergeRegenerated(target, asst) {
  const session = S.session;
  if (!session) return null;
  const idx = session.messages.findIndex((m) => m.id === target.id);
  if (idx < 0) return null;
  chat.discardMessage(asst);                       // 临时消息从消息数组与 DOM 中移除
  const merged = addVariant(session.messages[idx], asst);
  session.messages[idx] = merged;
  S.speakingId = '';
  return merged;
}

function handleApiError(e, asst, { session, mergeInto = null } = {}) {
  const status = e?.status || 0;
  let msg = e?.message || '请求失败';
  if (status === 401) {
    msg = S.demoMode ? '演示模式的上游拒绝了请求（Mock 服务异常），请重启 server.mjs。' : 'API Key 无效或已被删除，请重新登录。';
    if (!S.demoMode) setTimeout(() => logout(true), 600);
  } else if (status === 402) {
    msg = '账户余额不足，请前往开放平台充值后重试。';
  } else if (status === 429) {
    msg = '请求过于频繁（429），请稍后再试。';
  } else if (status === 400) {
    msg = `请求被拒绝：${e.message}`;
  } else if (status === 0 && e?.type !== 'stream_interrupted' && e?.type !== 'empty_response') {
    msg = (S.native || S.directWeb)
      ? '网络不可用：请检查网络，或稍后重试。'
      : '网络不可用：手机与运行 server.mjs 的电脑需在同一 Wi-Fi，且电脑未被防火墙拦截。';
  }
  asst.error = msg;
  asst.status = 'error';
  if (mergeInto) {
    const hasPayload = !!(asst.content || asst.reasoningContent || (asst.blocks && asst.blocks.length));
    if (hasPayload && S.session === session) {
      // 已有部分内容：作为新版本并入（与正常重新生成一致），不丢已生成内容
      asst.error = '';
      asst.status = 'done';
      mergeRegenerated(mergeInto, asst);
      chat.setSession(session);
    } else {
      // 纯失败：保留原消息与已有版本，不写入失败版本
      chat.discardMessage(asst, session);
      if (S.session === session) chat.setSession(session);
    }
  } else {
    chat.finishAssistant(asst, { error: msg });
  }
  toast(msg, { type: 'error', ms: 4200 });
  haptic([12, 40, 12]);
}

function afterAnswer(session, asst, { partial = false } = {}) {
  if (!session.title || !session.titleGenerated) {
    const firstUser = session.messages.find((m) => m.role === 'user');
    if (firstUser) session.title = (firstUser.content || '图片对话').slice(0, 24);
  }
  try { addChat(asst.usage, asst.model); } catch { /* 统计失败不影响使用 */ }
  if (S.session !== session || !S.sessions.includes(session)) return;
  updateChrome();
  sidebar.render(S.sessions, session.id);
  if (!partial && asst.content && S.settings.autoRead) speakMessage(asst);
}

function persistCurrent() {
  return persistSession(S.session);
}

async function persistSession(s, snapshot = s) {
  if (!s || !S.sessions.includes(s)) return;
  try {
    await store.saveSession(snapshot);
    s.updatedAt = snapshot.updatedAt;
    S.sessions.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt);
  } catch (e) {
    console.warn('保存失败', e);
  }
}

/* ----------------------------- 消息操作 -------------------------------- */

async function regenerate(msg) {
  if (S.streaming) return;
  const session = S.session;
  if (!session) return;
  const idx = session.messages.findIndex((m) => m.id === msg.id);
  if (idx < 0) return;
  let userIdx = idx;
  while (userIdx >= 0 && session.messages[userIdx].role !== 'user') userIdx -= 1;
  if (userIdx < 0) return;

  // 重新生成不再覆盖旧回答：原消息保留，本轮结果并入成为新版本
  if (S.speakingId === msg.id) { try { S.tts?.stop(); } catch { /* ignore */ } }
  const target = ensureVariants(session.messages[idx]);
  session.messages[idx] = target;
  const context = session.messages.slice(0, userIdx + 1);
  if (idx < session.messages.length - 1) {
    session.messages = session.messages.slice(0, idx + 1);
  }
  chat.setSession(session);
  updateChrome();
  await runAssistant({ context, mergeInto: target });
}

/** 在回答的历史版本之间循环切换（‹ n/m ›） */
async function switchMessageVariant(msg, direction) {
  if (S.streaming) { toast('正在生成，稍后再切换版本'); return; }
  const session = S.session;
  if (!session) return;
  const idx = session.messages.findIndex((m) => m.id === msg.id);
  if (idx < 0) return;
  const current = ensureVariants(session.messages[idx]);
  const next = switchVariant(current, direction);
  if (next.activeVariant === current.activeVariant) return;
  session.messages[idx] = next;
  if (S.speakingId === next.id) { try { S.tts?.stop(); } catch { /* ignore */ } }
  chat.refreshMessage(next);
  haptic(5);
  await persistCurrent();
}

async function editMessage(msg) {
  if (S.streaming) return;
  const session = S.session;
  if (!session) return;
  const text = await promptDialog({ title: '编辑消息', value: msg.content, multiline: true, okText: '发送' });
  if (text === null) return;
  const idx = session.messages.findIndex((m) => m.id === msg.id);
  if (idx < 0) return;
  session.messages = session.messages.slice(0, idx);
  chat.setSession(session);
  await sendMessage(text, { attachments: msg.attachments || [] });
}

function moreMenu(msg) {
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="sheet-grip"></div>
    <div class="sheet-head"><div class="sheet-title" style="font-size:15px">消息操作</div>
      <button class="icon-btn sm" data-close>${icon('close', { size: 20 })}</button></div>
    <div class="sheet-body" style="padding-bottom:10px">
      <button class="side-item" data-a="copy">${icon('copy', { size: 18 })} 复制回答</button>
      <button class="side-item" data-a="regen">${icon('refresh', { size: 18 })} 重新生成</button>
      <button class="side-item" data-a="speak">${icon('speaker', { size: 18 })} 朗读回答</button>
      <button class="side-item" data-a="md">${icon('download', { size: 18 })} 导出为 Markdown</button>
      <button class="side-item" data-a="copy-md">${icon('copy', { size: 18 })} 复制为 Markdown</button>
      <button class="side-item" data-a="branch">${icon('sparkle', { size: 18 })} 从这里建分支</button>
      <button class="side-item set-danger" data-a="delete">${icon('trash', { size: 18 })} 删除这条回答</button>
    </div>`;
  const sheet = openSheet(el);
  el.querySelector('[data-close]').addEventListener('click', () => sheet.close());
  el.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', async () => {
    sheet.close();
    const a = b.dataset.a;
    if (a === 'copy') { await copyText(msg.content); toast('已复制', { type: 'success' }); }
    else if (a === 'regen') regenerate(msg);
    else if (a === 'speak') speakMessage(msg);
    else if (a === 'md') downloadMarkdown(msg);
    else if (a === 'copy-md') { await copyText(messageToMarkdown(msg)); toast('已复制 Markdown', { type: 'success' }); }
    else if (a === 'branch') branchFromMessage(msg);
    else if (a === 'delete') {
      const ok = await confirmDialog({ title: '删除这条回答？', okText: '删除', danger: true });
      if (!ok) return;
      const s = S.session;
      s.messages = s.messages.filter((m) => m.id !== msg.id);
      chat.setSession(s);
      await persistCurrent();
    }
  }));
}

function downloadMarkdown(msg) {
  const blob = new Blob([msg.content], { type: 'text/markdown;charset=utf-8' });
  downloadBlob(blob, `deepseek-${Date.now()}.md`);
}

/* ------------------------------ 语音输入 ------------------------------- */

function buildRecWave() {
  const wave = $('#rec-wave');
  wave.innerHTML = Array.from({ length: 30 }, () => '<i></i>').join('');
  return Array.from(wave.querySelectorAll('i'));
}

async function startVoice() {
  if (S.streaming) { toast('正在生成回答，请稍候'); return; }
  if (!window.isSecureContext) {
    toast('麦克风需要 HTTPS 安全上下文，请用 https:// 地址访问', { type: 'error', ms: 5000 });
    return;
  }
  const rec = new Recorder({
    onLevel: (lv) => {
      const bars = S.recBars || [];
      bars.forEach((b, i) => {
        const center = Math.abs(i - bars.length / 2) / (bars.length / 2);
        const h = 6 + Math.max(2, lv * 44 * (1 - center * 0.65));
        b.style.height = `${Math.min(46, h)}px`;
      });
    },
    onTick: (sec) => {
      const el = $('#rec-time');
      if (el) el.textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
      if (sec > 100) $('#rec-hint').textContent = '接近 120 秒上限，点「完成」结束';
    },
  });
  S.recorder = rec;
  $('#recorder').hidden = false;
  $('#rec-title').textContent = '正在聆听…';
  $('#rec-hint').textContent = '说完后点「完成」，识别结果会填入输入框';
  $('#rec-time').textContent = '00:00';
  $('#rec-done').disabled = true;
  S.recBars = buildRecWave();
  try {
    await rec.start();
    $('#rec-done').disabled = false;
  } catch (e) {
    $('#recorder').hidden = true;
    toast(e.message || '无法开始录音', { type: 'error', ms: 4200 });
  }
}

async function finishVoice() {
  const rec = S.recorder;
  if (!rec || rec.state !== 'recording') return;
  $('#rec-title').textContent = '正在识别…';
  $('#rec-done').disabled = true;
  let out;
  try {
    out = await rec.stop();
  } catch {
    out = null;
  }
  if (!out || out.durationMs < 500) {
    hideRecorder();
    toast('录音太短，请再说一次');
    return;
  }
  try {
    $('#rec-hint').textContent = '调用 ASR 识别中…';
    const res = await S.client.asr(out.blob);
    const text = (res?.text || '').trim();
    try { addASR((res?.duration_ms || out.durationMs) / 1000); } catch { /* ignore */ }
    hideRecorder();
    if (!text) { toast('没有识别到内容'); return; }
    const input = $('#input');
    input.value = input.value ? `${input.value} ${text}` : text;
    autoGrow(input);
    input.focus();
    updateChrome();
    haptic(10);
    if (S.voiceAutoSend) {
      S.voiceAutoSend = false;
      toast('识别完成，正在发送');
      onSubmit();
    } else {
      toast('已转成文字，可编辑后发送');
    }
  } catch (e) {
    hideRecorder();
    toast(`语音识别失败：${e.message || '未知错误'}`, { type: 'error', ms: 4200 });
  }
}

function hideRecorder() {
  $('#recorder').hidden = true;
  S.recBars = [];
  if (S.recorder && S.recorder.state !== 'idle') S.recorder.cancel().catch(() => {});
  S.recorder = null;
}

/* ------------------------------- 朗读 ---------------------------------- */

function initTTS() {
  S.tts = new TTSPlayer({
    onState: (state, info) => {
      const btn = S.speakingId
        ? document.querySelector(`[data-id="${S.speakingId}"] .act[data-act="speak"]`)
        : null;
      if (!btn) return;
      if (state === "playing" || state === "loading") {
        btn.classList.add("on");
        btn.innerHTML = icon("stop", { size: 15 });
        btn.setAttribute("aria-label", "停止朗读");
      } else if (state === "paused") {
        btn.classList.add("on");
        btn.innerHTML = icon("play", { size: 15 });
        btn.setAttribute("aria-label", "继续朗读");
      } else {
        btn.classList.remove("on");
        btn.innerHTML = icon("speaker", { size: 15 });
        btn.setAttribute("aria-label", "朗读");
        S.speakingId = "";
      }
    },
    onError: (e) => toast(`朗读失败：${e.message || "未知错误"}`, { type: "error" }),
  });
}
async function speakMessage(msg) {
  const text = (msg.content || "").trim();
  if (!text) { toast("这条回答没有可朗读的内容"); return; }
  if (S.demoMode) { /* 演示模式用本地合成音频 */ }
  if (!S.tts) initTTS();

  // 再点一次同一条 → 停止
  if (S.tts.busy && S.speakingId === msg.id) {
    S.tts.stop();
    return;
  }
  S.tts.stop();
  S.speakingId = msg.id;
  try { addTTS(text); } catch { /* ignore */ }
  try {
    await S.tts.speak(text, {
      voiceId: S.settings.ttsVoice,
      rate: Number(S.settings.ttsRate) || 1,
      fetchAudio: (args, { signal }) => S.client.tts({ text: args.text, voiceId: args.voiceId, format: "wav" }, { signal }),
    });
  } catch (e) {
    toast(`朗读失败：${e.message || "未知错误"}`, { type: "error" });
    S.speakingId = "";
  }
}
/* ----------------------------- 附件上传 -------------------------------- */

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsDataURL(file);
  });
}

async function compressImage(file, maxSide = 1600, quality = 0.86) {
  if (file.type === 'image/gif') return readAsDataURL(file);
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    return canvas.toDataURL('image/jpeg', quality);
  } catch {
    return readAsDataURL(file);
  }
}

async function pickFiles() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'image/*,.pdf,.doc,.docx,.ppt,.pptx,.txt,.md,.csv,.json,.py,.js,.ts,.html,.css,.xlsx,.epub';
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    for (const f of files) await addAttachment(f);
  });
  input.click();
}

async function addAttachment(file) {
  if (!file) return;
  if (S.attachments.length >= 6) { toast('一次最多 6 个附件'); return; }
  const isImage = file.type.startsWith('image/');
  const sizeLimit = isImage ? 12 * 1024 * 1024 : 100 * 1024 * 1024;
  if (file.size > sizeLimit) { toast(`文件过大：${file.name}`, { type: 'error' }); return; }

  if (isImage) {
    toast('正在处理图片…', { ms: 1200 });
    const dataUrl = await compressImage(file);
    S.attachments.push({ kind: 'image', name: file.name, dataUrl, size: file.size });
    renderAttachments();
    return;
  }

  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const textLike = ['txt', 'md', 'csv', 'json', 'py', 'js', 'ts', 'html', 'css', 'xml', 'yaml', 'yml', 'log', 'xlsx', 'epub'].includes(ext);
  const purpose = textLike ? 'user_data' : 'text_recognition';
  const close = toast('正在上传并解析文档…', { ms: 60000 });
  try {
    const res = await S.client.uploadFile(file, { purpose });
    S.attachments.push({ kind: 'file', name: file.name, fileId: res.id, size: file.size });
    renderAttachments();
    toast(`已解析：${file.name}`, { type: 'success' });
  } catch (e) {
    toast(`上传失败：${e.message || '未知错误'}`, { type: 'error', ms: 4200 });
  } finally {
    close();
  }
}

function renderAttachments() {
  const box = $('#attachments');
  if (!S.attachments.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = S.attachments.map((a, i) => a.kind === 'image'
    ? `<div class="att-preview"><img src="${esc(a.dataUrl)}" alt=""><button class="att-del" data-i="${i}" aria-label="移除">${icon('close', { size: 12 })}</button></div>`
    : `<div class="att-preview att-file">${icon('file', { size: 14 })}<span>${esc(a.name)}</span><button class="att-del" data-i="${i}" aria-label="移除">${icon('close', { size: 12 })}</button></div>`).join('');
  box.querySelectorAll('.att-del').forEach((b) => b.addEventListener('click', () => {
    S.attachments.splice(Number(b.dataset.i), 1);
    renderAttachments();
    updateChrome();
  }));
}

/* ------------------------------ 额度 ---------------------------------- */

async function refreshBalance(force = false) {
  try {
    if (S.demoMode) {
      S.balance = { available: true, currency: 'CNY', total: '128.00', granted: '128.00', toppedUp: '0', all: [] };
      return S.balance;
    }
    const raw = await S.client.balance();
    S.balance = normalizeBalance(raw);
    const val = document.querySelector('#balance-value');
    if (val && S.balance) {
      const sym = S.balance.currency === 'USD' ? '$' : '¥';
      val.textContent = `${sym}${S.balance.total}`;
    }
    return S.balance;
  } catch (e) {
    if (force) toast(e?.status === 401 ? '密钥已失效，请重新登录' : '额度获取失败，请检查网络', { type: 'error' });
    return S.balance;
  }
}

/* ---------------------------- 侧栏 / 设置 ------------------------------ */

function openSidebar() {
  $('#sidebar').classList.add('open');
  $('#sidebar').setAttribute('aria-hidden', 'false');
  $('#scrim').hidden = false;
  $('#btn-menu').setAttribute('aria-expanded', 'true');
  sidebar.render(S.sessions, S.session?.id);
  refreshBalance(false);
}

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebar').setAttribute('aria-hidden', 'true');
  $('#scrim').hidden = true;
  $('#btn-menu').setAttribute('aria-expanded', 'false');
}

function settingsCtx() {
  return {
    settings: () => S.settings,
    saveSettings: (patch) => {
      store.saveSettings(patch);
      S.settings = store.settings;
      if (Object.prototype.hasOwnProperty.call(patch, 'edgeSwipe')) applyEdgeSwipeSetting();
    },
    applySettings: () => { applyTheme(); updateChrome(); },
    applyTheme,
    getKey: () => S.key,
    isEnvKey: () => S.envKey,
    isDemo: () => S.demoMode,
    isNative: () => S.native,
    isDirectWeb: () => S.directWeb,
    getBalance: () => S.balance,
    refreshBalance,
    changeKey: async () => { await logout(false); },
    getBackend: () => (store.backend === 'idb' ? '本机 IndexedDB' : '本机 localStorage'),
    getNickname: () => S.settings.nickname || 'DeepSeek 用户',
    setNickname: (v) => { store.saveSettings({ nickname: v }); S.settings = store.settings; updateChrome(); },
    getVersion: () => S.serverInfo?.version || VERSION,
    getServerInfo: () => S.serverInfo,
    getUsage: () => summary(),
    getPrompts: () => normalizePrompts(S.settings.prompts),
    sessionModel: () => S.session?.model || S.settings.model,
    setSessionModel: async (id) => {
      if (S.session) { S.session.model = id; await persistCurrent(); }
      store.saveSettings({ model: id });
      S.settings = store.settings;
      updateChrome();
    },
    setPrompts: (list) => { store.saveSettings({ prompts: normalizePrompts(list) }); S.settings = store.settings; updateContextBar(); },
    getMemories: () => normalizeMemories(S.settings.memories),
    addMemory: (text) => { store.saveSettings({ memories: addMemory(S.settings.memories, text) }); S.settings = store.settings; },
    updateMemory: (id, patch) => { store.saveSettings({ memories: updateMemory(S.settings.memories, id, patch) }); S.settings = store.settings; },
    removeMemory: (id) => { store.saveSettings({ memories: removeMemory(S.settings.memories, id) }); S.settings = store.settings; },
    resetUsage,
    openModelSheet: () => openModelSheet(settingsCtx()),
    sessionHasImages: () => !!S.session?.messages.some((m) => m.attachments?.some((a) => a.kind === 'image')),
    syncSpeakerIcon,
    previewTTS: () => {
      if (!S.tts) initTTS();
      S.tts.speak('你好，我是 DeepSeek，这是当前音色的试听效果。', {
        voiceId: S.settings.ttsVoice,
        rate: Number(S.settings.ttsRate) || 1,
        fetchAudio: (args, { signal }) => S.client.tts({ text: args.text, voiceId: args.voiceId, format: 'wav' }, { signal }),
      });
    },
    exportData,
    importData,
    clearAll: async () => {
      S.sessions = [];
      stopStreaming();
      await store.deleteAllSessions();
      S.session = null;
      chat.setSession(null);
      updateChrome();
      sidebar.render([], '');
      newSession({ silent: true });
      toast('已清空全部对话');
    },
    logout: async () => { await logout(false); },
  };
}

async function exportSession(s, fmt = 'json') {
  const name = safeFilename(s.title || 'chat');
  if (fmt === 'jsonl') {
    await downloadBlob(new Blob([sessionToJSONL(s) + '\n'], { type: 'application/jsonl' }), `${name}.jsonl`);
    toast('已导出 JSONL', { type: 'success' });
    return;
  }
  if (fmt === 'txt') {
    await downloadBlob(new Blob([sessionToTXT(s)], { type: 'text/plain' }), `${name}.txt`);
    toast('已导出 TXT', { type: 'success' });
    return;
  }
  const blob = new Blob([JSON.stringify({ app: 'deepseek-pocket', version: 1, sessions: [s] }, null, 2)], { type: 'application/json' });
  await downloadBlob(blob, `${name}.json`);
  toast('已导出对话');
}

/** 从某条消息建分支：复制到该条为止，切到新会话 */
async function branchFromMessage(msg) {
  const src = S.session;
  if (!src) return;
  const idx = src.messages.findIndex((m) => m.id === msg.id);
  if (idx < 0) return;
  const copy = {
    ...src,
    id: uid('s'),
    title: `${src.title || '未命名对话'} · 分支`,
    messages: src.messages.slice(0, idx + 1).map((m) => JSON.parse(JSON.stringify(m))),
    parentId: src.id,
    parentTitle: src.title || '',
    titleGenerated: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  S.sessions.unshift(copy);
  await store.saveSession(copy);
  await switchSession(copy.id);
  toast('已从这里创建分支', { type: 'success' });
}

async function exportData() {
  const data = await store.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  await downloadBlob(blob, `deepseek-backup-${new Date().toISOString().slice(0, 10)}.json`);
  toast('已导出全部对话', { type: 'success' });
}

async function downloadBlob(blob, name) {
  if (S.native && window.DSAndroid?.saveText) {
    const text = await blob.text();
    const path = window.DSAndroid.saveText(name, blob.type || 'application/json', text);
    if (path) { toast(`已保存到 ${path}`, { type: 'success', ms: 3600 }); haptic(10); }
    else toast('保存失败，请检查存储权限', { type: 'error' });
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

function importData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      const { sessions } = store.normalizeImport(raw);
      if (!sessions.length) { toast('文件里没有可导入的对话', { type: 'error' }); return; }
      const ok = await confirmDialog({
        title: `导入 ${sessions.length} 个对话？`,
        message: '导入会替换当前全部对话，建议先导出备份。',
        okText: '导入',
      });
      if (!ok) return;
      await store.importSessions(sessions, { replace: true });
      S.sessions = await store.listSessions();
      S.session = S.sessions[0] || null;
      if (S.session) { chat.setSession(S.session); } else { newSession(); }
      updateChrome();
      sidebar.render(S.sessions, S.session?.id);
      toast(`已导入 ${sessions.length} 个对话`, { type: 'success' });
    } catch (e) {
      toast('导入失败：文件格式不正确', { type: 'error' });
    }
  });
  input.click();
}

async function logout(force = false) {
  if (!force) {
    const ok = await confirmDialog({ title: '退出登录？', message: '本地对话不会删除，密钥会从本机移除。', okText: '退出', danger: true });
    if (!ok) return;
  }
  stopStreaming();
  store.setKey('');
  S.key = '';
  S.envKey = false;
  S.balance = null;
  S.sessions = [];
  S.session = null;
  S.settings = { ...store.settings };
  chat.setSession(null);
  closeSidebar();
  showLogin(force ? '密钥已失效，请重新登录。' : '已退出登录。');
}

/* ------------------------------- 输入区 -------------------------------- */

function clearComposer() {
  const input = $('#input');
  input.value = '';
  autoGrow(input);
  updateChrome();
}

async function onSubmit() {
  if (S.streaming) { stopStreaming(); return; }
  const text = $('#input').value.trim();
  if (!text && !S.attachments.length) return;
  const attachments = S.attachments.slice();
  $('#input').value = '';
  autoGrow($('#input'));
  haptic(10);
  await sendMessage(text, { attachments });
}

/* ------------------------------- 搜索 ---------------------------------- */

function openSearch() {
  openSearchPanel({
    getClient: () => S.client,
    onAsk: async (query) => {
      S.settings.webSearch = true;
      if (S.session) S.session.webSearch = true;
      store.saveSettings({ webSearch: true });
      syncToggles();
      await sendMessage(query);
    },
  });
}

/* ----------------------------- 绑定事件 -------------------------------- */

let sidebar = null;
let chat = null;

/* ----------------------------- 全面屏手势 ----------------------------- */

/** 侧栏：跟手左滑关闭（带阻尼，松手按距离回弹或关闭） */
function bindSidebarDrag() {
  const sb = $('#sidebar');
  if (!sb) return;
  let sx = 0; let sy = 0; let dx = 0; let dy = 0; let active = false;
  sb.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    dx = 0; dy = 0;
    active = true;
  }, { passive: true });
  sb.addEventListener('touchmove', (e) => {
    if (!active) return;
    dx = e.touches[0].clientX - sx;
    dy = e.touches[0].clientY - sy;
    if (dx < 0 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      sb.style.transition = 'none';
      sb.style.transform = `translateX(${Math.max(dx, -sb.offsetWidth * 0.6)}px)`;
    }
  }, { passive: true });
  const end = () => {
    if (!active) return;
    active = false;
    sb.style.transition = '';
    sb.style.transform = '';
    if (dx < -Math.min(110, sb.offsetWidth * 0.3)) closeSidebar();
    dx = 0; dy = 0;
  };
  sb.addEventListener('touchend', end, { passive: true });
  sb.addEventListener('touchcancel', end, { passive: true });
}

/** 消息：左右滑切换回答版本（仅多版本时生效） */
function bindMessageSwipe() {
  const box = $('#messages');
  if (!box) return;
  let node = null; let sx = 0; let sy = 0;
  box.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { node = null; return; }
    const target = e.target.closest('.msg.assistant');
    if (!target) { node = null; return; }
    if (e.target.closest('.code-block, table, .math-display, img, a, input, textarea, .msg-actions, .source-list')) {
      node = null;
      return;
    }
    node = target;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
  }, { passive: true });
  box.addEventListener('touchend', (e) => {
    if (!node) return;
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) { node = null; return; }
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    const target = node;
    node = null;
    if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const msg = S.session?.messages.find((m) => m.id === target.dataset.id);
    if (!msg) return;
    const count = msg.variants?.length || 1;
    if (count < 2) { haptic(4); return; }
    switchMessageVariant(msg, dx < 0 ? 'next' : 'prev');
    haptic(6);
  }, { passive: true });
}

/** 把“左缘滑动打开侧栏”开关同步给 Android 壳（决定是否让出系统手势区） */
function applyEdgeSwipeSetting() {
  try { window.DSAndroid?.setEdgeSwipe?.(S.native); } catch { /* 浏览器忽略 */ }
}

/** 左缘向右滑打开侧栏（需在设置里开启，避免与系统返回手势冲突） */
function bindEdgeSwipe() {
  let ex = 0; let ey = 0; let active = false;
  document.addEventListener('touchstart', (e) => {
    if (!S.settings.edgeSwipe) return;
    if (e.touches.length !== 1) return;
    const x = e.touches[0].clientX;
    if (x > 24) { active = false; return; }
    ex = x;
    ey = e.touches[0].clientY;
    active = true;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (!active) return;
    active = false;
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - ex;
    const dy = t.clientY - ey;
    if (!(dx > 70 && Math.abs(dx) > Math.abs(dy) * 1.4)) return;
    // 浮层/搜索/设置/侧栏打开时，左缘右滑等价于返回
    if (document.querySelector('.sheet-wrap, .modal-wrap, .search-panel, .settings-page') || $('#sidebar')?.classList.contains('open')) {
      window.__dsBack?.();
    } else {
      openSidebar();
    }
    haptic(6);
  }, { passive: true });
  document.addEventListener('touchcancel', () => { active = false; }, { passive: true });
}

function bindUI() {
  chat = new ChatView({
    container: $('#messages'),
    onEvent: {
      onRegenerate: (msg) => regenerate(msg),
      onSwitchVariant: (msg, direction) => switchMessageVariant(msg, direction),
      onSpeak: (msg) => speakMessage(msg),
      onEdit: (msg) => editMessage(msg),
      onMore: (msg) => moreMenu(msg),
      onFeedback: async () => { /* 仅本地记录 */ },
      onZoom: (src) => {
        const box = document.createElement('div');
        box.className = 'lightbox';
        box.innerHTML = `<img src="${esc(src)}" alt="">`;
        box.addEventListener('click', () => box.remove());
        document.body.appendChild(box);
      },
      onCite: (n) => {
        const node = $('.source-list');
        if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      },
      onOpenSource: (url) => {
        const a = document.createElement('a');
        a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.click();
      },
    },
  });

  sidebar = new Sidebar({
    root: $('#sidebar'),
    listEl: $('#session-list'),
    onSelect: (id) => switchSession(id),
    onMenu: (id) => sessionMenu(id),
    onNew: () => newSession(),
  });

  // 顶栏
  $('#btn-menu').addEventListener('click', openSidebar);
  bindSidebarDrag();
  bindMessageSwipe();
  bindEdgeSwipe();
  // 键盘弹出时保持输入区可见
  window.visualViewport?.addEventListener('resize', () => {
    if (document.activeElement && document.activeElement.id === 'input') {
      setTimeout(() => scrollToBottom($('#messages')), 80);
    }
  });
  $('#btn-sidebar-close')?.addEventListener('click', closeSidebar);
  $('#scrim').addEventListener('click', closeSidebar);
  $('#btn-model').addEventListener('click', () => openModelSheet(settingsCtx()));
  $('#btn-new').addEventListener('click', () => newSession());

  // 输入
  const input = $('#input');
  input.addEventListener('input', () => { autoGrow(input); updateChrome(); });
  input.addEventListener('focus', () => $('#composer').classList.add('focus'));
  input.addEventListener('blur', () => $('#composer').classList.remove('focus'));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      if (S.settings.enterToSend || !window.matchMedia('(pointer: coarse)').matches) {
        e.preventDefault();
        onSubmit();
      }
    }
  });
  $('#btn-send').addEventListener('click', onSubmit);
  $('#btn-attach').addEventListener('click', pickFiles);
  // 按住说话：按下开始录音，松手结束并自动发送；轻点则打开录音浮层手动确认
  let voiceHoldAt = 0;
  let voiceHeld = false;
  const voiceBtn = $('#btn-voice');
  voiceBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    voiceHeld = true;
    voiceHoldAt = Date.now();
    S.voiceAutoSend = true;
    startVoice();
  });
  const endHold = () => {
    if (!voiceHeld) return;
    voiceHeld = false;
    const held = Date.now() - voiceHoldAt;
    if (held < 350) {
      S.voiceAutoSend = false;
      return;
    }
    if (S.recorder && S.recorder.state === 'recording') finishVoice();
  };
  voiceBtn.addEventListener('pointerup', endHold);
  voiceBtn.addEventListener('pointercancel', () => { voiceHeld = false; S.voiceAutoSend = false; });
  voiceBtn.addEventListener('pointerleave', () => { if (voiceHeld) endHold(); });
  // 键盘/程序化触发（无 pointer 事件）时也能开始录音；按住流程不受影响
  voiceBtn.addEventListener('click', () => {
    const st = S.recorder?.state;
    if (st === 'recording' || st === 'starting' || st === 'stopping') return;
    S.voiceAutoSend = false;
    startVoice();
  });
  $('#rec-cancel').addEventListener('click', hideRecorder);
  $('#rec-done').addEventListener('click', finishVoice);

  // 能力开关（写入会话 + 全局默认）
  $('#btn-thinking').addEventListener('click', () => {
    const next = !effectiveSettings().thinking;
    S.settings.thinking = next;
    if (S.session) S.session.thinking = next;
    store.saveSettings({ thinking: next });
    syncToggles();
    haptic(6);
    toast(next ? '深度思考已开启' : '深度思考已关闭', { ms: 1200 });
  });
  $('#btn-websearch').addEventListener('click', () => {
    const next = !effectiveSettings().webSearch;
    S.settings.webSearch = next;
    if (S.session) S.session.webSearch = next;
    store.saveSettings({ webSearch: next });
    syncToggles();
    haptic(6);
    toast(next ? '联网搜索已开启' : '联网搜索已关闭', { ms: 1200 });
  });

  // 侧栏底部
  $('#btn-account').addEventListener('click', () => { closeSidebar(); openSettings(settingsCtx()); });
  $('#btn-call').addEventListener('click', () => startVoice());
  $('#btn-speaker').addEventListener('click', () => {
    const next = !S.settings.autoRead;
    store.saveSettings({ autoRead: next });
    S.settings = store.settings;
    syncSpeakerIcon();
    haptic(6);
    toast(next ? '回答后自动朗读已开启' : '回答后自动朗读已关闭', { ms: 1500 });
  });

  // 滚动
  const msgEl = $('#messages');
  msgEl.addEventListener('scroll', () => {
    const near = isNearBottom(msgEl, 240);
    $('#btn-scroll-bottom').hidden = near || msgEl.scrollTop < 40;
    $('#topbar').classList.toggle('scrolled', msgEl.scrollTop > 12 && !!S.session?.messages.length);
  }, { passive: true });
  $('#btn-scroll-bottom').addEventListener('click', () => scrollToBottom(msgEl, true));

  // 全局快捷键
  document.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
    if (meta && e.key.toLowerCase() === 'n') { e.preventDefault(); newSession(); }
    if (e.key === 'Escape') {
      if (S.streaming) stopStreaming();
      else if (!$('#sidebar').classList.contains('open') === false) closeSidebar();
      else if (S.tts?.busy) S.tts.stop();
    }
  });

  // Android 返回键：优先关闭浮层，其次是停止生成，最后交给原生
  window.__dsBack = () => {
    const layer = document.querySelector('.sheet-wrap, .modal-wrap');
    if (layer) { layer.querySelector('.sheet-mask, .modal-mask')?.click(); return true; }
    const panel = document.querySelector('.search-panel');
    if (panel) { panel.querySelector('[data-back]')?.click(); return true; }
    if (document.querySelector('.lightbox')) { document.querySelector('.lightbox').click(); return true; }
    const rec = document.querySelector('#recorder');
    if (rec && !rec.hidden) { hideRecorder(); return true; }
    const settingsPage = document.querySelector('.settings-page');
    if (settingsPage) { settingsPage.querySelector('[data-back]')?.click(); return true; }
    if (document.querySelector('#sidebar').classList.contains('open')) { closeSidebar(); return true; }
    if (S.tts?.busy) { S.tts.stop(); return true; }
    if (S.streaming) { stopStreaming(); return true; }
    return false;
  };

  /* Android 13+ 预测性返回：手势进行时实时预览浮层收起 */
  const backPreviewTarget = () => {
    const layer = document.querySelector('.sheet-wrap');
    if (layer) return { type: 'sheet', el: layer.querySelector('.sheet') || layer };
    const modal = document.querySelector('.modal-wrap');
    if (modal) return { type: 'sheet', el: modal.firstElementChild || modal };
    const panel = document.querySelector('.search-panel');
    if (panel) return { type: 'x', el: panel };
    const st = document.querySelector('.settings-page');
    if (st) return { type: 'x', el: st };
    const sb = $('#sidebar');
    if (sb && sb.classList.contains('open')) return { type: 'x', el: sb };
    return null;
  };
  window.__dsBackPrepare = () => {
    S.backPreview = backPreviewTarget();
    if (!S.backPreview) return;
    S.backPreview.el.style.transition = 'none';
  };
  window.__dsBackProgress = (p) => {
    const t = S.backPreview;
    if (!t) return;
    const q = Math.min(1, Math.max(0, Number(p) || 0));
    if (t.type === 'sheet') t.el.style.transform = `translateY(${t.el.offsetHeight * q}px)`;
    else t.el.style.transform = `translateX(${-t.el.offsetWidth * q}px)`;
  };
  window.__dsBackCancel = () => {
    const t = S.backPreview;
    if (!t) return;
    t.el.style.transition = '';
    t.el.style.transform = '';
    S.backPreview = null;
  };
  window.__dsBackInvoked = () => {
    const t = S.backPreview;
    S.backPreview = null;
    if (t) { t.el.style.transition = ''; t.el.style.transform = ''; }
    return window.__dsBack();
  };
  // 粘贴图片（桌面端截图）与拖拽文件上传，与官方 Demo 一致
  document.addEventListener('paste', (e) => {
    if (!S.booted) return;
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) {
      e.preventDefault();
      files.filter((f) => f.type.startsWith('image/')).forEach((f) => addAttachment(f));
    }
  });
  ['dragover', 'dragenter'].forEach((ev) => window.addEventListener(ev, (e) => {
    if (!S.booted) return;
    e.preventDefault();
    document.body.classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'dragleave' && e.relatedTarget) return;
    document.body.classList.remove('dragging');
    if (ev === 'drop' && e.dataTransfer?.files?.length) {
      e.dataTransfer.files.forEach?.((f) => addAttachment(f)) || Array.from(e.dataTransfer.files).forEach((f) => addAttachment(f));
    }
  }));
  window.addEventListener('online', () => toast('网络已恢复', { type: 'success' }));
  window.addEventListener('offline', () => toast('网络已断开', { type: 'error' }));

  // 站点图标加载失败时隐藏（CSP 禁止内联 onerror，改用捕获阶段代理）
  document.addEventListener('error', (e) => {
    const el = e.target;
    if (el && el.tagName === 'IMG' && el.classList.contains('ts-fav')) {
      el.style.visibility = 'hidden';
    }
  }, true);

  // 移动端键盘弹出时保持输入区可见
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      document.documentElement.style.setProperty('--app-h', `${window.visualViewport.height}px`);
      if (document.activeElement === $('#input')) slowScrollBottom();
    });
  }
}

/* -------------------------------- 启动 --------------------------------- */

async function loadSessions() {
  try {
    S.sessions = await store.listSessions();
  } catch {
    S.sessions = [];
  }
  const wantSeed = new URLSearchParams(location.search).get('seed');
  if (wantSeed) {
    const demo = buildDemoSession();
    if (!S.sessions.some((s) => s.id === demo.id)) {
      S.sessions.unshift(demo);
      await store.saveSession(demo);
    }
    S.session = S.sessions.find((s) => s.id === demo.id) || demo;
  }
}

async function enterMain({ silent = false } = {}) {
  $('#login').hidden = true;
  $('#main').hidden = false;
  S.client = (S.native && S.demoMode) ? createMockClient() : createClient({ key: S.envKey ? '' : S.key, direct: S.native });
  initTTS();
  if (!S.booted) {
    bindUI();
    renderSuggestions();
    S.booted = true;
    syncSpeakerIcon();
  }
  await loadSessions();
  if (S.session) {
    ensureSessionReminders(S.session);
    chat.setSession(S.session);
  } else {
    chat.setSession(null);
  }
  updateChrome();
  sidebar.render(S.sessions, S.session?.id);
  if (!silent) { /* 登录成功后不额外提示 */ }
  refreshBalance(false);
  applySettingsAfterLogin();
  applyEdgeSwipeSetting();
  handleDeepLinkScreen();
  registerSW();
}

function applySettingsAfterLogin() {
  const s = S.settings;
  if (s.fontSize) document.documentElement.dataset.font = s.fontSize;
}

function handleDeepLinkScreen() {
  const p = new URLSearchParams(location.search);
  const screen = p.get('screen');
  if (!screen) return;
  setTimeout(() => {
    if (screen === 'settings') openSettings(settingsCtx());
    else if (screen === 'model') openModelSheet(settingsCtx());
    else if (screen === 'sidebar') openSidebar();
    else if (screen === 'search') openSearch();
    else if (screen === 'new') newSession();
    else if (screen === 'reader') openReader({ getClient: () => S.client, onAsk: async () => {} }, { url: 'https://api-docs.deepseek.com/', title: 'DeepSeek API Docs' });
  }, 400);
}

function registerSW() {
  if (!S.native && 'serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* 离线能力可选 */ });
  }
}

async function boot() {
  if (S.booting || S.booted) return;
  S.booting = true;
  installViewportFix();
  document.documentElement.dataset.font = store.ui.fontSize || 'm';

  if (isNativeShell() || S.directWeb) {
    const note = $('#login-note');
    if (note) {
      note.innerHTML = isNativeShell()
        ? '密钥只保存在本机；APK 直连 <code>api.deepseek.com</code>，按开放平台价格从你的额度扣费。'
        : '密钥只保存在本机；网页直连 <code>api.deepseek.com</code>（CORS），按开放平台价格从你的额度扣费。';
    }
  }
  $('#boot-error').hidden = true;
  window.addEventListener('error', (e) => {
    const box = $('#boot-error');
    if (!box) return;
    box.hidden = false;
    box.textContent = `运行出错：${e.message || '未知错误'}`;
  });

  await store.init();
  S.settings = store.settings;
  applyTheme();

  const params = new URLSearchParams(location.search);
  if (params.get('theme')) { S.settings.theme = params.get('theme'); applyTheme(); }
  if (params.get('font')) { S.settings.fontSize = params.get('font'); applyTheme(); }

  // 登录页按钮（先绑定，避免服务未就绪时无法点击）
  $('#login-paste').addEventListener('click', async () => {
    try {
      const text = S.native ? (window.DSAndroid?.readClipboard?.() || '') : await navigator.clipboard.readText();
      if (text) { $('#login-key').value = text.trim(); toast('已粘贴'); }
      else toast('剪贴板为空');
    } catch {
      toast('浏览器不允许读取剪贴板，请长按输入框粘贴', { type: 'error' });
    }
  });
  $('#login-submit').addEventListener('click', async () => {
    const key = $('#login-key').value.trim();
    if (!key) { setLoginStatus('请先填写 API Key', 'error'); return; }
    if (key.length < 20) { setLoginStatus('密钥长度不对，请检查是否复制完整', 'error'); return; }
    await validateAndEnter({ key });
  });
  $('#login-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#login-submit').click(); });
  $('#login-env').addEventListener('click', () => validateAndEnter({ fromEnv: true }));
  $('#login-demo').addEventListener('click', enterDemo);

  // 服务端信息（决定一键登录按钮与演示模式）
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    S.serverInfo = (S.native || S.directWeb)
      ? await createClient({ key: '', direct: true }).serverInfo()
      : await createClient({ key: '' }).serverInfo({ signal: controller.signal });
    clearTimeout(timer);
  } catch {
    S.serverInfo = null;
  }
  if (S.serverInfo?.mock) $('#login-demo').hidden = false;
  $('#login-foot-note')?.remove();

  const demoParam = params.get('demo');
  if (demoParam === '1') S.demoMode = true;
  if (params.get('seed') === '1') S.demoMode = true;
  if (S.demoMode) S.key = 'sk-demo-mode-not-real';

  const savedKey = store.getKey();
  const envKey = !!S.serverInfo?.hasEnvKey;

  if (S.demoMode) {
    await enterMain({ silent: true });
    return;
  }

  if (savedKey) {
    $('#login-status').innerHTML = '<span class="spinner"></span>检测到已保存的密钥，正在连接…';
    $('#login').hidden = false;
    $('#main').hidden = true;
    try {
      await validateAndEnter({ key: savedKey });
    } catch { showLogin('自动登录失败，请重新输入密钥'); }
    return;
  }

  if (envKey) {
    showLogin();
    await validateAndEnter({ fromEnv: true });
    return;
  }

  showLogin();
  if (!S.serverInfo) {
    setLoginStatus('未连接到本机服务：请运行 <code>node server.mjs</code> 后用电脑显示的地址打开。', 'error');
  }
}

/* PWA 安装提示 */
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  S.installedPrompt = e;
});

document.addEventListener('DOMContentLoaded', boot);
if (document.readyState !== 'loading') boot();
