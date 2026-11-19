/* 文档检查：本地链接、图片引用、站点页面源文件是否齐全（离线、无网络） */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MD_FILES = [
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/FAQ.md',
  'docs/ARCHITECTURE.md',
  'docs/DEVELOPMENT.md',
  'docs/RELEASING.md',
  'docs/API-MAPPING.md',
  'docs/CONTRACTS.md',
];

const errors = [];
const checked = new Set();

function checkLink(fromFile, target) {
  if (!target || /^(https?:|mailto:|tel:|#)/.test(target)) return;
  const clean = decodeURIComponent(target.split('#')[0].split('?')[0]);
  if (!clean) return;
  const abs = path.resolve(path.dirname(path.join(ROOT, fromFile)), clean);
  const rel = path.relative(ROOT, abs);
  if (rel.startsWith('..')) { errors.push(`${fromFile}: 越界链接 ${target}`); return; }
  checked.add(rel);
  if (!fs.existsSync(abs)) errors.push(`${fromFile}: 文件不存在 ${target} -> ${rel}`);
}

for (const file of MD_FILES) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) { errors.push(`缺少文档 ${file}`); continue; }
  const text = fs.readFileSync(full, 'utf8');
  for (const m of text.matchAll(/\]\(([^)\s]+?)(?:\s+"[^"]*")?\)/g)) checkLink(file, m[1]);
  // 裸图片引用（HTML <img src>）
  for (const m of text.matchAll(/<img[^>]+src="([^"]+)"/g)) checkLink(file, m[1]);
}

/* README 截图必须都在 docs/screenshots 下且被引用 */
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const used = new Set([...readme.matchAll(/docs\/screenshots\/([\w.-]+)/g)].map((m) => m[1]));
const available = fs.readdirSync(path.join(ROOT, 'docs/screenshots'));
for (const f of used) if (!available.includes(f)) errors.push(`README 引用了不存在的截图 ${f}`);
const orphans = available.filter((f) => !used.has(f));
if (orphans.length) console.log(`提示：${orphans.length} 张截图未被 README 引用（${orphans.join(', ')}）`);

/* 站点构建的源文件与页面必须存在 */
const siteBuilder = fs.readFileSync(path.join(ROOT, 'tools/site/build.mjs'), 'utf8');
for (const m of siteBuilder.matchAll(/file: '([^']+\.md)'/g)) {
  if (!fs.existsSync(path.join(ROOT, m[1]))) errors.push(`站点页面缺少源文件 ${m[1]}`);
}

console.log(`检查 ${MD_FILES.length} 个文档，本地链接 ${checked.size} 个`);
if (errors.length) {
  console.error('\n发现 %d 个问题：', errors.length);
  for (const e of errors) console.error(' -', e);
  process.exit(1);
}
console.log('文档链接检查通过');
