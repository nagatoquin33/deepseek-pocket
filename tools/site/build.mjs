/* =========================================================================
 * 文档站构建：把仓库 Markdown 渲染成静态站点（复用 public/js/render.js）
 *   输出： site/index.html（首页）、site/docs/*.html、site/app/（Web 版）、site/screenshots/
 * ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown } from '../../public/js/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'site');

const REPO = 'https://github.com/nagatoquin33/deepseek-pocket';
const PAGES = [
  { slug: 'overview', title: '概览', file: 'README.md' },
  { slug: 'faq', title: '常见问题', file: 'docs/FAQ.md' },
  { slug: 'architecture', title: '架构', file: 'docs/ARCHITECTURE.md' },
  { slug: 'development', title: '开发指南', file: 'docs/DEVELOPMENT.md' },
  { slug: 'api-mapping', title: 'API 映射', file: 'docs/API-MAPPING.md' },
  { slug: 'releasing', title: '发布流程', file: 'docs/RELEASING.md' },
  { slug: 'security', title: '安全', file: 'SECURITY.md' },
  { slug: 'contributing', title: '参与贡献', file: 'CONTRIBUTING.md' },
  { slug: 'changelog', title: '更新日志', file: 'CHANGELOG.md' },
];

const slugOf = (p) => (PAGES.find((x) => x.file === p) || {}).slug || null;

function rewriteLinks(md, currentFile) {
  const toHtml = (target) => {
    if (/^(https?:|mailto:|#)/.test(target)) return target;
    const [pathPart, hash = ''] = target.split('#');
    const abs = path.posix.normalize(path.posix.join(path.posix.dirname(currentFile), pathPart));
    // 1) 其他文档页
    const slug = slugOf(abs);
    if (slug) {
      const suffix = hash ? `#${hash}` : '';
      return `./${slug}.html${suffix}`;
    }
    // 2) 截图
    if (abs.startsWith('docs/screenshots/')) return `../screenshots/${path.posix.basename(abs)}`;
    if (abs.startsWith('screenshots/')) return `../screenshots/${path.posix.basename(abs)}`;
    // 3) 其它仓库文件（LICENSE、workflow 等）回落到 GitHub
    if (abs.startsWith('..') || abs.includes('LICENSE') || abs.startsWith('.github/')) {
      return `${REPO}/blob/main/${abs.replace(/^\.\.\//, '')}`;
    }
    return `${REPO}/blob/main/${abs}`;
  };
  return md.replace(/\]\(([^)\s]+)\)/g, (m, target) => `](${toHtml(target)})`);
}

const CSS = `
:root{--bg:#fff;--fg:#16181d;--muted:#6b7280;--line:#e7e9ee;--brand:#4d6bfe;--card:#f7f8fb;--code:#f6f8fa}
@media(prefers-color-scheme:dark){:root{--bg:#0f1114;--fg:#e8eaef;--muted:#9aa1ad;--line:#23262d;--brand:#7c93ff;--card:#171a1f;--code:#12151a}}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
a{color:var(--brand);text-decoration:none}a:hover{text-decoration:underline}
.wrap{display:flex;min-height:100vh;max-width:1180px;margin:0 auto}
nav{width:220px;flex:none;padding:26px 18px;border-right:1px solid var(--line);position:sticky;top:0;height:100vh;overflow:auto}
nav .brand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:16px;margin-bottom:18px}
nav .brand img{width:28px;height:28px}
nav a{display:block;padding:7px 10px;border-radius:9px;color:var(--muted);font-size:14.5px}
nav a:hover{background:var(--card);text-decoration:none}
nav a.on{color:var(--brand);background:var(--card);font-weight:600}
main{flex:1;min-width:0;padding:34px 40px 80px}
main h1{font-size:30px;margin:0 0 18px}main h2{font-size:22px;margin:34px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line)}
main h3{font-size:18px;margin:24px 0 10px}main p,main li{color:var(--fg)}
main table{border-collapse:collapse;width:100%;margin:14px 0;display:block;overflow:auto;font-size:14.5px}
main th,main td{border:1px solid var(--line);padding:8px 10px;text-align:left}main th{background:var(--card)}
main code{background:var(--code);border:1px solid var(--line);border-radius:5px;padding:1px 5px;font-size:.9em}
.code-block{border:1px solid var(--line);border-radius:10px;overflow:hidden;margin:14px 0}
.code-hd{display:flex;justify-content:space-between;padding:6px 10px;background:var(--card);font-size:12px;color:var(--muted)}
.code-copy{background:none;border:0;color:var(--muted);cursor:pointer;font-size:12px}
.code-block pre{margin:0;padding:12px;overflow:auto;background:var(--code);font-size:13px;line-height:1.6}
main img{max-width:100%;border-radius:10px}
.top{display:flex;justify-content:flex-end;gap:10px;margin-bottom:6px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:10px;font-size:14px;font-weight:600;background:var(--brand);color:#fff}
.btn.ghost{background:var(--card);color:var(--fg);border:1px solid var(--line)}
footer{margin-top:50px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
@media(max-width:820px){.wrap{display:block}nav{position:static;width:auto;height:auto;border-right:0;border-bottom:1px solid var(--line);padding:14px 16px}
nav .navlinks{display:flex;gap:4px;overflow:auto}nav a{white-space:nowrap}main{padding:22px 16px 60px}}
`;

function slugify(text) {
  return text.trim().toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[!-/:-@[-\`{-~]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-|-$/g, '');
}

function addHeadingIds(html) {
  return html.replace(/<h([1-4])>(.*?)<\/h\1>/g, (m, level, inner) => {
    const id = slugify(inner);
    return id ? `<h${level} id="${id}">${inner}</h${level}>` : m;
  });
}

function pageHtml({ title, navHtml, content, active }) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title} · DeepSeek 随身版</title><link rel="icon" href="../icons/deepseek-mark.png" /><style>${CSS}</style></head><body>
<div class="wrap">
  <nav>
    <a class="brand" href="./overview.html"><img src="../icons/deepseek-mark.png" alt="" />DeepSeek 随身版</a>
    <div class="navlinks">${navHtml}</div>
  </nav>
  <main>
    <div class="top">
      <a class="btn" href="${REPO}/releases/latest">下载 APK</a>
      <a class="btn ghost" href="../app/?direct=1">打开 Web 版</a>
    </div>
    ${content}
    <footer>MIT · 非官方客户端 · <a href="${REPO}">GitHub</a> · <a href="./changelog.html">更新日志</a></footer>
  </main>
</div>
<script>
document.addEventListener('click', async (e) => {
  const b = e.target.closest('.code-copy');
  if (!b) return;
  const code = b.closest('.code-block')?.querySelector('pre code')?.textContent || '';
  try { await navigator.clipboard.writeText(code); b.textContent = '已复制'; setTimeout(() => (b.textContent = '复制'), 1200); } catch {}
});
</script>
</body></html>`;
}

/* ---------------------------------- 构建 ---------------------------------- */
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'docs'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'screenshots'), { recursive: true });

