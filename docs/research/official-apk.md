# 官方 DeepSeek Android APK 设计研究报告

> 对象：`参考/deepseek.apk`（22,376,084 B，gitignored）
> 解包：apktool 3.0.3 → `.ref/apk`（资源，`apktool d -f --no-src`）、`.ref/apk-src`（smali，`apktool d -f -r`）
> 复现：`apktool d -f -o .ref/apk "参考/deepseek.apk"`；`.ref` 已在 .gitignore 中，本文所有证据路径均为本地临时产物

## 0. 结论速览

1. 官方 App 是**单 Activity + 纯 Jetpack Compose**（`res/layout` 仅剩 3 个 AppCompat 对话框 XML），设计系统为 **自建 `DeepSeekTheme` + Material3 `ColorScheme` + M3 默认 Typography**；UI 层无自定义字体（APK 内 ttf 仅 `assets/org/scilab/...` 数学公式字体）。
2. 品牌蓝取值为 **#426EFE（浅色）/ #507BF2（深色）**，与网页端/我们仓库用的 #4D6BFE 不同；Lottie 资源中的品牌色精确为 `[0.26,0.432,0.997]` = #426EFE。
3. 官方有完整「模式」体系（快速/专家/识图），不是单一模型 + 思考开关；模式决定文件/图片能力，且**切换模式必须开新对话**。
4. 交互面远比我们宽：语音通话（打电话）、拍照/识图/OCR、分享链接与分享图、多选批量会话、登录设备管理、未成年人模式、字体大小滑杆（通过 density 缩放整个 UI）。
5. 微动效用 Lottie 内嵌（16×16、60fps、0.43–0.5s 循环；播放条 24×24、1.2s），并提供 reduced-motion 降级。

## 1. Manifest / 工程事实

证据：`AndroidManifest.xml`、`apktool.yml`

| 项 | 值 |
| --- | --- |
| package | `com.deepseek.chat` |
| version | versionName 2.9.0 / versionCode 299 |
| SDK | minSdk 24，target 36，compileSdk 37 |
| 入口 | `MainActivity`（singleTask，`windowSoftInputMode=adjustResize`，全 configChanges） |
| 其他 Activity | `ShareProxyActivity`（无界面，接收 SEND/SEND_MULTIPLE/VIEW/PROCESS_TEXT）、`TablePreviewActivity`、`WXEntryActivity` |
| 服务 | `CallForegroundService`(mediaPlayback\|microphone)、`MediaPlaybackForegroundService`、`FileUploadForegroundService`(dataSync)、3×QS Tile（新对话/拍照提问/发图提问） |
| Deep link | `dpsk://chat/new`、`dpsk://chat/share`；`com.deepseek.chat://authorized_android`；`PROCESS_TEXT` |
| 快捷方式 | `new_chat`、`camera_ask`、`send_photo`（`res/xml/shortcuts.xml`） |
| 权限 | INTERNET、CAMERA、RECORD_AUDIO、READ_MEDIA_IMAGES(+VISUAL_USER_SELECTED)、POST_NOTIFICATIONS、BLUETOOTH_CONNECT、FOREGROUND_SERVICE(_MICROPHONE/_MEDIA_PLAYBACK/_DATA_SYNC)、WAKE_LOCK |
| 其他 | allowBackup=false、enableOnBackInvokedCallback、localeConfig、usesCleartextTraffic=false |

`MainActivity` 里只有 Compose 容器（`AppEntry` 页面），页面路由由 Compose 侧 `ui.pages.*` 完成。

## 2. 颜色 token

### 2.1 品牌与语义色（可直接用）

| Token | 浅色 | 深色 | 证据 |
| --- | --- | --- | --- |
| 品牌主色 | **#426EFE** | **#507BF2** | `res/values/colors.xml` `primary`；`res/values-night/colors.xml`；`res/raw/playing.json` fill `[0.26,0.432,0.997]` |
| 品牌亮阶 | #4D8EFF | #6799FE | `smali/jf8.smali`、`smali/bq3.smali` |
| 链接/交互蓝 | #2170E4 | #ADC6FF | `smali/h23.smali` 蓝色阶 |
| 启动背景 | #FFFFFF | #0F0F0F | `colors.xml` `splashscreenBackground`（values-night） |
| 错误 | #EF4444（按压 #F25A5A） | #FFB4AB | `smali/c79.smali`；`h23.smali` |
| 警告 | #F59E0B / #DD8629 | — | `smali/cb.smali` |
| 微信绿（分享入口） | #07C160 | — | `smali/z21.smali` |

