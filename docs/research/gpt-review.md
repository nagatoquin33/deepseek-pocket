# GPT 未提交改动审查（只读复核）

审查对象：`git diff` 的 11 个已改文件 + 未跟踪 `test/api.test.mjs`（基线 `d0e59c9`，工作区 v1.3.1）。
结论速览：整体方向正确（"流必须显式收到 `[DONE]` 才算完成"、跨会话串写、会话保存时机），但有 **3 处必须修**（`reader.cancel()` 引入的请求中断噪声/QA 回归、EOF 未冲刷残留 SSE 行导致的误报、重新生成被中断时丢弃已生成的部分回答）。未改动仓库任何文件。

## 0. 复现环境与命令

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 单测 | `node --test` | 211 pass / 0 fail（含新增 2 例），用时 2.3s |
| 单测（新文件） | `node --test test/api.test.mjs` | 2 pass / 0 fail |
| QA | `node server.mjs --mock --port 8898` + `QA_URL=… npm run qa` | 14 张截图，api-status 全 200；唯一 error：`requestfailed: /api/chat net::ERR_ABORTED` |
| 边界探针 | 直连 `public/js/api.js` + 伪造 `fetch` | 见 §2.1 表 |

环境注意：8899 端口被一个 **27 小时前启动的旧进程**（`server-info` 报 version 1.1.0）占用，故本轮改用 8898，QA 走 `QA_URL`。这属环境残留，不是代码问题。

## 1. 改动意图与逐项判定

| 文件 | 意图 | 判定 |
| --- | --- | --- |
| `public/js/api.js:75-114` | 流式收尾加固：区分"用户中止 / 传输中断 / 正常结束"，只在 `[DONE]` 算完成 | 方向对，细节见 §2 |
| `public/js/app.js` | 会话切换/流式中途的串写修复、保存时机前移与统一、发送键状态 | 正确（细节见 §3.2 S4/S5、§3.3） |
| `public/js/chat.js:481-504` | 错误提示从"替换正文"改为"追加在正文后"，保留已生成的部分回答 | 正确（顺序建议调整） |
| `public/js/chat.js:688-695` | `discardMessage(msg, session)` 显式指定目标会话 | 正确修复 |
| `public/index.html:86-90` + `public/css/app.css:1089-1122` | 欢迎页视觉：轨道圆环、副标题、品牌色渐变 | 正确（样式有小冗余） |
| `public/css/app.css:1135/1155-1156/1168-1170` | 输入卡聚焦品牌色、生成中隐藏语音键/保留停止键、侧栏阴影只在展开时 | 正确 |
| `public/sw.js:7` | `dsp-v1 → dsp-v2` 触发重新预缓存 | 正确且必要（index.html/css 变了） |
| `MainActivity.java:115` + `android/build.{sh,ps1}` | WebView 调试只在 debuggable 构建开启，`DEBUG_WEBVIEW=1` 传 `--debug-mode` | 正确（安全性提升）；`build.sh` 有 macOS 兼容隐患 |
| `.gitignore`、`docs/DEVELOPMENT.md:49` | 忽略参考 APK/解包目录、调试说明同步 | 正确 |
| `test/api.test.mjs` | 覆盖"收到 `[DONE]` 即完成"与"无 `[DONE]` 报中断且保留半截" | 有效但覆盖不全 |

## 2. api.js SSE 结束处理专项

### 2.1 `done` 时抛 `stream_interrupted` 会不会误报正常结束？

**会，但只在"EOF 前最后一行的 `[DONE]` 没有尾随换行"这一种形态。** 解析循环只在 `buf.indexOf('\n')` 处切行（`api.js:87`），`if (done) throw interrupted()`（`api.js:84`）之前没有冲刷 `buf` 与 `decoder`。实测：

| 构造的响应体 | 结果 |
| --- | --- |
| `data: [DONE]\r\n\r\n`（含正文块） | 正常，事件 `[…, {done:true}]` |
| `data: [DONE]\n\n` | 正常 |
| `…\n\ndata: [DONE]`（**无尾随换行**） | **误报 `stream_interrupted`**（已收到全部内容） |
| 空 200 响应 | `stream_interrupted`（符合预期） |
| 200 + 非流式 JSON | `stream_interrupted`（`composeRequestBody` 恒 `stream:true`，`chat.js:68`，实际不可达） |

真实 `api.deepseek.com` 以 `data: [DONE]\n\n` 收尾、`mock/deepseek-mock.mjs:264` 也是 `sendRaw('[DONE]')` 后才 `end()`，所以现网不易触发；但这是典型的 SSE 收尾解析缺陷，且新规则把"必须见到 `[DONE]`"变成了硬约束，一旦上游/Nginx/抓包重放少一个空行就会把完整回答标成"连接中断"。修法（`api.js:84` 前）：

