# 更新日志

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)；提交信息参考 Conventional Commits。

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

[1.0.2]: https://github.com/nagatoquin33/deepseek-pocket/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/nagatoquin33/deepseek-pocket/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/nagatoquin33/deepseek-pocket/releases/tag/v1.0.0
