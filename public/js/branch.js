/* =========================================================================
 * branch.js —— 消息版本（variants）纯函数
 *
 * 一处对话里，助手回答可能有多个版本（重新生成时保留旧回答）。
 * 存储约定：
 *   - 消息顶层字段（content / blocks / usage …）永远是「当前版本」的投影，
 *     渲染、朗读、导出、请求组装照旧直接读这些字段，调用方无需改写法。
 *   - msg.variants 保存每个版本的快照，msg.activeVariant 是当前版本下标。
 * 纯函数：不碰 DOM / localStorage / 网络，不修改入参，返回新的消息对象。
 * 旧数据（没有 variants）读取时自动迁移成单版本，字段原样保留，不丢数据。
 * ========================================================================= */

/** 参与版本快照的消息字段（渲染 / 用量 / 朗读 / 导出所需的全部内容） */
export const VARIANT_FIELDS = Object.freeze([
  'content', 'reasoningContent', 'blocks', 'annotations', 'citations',
  'serverToolCalls', 'usage', 'title', 'model', 'reasoningStart',
  'reasoningEnd', 'finishReason', 'refusal', 'durationMs', 'firstTokenMs',
  'status', 'error', 'feedback',
]);

/** 结构字段缺省值：保证任意版本都能安全渲染 */
const STRUCT_DEFAULTS = Object.freeze({
  content: '',
  reasoningContent: '',
  blocks: [],
  annotations: [],
  citations: [],
  serverToolCalls: [],
  usage: null,
  title: '',
  reasoningStart: 0,
  reasoningEnd: 0,
  finishReason: '',
  refusal: '',
  status: 'done',
  error: '',
});

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof globalThis.structuredClone === 'function') {
    try { return globalThis.structuredClone(value); } catch { /* 含函数/循环引用时降级 */ }
  }
  try { return JSON.parse(JSON.stringify(value)); } catch { return undefined; }
}

/** 判断一份数据里是否真的承载了回答内容 */
function isEmptyVariant(v) {
  if (!isObj(v)) return true;
  const hasContent = String(v.content || '').trim().length > 0;
  const hasBlocks = Array.isArray(v.blocks) && v.blocks.length > 0;
  const hasSources = Array.isArray(v.annotations) && v.annotations.length > 0;
  return !hasContent && !hasBlocks && !hasSources && !v.error && !v.refusal;
}

/** 取当前消息的版本快照（深拷贝，与后续流式增量互不影响） */
export function captureVariant(msg) {
  const snapshot = {};
  if (!isObj(msg)) return snapshot;
  for (const field of VARIANT_FIELDS) {
    if (msg[field] === undefined) continue;
    const value = clone(msg[field]);
    if (value !== undefined) snapshot[field] = value;
  }
  return snapshot;
}

/** 把任意来源的快照收敛成合法快照（丢弃未知字段 / 非对象 / 残缺数据） */
function normalizeSnapshot(raw) {
  if (!isObj(raw)) return null;
  const snapshot = captureVariant(raw);
  if (!Object.keys(snapshot).length) return null;
  if (snapshot.status === 'streaming') snapshot.status = 'done';
  if (snapshot.blocks !== undefined && !Array.isArray(snapshot.blocks)) snapshot.blocks = [];
  return snapshot;
}

/** 用快照生成新消息：快照里没有的字段回落到结构缺省值或删除，避免串味 */
function applySnapshot(base, snapshot) {
  const next = { ...base };
  for (const field of VARIANT_FIELDS) {
    if (isObj(snapshot) && hasOwn(snapshot, field) && snapshot[field] !== undefined) {
      next[field] = clone(snapshot[field]);
    } else if (hasOwn(STRUCT_DEFAULTS, field)) {
      next[field] = clone(STRUCT_DEFAULTS[field]);
    } else {
      delete next[field];
    }
  }
  return next;
}

/**
 * 迁移 / 归一化：保证 assistant 消息带有 variants。
 * 旧数据（无 variants）视为 1 个版本；非法 variants 丢弃后回落到当前投影。
 * @returns 新的消息对象（非 assistant 消息原样返回）
 */