```js
if (done) {
  buf += decoder.decode();                       // 冲刷多字节残留
  const tail = buf.trim();                       // 处理最后一行
  if (tail === 'data: [DONE]') { onEvent({ done: true }); return; }
  throw interrupted();
}
```

### 2.2 `reader.cancel()` 的副作用（必须修）

`api.js:97` 在 `[DONE]` 后 `void reader.cancel()` 会把仍在进行中的 `fetch` 请求主动取消，浏览器侧记为 **`net::ERR_ABORTED`**。已用 A/B 对照实测（临时目录复制 `public/`，`--public` 起 mock，puppeteer 只监听 `/api/chat` 的 requestfailed）：

| 变体 | `/api/chat` 请求失败 |
| --- | --- |
| 当前工作区（含 `reader.cancel()`） | **`net::ERR_ABORTED`** |
| 仅删掉 `reader.cancel()` 那一行 | 无 |
| `HEAD` 原版（读至 EOF） | 无 |

影响：① `npm run qa` 从"0 error"变成 1 条 error（`tools/qa/run.mjs` 把 requestfailed 计入 errors），QA 闸门出现假红；② 真机 DevTools/外部监控里每次正常对话都留一条 ERR_ABORTED；③ `lib/proxy.mjs:122-128` 会把"客户端断开"当作 `clientGone` 并 `abortUpstream()` 销毁上游 socket——`[DONE]` 之后通常无害，但属实多了一层竞态。既然服务端在 `[DONE]` 后立即 `res.end()`，这行没有必要：**直接删除**（`finally` 里的 `releaseLock()` 足够；实测删掉后 211 用例与 QA 均正常）。

### 2.3 `AbortError` 分支

- 主路径正确：`reader.read()` 的 `.catch` 把非 AbortError 统一转成 `ApiError(stream_interrupted)`，AbortError 原样抛出，`app.js:434` 据此走"已停止生成"分支。
- 风险 1：Safari/部分 WebView 中止流式读取时抛的是 `TypeError: Load failed` 而不是 `AbortError`，会被误判为"连接中断"。建议在 `api.js:171` 外包一层：`catch (e) { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); throw e; }`。
- 风险 2：用户点停止与 EOF 竞态——若 EOF 先到，抛出的是 `stream_interrupted`，界面变成红色错误气泡而不是"已停止生成"。同上修法（先判 `signal.aborted`）即可一并解决。

### 2.4 代理是否总补 `[DONE]`？

**不补。** `lib/proxy.mjs` 全程字节透传（`:284-299`），只在 `upstreamRes.on('end')` 时 `res.end()`；上游提前关闭时走 `:308-323` 或 `:300-305`（`res.destroy()`）。所以"客户端看到干净 EOF 却其实被打断"确实存在——这正是本次"无 `[DONE]` 即中断"改动的正当理由，`mock/deepseek-mock.mjs:264` 也证明 mock 侧始终有 `[DONE]`。结论：`done` 抛错的**设计是对的**，只需要补 §2.1 的冲刷。

## 3. 三类清单

### 3.1 必须修

| # | 文件:行 | 问题 | 建议改法 |
| --- | --- | --- | --- |
| M1 | `public/js/api.js:97` | `reader.cancel()` 让每次正常结束都产生 `net::ERR_ABORTED`，QA/监控假红（已 A/B 实测） | 删除该行；或改为不 abort 的收尾（保留 `finally` 的 `releaseLock()`） |
| M2 | `public/js/api.js:84`（配合 `:87`） | EOF 时不冲刷 `decoder`/残留 `buf`，`[DONE]` 无尾随换行时误报 `stream_interrupted` | 按 §2.1 代码片段补 EOF 冲刷与尾行判断 |
| M3 | `public/js/app.js:484-490` | 重新生成（`mergeInto`）遇 `stream_interrupted`/`empty_response` 时 `discardMessage(asst, session)` 把已生成的部分回答整条丢弃——旧行为会并入新版本，属数据丢失回归 | `mergeInto && (asst.content \|\| asst.reasoningContent)` 时走"并入新版本"分支，仅纯失败才丢弃 |

### 3.2 建议修

