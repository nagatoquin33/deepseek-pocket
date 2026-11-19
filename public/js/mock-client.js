/* =========================================================================
 * mock-client.js —— APK 内置离线演示客户端（?demo=1）
 * 与真实客户端同接口，本地合成 SSE，便于无密钥体验与自动化验证。
 * 只在 Android 壳或显式演示时使用，不会伪装成真实回答（界面有演示提示）。
 * ========================================================================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const THINK = '用户问的是实时信息，我需要先拆解问题：先确认时间与地点，再检索权威来源，最后用简洁的结构回答。';
const ANSWER = `## 上海今天天气

上海今天（11 月 19 日）**多云转晴**，气温约 18～24℃，东北风 3 级，体感舒适，适合外出[1]。

- 早晚偏凉，建议带一件薄外套
- 空气质量良，可正常通勤与户外活动[2]
- 昼夜温差较大，注意增减衣物[3]

| 时段 | 天气 | 气温 |
| --- | --- | --- |
| 上午 | 多云 | 18～21℃ |
| 下午 | 晴 | 22～24℃ |
| 夜间 | 晴转多云 | 15～18℃ |

\`\`\`mermaid
graph LR
  A[查询天气] --> B[搜索来源]
  B --> C[生成回答]
\`\`\`

> 演示数据由本地 Mock 生成，不代表真实天气。`;

const RESULTS = [
  { title: '上海今日天气：多云转晴，18～24℃', url: 'https://www.weather.com.cn/shanghai', site_name: '上海天气网', snippet: '上海今天多云转晴，18～24℃，东北风 3 级。', date: '2026-11-19', rerank_score: 0.96, site_icon: '' },
  { title: '上海天气与出行提示', url: 'https://www.weather.com.cn/', site_name: '中国天气网', snippet: '今日上海空气质量良，早晚偏凉，注意增减衣物。', date: '2026-11-19', rerank_score: 0.91, site_icon: '' },
  { title: '11 月 19 日上海以多云为主', url: 'https://sh.cma.gov.cn/', site_name: '上海市气象局', snippet: '午后转晴，体感舒适。', date: '2026-11-19', rerank_score: 0.86, site_icon: '' },
  { title: '上海今日出行指数：适宜', url: 'https://www.eastday.com/', site_name: '东方网', snippet: '地铁客流平稳，建议错峰出行。', date: '2026-11-19', rerank_score: 0.81, site_icon: '' },
  { title: '今日上海昼夜温差较大', url: 'https://www.shanghai.gov.cn/', site_name: '上海发布', snippet: '请市民注意保暖。', date: '2026-11-19', rerank_score: 0.76, site_icon: '' },
];

function makeWav(seconds = 1.2, rate = 16000) {
  const n = Math.floor(seconds * rate);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i += 1) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i += 1) {
    const env = Math.min(1, i / 800, (n - i) / 800);
    v.setInt16(44 + i * 2, Math.sin((2 * Math.PI * 220 * i) / rate) * 0.22 * env * 32767, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

const split = (text, size) => {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};

export function createMockClient() {
  const client = {
    key: 'demo',
    direct: true,
    demo: true,
    base: 'https://api.deepseek.com',
    setKey() { },
    async serverInfo() {
      return { native: true, mock: true, demo: true, hasEnvKey: false, https: true, version: '1.0.0', urls: [], platform: 'android' };
    },

    async chat(body, { signal, onEvent } = {}) {
      const emit = async (chunk, delay) => {
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        await sleep(delay);
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        onEvent(chunk);
      };
      const base = { id: 'chatcmpl-demo', object: 'chat.completion.chunk', model: body?.model || 'deepseek-flash' };
      const piece = (delta) => ({ ...base, choices: [{ index: 0, delta, finish_reason: null }] });

      await emit(piece({ role: 'assistant', content: '' }), 120);
      for (const t of split(THINK, 14)) await emit(piece({ reasoning_content: t }), 55);

      const wantSearch = Array.isArray(body?.tools) && body.tools.some((t) => t.type === 'deepseek_web_search');
      if (wantSearch) {
        await emit(piece({ server_tool_calls: [{ id: 'call_demo_1', name: 'deepseek_web_search', input: { action: 'search', queries: ['上海今天天气'] }, kind: 'search' }] }), 260);
        await emit(piece({
          server_tool_calls: [{
            id: 'call_demo_1', tool_use_id: 'call_demo_1', name: 'deepseek_web_search', kind: 'search',
            content: RESULTS.slice(0, 3).map((r) => ({ ...r, site_icon: '' })),
          }],
        }), 320);
      }

      const paras = ANSWER.split('\n\n');
      const citations = [1, 2, 3];
      for (let i = 0; i < paras.length; i += 1) {
        const chunkSize = 10;
        for (const t of split(paras[i] + (i < paras.length - 1 ? '\n\n' : ''), chunkSize)) {
          await emit(piece({ content: t }), 28);
        }
      }
      for (const n of citations) {
        await emit(piece({ annotations: [{ type: 'web_search_result_location', url: RESULTS[n - 1].url, title: RESULTS[n - 1].title, cited_text: '' }] }), 40);
      }
      await emit({ ...base, choices: [{ index: 0, delta: { title: '上海今天天气怎么样' }, finish_reason: null }] }, 80);
      await emit({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'end_turn' }],
        usage: { prompt_tokens: 186, completion_tokens: 268, total_tokens: 454, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 186 },
      }, 60);
      onEvent({ done: true });
    },

    async search({ query }) {
      await sleep(420);
      return { results: RESULTS.map((r) => ({ ...r, summary: r.snippet, content: r.snippet, authority: 2 })) };
    },

    async fetchPage(url) {
      await sleep(320);
      return {
        title: '上海今日天气（演示）',
        content: `# 上海今日天气\n\n> 演示数据：真实环境中此内容来自 \`POST /v1/tools/fetch\`。\n\n上海今天多云转晴，气温 18～24℃，东北风 3 级。\n\n- 来源：${url}\n- 更新时间：2026-11-19 08:00\n`,
      };
    },

    async ocr() { return { text: '演示 OCR 结果' }; },

    async tts() { await sleep(260); return makeWav(); },

    async asr() { await sleep(500); return { text: '今天上海天气怎么样？', duration_ms: 2400, request_id: 'demo' }; },

    async uploadFile(file) { await sleep(600); return { id: 'file-api-demo', filename: file?.name || 'file', purpose: 'text_recognition' }; },

    async balance() {
      return { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '128.00', granted_balance: '128.00', topped_up_balance: '0.00' }] };
    },

    async models() { return { object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }; },
  };
  return client;
}
