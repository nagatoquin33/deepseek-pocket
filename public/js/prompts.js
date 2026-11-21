/* =========================================================================
 * prompts.js —— 有序提示词块（参考 SillyTavern Prompt Manager 的简化版）
 * 纯函数：不碰 DOM / localStorage；所有操作返回新数组。
 * ========================================================================= */

export const PROMPT_ROLES = ['system', 'user'];

export const DEFAULT_PROMPTS = Object.freeze([
  {
    id: 'p_role',
    name: '角色设定',
    role: 'system',
    content: '你是 DeepSeek，由深度求索创造的 AI 助手。回答准确、简洁、可执行；不确定时明确说明，不要编造。',
    enabled: true,
  },
  {
    id: 'p_lang',
    name: '语言',
    role: 'system',
    content: '使用与用户相同的语言回答；代码与专有名词保持原样。',
    enabled: true,
  },
]);

const uid = () => `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

function str(v, max = 20000) {
  return String(v ?? '').slice(0, max);
}

/** 归一化：兼容缺字段、非法 role、重复 id；不修改入参 */
export function normalizePrompts(list) {
  if (!Array.isArray(list)) return DEFAULT_PROMPTS.map((p) => ({ ...p }));
  const seen = new Set();
  return list
    .filter((p) => p && typeof p === 'object')
    .map((p, i) => {
      const id = str(p.id, 60) || `p_${i}`;
      const role = PROMPT_ROLES.includes(p.role) ? p.role : 'system';
      return {
        id,
        name: str(p.name, 60) || `提示词 ${i + 1}`,
        role,
        content: str(p.content),
        enabled: p.enabled !== false,
      };
    })
    .filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
}

/** 按顺序取出启用的块，并把相邻 system 块合并为一条消息 */
export function promptsToMessages(list) {
  const blocks = normalizePrompts(list).filter((p) => p.enabled && p.content.trim());
  const out = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (b.role === 'system' && prev && prev.role === 'system') {
      prev.content += `\n\n${b.content}`;
    } else {
      out.push({ role: b.role, content: b.content, _promptId: b.id });
    }
  }
  return out.map(({ _promptId, ...m }) => m);
}

export function addPrompt(list, patch = {}) {
  const base = normalizePrompts(list);
  const p = normalizePrompts([{
    id: uid(),
    name: patch.name || '新提示词',
    role: patch.role || 'system',
    content: patch.content || '',
    enabled: patch.enabled !== false,
  }])[0];
  return [...base, p];
}

export function updatePrompt(list, id, patch = {}) {
  return normalizePrompts(list).map((p) => (p.id === id
    ? {
      ...p,
      name: patch.name !== undefined ? str(patch.name, 60) : p.name,
      role: patch.role && PROMPT_ROLES.includes(patch.role) ? patch.role : p.role,
      content: patch.content !== undefined ? str(patch.content) : p.content,
      enabled: patch.enabled !== undefined ? !!patch.enabled : p.enabled,
    }
    : p));
}

export function removePrompt(list, id) {
  return normalizePrompts(list).filter((p) => p.id !== id);
}

/** delta=-1 上移，+1 下移；越界返回原顺序 */
export function movePrompt(list, id, delta) {
  const arr = normalizePrompts(list);
  const i = arr.findIndex((p) => p.id === id);
  if (i < 0) return arr;
  const j = i + delta;
  if (j < 0 || j >= arr.length) return arr;
  const next = arr.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** 旧数据迁移：把单条 systemPrompt 变成第一个块 */
export function migrateLegacy(systemPrompt) {
  const text = str(systemPrompt).trim();
  if (!text) return normalizePrompts(DEFAULT_PROMPTS);
  return [
    { id: 'p_legacy', name: '自定义提示词', role: 'system', content: text, enabled: true },
    ...DEFAULT_PROMPTS.filter((p) => p.id !== 'p_role').map((p) => ({ ...p })),
  ];
}

export const PROMPT_PRESETS = Object.freeze([
  {
    id: 'general',
    name: '通用助手',
    prompts: DEFAULT_PROMPTS.map((p) => ({ ...p })),
  },
  {
    id: 'coding',
    name: '编程',
    prompts: [
      { id: 'p_code_role', name: '角色设定', role: 'system', content: '你是资深软件工程师。优先给出可运行的最小方案，指出边界条件与风险。', enabled: true },
      { id: 'p_code_style', name: '回答风格', role: 'system', content: '先给代码，再给关键说明；代码使用 Markdown 代码块并标注语言。', enabled: true },
    ],
  },
  {
    id: 'translate',
    name: '翻译',
    prompts: [
      { id: 'p_tr_role', name: '角色设定', role: 'system', content: '你是专业译者。只输出译文，保留原文格式与术语一致性，不要解释。', enabled: true },
    ],
  },
  {
    id: 'concise',
    name: '精简',
    prompts: [
      { id: 'p_short_role', name: '角色设定', role: 'system', content: '回答尽量短：先结论，最多三条要点，不寒暄。', enabled: true },
    ],
  },
]);
