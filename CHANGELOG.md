# 更新日志

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)；提交信息参考 Conventional Commits。

## [1.5.0] - 2026-11-21

### 新增

- 1M 上下文：预算条按 1M 计算；超过 82% 自动裁剪较早消息，并在请求中标注省略条数
- 长期记忆：设置 → 记忆，可增删改/开关，作为 system 消息注入每次请求
- 设置 → 模型：独立的模型页（含思考/搜索开关），不再跳回对话界面

### 修复

- 设置页内弹窗被设置页遮挡：modal/sheet 层级提到设置页之上，提示词编辑/删除确认恢复可用
- 右上角加号在已存在空对话时重复创建：现在复用当前空对话并聚焦输入框
- 每轮 latest_reminder 在发送时固化，避免修改设置后重写历史前缀、拉低缓存命中

## [1.4.1] - 2026-11-21

### 变更

- 模型选择改为会话级：顶栏显示当前模型，切换只影响当前对话，新对话继承上次选择
- 不做「快速 / 专家 / 识图」模式选择器：官方已弃用该三模式，改为自由选模型；能力开关与模型解耦
- 更正官方 APK 研究报告，注明三模式为历史形态

## [1.4.0] - 2026-11-21

### 新增

- 提示词块（Prompt Manager 简化版）：有序块、启用/禁用、上下移动、编辑、四种预设；旧系统提示词自动迁移
- 输入区上下文预算条：本地 token 估算 + 上次真实 prompt_tokens 校准，80%/90% 变色提示
- 会话导出 JSONL / TXT；消息菜单新增「复制为 Markdown」「从这里建分支」
- 官方 App 2.9 实测配色：品牌蓝 #426EFE / 深色 #507BF2，中性色 #F9F9FF / #10131A / #171717

### 修复

- 流式收尾：必须显式收到 [DONE] 才完成；EOF 前冲刷残留 buffer，避免误报中断
- 重新生成被中断时保留已生成内容并并入新版本，不再丢弃
- [DONE] 后不再主动 cancel 响应，消除 net::ERR_ABORTED 噪声与代理误判

## [1.3.1] - 2026-11-20

### 变更

- 左缘右滑打开侧栏改为默认开启，并移除设置开关：这是标准手势，不该让用户配置
- 浮层 / 搜索 / 设置 / 侧栏打开时，左缘右滑等价于返回，左缘始终承担「返回上一级」语义
- 旧安装一次性迁移为开启

## [1.3.0] - 2026-11-20

### 新增

- Android 14+ 预测性返回：手势进行时实时预览侧栏 / 底部抽屉收起，取消可回弹
- 左缘右滑打开侧栏：设置 → 对话可开启，开启后左侧手势区留给应用（系统返回从右缘触发）
- 键盘弹出时输入区过渡，并保持消息列表贴底

### 变更

- Android 13+ 返回统一走 OnBackInvokedDispatcher，保留「再滑一次退出」兜底

## [1.2.0] - 2026-11-20

### 新增

- 消息左右滑切换回答版本（仅多版本时生效，带触感反馈）
- 底部抽屉从抓手/标题栏跟手下拉关闭，按距离或速度判定，松手回弹
- 侧栏跟手左滑关闭，带阻尼与回弹

### 变更

- 媒体区域（代码块/表格/公式/图片）不参与消息滑动，避免与横向滚动冲突

## [1.1.1] - 2026-11-20

### 修复

- 入口页顶栏不显示：insets 在页面加载前注入会丢失，改为页面加载完成后再注入一次
- 消息「⋯」菜单空白：全局隐藏规则误伤菜单项，改为只作用于侧栏

## [1.1.0] - 2026-11-20

### 新增

