/* =========================================================================
 * settings.js —— 设置（整页，对齐官方 2.8：灰色底 + 分组白卡 + 二级页）
 * ========================================================================= */

import { esc, icon, toast, confirmDialog, promptDialog, formatNumber, openSheet } from './ui.js';
import { estimateTokens } from './tokens.js';
import { PROMPT_PRESETS, normalizePrompts, addPrompt, updatePrompt, removePrompt, movePrompt } from './prompts.js';

const I = {
  user: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="8.4" r="3.6"/><path d="M4.8 20c1.2-3.4 3.9-5 7.2-5s6 1.6 7.2 5"/></svg>',
  data: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6"/><path d="M5 12v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6v-6"/></svg>',
  globe: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="8.2"/><path d="M3.8 12h16.4M12 3.8c2.2 2.4 3.4 5.1 3.4 8.2s-1.2 5.8-3.4 8.2c-2.2-2.4-3.4-5.1-3.4-8.2s1.2-5.8 3.4-8.2Z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.6v2M12 19.4v2M2.6 12h2M19.4 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/></svg>',
  type: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 6.5V5h14v1.5M12 5v14M8.6 19h6.8"/></svg>',
  palette: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 3.4a8.6 8.6 0 1 0 0 17.2c1.4 0 2-.9 2-1.9 0-1.4-1.3-1.7-1.3-2.9 0-1 .8-1.7 1.9-1.7h1.9a3.9 3.9 0 0 0 3.9-3.9c0-3.8-3.8-6.8-8.4-6.8Z"/><circle cx="8" cy="10" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="7.6" r="1.1" fill="currentColor" stroke="none"/><circle cx="16" cy="9.6" r="1.1" fill="currentColor" stroke="none"/></svg>',
  voice: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M11 5 6.5 9H3.5v6h3L11 19V5Z"/><path d="M15.4 8.6a5 5 0 0 1 0 6.8M18 6.2a8.6 8.6 0 0 1 0 11.6"/></svg>',
  brain: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M9.5 4.4a3 3 0 0 0-3 3 3 3 0 0 0-1.5 5.6A3 3 0 0 0 8 18.6h1.5V4.4Z"/><path d="M14.5 4.4a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.6A3 3 0 0 1 16 18.6h-1.5V4.4Z"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 3.4c1.5 2.5 3 4 5.5 5.5-2.5 1.5-4 3-5.5 5.5-1.5-2.5-3-4-5.5-5.5 2.5-1.5 4-3 5.5-5.5Z"/><path d="M17.5 15.4c.7 1.2 1.4 1.9 2.6 2.6-1.2.7-1.9 1.4-2.6 2.6-.7-1.2-1.4-1.9-2.6-2.6 1.2-.7 1.9-1.4 2.6-2.6Z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 3.2 4.8 6v5.4c0 4.4 3 7.6 7.2 9.4 4.2-1.8 7.2-5 7.2-9.4V6Z"/><path d="m9.2 12.2 2 2 3.6-3.8"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="8.4"/><path d="M12 11v5.2M12 8h.01"/></svg>',
  help: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="8.4"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.3c-.8.4-1.2.9-1.2 1.7v.4M12 16.6h.01"/></svg>',
  logout: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M14 4.6H6.6a1.8 1.8 0 0 0-1.8 1.8v11.2a1.8 1.8 0 0 0 1.8 1.8H14"/><path d="M16.5 8.4 20 12l-3.5 3.6M20 12h-8.4"/></svg>',
  chev: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="m14.5 6-6 6 6 6"/></svg>',
  key: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="8" cy="15.6" r="4"/><path d="m11 12.6 8-8M16.4 4.6l3 3M14.2 6.8l3 3"/></svg>',
};

const MODELS = [
  { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', desc: '响应快、价格低，支持图片理解', icon: 'sparkle' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', desc: '更强推理与写作，不支持图片', icon: 'brain' },
];
const EFFORTS = [{ id: 'low', label: 'low' }, { id: 'high', label: 'high' }, { id: 'max', label: 'max' }];
const VOICES = [{ id: 'stella', label: 'Stella · 女声' }, { id: 'tide', label: 'Tide · 男声' }];
const THEMES = [{ id: 'auto', label: '跟随系统' }, { id: 'light', label: '浅色' }, { id: 'dark', label: '深色' }];
const FONTS = [{ id: 's', label: '小' }, { id: 'm', label: '标准' }, { id: 'l', label: '大' }];
const PRESETS = [
  { name: '默认助手（不设置）', value: '' },
  { name: '严谨技术', value: '你是严谨的技术助手。先给结论，再给关键步骤；不确定时明确说明，不要编造。涉及代码请给出可运行示例并标注语言。' },
  { name: '简洁口语', value: '回答尽量简短、口语化，默认不超过三句话，除非用户明确要求展开。避免客套和重复。' },
  { name: '代码伙伴', value: '你是资深软件工程师。先说明思路，再给完整可运行代码；指出边界情况与常见坑。' },
  { name: '翻译润色', value: '你是中英双语编辑。保持原意与语气，输出书面、准确、自然的中文；术语首次出现时保留英文原文。' },
  { name: '面试官', value: '你是严格但友善的技术面试官。围绕回答追问原理与取舍，每次只问一个问题，最后给出评价与改进建议。' },
];

