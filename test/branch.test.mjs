/**
 * branch.js 单元测试 —— 消息版本（variants）
 * 运行：node --test test/branch.test.mjs
 *
 * 覆盖：
 *  - 旧消息迁移（无 variants = 1 个版本，字段不丢）
 *  - 添加变体（重新生成保留历史版本）
 *  - 循环切换（首尾相接）与投影回写
 *  - 当前版本信息只读查询
 *  - JSON 序列化后重载保持当前版本
 *  - 导出 / 导入归一化兼容（store.js）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  VARIANT_FIELDS,
  addVariant,
  captureVariant,
  currentVariant,
  ensureVariants,
  switchVariant,
} from '../public/js/branch.js';
import { migrateSessionMessages, normalizeSession, store } from '../public/js/store.js';

/** 旧版本（没有 variants 字段）的助手消息 */
function legacyMessage(overrides = {}) {
  return {
    id: 'm_a1',
    role: 'assistant',
    createdAt: 1730000000000,
    content: '第一版回答',
    reasoningContent: '第一版思考',
    blocks: [
      { type: 'think', text: '第一版思考', start: 100, end: 900 },
      {
        type: 'tools',
        steps: [{
          id: 't1',
          name: 'deepseek_web_search',
          action: 'search',
          kind: 'search',
          queries: ['deepseek'],
          url: '',
          pattern: '',
          results: [{
            url: 'https://example.com/a',
            title: 'A',
            site: 'example.com',
            icon: '',
            snippet: '',
            pageAge: null,
            kind: 'search',
          }],
          error: '',
          done: true,
        }],
      },
      { type: 'text', text: '第一版回答', citations: [{ url: 'https://example.com/a', title: 'A' }] },
    ],
    annotations: [{ url: 'https://example.com/a', title: 'A' }],
    citations: [],
    serverToolCalls: [{ id: 't1' }],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
    model: 'deepseek-flash',
    title: '标题',
    reasoningStart: 100,
    reasoningEnd: 900,
    finishReason: 'stop',
    refusal: '',
    durationMs: 1500,
    firstTokenMs: 320,
    status: 'done',
    error: '',
    feedback: 'like',
    ...overrides,
  };
}

/** 模拟一次重新生成的助手消息 */
function reMessage(content, extra = {}) {
  return {
    id: 'm_tmp',
    role: 'assistant',
    createdAt: 1730000100000,
    content,
    reasoningContent: '',
    blocks: [{ type: 'text', text: content, citations: [] }],
    annotations: [],
    citations: [],
    serverToolCalls: [],
    usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 },
    model: 'deepseek-flash',
    status: 'done',
    error: '',
    durationMs: 1800,
    firstTokenMs: 280,
    ...extra,
  };
}

/* ============================================================
 * 旧消息迁移
 * ============================================================ */

describe('旧消息迁移', () => {
  it('没有 variants 的消息视为 1 个版本', () => {
    const legacy = legacyMessage();
    const msg = ensureVariants(legacy);

    assert.equal(msg.variants.length, 1);
    assert.equal(msg.activeVariant, 0);
    assert.equal(msg.content, '第一版回答');
    assert.deepEqual(msg.variants[0].blocks, legacy.blocks);
  });

  it('迁移不修改原始对象（纯函数）', () => {
    const legacy = legacyMessage();
    const snapshot = JSON.stringify(legacy);
    ensureVariants(legacy);
    assert.equal(legacy.variants, undefined);
    assert.equal(legacy.activeVariant, undefined);
    assert.equal(JSON.stringify(legacy), snapshot);
  });

  it('迁移保留全部版本字段，不丢数据', () => {
    const msg = ensureVariants(legacyMessage());
    const v = msg.variants[0];
    for (const field of ['content', 'reasoningContent', 'blocks', 'annotations', 'usage', 'title', 'model', 'durationMs', 'firstTokenMs', 'feedback', 'finishReason']) {
      assert.deepEqual(v[field], legacyMessage()[field], `字段 ${field} 应保留`);
    }
    assert.deepEqual(msg.usage, legacyMessage().usage);
    assert.equal(msg.feedback, 'like');
  });

  it('用户消息不做版本迁移，原样返回', () => {
    const user = { id: 'm_u1', role: 'user', content: '你好', createdAt: 1 };
    assert.equal(ensureVariants(user), user);
    assert.equal(currentVariant(user).total, 1);
  });

  it('重复迁移幂等', () => {
    const once = ensureVariants(legacyMessage());
    const twice = ensureVariants(once);
    assert.equal(twice.variants.length, 1);
    assert.equal(twice.activeVariant, 0);
    assert.equal(twice.content, once.content);
  });

  it('损坏的 variants 字段被容错成单版本', () => {
    for (const broken of [null, [], 'x', 42, [null], [{}], [1, 2]]) {
      const msg = ensureVariants(legacyMessage({ variants: broken, activeVariant: 9 }));
      assert.equal(msg.variants.length, 1, `variants=${JSON.stringify(broken)} 应回落成 1 个版本`);
      assert.equal(msg.activeVariant, 0);
      assert.equal(msg.content, '第一版回答');
    }
  });

  it('activeVariant 越界时收敛到合法下标', () => {
    const msg = ensureVariants(legacyMessage({ variants: [captureVariant(legacyMessage())], activeVariant: 7 }));
    assert.equal(msg.activeVariant, 0);
  });

  it('投影为空但快照有内容时以快照为准（中断写入恢复）', () => {
    const msg = ensureVariants({
      id: 'm_x',
      role: 'assistant',
      createdAt: 1,
      content: '',
      blocks: [],
      variants: [{ content: '存活版本', blocks: [{ type: 'text', text: '存活版本', citations: [] }] }],
      activeVariant: 0,
    });
    assert.equal(msg.content, '存活版本');
    assert.equal(msg.blocks.length, 1);
  });
});

