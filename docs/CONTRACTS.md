# 模块契约（冻结版 v1）

项目：DeepSeek 随身版 —— 手机端 DeepSeek 应用（PWA）+ 局域网代理服务。
根目录：`D:\ai\deepseek-mobile`。零构建、零打包：浏览器原生 ES Module。
Node ≥ 20（本机 v22）。除 `qrcode`（仅服务端可选）外不得引入运行时依赖；不得使用 TypeScript、打包器、框架。

## 文件所有权（不要改别人的文件）

| 归属 | 文件 |
| --- | --- |
| 后端队友 backend | `server.mjs`、`lib/**`、`mock/**`、`tools/gen-cert.mjs`、`test/server.test.mjs`、`package.json`、`.gitignore` |
| 渲染队友 render | `public/js/render.js`、`test/render.test.mjs` |
| Lead | `public/index.html`、`public/css/app.css`、`public/js/{app,api,store,voice,chat,search,settings,sidebar,ui,i18n}.js`、`public/manifest.webmanifest`、`public/sw.js`、`public/icons/**`、`README.md`、`docs/**` |

如需改别人的文件：先发消息给 Lead，不要直接改。

## 一、DeepSeek 开放平台 API 事实（2026-11 文档）

- Base URL：`https://api.deepseek.com`（OpenAI 兼容）。鉴权：`Authorization: Bearer <API key>`。
- 模型：`deepseek-flash`（默认，支持视觉）、`deepseek-v4-pro`。
- 对话：`POST /chat/completions`，SSE 流式，`data: [DONE]` 结束。
  - 思考开关：`{"thinking":{"type":"enabled"|"disabled"}}`；强度：`reasoning_effort: low|high|max`。
  - 思考内容：`choices[0].delta.reasoning_content`（增量）/ `message.reasoning_content`（最终）。
  - 正文：`delta.content`。
  - 服务端联网工具：`tools:[{"type":"deepseek_web_search","name":"deepseek_web_search"},{"type":"deepseek_read_url","name":"deepseek_read_url"}]`。
  - 引用：`delta.annotations[]` / `message.annotations[]`，元素形如
    `{"type":"web_search_result_location","url":..,"title":..,"cited_text":..}`。
  - 服务端工具调用（Chat Completions 扩展）：`delta.server_tool_calls[]` / `message.server_tool_calls[]`，
    每项最少含 `{id, name, input:{action:"search"|"open_page"|"find_in_page"|"read_link", queries?, url?, pattern?}, kind:"search"|"deep_search"|"read_link"|"image_search"|"deep_image_search"}`；
    结果项形如 `{tool_use_id, content:[{title,url,snippet,site_name,site_icon,page_age}], kind}` 或
    `{tool_use_id, content:{url,title,published_at}, kind}`；失败含 `error_code`。
    解析必须宽容：两种形状都要接受，缺字段不报错。
  - 标题：请求 `{"title":{"enabled":true}}`，最后 chunk `delta.title`，也可能 `message.title`。
  - 安全审核：`{"safety_check":{"level":"high"}}`；拒绝时 `finish_reason:"refusal"`、`message.refusal`。
  - 用量：最后 chunk `usage`：`prompt_tokens, completion_tokens, total_tokens, prompt_cache_hit_tokens, prompt_cache_miss_tokens, prompt_tokens_details.cached_tokens`。
  - 图片：`content` 用数组 `[{type:"image_url",image_url:{url:"data:image/jpeg;base64,..."}},{type:"text",text:"..."}]`。
  - 文件：`{type:"file",file_id:"file-api-..."}`，需先 `POST /files`（multipart，字段顺序 `purpose` 在前、`file` 在后）。
  - 用户元信息（每条 user 之前）：`{"role":"latest_reminder","content":"2026-11-19,Wednesday,上海,App,中文"}`。
- 检索：`POST /v1/tools/search` `{query,count,ori_question?,localization?,need_content?}` →
  `{results:[{rerank_score,title,url,snippet,summary,content,site_name,site_icon,date,authority}]}`。
