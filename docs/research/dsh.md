# DeepSeek Harness 桌面端界面设计分析

> 目标：为 DeepSeek Pocket（[public/index.html](../../public/index.html)，Android APK + PWA）提炼可迁移的设计语言。
> 方法：解包 `C:\Users\nagatoquin\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`（213 MB），
> 读取 web 前端 bundle 与 60+ 个 `@deepseek-ai/dsh-client-ui-*` 客户端插件的编译产物（含内联 CSS 与区域注释）。
> 下文 `P/` = `app.asar:/dsh/node_modules/@deepseek-ai/`；本地副本在 `.ref/dsh/files/`（已 gitignore，不提交）。

## 0. 证据与可复现路径

- 前端壳：`dsh-web-frontend/dist/index.html`、`assets/index-lh_YM6sT.css`（87 KB，全局 markdown/气泡/tooltip）。
- 设计 token：`P/dsh-client-ui-theme/lib/client.js`（palette + alias + 字体/圆角/动效/阴影/字号档）。
- 布局：`P/dsh-client-ui-layout/lib/client.js`（三列求解、抽屉、断点常量）。
- 会话与输入：`P/dsh-client-ui-conversation/lib/client.js`（InputBar、QueueDock、ContextMeter、keymap）。
- 消息块：`P/dsh-client-ui-chat/lib/client.js`、`P/dsh-client-ui-tool/lib/client.js`、`P/dsh-client-ui-approval/lib/client.js`。
- 说明：asar 内插件是「模块加载器 + 每插件 `lib/client.js`」，CSS 以 `const css = "..."` 注入 `<style data-plugin-css>`，
  因此数值可直接从字符串中读取（已抽取为 `.ref/dsh/notes/` 下可读 CSS，未入库）。
- 本次未运行任何 DSH 配置变更；GUI（http://127.0.0.1:10800）仅作交叉印证，结论全部以源码为准。

## 1. 布局框架与响应式行为

**三列壳（AppFrame）**：`grid-template-rows: minmax(0,1fr) auto`，列宽由 JS 求解后写入 inline style
（`P/dsh-client-ui-layout/lib/client.js:39-48`）。

| 列 | 规则 | 数值 |
| --- | --- | --- |
| 左栏 sidebar | `clamp(pref, 264, 420)`；折叠为图标轨 | 默认 280，轨宽 56；macOS/Windows 标题栏下折叠为 0 |
| 右栏 rightbar | `clamp(pref, 300, viewport*0.7)`，且 `viewport - s - 400 < 300` 时整列移除 | 首开偏好 45% |
| 主区 center | `viewport - sidebar - rightbar`，`min-width:0` | 内容列 `min(100% - 32px, 920px)` 居中 |

- **断点只有两条**：`SIDEBAR_AUTO_COLLAPSE = 1024`（视口小于该值侧栏自动收成 56px 轨，手动再展开则盖住主区）；
  `drawer = viewport < 768`（侧栏变 overlay 抽屉，宽 `min(pref||280, viewport-48)`，带 `bg-mask-1` 遮罩、`inert` 焦点隔离、`.3s` 滑入）。
- 折叠动画统一 `grid-template-columns .3s cubic-bezier(.4,0,.2,1)`，拖拽时 `data-dragging` 关闭过渡；
  把手宽 8px（`margin-left:-4px`，`cursor:col-resize`）；`prefers-reduced-motion` 下全部 `transition:none`。
- **壳层留白变量**（窗口装饰）：`--dsh-frame-top-clearance: 48px`（macOS）/ `--dsh-frame-leading-clearance: 160px→84px→48px`
  随折叠/全屏变化；Windows 自定义标题栏用 `padding-top: var(--dsh-windows-titlebar-height)` + 内容区左上 16px 圆角。
- 底部 `shell.bottom` 行 `grid-column:1/-1`、`auto` 高（状态栏/全局条）；`shell.overlay` 为 `z-index:20` 的绝对浮层。
- **容器查询而非媒体查询**：输入区行 `container-type:inline-size`，`@container (width<=560px)` 把间距 12→8、模型名切换为纯图标；
  设置页字段 `@media (width<=767px)` 改堆叠。触摸适配用 `@media (pointer:coarse)`（输入 16px 防缩放）与 `hover:hover` 包裹所有 hover 态。