export function ensureVariants(msg) {
  if (!isObj(msg) || msg.role !== 'assistant') return msg;

  const rawList = Array.isArray(msg.variants) ? msg.variants : [];
  const snapshots = rawList.map(normalizeSnapshot).filter(Boolean);

  // 旧会话数据：顶层字段就是唯一版本
  if (!snapshots.length) {
    return { ...msg, variants: [captureVariant(msg)], activeVariant: 0 };
  }

  let index = Number.isInteger(msg.activeVariant) ? msg.activeVariant : 0;
  index = Math.min(snapshots.length - 1, Math.max(0, index));

  // 投影为空但快照有内容（导入 / 中断写入）→ 以快照为准恢复，避免丢数据
  let projection = msg;
  if (isEmptyVariant(msg) && !isEmptyVariant(snapshots[index])) {
    projection = applySnapshot(msg, snapshots[index]);
  }

  // 反向同步：当前版本的快照始终跟投影一致
  const variants = snapshots.slice();
  variants[index] = captureVariant(projection);
  return { ...projection, variants, activeVariant: index };
}

/**
 * 追加一个版本并切到它（重新生成用）。
 * @param msg 原消息（不要求已迁移）
 * @param variant 新版本：可以是流式得到的 assistant 消息，也可以是快照；
 *                省略时把当前版本原样复制一份
 * @returns 新的消息对象，容器 id / role 保持不变
 */
export function addVariant(msg, variant) {
  const base = ensureVariants(msg);
  if (!isObj(base) || base.role !== 'assistant') return base;

  const variants = base.variants.slice();
  variants[base.activeVariant] = captureVariant(base);

  let incoming;
  if (isObj(variant)) {
    incoming = normalizeSnapshot(variant);
    if (!incoming) incoming = {};
  } else {
    incoming = captureVariant(base);
  }

  const index = variants.length;
  variants.push(incoming);
  const next = applySnapshot(base, incoming);
  next.id = base.id;
  next.role = base.role;
  next.variants = variants;
  next.activeVariant = index;
  return next;
}

/**
 * 切换版本。
 * @param target 'next' / 'prev'（循环，首尾相接）或版本下标（越界自动回绕）
 * @returns 新的消息对象；版本数不足或目标非法时原样返回迁移后的消息
 */
export function switchVariant(msg, target) {
  const base = ensureVariants(msg);
  if (!isObj(base) || base.role !== 'assistant') return base;

  const total = base.variants.length;
  if (total <= 1) return base;

  let index;
  if (target === 'next') index = (base.activeVariant + 1) % total;
  else if (target === 'prev') index = (base.activeVariant - 1 + total) % total;
  else if (typeof target === 'number' && Number.isInteger(target)) index = ((target % total) + total) % total;
  else return base;

  if (index === base.activeVariant) return base;

  const variants = base.variants.slice();
  // 先保存当前投影的最新状态（可能刚被流式/交互改动过），再载入目标版本
  variants[base.activeVariant] = captureVariant(base);
  const next = applySnapshot(base, variants[index]);
  next.variants = variants;
  next.activeVariant = index;
  return next;
}

/**
 * 读取当前版本信息（只读，不迁移、不改数据）。
 * @returns {{ index:number, total:number, variant:object, canSwitch:boolean }}
 */
export function currentVariant(msg) {
  if (!isObj(msg)) return { index: 0, total: 1, variant: {}, canSwitch: false };
  const rawList = Array.isArray(msg.variants) ? msg.variants : [];
  // 渲染路径上的只读查询：不做深拷贝，避免长会话每次重绘都复制一遍正文
  const valid = rawList.filter((v) => isObj(v) && VARIANT_FIELDS.some((f) => v[f] !== undefined));
  const total = Math.max(1, valid.length);
  let index = Number.isInteger(msg.activeVariant) ? msg.activeVariant : 0;
  index = Math.min(total - 1, Math.max(0, index));
  const variant = valid.length ? valid[index] : captureVariant(msg);
  return { index, total, variant, canSwitch: total > 1 };
}