| # | 文件:行 | 问题 | 建议改法 |
| --- | --- | --- | --- |
| S1 | `public/js/api.js:171` | 中止错误跨浏览器形态不一 + 停止/EOF 竞态（§2.3） | `chat()` 中按 `signal.aborted` 归一成 `AbortError` |
| S2 | `public/js/api.js:102-108` | `json.error` 抛错路径既不 `cancel` 也不复用 `finally` 的 cancel，body 留到 GC | `finally` 中在未正常结束时 `reader.cancel().catch(() => {})` |
| S3 | `android/build.sh:49-52` | `set -euo pipefail`（`:9`）+ 空数组展开：bash < 4.4（macOS 自带 3.2）报 `unbound variable` | 用 `${DEBUG_ARGS[@]+"${DEBUG_ARGS[@]}"}`，或改用字符串 `DEBUG_ARG="${DEBUG_WEBVIEW:+--debug-mode}"` 后不加引号展开 |
| S4 | `public/js/app.js:512` | `!S.sessions.includes(s)` 直接 return：若 `switchSession` 用 `store.getSession()` 兜底拿到不在列表里的对象（`:161`），此后该会话**永不落盘** | 不在列表时先 `S.sessions.unshift(s)`（保留旧行为） |
| S5 | `public/js/app.js:353` + `:926-928` | 早存盘是 `void` 的；`clearAll` 先清列表再删库，在途写入仍可能把会话写回（低概率） | 给存储层加 epoch/串行队列，`clearAll` 后丢弃陈旧写入 |
| S6 | `public/js/chat.js:501-502` | 错误块排在 `renderSources()` 之后，视觉上"引用→报错" | 顺序改为 正文 → 错误 → 引用 |
| S7 | `public/css/app.css:1118` 与 `:294`；`:1116` 与 `:292` | `.welcome-sub`/`.welcome-mark` 重复定义，后者覆盖前者，后续维护易踩 | 合并到一处（移动端差异只留尺寸） |
| S8 | `docs/FAQ.md:54` | 仍写"APK 已开 WebView 调试"，与 `MainActivity.java:115` 新行为矛盾 | 改为"仅 `DEBUG_WEBVIEW=1` 的本地构建可 inspect" |
| S9 | `test/api.test.mjs` | 缺三个关键用例：用户 abort 透传、`[DONE]` 后立即 EOF 需正常返回、无 `[DONE]` 但 `finish_reason` 已到（可选） | 补 2 例即可锁住 M1/M2 的回归 |
| S10 | `android/build.sh:52` 周边 | `--debug-mode` 会写 `android:debuggable="true"`，产物不可分发 | 在 `docs/DEVELOPMENT.md:49` 补一句"勿分发 DEBUG_WEBVIEW 产物" |

### 3.3 可接受

- `app.js:353` 用户消息提前落盘（双写一次、侧栏排序略延后一个 await）——换来崩溃/切后台不丢提问，值得。
- `app.js:388/419-422/486-487/501` 的 `S.session === session` 守卫：正确修掉"生成中切走会话会改写当前画布"。
- `app.js:315-322` 发送键三元状态（busy→停止键可点、空闲且无输入→禁用），与 `:257` 的 `updateChrome` 公式一致，无冲突。
- `app.js:428-430` 空回答改用 `ApiError('empty_response')` 抛出：错误文案与 `handleApiError` 的 `status===0` 白名单（`:477`）配套，行为等价且更集中。
- `app.js:447` `await persistSession(session)` 替换 `persistCurrent()`：修掉"存了错误会话"的老 bug。
- `chat.js:481-502`：错误气泡保留部分回答，且 `:46` 仍把带 error 的助手消息排除在上下文之外（避免把半截答案回灌给模型）——可接受。
- `chat.js:688` 默认参数 `session = this.session`：向后兼容，无调用点需要改。
- `sw.js:7` 版本号递增：`install` 逐个 `cache.add().catch()`、`activate` 清旧缓存 + `claim()`，逻辑未动，安全。
- `MainActivity.java:115`：`minSdkVersion=24`（manifest）故删掉 `SDK_INT>=19` 判断安全；`ApplicationInfo.FLAG_DEBUGGABLE` 门控比"永远开调试"更正确。
- 欢迎页/输入卡 CSS 均为全局规则（文件末尾无外层 `@media` 包裹），桌面端不会缺样式；`@media (max-height:520px)` 隐藏轨道环对横屏矮窗合理。
- `index.html:86-90` 新增 `welcome-orbit`/`welcome-sub` 与 `aria-hidden` 用法规范。
- `.gitignore` 新增 `/参考/`、`/.ref/`：避免把官方 APK/解包产物入库，合理。

## 4. 背景说明（非缺陷）

- 现网 `[DONE]` 之后仍可能有尾随块（如 `usage`）——`public/js/chat.js` 的 `applyChunk` 已处理，`api.js` 的 `[DONE]` 即返回不会丢 `usage`，因为 mock/真实上游都把 `usage` 放在 `[DONE]` **之前**。
- `test/api.test.mjs:9` 用 `t.mock.method(globalThis, 'fetch')`：Node 22 下可行（211 例全绿即证），但取的是模块级 `fetch` 引用后调用，仍是全局解析，换到 Node 20 也成立。
- 本轮只读：未执行任何 `git add/commit/stash/checkout`；实验副本放在系统临时目录（`%TEMP%\ds-review`），未改仓库文件。
