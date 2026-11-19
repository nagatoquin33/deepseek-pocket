# API 映射与协议选择

Base URL：`https://api.deepseek.com`（浏览器不直连，统一经本机 `server.mjs` 的 `/api/*` 代理）。
鉴权：`Authorization: Bearer <API Key>`（代理从 `x-ds-key` 或 `Authorization` 读取，其次用环境变量）。

## 1. 协议对比与选择

| 维度 | Chat Completions（**本项目采用**） | Responses API | Anthropic Messages |
| --- | --- | --- | --- |
| 端点 | `POST /chat/completions` | `POST /responses` | `POST /anthropic/v1/messages` |
| 流式增量 | `choices[0].delta.{content, reasoning_content, annotations, server_tool_calls}` | 类型化事件（`response.output_text.delta` 等） | `content_block_delta` |
| 联网工具 | `tools:[{type:"deepseek_web_search",…}]` | `tools:[{type:"deepseek_web_search"}]`，另有原生 `web_search` | `web_search` 服务端工具 |
| 多轮 | 客户端回传完整 messages | 可 `store:true` + `previous_response_id` | 回传 content blocks |
| 视觉 | `image_url` content block | `input_image` | `image` block |
| 文件 | `{type:"file", file_id}` | `input_file` | `document` + beta 头 |

**结论**：三者能力等价（尤其检索与计费一致），差异只在报文形状与状态托管。
本项目选 Chat Completions 的原因：增量解析最简单；多轮/编辑重发/重新生成完全由客户端掌握（配合本地会话管理更自然）；OpenAI SDK 生态最广；无需额外处理服务端会话存储的隐私开关。

## 2. 对话请求（`chat.js#composeRequestBody`）

```json
{
  "model": "deepseek-flash",
  "messages": [
    {"role": "latest_reminder", "content": "2026-11-19,星期三,上海,App,中文"},
    {"role": "user", "content": "…或 [{type:'image_url',…},{type:'text',…}]"},
    {"role": "assistant", "content": "上一轮正文", "server_tool_calls": ["…原样回传…"]},
    {"role": "latest_reminder", "content": "2026-11-19,星期三,上海,App,中文"},
    {"role": "user", "content": "下一轮"}
  ],
  "stream": true,
  "stream_options": {"include_usage": true},
  "thinking": {"type": "enabled"},
  "reasoning_effort": "high",
  "tools": [
    {"type": "deepseek_web_search", "name": "deepseek_web_search"},
    {"type": "deepseek_read_url", "name": "deepseek_read_url"}
  ],
  "safety_check": {"level": "high"},
  "title": {"enabled": true}
}
```

规则与实现要点：

- `thinking` 优先于 `reasoning_effort`；关闭思考时发 `{"type":"disabled"}`。
- 声明 web 工具后，`temperature / top_p / stop / seed / n` 等会被服务端忽略（正常现象）。
- `title` 只在会话首轮开启；标题随最后一个 chunk 的 `delta.title` 返回，不额外计费。
- 关闭联网时不下发 `tools`（保留函数调用能力时可只删 `deepseek_web_search`）。
- 含图片时强制 `deepseek-flash`（V4 Pro 不支持视觉）。
- `latest_reminder` 必须紧邻其后的 user 消息；格式 `<date>,<weekday>,<location>,<platform>,<language>`。
- 续写（prefix completion）属 beta，UI 用「重新生成」替代，未启用。

## 3. 流式响应归一化（`chat.js#applyChunk` / `normalizeToolEvent`）

服务端可能给两种工具事件形状，解析器都接受：

```jsonc
// 调用
{"id":"call_1","name":"deepseek_web_search","input":{"action":"search","queries":["…"]},"kind":"search"}
{"id":"call_2","name":"deepseek_read_url","input":{"action":"read_link","url":"https://…"},"kind":"read_link"}
// 结果
{"tool_use_id":"call_1","content":[{"title":"…","url":"…","snippet":"…","site_name":"…","site_icon":"…","page_age":"…"}],"kind":"search"}
{"tool_use_id":"call_2","content":{"type":"web_fetch_result","url":"…","content":{"title":"…"},"published_at":null},"kind":"read_link"}
// 失败
{"tool_use_id":"call_1","content":[{"type":"web_search_tool_result_error","error_code":"unavailable"}]}
```

界面块：`think`（折叠面板 + 计时）、`tools`（查询词 / 结果卡片 / 打开网页 / 页内查找）、`text`（正文 + `[n]` 角标）。
`annotations` 元素形如 `{"type":"web_search_result_location","url":…,"title":…,"cited_text":…}`，按 URL 去重后编号，正文 `[n]` 渲染为角标，底部生成「参考来源」。

用量：最后一个 chunk 的 `usage`（`prompt_tokens / completion_tokens / total_tokens / prompt_cache_hit_tokens / prompt_cache_miss_tokens`），用于 message 底部 token 数与估算费用。

## 4. 其他端点

| 功能 | 请求 | 响应要点 |
| --- | --- | --- |
| 检索 | `POST /v1/tools/search` `{query,count,ori_question,need_content,localization}` | `results[]`：`title/url/snippet/summary/content/site_name/site_icon/date/authority/rerank_score`；计费 $0.75/千次成功请求，QPS 100 |
| 抓取 | `POST /v1/tools/fetch` `{url}` | `{title, content}`（Markdown）；计费 $0.75/千次；QPS 25 |
| 朗读 | `POST /v1/tools/tts` `{text,voice_id:"stella" 或 "tide",format:"wav" 或 "pcm",filter_markdown}` | `audio/wav` 流；≤10k 计费字符/次；支持 WebSocket 流式合成（本项目用整段 WAV，长文客户端分句） |
| 语音识别 | `POST /v1/tools/asr` multipart `file` | `{text,duration_ms,request_id}`；16-bit PCM WAV 或 Ogg Opus，≤8MiB、≤120s |
| 文档解析 | `POST /files` multipart，`purpose` 在前：`text_recognition` / `rich_layout_recognition` / `user_data` | `{id:"file-api-…", purpose, …}`；对话中用 `{type:"file",file_id}` 引用 |
| OCR | `POST /v1/tools/ocr` | 页面识别（前端已封装 `client.ocr`，当前 UI 未入口） |
| 余额 | `GET /user/balance` | `{is_available, balance_infos:[{currency,total_balance,granted_balance,topped_up_balance}]}` |
| 模型 | `GET /models` | 模型列表（UI 用内置文案，仅作能力探测） |

## 5. 错误处理约定

| 状态 | 前端行为 |
| --- | --- |
| 401 | 提示密钥失效并回到登录页（演示模式除外） |
| 402 | 提示余额不足，引导充值 |
| 429 / 503 / 504 | 提示稍后重试；`retryable` 标记 |
| 400 | 直接展示上游 `error.message`（字段非法时最有价值） |
| 0（网络） | 提示检查同一 Wi-Fi / 服务是否启动 / 防火墙 |

代理层对网络错误返回 `502` 与 `{error:{message,type:"upstream_error"}}`，其余状态原样透传。

## 6. 未接入但已预留

- **Responses API**：作为协议开关接入可复用 `chat.js` 的块模型，只需替换事件解析器；`store:false` + 完整 input 可保持无状态。
- **TTS WebSocket**（`wss://api.deepseek.com/v1/tools/tts`）：可做「边生成边朗读」，当前为整段合成。
- **FIM / JSON Output / Tool Calls（函数）**：对话场景未使用，API 客户端已具备透传能力。
- **OCR / Files 列表管理**：封装完成，UI 入口可后续补充。