- 消息分支切换：重新生成保留旧回答，消息下方 `‹ n/m ›` 前后切换；版本随导入导出保存
- TeX 渲染扩展：分式、`\sqrt[n]`、上下标组合、`\sum/\int` 等大运算符上下限、`\left(\right)`、矩阵（pmatrix/bmatrix/vmatrix）、cases、aligned，超深嵌套安全降级
- `npm run doctor` 一键体检：Node、openssl、证书 SAN/有效期、端口、JDK、Android SDK、签名与网络
- 英文 README 与文档站英文页；README 增加中英文切换
- 渲染器与分支逻辑测试增至 209 项

### 变更

- 重新生成不再覆盖原回答，而是新增版本；切换版本时同步正文、思考、搜索卡片、引用与用量
- 导入会话时清洗内容块，仅保留 http(s) 引用链接

### 修复

- QA 脚本与新设置入口（`#btn-account`）对齐

## [1.0.3] - 2026-11-19

### 修复

- 应用内版本号仍显示 1.0.0：改为读取已安装包的 versionName，版本号统一以 package.json 为单一来源

## [1.0.2] - 2026-11-19

### 修复

- 全面屏返回手势在根页面直接退回桌面：改为「再滑一次返回退出」，浮层优先关闭
- 自动朗读在旧安装上可能保持开启：默认关闭并做一次性迁移

### 变更

- 系统提示词取消 2000 字上限，字数限制交给上下文 token 预算

## [1.0.1] - 2026-11-19

### 修复

- 朗读播放成功却提示「朗读失败」：释放音频前摘除事件监听，主动停止期间忽略空 src 的 error 事件
- 全面屏手势未适配：Android 11+ 开启 edge-to-edge，把状态栏/导航手势/刘海/输入法 insets 注入 CSS 安全区
- 旧版设置里内容安全审核默认开启的问题：默认关闭，并对老数据做一次性迁移

### 新增

- 消息底部完整用量：输入/输出 tokens、缓存命中率、思考 token、首字延迟、输出速度、耗时、估算费用
- 设置 → 账户 → 用量统计：累计 token、缓存命中、TTS 计费字符、ASR 时长与分项费用，可清空
- 应用内手势：侧栏左滑关闭、底部抽屉下拉关闭、搜索/设置页左缘右滑返回、图片下滑关闭
- 按住说话：按下录音、松手自动识别并发送

### 变更

- 朗读交互改为回答操作栏喇叭按钮就地切换
- 思考强度文案改为官方 `low / high / max`；深度思考行只保留开关
- 系统提示词支持自定义（≤2000 字）与 6 套模板

### 文档

- README 重写（导航、兼容性、隐私、FAQ 索引、贡献入口）
- 新增 FAQ、SECURITY、CONTRIBUTING、Issue/PR 模板与 GitHub Actions 构建说明

## [1.0.0] - 2026-11-19

### 新增

- Android APK（WebView 直连 `api.deepseek.com`，本地资产拦截，手机独立运行）
- 浏览器/PWA 模式（`server.mjs`：SSE 代理、HTTPS 自签、二维码、离线 Mock）
- 深度思考、智能搜索与引用、图片/文档输入、Markdown/代码/Mermaid/公式
- 语音输入（WAV → ASR）与朗读（TTS），会话管理与导入导出
- 开放平台余额、费用估算、系统提示词、深色模式、PWA 安装
- 132 项自动化测试；GitHub Actions 自动测试、打包 APK、tag 发布 Release

[1.5.0]: https://github.com/nagatoquin33/deepseek-pocket/compare/v1.4.1...v1.5.0
[1.4.1]: https://github.com/nagatoquin33/deepseek-pocket/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/nagatoquin33/deepseek-pocket/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/nagatoquin33/deepseek-pocket/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/nagatoquin33/deepseek-pocket/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/nagatoquin33/deepseek-pocket/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/nagatoquin33/deepseek-pocket/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/nagatoquin33/deepseek-pocket/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/nagatoquin33/deepseek-pocket/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/nagatoquin33/deepseek-pocket/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/nagatoquin33/deepseek-pocket/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/nagatoquin33/deepseek-pocket/releases/tag/v1.0.0
