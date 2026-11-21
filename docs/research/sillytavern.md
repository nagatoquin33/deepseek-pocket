# SillyTavern 移动端交互与提示词管理研究

> 取样：2026-11-21 用 `npx --yes degit SillyTavern/SillyTavern .ref/tavern` 取 main HEAD（约 59 MB，`public/scripts` 345 个文件），未运行 git；同时抓取 docs.sillytavern.app。行号基于该快照，链接指向 GitHub `main` 的对应文件。本文只做源码/文档分析，未在真机跑 ST。

## 0. 一句话结论

ST 是「桌面优先 + 移动补丁」的 Web 应用：桌面靠 hover/悬浮面板，移动靠 `@media (max-width:1000px)` 把面板变全屏抽屉、放大字号、把低频动作收进 `...`、用长按替代右键。提示词侧是一套**显式的有序块 + 深度注入流水线**，配 dry-run token 预算与「块级 token 数」，把"发了什么、还剩多少预算"直接摆在界面上。

## 1. Swipe（滑动换回复）

- **数据模型**：每条 AI 消息 `swipes[]` + `swipe_id` + `swipe_info[]`，顶层 `mes` 永远是当前版本的投影；`ensureSwipes` 兼容无 swipes 的旧数据（[script.js:6833](https://github.com/SillyTavern/SillyTavern/blob/main/public/script.js#L6833)）。
- **UI**：`.swipe_left` 绝对定位在左侧中部；`.swipeRightBlock` 固定右下、竖排 `chevron-right` + `.swipes-counter`（[index.html:7402](https://github.com/SillyTavern/SillyTavern/blob/main/public/index.html#L7402)、[7466-7468](https://github.com/SillyTavern/SillyTavern/blob/main/public/index.html#L7466)）。计数器格式 `当前/总数`，用 U+200B 零宽空格分隔防换行（[script.js:9935](https://github.com/SillyTavern/SillyTavern/blob/main/public/script.js#L9935)）；默认 opacity .3，末版 `.last_swipe` 提到 .7，`--swipeCounterHeight: 15px`（[style.css:1229-1327](https://github.com/SillyTavern/SillyTavern/blob/main/public/style.css#L1229)）。
- **可见性规则**：单版本时左箭头隐藏、只有可滑消息显示（`.swipes_visible`）；开关 "Swipe # for All Messages" 打开后 `body.swipeAllMessages` 让所有消息显示计数器（[style.css:1309-1357](https://github.com/SillyTavern/SillyTavern/blob/main/public/style.css#L1309)、[script.js:9275](https://github.com/SillyTavern/SillyTavern/blob/main/public/script.js#L9275)）。
- **手势**：`lib/swiped-events.js` 监听 touchstart/move/end，默认 **20px 位移 + 500ms** 判定，支持 `data-swipe-ignore` / `data-swipe-threshold` / `-unit` / `-timeout`（[swiped-events.js:49-73](https://github.com/SillyTavern/SillyTavern/blob/main/public/lib/swiped-events.js#L49)）。`swiped-left/right` 在手机上被翻译成点击 `.last_mes` 的箭头，且有 4 个前置条件：手势开关开、无弹窗、事件在 `#sheld` 内、不在编辑态（[RossAscends-mods.js:909/933](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/RossAscends-mods.js#L909)）。
- **动画**：整条消息用 Web Animations 位移 ±宽度（`animateSwipeTransition` [script.js:10169](https://github.com/SillyTavern/SillyTavern/blob/main/public/script.js#L10169)），先滑出 → 换内容/触发生成 → 从反方向滑入（`animateSwipe` [10271](https://github.com/SillyTavern/SillyTavern/blob/main/public/script.js#L10271)）；连续快滑用 sigmoid 缩短时长（`getSwipeDuration` 10014 附近），避免"手快时动画拖沓"。生成中禁止滑动并 toast。
- **越界 overswipe**：`NONE / LOOP / REGENERATE / EDIT_GENERATE / PRISTINE_GREETING`（[constants.js:147](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/constants.js#L147)）。末版右滑=重新生成（保留旧版），用户消息=循环，首条问候永远显示双箭头；生成中/编辑中/被隐藏的消息不显示箭头。
- **版本历史弹层**：`swipe-picker.js` 提供"跳到某次 swipe"列表（带 token、时间、可"用此版本建分支"）。桌面点计数器/书签图标，**移动端长按计数器 500ms**（`addLongPressEvent` [utils.js:3098](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/utils.js#L3098)、[swipe-picker.js:412-428](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/swipe-picker.js#L412)）。
- **可迁移点**：计数器既是状态又是入口（点/长按打开历史），这是低成本高价值的细节。

## 2. 消息操作菜单的层级与触达

三级结构（[index.html:7409-7450](https://github.com/SillyTavern/SillyTavern/blob/main/public/index.html#L7409)）：

1. **常驻 3 个**：`...`（Message Actions）、checkpoint 旗标（仅有 checkpoint 时出现）、编辑铅笔。
2. **`...` 展开的 12 个次要动作**：翻译、SD 生图、朗读、Prompt、隐藏/取消隐藏（是否进上下文）、媒体样式、附件、swipe 历史、建检查点、建分支、复制（[7424-7434](https://github.com/SillyTavern/SillyTavern/blob/main/public/index.html#L7424)）。
3. **编辑态工具条**：确认、复制、加 reasoning、删除、上移/下移、取消（[7440-7448](https://github.com/SillyTavern/SillyTavern/blob/main/public/index.html#L7440)）。

机制：点 `...` 让 hint 淡出、按钮组淡入，点空白处收起（[script.js:11868-11930](https://github.com/SillyTavern/SillyTavern/blob/main/public/script.js#L11868)）；`expand_message_actions` 可让全部常显（[power-user.js:200](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/power-user.js#L200)、[toggle-dependent.css:472](https://github.com/SillyTavern/SillyTavern/blob/main/public/css/toggle-dependent.css#L472)）。移动端仅把 `.mes_buttons` 字号 ×1.2（[mobile-styles.css:357](https://github.com/SillyTavern/SillyTavern/blob/main/public/css/mobile-styles.css#L357)）。
优点：主操作永不隐藏，次要操作位置稳定；缺点：一次展开 12 个 icon、无文字标签，手机可点性差（文档也承认按钮只有 hover 语义）。

## 3. Prompt Manager / Author's Note / World Info 的信息架构

**Prompt Manager**（Chat Completion 流水线）：`Prompt {enabled, role, content, name, system_prompt, injection_position, injection_depth, injection_order, injection_trigger, forbid_overrides, marker}`（[PromptManager.js:80-175](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/PromptManager.js#L80)）。

- 列表项 = 拖拽手柄 + 类型图标（图钉=marker、方框=全局、星=important、星号=预设、注射器=in-chat@深度）+ 角色图标（user/assistant）+ 行内三控件（解除/编辑/开关）+ 右侧该块 token（[1660-1760](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/PromptManager.js#L1660)）。
- 拖拽用 jQuery UI sortable（`delay:30`）；**移动端 `handle: '.drag-handle'`**，桌面可整行拖（[1918-1935](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/PromptManager.js#L1918)）——避免拖拽与滚动打架。
- 头部显示 `Total Tokens: N`（[promptManagerHeader.html](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/templates/promptManagerHeader.html)）；当已用 >80% 预算且 `chatHistory` 块 token ≤1500/≤500 时打黄/红警告（[1673-1695](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/PromptManager.js#L1673)）。
- 编辑表单：name / role / triggers（normal/continue/impersonate/swipe/regenerate/quiet）/ position（relative | in-chat）/ depth / order / 内容 / forbid overrides（[index.html:7294-7375](https://github.com/SillyTavern/SillyTavern/blob/main/public/index.html#L7294)）。语义：`depth 0`=最后一条消息之后，`order` 是同角色同深度内的排序。
- **Inspect**：点块名可预览它在真实请求里展开成哪些消息（role + tokens），"所见即所发"（`handleInspect` [468](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/PromptManager.js#L468)）。

**Author's Note**：独立浮层，不是提示词列表的一员。字段：文本 + 实时 token + "Include in World Info Scanning" + 位置（Before/After story string、In-chat @depth as role）+ Insertion Frequency（0=禁用，1=每次）；数据存 `chat_metadata.note_*`（[authors-note.js:30-38](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/authors-note.js#L30)、[index.html:7749-7795](https://github.com/SillyTavern/SillyTavern/blob/main/public/index.html#L7749)）。角色私有 AN 不随卡片导出；checkpoint 继承父会话的 Note。

**World Info**：抽屉面板顶部先是**激活设置**（scan depth、budget % 或绝对 token、budget cap、min activations、max recursion steps、角色/全局策略、case sensitive、whole words、overflow 提醒），下面才是条目列表；条目字段很长（keys 含正则、optional filter + AND ANY/ALL/NOT ANY/ALL、content、order、8 种 insertion position 含 @depth 与 outlet、probability、inclusion group + weight、timed effects sticky/cooldown/delay、triggers、character filter、automation id），用「策略色点（恒定/关键词/向量）+ 抽屉」收纳（[index.html:4673-4810](https://github.com/SillyTavern/SillyTavern/blob/main/public/index.html#L4673)、[world-info.js:855](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/world-info.js#L855)）。

**IA 共性**：三者统一为「块 + 位置/深度 + token 数」；全局预算在上、内容块在中、注入控制在下（编辑弹层里）；默认只露常用项，高级参数折叠。这是我们最该学的部分。

## 4. Token 计数与上下文预算展示

- **每消息**：`tokenCounterDisplay` 显示 `Nt`，仅在开关开启且生成完成 / 切换 swipe 后计算（[script.js:2664](https://github.com/SillyTavern/SillyTavern/blob/main/public/script.js#L2664)、[3699](https://github.com/SillyTavern/SillyTavern/blob/main/public/script.js#L3699)）；timer 的 title 里带 `t/s`（[2740](https://github.com/SillyTavern/SillyTavern/blob/main/public/script.js#L2740)）。
- **每块**：Prompt Manager 每块 token + 总 token；AN 文本框下实时 token（`#extension_floating_prompt_token_counter`）。
- **预算告警**：PM 用 `max_context - max_tokens` 当预算，缺口按 1500/500 两档上色；WI 用 Context % 或绝对 Budget，超出可 alert。
- **发送前 dry-run**：`tryGenerate` 真实组一次消息算 tokenUsage，不是按字数估；输入框另有可选 Token Counter 扩展，能看 tokenizer 名与 token 切分色块（[extensions/token-counter/index.js](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/extensions/token-counter/index.js)）。
- 结论：ST 不隐藏 token，而是**在"块"和"消息"两个粒度就近显示**，并把告警绑定到最可能被挤掉的 chat history。

## 5. 分支 / 检查点 / 书签

- **Branch**（`createBranch` [bookmarks.js:187](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/bookmarks.js#L187)）：克隆 chat 到该消息为止 → 新文件 `X - Branch #N` → **切换过去**；`message.extra.branches[]` 记录来源；metadata 加 `main_chat` + 新 `integrity` uuid。
- **Checkpoint**（`createNewBookmark` [255](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/bookmarks.js#L255)）：同样克隆但**不切换**，弹窗命名，`message.extra.bookmark_link` 反链；旗标常显、点击打开、Shift+点击覆盖；回到父会话走 options 菜单 "Back to parent chat"。
- **Swipe 级分支**：版本历史里可直接"用这一次 swipe 建分支"（[swipe-picker.js:388](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/swipe-picker.js#L388)）。
- 文档把二者类比浏览器"前台新标签"与"后台新标签"（[chatfilemanagement](https://docs.sillytavern.app/usage/core-concepts/chatfilemanagement/)）。

## 6. 导出

- **聊天 JSONL / TXT**：每条历史记录右侧两枚按钮（[index.html:6792-6793](https://github.com/SillyTavern/SillyTavern/blob/main/public/index.html#L6792)）；前端 `POST /api/chats/export`（[script.js:11499](https://github.com/SillyTavern/SillyTavern/blob/main/public/script.js#L11499)）。JSONL 直接回源文件文本；TXT 在服务端逐行拼 `name: message\n\n`，跳过 `is_system`，优先 `extra.display_text`（[src/endpoints/chats.js:724-738](https://github.com/SillyTavern/SillyTavern/blob/main/src/endpoints/chats.js#L724)）。
- **角色卡 PNG / JSON**：PNG 用 tEXt 写 `chara`（v2，base64）并尽力写 `ccv3`（v3），写入前先删旧 chunk；读时 v3 优先（[character-card-parser.js:10-42](https://github.com/SillyTavern/SillyTavern/blob/main/src/character-card-parser.js#L10)）。所以"PNG 角色卡"是**图片当容器、元数据在 chunk 里**。
- 主题、提示词列表、世界书也都能 JSON 导入导出；可逆性分层：JSONL 可再导入，TXT 明确"丢元数据、不可导入"。

## 7. 主题、移动端布局、可访问性

- **主题**：CSS 变量 `--SmartTheme*`（[style.css:71-96](https://github.com/SillyTavern/SillyTavern/blob/main/public/style.css#L71)）+ 主题 JSON（导入/导出/另存/更新，[index.html:4924-4960](https://github.com/SillyTavern/SillyTavern/blob/main/public/index.html#L4924)）；可调 10 个颜色、chat width 25-100%、font scale 0.5-1.5、blur 0-30、shadow 0-5；chat style 三态 Flat/Bubbles/Document；性能开关 Reduced Motion / No Blur / No Text Shadow；自定义 CSS 随主题保存（[uicustomization](https://docs.sillytavern.app/usage/core-concepts/uicustomization/)）。
- **移动布局**：`@media (max-width:1000px)` 统一把 `.drawer-content` 变成 `100dvw` 固定层、顶栏 fixed、`#sheld` 满宽、dpvh 兼容、隐藏 pin/拖拽条、WI 表头换移动版（[mobile-styles.css:2](https://github.com/SillyTavern/SillyTavern/blob/main/public/css/mobile-styles.css#L2)、[260-450](https://github.com/SillyTavern/SillyTavern/blob/main/public/css/mobile-styles.css#L260)、[592-644](https://github.com/SillyTavern/SillyTavern/blob/main/public/css/mobile-styles.css#L592)）；`isMobile()` 只看 UA（[RossAscends-mods.js:143](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/RossAscends-mods.js#L143)）；`body.PWA` 由 `display-mode: standalone` 加上（[script.js:799](https://github.com/SillyTavern/SillyTavern/blob/main/public/script.js#L799)）。
- **可访问性**：集中式 `a11y.js` 给 `.menu_button/.mes_button/.swipe_left/.swipe_right/...` 补 `role=button`，列表补 `role=list/listitem/toolbar/tablist/tab`，toast `role=status`，并用 MutationObserver 覆盖动态 DOM（[a11y.js:8-135](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/a11y.js#L8)）；计数器/选择器支持 `tabindex` + Space。不足：大量 icon-only 控件只有 `title` 没有 `aria-label`；`...` 展开没有 `aria-expanded`；25px 箭头对触控偏小。

## 8. 对我们 App 的改进（11 条，含优先级/实现提示/风险）

> 现状基线：`public/js/branch.js` 已有 variants；`chat.js:615` 已有 `‹ 1/3 ›`；`settings.js:170` 只有单条 systemPrompt；`store.js` 只有全量 JSON 导出；`usage.js` 只有累计用量。以下不依赖后端新接口的优先。

**P0（下一迭代）**

1. **把版本切换器升级为完整 swipe 语义**：计数常显、末版右箭头高亮（opacity .7）、末版再"下一版"=重新生成、长按计数/点计数打开版本历史 sheet（首 80 字+时间+token+「用此版本建分支」）。
   - 实现：扩展 `branch.js` 计算 `isLastVariant`；`chat.js` 的 `variantBar` 已存在，加长按（Pointer Events，500ms，移动 10px 取消）与 `openSheet`。
   - 风险：长按与文本选择/滚动冲突；旧数据无 variants 时需仍显示"1/1"或不显示。
   - 来源：[script.js:9129/9935](https://github.com/SillyTavern/SillyTavern/blob/main/public/script.js#L9129)、[swipe-picker.js:412](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/swipe-picker.js#L412)。

2. **收敛常驻按钮，把 `...` sheet 变成真正的"消息操作中心"**：常驻只留复制、重新生成、`...`（现在有 6 个：复制/重生成/朗读/赞/踩/更多）；`moreMenu` 里补"从这里建分支 / 建检查点 / 复制引用 / 导出该条"，并让长按消息直接打开同一 sheet。
   - 实现：`chat.js:623` 精简按钮；`app.js:586` 的 `moreMenu` 已是底部 sheet（`openSheet`），在 `data-a` 分支加 `branch/checkpoint` 即可；赞踩可移入 sheet 或保留为轻量反馈。
   - 风险：高频的"朗读"被折叠会降体验 → 按真实使用率决定常驻项；删除必须走 `confirmDialog`（已有）。
   - 来源：[index.html:7409-7450](https://github.com/SillyTavern/SillyTavern/blob/main/public/index.html#L7409)、[script.js:11868](https://github.com/SillyTavern/SillyTavern/blob/main/public/script.js#L11868)。

3. **systemPrompt 升级为有序提示词块**：内置块（系统提示 / 时间地点注入 / 用户画像 / 上下文摘要 / 历史 / 后置指令）+ 自定义块；每块开关、顺序、角色（system/user）、token；默认视图只露前 6 块，"高级"展开。
   - 实现：新增 `public/js/prompts.js`（纯函数，可 Node 测试）：`normalizePromptList`、`moveBlock`、`buildPrompt(blocks, ctx)`、旧 `systemPrompt`→单块迁移；`settings.js` 渲染列表；排序用"上移/下移 + 拖拽手柄"双通道（Pointer Events 自写，避免引依赖）。
   - 风险：顺序改变影响输出质量，需"恢复默认"；迁移必须幂等；不要把默认视图做成 20 个块的表单。
   - 来源：[PromptManager.js:80/1660](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/PromptManager.js#L1660)、[docs Prompt Manager](https://docs.sillytavern.app/usage/prompts/prompt-manager/)。

4. **上下文预算条**：输入框上方一行 `≈18.4k / 64k · 历史 12.1k · 系统 2.3k`；>80% 黄、>90% 红；超出时提示"将按预算截断最早消息"。
   - 实现：`chat.js` 发送前用 `render.js` 的纯文本长度估 token（中文按 ~1.6 字/token，ASCII 4 字/token），结果写入 session 缓存；服务端返回的 `usage.prompt_tokens` 回填校正系数；开关默认开。
   - 风险：估算偏差需显示 `≈`；不要为此阻塞发送。
   - 来源：[PromptManager.js:1673](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/PromptManager.js#L1673)、[extensions/token-counter](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/extensions/token-counter/index.js)。

5. **会话级 JSONL / TXT 导出**：侧栏会话长按或设置里"导出此会话"，JSONL=每行一条消息（含 variants/usage/citations），TXT=`角色: 内容`（现在只有"导出全部 JSON"和单条 Markdown）。
   - 实现：`store.js` 加 `exportSession(id, format)`，复用现有 `download` 逻辑与 `app.js` 的 `downloadBlob`；JSONL 与现有全量 JSON 导入兼容（`normalizeSession` 已是逐条）。
   - 风险：隐私——引用里的 URL/正文、附件 base64 需默认剔除；文件名用标题+日期并清洗非法字符。
   - 来源：[src/endpoints/chats.js:724](https://github.com/SillyTavern/SillyTavern/blob/main/src/endpoints/chats.js#L724)、[docs Chat File Management](https://docs.sillytavern.app/usage/core-concepts/chatfilemanagement/)。

**P1（一个迭代内）**

6. **会话分支与检查点**：消息菜单"从这里建分支"（复制到该消息，切到新会话，`parentId` 记父链）与"建检查点"（不切换，消息上出现旗标可回跳）；侧栏显示"来源"标签。
   - 实现：入口挂到 `app.js:586` 的 `moreMenu`；`store.js` session 增加 `parentId/parentTitle/checkpointOf`；新建会话复用现有 session 创建逻辑；迁移无 parentId 的旧数据即可。
   - 风险：会话膨胀 → 侧栏按根折叠并提供"清理孤立分支"。
   - 来源：[bookmarks.js:187/255](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/bookmarks.js#L187)。

7. **提示词预设成套导入导出**：`{blocks, params, version}` JSON，可导入第三方预设（忽略未知字段）、按会话覆盖。
   - 实现：复用 `exportAll` 的下载/导入链路；`normalizePromptList` 做白名单校验。
   - 风险：预设含危险指令无需过滤（本身就发给模型），但要防超大文件（>1MB 拒绝）。
   - 来源：[docs Prompt Manager](https://docs.sillytavern.app/usage/prompts/prompt-manager/)（preset 语义见 ST 的 Chat Completion preset）。

8. **主题 token 化 + 密度/动效开关**：把散落色值收敛到 `--ds-*`；新增紧凑/标准/宽松与"关闭模糊""减少动效"，跟随 `prefers-reduced-motion`。
   - 实现：`app.css` 已有 `[data-theme]`，补 `[data-density]` 与 `@media (prefers-reduced-motion)`；设置-外观三组开关。
   - 风险：视觉回归——逐屏截图对比；`backdrop-filter` 在低端 Android WebView 上耗电。
   - 来源：[index.html:4924](https://github.com/SillyTavern/SillyTavern/blob/main/public/index.html#L4924)、[uicustomization](https://docs.sillytavern.app/usage/core-concepts/uicustomization/)。

9. **触控与可访问性硬化**：其余 icon-only `.act` 补 `aria-label`（版本切换已带，`chat.js:615`）、sheet 开关补 `aria-expanded`、动作按钮 `min-height:40px`、版本切换支持键盘 ←/→（桌面）。
   - 实现：`ui.js` 的 `icon()` 强制传 label；CSS 集中覆盖 `.act`；`chat.js` 事件委托已就绪。
   - 风险：按钮变高挤压消息间距 → 用 `gap` 与 `-webkit-tap-highlight` 调整。
   - 来源：[a11y.js](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/a11y.js)、[docs Chatting](https://docs.sillytavern.app/usage/chatting/)。

**P2（观察/储备）**

10. **轻量"世界书"按需注入**：给系统提示加「条目 + 关键词」，发送前只拼命中项（`includes` 即可，不做向量），并显示"本次命中 N 条 / X token"。
    - 实现：`prompts.js` 里 `selectEntries(recentText, entries)` 纯函数 + 测试；默认关闭。
    - 风险：漏触发/误触发；关键词大小写与中文分词需说明。
    - 来源：[world-info.js](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/world-info.js)、[docs World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)。

11. **「查看本次请求」检查器**：消息菜单展示实际发送的 messages（role + 内容 + token），mock 模式也能看；只读、不可编辑。
    - 实现：`app.js` 组请求处保留一份脱敏快照（无 headers/key）挂到当前消息。
    - 风险：隐私与误以为可改；明确"只读 + 本次请求"。
    - 来源：[PromptManager.js:468](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/PromptManager.js#L468)、[docs Chatting](https://docs.sillytavern.app/usage/chatting/)。

## 9. 来源清单

- 仓库（main HEAD，2026-11-21 抓取）：[script.js](https://github.com/SillyTavern/SillyTavern/blob/main/public/script.js) · [swipe-picker.js](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/swipe-picker.js) · [PromptManager.js](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/PromptManager.js) · [bookmarks.js](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/bookmarks.js) · [world-info.js](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/world-info.js) · [authors-note.js](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/authors-note.js) · [a11y.js](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/a11y.js) · [RossAscends-mods.js](https://github.com/SillyTavern/SillyTavern/blob/main/public/scripts/RossAscends-mods.js) · [swiped-events.js](https://github.com/SillyTavern/SillyTavern/blob/main/public/lib/swiped-events.js) · [mobile-styles.css](https://github.com/SillyTavern/SillyTavern/blob/main/public/css/mobile-styles.css) · [style.css](https://github.com/SillyTavern/SillyTavern/blob/main/public/style.css) · [index.html](https://github.com/SillyTavern/SillyTavern/blob/main/public/index.html) · [chats.js(server)](https://github.com/SillyTavern/SillyTavern/blob/main/src/endpoints/chats.js) · [character-card-parser.js](https://github.com/SillyTavern/SillyTavern/blob/main/src/character-card-parser.js)
- 官方文档：[Chatting](https://docs.sillytavern.app/usage/chatting/) · [Prompt Manager](https://docs.sillytavern.app/usage/prompts/prompt-manager/) · [World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/) · [Chat File Management](https://docs.sillytavern.app/usage/core-concepts/chatfilemanagement/) · [UI Customization](https://docs.sillytavern.app/usage/core-concepts/uicustomization/)

## 10. 与我们的差异（快速对照）

| 维度 | SillyTavern | 我们（deepseek-mobile） | 差距 |
| --- | --- | --- | --- |
| 多版本回复 | swipes + 计数器 + 历史弹层 + swipe 分支 | variants + `‹1/3›`（chat.js:615） | 缺历史弹层/末版重生成语义 |
| 消息菜单 | 3 常驻 + `...` 12 项 | 6 常驻 + `...` sheet 5 项（chat.js:623 / app.js:586） | 常驻偏多，sheet 未覆盖分支/检查点 |
| 提示词 | 有序块 + 深度注入 + token/块 | 单条 systemPrompt + 3 预设 | 最大差距 |
| 预算 | 块/消息两级 + 80% 告警 | 仅累计用量（usage.js） | 缺"本次请求"预算 |
| 分支 | Branch + Checkpoint + 父链 | 无 | 可从消息菜单补 |
| 导出 | JSONL/TXT/PNG/JSON/主题 | 全量 JSON | 需会话级导出 |
| 移动适配 | 1000px 断点 + 全屏抽屉 + 长按 | 已有底部 sheet/安全区 | 触控尺寸与 aria 需补 |

> 局限：以上为源码与文档静态分析；未实测 ST 在 iOS/Android 上的手势冲突与性能。建议后续用真机录屏对照第 1、2 节的交互细节，再定第 1-3 条的最终形态。