const navFor = (active) => PAGES.map((p) => `<a href="./${p.slug}.html" class="${p.slug === active ? 'on' : ''}">${p.title}</a>`).join('');

for (const p of PAGES) {
  const src = fs.readFileSync(path.join(ROOT, p.file), 'utf8');
  const md = rewriteLinks(src, p.file);
  const html = renderMarkdown(md, { math: true });
  const output = pageHtml({ title: p.title, navHtml: navFor(p.slug), content: addHeadingIds(html), active: p.slug });
  fs.writeFileSync(path.join(OUT, 'docs', `${p.slug}.html`), output, 'utf8');
  console.log('page', p.slug, `${Math.round(output.length / 1024)}KB`);
}

/* 截图与图标 */
const shotsDir = path.join(ROOT, 'docs/screenshots');
for (const f of fs.readdirSync(shotsDir)) {
  fs.copyFileSync(path.join(shotsDir, f), path.join(OUT, 'screenshots', f));
}
fs.mkdirSync(path.join(OUT, 'icons'), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'public/icons'))) {
  fs.copyFileSync(path.join(ROOT, 'public/icons', f), path.join(OUT, 'icons', f));
}

/* Web 版（PWA）：public → /app，并把 manifest 改成相对作用域 */
const appDir = path.join(OUT, 'app');
fs.cpSync(path.join(ROOT, 'public'), appDir, { recursive: true });
const manifestPath = path.join(appDir, 'manifest.webmanifest');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.start_url = './';
manifest.scope = './';
manifest.id = './';
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
console.log('app copied');

