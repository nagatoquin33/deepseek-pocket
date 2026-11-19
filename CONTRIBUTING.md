# 参与贡献

感谢你愿意改进 DeepSeek 随身版。这个项目刻意保持「零框架、零构建」：前端是原生 ES Module，服务端零依赖，APK 用手工工具链打包。请在改动前先读一遍本文。

## 环境

| 用途 | 要求 |
| --- | --- |
| 浏览器模式 / 服务端 | Node ≥ 20 |
| 测试 | `npm test`（服务端 + 渲染器，无需网络） |
| 构建 APK | JDK 17+、Android SDK（build-tools + platforms/android-34+） |
| 端到端 / 截图 | 本机 Chrome + `tools/qa`（`npm i --prefix tools/qa`） |

```bash
git clone https://github.com/nagatoquin33/deepseek-pocket.git
cd deepseek-pocket
npm install

node server.mjs --mock      # 离线演示
npm test                    # 132 项测试
npm run qa                  # 端到端（需另开 --mock --port 8899）
npm run build:android:win   # Windows 构建 APK；Linux/macOS 用 npm run build:android
```

## 代码约定

- 前端：原生 ESM，不引入框架/打包器；新增模块请同步 `public/sw.js` 的预缓存列表（如需要）。
- 服务端：Node 内置模块，零运行时依赖；任何上游请求都要可中断（AbortController）。
- 渲染器（`public/js/render.js`）：必须保持 XSS 安全与「无 DOM 依赖」，新增语法请补 `test/render.test.mjs`。
- 样式：移动优先，新增 UI 请同时检查深色模式与 WebView 110（无 `color-mix` 时的回退）。
- 文案：中文为主；错误提示要可执行（告诉用户下一步做什么）。

## 提交规范

参考 Conventional Commits：

```
feat: 新增系统提示词模板
fix: 修复朗读停止时误报失败
docs: 重写 README 与 FAQ
ci: 版本号跟随 tag
refactor: 抽离用量统计模块
```

一个 PR 只做一件事；涉及行为变化请更新 `CHANGELOG.md`（Unreleased 段）。

## 测试要求

- 改动服务端 / 渲染器：补对应单测，`npm test` 必须全绿。
- 改动 UI / 交互：跑 `npm run qa` 与 `npm run qa:voice`，并在 PR 描述里附截图或录屏。
- 涉及 Android 壳：说明测试机型/模拟器（本仓库在 MuMu Android 12 / WebView 110 验证）。

## 截图规范

- 文档图片统一放 `docs/screenshots/`，命名 `NN-用途.png`（如 `03-chat.png`）。
- 用 `npm run shots` 生成，尺寸 390×844 @2x；不要把调试/一次性截图提交进仓库。
- README 引用的图片必须真实存在（CI 未来会加链接检查）。

## 文档

- 用户向：README、`docs/FAQ.md`。
- 协议/字段：`docs/API-MAPPING.md`。
- 内部契约：`docs/CONTRACTS.md`（模块接口与验收标准，改动接口请同步）。
- 安全：`SECURITY.md`；发布：`CHANGELOG.md` + tag。

## PR 检查清单

- [ ] `npm test` 全绿
- [ ] 不提交密钥、`.tls/`、`android/debug.keystore`、构建产物
- [ ] 新增/修改的接口已更新文档
- [ ] 截图仅提交文档用的精简图集
- [ ] 变更已写入 `CHANGELOG.md` 的 Unreleased
- [ ] 如涉及 APK，说明验证方式与机型

## 行为准则

保持友善、对事不对人；不提交来源不明或含个人隐私的素材。官方图标/商标归 DeepSeek, Inc. 所有，请勿用于对外分发。
