import fs from 'node:fs';

const base = 'D:/ai/deepseek-mobile';
const NEW = '1.0.3';

/* 1) package.json 单源 */
let pkg = JSON.parse(fs.readFileSync(`${base}/package.json`, 'utf8'));
pkg.version = NEW;
fs.writeFileSync(`${base}/package.json`, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

/* 2) MainActivity：版本号读已安装包的 versionName */
const java = `${base}/android/app/src/com/deepseek/pocket/MainActivity.java`;
let j = fs.readFileSync(java, 'utf8');
j = j.replace('public String version() { return "1.0.0"; }', `public String version() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Throwable e) {
                return "1.0.0";
            }
        }`);
fs.writeFileSync(java, j, 'utf8');

/* 3) Manifest（CI 会用 tag 覆盖，本地构建保持一致） */
const manifest = `${base}/android/app/AndroidManifest.xml`;
let m = fs.readFileSync(manifest, 'utf8');
m = m.replace(/android:versionName="[^"]+"/, `android:versionName="${NEW}"`);
fs.writeFileSync(manifest, m, 'utf8');

/* 4) build.ps1：版本读 package.json */
const ps = `${base}/android/build.ps1`;
let p = fs.readFileSync(ps, 'utf8');
if (!p.includes('$APP_VERSION')) {
  p = p.replace('$ErrorActionPreference = \'Stop\'', `$ErrorActionPreference = 'Stop'
$APP_VERSION = (Get-Content (Join-Path (Split-Path -Parent $PSScriptRoot) 'package.json') -Raw | ConvertFrom-Json).version
if (-not $APP_VERSION) { $APP_VERSION = '1.0.0' }`);
  p = p.replace("--version-name '1.0.0' `", '--version-name $APP_VERSION `');
  p = p.replace("$apk = Join-Path $dist 'DeepSeekPocket-1.0.0.apk'", '$apk = Join-Path $dist "DeepSeekPocket-$APP_VERSION.apk"');
  p = p.replace('# 产物： android\\dist\\DeepSeekPocket-1.0.0.apk', '# 产物： android\\dist\\DeepSeekPocket-<package.json version>.apk');
  fs.writeFileSync(ps, p, 'utf8');
}

/* 5) build.sh：版本读 package.json */
const sh = `${base}/android/build.sh`;
let s = fs.readFileSync(sh, 'utf8');
s = s.replace('VERSION_NAME="${VERSION_NAME:-1.0.0}"',
  `VERSION_NAME="${VERSION_NAME:-$(node -p "require(process.env.ROOT_DIR + '/package.json').version" 2>/dev/null || echo 1.0.0)}"`);
// 需要在 ROOT 定义之后设置 ROOT_DIR
s = s.replace('ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"',
  'ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"\nexport ROOT_DIR="$ROOT"');
fs.writeFileSync(sh, s, 'utf8');

/* 6) server 版本读 package.json */
const cfg = `${base}/lib/config.mjs`;
let c = fs.readFileSync(cfg, 'utf8');
if (!c.includes("readFileSync(new URL('../package.json'")) {
  c = c.replace("export const APP_NAME =", `import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const APP_NAME =`);
  c = c.replace("export const VERSION = '1.0.0';", 'export const VERSION = pkg.version || \'1.0.0\';');
  fs.writeFileSync(cfg, c, 'utf8');
}

/* 7) 前端版本：优先原生桥，其次 meta */
const idx = `${base}/public/index.html`;
let h = fs.readFileSync(idx, 'utf8');
if (!h.includes('name="app-version"')) {
  h = h.replace('<meta name="theme-color" content="#FFFFFF" />',
    '<meta name="theme-color" content="#FFFFFF" />\n<meta name="app-version" content="' + NEW + '" />');
} else {
  h = h.replace(/<meta name="app-version" content="[^"]+" \/>/, `<meta name="app-version" content="${NEW}" />`);
}
fs.writeFileSync(idx, h, 'utf8');

const app = `${base}/public/js/app.js`;
let a = fs.readFileSync(app, 'utf8');
a = a.replace("const VERSION = '1.0.0';",
  "const VERSION = (typeof document !== 'undefined' && document.querySelector('meta[name=\"app-version\"]')?.content) || '1.0.0';");
fs.writeFileSync(app, a, 'utf8');

const api = `${base}/public/js/api.js`;
let ai = fs.readFileSync(api, 'utf8');
ai = ai.replace("version: (typeof window !== 'undefined' && window.DSAndroid?.version?.()) || '1.0.0',",
  "version: (typeof window !== 'undefined' && (window.DSAndroid?.version?.()\n            || document.querySelector('meta[name=\"app-version\"]')?.content)) || '1.0.0',");
fs.writeFileSync(api, ai, 'utf8');

/* 8) CHANGELOG */
const cl = `${base}/CHANGELOG.md`;
let ch = fs.readFileSync(cl, 'utf8');
if (!ch.includes('## [1.0.3]')) {
  ch = ch.replace('## [1.0.2] - 2026-11-19', `## [1.0.3] - 2026-11-19

### 修复

- 应用内版本号显示 1.0.0：改为读取已安装包的 versionName，版本统一以 package.json 为单一来源

## [1.0.2] - 2026-11-19`);
  ch = ch.replace('[1.0.2]: https://github.com/nagatoquin33/deepseek-pocket/compare/v1.0.1...v1.0.2',
`[1.0.3]: https://github.com/nagatoquin33/deepseek-pocket/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/nagatoquin33/deepseek-pocket/compare/v1.0.1...v1.0.2`);
  fs.writeFileSync(cl, ch, 'utf8');
}
console.log('version unified to', NEW);