### 2.2 M3 ColorScheme 解析（中性面/文字/描边）

官方自定义了一套 M3 `ColorScheme`（48 色）：调色板在 `smali/h23.smali`，组装在 `smali/i4b.smali`（light/dark 两个实例），选择逻辑在 `smali/j4b.smali`（`DeepSeekTheme`，`fallbackMaterialColorScheme`）。按 M3 构造顺序反解出的**中性/语义 token**：

| 语义（M3） | 浅色 | 深色 | 浅色字段 |
| --- | --- | --- | --- |
| background / surface | **#F9F9FF** | **#10131A** | h23.q / h23.s；深 h23.Z / h23.b0 |
| onBackground / onSurface | **#191B23** | **#E1E2EC** | h23.r / h23.t；深 h23.a0 / h23.c0 |
| surfaceVariant | #DEE2F2 | #424754 | h23.u；深 h23.d0 |
| onSurfaceVariant | #424754 | #C2C6D6 | h23.v；深 h23.e0 |
| outline | #727785 | #8C909F | h23.w；深 h23.f0 |
| outlineVariant | #C2C6D6 | #424754 | h23.x；深 h23.g0 |
| scrim | #000000 | #000000 | h23.y；深 h23.h0 |
| surfaceBright / surfaceDim | #F9F9FF / #FFFFFF | #363941 / #10131A | h23.D/G；深 h23.m0/l0 |
| surfaceContainer* | #FFFFFF（各档） | **#171717**（各档） | h23.H/I/F/E；深 h23.p0/q0/r0/o0 |
| inverseSurface / inverseOnSurface | #EFF0FA / #2E3038* | #E1E2EC / #2E3038 | h23.A/z*；深 h23.i0/j0 |

\* 浅色 `inverseOnSurface` 的槽位解析到 h23.m=#EF4444，与 M3 语义不符，判断为**未使用槽位的占位/对齐偏移**，UI 中请用深色对应值 #2E3038。该表按 Compose `lightColorScheme()` 形参顺序推导，除上述槽位外与深色方案互洽。

> 说明：M3 的 primary/secondary/tertiary 三族在官方调色板里被复用成同一套蓝阶（#004CA7 / #2170E4 / #ADC6FF / #002E6A），说明 **M3 scheme 只是组件载体，真正面向用户的品牌按钮色来自组件默认值里的 #426EFE**。落地时：背景/文字/描边抄上表，主按钮统一用品牌蓝。

### 2.3 灰阶（`smali/pz7.smali`，22 阶）

`#0F0F0F #1E1E1E #242424 #292929 #333333 #3C3C3D #474849 #545557 #5E6063 #7D7F85 #8E9094 #A2A4A6 #B9BABB #D4D4D4 #DCDCDC #E5E5E5 #EDEDED #F0F0F0 #F5F5F5 #F8F8F8 #FAFAFA #FFFFFF`——适合做文字三级、分隔线、禁用态阶梯。

## 3. 字体 / 字号

证据：`smali/hjb.smali`（`static final Lzkb; a` = M3 默认 `Typography`）+ `smali/j4b.smali` 中 `MaterialTheme(wrapper) ... typography = Lhjb;->a`；`res/font` 为空、UI 未注册任何 ttf/otf（仅 `assets/org/scilab/forge/jlatexmath` 数学字体），即使用系统字体（Roboto / Noto Sans CJK，中文回退到系统黑体）。

| 角色 | 字号/行高（M3 库默认值，官方未覆盖） | 字重 |
| --- | --- | --- |
| displayLarge/Medium/Small | 57/64、45/52、36/44 | 400 |
| headlineLarge/Medium/Small | 32/40、28/36、24/32 | 400 |
| titleLarge/Medium/Small | 22/28、16/24、14/20 | 400/500/500 |
| bodyLarge/Medium/Small | **16/24**、14/20、12/16 | 400 |
| labelLarge/Medium/Small | 14/20、12/16、11/16 | 500 |

