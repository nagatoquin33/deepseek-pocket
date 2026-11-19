# 发布流程

## 1. 版本号

遵循 SemVer：`MAJOR.MINOR.PATCH`。

- 修 bug / 文档：PATCH（1.0.0 → 1.0.1）
- 新增功能：MINOR（1.0.x → 1.1.0）
- 破坏性变更（存储格式、接口契约）：MAJOR

APK 的 `versionName` 跟随 tag（`v1.0.1` → `1.0.1`），`versionCode` 使用 CI 运行号。

## 2. 发布步骤

```bash
# 1) 更新 CHANGELOG.md（Unreleased → 新版本号 + 链接）
# 2) 提交
git add -A
git commit -m "chore(release): v1.0.2"
git push origin main

# 3) 打标签（触发 Release 构建）
git tag -a v1.0.2 -m "DeepSeek Pocket 1.0.2"
git push origin v1.0.2
```

CI（`.github/workflows/build-apk.yml`）会：

1. 跑 132 项测试；
2. `bash android/build.sh` 构建已签名 APK；
3. 上传 artifact `DeepSeekPocket-apk`（含 SHA256SUMS.txt）；
4. 为 tag 创建 GitHub Release 并附加 APK 与校验和。

## 3. 签名

默认情况下 CI 生成一次性调试证书（可安装，但跨版本升级需卸载）。
稳定升级请在仓库 **Settings → Secrets and variables → Actions** 配置：

| Secret | 说明 |
| --- | --- |
| `KEYSTORE_BASE64` | keystore 的 base64：`base64 -w0 release.keystore` |
| `KEYSTORE_PASSWORD` | store 密码 |
| `KEY_ALIAS` | 别名（默认 `deepseek`） |
| `KEY_PASSWORD` | key 密码 |

> 更换签名会导致已安装用户无法覆盖升级，请妥善保存 keystore 与密码。

## 4. 发布前检查

- [ ] `npm test` 全绿
- [ ] `npm run qa` 与 `npm run qa:voice` 通过
- [ ] 真机/模拟器安装新 APK，验证登录、对话、语音、手势
- [ ] `CHANGELOG.md` 已更新，版本号与 tag 一致
- [ ] Release 附件包含 APK + `SHA256SUMS.txt`
- [ ] 下载 APK 校验：`sha256sum DeepSeekPocket-x.y.z.apk`

## 5. 文档站

推送 `main` 会触发 `.github/workflows/docs.yml`：lint 文档 → 构建 `site/` → 部署 GitHub Pages。
站点地址：<https://nagatoquin33.github.io/deepseek-pocket/>（含 Web 版入口与最新 APK 下载）。
