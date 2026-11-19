/* =========================================================================
 * usage.js —— 本地用量统计（token / 缓存 / 语音 / 费用估算）
 * 只存在设备上，不上报任何服务器；费用按官方价目表估算，仅供参考。
 * ========================================================================= */

const KEY = 'ds.usage';

const EMPTY = {
  requests: 0,
  promptTokens: 0,
  completionTokens: 0,
  cacheHitTokens: 0,
  modelCost: 0,       // USD
  ttsChars: 0,        // 计费字符（中文按 2 计）
  ttsCost: 0,
  asrSeconds: 0,
  asrCost: 0,
  updatedAt: 0,
};

export function loadUsage() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...EMPTY, ...JSON.parse(raw) } : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

function save(u) {
  try { localStorage.setItem(KEY, JSON.stringify(u)); } catch { /* 配额满忽略 */ }
  return u;
}

/** 计费字符：中文（含全角标点）按 2 计，其余按 1 */
export function billedChars(text) {
  let n = 0;
  for (const ch of String(text || '')) {
    n += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/.test(ch) ? 2 : 1;
  }
  return n;
}

/** 累计一次对话用量（按 deepseek-flash / v4-pro 非高峰价估算） */
export function addChat(usage, model = 'deepseek-flash') {
  const u = loadUsage();
  if (usage) {
    const prompt = usage.prompt_tokens || 0;
    const cache = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
    const completion = usage.completion_tokens || 0;
    const pro = model === 'deepseek-v4-pro';
    const inRate = pro ? 0.66 : 0.15;
    const outRate = pro ? 1.98 : 0.6;
    const cacheRate = pro ? 0.022 : 0.003;
    u.promptTokens += prompt;
    u.completionTokens += completion;
    u.cacheHitTokens += cache;
    u.modelCost += ((prompt - cache) * inRate + cache * cacheRate + completion * outRate) / 1e6;
  }
  u.requests += 1;
  u.updatedAt = Date.now();
  return save(u);
}

/** 累计 TTS：按计费字符，$0.45 / 万字符 */
export function addTTS(text) {
  const chars = billedChars(text);
  const u = loadUsage();
  u.ttsChars += chars;
  u.ttsCost += (chars / 10000) * 0.45;
  u.updatedAt = Date.now();
  return save(u);
}

/** 累计 ASR：按时长，$0.116 / 小时 */
export function addASR(seconds) {
  const sec = Math.max(0, Number(seconds) || 0);
  const u = loadUsage();
  u.asrSeconds += sec;
  u.asrCost += (sec / 3600) * 0.116;
  u.updatedAt = Date.now();
  return save(u);
}

export function resetUsage() {
  return save({ ...EMPTY, updatedAt: Date.now() });
}

export function summary() {
  const u = loadUsage();
  const totalCost = u.modelCost + u.ttsCost + u.asrCost;
  const cacheRate = u.promptTokens ? u.cacheHitTokens / u.promptTokens : 0;
  return { ...u, totalCost, cacheRate };
}