const LANGS = ['中文', '中文繁體', '中文香港', 'English', '日本語', '한국어', 'Français', 'Deutsch', 'Español', 'Русский', 'العربية'];
const LOCS = ['上海', '北京', '深圳', '广州', '杭州', '成都', '香港', '台北', '新加坡', '东京', '伦敦', '纽约', ''];

function sw(id, on) {
  return `<button class="switch" id="${id}" role="switch" aria-checked="${on ? 'true' : 'false'}"></button>`;
}

export function maskKey(key) {
  if (!key) return '未配置';
  const k = key.trim();
  if (k.length <= 10) return '••••••';
  return `${k.slice(0, 5)}••••••••${k.slice(-4)}`;
}

export function openSettings(ctx) {
  const root = document.getElementById('overlay-root');
  const page = document.createElement('div');
  page.className = 'settings-page';
  page.innerHTML = `
    <div class="settings-head">
      <button class="settings-back" data-back aria-label="返回">${I.back}</button>
      <div class="settings-title" id="st-title">设置</div>
    </div>
    <div class="settings-body" id="st-body"></div>
  `;
  root.appendChild(page);

  const body = page.querySelector('#st-body');
  const title = page.querySelector('#st-title');
  const stack = [{ id: 'main', title: '设置' }];

  const s = () => ctx.settings();
  const save = (patch) => { ctx.saveSettings(patch); ctx.applySettings(); };
  const swBind = (id, key) => {
    const el = body.querySelector(`#${id}`);
    if (!el) return;
    el.addEventListener('click', () => {
      const next = !s()[key];
      save({ [key]: next });
      el.setAttribute('aria-checked', String(next));
      if (key === 'autoRead') ctx.syncSpeakerIcon();
    });
  };

  const goBack = () => {
    stack.pop();
    if (!stack.length) { close(); return; }
    render();
  };
  const close = () => { page.style.opacity = '0'; setTimeout(() => page.remove(), 160); };
  page.querySelector('[data-back]').addEventListener('click', goBack);
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { goBack(); }
    if (!page.isConnected) document.removeEventListener('keydown', onKey);
  });

  /* ------------------------------ 页面渲染 ------------------------------ */
  const render = () => {
    const cur = stack[stack.length - 1];
    title.textContent = cur.title;
    if (cur.id === 'main') renderMain();
    else if (cur.id === 'account') renderAccount();
    else if (cur.id === 'data') renderData();
    else if (cur.id === 'theme') renderTheme();
    else if (cur.id === 'font') renderFont();
    else if (cur.id === 'lang') renderLang();
    else if (cur.id === 'region') renderRegion();
    else if (cur.id === 'effort') renderEffort();
    else if (cur.id === 'voice') renderVoice();
    else if (cur.id === 'about') renderAbout();
    else if (cur.id === 'system') renderSystem();
    else if (cur.id === 'prompts') renderPrompts();
    else if (cur.id === 'model') renderModel();
    else if (cur.id === 'memory') renderMemory();
    else if (cur.id === 'usage') renderUsage();
    bindCommon();
  };

  const push = (id, t) => { stack.push({ id, title: t }); render(); };

  const rowLink = ({ ico, name, desc, value, go, act, danger }) => `
    <button class="set-row ${danger ? 'danger' : ''}" ${act ? `data-act="${act}"` : ''} ${go ? `data-go="${go}"` : ''}>
      ${ico ? `<span class="row-ico">${I[ico] || ''}</span>` : ''}
      <span class="row-main">
        <span class="row-name">${esc(name)}</span>
        ${desc ? `<span class="row-desc">${esc(desc)}</span>` : ''}
      </span>
      ${value ? `<span class="row-value">${esc(value)}</span>` : ''}
      ${go || act ? `<span class="row-chev">${I.chev}</span>` : ''}
    </button>`;

  const rowSwitch = ({ ico, name, desc, id, on }) => `
    <div class="set-row">
      ${ico ? `<span class="row-ico">${I[ico] || ''}</span>` : ''}
      <span class="row-main">
        <span class="row-name">${esc(name)}</span>
        ${desc ? `<span class="row-desc">${esc(desc)}</span>` : ''}
      </span>
      ${sw(id, on)}
    </div>`;

  const optionRows = (id, options, curValue) => options.map((o) => `
    <button class="option-row" data-opt="${esc(o.id)}">
      <span>${esc(o.label)}</span>
      ${o.id === curValue ? `<span class="check">${icon('check', { size: 18 })}</span>` : ''}
    </button>`).join('');

  function renderMain() {
    const st = s();
    const bal = ctx.getBalance();
    const modelName = st.model === 'deepseek-v4-pro' ? 'DeepSeek V4 Pro' : 'DeepSeek V4.1 Flash';
    body.innerHTML = `
      <div class="group-label">账户</div>
      <div class="group-card">
        ${rowLink({ ico: 'user', name: '账号管理', value: bal ? `${bal.currency === 'USD' ? '$' : '¥'}${bal.total}` : '', go: 'account' })}
        ${rowLink({ ico: 'data', name: '数据管理', go: 'data' })}
        ${rowLink({ ico: 'data', name: '用量统计', desc: 'token / 缓存 / 语音 / 费用', value: '累计', go: 'usage' })}
      </div>

      <div class="group-label">应用</div>
      <div class="group-card">
        ${rowLink({ ico: 'globe', name: '语言', value: st.language, go: 'lang' })}
        ${rowLink({ ico: 'sun', name: '外观', value: (THEMES.find((t) => t.id === st.theme) || THEMES[0]).label, go: 'theme' })}
        ${rowLink({ ico: 'type', name: '字体大小', value: (FONTS.find((f) => f.id === st.fontSize) || FONTS[1]).label, go: 'font' })}
        ${rowLink({ ico: 'palette', name: '个性化', value: st.haptics ? '触感开启' : '触感关闭', go: 'theme' })}
      </div>

      <div class="group-label">语音</div>
      <div class="group-card">
        ${rowLink({ ico: 'voice', name: '朗读音色', value: (VOICES.find((v) => v.id === st.ttsVoice) || VOICES[0]).label, go: 'voice' })}
        ${rowSwitch({ ico: 'voice', name: '回答后自动朗读', id: 'st-autoRead', on: st.autoRead })}
      </div>

      <div class="group-label">对话</div>
      <div class="group-card">
        ${rowLink({ ico: 'sparkle', name: '模型', value: modelName, go: 'model' })}
        ${rowSwitch({ ico: 'brain', name: '深度思考', id: 'st-thinking', on: st.thinking })}
        ${rowLink({ ico: 'brain', name: '思考强度', value: (EFFORTS.find((e) => e.id === st.effort) || EFFORTS[1]).label, go: 'effort' })}
        ${rowSwitch({ ico: 'globe', name: '智能搜索', desc: '服务端检索，检索本身不计费', id: 'st-webSearch', on: st.webSearch })}
        ${rowSwitch({ ico: 'shield', name: '内容安全审核', desc: '输入输出经平台风险审核', id: 'st-safety', on: st.safety })}
        ${rowLink({ ico: 'sparkle', name: '提示词', desc: '有序提示词块，随每次请求发送', value: `${(st.prompts || []).filter((p) => p.enabled).length}/${(st.prompts || []).length}`, go: 'prompts' })}
        ${rowLink({ ico: 'user', name: '记忆', desc: '长期偏好，作为 system 注入每次请求', value: `${(st.memories || []).filter((m) => m.enabled).length}/${(st.memories || []).length}`, go: 'memory' })}
      </div>

      <div class="group-label">关于</div>
      <div class="group-card">
        ${rowLink({ ico: 'info', name: '版本', value: `v${ctx.getVersion()}`, go: 'about' })}
        ${rowLink({ ico: 'help', name: '帮助与反馈', value: 'API 文档 / 用量', act: 'docs' })}
      </div>

      <div class="settings-footer-card">
        <button class="set-row danger" data-act="logout">
          <span class="row-main"><span class="row-name">退出登录</span></span>
        </button>
      </div>
      <div class="settings-version">DeepSeek 随身版 · ${ctx.isNative() ? 'Android APK' : ctx.isDirectWeb?.() ? 'Web 直连' : 'Web 代理'} · ${ctx.getBackend()}</div>
    `;
  }

  function renderAccount() {
    const bal = ctx.getBalance();
    const sym = bal?.currency === 'USD' ? '$' : '¥';
    body.innerHTML = `
      <div class="group-card" style="margin-top:18px">
        <div class="balance-line">
          <strong>${bal ? `${sym}${bal.total}` : '—'}</strong>
          <span>${bal ? `可用 · 赠送 ${sym}${bal.granted}` : '点击下方刷新额度'}</span>
        </div>
      </div>
      <div class="group-card" style="margin-top:14px">
        ${rowLink({ ico: 'key', name: 'API Key', value: ctx.isDemo() ? '离线演示' : maskKey(ctx.getKey()), act: 'change-key' })}
        ${rowLink({ ico: 'info', name: '登录方式', value: ctx.isDemo() ? '演示模式' : ctx.isEnvKey() ? '本机预置' : '手动输入' })}
        ${rowLink({ ico: 'user', name: '昵称', value: ctx.getNickname(), act: 'nickname' })}
      </div>
      <div class="group-card" style="margin-top:14px">
        ${rowLink({ ico: 'info', name: '刷新额度', act: 'refresh-bal' })}
        ${rowLink({ ico: 'help', name: '用量与账单', act: 'usage' })}
      </div>
      <div class="settings-version">密钥只保存在本机，不上传任何服务器</div>
    `;
  }

  function renderData() {
    body.innerHTML = `
      <div class="group-card" style="margin-top:18px">
        ${rowLink({ ico: 'data', name: '导出全部对话', desc: 'JSON 文件，可备份到其它设备', act: 'export' })}
        ${rowLink({ ico: 'data', name: '导入对话', desc: '导入后替换当前全部对话', act: 'import' })}
        ${rowLink({ ico: 'data', name: '清空全部对话', desc: '不可恢复', act: 'clear', danger: true })}
        ${rowLink({ ico: 'data', name: '上下文窗口', desc: '超出 82% 自动裁剪较早消息', value: '1M tokens' })}
      </div>
      <div class="settings-version">存储位置：${ctx.getBackend()} · 不经过任何服务器</div>
    `;
  }

  function renderTheme() {
    const st = s();
    body.innerHTML = `
      <div class="group-card" style="margin-top:18px">
        ${optionRows('theme', THEMES, st.theme)}
      </div>
      <div class="group-label">个性化</div>
      <div class="group-card">
        ${rowSwitch({ ico: 'palette', name: '触感反馈', desc: '轻点按钮时振动', id: 'st-haptics', on: st.haptics })}
      </div>`;
  }

  function renderFont() {
    body.innerHTML = `<div class="group-card" style="margin-top:18px">${optionRows('font', FONTS, s().fontSize)}</div>`;
  }

  function renderLang() {
    body.innerHTML = `<div class="group-card" style="margin-top:18px">
      ${LANGS.map((l) => `<button class="option-row" data-lang="${esc(l)}"><span>${esc(l)}</span>${l === s().language ? `<span class="check">${icon('check', { size: 18 })}</span>` : ''}</button>`).join('')}
    </div>
    <div class="settings-version">随每条消息作为 latest_reminder 发送</div>`;
  }

  function renderRegion() {
    body.innerHTML = `<div class="group-card" style="margin-top:18px">
      ${LOCS.map((l) => `<button class="option-row" data-loc="${esc(l)}"><span>${esc(l || '不设置')}</span>${l === s().location ? `<span class="check">${icon('check', { size: 18 })}</span>` : ''}</button>`).join('')}
    </div>`;
  }

  function renderEffort() {
    body.innerHTML = `<div class="group-card" style="margin-top:18px">${optionRows('effort', EFFORTS, s().effort)}</div>
      <div class="settings-version">强度越高，推理步数越多，token 消耗也越高</div>`;
  }

  function renderVoice() {
    const st = s();
    body.innerHTML = `
      <div class="group-card" style="margin-top:18px">
        ${rowSwitch({ ico: 'voice', name: '回答后自动朗读', id: 'st-autoRead', on: st.autoRead })}
      </div>
      <div class="group-label">音色</div>
      <div class="group-card">${optionRows('voice', VOICES, st.ttsVoice)}</div>
      <div class="group-label">语速</div>
      <div class="group-card"><div class="field-row">
        <input class="input" id="st-rate" type="range" min="0.6" max="1.6" step="0.1" value="${st.ttsRate}" style="border:0;padding:0" />
        <span class="row-value" id="st-rate-v">${st.ttsRate.toFixed(1)}x</span>
      </div></div>
      <div class="group-card" style="margin-top:14px">
        ${rowLink({ ico: 'voice', name: '试听', act: 'preview-tts' })}
      </div>`;
  }

  function renderSystem() {
    const cur = String(s().systemPrompt || "");
    body.innerHTML = `
      <div class="group-card" style="margin-top:18px">
        <div style="padding:14px 16px 4px">
          <textarea class="input" id="sp-input" rows="7" placeholder="例如：你是严谨的中文技术助手，先给结论再给要点，避免客套话。" style="height:auto;min-height:158px;padding:12px 14px;line-height:1.65;resize:vertical">${esc(cur)}</textarea>
          <div class="row-desc" style="display:flex;justify-content:space-between;padding:8px 2px 12px">
            <span>作为 system 消息随每次请求发送，对所有对话生效</span>
            <span id="sp-count">${cur.length} 字</span>
          </div>
        </div>
        <button class="set-row" id="sp-save"><span class="row-main"><span class="row-name" style="color:var(--brand);font-weight:600">保存</span></span></button>
      </div>
      <div class="group-label">快捷模板</div>
      <div class="group-card">
        ${PRESETS.map((p, i) => `<button class="option-row" data-preset="${i}">
          <span>${esc(p.name)}</span><span class="row-chev">${I.chev}</span>
        </button>`).join("")}
      </div>
      <div class="group-card" style="margin-top:14px">
        ${rowLink({ ico: "info", name: "清空提示词", desc: "恢复为未设置状态", act: "clear-sys" })}
      </div>
      <div class="settings-version">提示词只保存在本机，不经过任何服务器</div>`;
  }

  function renderUsage() {
    const u = ctx.getUsage();
    const money = (v) => (v < 0.01 ? `<$0.01` : `${v.toFixed(3)}`);
    const tok = (v) => (v < 1000 ? String(v) : v < 1e6 ? `${(v / 1000).toFixed(1)}K` : `${(v / 1e6).toFixed(2)}M`);
    body.innerHTML = `
      <div class="group-label">对话</div>
      <div class="group-card">
        <div class="set-row"><span class="row-main"><span class="row-name">输入 tokens</span></span><span class="row-value">${tok(u.promptTokens)}</span></div>
        <div class="set-row"><span class="row-main"><span class="row-name">输出 tokens</span></span><span class="row-value">${tok(u.completionTokens)}</span></div>
        <div class="set-row"><span class="row-main"><span class="row-name">缓存命中</span><span class="row-desc">命中 ${tok(u.cacheHitTokens)} / 输入 ${tok(u.promptTokens)}</span></span><span class="row-value">${(u.cacheRate * 100).toFixed(1)}%</span></div>
        <div class="set-row"><span class="row-main"><span class="row-name">请求数</span></span><span class="row-value">${u.requests}</span></div>
        <div class="set-row"><span class="row-main"><span class="row-name">模型费用</span><span class="row-desc">按非高峰价估算</span></span><span class="row-value">≈${money(u.modelCost)}</span></div>
      </div>
      <div class="group-label">语音</div>
      <div class="group-card">
        <div class="set-row"><span class="row-main"><span class="row-name">朗读合成</span><span class="row-desc">按计费字符（中文 2 / 其他 1），$0.45 每万字</span></span><span class="row-value">${u.ttsChars} 字 · ≈${money(u.ttsCost)}</span></div>
        <div class="set-row"><span class="row-main"><span class="row-name">语音识别</span><span class="row-desc">$0.116 每小时</span></span><span class="row-value">${u.asrSeconds.toFixed(1)} 秒 · ≈${money(u.asrCost)}</span></div>
      </div>
      <div class="group-card" style="margin-top:14px">
        <div class="set-row"><span class="row-main"><span class="row-name" style="font-weight:600">累计估算费用</span></span><span class="row-value" style="font-weight:600;color:var(--text)">≈${money(u.totalCost)}</span></div>
      </div>
      <div class="group-card" style="margin-top:14px">
        ${rowLink({ ico: "info", name: "清空统计", desc: "只清本地统计，不影响对话", act: "clear-usage" })}
      </div>
      <div class="settings-version">统计只保存在本机；费用为估算，实际以开放平台账单为准</div>`;
  }

  function renderPrompts() {
    const list = ctx.getPrompts();
    const enabled = list.filter((p) => p.enabled);
    const tokens = estimateTokens(enabled.map((p) => p.content).join('\n'));
    body.innerHTML = `
      <div class="group-label">提示词块 · ${enabled.length}/${list.length} 启用 · ≈${tokens} tokens</div>
      <div class="group-card">
        ${list.map((p, i) => `
          <div class="prompt-item ${p.enabled ? 'on' : ''}">
            <button class="prompt-toggle" data-pact="toggle" data-id="${p.id}" aria-pressed="${p.enabled}" aria-label="启用"></button>
            <button class="prompt-body" data-pact="edit" data-id="${p.id}">
              <span class="row-name">${esc(p.name)}<span class="prompt-role">${p.role}</span></span>
              <span class="row-desc">${esc(p.content.slice(0, 80) || '（空）')}</span>
            </button>
            <span class="prompt-side">
              <button class="prompt-mini" data-pact="up" data-id="${p.id}" ${i === 0 ? 'disabled' : ''} aria-label="上移">↑</button>
              <button class="prompt-mini" data-pact="down" data-id="${p.id}" ${i === list.length - 1 ? 'disabled' : ''} aria-label="下移">↓</button>
              <button class="prompt-mini del" data-pact="del" data-id="${p.id}" aria-label="删除">×</button>
            </span>
          </div>`).join('')}
      </div>
      <button class="settings-add" data-pact="add">＋ 新增提示词块</button>
      <div class="group-label">预设</div>
      <div class="group-card">
        ${PROMPT_PRESETS.map((pr) => `
          <button class="set-row" data-pact="preset" data-id="${pr.id}">
            <span class="row-main"><span class="row-name">${esc(pr.name)}</span></span><span class="row-value">${pr.prompts.length} 个块</span>
            <span class="row-chev">${I.chev}</span>
          </button>`).join('')}
      </div>
      <div class="settings-version">按顺序发送；相邻 system 块会合并为一条消息</div>`;

    body.querySelectorAll('[data-pact]').forEach((el) => el.addEventListener('click', async () => {
      const pact = el.dataset.pact;
      const id = el.dataset.id;
      let list = ctx.getPrompts();
      if (pact === 'toggle') {
        const cur = list.find((p) => p.id === id);
        if (cur) list = updatePrompt(list, id, { enabled: !cur.enabled });
      } else if (pact === 'up') list = movePrompt(list, id, -1);
      else if (pact === 'down') list = movePrompt(list, id, 1);
      else if (pact === 'del') {
        const ok = await confirmDialog({ title: '删除这个提示词块？', okText: '删除', danger: true });
        if (!ok) return;
        list = removePrompt(list, id);
      } else if (pact === 'add') {
        list = addPrompt(list, { name: '新提示词', content: '' });
      } else if (pact === 'edit') {
        const cur = list.find((p) => p.id === id);
        if (!cur) return;
        const name = await promptDialog({ title: '块名称', value: cur.name });
        if (name !== null) list = updatePrompt(list, id, { name });
        const content = await promptDialog({ title: '提示词内容', value: cur.content, multiline: true, okText: '保存' });
        if (content !== null) list = updatePrompt(list, id, { content });
      } else if (pact === 'preset') {
        const pr = PROMPT_PRESETS.find((x) => x.id === id);
        if (!pr) return;
        const ok = await confirmDialog({ title: `应用「${pr.name}」预设？`, message: '会替换当前全部提示词块', okText: '应用' });
        if (!ok) return;
        list = normalizePrompts(pr.prompts.map((p) => ({ ...p })));
      }
      ctx.setPrompts(list);
      render();
    }));
  }

  function renderModel() {
    const st = ctx.settings();
    const cur = ctx.sessionModel();
    body.innerHTML = `
      <div class="group-label">模型（仅影响当前对话）</div>
      <div class="group-card">
        ${MODELS.map((m) => `
          <button class="set-row" data-pick="${m.id}">
            <span class="row-ico">${icon(m.icon === 'brain' ? 'brain' : 'sparkle', { size: 20 })}</span>
            <span class="row-main"><span class="row-name">${esc(m.name)}</span><span class="row-desc">${esc(m.desc)}</span></span>
            ${cur === m.id ? `<span class="row-value">${icon('check', { size: 18 })}</span>` : ''}
          </button>`).join('')}
      </div>
      <div class="group-label">本轮能力</div>
      <div class="group-card">
        ${rowSwitch({ ico: 'brain', name: '深度思考', id: 'md-thinking', on: st.thinking })}
        ${rowSwitch({ ico: 'globe', name: '智能搜索', id: 'md-websearch', on: st.webSearch })}
      </div>
      <div class="settings-version">模型按会话记忆，新对话继承上次选择；能力开关与模型解耦</div>`;
    body.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', async () => {
      await ctx.setSessionModel(b.dataset.pick);
      render();
    }));
    swBind('md-thinking', 'thinking');
    swBind('md-websearch', 'webSearch');
  }

  function renderMemory() {
    const list = ctx.getMemories();
    const enabled = list.filter((m) => m.enabled).length;
    body.innerHTML = `
      <div class="group-label">长期记忆 · ${enabled}/${list.length} 启用</div>
      <div class="group-card">
        ${list.length ? list.map((m) => `
          <div class="prompt-item ${m.enabled ? 'on' : ''}">
            <button class="prompt-toggle" data-mem="toggle" data-id="${m.id}" aria-pressed="${m.enabled}" aria-label="启用"></button>
            <button class="prompt-body" data-mem="edit" data-id="${m.id}"><span class="row-name">${esc(m.text)}</span></button>
            <span class="prompt-side"><button class="prompt-mini del" data-mem="del" data-id="${m.id}" aria-label="删除">×</button></span>
          </div>`).join('') : '<div class="set-row"><span class="row-main"><span class="row-desc">还没有记忆。添加后会在每次请求里作为 system 消息注入。</span></span></div>'}
      </div>
      <button class="settings-add" data-mem="add">＋ 添加记忆</button>
      <div class="settings-version">记忆只保存在本机；关闭开关后不注入；适合写称呼、城市、职业、回答偏好</div>`;
    body.querySelectorAll('[data-mem]').forEach((el) => el.addEventListener('click', async () => {
      const act = el.dataset.mem;
      const id = el.dataset.id;
      if (act === 'add') {
        const text = await promptDialog({ title: '添加记忆', placeholder: '例如：我在上海，偏好简洁的中文回答', multiline: true, okText: '保存' });
        if (text) { ctx.addMemory(text); render(); }
      } else if (act === 'edit') {
        const cur = list.find((m) => m.id === id);
        if (!cur) return;
        const text = await promptDialog({ title: '编辑记忆', value: cur.text, multiline: true, okText: '保存' });
        if (text !== null) { ctx.updateMemory(id, { text }); render(); }
      } else if (act === 'toggle') {
        const cur = list.find((m) => m.id === id);
        if (cur) { ctx.updateMemory(id, { enabled: !cur.enabled }); render(); }
      } else if (act === 'del') {
        const ok = await confirmDialog({ title: '删除这条记忆？', okText: '删除', danger: true });
        if (ok) { ctx.removeMemory(id); render(); }
      }
    }));
  }

  function renderAbout() {
    const info = ctx.getServerInfo?.() || {};
    body.innerHTML = `
      <div class="group-card" style="margin-top:18px">
        ${rowLink({ ico: 'info', name: '版本', value: `v${ctx.getVersion()}` })}
        ${rowLink({ ico: 'info', name: '运行形态', value: ctx.isNative() ? 'Android APK' : ctx.isDirectWeb?.() ? '网页直连' : '浏览器 + 代理' })}
        ${rowLink({ ico: 'info', name: '接口地址', value: 'api.deepseek.com' })}
        ${rowLink({ ico: 'info', name: '模型名称', value: 'Deepseek Chat' })}
      </div>
      <div class="group-card" style="margin-top:14px">
        ${rowLink({ ico: 'help', name: '开放平台 API 文档', act: 'docs' })}
        ${rowLink({ ico: 'help', name: '查看用量与账单', act: 'usage' })}
        ${rowLink({ ico: 'shield', name: '内容安全与隐私', act: 'privacy' })}
      </div>
      <div class="settings-version">内容由 AI 生成，请仔细甄别 · MIT</div>`;
  }

  /* ------------------------------ 事件绑定 ------------------------------ */
  const bindCommon = () => {
    body.querySelectorAll('[data-go]').forEach((el) => el.addEventListener('click', () => {
      const id = el.dataset.go;
      const titles = { account: '账号管理', data: '数据管理', theme: '外观', font: '字体大小', lang: '语言', region: '地区', effort: '思考强度', voice: '语音', about: '关于', system: '系统提示词', usage: '用量统计', prompts: '提示词', model: '模型', memory: '记忆' };
      push(id, titles[id] || '设置');
    }));

    swBind('st-thinking', 'thinking');
    swBind('st-webSearch', 'webSearch');
    swBind('st-safety', 'safety');
    swBind('st-autoRead', 'autoRead');
    swBind('st-haptics', 'haptics');

    body.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', async () => {
      const act = el.dataset.act;
      if (act === 'model') { close(); ctx.openModelSheet(); }
      else if (act === 'docs') window.open('https://api-docs.deepseek.com/', '_blank', 'noopener');
      else if (act === 'usage') window.open('https://platform.deepseek.com/usage', '_blank', 'noopener');
      else if (act === 'privacy') toast('密钥与对话只保存在本机，不会上传服务器');
      else if (act === 'refresh-bal') { toast('正在刷新额度…'); await ctx.refreshBalance(true); render(); }
      else if (act === 'change-key') { close(); await ctx.changeKey(); }
      else if (act === 'nickname') {
        const v = await promptDialog({ title: '修改昵称', value: ctx.getNickname(), placeholder: '输入昵称' });
        if (v) { ctx.setNickname(v); render(); }
      } else if (act === 'export') { await ctx.exportData(); }
      else if (act === 'import') { ctx.importData(); }
      else if (act === 'clear') {
        const ok = await confirmDialog({ title: '清空全部对话？', message: '所有本地对话将被删除，且无法恢复。', okText: '清空', danger: true });
        if (ok) { await ctx.clearAll(); close(); }
      } else if (act === 'preview-tts') ctx.previewTTS();
      else if (act === "clear-sys") {
        save({ systemPrompt: "" });
        toast("已清空系统提示词");
        render();
      } else if (act === "logout") {
        const ok = await confirmDialog({ title: '退出登录？', message: '本地对话不会删除，密钥会从本机移除。', okText: '退出', danger: true });
        if (ok) { close(); await ctx.logout(); }
      }
    }));

    body.querySelectorAll('[data-opt]').forEach((el) => el.addEventListener('click', () => {
      const v = el.dataset.opt;
      const cur = stack[stack.length - 1].id;
      if (cur === 'theme') { save({ theme: v }); ctx.applyTheme(); }
      else if (cur === 'font') { save({ fontSize: v }); ctx.applyTheme(); }
      else if (cur === 'effort') { save({ effort: v }); }
      else if (cur === 'voice') { save({ ttsVoice: v }); }
      render();
    }));

    body.querySelectorAll('[data-lang]').forEach((el) => el.addEventListener('click', () => {
      save({ language: el.dataset.lang }); render();
    }));
    body.querySelectorAll('[data-loc]').forEach((el) => el.addEventListener('click', () => {
      save({ location: el.dataset.loc }); render();
    }));

    const spInput = body.querySelector("#sp-input");
    if (spInput) {
      const count = body.querySelector("#sp-count");
      spInput.addEventListener("input", () => {

        if (count) count.textContent = `${spInput.value.length} 字`;
      });
      body.querySelectorAll("[data-preset]").forEach((el) => el.addEventListener("click", () => {
        const p = PRESETS[Number(el.dataset.preset)];
        if (!p) return;
        spInput.value = p.value;
        spInput.dispatchEvent(new Event("input"));
        spInput.focus();
      }));
      body.querySelector("#sp-save")?.addEventListener("click", () => {
        save({ systemPrompt: spInput.value.trim() });
        toast("系统提示词已保存", { type: "success" });
      });
    }

    const rate = body.querySelector("#st-rate");
    if (rate) {
      rate.addEventListener('input', () => {
        save({ ttsRate: Number(rate.value) });
        const v = body.querySelector('#st-rate-v');
        if (v) v.textContent = `${Number(rate.value).toFixed(1)}x`;
      });
    }
  };

  render();
  return { close, page };
}