- 输入框正文与消息正文用 bodyLarge（16sp/24）体系；`ChatInputDefaults`/`markdownTypographyV2` 只做了局部 TextStyle 派生（`smali/a77.smali`、`smali/q47.smali`）。
- **字体大小设置**：官方不是简单换字号，而是 `FontSizeManager.OverrideDensity` / `ProvideDensity` 覆盖 density（`ui.utils` 追踪符号），配合 `FontSizeSlider` + 3 段预览文案（`font_size`、`preview_font_size_msg1-3`），可整体缩放 UI。对我们最简单等价物：给 `html` 设置 `font-size` 并对全站 rem 化。

## 4. 图标

- 全部为 Compose `ImageVector`/矢量 drawable，典型尺寸 **16 / 20 / 24 / 26 dp** 四档；命名 `ic_*_outline_20` / `*_fill_20` / `*_outline_24` / `*_outline_16`，**默认 outline、选中/激活态 fill**。
- 单色填充路径，`fillColor="#ffffff"` 运行时由 `Icon(tint=...)` 上色（例：`res/drawable/ic_send_fill_20.xml`，16dp viewport，纯 path）。风格是**几何、细笔画、圆角端点**（`lc=2, lj=2`）。
- 关键图标清单（可直接映射到我们的 SVG）：`ic_send_fill_20`、`ic_stop_fill_20`、`ic_mic_filled_20`、`ic_keyboard_voice_24`、`ic_keyboard_outline_26`、`ic_add_outline_26`、`ic_new_chat_outline_24`、`ic_menu_outline_24`、`ic_think`（think.json）、`ic_flash_on/off_fill_24`、`ic_browse_outline_16`、`ic_search_outline_16`、`ic_scan_text_filled_20`、`ic_scan_picture_filled_20`、`ic_paperclip_outline_20`、`ic_like/dislike_fill|outline`、`ic_pin/unpin_outline_20`、`ic_chevron_*`。

## 5. 圆角 / 间距 / 阴影

- 资源层**没有任何 dimens/radius 变量**（`res/values/dimens.xml` 全是 AppCompat 库默认值），全部在 Compose 内联 dp，R8 内联后无法稳定归属；主题 wrapper（`smali/n77.smali` `b(...)`）对 shapes 参数存在 null 兜底、未见自定义 Shapes 常量，**按 M3 默认 8 / 12 / 16dp（small/medium/large）**，对话框/底部弹层用 large。
- 间距建议沿用 M3 4dp 网格：页面左右 16dp、列表行高 48–56dp、组件间 8/12dp、分区 24dp。
- 阴影/Elevation：M3 tonal elevation 为主（深色靠 `surfaceContainer*` 提亮，而非投影）；`--shadow-*` 类大投影只用于弹层，不要用在消息气泡上。
- **证据边界**：本项为「未取到精确值」的诚实结论，不作为 APK 实测数值引用；我们现有 22/16/12px 圆角偏大，若想贴近官方建议降到 16/12/8 并保持气泡 18–20。

## 6. 动效

### 6.1 Lottie（`res/raw/*.json`、`assets/ic_playing_bars_24.json`）

| 资源 | 尺寸 | fr / 总帧 | 时长 | 颜色/用途 |
| --- | --- | --- | --- | --- |
| `think.json` | 16×16 | 60 / 26 | ~0.43s | 描边 #0F1115，1.4px，思考图标微动效 |
| `flash.json`、`globe.json`、`photo.json`、`expert.json` | 16×16 | 60 / 30 | 0.5s | 模式/工具图标激活动效 |
| `playing.json`、`ic_playing_bars_24.json` | 24×24 | 100 / 120、60 / 96 | 1.2s、1.6s | 填充 #426EFE，朗读/播放声波条 |
| `auto_play_on/off.json` | 25×24 | 100 / 40 | 0.4s | 自动朗读开关 |

缓动签名：关键帧 `i:{x:[1],y:[1]}, o:{x:[0.58],y:[1]}` 与 `0.42/0/0.58/1` 混用，即 **ease-in-out 风格（≈ cubic-bezier(0.42,0,0.58,1)）**，无弹跳。
> 落地：CSS 用 `cubic-bezier(.42,0,.58,1)`，150–250ms；声波条用 3 根柱 `scaleY` 错峰循环，1.2s。

### 6.2 Compose 动效组件（追踪符号，`smali` 内 `com.deepseek.chat.ui.*` 字符串）

