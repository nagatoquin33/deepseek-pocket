/* =========================================================================
 * memory.js —— 长期记忆与偏好（本机、可编辑，注入 system 消息）
 * 纯函数，便于 Node 测试。
 * ========================================================================= */

const MAX_ITEMS = 100;
const MAX_LEN = 500;

const uid = () => `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

function str(v, n = MAX_LEN) {
  return String(v ?? '').slice(0, n).trim();
}

export function normalizeMemories(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list
    .filter((m) => m && typeof m === 'object')
    .map((m, i) => ({
      id: str(m.id, 60) || `mem_${i}`,
      text: str(m.text),
      enabled: m.enabled !== false,
    }))
    .filter((m) => {
      if (!m.text || seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    })
    .slice(0, MAX_ITEMS);
}

export function addMemory(list, text) {
  const t = str(text);
  if (!t) return normalizeMemories(list);
  return [...normalizeMemories(list), { id: uid(), text: t, enabled: true }];
}

export function updateMemory(list, id, patch = {}) {
  return normalizeMemories(list).map((m) => (m.id === id
    ? {
      ...m,
      text: patch.text !== undefined ? str(patch.text) : m.text,
      enabled: patch.enabled !== undefined ? !!patch.enabled : m.enabled,
    }
    : m));
}

export function removeMemory(list, id) {
  return normalizeMemories(list).filter((m) => m.id !== id);
}

/** 启用的记忆 → 一条 system 消息；没有则返回 null */
export function memoriesToMessage(list) {
  const items = normalizeMemories(list).filter((m) => m.enabled);
  if (!items.length) return null;
  return {
    role: 'system',
    content: `关于用户的长期记忆与偏好（请在回答中遵守）：\n${items.map((m) => `- ${m.text}`).join('\n')}`,
  };
}