- 会话滚动：`padding:16px calc(var(--dsh-composer-side-clearance) + 16px)`，消息列居中；
  用户气泡 `max-width: min(var(--dsh-chat-content-width)*0.702, 82%)`（`P/dsh-client-ui-chat` MessageItem.module.css）。
- 运行状态区（右栏）是**标签页 dock**：可拆分/浮动/全屏（壳原语 `_tab_*`、`_float_*`、`_dockScrim`），宽度同上表 clamp。

## 2. 设计 token（尽量给数值）

**三层结构**：`static-*` 调色板 → `alias-*` 语义色 → `dsh-*` 组件变量；主题用 `body` / `body[data-ds-dark-theme]` 覆盖，
非颜色 token 在 `:root`（`P/dsh-client-ui-theme/lib/client.js:1464-1490`）。

**字号 / 行高（含字重）**：`11/14`、`12/18`、`13/20`、`14/22`、`16/24`、`16/28(500)`、`20/28(500)`、`24/32(600)`；
markdown：h1 `21/30 700`、h2 `19/28 700`、h3 `18/26 700`、h4 `14/24 600`、正文 `14/24`、表格 `13/22`、
行内码 `12/19`、代码块 `11/19`、工具输出小码 `11/16`。
**字号联动技巧（可直接抄）**：`--dsh-content-font-delta = 字号 - 14px`，所有行高/图标/间距写成 `calc(基准 + delta)`，
用户改字号时整页等比呼吸；次级字号 `min(size-1px, max(13px, size-2px))`。默认档：正文 14（范围 10–22）、代码 11（10–16）、终端 13（10–20）。
**字体族**：正文 `-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", …`；等宽 `"SF Mono", "JetBrains Mono", Consolas, …`；品牌用 Montserrat。
**圆角**：`xs 4 / sm 8 / md 12 / lg 16 / xl 20 / panel 28`，胶囊 `999`；细线统一 `.5px`（1px 只用于边框强调）。
**间距基调**：4 的倍数，常用 6 / 8 / 10 / 12 / 14 / 16 / 24 / 32；侧栏内边距 8、行内 12，消息流间距 4/12/16（见 §3）。
**动效**：`--ds-transition-duration .2s`、`fast .1s`、`slow .3s`，曲线 `cubic-bezier(.4,0,.2,1)`；
另有进入动效 `.14s cubic-bezier(.2,.8,.2,1)`（运行行插槽）、tooltip `.15s`、chevron `.12s`、
侧栏轨 `rail-in .15s translate(49px)`。`prefers-reduced-motion` 与 `prefers-reduced-transparency` 均有降级分支。
**阴影 / 材质**：描边 `0 0 0 .5px`；`lv1 0 2px 4px #0000000d`；`lv2 0 4px 12px #00000005, 0 2px 8px #0000000a`；
`lv3 0 0 1px #0003, 0 12px 32px #00000014`；组合出 `elevation-panel / prominent / soft`；
菜单材质 `backdrop-filter: blur(40px) saturate(150%)`，面 `#fcfdfeb3`（浅）/ `#303136a3`（深，macOS `#f8f9faf0`）。
**主色语义（浅 / 深）**：`bg-base #fff / #151517`，`layer-1 #fff / #232324`，`layer-2 #fff / #2c2c2e`，
`sidebar-fill #f9fafb / #1b1b1c`，`label-primary #0f1115 / #f9fafb`，`secondary #61666b / #cfd3d6`，
`tertiary #81858c / #adb2b8`，`caption #adb2b8 / #81858c`。
边框 `#0000000a·1a·1f·29 / #ffffff0f·1f·29·33`（→ 4%/10%/12%/16% 与 6%/12%/16%/20%）。
品牌位是**中性黑白**（`#0f1115 / #f9fafb`），蓝色只承担「信息/业务」：`#4176e6 / #5686fe`；
状态色 `success #22c55e`、`error #ec1313 / #f25a5a`、`warn #f59e0b / #f7ad31`、`done #7c3aed / #a78bfa`；
交互底色 `hover #2631480f(4%) / #ffffff14`、`active #2631481a / #ffffff24`；气泡 `#edf3fe / #2c2c2e`（高亮 `#d3e2ff / #43454a`）。
聚焦环 `--dsw-focus-ring-width: 2px`，颜色取业务蓝，`outline-offset:-2px` 收进控件内。

