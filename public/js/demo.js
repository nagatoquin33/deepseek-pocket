/* =========================================================================
 * demo.js —— 离线演示数据（?seed=1 时载入），同时用于视觉回归截图
 * 结构与真实流式结果一致：think / tools / text 三类块 + 引用 + 用量
 * ========================================================================= */

export function buildDemoSession() {
  const now = Date.now();
  const t = (min) => now - min * 60 * 1000;

  return {
    id: 'demo_session_1',
    title: 'DeepSeek V4.1 有哪些提升',
    createdAt: t(28),
    updatedAt: t(1),
    pinned: false,
    model: 'deepseek-flash',
    thinking: true,
    webSearch: true,
    effort: 'high',
    titleGenerated: true,
    messages: [
      {
        id: 'demo_u1',
        role: 'user',
        content: 'DeepSeek V4.1 相比上一代有什么提升？顺便用 Python 写个流式调用示例。',
        createdAt: t(27),
        status: 'done',
      },
      {
        id: 'demo_a1',
        role: 'assistant',
        createdAt: t(26),
        content: `## 核心提升

DeepSeek V4.1（对应模型名 \`deepseek-flash\`，底层版本 DeepSeek-V4.1-Flash-1017）主要在三个方面做了升级：

1. **上下文与输出更长**：上下文提升到 **1M tokens**，单次最大输出 **384K**，长文档与大型代码库可以一次性读完[1]。
2. **推理更稳**：思考模式默认开启，支持 \`low / high / max\` 三档强度，可通过 \`reasoning_effort\` 调节；同等准确率下平均思考步数下降约 18%[2]。
3. **能力更全**：原生支持视觉输入、工具调用、JSON 输出与 FIM 补全；联网搜索改为服务端工具，检索与读页不再单独计费[3]。

| 能力 | V4.1 Flash | V4 Pro |
| --- | --- | --- |
| 上下文 | 1M | 1M |
| 最大输出 | 384K | 384K |
| 视觉输入 | 支持 | 不支持 |
| 输入价格（缓存未命中） | $0.15 / 1M | $0.66 / 1M |

## 推理流程

\`\`\`mermaid
graph TD
  A[用户提问] --> B{需要联网吗}
  B -- 是 --> C[搜索网页]
  B -- 否 --> D[直接推理]
  C --> E[阅读来源]
  E --> F[带引用作答]
  D --> F
\`\`\`

## 流式调用示例

\`\`\`python
from openai import OpenAI

client = OpenAI(api_key="sk-...", base_url="https://api.deepseek.com")

stream = client.chat.completions.create(
    model="deepseek-flash",
    messages=[{"role": "user", "content": "用一句话解释注意力机制"}],
    reasoning_effort="high",
    extra_body={"thinking": {"type": "enabled"}},
    stream=True,
)

for chunk in stream:
    delta = chunk.choices[0].delta
    if getattr(delta, "reasoning_content", None):
        print(delta.reasoning_content, end="")   # 思考过程
    if delta.content:
        print(delta.content, end="")              # 最终回答
\`\`\`

> 小提示：开启联网搜索时，温度、top_p 等采样参数会被服务端忽略，属于正常现象。

如果要严格复现答案，可以把 \`temperature\` 设为 0.2 左右——但在思考模式下该参数不生效。`,
        reasoningContent: '用户想要两件事：一是 V4.1 的升级点，二是 Python 流式示例。升级点需要联网确认，避免用过时信息；示例代码要能直接跑，注意 extra_body 传 thinking 参数，以及 reasoning_content 字段的读取方式。表格用三列足够，价格取缓存未命中价更直观。',
        blocks: [
          {
            type: 'think',
            text: '用户想要两件事：一是 V4.1 相比上一代的提升，二是 Python 流式调用示例。升级点涉及版本信息，应当检索官方发布说明，避免用过时资料。示例代码要能直接运行：注意 OpenAI SDK 需要把 thinking 放进 extra_body，流式读取时要分别处理 reasoning_content 与 content。价格部分取缓存未命中价，用表格更直观。',
            start: t(26),
            end: t(26) + 9400,
          },
          {
            type: 'tools',
            steps: [
              {
                id: 'demo_t1',
                name: 'deepseek_web_search',
                action: 'search',
                kind: 'deep_search',
                queries: ['DeepSeek V4.1 升级 上下文 输出长度', 'DeepSeek V4.1 Flash 价格 思考强度'],
                url: '',
                pattern: '',
                results: [
                  { url: 'https://api-docs.deepseek.com/news/news261017/', title: 'DeepSeek V4.1 发布：1M 上下文与 384K 输出', site: 'DeepSeek', icon: '', snippet: '', pageAge: '2026-10-17' },
                  { url: 'https://api-docs.deepseek.com/quick_start/pricing', title: 'Models & Pricing', site: 'DeepSeek API Docs', icon: '', snippet: '', pageAge: '2026-11-01' },
                  { url: 'https://github.com/deepseek-ai/DeepSeek-V4', title: 'deepseek-ai/DeepSeek-V4', site: 'GitHub', icon: '', snippet: '', pageAge: '2026-10-20' },
                ],
                error: '',
                done: true,
              },
              {
                id: 'demo_t2',
                name: 'deepseek_read_url',
                action: 'open_page',
                kind: 'deep_search',
                queries: [],
                url: 'https://api-docs.deepseek.com/news/news261017/',
                pattern: '',
                results: [
                  { url: 'https://api-docs.deepseek.com/news/news261017/', title: 'DeepSeek V4.1 发布说明', site: 'DeepSeek', icon: '', snippet: '', pageAge: '2026-10-17' },
                ],
                error: '',
                done: true,
              },
            ],
          },
          {
            type: 'text',
            text: `## 核心提升

DeepSeek V4.1（对应模型名 \`deepseek-flash\`，底层版本 DeepSeek-V4.1-Flash-1017）主要在三个方面做了升级：

1. **上下文与输出更长**：上下文提升到 **1M tokens**，单次最大输出 **384K**，长文档与大型代码库可以一次性读完[1]。
2. **推理更稳**：思考模式默认开启，支持 \`low / high / max\` 三档强度，可通过 \`reasoning_effort\` 调节；同等准确率下平均思考步数下降约 18%[2]。
3. **能力更全**：原生支持视觉输入、工具调用、JSON 输出与 FIM 补全；联网搜索改为服务端工具，检索与读页不再单独计费[3]。

| 能力 | V4.1 Flash | V4 Pro |
| --- | --- | --- |
| 上下文 | 1M | 1M |
| 最大输出 | 384K | 384K |
| 视觉输入 | 支持 | 不支持 |
| 输入价格（缓存未命中） | $0.15 / 1M | $0.66 / 1M |

## 推理流程

\`\`\`mermaid
graph TD
  A[用户提问] --> B{需要联网吗}
  B -- 是 --> C[搜索网页]
  B -- 否 --> D[直接推理]
  C --> E[阅读来源]
  E --> F[带引用作答]
  D --> F
\`\`\`

## 流式调用示例

\`\`\`python
from openai import OpenAI

client = OpenAI(api_key="sk-...", base_url="https://api.deepseek.com")

stream = client.chat.completions.create(
    model="deepseek-flash",
    messages=[{"role": "user", "content": "用一句话解释注意力机制"}],
    reasoning_effort="high",
    extra_body={"thinking": {"type": "enabled"}},
    stream=True,
)

for chunk in stream:
    delta = chunk.choices[0].delta
    if getattr(delta, "reasoning_content", None):
        print(delta.reasoning_content, end="")   # 思考过程
    if delta.content:
        print(delta.content, end="")              # 最终回答
\`\`\`

> 小提示：开启联网搜索时，温度、top_p 等采样参数会被服务端忽略，属于正常现象。

如果要严格复现答案，可以把 \`temperature\` 设为 0.2 左右——但在思考模式下该参数不生效。`,
            citations: [
              { url: 'https://api-docs.deepseek.com/news/news261017/', title: 'DeepSeek V4.1 发布：1M 上下文与 384K 输出' },
              { url: 'https://api-docs.deepseek.com/guides/thinking_mode', title: 'Thinking Mode · DeepSeek API Docs' },
              { url: 'https://api-docs.deepseek.com/guides/web_tools', title: 'Web Tools · DeepSeek API Docs' },
            ],
          },
        ],
        annotations: [
          { url: 'https://api-docs.deepseek.com/news/news261017/', title: 'DeepSeek V4.1 发布：1M 上下文与 384K 输出' },
          { url: 'https://api-docs.deepseek.com/guides/thinking_mode', title: 'Thinking Mode · DeepSeek API Docs' },
          { url: 'https://api-docs.deepseek.com/guides/web_tools', title: 'Web Tools · DeepSeek API Docs' },
        ],
        citations: [],
        serverToolCalls: [],
        usage: { prompt_tokens: 1890, completion_tokens: 642, total_tokens: 2532, prompt_cache_hit_tokens: 1024, prompt_cache_miss_tokens: 866 },
        title: 'DeepSeek V4.1 有哪些提升',
        model: 'deepseek-flash',
        reasoningStart: t(26),
        reasoningEnd: t(26) + 9400,
        finishReason: 'end_turn',
        refusal: '',
        status: 'done',
        error: '',
        feedback: '',
      },
      {
        id: 'demo_u2',
        role: 'user',
        content: '很好，那 1M 上下文大概能放多少本书？',
        createdAt: t(6),
        status: 'done',
      },
      {
        id: 'demo_a2',
        role: 'assistant',
        createdAt: t(5),
        content: `按中文平均每字约 0.6–0.7 个 token 估算，1M tokens 大约相当于 **60–80 万汉字**。

一本 30 万字的书约 20 万 tokens，因此 1M 上下文大概能放下 **4–5 本**这样的书；如果是短篇小说集，可以放十几本。

不过实际可用长度还要扣掉输出预留（默认 64K，\`reasoning_effort=max\` 时 128K），所以稳妥的阅读量建议按 **80%** 估算。`,
        reasoningContent: '',
        blocks: [
          {
            type: 'text',
            text: `按中文平均每字约 0.6–0.7 个 token 估算，1M tokens 大约相当于 **60–80 万汉字**。

一本 30 万字的书约 20 万 tokens，因此 1M 上下文大概能放下 **4–5 本**这样的书；如果是短篇小说集，可以放十几本。

不过实际可用长度还要扣掉输出预留（默认 64K，\`reasoning_effort=max\` 时 128K），所以稳妥的阅读量建议按 **80%** 估算。`,
            citations: [],
          },
        ],
        annotations: [],
        citations: [],
        serverToolCalls: [],
        usage: { prompt_tokens: 3120, completion_tokens: 96, total_tokens: 3216, prompt_cache_hit_tokens: 2800, prompt_cache_miss_tokens: 320 },
        model: 'deepseek-flash',
        reasoningStart: 0,
        reasoningEnd: 0,
        finishReason: 'end_turn',
        refusal: '',
        status: 'done',
        error: '',
        feedback: '',
      },
    ],
  };
}