/* 首页 */
const index = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>DeepSeek 随身版 · 用你自己的开放平台额度</title>
<meta name="description" content="手机上的 DeepSeek：深度思考、智能搜索、语音、多会话；Android APK 与 PWA，直连开放平台。" />
<link rel="icon" href="./icons/deepseek-mark.png" />
<style>${CSS}
.hero{display:grid;grid-template-columns:1.05fr .95fr;gap:40px;align-items:center;padding:24px 0 12px}
.hero h1{font-size:40px;line-height:1.18;margin:0 0 14px;letter-spacing:-.02em}
.hero p.lead{font-size:17px;color:var(--muted);margin:0 0 22px}
.hero .cta{display:flex;gap:12px;flex-wrap:wrap}
.hero .btn{padding:11px 20px;font-size:15px}
.phone{border:10px solid #1b1d22;border-radius:36px;overflow:hidden;box-shadow:0 30px 70px rgba(0,0,0,.28);max-width:300px;margin:0 auto;background:#000}
.phone img{display:block;width:100%}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:34px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
.card h3{margin:0 0 6px;font-size:16px}.card p{margin:0;color:var(--muted);font-size:13.5px;line-height:1.6}
.docs{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:12px 0 0}
.docs a{display:block;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:13px;color:var(--fg)}
.docs a b{display:block;font-size:15px;margin-bottom:3px}.docs a span{color:var(--muted);font-size:12.5px}
.end{display:flex;gap:10px;flex-wrap:wrap;margin-top:26px}
@media(max-width:820px){.hero{grid-template-columns:1fr;gap:20px}.grid,.docs{grid-template-columns:1fr 1fr}.hero h1{font-size:30px}.phone{max-width:240px}}
</style></head><body>
<div class="wrap"><main style="padding-top:30px">
  <div class="hero">
    <div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;font-weight:700;color:var(--muted)">
        <img src="./icons/deepseek-mark.png" width="34" height="34" alt="" /> DeepSeek 随身版
      </div>
      <h1>手机上的 DeepSeek<br />用你自己的额度</h1>
      <p class="lead">深度思考 · 智能搜索与引用 · 语音输入与朗读 · 多会话 · 系统提示词。<br />
      Android APK 直连开放平台，不需要电脑；也可以直接在浏览器里用。</p>
      <div class="cta">
        <a class="btn" href="${REPO}/releases/latest">下载 Android APK</a>
        <a class="btn ghost" href="./app/?direct=1">在浏览器中打开</a>
        <a class="btn ghost" href="./docs/overview.html">查看文档</a>
      </div>
      <p class="lead" style="font-size:13px;margin-top:14px">首次使用需在登录页粘贴 <a href="https://platform.deepseek.com/api_keys">开放平台 API Key</a>，按你的额度计费。</p>
    </div>
    <div class="phone"><img src="./screenshots/02-welcome.png" alt="DeepSeek 随身版首页" /></div>
  </div>

  <div class="grid">
    <div class="card"><h3>深度思考</h3><p>折叠思考过程与计时，低 / 高 / 最高三档推理强度。</p></div>
    <div class="card"><h3>智能搜索</h3><p>服务端联网工具，回答带 <code>[n]</code> 引用与来源卡片；对话内检索不计费。</p></div>
    <div class="card"><h3>语音</h3><p>按住说话（ASR）、回答朗读（TTS），跨 Android / iOS 一致。</p></div>
    <div class="card"><h3>多会话</h3><p>自动标题、置顶、搜索、导入导出；全部保存在本机。</p></div>
    <div class="card"><h3>用量透明</h3><p>输入/输出 token、缓存命中、首字延迟、速度、估算费用。</p></div>
    <div class="card"><h3>可自托管</h3><p>Node 一行命令起局域网服务；APK 与 PWA 同一套前端。</p></div>
  </div>

  <h2 style="font-size:20px;margin:8px 0 10px">文档</h2>
  <div class="docs">
    <a href="./docs/overview.html"><b>概览</b><span>功能、快速开始、计费</span></a>
    <a href="./docs/faq.html"><b>常见问题</b><span>401 / 麦克风 / 手势 / 计费口径</span></a>
    <a href="./docs/architecture.html"><b>架构</b><span>三条请求链路与模块地图</span></a>
    <a href="./docs/development.html"><b>开发指南</b><span>调试、改代码、测试</span></a>
    <a href="./docs/api-mapping.html"><b>API 映射</b><span>端点、流式事件、错误码</span></a>
    <a href="./docs/releasing.html"><b>发布流程</b><span>版本号、签名、CI</span></a>
  </div>

  <div class="end">
    <a class="btn ghost" href="${REPO}">GitHub 仓库</a>
    <a class="btn ghost" href="${REPO}/actions">CI 构建</a>
    <a class="btn ghost" href="${REPO}/releases">所有版本</a>
  </div>
  <footer>MIT · 非官方客户端，与深度求索无隶属关系 · 图标与商标归 DeepSeek, Inc. 所有</footer>
</main></div></body></html>`;
fs.writeFileSync(path.join(OUT, 'index.html'), index, 'utf8');
console.log('landing written');

/* 404 */
fs.writeFileSync(path.join(OUT, '404.html'), `<!doctype html><meta charset="utf-8"><title>404</title>
<body style="font:16px system-ui;padding:60px;text-align:center"><h1>404</h1><p><a href="/deepseek-pocket/">回到首页</a></p></body>`, 'utf8');

/* 站点体积 */
const files = [...walk(OUT)];
let total = 0;
for (const f of files) total += fs.statSync(f).size;
console.log(`site built: ${(total / 1024 / 1024).toFixed(1)} MB, ${files.length} files`);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}