## 3. 消息块与信息层级

层级从「回合」→「折叠过程」→「单条工具行」→「正文/卡片」四档，越外层越弱、越内层越具体：

1. **回合过程折叠行**（turn-process）：回合结束后在回答上方渲染一行标题，文案为「工作 3m12s / 已停止 / 失败」，
   带 `data-turn-process-messages|tool-calls|subagents` 计数，点击展开全部过程；这是 DSH 控制长对话噪音的主手段。
2. **思考块**（ReasoningRow）：行高固定 `24px`（折叠态 `contain:size layout`）；`图标 14px + "思考" + 2px 圆点分隔 + 单行摘要 13/20`，
   摘要取「最后完成段落的首行」并用 `TextShimmer` 扫光，流式时右侧 48px 渐隐遮罩；展开后正文左侧缩进 `22px`、次级字号。
3. **工具调用行**（ToolRow）：`DisclosureRow` 一行 `图标 + 标题 + 摘要 13/24`；摘要按族切换（读文件/搜索/终端/Web/Diff），
   diff 统计用等宽 `13-2=11px`、hover/展开才上色（加绿 `#22c55e`、删红 `#ec1313`）；错误摘要整行红、停止态琥珀；
   展开体 `max-height:260px` 滚动，IO 折叠为 `radius 16 + code-block 底色` 的双语言卡（标签列 + 内容列，各 `max-height:150px`）。
4. **正文**（AssistantMarkdown）：`14/24`，块间距 `gap:16px`，段落 `margin:16px 0`，引用 `border-left:2px solid caption; padding-left:14px`，
   列表 `padding-left:18px; li+li 6px`；行内码 `.875em` + `.5px` 边框 + `radius 8`；超宽表格破格到内容列外（`md-table-wide` 用容器宽度反算 `--dsh-table-lead`）。
5. **引用/提及 chip**：业务蓝、`radius 8`、`padding:0 4px`，hover 才出现 `business-tertiary` 底；失效引用删除线 + 70% 透明。
6. **运行中提示**（running 行）：`12/22`、`deep-diving` 混色（`color-mix(deepseek-500 70%, blue-950)`）+ 扫光、高 `28px`，
   上方 `.5px` 分隔线，插入动效 `0.14s cubic-bezier(.2,.8,.2,1)`。
7. **错误 / 停止**：统一成一行「低饱和 chip」——`11/18`、`interactive-bg-hover` 底、`label-tertiary` 字；不整块红色，只在摘要处点红。
8. **审批卡片**（ApprovalCard）：`1px` 琥珀边框 + `radius 20` + `shadow-lv2`；顶部琥珀条 `13/18`（10/16 内边距），
   标题 `15/24 500`，命令用等宽 `13/20 label-tertiary`，操作区右对齐 `gap:8 padding:14 16`；
   键盘 `Enter` 允许 / `Esc` 拒绝，且 `data-approval-key` 防误触。**它是唯一打断流的模态级卡片，不做悬浮球。**
9. **回合尾部信息**：统计胶囊 `12/20`（tabular-nums、`padding:1px 8px`、图标 14）与上下文环（见 §4），默认极弱、hover 提亮。

## 4. 输入区能力（Composer）

**结构**（`P/dsh-client-ui-conversation` InputBar.module.css + client.js）：
卡片 `radius 28`、`bg input-major`、`shadow elevation-soft`、`gap 12`、`padding-top 8` → 附件区 → 富文本编辑器（Lexical）
→ 控制行 → 底部 dock（排队条 + 上下文表）。