- 抓取：`POST /v1/tools/fetch` `{url}` → `{title,content}`（Markdown）。
- TTS：`POST /v1/tools/tts` `{text,voice_id:"stella"|"tide",format:"wav"|"pcm",filter_markdown}` → `audio/wav` 二进制。
- ASR：`POST /v1/tools/asr` multipart `file`（16-bit PCM WAV 或 Ogg Opus，≤8MiB，≤120s）→ `{text,duration_ms,request_id}`。
- 余额：`GET /user/balance` → `{is_available,balance_infos:[{currency,total_balance,granted_balance,topped_up_balance}]}`。
- 模型列表：`GET /models`。OCR：`POST /v1/tools/ocr`。

**没有 OAuth**：开放平台不提供第三方授权登录，「一键登录」= 粘贴/扫码/本机预置 API Key 后一键校验并保存。

## 二、后端契约（server.mjs）

启动：`node server.mjs [--port 8787] [--host 0.0.0.0] [--https] [--mock] [--portable]`
环境变量：`DEEPSEEK_API_KEY`（可选，服务端预置密钥 → 手机端零输入一键登录）、`DEEPSEEK_BASE_URL`（测试用，默认 `https://api.deepseek.com`）、`PORT`、`HOST`、`MOCK=1`。

HTTP 路由（同源，无 CORS 需求；带 `Origin` 时校验与 Host 同源）：

- `GET /healthz` → `{ok:true,name,version,uptime,mock}`
- `GET /api/server-info` → `{version,https,port,hasEnvKey,mock,urls:[{ip,url}],platform}`
- `POST /api/chat`：body 原样转发 `POST {BASE}/chat/completions`（流式透传 SSE，逐块 flush；客户端断开时 abort 上游）。
- `POST /api/tools/search`、`POST /api/tools/fetch`、`POST /api/tools/ocr`：JSON 透传。
- `POST /api/tools/tts`：JSON 透传，返回 `audio/wav` 字节流（`Content-Type` 沿用上游）。
- `POST /api/tools/asr`：multipart 流式透传（不要缓冲整个文件）。
- `POST /api/files`：multipart 流式透传，超时 300s。
- `GET /api/user/balance`、`GET /api/models`：GET 透传。
- `GET /api/qr?data=<url>` → `image/png`（qrcode 生成；data 仅允许本站 host/局域网 IP，否则 400）。
- 静态：`public/` 下文件，正确 MIME；未知路径回退 `index.html`（SPA）；禁止 `..` 穿越；`/sw.js` 加 `Cache-Control: no-cache`。
- 401 统一 JSON：`{error:{message,type:"authentication_error"}}`；上游错误原样透传状态码 + JSON。

密钥优先级：请求头 `x-ds-key` > `Authorization: Bearer` > 环境变量。任何日志/错误信息都不得包含密钥。

安全头：CSP `default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://api.deepseek.com; frame-ancestors 'none'; base-uri 'self'`、
`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`。
限流：每 IP 每分钟 180 次 API 请求，超限 429。
体积上限：`/api/chat` 64MB、`/api/files` 110MB、`/api/tools/asr` 10MB，其余 2MB。
HTTPS：`--https` 时读 `.tls/cert.pem`+`.tls/key.pem`；缺失则调用 `tools/gen-cert.mjs`（openssl，SAN 覆盖 localhost+所有局域网 IPv4）；失败则打印说明并回退 HTTP。启动时终端打印手机访问 URL 与二维码（qrcode 未安装则跳过，不影响运行）。

Mock 模式（`--mock`）：`mock/deepseek-mock.mjs` 完整模拟上述上游端点，供离线演示与 e2e：
- 流式：reasoning_content 若干块 → server_tool_calls(search) → 结果 → 正文含 `[1][2]` 引用 → annotations → 标题 → usage → `[DONE]`，块间 15–30ms。
- TTS 返回 1 秒 24kHz 单声道 16-bit 正弦 WAV；ASR 固定返回「今天上海天气怎么样？」；balance 返回 ¥110；search 返回 5 条示例（含 site_name/site_icon 为 data:image/svg 小图标）；files 返回 `file-api-mock`。