- 抽屉：`ParallaxAnimatedContent`（侧栏视差推入）。
- 弹窗：`AnimatedDialog`、`AnimatedAppProgressIndicator`、`Snackbar` 的 `animatedOpacity/animatedScale`。
- 列表：`AnimatedLazyColumn/Row`、`MessageListScrollbarDefaults`，流式输出有 `StreamingSmoothScrollEffect`、`StreamingSmoothAutoScrollOneScreenEffect`（平滑跟随、一屏内不抢滚动）。
- 顶栏：`animateHeaderSubtitle`（标题下方副标题淡入）。
- 语音：`animatedWaveformColor`、`animatedOverlayAccentColor`、`ShaderVoiceInputDefaults`（Shader 流体波形）、`animateFluidPaletteAsState`。
- 无障碍：`isReducedMotionEnabled`（降级为无位移动画）——我们已有 `prefers-reduced-motion`，建议再补「流式打字/声波」的降级。

## 7. 关键界面结构

| 界面 | 结构要点 | 证据 |
| --- | --- | --- |
| 欢迎/空态 | Logo（`chat_welcome_logo`）、"今天有什么可以帮到你？"、两句模型欢迎语（`使用%1$s开始对话`）、信息卡「官方免费应用」「DeepSeek 可能不准确」、建议问题、底部 **模型胶囊选择器**（`modelCapsuleTab`、`modelSelectorDescription`） | strings `chat_welcome_*`、`welcome_message_title_unified`；追踪符号 `...session.views.welcome.*` |
| 抽屉 | 新对话按钮、搜索入口、置顶分组（`session_group_pinned`、折叠）、会话列表（重命名/置顶/删除/多选）、设置入口；视差动画 | `NavigationDrawerDefaults`、`show_menu`、`session_batch_*` |
| 对话页 | 顶栏（模型名 + 分支切换 `第 x 条（共 y 条）`）、消息列表、流式平滑滚动、消息操作（复制/喜欢/不喜欢/重新生成/修改并创建分支/举报/反馈标签）、思考块（自动折叠、耗时秒数）、联网搜索块（queries/结果/已读网页）、工具调用块（搜索/打开链接/查找）、Markdown 代码块（复制/保存/全屏）、Mermaid（代码/图表切换、全屏、保存） | `message_press_*`、`message_*`、`thinking_auto_fold`、`markdown.*`、`mermaid_*`、`AnimatedLazyColumn` |
| 输入区 | 多行输入（placeholder「发消息」/「发消息或按住说话」）、左侧加号（上传文件）、工具条（深度思考、智能搜索、模式工具）、提示词模板 chip（`PromptTemplateChipDefaults`）、文件卡片（数量/大小/token 上限提示）、发送/停止、语音切换、语音输入浮层（Shader 波形）、banner host | `ChatInputDefaults`、`ToolButtonDefaults`、`attach_files`、`voice_input_button`、`file_*` |
| 设置 | 主页面 + 子页：字体大小（滑块+预览）、外观（系统/浅色/深色弹窗）、语言、回答设置（思考自动折叠等）、语音（主要语言、朗读音色）、通话设置、关于/检查更新、应用权限、个人信息清单、第三方共享清单、注销账号、登录设备管理、导出全部历史对话 | `settings.SettingsPage`、`DarkThemeDialog`、`FontSizePreferencePage`、`AsrLanguageSettingItem`、`app_color_scheme*`、`profile_*` |
| 语音 | ①语音输入（按住说话 / ASR 语言）②朗读（音色、自动朗读、试听）③**打电话**（CallPage + orb + 通话字幕、说话打断、通话评价、每日时长上限） | `voice_*`、`read_aloud_*`、`call_*`、`feature.call`、`CallForegroundService` |
| 搜索 | 对话内全文搜索（结果按消息定位）、联网搜索块、搜索结果页、无结果/加载更多 | `search_*`、`message_search_*`、`fulltext_search` |
| 其他 | 相机（拍照提问/文字识别/图像识别/闪光灯/翻转）、图片编辑器（裁剪/还原）、分享（链接管理、生成分享图、微信分享、分享页免责 banner、从分享 fork 会话）、authv2（验证码/密码/注册/重置/年龄门/监护人手机）、未成年人模式、更新弹窗、权限横幅 | `camera_*`、`crop_photo*`、`share_*`、`authv2.*`、`minor_mode_*`、`UpdateDialog`、`PermissionBanners` |

## 8. 功能面清单（官方具备）