- 尺寸：卡片 `max-width = 内容宽 + 32`；编辑区 `min-height 36`（空会话 hero 态 52）、`line-height 24 + delta`、
  最大高 `336px` 后内部滚动；`@media (pointer:coarse)` 强制 `font-size ≥16px`（避免 iOS 聚焦缩放）。
- 按钮：`＋`（打开命令菜单，与 `/` 同一插槽）`28px` 圆形；模型选择 `28px` 高、`13/20`；发送/停止主按钮 `34px` 圆形（`translateY(-2px)`）——
  空闲为上行箭头，运行中变「实心方块」停止，发送中显示 `0.8s linear` 旋转环（reduced-motion 改 2.4s）。
- **停止**：双击 `Esc`（`StopSequence`，忽略输入法组合、模态、终端区、带修饰键的 Esc），按钮 tooltip `delayMs:500` 展示快捷键。
- **排队 / 插话**：`BusyEnter` 设置二选一 `queue | steer`；运行中按 Enter 入队（排队条），输入框为空且有队列时出现「插话」按钮；
  排队条 `radius 16 16 0 0`、头部 `36px` 显示条数、列表 `max-height:180px`、每行 `min-height:36px`，
  文件 chip `24px` 高（图标 16、名 `13`、大小 `10`）、行内操作 `28px` 圆形；附件以 chip + 缩略图 24px 呈现，失败可重试、未完成禁止提交。
- **模式**：控制行左侧渲染 `conversation.input.permission`（4 档权限预设：只读 / 工作区写入 / 完全访问 / 自动审阅）
  与 `conversation.input.plan`（计划模式）两个 slot；运行中两者均可锁。
- **模型**：`模型名 + 推理档位`（档位用 caption 色弱化）；`@container (width<=560px)` 时隐藏文字只留图标。
- **上下文占用**：环形进度触发器（`13/20`，tabular-nums）→ 浮层 `264px`、`radius 16`、`padding 12`、`12/20`；
  4px 高分段条按类着色：系统 `#adb2b8`、工具 `#a78bfa`、消息 `#4d93f8`，下方两列键值表。
- 快捷键体系：`Mod+B` 左栏开关、`Mod+Alt+B` 右栏、`Mod+/` 速查弹窗（`480×600`、行高 `42px`）、
  `Enter` 发送 / `Shift+Enter` 换行 / `Mod+Enter` 强制发送；绑定可重录、冲突拒绝、持久化到 `dsh.keybindings.v1` 或 `userData/keybindings.json`。

## 5. 设置与导航模式

- **侧栏**：`padding:6px 8px`、`font-size:14`；顶部 `logoRow 60px`，其下「新会话」→ 面板列表 → 工作区/会话浏览区（虚拟列表）
  → `footArea`（`sidebar.settings` 槽 + 底部动作槽，账号/用量由各插件注入）。折叠轨 `56px`，图标按钮 `28px`，行内边距常量 `--dsh-sidebar-row-padding:12px`，
  展开/收起各配 `.15s` 位移入场，避免硬切。
- **导航模式三套并存**：① 左栏面板（会话/工作区/插件）；② 右栏标签页 dock（文件、浏览器、终端、文档预览、轨迹、交付物，可拆分/浮动/全屏）；
  ③ 输入框 `＋` 与 `/` 命令菜单（同一 `ui-commands` 插槽，`＋` 左侧 28px、菜单项含图标与快捷键提示）。
- **设置**：不是一个大弹窗，而是「侧栏 → 插件页 → 官方分组卡片 → 单功能页」；每页字段「暂存草稿 + 显式保存 + 已覆盖标记 + 恢复默认」，
  离开即丢弃草稿。分组约十个：通用、外观（明暗/字号/字体）、模型、Agent 循环、子 Agent、联网搜索、终端执行器、会话日志、账号、快捷键、插件清单。
- 弹层统一走 `useModalLayer`（Esc 关闭 + 焦点回填），锚定浮层用 `useAnchoredPosition` 自动翻转并写 `--dsh-anchored-max-width/height`。

## 6. 可迁移到手机端的改进（12 条）

优先级：P0 = 直接决定可用性；P1 = 明显提升质感；P2 = 打磨。

