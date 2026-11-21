/* =========================================================================
 * exporter.js —— 会话导出格式（JSON / JSONL / TXT / Markdown）
 * 纯函数，便于 Node 测试；app.js 负责下载。
 * ========================================================================= */

function roleName(role) {
  return role === 'user' ? '用户' : role === 'assistant' ? '助手' : role;
}

export function safeFilename(title, fallback = 'deepseek-chat') {
  const base = String(title || fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return base || fallback;
}

/** 每条消息一行 JSON：{role,content,time,ids?}；跳过空消息 */
export function sessionToJSONL(session) {
  const msgs = Array.isArray(session?.messages) ? session.messages : [];
  return msgs
    .filter((m) => m && m.role !== 'system' && (m.content || m.reasoningContent))
    .map((m) => JSON.stringify({
      role: m.role,
      content: m.content || '',
      time: m.createdAt ? new Date(m.createdAt).toISOString() : undefined,
      ...(m.reasoningContent ? { reasoning: m.reasoningContent } : {}),
      ...(m.error ? { error: m.error } : {}),
    }))
    .join('\n');
}

/** 人类可读纯文本 */
export function sessionToTXT(session) {
  const lines = [`# ${session?.title || '未命名对话'}`, ''];
  for (const m of session?.messages || []) {
    if (!m || m.role === 'system') continue;
    if (!m.content && !m.reasoningContent) continue;
    lines.push(`## ${roleName(m.role)}`, '', m.content || '', '');
    if (m.reasoningContent) lines.push('> 思考过程', '', m.reasoningContent, '');
  }
  return lines.join('\n').trimEnd() + '\n';
}

/** 单条 Assistant 消息的 Markdown（用于“复制为 Markdown”） */
export function messageToMarkdown(msg) {
  if (!msg) return '';
  const parts = [];
  if (msg.reasoningContent) parts.push(`> 思考过程\n>\n> ${msg.reasoningContent.replace(/\n/g, '\n> ')}`, '');
  if (msg.content) parts.push(msg.content);
  if (Array.isArray(msg.citations) && msg.citations.length) {
    parts.push('', '参考来源：');
    for (const c of msg.citations) parts.push(`- [${c.n || ''}] ${c.title || c.url || ''} ${c.url || ''}`.trim());
  }
  return parts.join('\n').trimEnd();
}
