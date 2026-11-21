/* =========================================================================
 * tokens.js —— 本地 token 估算与上下文预算
 * 估算规则（与 DeepSeek tokenizer 近似）：CJK 字符约 1 token/字，
 * 其余字符约 4 字符/token；仅用于 UI 提示，不用于计费。
 * ========================================================================= */

export function estimateTokens(text) {
  const s = String(text ?? '');
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (/[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}

/** 消息数组 token 估算（role 与分隔符按 4 token/条计） */
export function messagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const m of messages) {
    total += 4;
    if (typeof m.content === 'string') total += estimateTokens(m.content);
    if (m.reasoningContent) total += estimateTokens(m.reasoningContent);
    if (Array.isArray(m.attachments)) {
      for (const a of m.attachments) total += 256; // 图片/文件按占位估算
    }
  }
  return total;
}

export const CONTEXT_LIMIT = 1000000;

export function contextUsage(messages, limit = CONTEXT_LIMIT, lastPromptTokens = 0) {
  const estimated = messagesTokens(messages);
  const used = Math.max(estimated, Number(lastPromptTokens) || 0);
  const max = Math.max(1, Number(limit) || CONTEXT_LIMIT);
  return { used, limit: max, ratio: Math.min(1, used / max) };
}

export function formatTokens(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v < 10000) return `${(v / 1000).toFixed(1)}k`;
  if (v < 1e6) return `${Math.round(v / 1000)}k`;
  return `${(v / 1e6).toFixed(1)}m`;
}
