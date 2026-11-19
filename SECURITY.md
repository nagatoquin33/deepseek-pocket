# 安全说明

本项目的定位是**个人自用**的 DeepSeek 客户端：密钥、对话与附件都在你自己的设备上，服务端只做转发。请勿把它直接暴露到公网。

## 威胁模型

| 风险 | 现状 | 缓解 |
| --- | --- | --- |
| API Key 泄露 | Key 存在设备本地（localStorage）/ 预置模式在服务进程环境变量 | 不上传、不写日志（`sk-*`、`Bearer` 脱敏）；APK 内不预置 Key |
| XSS（模型输出注入） | 模型返回的 Markdown/HTML 一律转义，链接白名单，无 `on*` 属性 | 自研渲染器 + 106 项安全测试；CSP `script-src 'self'` |
| 恶意链接 / 图片 | 链接仅允许 http/https/mailto/tel；图片仅 http/https/data:image | 外链统一 `rel="noopener noreferrer nofollow"`，外部浏览器打开 |
| 中间人 | 上游强制 HTTPS；浏览器模式经本机代理 | 本机 HTTPS 使用自签证书（仅局域网），首次需手动信任 |
| 越权访问本地服务 | 无鉴权，默认监听 `0.0.0.0` | 仅局域网使用；如需公网，请加反向代理与鉴权，并启用 `--host 127.0.0.1` |
| 日志泄露 | 服务端日志脱敏 | 不记录请求体；错误信息不含密钥 |
| 供应链 | 运行时依赖仅可选 `qrcode`，前端零依赖 | 构建不执行第三方脚本；CI 只跑本仓库脚本 |

## 密钥与数据

- APK：Key 存在 WebView 同源 localStorage；对话/附件/统计存在 IndexedDB（降级 localStorage）。
- 浏览器模式：Key 与数据存在该站点的浏览器存储；预置模式 Key 只在服务进程环境中。
- 导出：设置 → 数据管理，JSON 文件由你自己保管。
- 卸载应用/清除站点数据会删除本地内容（不可恢复）。

## 内容安全

- 设置 → 对话 → 内容安全审核（`safety_check: high`）默认**关闭**，开启后输入与输出会经平台审核，命中风险时返回拒答。
- 对外提供服务时，请开启该选项，并自行完成大模型备案、AI 生成内容标识等合规义务。

## 依赖与构建

- 前端无第三方运行时依赖；`qrcode` 仅用于启动横幅二维码，可不安装。
- APK 由 `aapt2 + javac + d8 + apksigner` 手工构建，CI 不执行 Gradle/第三方插件。
- 发布件由 GitHub Actions 构建，提供 SHA256；请核对 Release 中的 `SHA256SUMS.txt`。

## 漏洞上报

如果你发现安全问题（密钥泄露路径、XSS、越权、依赖漏洞等），请**不要公开提 issue**，通过以下方式私下联系：

- GitHub Security Advisories（推荐）：仓库 → Security → Report a vulnerability
- 或邮件：`security@example.com`（占位，请替换为你的真实邮箱）

请附：版本号 / 平台（APK 或浏览器）/ 复现步骤 / 影响范围。我们会在确认后修复并在 CHANGELOG 中致谢（如你愿意）。

## 支持版本

仅维护最新 release（当前 `1.0.x`）。旧版本请先升级再反馈。