/* ============================================================
 * 添加变体
 * ============================================================ */

describe('添加变体', () => {
  it('新增版本成为当前版本，旧回答保留为历史版本', () => {
    const legacy = legacyMessage();
    const msg = addVariant(legacy, reMessage('第二版回答'));

    assert.equal(msg.variants.length, 2);
    assert.equal(msg.activeVariant, 1);
    assert.equal(msg.content, '第二版回答');
    assert.equal(msg.variants[0].content, '第一版回答');
    assert.equal(msg.variants[1].content, '第二版回答');
  });

  it('容器身份（id / role）保持不变，DOM 引用不失效', () => {
    const msg = addVariant(legacyMessage(), reMessage('第二版回答'));
    assert.equal(msg.id, 'm_a1');
    assert.equal(msg.role, 'assistant');
    assert.equal(msg.variants[0].id, undefined, '快照只保存内容字段');
    assert.deepEqual(Object.keys(msg.variants[1]).every((k) => VARIANT_FIELDS.includes(k)), true);
  });

  it('连续重新生成按顺序累积版本', () => {
    let msg = ensureVariants(legacyMessage());
    msg = addVariant(msg, reMessage('第二版回答'));
    msg = addVariant(msg, reMessage('第三版回答'));
    msg = addVariant(msg, reMessage('第四版回答'));

    assert.equal(msg.variants.length, 4);
    assert.equal(msg.activeVariant, 3);
    assert.deepEqual(msg.variants.map((v) => v.content), ['第一版回答', '第二版回答', '第三版回答', '第四版回答']);
    assert.equal(msg.content, '第四版回答');
  });

  it('添加变体不修改原消息', () => {
    const legacy = legacyMessage();
    addVariant(legacy, reMessage('第二版回答'));
    assert.equal(legacy.variants, undefined);
    assert.equal(legacy.content, '第一版回答');
  });

  it('流式消息的 status=streaming 入快照时归一为 done', () => {
    const msg = addVariant(legacyMessage(), reMessage('第二版回答', { status: 'streaming' }));
    assert.equal(msg.variants[1].status, 'done');
    assert.equal(msg.status, 'done');
  });

  it('用量与思考块跟随新版本', () => {
    const msg = addVariant(legacyMessage(), reMessage('第二版回答'));
    assert.equal(msg.usage.completion_tokens, 60);
    assert.equal(msg.reasoningContent, '');
    assert.equal(msg.blocks.length, 1);
    assert.deepEqual(msg.usage, { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 });
  });
});

/* ============================================================
 * 切换版本
 * ============================================================ */