export function openModelSheet(ctx) {
  const { settings, saveSettings } = ctx;
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="sheet-grip"></div>
    <div class="sheet-head">
      <div class="sheet-title">模型与能力</div>
      <button class="icon-btn sm" data-close aria-label="关闭">${icon('close', { size: 20 })}</button>
    </div>
    <div class="sheet-body" id="ms-body"></div>`;
  const sheet = openSheet(el);
  const body = el.querySelector('#ms-body');

  const render = () => {
    const s = settings();
    body.innerHTML = `
      <div class="settings-section" style="margin-top:4px">
        ${MODELS.map((m) => `
          <button class="model-option ${ctx.sessionModel() === m.id ? 'on' : ''}" data-model="${m.id}">
            <span class="model-ico">${icon(m.icon === 'brain' ? 'brain' : 'sparkle', { size: 18 })}</span>
            <span style="flex:1;min-width:0">
              <span class="model-name">${esc(m.name)}</span>
              <span class="model-desc">${esc(m.desc)}</span>
            </span>
          </button>`).join('')}
      </div>
      <div class="settings-section">
        <div class="settings-label">本轮能力</div>
        <div class="set-row"><div class="set-main"><div class="set-name">深度思考</div></div>${sw('m-thinking', s.thinking)}</div>
        <div class="set-row"><div class="set-main"><div class="set-name">智能搜索</div></div>${sw('m-websearch', s.webSearch)}</div>
      </div>
      <div style="height:8px"></div>`;
    body.querySelectorAll('[data-model]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.model;
      if (id === 'deepseek-v4-pro' && ctx.sessionHasImages()) { toast('V4 Pro 不支持图片，请改用 Flash'); return; }
      ctx.setSessionModel(id).then(() => render());
    }));
    body.querySelector('#m-thinking')?.addEventListener('click', (e) => {
      const next = !settings().thinking;
      e.currentTarget.setAttribute('aria-checked', String(next));
      saveSettings({ thinking: next }); ctx.applySettings(); render();
    });
    body.querySelector('#m-websearch')?.addEventListener('click', (e) => {
      const next = !settings().webSearch;
      e.currentTarget.setAttribute('aria-checked', String(next));
      saveSettings({ webSearch: next }); ctx.applySettings(); render();
    });
    body.querySelector('[data-close]')?.addEventListener('click', () => sheet.close());
  };
  render();
  return sheet;
}