登录/账号（手机验证码、密码、注册、找回、微信/Apple/Google 三方、登录设备管理、注销）、年龄门与未成年人模式、会话（置顶分组/多选批量置顶删除/重命名/删除全部/导出全部）、模式（快速/专家/识图）、深度思考（自动折叠）、联网搜索、文件上传（本地/微信、格式与大小/数量/token 限制）、图片（拍照、相册、文字识别、图像识别、裁剪）、语音输入、朗读（音色/自动朗读/试听）、语音通话（字幕/打断/评价/限额）、分享（链接/分享图/微信/链接管理/分享页）、Markdown/Mermaid/表格预览/LaTeX、搜索、反馈举报、检查更新、权限与隐私清单、外观/语言/字体大小。

## 9. 我们的差距与建议（按优先级）

1. **P0 模式体系**：把「模型 + 思考开关」升级为三模式（快速/专家/识图），模式决定能力（识图模式只识别图片文字；专家模式仅识别文字——`expert_upload_panel_o_c_r_tip_with_vision`），切换模式需新对话（`session_model_name_tag_toast`）。输入区顶部加胶囊选择器 + 每个模式一句定位文案（"适合日常对话，即时响应"/"擅长复杂问题，高峰需等待"/"擅长理解图片内容"）。
2. **P0 品牌色对齐**：主按钮/发送键/选中药改用 **#426EFE / #507BF2**，浅色背景 #F9F9FF、正文 #191B23、描边 #C2C6D6；深色背景 #10131A、卡片 #171717、正文 #E1E2EC。我们现有 #4D6BFE + #FFFFFF + #141519 与之有明显色差。
3. **P1 分享体系**：链接创建/管理（我共享的链接 → 复制/删除）、生成分享图（长图 + 免责 footer）、分享页顶部 banner、从分享链接 fork 新会话。当前只有导出 JSON/Markdown。
4. **P1 语音能力补齐**：朗读已有，缺「音色切换 + 自动朗读 + 每日限额提示」细节和「通话」形态。若不做通话，至少补朗读音色底部弹层（`voice_switch_bottom_sheet_title`）与统一失败 toast 文案。
5. **P2 会话管理**：多选 + 批量置顶/删除（含置顶数量上限、部分为空的提示）、置顶折叠分组；我们目前仅单条操作。
6. **P2 字体大小机制**：三档 → 连续滑杆 + 预览段落（官方 3 段预览），底层用根字号/密度缩放，避免只改正文导致排版错位。
7. **P2 输入区工具条**：按官方补齐「深度思考 / 智能搜索 / 上传文件 / 拍照识图」四个 ToolButton（容器色/描边色/图标色/标签色四态），以及上传面板（本地文件 / 微信文件）。
8. **P3 合规与信任细节**：AI 生成免责 footer（`input_a_i_alert`、`profile_ai_compliance_footer`）、举报与反馈标签（虚假信息/有害/没有帮助/其他）、权限说明页与个人信息清单入口。成本低、观感提升明显。
9. **P3 动效**：统一 `cubic-bezier(.42,0,.58,1)`、150–250ms；思考/工具图标 0.43–0.5s Lottie 感循环；声波条 1.2s、3 柱错峰；`prefers-reduced-motion` 全覆盖。
10. **P3 图标规范**：outline 20/24 默认、激活换 fill，16 用于行内小控件、26 用于输入区大按钮；我们现有 `icon()` 尺寸 15/18 混用，建议收敛。

## 10. 证据索引 / 复现

- 资源：`.ref/apk/AndroidManifest.xml`、`res/values/{colors,dimens,strings,styles}.xml`、`res/values-night/colors.xml`、`res/values-b+zh+Hans/strings.xml`、`res/xml/shortcuts.xml`、`res/raw/*.json`、`res/drawable*/ic_*`
- smali：`.ref/apk-src/smali/{h23,i4b,j4b,o23,n23,j23,f23,ce8,c79,cb,pz7,bq3,v93}.smali`（颜色与主题）、`hjb.smali`（Typography）、`i4b.smali`（light/dark 组装）
- 追踪符号全集：`.ref/kt-traces.txt`（1308 条，由 smali 中 `com.deepseek.chat.*` 追踪字符串提取，页面/组件清单可直接 grep）
- 分析脚本：`.ref/apk-parse.py`、`.ref/apk-map.py`（解析 const-wide / Color 变换 / 默认参数槽位）