测试 `test/server.test.mjs`（node:test + 随机端口）：健康检查、server-info、静态首页 200 且 CSP 存在、路径穿越 403/404、无密钥 401、mock SSE 收到 thinking/search/citations/usage/title 与 `[DONE]`、tts 返回 RIFF、asr 返回 text、balance 字段、`/api/qr` 合法/非法、日志不含密钥。
完成标准：`node --test test/server.test.mjs` 全绿；`node server.mjs --mock` 可跑；无依赖缺失。

## 三、渲染契约（public/js/render.js）

纯 ESM、无依赖、浏览器与 Node 均可直接 `import`。导出：

```js
export function escapeHtml(s: string): string
export function highlight(code: string, lang?: string): string   // 返回已转义的安全 HTML
export function renderMath(tex: string, display?: boolean): string
export function renderMarkdown(md: string, opts?: {
  citeNumbers?: Set<number>          // 出现 [n] 且 n 在集合内 → 引用角标
  highlight?: boolean                // 默认 true
  math?: boolean                     // 默认 true
}): string
```

要求：
1. **XSS 安全**：模型输出中的 HTML 一律转义，不允许原样透传；URL 仅允许 `https:`、`http:`、`mailto:`、`tel:`、`#` 及 `data:image/*`；链接加 `target="_blank" rel="noopener noreferrer nofollow"`；不得输出 `on*` 属性。
2. 代码块：`<div class="code-block" data-lang="js"><div class="code-hd"><span class="code-lang">JavaScript</span><button class="code-copy" type="button" aria-label="复制代码">复制</button></div><pre><code>…</code></pre></div>`；未闭合围栏（流式截断）也要正常渲染。
3. 支持 GFM：标题、粗斜体、删除线、行内代码、围栏代码、有序/无序/嵌套列表、任务列表、引用、分隔线、表格（含对齐）、链接、图片（懒加载）、自动链接、硬换行、脚注可省略。
4. 数学：`$...$`、`$$...$$`、`\(...\)`、`\[...\]`；`renderMath` 覆盖 `\frac \sqrt ^{-} _{-} \sum \int \prod \lim \times \cdot \pm \le \ge \ne \approx \infty \pi \alpha…\omega \text \mathrm \mathbf \left \right` 与希腊字母；未知命令降级为 `<code class="math-fallback">`。数学/代码块内部不再解析 Markdown。
5. 引用角标：正文 `[1]` 且 `opts.citeNumbers.has(1)` → `<a class="cite" data-cite="1" href="#ref-1">1</a>`。
6. 性能：≤ 8KB 文本单次渲染 < 20ms（不要求流式增量，但不得 O(n²) 拼接字符串）。
7. 测试 `test/render.test.mjs`：XSS（`<script>`、`<img onerror>`、`javascript:`、`<iframe>`、`<svg onload>`）、代码围栏转义与语言标签、表格、嵌套列表、引用、任务列表、行内代码含反引号、未闭合围栏、数学公式、引用角标、`escapeHtml`。测试用 `assert` 检查关键片段与「不含危险片段」。

## 四、联调接口（Lead 提供，队友只需遵循）

`public/js/api.js`（Lead 写）：
```js
createClient({key, base:'/api'}) -> {
  chat(body, {signal, onChunk}) -> Promise<final>,
  search(q, {count, needContent}), fetchPage(url), tts(text, voice), asr(blob),
  balance(), models(), uploadFile(file, purpose), serverInfo()
}
```
`public/js/store.js`：会话与设置持久化。`public/js/voice.js`：录音与 TTS 播放。

## 五、验收（Lead 负责）

- `node --test` 全绿；`node server.mjs --mock` 启动；手机同网段可访问（HTTPS 下麦克风可用）。
- Chrome headless 截图：登录页、欢迎页、对话（思考+搜索+引用+代码）、侧栏、设置、搜索页。
- README 中文：登录方式、手机安装、语音、搜索、会话管理、费用、隐私、限制。
