/**
 * Mock 上游示例数据。
 * 与 docs/CONTRACTS.md 第一节的真实 API 字段保持同形，供前端离线演示与 e2e 使用。
 */

/** 生成小尺寸 SVG 图标（data URI），模拟搜索结果的 site_icon。 */
function svgIconDataUri(letter, background) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="8" fill="${background}"/>` +
    `<text x="16" y="22" font-family="system-ui,sans-serif" font-size="16" font-weight="600" ` +
    `text-anchor="middle" fill="#ffffff">${letter}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * 5 条示例搜索结果，字段与 POST /v1/tools/search 的真实返回一致。
 * @returns {Array<Record<string, unknown>>}
 */
export function sampleSearchResults() {
  const site = [
    { name: '上海天气网', letter: '天', color: '#2f7cf6', url: 'https://www.weather.com.cn/shanghai', snippet: '上海今天多云转晴，18～24℃，东北风 3 级。' },
    { name: '中国天气网', letter: '中', color: '#0ea5a4', url: 'https://www.weather.com.cn/', snippet: '今日上海空气质量良，早晚偏凉，注意增减衣物。' },
    { name: '上海市气象局', letter: '气', color: '#7c4dff', url: 'https://sh.cma.gov.cn/', snippet: '11 月 19 日上海以多云为主，午后转晴，体感舒适。' },
    { name: '东方网', letter: '东', color: '#ef4444', url: 'https://www.eastday.com/', snippet: '上海今日出行指数：适宜。地铁客流平稳，建议错峰出行。' },
    { name: '上海发布', letter: '上', color: '#f59e0b', url: 'https://www.shanghai.gov.cn/', snippet: '今日上海昼夜温差较大，请市民注意保暖。' },
  ];
  return site.map((item, index) => ({
    rerank_score: Number((0.96 - index * 0.05).toFixed(3)),
    title: index === 0 ? '上海今日天气：多云转晴，18～24℃' : `上海天气与出行提示（${index + 1}）`,
    url: item.url,
    snippet: item.snippet,
    summary: `${item.name}：${item.snippet}`,
    content: `${item.name}报道：${item.snippet} 数据更新于 2026-11-19 08:00。`,
    site_name: item.name,
    site_icon: svgIconDataUri(item.letter, item.color),
    date: '2026-11-19',
    authority: Number((0.9 - index * 0.08).toFixed(2)),
  }));
}

/** 思考过程增量文本（模拟 reasoning_content 多块） */
export const REASONING_CHUNKS = [
  '用户问的是“今天上海天气怎么样”。',
  '我需要先搜索当天上海的实时天气，',
  '再结合气温与风力给出出行建议。',
  '回答中要标注信息来源，方便用户核对。',
];

/** 正文增量文本（含 [1][2][3] 引用角标） */
export const ANSWER_CHUNKS = [
  '上海今天',
  '（11 月 19 日）',
  '多云转晴',
  '，气温约 ',
  '18～24℃',
  '[1]',
  '。',
  '上午云量较多',
  '，下午阳光不错',
  '；',
  '东北风 3 级',
  '，体感舒适',
  '，适合外出',
  '[2]',
  '。\n\n',
  '建议：',
  '早晚偏凉',
  '，带一件薄外套',
  '；',
  '空气质量良',
  '，可正常通勤和户外活动',
  '[3]',
  '。',
];

/** 引用信息（annotations） */
export function sampleAnnotations() {
  return [
    {
      type: 'web_search_result_location',
      url: 'https://www.weather.com.cn/shanghai',
      title: '上海今日天气：多云转晴，18～24℃',
      cited_text: '上海今天多云转晴，18～24℃，东北风 3 级。',
    },
    {
      type: 'web_search_result_location',
      url: 'https://sh.cma.gov.cn/',
      title: '上海市气象局：11 月 19 日天气实况',
      cited_text: '11 月 19 日上海以多云为主，午后转晴，体感舒适。',
    },
    {
      type: 'web_search_result_location',
      url: 'https://www.eastday.com/',
      title: '东方网：今日上海出行指数',
      cited_text: '上海今日出行指数：适宜。地铁客流平稳，建议错峰出行。',
    },
  ];
}

/** 会话标题（delta.title） */
export const SAMPLE_TITLE = '上海今日天气与出行建议';

/** ASR 固定识别结果 */
export const ASR_TEXT = '今天上海天气怎么样？';

/** OCR 固定识别结果 */
export const OCR_TEXT = '识别的文字：上海今日多云转晴，气温 18～24℃。';

/** 抓取网页的示例 Markdown */
export function sampleFetchedPage(url) {
  return {
    title: '上海天气与出行指南（Mock）',
    content:
      `# 上海天气与出行指南\n\n` +
      `> 来源：${url}\n\n` +
      `## 今日天气\n\n` +
      `- 天气：多云转晴\n- 气温：18～24℃\n- 风力：东北风 3 级\n- 空气质量：良\n\n` +
      `## 出行建议\n\n` +
      `1. 早晚偏凉，建议携带薄外套。\n2. 午后适合户外活动，注意补水。\n3. 地铁客流平稳，可错峰出行。\n\n` +
      `\`\`\`js\nconsole.log('上海天气不错');\n\`\`\`\n`,
  };
}

/**
 * 生成 1 秒 24kHz 单声道 16-bit 正弦波 WAV（合法 RIFF 头，带淡入淡出避免爆音）。
 * @param {{seconds?: number, sampleRate?: number, frequency?: number, amplitude?: number, fadeSeconds?: number}} [options]
 * @returns {Buffer}
 */
export function createSineWav(options = {}) {
  const {
    seconds = 1,
    sampleRate = 24_000,
    frequency = 440,
    amplitude = 0.28,
    fadeSeconds = 0.02,
  } = options;
  const sampleCount = Math.max(1, Math.round(sampleRate * seconds));
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // fmt 块长度
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // 单声道
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // 位深
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  const fadeSamples = Math.max(1, Math.round(sampleRate * fadeSeconds));
  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / sampleRate;
    let envelope = 1;
    if (i < fadeSamples) envelope = i / fadeSamples;
    else if (i > sampleCount - fadeSamples) envelope = (sampleCount - i) / fadeSamples;
    const sample = Math.sin(2 * Math.PI * frequency * t) * amplitude * envelope;
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), 44 + i * 2);
  }
  return buffer;
}