| # | 优先级 | 改进 | 实现提示（本仓落点） |
| --- | --- | --- | --- |
| 1 | P0 | 停止 / 排队 / 插话三态统一 | [public/js/chat.js](../../public/js/chat.js)：运行中把发送键切为方块停止；Enter 行为按设置分流 `queue`/`steer`；输入为空且有队列时给「立即插话」按钮 |
| 2 | P0 | 上下文占用表 | [public/js/usage.js](../../public/js/usage.js) + [public/css/app.css](../../public/css/app.css)：环形触发器 + 4px 分段条 + 系统/工具/消息三色（`#adb2b8 / #a78bfa / #4d93f8`） |
| 3 | P0 | 长会话折叠层级 | [public/js/render.js](../../public/js/render.js)：思考折叠行固定 `24px`（摘要 13/20 + 扫光）、工具行 `13/24`、回合结束加「工作 3m12s」折叠；三档行高统一，滚动不再抖动 |
| 4 | P0 | token 三层化 | [public/css/app.css](../../public/css/app.css)：现有 62 个变量保留为 alias 层，补 static 层（`--ds-blue-*`）与组件层；新增 `--motion-fast/.2s/slow`、`--radius-panel:28px`、`--elevation-stroke`；字号统一走 `--dsh-content-font-delta` 联动 |
| 5 | P1 | 输入卡尺寸节奏 | 卡片 `radius 28`、编辑区 `min-height 36/52`、底部控制行 `gap 12`；触摸端用 `@media (pointer:coarse)` 把输入 `font-size` 钉到 `16px` |
| 6 | P1 | 权限模式一键切换 | 控制行左侧放「只读 / 工作区 / 完全访问 / 自动」四档选择器 + 计划模式开关，运行中锁定；权限变更需一次确认弹簧提示 |
| 7 | P1 | 手势抽屉式侧栏 | 借鉴 `<768px` drawer：遮罩 `bg-mask` + `.3s` 滑入 + `inert` 焦点隔离 + 手势边缘拖拽；替代当前纯遮罩式汉堡，`prefers-reduced-motion` 关闭过渡 |
| 8 | P1 | 审批卡片规范 | `1px` 琥珀边 + `radius 20` + 顶部琥珀条（标题 15/24、命令等宽 13/20）；移动端把主按钮固定右侧「允许」、左侧「拒绝」，长按展开完整命令 |
| 9 | P2 | 附件与队列 chip | 文件 chip 高 `24px`（图标 16 + 名 13 + 大小 10）、队列行 `min-height 36`、头部 36px 显示条数、操作按钮 28px 圆形 |
| 10 | P2 | 动效与时序降级 | 统一 `cubic-bezier(.4,0,.2,1)`，时长 `.1/.2/.3s`；运行行插入 `.14s cubic-bezier(.2,.8,.2,1)`；同时尊重 `prefers-reduced-motion` |
| 11 | P2 | 设置页结构 | 现 [public/js/settings.js](../../public/js/settings.js) 改为「分组卡片 + 单功能页 + 暂存/保存 + 已覆盖标签 + 恢复默认」；明暗与字号放在「外观」页（字号 3 档 → 连续 10–22px） |
| 12 | P2 | 快捷键/手势速查 | 类比 `Mod+/` 弹窗（480×600、行高 42）：移动端用底部 sheet，列出「双指点按停止、上滑插话、长按复制」等手势，并复用 `aria-keyshortcuts` |

## 7. 不宜照搬的部分

- 悬停才出现的操作（工具行「检查」按钮、diff 上色、定位浮层）在触摸端必须常显或改为长按/滑动。
- `56px` 图标轨 + 1024px 自动折叠是桌面信息密度下的解，手机端直接用 drawer（<768）即可，不必实现轨。
- 双击 `Esc` 停止在触摸端不可发现：保留按钮 + 手势（双指点按）两条路径，tooltip 文案改「再点一次停止」。
- 桌面 `backdrop-filter: blur(40px)` 菜单在低端 Android 上掉帧，建议按 `matchMedia('(prefers-reduced-transparency)')` 降级为不透明面。