describe('切换版本', () => {
  function threeVariants() {
    let msg = ensureVariants(legacyMessage());
    msg = addVariant(msg, reMessage('第二版回答'));
    msg = addVariant(msg, reMessage('第三版回答'));
    return msg;
  }

  it('prev 从第一版回绕到最后一版（循环切换）', () => {
    let msg = threeVariants();
    assert.equal(msg.activeVariant, 2);
    msg = switchVariant(msg, 'prev');
    assert.equal(msg.activeVariant, 1);
    assert.equal(msg.content, '第二版回答');
    msg = switchVariant(msg, 'prev');
    msg = switchVariant(msg, 'prev');
    assert.equal(msg.activeVariant, 2, '再往前应回到最后一版');
    assert.equal(msg.content, '第三版回答');
  });

  it('next 从最后一版回绕到第一版（循环切换）', () => {
    let msg = threeVariants();
    msg = switchVariant(msg, 'next');
    assert.equal(msg.activeVariant, 0);
    assert.equal(msg.content, '第一版回答');
    msg = switchVariant(msg, 'next');
    assert.equal(msg.activeVariant, 1);
  });

  it('切换后用绝对值下标也能定位版本', () => {
    let msg = threeVariants();
    msg = switchVariant(msg, 0);
    assert.equal(msg.activeVariant, 0);
    assert.equal(msg.content, '第一版回答');
    msg = switchVariant(msg, 9);
    assert.equal(msg.activeVariant, 0, '越界下标回绕');
    msg = switchVariant(msg, -1);
    assert.equal(msg.activeVariant, 2);
  });

  it('切换会重渲染所需的正文/思考/引用/用量', () => {
    let msg = addVariant(legacyMessage(), reMessage('第二版回答', {
      annotations: [{ url: 'https://example.com/b', title: 'B' }],
      reasoningContent: '第二版思考',
      blocks: [
        { type: 'think', text: '第二版思考', start: 1, end: 2 },
        { type: 'text', text: '第二版回答', citations: [{ url: 'https://example.com/b', title: 'B' }] },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    }));
    assert.equal(msg.usage.completion_tokens, 3);

    msg = switchVariant(msg, 'prev');
    assert.equal(msg.content, '第一版回答');
    assert.equal(msg.reasoningContent, '第一版思考');
    assert.equal(msg.annotations[0].url, 'https://example.com/a');
    assert.equal(msg.usage.completion_tokens, 40);
    assert.equal(msg.blocks[0].type, 'think');

    msg = switchVariant(msg, 'next');
    assert.equal(msg.content, '第二版回答');
    assert.equal(msg.usage.completion_tokens, 3);
  });

  it('切走前把当前投影的最新改动写回快照', () => {
    let msg = addVariant(legacyMessage(), reMessage('第二版回答'));
    // 模拟流式增量 / 交互就地修改了当前投影
    msg = { ...msg, content: '第二版回答（后续补写）', blocks: [{ type: 'text', text: '第二版回答（后续补写）', citations: [] }] };

    msg = switchVariant(msg, 'prev');
    assert.equal(msg.content, '第一版回答');
    assert.equal(msg.variants[1].content, '第二版回答（后续补写）');

    msg = switchVariant(msg, 'next');
    assert.equal(msg.content, '第二版回答（后续补写）');
  });

  it('单版本切换不产生变化', () => {
    const only = ensureVariants(legacyMessage());
    const same = switchVariant(only, 'next');
    assert.equal(same.activeVariant, 0);
    assert.equal(same.variants.length, 1);
    assert.equal(same.content, only.content);
  });

  it('非法 target 不改变当前版本', () => {
    const msg = threeVariants();
    const same = switchVariant(msg, 'whatever');
    assert.equal(same.activeVariant, msg.activeVariant);
    assert.equal(currentVariant(same).total, 3);
  });

  it('切换不修改入参消息', () => {
    const msg = threeVariants();
    const before = JSON.stringify(msg);
    switchVariant(msg, 'prev');
    switchVariant(msg, 'next');
    assert.equal(JSON.stringify(msg), before);
  });
});

/* ============================================================
 * 当前版本信息
 * ============================================================ */

describe('currentVariant', () => {
  it('旧消息报告 1/1 且不可切换', () => {
    const info = currentVariant(legacyMessage());
    assert.deepEqual([info.index, info.total, info.canSwitch], [0, 1, false]);
    assert.equal(info.variant.content, '第一版回答');
  });

  it('多版本报告当前下标与总数', () => {
    let msg = ensureVariants(legacyMessage());
    msg = addVariant(msg, reMessage('第二版回答'));
    msg = switchVariant(msg, 'prev');
    const info = currentVariant(msg);
    assert.deepEqual([info.index, info.total, info.canSwitch], [0, 2, true]);
    assert.equal(info.variant.content, '第一版回答');
  });

  it('是只读查询，不迁移也不改数据', () => {
    const legacy = legacyMessage();
    currentVariant(legacy);
    assert.equal(legacy.variants, undefined);
  });
});

/* ============================================================
 * 序列化（导出 / 重载）
 * ============================================================ */

describe('序列化', () => {
  it('JSON 往返后保持当前版本', () => {
    let msg = ensureVariants(legacyMessage());
    msg = addVariant(msg, reMessage('第二版回答'));
    msg = addVariant(msg, reMessage('第三版回答'));
    msg = switchVariant(msg, 'prev');          // 当前 = 第二版

    const loaded = ensureVariants(JSON.parse(JSON.stringify(msg)));
    assert.equal(loaded.variants.length, 3);
    assert.equal(loaded.activeVariant, 1);
    assert.equal(loaded.content, '第二版回答');
    assert.deepEqual(currentVariant(loaded), currentVariant(ensureVariants(msg)));
  });

  it('旧消息 JSON 往返后仍是单版本且内容不丢', () => {
    const loaded = ensureVariants(JSON.parse(JSON.stringify(legacyMessage())));
    assert.equal(loaded.variants.length, 1);
    assert.equal(loaded.content, '第一版回答');
    assert.equal(loaded.blocks.length, 3);
  });

  it('快照与投影互相隔离（深拷贝）', () => {
    const msg = ensureVariants(legacyMessage());
    msg.blocks[0].text = '被就地改掉的思考';
    msg.blocks.push({ type: 'text', text: '追加块', citations: [] });
    assert.equal(msg.variants[0].blocks[0].text, '第一版思考');
    assert.equal(msg.variants[0].blocks.length, 3);
  });

  it('切换到旧版本后修改投影，不影响其他版本快照', () => {
    let msg = addVariant(legacyMessage(), reMessage('第二版回答'));
    msg = switchVariant(msg, 'prev');
    msg.blocks.push({ type: 'text', text: '注入', citations: [] });
    assert.equal(msg.variants[1].blocks.length, 1);
  });
});

/* ============================================================
 * 导出 / 导入兼容（store.js）
 * ============================================================ */

describe('导入导出兼容', () => {
  it('旧格式导出（无 variants）导入后每个回答是 1 个版本', () => {
    const session = normalizeSession({
      id: 's1',
      title: '旧对话',
      messages: [
        { id: 'u1', role: 'user', content: '问题' },
        { id: 'a1', role: 'assistant', content: '回答', blocks: [{ type: 'text', text: '回答', citations: [] }] },
      ],
    });
    const asst = session.messages.find((m) => m.role === 'assistant');
    assert.equal(asst.variants.length, 1);
    assert.equal(asst.activeVariant, 0);
    assert.equal(asst.content, '回答');
    assert.equal(asst.blocks.length, 1);
    assert.equal(session.messages.find((m) => m.role === 'user').variants, undefined);
  });

  it('新格式导出（含 variants）导入后保持当前版本', () => {
    let asst = ensureVariants(legacyMessage());
    asst = addVariant(asst, reMessage('第二版回答'));
    asst = addVariant(asst, reMessage('第三版回答'));
    asst = switchVariant(asst, 'prev');

    const session = normalizeSession({
      id: 's2',
      title: '新对话',
      messages: [{ id: 'u1', role: 'user', content: '问题' }, asst],
    });
    const loaded = session.messages.find((m) => m.role === 'assistant');
    assert.equal(loaded.variants.length, 3);
    assert.equal(loaded.activeVariant, 1);
    assert.equal(loaded.content, '第二版回答');
    assert.equal(loaded.usage.completion_tokens, 60);

    // 导入后还能继续切换
    const prev = switchVariant(loaded, 'prev');
    assert.equal(prev.content, '第一版回答');
  });

  it('导入时过滤 javascript: 等非 http(s) 链接（防止注入）', () => {
    const session = normalizeSession({
      id: 's3',
      messages: [{
        id: 'a1',
        role: 'assistant',
        content: '回答',
        annotations: [{ url: 'javascript:alert(1)', title: 'x' }, { url: 'https://ok.example/a', title: 'ok' }],
        blocks: [
          { type: 'text', text: '回答', citations: [{ url: 'javascript:alert(2)' }, { url: 'https://ok.example/a', title: 'ok' }] },
          { type: 'tools', steps: [{ results: [{ url: 'javascript:alert(3)', title: 'x' }] }] },
        ],
      }],
    });
    const asst = session.messages[0];
    assert.deepEqual(asst.annotations.map((a) => a.url), ['https://ok.example/a']);
    assert.deepEqual(asst.blocks[0].citations.map((c) => c.url), ['https://ok.example/a']);
    assert.equal(asst.blocks[1].steps[0].results.length, 0);
  });

  it('migrateSessionMessages 幂等且不丢消息', () => {
    const session = {
      id: 's4',
      messages: [
        { id: 'u1', role: 'user', content: '问题', createdAt: 1 },
        { id: 'a1', role: 'assistant', content: '回答', blocks: [], createdAt: 2 },
      ],
    };
    migrateSessionMessages(session);
    migrateSessionMessages(session);
    assert.equal(session.messages.length, 2);
    assert.equal(session.messages[1].variants.length, 1);
    assert.equal(session.messages[1].content, '回答');
  });

  it('写盘迁移保持消息对象引用不变（流式安全）', async () => {
    const legacy = legacyMessage();
    const session = { id: 's5', title: 't', createdAt: 1, updatedAt: 1, messages: [legacy] };
    await store.saveSession(session);
    assert.equal(session.messages[0], legacy, '消息对象不应被替换');
    assert.equal(legacy.variants.length, 1);
    assert.equal(legacy.content, '第一版回答');
  });
});
