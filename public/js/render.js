/**
 * render.js —— 零依赖 Markdown / 代码高亮 / 数学公式渲染器
 * ------------------------------------------------------------------
 * 目标：
 *  1. 纯 ESM，浏览器（原生 module）与 Node（node:test / import）双端可用；
 *  2. 零运行时依赖，不使用任何 DOM API；
 *  3. XSS 安全：模型输出中的 HTML 一律转义，URL 走白名单；
 *  4. 流式容错：未闭合的代码围栏 / 强调 / 表格都能安全降级；
 *  5. 线性扫描：块级、行内、词法高亮均为一次扫描，避免回溯灾难。
 *
 * 对外导出（见 docs/CONTRACTS.md 第三节）：
 *  - escapeHtml(s)
 *  - highlight(code, lang)
 *  - renderMath(tex, display)
 *  - renderMarkdown(md, opts)
 *
 * 已知取舍（详见文件末尾注释）：
 *  - 段内软换行直接渲染为 <br>（聊天场景更自然，非 CommonMark 的「合并为空格」）；
 *  - 不解析 Markdown 内嵌原始 HTML（全部转义展示）；
 *  - 不支持引用式链接、脚注、复杂表格（单元格内换行）、嵌套 blockquote 的惰性续行完美语义；
 *  - 代码高亮为「词法级」近似（不做语法分析），JS 正则字面量不专门识别。
 */

/* ============================================================
 * 一、基础工具：转义、URL 白名单
 * ============================================================ */

const HTML_ESCAPE_RE = /[&<>"']/g;
const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * 转义 HTML 特殊字符。所有进入输出的文本都必须经过它。
 * @param {unknown} s
 * @returns {string}
 */
export function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch]);
}

/** 属性值转义：属性统一用双引号包裹，escapeHtml 已覆盖双引号。 */
function escapeAttr(s) {
  return escapeHtml(s);
}

const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
// data: 仅允许图片（禁止 data:text/html、data:image/svg+xml 之外的脚本面）
const DATA_IMAGE_RE =
  /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif|svg\+xml|ico|x-icon)(?:;[a-z0-9=;._+-]*)?,/i;

/**
 * URL 白名单校验，返回可直接放进属性的安全字符串；不安全返回 null。
 * 允许：http/https/mailto/tel、页内锚点 #、data:image/*。
 */
function safeUrl(raw) {
  if (typeof raw !== 'string') return null;
  let u = raw.trim();
  if (!u) return null;
  // 去掉不可见控制字符，避免 "java\tscript:" 之类的绕过尝试
  u = u.replace(/[\u0000-\u001f\u007f]/g, '');
  if (!u) return null;
  // URL 中不允许空白/引号/尖括号/反引号：既不符合 URL 规范，也避免属性注入面
  if (/[\s"'<>`]/.test(u)) return null;

  // 页内锚点
  if (u.startsWith('#')) return escapeAttr(u);

  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(u);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === 'data') {
      return DATA_IMAGE_RE.test(u) ? escapeAttr(u) : null;
    }
    if (!ALLOWED_SCHEMES.has(scheme)) return null;
    return escapeAttr(u);
  }

  // 无 scheme 的（相对路径、裸域名、协议相对 //）一律拒绝，保持白名单最小面
  return null;
}

/**
 * 安全的 <a>；URL 非法时只渲染内部文本。
 * 说明：不接受 title（链接标题），避免任何额外属性面。
 */
function renderLink(href, innerHtml) {
  const url = safeUrl(href);
  if (!url) return innerHtml;
  return `<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${innerHtml}</a>`;
}

/** 安全的 <img>：懒加载、只允许安全 URL（不接受 title 属性）。 */
function renderImage(src, alt) {
  const url = safeUrl(src);
  const altText = alt || '';
  if (!url) return altText ? escapeHtml(altText) : '';
  return `<img src="${url}" alt="${escapeAttr(altText)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
}

/* ============================================================
 * 二、代码高亮：语言别名 / 显示名 / 词法规则
 * ============================================================ */

const LANG_ALIASES = new Map([
  // JS 家族
  ['js', 'js'], ['javascript', 'js'], ['mjs', 'js'], ['cjs', 'js'], ['node', 'js'],
  ['ts', 'ts'], ['typescript', 'ts'], ['mts', 'ts'], ['cts', 'ts'],
  ['jsx', 'jsx'], ['tsx', 'tsx'],
  ['json', 'json'], ['jsonc', 'json'], ['json5', 'json'],
  // Shell
  ['bash', 'bash'], ['sh', 'bash'], ['shell', 'bash'], ['zsh', 'bash'],
  ['console', 'bash'], ['shellscript', 'bash'], ['powershell', 'bash'], ['ps1', 'bash'],
  // Python
  ['python', 'python'], ['py', 'python'], ['python3', 'python'],
  // 标记 / 样式
  ['html', 'html'], ['xhtml', 'html'], ['xml', 'html'], ['svg', 'html'], ['vue', 'html'],
  ['css', 'css'], ['scss', 'css'], ['less', 'css'],
  // 数据 / 查询
  ['sql', 'sql'], ['mysql', 'sql'], ['postgresql', 'sql'], ['pgsql', 'sql'], ['sqlite', 'sql'],
  // 系统语言
  ['go', 'go'], ['golang', 'go'],
  ['rust', 'rust'], ['rs', 'rust'],
  ['java', 'java'],
  ['c', 'c'],
  ['cpp', 'cpp'], ['c++', 'cpp'], ['cc', 'cpp'], ['cxx', 'cpp'], ['hpp', 'cpp'],
  // 配置 / 其它
  ['yaml', 'yaml'], ['yml', 'yaml'],
  ['diff', 'diff'], ['patch', 'diff'],
  ['markdown', 'markdown'], ['md', 'markdown'], ['mdx', 'markdown'],
  ['plain', 'plain'], ['plaintext', 'plain'], ['text', 'plain'], ['txt', 'plain'],
]);

const LANG_DISPLAY = {
  js: 'JavaScript',
  ts: 'TypeScript',
  jsx: 'JSX',
  tsx: 'TSX',
  json: 'JSON',
  bash: 'Bash',
  python: 'Python',
  html: 'HTML',
  css: 'CSS',
  sql: 'SQL',
  go: 'Go',
  rust: 'Rust',
  java: 'Java',
  c: 'C',
  cpp: 'C++',
  yaml: 'YAML',
  diff: 'Diff',
  markdown: 'Markdown',
  plain: 'Text',
};

/**
 * 语言归一化。
 * @returns {{canon: string|null, key: string}} canon 为已知语言键（未知为 null），key 用于展示
 */
function canonicalLang(lang) {
  const raw = String(lang ?? '')
    .trim()
    .split(/[\s{]/)[0]
    .replace(/^language-/i, '')
    .replace(/^[.]+/, '')
    .toLowerCase();
  if (!raw) return { canon: 'plain', key: 'plain' };
  const canon = LANG_ALIASES.get(raw);
  if (canon) return { canon, key: canon };
  return { canon: null, key: raw };
}

/* ---------- 2.1 规则构造工具 ---------- */

/** 把字面词转成安全的正则片段（非捕获组外部使用）。 */
function escReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 大小写敏感关键字：\b(?:a|b|c)\b */
function words(list) {
  return `\\b(?:${list.map(escReg).join('|')})\\b`;
}

/** 大小写不敏感关键字（SQL 用），逐字母展开字符类。 */
function ciWords(list) {
  const parts = list.map((w) =>
    w
      .split('')
      .map((ch) => (/[a-zA-Z]/.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : escReg(ch)))
      .join('')
  );
  return `\\b(?:${parts.join('|')})\\b`;
}

/* ---------- 2.2 规则片段 ---------- */

const RE_LINE_COMMENT = String.raw`\/\/[^\n]*`;
const RE_BLOCK_COMMENT = String.raw`\/\*[\s\S]*?\*\/`;
const RE_HASH_COMMENT = String.raw`#[^\n]*`;
const RE_DQ_STR = String.raw`"(?:[^"\\\n]|\\.)*"`;
const RE_SQ_STR = String.raw`'(?:[^'\\\n]|\\.)*'`;
// JS 模板字符串（反引号无法放进 String.raw，用普通字符串转义构造）
const RE_JS_TEMPLATE_STR = '`(?:[^`\\\\]|\\\\.)*`';

const RE_NUM = String.raw`\b(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|0[bB][01](?:_?[01])*|0[oO][0-7](?:_?[0-7])*|\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?(?:[eE][+-]?\d+)?)\b`;
const RE_JS_OP = String.raw`===|!==|>>>|<<=|>>=|=>|\*\*|&&|\|\||\?\?|\.\.\.|\+\+|--|[+\-*/%&|^!~<>=?:]`;
const RE_C_OP = String.raw`->|::|<<=|>>=|===|!==|&&|\|\||<<|>>|[+\-*/%&|^!~<>=?:]`;
const RE_GO_OP = String.raw`:=|<-|\.\.\.|&&|\|\||==|!=|<=|>=|[+\-*/%&|^!<>=]`;
const RE_PY_OP = String.raw`\*\*|\/\/|:=|->|==|!=|<=|>=|[+\-*/%&|^~<>=@]`;
const RE_SH_OP = String.raw`\|\||&&|>>|>&|[|&;<>()\[\]{}]`;

/* ---------- 2.3 各语言规则表 ----------
 * 结构：[tokenClass, regexSource]，按优先级排列，全部使用非捕获组，
 * 以保证合并成一条 sticky 正则时分组编号稳定。
 */

const JS_KW = [
  'abstract', 'as', 'asserts', 'async', 'await', 'break', 'case', 'catch', 'class',
  'const', 'constructor', 'continue', 'debugger', 'declare', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function',
  'get', 'if', 'implements', 'import', 'in', 'infer', 'instanceof', 'interface',
  'keyof', 'let', 'namespace', 'never', 'new', 'null', 'of', 'override', 'package',
  'private', 'protected', 'public', 'readonly', 'return', 'satisfies', 'set', 'static',
  'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined',
  'unique', 'unknown', 'var', 'void', 'while', 'with', 'yield',
];

const JS_TYPE = [
  'Array', 'ArrayBuffer', 'BigInt', 'Boolean', 'Date', 'Error', 'EvalError',
  'Function', 'Infinity', 'Intl', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object',
  'Promise', 'Proxy', 'RangeError', 'ReferenceError', 'Reflect', 'RegExp', 'Set',
  'String', 'Symbol', 'SyntaxError', 'TypeError', 'URIError', 'WeakMap', 'WeakSet',
  'console', 'document', 'globalThis', 'window',
];

const JS_RULES = [
  ['com', `${RE_LINE_COMMENT}|${RE_BLOCK_COMMENT}`],
  ['str', `${RE_DQ_STR}|${RE_SQ_STR}|${RE_JS_TEMPLATE_STR}`],
  ['kw', words(JS_KW)],
  ['fn', String.raw`[A-Za-z_$][\w$]*(?=\s*\()`],
  ['type', `${words(JS_TYPE)}|\\b[A-Z][A-Za-z0-9_$]*\\b`],
  ['num', RE_NUM],
  ['op', RE_JS_OP],
  ['var', String.raw`\$[A-Za-z_$][\w$]*`],
];

const JSX_RULES = [
  ['com', `${RE_LINE_COMMENT}|${RE_BLOCK_COMMENT}`],
  ['str', `${RE_DQ_STR}|${RE_SQ_STR}|${RE_JS_TEMPLATE_STR}`],
  ['tag', String.raw`<\/?[A-Za-z][\w.:-]*|\/>`],
  ['kw', words(JS_KW)],
  ['fn', String.raw`[A-Za-z_$][\w$]*(?=\s*\()`],
  ['type', `${words(JS_TYPE)}|\\b[A-Z][A-Za-z0-9_$]*\\b`],
  ['num', RE_NUM],
  ['op', RE_JS_OP],
  ['var', String.raw`\$[A-Za-z_$][\w$]*`],
];

const JSON_RULES = [
  ['com', RE_LINE_COMMENT],
  ['attr', String.raw`"(?:[^"\\\n]|\\.)*"(?=\s*:)`],
  ['str', RE_DQ_STR],
  ['kw', words(['true', 'false', 'null'])],
  ['num', RE_NUM],
  ['op', String.raw`[{}\[\],:]`],
];

const BASH_KW = [
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case',
  'esac', 'function', 'in', 'return', 'local', 'export', 'declare', 'readonly',
  'unset', 'source', 'alias', 'break', 'continue', 'exit', 'shift', 'trap', 'set',
  'eval', 'exec', 'test',
];

const BASH_CMDS = [
  'echo', 'cd', 'pwd', 'ls', 'cat', 'grep', 'egrep', 'sed', 'awk', 'curl', 'wget',
  'git', 'npm', 'pnpm', 'yarn', 'node', 'deno', 'python', 'pip', 'mkdir', 'rmdir',
  'rm', 'cp', 'mv', 'touch', 'chmod', 'chown', 'sudo', 'apt', 'apt-get', 'yum',
  'docker', 'kubectl', 'systemctl', 'ssh', 'scp', 'tar', 'unzip', 'find', 'xargs',
  'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'tee', 'kill', 'ps', 'top',
  'df', 'du', 'mount', 'umount', 'which', 'command', 'read', 'printf', 'sleep',
];

const BASH_RULES = [
  ['com', RE_HASH_COMMENT],
  ['str', `${RE_DQ_STR}|'[^']*'`],
  ['var', String.raw`\$\{[^}\n]*\}|\$[A-Za-z_][\w]*|\$[0-9@#?*!$-]`],
  ['kw', words(BASH_KW)],
  ['fn', words(BASH_CMDS)],
  ['num', String.raw`\b\d+\b`],
  ['op', RE_SH_OP],
];

const PY_KW = [
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
  'del', 'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if',
  'import', 'in', 'is', 'lambda', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'True', 'try', 'while', 'with', 'yield', 'match', 'case',
];

const PY_TYPE = [
  'bool', 'bytes', 'dict', 'float', 'frozenset', 'int', 'list', 'object', 'range',
  'set', 'str', 'tuple', 'type', 'Exception', 'ValueError', 'TypeError', 'KeyError',
  'IndexError', 'RuntimeError', 'StopIteration', 'super', 'print', 'len', 'enumerate',
  'zip', 'open', 'isinstance', 'issubclass', 'staticmethod', 'classmethod', 'property',
  'abs', 'sorted', 'reversed', 'sum', 'min', 'max', 'map', 'filter', 'input', 'format',
  'repr', 'id', 'iter', 'next',
];

const PY_RULES = [
  ['com', RE_HASH_COMMENT],
  ['str', String.raw`"""[\s\S]*?"""|'''[\s\S]*?'''|${RE_DQ_STR}|${RE_SQ_STR}`],
  ['kw', words(PY_KW)],
  ['attr', String.raw`@[A-Za-z_][\w.]*`],
  ['fn', String.raw`[A-Za-z_][\w]*(?=\s*\()`],
  ['type', words(PY_TYPE)],
  ['num', RE_NUM],
  ['op', RE_PY_OP],
  ['var', String.raw`\bself\b|\bcls\b`],
];

const HTML_RULES = [
  ['com', String.raw`<!--[\s\S]*?-->`],
  ['tag', String.raw`<\/?[A-Za-z][\w:-]*|<!DOCTYPE[^>]*>|<!\[CDATA\[[\s\S]*?\]\]>`],
  ['str', `${RE_DQ_STR}|'[^']*'`],
  ['attr', String.raw`[A-Za-z_:][\w:.-]*(?=\s*=)`],
  ['var', String.raw`&[A-Za-z#][\w]*;`],
  ['op', String.raw`[<>/=]+`],
];

const CSS_RULES = [
  ['com', String.raw`\/\*[\s\S]*?\*\/`],
  ['str', `${RE_DQ_STR}|'[^'\n]*'`],
  ['kw', String.raw`@[\w-]+|!important\b`],
  ['attr', String.raw`[-A-Za-z_][\w-]*(?=\s*:)`],
  ['num', String.raw`#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|pt|ch)?\b`],
  ['fn', String.raw`[A-Za-z-][\w-]*(?=\()`],
  ['op', String.raw`[{}();:,>+~*=|^$]`],
];

const SQL_KW = [
  'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete',
  'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'on', 'group', 'by',
  'order', 'having', 'limit', 'offset', 'as', 'and', 'or', 'not', 'null', 'is', 'in',
  'like', 'between', 'distinct', 'union', 'all', 'create', 'table', 'primary', 'key',
  'foreign', 'references', 'drop', 'alter', 'add', 'column', 'index', 'default',
  'count', 'sum', 'avg', 'min', 'max', 'case', 'when', 'then', 'else', 'end', 'exists',
  'desc', 'asc', 'view', 'database', 'if', 'begin', 'commit', 'rollback', 'transaction',
  'with', 'returning', 'using', 'natural', 'window', 'partition', 'over', 'cast',
  'coalesce', 'nullif', 'unique', 'check', 'constraint', 'trigger', 'procedure',
  'function', 'declare', 'cursor', 'fetch', 'grant', 'revoke', 'truncate',
];

const SQL_RULES = [
  ['com', String.raw`--[^\n]*|\/\*[\s\S]*?\*\/`],
  ['str', String.raw`'(?:[^']|'')*'|"(?:[^"]|"")*"`],
  ['kw', ciWords(SQL_KW)],
  ['fn', String.raw`[A-Za-z_][\w$]*(?=\s*\()`],
  ['num', String.raw`\b\d+(?:\.\d+)?\b`],
  ['op', String.raw`[=<>!+\-*/%,;().]+`],
];

const GO_KW = [
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else',
  'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map',
  'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var', 'nil',
  'true', 'false', 'iota',
];

const GO_TYPE = [
  'bool', 'byte', 'complex64', 'complex128', 'error', 'float32', 'float64', 'int',
  'int8', 'int16', 'int32', 'int64', 'rune', 'string', 'uint', 'uint8', 'uint16',
  'uint32', 'uint64', 'uintptr', 'any',
];

const GO_RULES = [
  ['com', `${RE_LINE_COMMENT}|${RE_BLOCK_COMMENT}`],
  ['str', `\`[^\`]*\`|${RE_DQ_STR}|${RE_SQ_STR}`],
  ['kw', words(GO_KW)],
  ['type', words(GO_TYPE)],
  ['fn', String.raw`[A-Za-z_][\w]*(?=\s*\()`],
  ['num', RE_NUM],
  ['op', RE_GO_OP],
];

const RS_KW = [
  'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else',
  'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match',
  'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct',
  'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while', 'yield',
  'macro_rules',
];

const RS_TYPE = [
  'bool', 'char', 'f32', 'f64', 'i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'str',
  'u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'String', 'Vec', 'Option', 'Result',
  'Box', 'Rc', 'Arc', 'HashMap', 'HashSet', 'Some', 'None', 'Ok', 'Err',
];

const RUST_RULES = [
  ['com', `${RE_LINE_COMMENT}|${RE_BLOCK_COMMENT}`],
  ['attr', String.raw`#!?\[[^\]\n]*\]`],
  ['str', String.raw`r#*"(?:[^"]|"(?!#))*"#*|${RE_DQ_STR}`],
  ['char', String.raw`'(?:[^'\\\n]|\\.)'`],
  ['type', String.raw`'[A-Za-z_]\w*`],
  ['kw', words(RS_KW)],
  ['type', words(RS_TYPE)],
  ['macro', String.raw`[A-Za-z_][\w]*!`],
  ['fn', String.raw`[A-Za-z_][\w]*(?=\s*\()`],
  ['num', String.raw`\b(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)(?:[iu](?:8|16|32|64|128|size)|f(?:32|64))?\b`],
  ['op', RE_C_OP],
];

const JAVA_KW = [
  'abstract', 'assert', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'default', 'do', 'else', 'enum', 'extends', 'final', 'finally', 'for', 'goto', 'if',
  'implements', 'import', 'instanceof', 'interface', 'native', 'new', 'package',
  'private', 'protected', 'public', 'return', 'static', 'strictfp', 'super', 'switch',
  'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'volatile', 'while',
  'true', 'false', 'null', 'var', 'record', 'sealed', 'permits', 'yield',
];

const JAVA_TYPE = [
  'String', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Byte', 'Short',
  'Character', 'Object', 'List', 'ArrayList', 'Map', 'HashMap', 'Set', 'HashSet',
  'Optional', 'Stream', 'Exception', 'RuntimeException', 'System', 'Math', 'Thread',
  'Runnable', 'Class', 'Void', 'StringBuilder', 'Collections', 'Arrays', 'Objects',
];

const JAVA_RULES = [
  ['com', `${RE_LINE_COMMENT}|${RE_BLOCK_COMMENT}`],
  ['str', String.raw`"""[\s\S]*?"""|${RE_DQ_STR}|'[^'\\\n]'`],
  ['attr', String.raw`@[A-Za-z_][\w.]*`],
  ['kw', words(JAVA_KW)],
  ['type', `${words(JAVA_TYPE)}|\\b[A-Z][A-Za-z0-9_$]*\\b`],
  ['fn', String.raw`[A-Za-z_$][\w$]*(?=\s*\()`],
  ['num', RE_NUM],
  ['op', RE_C_OP],
];

const C_KW = [
  'auto', 'break', 'case', 'const', 'continue', 'default', 'do', 'else', 'enum',
  'extern', 'for', 'goto', 'if', 'inline', 'register', 'restrict', 'return', 'sizeof',
  'static', 'struct', 'switch', 'typedef', 'union', 'volatile', 'while', 'class',
  'namespace', 'template', 'public', 'private', 'protected', 'virtual', 'override',
  'new', 'delete', 'using', 'try', 'catch', 'throw', 'constexpr', 'nullptr', 'true',
  'false', 'this', 'noexcept', 'static_cast', 'dynamic_cast', 'const_cast',
  'reinterpret_cast', 'typename', 'operator', 'friend', 'explicit', 'mutable',
];

const C_TYPE = [
  'bool', 'char8_t', 'char16_t', 'char32_t', 'char', 'double', 'float', 'int', 'long',
  'short', 'signed', 'unsigned', 'void', 'size_t', 'ssize_t', 'int8_t', 'int16_t',
  'int32_t', 'int64_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'FILE', 'std',
  'string', 'vector', 'map', 'set', 'unique_ptr', 'shared_ptr', 'cout', 'cin', 'endl',
  'printf', 'malloc', 'free', 'memcpy',
];

const C_RULES = [
  ['com', `${RE_LINE_COMMENT}|${RE_BLOCK_COMMENT}`],
  ['kw', String.raw`#[ \t]*[A-Za-z_]\w*`],
  ['str', `${RE_DQ_STR}|'[^'\\\n]'`],
  ['kw', words(C_KW)],
  ['type', words(C_TYPE)],
  ['fn', String.raw`[A-Za-z_][\w]*(?=\s*\()`],
  ['num', RE_NUM],
  ['op', RE_C_OP],
];

const YAML_RULES = [
  ['com', RE_HASH_COMMENT],
  ['str', String.raw`${RE_DQ_STR}|'(?:[^']|'')*'`],
  ['attr', String.raw`[A-Za-z_][\w.-]*(?=\s*:)`],
  ['num', String.raw`\b\d+(?:\.\d+)?\b`],
  ['kw', String.raw`\b(?:true|false|null|yes|no|on|off)\b|~`],
  ['var', String.raw`&[A-Za-z_][\w.-]*|\*[A-Za-z_][\w.-]*`],
  ['op', String.raw`\[|\]|\{|\}|,|-(?=\s)|:`],
];

const MD_CODE_SPAN = '`[^`\\n]*`';
const MD_RULES = [
  ['kw', String.raw`#{1,6}[ \t][^\n]*`],
  ['str', MD_CODE_SPAN],
  ['fn', String.raw`\[[^\]\n]*\]\([^)\n]*\)`],
  ['op', String.raw`\*\*|__|~~|[*_]`],
];

const RULES = {
  js: JS_RULES,
  ts: JS_RULES,
  jsx: JSX_RULES,
  tsx: JSX_RULES,
  json: JSON_RULES,
  bash: BASH_RULES,
  python: PY_RULES,
  html: HTML_RULES,
  css: CSS_RULES,
  sql: SQL_RULES,
  go: GO_RULES,
  rust: RUST_RULES,
  java: JAVA_RULES,
  c: C_RULES,
  cpp: C_RULES,
  yaml: YAML_RULES,
  markdown: MD_RULES,
};

// Rust 规则里 type2 只是想复用 type 类名，统一映射到 tok-type
const TOKEN_CLASS_ALIAS = { type2: 'type' };

/* ---------- 2.4 一次性扫描 tokenizer ---------- */

const compiledRuleCache = new WeakMap();

function compileRules(rules) {
  let compiled = compiledRuleCache.get(rules);
  if (compiled) return compiled;
  const source = rules.map(([, re]) => `(${re})`).join('|');
  compiled = {
    re: new RegExp(source, 'y'), // sticky：必须从 lastIndex 精确匹配，避免 O(n²) 搜索
    classes: rules.map(([cls]) => TOKEN_CLASS_ALIAS[cls] || cls),
  };
  compiledRuleCache.set(rules, compiled);
  return compiled;
}

/**
 * 线性词法扫描：每个位置只尝试一次 sticky 正则，未命中就并入普通文本。
 * token 文本一律 escapeHtml，输出可安全插入 DOM。
 */
function tokenize(code, rules) {
  const { re, classes } = compileRules(rules);
  const out = [];
  let pos = 0;
  let plainStart = 0;

  while (pos < code.length) {
    re.lastIndex = pos;
    const m = re.exec(code);
    if (m && m[0].length > 0) {
      let group = 1;
      while (group < m.length && m[group] === undefined) group++;
      if (group < m.length && m[group].length > 0) {
        if (pos > plainStart) out.push(escapeHtml(code.slice(plainStart, pos)));
        out.push(`<span class="tok-${classes[group - 1]}">${escapeHtml(m[0])}</span>`);
        pos = re.lastIndex;
        plainStart = pos;
        continue;
      }
    }
    pos++;
  }
  if (plainStart < code.length) out.push(escapeHtml(code.slice(plainStart)));
  return out.join('');
}

/** diff 按行着色：新增行 / 删除行 / hunk 头 / 文件头。 */
function highlightDiff(code) {
  const lines = code.split('\n');
  const out = [];
  for (const line of lines) {
    if (/^(?:diff --git|index |--- |\+\+\+ |new file|deleted file|similarity |rename |old mode|new mode)/.test(line)) {
      out.push(`<span class="tok-com">${escapeHtml(line)}</span>`);
    } else if (/^@@/.test(line)) {
      out.push(`<span class="tok-var">${escapeHtml(line)}</span>`);
    } else if (line.startsWith('+')) {
      out.push(`<span class="tok-add">${escapeHtml(line)}</span>`);
    } else if (line.startsWith('-')) {
      out.push(`<span class="tok-del">${escapeHtml(line)}</span>`);
    } else {
      out.push(escapeHtml(line));
    }
  }
  return out.join('\n');
}

/**
 * 代码高亮入口：返回已转义的安全 HTML。
 * @param {string} code
 * @param {string} [lang]
 * @returns {string}
 */
export function highlight(code, lang) {
  const text = code === null || code === undefined ? '' : String(code);
  const { canon } = canonicalLang(lang);
  if (!canon || canon === 'plain') return escapeHtml(text);
  if (canon === 'diff') return highlightDiff(text);
  const rules = RULES[canon];
  if (!rules) return escapeHtml(text);
  return tokenize(text, rules);
}

/* ============================================================
 * 三、数学公式：TeX 子集解析
 * ------------------------------------------------------------
 * 输出结构：
 *   行内 <span class="math math-inline">…</span>
 *   块级 <div  class="math math-display">…</div>
 * 内部使用 span.math-*（frac/sup/sub/sqrt/text/op/greek/var/num/script/...）；
 * 未知命令降级为 <code class="math-fallback">\cmd</code>。
 * ============================================================ */

const MATH_GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ',
  rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ',
  phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

const MATH_OPS = {
  // 大型运算符
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮',
  lim: 'lim', max: 'max', min: 'min', sup: 'sup', inf: 'inf', det: 'det', gcd: 'gcd',
  // 二元运算 / 关系
  times: '×', cdot: '⋅', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆',
  circ: '∘', bullet: '∙', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠',
  neq: '≠', approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', propto: '∝',
  ll: '≪', gg: '≫', infty: '∞', partial: '∂', nabla: '∇', prime: '′',
  forall: '∀', exists: '∃', nexists: '∄', in: '∈', notin: '∉', ni: '∋',
  subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩',
  setminus: '∖', emptyset: '∅', varnothing: '∅',
  // 箭头
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔',
  Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', mapsto: '↦',
  implies: '⟹', iff: '⟺',
  // 省略号
  cdots: '⋯', ldots: '…', dots: '…', vdots: '⋮', ddots: '⋱',
  // 其它
  angle: '∠', perp: '⊥', parallel: '∥', therefore: '∴', because: '∵',
  langle: '⟨', rangle: '⟩', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋',
  lvert: '|', rvert: '|', vert: '|', mid: '|', nmid: '∤',
  // 间距命令
  quad: '\u2003', qquad: '\u2003\u2003', ',': '\u2009', ';': '\u2005',
  ':': '\u2004', '!': '',
};

class MathParser {
  constructor(src) {
    this.s = src;
    this.i = 0;
  }

  skipSpace() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  parse() {
    return this.parseSeq(false);
  }

  /** 解析一段序列；inGroup 为 true 时遇到 } 结束。 */
  parseSeq(inGroup) {
    const nodes = [];
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i];

      // 分组结束
      if (c === '}') {
        this.i++;
        if (inGroup) return nodes.join('');
        nodes.push(escapeHtml('}'));
        continue;
      }

      // 分组开始
      if (c === '{') {
        this.i++;
        nodes.push(`<span class="math-group">${this.parseSeq(true)}</span>`);
        continue;
      }

      // 上下标：挂到前一个节点上
      if (c === '^' || c === '_') {
        const base = nodes.length ? nodes.pop() : '';
        let sup = '';
        let sub = '';
        while (this.i < s.length && (s[this.i] === '^' || s[this.i] === '_')) {
          const kind = s[this.i];
          this.i++;
          const arg = this.parseArg();
          if (kind === '^') sup = arg;
          else sub = arg;
        }
        nodes.push(
          `<span class="math-script"><span class="math-base">${base}</span>` +
            (sup ? `<span class="math-sup">${sup}</span>` : '') +
            (sub ? `<span class="math-sub">${sub}</span>` : '') +
            '</span>'
        );
        continue;
      }

      // 空白在数学模式下不产生可见文本
      if (/\s/.test(c)) {
        this.i++;
        continue;
      }

      nodes.push(this.parseToken());
    }
    return nodes.join('');
  }

  /**
   * 解析一个参数：{...} 分组、单条命令，或单个「原子」token。
   * 遵循 TeX 语义：无花括号时 \frac12 表示 \frac{1}{2}，只吃一个字符。
   */
  parseArg() {
    this.skipSpace();
    if (this.i >= this.s.length) return '';
    const c = this.s[this.i];
    if (c === '{') {
      this.i++;
      return this.parseSeq(true);
    }
    if (c === '\\') return this.parseCommand();
    this.i++;
    if (/[A-Za-z]/.test(c)) return `<span class="math-var">${escapeHtml(c)}</span>`;
    if (/[0-9]/.test(c)) return `<span class="math-num">${escapeHtml(c)}</span>`;
    return `<span class="math-op">${escapeHtml(c)}</span>`;
  }

  /** 解析一个 token（保证推进 this.i）。 */
  parseToken() {
    const s = this.s;
    const c = s[this.i];

    if (c === '\\') return this.parseCommand();

    if (c === '{') {
      this.i++;
      return `<span class="math-group">${this.parseSeq(true)}</span>`;
    }

    if (/[A-Za-z]/.test(c)) {
      let run = '';
      while (this.i < s.length && /[A-Za-z]/.test(s[this.i])) {
        run += s[this.i];
        this.i++;
      }
      return `<span class="math-var">${escapeHtml(run)}</span>`;
    }

    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[this.i + 1] || ''))) {
      let run = '';
      while (this.i < s.length && /[0-9.]/.test(s[this.i])) {
        run += s[this.i];
        this.i++;
      }
      return `<span class="math-num">${escapeHtml(run)}</span>`;
    }

    this.i++;
    return `<span class="math-op">${escapeHtml(c)}</span>`;
  }

  /** 解析反斜杠命令（含单字符命令）。 */
  parseCommand() {
    const s = this.s;
    this.i++; // 跳过反斜杠
    if (this.i >= s.length) return escapeHtml('\\');

    const ch = s[this.i];
    if (!/[A-Za-z]/.test(ch)) {
      this.i++;
      if (ch === ',' || ch === ';' || ch === ':' || ch === ' ') {
        return '<span class="math-space"> </span>';
      }
      if (ch === '!') return '';
      if (ch === '\\') return '<span class="math-space"></span>'; // 换行
      return `<span class="math-op">${escapeHtml(ch)}</span>`;
    }

    let name = '';
    while (this.i < s.length && /[A-Za-z]/.test(s[this.i])) {
      name += s[this.i];
      this.i++;
    }
    return this.renderCommand(name);
  }

  renderCommand(name) {
    switch (name) {
      case 'frac':
      case 'dfrac':
      case 'tfrac': {
        const num = this.parseArg();
        const den = this.parseArg();
        return `<span class="math-frac"><span class="math-frac-num">${num}</span><span class="math-frac-den">${den}</span></span>`;
      }
      case 'sqrt': {
        this.skipSpace();
        let index = '';
        if (this.s[this.i] === '[') {
          const end = this.s.indexOf(']', this.i);
          if (end > this.i) {
            index = this.s.slice(this.i + 1, end);
            this.i = end + 1;
          }
        }
        const arg = this.parseArg();
        const indexHtml = index
          ? `<span class="math-root">${escapeHtml(index)}</span>`
          : '';
        return `<span class="math-sqrt">${indexHtml}<span class="math-radicand">${arg}</span></span>`;
      }
      case 'text':
        return `<span class="math-text">${escapeHtml(this.readRaw())}</span>`;
      case 'mathrm':
        return `<span class="math-text math-rm">${escapeHtml(this.readRaw())}</span>`;
      case 'mathbf':
        return `<span class="math-text math-bf">${escapeHtml(this.readRaw())}</span>`;
      case 'mathit':
        return `<span class="math-text math-it">${escapeHtml(this.readRaw())}</span>`;
      case 'operatorname':
        return `<span class="math-text math-op-name">${escapeHtml(this.readRaw())}</span>`;
      case 'left':
      case 'right':
        return this.parseDelimiter();
      case 'overline':
        return `<span class="math-overline">${this.parseArg()}</span>`;
      case 'underline':
        return `<span class="math-underline">${this.parseArg()}</span>`;
      case 'vec':
        return `<span class="math-accent math-vec">${this.parseArg()}</span>`;
      case 'bar':
        return `<span class="math-accent math-bar">${this.parseArg()}</span>`;
      case 'hat':
        return `<span class="math-accent math-hat">${this.parseArg()}</span>`;
      case 'dot':
        return `<span class="math-accent math-dot">${this.parseArg()}</span>`;
      case 'tilde':
        return `<span class="math-accent math-tilde">${this.parseArg()}</span>`;
      case 'displaystyle':
      case 'textstyle':
      case 'scriptstyle':
      case 'limits':
      case 'nolimits':
        return '';
      case 'begin':
        return `<code class="math-fallback">\\begin{${escapeHtml(this.readRaw())}}</code>`;
      case 'end':
        return `<code class="math-fallback">\\end{${escapeHtml(this.readRaw())}}</code>`;
      default: {
        if (MATH_GREEK[name] !== undefined) {
          return `<span class="math-greek">${MATH_GREEK[name]}</span>`;
        }
        if (MATH_OPS[name] !== undefined) {
          const value = MATH_OPS[name];
          if (value === '') return '';
          if (name === 'quad' || name === 'qquad') {
            return `<span class="math-space">${value}</span>`;
          }
          return `<span class="math-op">${value}</span>`;
        }
        // 未知命令：安全降级，保留命令字面量
        return `<code class="math-fallback">\\${escapeHtml(name)}</code>`;
      }
    }
  }

  /** \left / \right 后面的定界符。 */
  parseDelimiter() {
    this.skipSpace();
    const s = this.s;
    if (this.i >= s.length) return '';
    let ch = s[this.i];
    if (ch === '\\') {
      this.i++;
      let name = '';
      while (this.i < s.length && /[A-Za-z]/.test(s[this.i])) {
        name += s[this.i];
        this.i++;
      }
      if (name) {
        const value = MATH_GREEK[name] || MATH_OPS[name] || '';
        return value ? `<span class="math-op">${value}</span>` : `<code class="math-fallback">\\${escapeHtml(name)}</code>`;
      }
      if (this.i < s.length) {
        const c2 = s[this.i];
        this.i++;
        return c2 === '.' ? '' : `<span class="math-op">${escapeHtml(c2)}</span>`;
      }
      return '';
    }
    this.i++;
    if (ch === '.') return '';
    return `<span class="math-op">${escapeHtml(ch)}</span>`;
  }

  /** 读取 {...} 内的原始文本（不解析），用于 \text \mathrm 等。 */
  readRaw() {
    this.skipSpace();
    const s = this.s;
    if (this.i >= s.length) return '';
    if (s[this.i] === '{') {
      let depth = 1;
      let j = this.i + 1;
      let out = '';
      while (j < s.length) {
        const c = s[j];
        if (c === '\\') {
          out += s[j + 1] || '';
          j += 2;
          continue;
        }
        if (c === '{') {
          depth++;
          out += c;
          j++;
          continue;
        }
        if (c === '}') {
          depth--;
          j++;
          if (depth === 0) break;
          out += c;
          continue;
        }
        out += c;
        j++;
      }
      this.i = j;
      return out;
    }
    if (/[A-Za-z]/.test(s[this.i])) {
      let run = '';
      while (this.i < s.length && /[A-Za-z]/.test(s[this.i])) {
        run += s[this.i];
        this.i++;
      }
      return run;
    }
    this.i++;
    return s[this.i - 1] || '';
  }
}

/**
 * 渲染 TeX 子集。
 * @param {string} tex
 * @param {boolean} [display] 块级公式
 * @returns {string}
 */
function mathBody(tex) {
  const src = tex === null || tex === undefined ? '' : String(tex);
  return new MathParser(src).parse();
}

export function renderMath(tex, display = false) {
  const body = mathBody(tex);
  if (display) {
    return `<div class="math math-display">${body}</div>`;
  }
  return `<span class="math math-inline">${body}</span>`;
}

/** 行内上下文中的块级公式：用 span 承载，避免 <div> 出现在 <p> 里。 */
function renderMathInlineDisplay(tex) {
  return `<span class="math math-display">${mathBody(tex)}</span>`;
}

/* ============================================================
 * 四、Markdown：行内解析
 * ============================================================ */

// 可被反斜杠转义的标点（CommonMark 的子集）
const ESCAPABLE_PUNCT = '\\`*_{}[]()#+-.!|<>~$"\'%&,:;/=?@^';

function stripTrailingSpaces(s) {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  return i === s.length ? s : s.slice(0, i);
}

function countRun(src, start, ch) {
  let n = 0;
  while (src[start + n] === ch) n++;
  return n;
}

/** 找到与 n 个连续反引号等长的闭合串。 */
function findBacktickClose(src, from, n) {
  let j = from;
  while (j < src.length) {
    if (src[j] === '`') {
      let run = 0;
      while (src[j + run] === '`') run++;
      if (run === n) return j;
      j += run;
      continue;
    }
    j++;
  }
  return -1;
}

/** 找到 `[` 对应的 `]`（支持一层嵌套，不跨行）。 */
function findBracketClose(src, start) {
  let depth = 0;
  for (let j = start; j < src.length; j++) {
    const ch = src[j];
    if (ch === '\\') {
      j++;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return j;
    } else if (ch === '\n') {
      return -1;
    }
  }
  return -1;
}

/** 解析 `(dest "title")` 尾部，返回 {dest,title,end}；失败返回 null。 */
function parseLinkTail(src, openParen) {
  let j = openParen + 1;
  let depth = 1;
  let raw = '';
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\' && j + 1 < src.length) {
      raw += ch + src[j + 1];
      j += 2;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        j++;
        break;
      }
    } else if (ch === '\n') {
      return null;
    }
    raw += ch;
    j++;
  }
  if (depth !== 0) return null;

  let dest = raw.trim();
  let title = '';
  if (dest.startsWith('<')) {
    const gt = dest.indexOf('>');
    if (gt < 0) return null;
    const rest = dest.slice(gt + 1).trim();
    dest = dest.slice(1, gt);
    title = stripQuotes(rest);
  } else {
    const sp = dest.search(/\s/);
    if (sp >= 0) {
      const rest = dest.slice(sp).trim();
      dest = dest.slice(0, sp);
      title = stripQuotes(rest);
    }
  }
  // 反斜杠转义还原
  dest = dest.replace(/\\([\\`*_{}[\]()#+\-.!|~<>$])/g, '$1');
  return { dest, title, end: j };
}

function stripQuotes(s) {
  if (!s) return '';
  const m = /^["'(](.*)["')]$/.exec(s.trim());
  return m ? m[1] : s.trim();
}

/** 解析 `[label](dest)`，bracketIndex 指向 `[`。 */
function parseLinkLike(src, bracketIndex) {
  const close = findBracketClose(src, bracketIndex);
  if (close < 0) return null;
  if (src[close + 1] !== '(') return null;
  const tail = parseLinkTail(src, close + 1);
  if (!tail) return null;
  return {
    label: src.slice(bracketIndex + 1, close),
    dest: tail.dest,
    title: tail.title,
    end: tail.end,
  };
}

/** 图片 alt 的纯文本化（去掉常见行内标记符号与事件属性样式子串）。 */
function plainAlt(label) {
  return String(label || '')
    .replace(/[*_`~]/g, '')
    .replace(/\bon\w+\s*=/gi, '');
}

/** 去除 URL 末尾的标点（中英文句读），保留配对括号。 */
function trimAutolinkUrl(raw) {
  let s = raw;
  const trail = /[.,;:!?，。；：！？、'"`】》」』]/;
  while (s.length && trail.test(s[s.length - 1])) s = s.slice(0, -1);
  while (s.endsWith(')')) {
    const open = (s.match(/\(/g) || []).length;
    const close = (s.match(/\)/g) || []).length;
    if (open >= close) break;
    s = s.slice(0, -1);
  }
  while (s.endsWith(']')) {
    const open = (s.match(/\[/g) || []).length;
    const close = (s.match(/\]/g) || []).length;
    if (open >= close) break;
    s = s.slice(0, -1);
  }
  return s;
}

/** 找到强调的闭合定界符位置；找不到返回 -1。 */
function findEmphasisClose(src, from, ch, len) {
  let j = from;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '\n' && src[j + 1] === '\n') return -1;
    if (c === ch) {
      let run = 0;
      while (src[j + run] === ch) run++;
      // 单字符强调只接受恰好 1 个的闭合串，避免贪婪吃掉 ** 的开头
      const ok = len === 1 ? run === 1 : run >= len;
      if (ok && j > from && !/\s/.test(src[j - 1])) {
        if (ch !== '_' || !/[A-Za-z0-9]/.test(src[j + len] || '')) return j;
      }
      j += run;
      continue;
    }
    j++;
  }
  return -1;
}

/** 尝试解析 * / _ 强调，返回 {html,end} 或 null。 */
function parseEmphasis(src, i, ctx) {
  const ch = src[i];
  if (ch === '_' && i > 0 && /[A-Za-z0-9]/.test(src[i - 1])) return null; // 词内下划线
  let run = 0;
  while (src[i + run] === ch) run++;
  const lengths = run >= 3 ? [3, 2, 1] : run >= 2 ? [2, 1] : [1];
  for (const len of lengths) {
    if (run < len) continue;
    const start = i + len;
    if (start >= src.length) continue;
    if (/\s/.test(src[start])) continue;
    const end = findEmphasisClose(src, start, ch, len);
    if (end < 0) continue;
    const inner = src.slice(start, end);
    if (!inner.trim()) continue;
    const html = renderInline(inner, ctx);
    if (len === 3) return { html: `<strong><em>${html}</em></strong>`, end: end + len };
    if (len === 2) return { html: `<strong>${html}</strong>`, end: end + len };
    return { html: `<em>${html}</em>`, end: end + len };
  }
  return null;
}

/**
 * 行内解析：一次从左到右扫描，遇到可识别结构就递归/内联生成 HTML。
 * 所有普通文本都走 escapeHtml，不做任何原始 HTML 透传。
 */
function renderInline(text, ctx) {
  const src = String(text === null || text === undefined ? '' : text);
  let out = '';
  let plain = '';
  let i = 0;

  const flush = () => {
    if (plain) {
      out += escapeHtml(plain);
      plain = '';
    }
  };
  const push = (html) => {
    flush();
    out += html;
  };

  while (i < src.length) {
    const c = src[i];

    /* ---- 反斜杠：硬换行 / 转义 / \(...\) \[...\] ---- */
    if (c === '\\') {
      const next = src[i + 1];
      if (next === '\n') {
        plain = stripTrailingSpaces(plain);
        push('<br>');
        i += 2;
        continue;
      }
      if (ctx.math && next === '(') {
        const end = src.indexOf('\\)', i + 2);
        if (end > i + 2) {
          push(renderMath(src.slice(i + 2, end), false));
          i = end + 2;
          continue;
        }
      }
      if (ctx.math && next === '[') {
        const end = src.indexOf('\\]', i + 2);
        if (end > i + 2) {
          push(renderMathInlineDisplay(src.slice(i + 2, end)));
          i = end + 2;
          continue;
        }
      }
      if (next !== undefined && ESCAPABLE_PUNCT.includes(next)) {
        plain += next;
        i += 2;
        continue;
      }
      plain += '\\';
      i++;
      continue;
    }

    /* ---- 行内代码（多个反引号包裹） ---- */
    if (c === '`') {
      const run = countRun(src, i, '`');
      const close = findBacktickClose(src, i + run, run);
      if (close >= 0) {
        let raw = src.slice(i + run, close).replace(/\n/g, ' ');
        if (raw.length >= 2 && raw.startsWith(' ') && raw.endsWith(' ') && raw.trim() !== '') {
          raw = raw.slice(1, -1);
        }
        push(`<code>${escapeHtml(raw)}</code>`);
        i = close + run;
        continue;
      }
      plain += '`'.repeat(run);
      i += run;
      continue;
    }

    /* ---- 数学公式：$$...$$（块级）/ $...$（行内） ---- */
    if (ctx.math && c === '$') {
      const delimLen = src[i + 1] === '$' ? 2 : 1;
      const matched = matchDollarMath(src, i, delimLen);
      if (matched) {
        push(delimLen === 2 ? renderMathInlineDisplay(matched.tex) : renderMath(matched.tex, false));
        i = matched.end;
        continue;
      }
      plain += '$'.repeat(delimLen);
      i += delimLen;
      continue;
    }

    /* ---- 图片 ![alt](src) ---- */
    if (c === '!' && src[i + 1] === '[') {
      const node = parseLinkLike(src, i + 1);
      if (node) {
        push(renderImage(node.dest, plainAlt(node.label)));
        i = node.end;
        continue;
      }
    }

    /* ---- 链接 / 引用角标 ---- */
    if (c === '[') {
      const node = parseLinkLike(src, i);
      if (node) {
        push(renderLink(node.dest, renderInline(node.label, ctx)));
        i = node.end;
        continue;
      }
      const cite = /^\[(\d{1,4})\]/.exec(src.slice(i));
      if (cite && ctx.cite && ctx.cite.has(Number(cite[1]))) {
        const n = Number(cite[1]);
        push(`<a class="cite" data-cite="${n}" href="#ref-${n}">${n}</a>`);
        i += cite[0].length;
        continue;
      }
      plain += c;
      i++;
      continue;
    }

    /* ---- 自动链接 <https://...> / <user@example.com> ---- */
    if (c === '<') {
      const rest = src.slice(i);
      const auto = /^<((?:https?:\/\/|mailto:|tel:)[^\s<>]+)>/i.exec(rest);
      if (auto) {
        push(renderLink(auto[1], escapeHtml(auto[1])));
        i += auto[0].length;
        continue;
      }
      const email = /^<([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>/.exec(rest);
      if (email) {
        push(renderLink(`mailto:${email[1]}`, escapeHtml(email[1])));
        i += email[0].length;
        continue;
      }
      plain += c;
      i++;
      continue;
    }

    /* ---- 裸 URL 自动链接 ---- */
    if (isAutolinkStart(src, i)) {
      const rest = src.slice(i);
      const m = /^(?:https?:\/\/|www\.)[^\s<>"'`]+/i.exec(rest);
      if (m) {
        const display = trimAutolinkUrl(m[0]);
        if (display) {
          const href = display.startsWith('www.') ? `https://${display}` : display;
          push(renderLink(href, escapeHtml(display)));
          i += display.length;
          continue;
        }
      }
    }

    /* ---- 删除线 ~~x~~ ---- */
    if (c === '~' && src[i + 1] === '~') {
      const end = findEmphasisClose(src, i + 2, '~', 2);
      if (end > i + 2) {
        push(`<del>${renderInline(src.slice(i + 2, end), ctx)}</del>`);
        i = end + 2;
        continue;
      }
    }

    /* ---- 强调 * ** *** / _ __ ___ ---- */
    if (c === '*' || c === '_') {
      const emphasized = parseEmphasis(src, i, ctx);
      if (emphasized) {
        push(emphasized.html);
        i = emphasized.end;
        continue;
      }
      plain += c;
      i++;
      continue;
    }

    /* ---- 换行：软换行与硬换行统一渲染为 <br>（聊天场景更自然） ---- */
    if (c === '\n') {
      plain = stripTrailingSpaces(plain);
      push('<br>');
      i++;
      continue;
    }

    plain += c;
    i++;
  }

  flush();
  return out;
}

/** 判断 pos 是否是裸 URL 的合法起点（前面是行首/空白/标点）。 */
function isAutolinkStart(src, pos) {
  const c = src[pos];
  if (c !== 'h' && c !== 'H' && c !== 'w' && c !== 'W') return false;
  const rest = src.slice(pos, pos + 8);
  if (!/^(?:https?:\/\/|www\.)/i.test(rest)) return false;
  if (pos === 0) return true;
  return /[\s([{<"'`，。；：！？、】》」』]/.test(src[pos - 1]);
}

/**
 * 匹配 $...$ / $$...$$。
 * 规则：开定界符后不能是空白；闭定界符前不能是空白；单 $ 不跨行、
 * 内容含 CJK 时视为货币/正文不解析（避免「$5 和 $10」误判）。
 */
function matchDollarMath(src, start, delimLen) {
  const openEnd = start + delimLen;
  if (openEnd >= src.length) return null;
  if (/\s/.test(src[openEnd])) return null;
  if (src[openEnd] === '$') return null;

  let j = openEnd;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === '\n') {
      if (delimLen === 1) return null;
      if (src[j + 1] === '\n') return null;
      j++;
      continue;
    }
    if (ch === '$' && src.startsWith('$'.repeat(delimLen), j)) {
      if (j === openEnd) {
        j += delimLen;
        continue;
      }
      if (/\s/.test(src[j - 1])) return null;
      if (delimLen === 1 && /[0-9]/.test(src[j + 1] || '')) return null;
      const tex = src.slice(openEnd, j);
      // 单个 $ 包裹的内容若含 CJK，更可能是货币/正文而非公式
      if (delimLen === 1 && /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(tex)) return null;
      return { tex, end: j + delimLen };
    }
    j++;
    if (j - openEnd > 2000) return null;
  }
  return null;
}

/* ============================================================
 * 五、Markdown：块级解析
 * ============================================================ */

const RE_FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const RE_SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const RE_BQ = /^ {0,3}>/;
const RE_LIST_MARKER = /^( *)([-+*]|\d{1,9}[.)])([ \t]*)(.*)$/;

function isHrLine(line) {
  return RE_HR.test(line);
}

function matchFenceStart(line) {
  const m = RE_FENCE.exec(line);
  if (!m) return null;
  const ch = m[2][0];
  const info = m[3].trim();
  if (ch === '`' && info.includes('`')) return null;
  return { ch, len: m[2].length, info };
}

function countIndent(line) {
  let col = 0;
  for (const ch of line) {
    if (ch === ' ') col++;
    else if (ch === '\t') col += 4;
    else break;
  }
  return col;
}

function stripIndent(line, n) {
  let col = 0;
  let k = 0;
  while (k < line.length && col < n) {
    const ch = line[k];
    if (ch === ' ') {
      col++;
      k++;
    } else if (ch === '\t') {
      col += 4;
      k++;
    } else {
      break;
    }
  }
  return line.slice(k);
}

function parseListMarker(line) {
  const m = RE_LIST_MARKER.exec(line);
  if (!m) return null;
  if (m[1].length > 3) return null;
  // 标记后必须是空白或行尾（否则是普通段落，如 "-abc"）
  if (!m[3] && m[4]) return null;
  return {
    indent: m[1].length,
    marker: m[2],
    spaces: m[3].length || 1,
    ordered: /\d/.test(m[2]),
    number: /\d/.test(m[2]) ? parseInt(m[2], 10) : null,
    kind: /\d/.test(m[2]) ? m[2].slice(-1) : m[2],
    content: m[4],
  };
}

function isTableDelim(line) {
  if (!line || !line.includes('-') || !line.includes('|')) return false;
  const t = line.trim();
  // 单列表格也允许（|---|），多列表格为 |---|:---:|---:|
  return /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?$/.test(t);
}

/** 按未转义的 | 切分表格行，保留 \| 交给行内解析处理。 */
function splitTableRow(line) {
  const trimmed = line.trim();
  const cells = [];
  let cur = '';
  for (let k = 0; k < trimmed.length; k++) {
    const ch = trimmed[k];
    if (ch === '\\' && trimmed[k + 1] === '|') {
      cur += '\\|';
      k++;
      continue;
    }
    if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  // 去掉首尾竖线产生的空单元
  if (trimmed.startsWith('|') && cells.length && cells[0] === '') cells.shift();
  if (trimmed.endsWith('|') && cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

/** 判断某个位置是否开启了新的块（用于段落收集时判断边界）。 */
function isBlockStartAt(lines, i) {
  const line = lines[i];
  if (!line || !line.trim()) return true;
  if (matchFenceStart(line)) return true;
  if (RE_ATX.test(line)) return true;
  if (isHrLine(line)) return true;
  if (RE_BQ.test(line)) return true;
  if (parseListMarker(line)) return true;
  if (/^ {0,3}\$\$/.test(line)) return true;
  if (/^ {0,3}\\\[/.test(line)) return true;
  if (i + 1 < lines.length) {
    if (isTableDelim(lines[i + 1]) && line.includes('|')) return true;
    if (RE_SETEXT.test(lines[i + 1]) && line.trim()) return true;
  }
  return false;
}

/** 渲染代码块（严格遵循渲染契约的结构）。 */
function renderCodeBlock(code, lang, ctx) {
  const { canon, key } = canonicalLang(lang);
  const display = canon && LANG_DISPLAY[canon] ? LANG_DISPLAY[canon] : key;
  const dataLang = canon || key;
  const highlighted =
    ctx.highlight && canon && canon !== 'plain' ? highlight(code, canon) : escapeHtml(code);
  return (
    `<div class="code-block" data-lang="${escapeAttr(dataLang)}">` +
    '<div class="code-hd">' +
    `<span class="code-lang">${escapeHtml(display)}</span>` +
    '<button class="code-copy" type="button" aria-label="复制代码">复制</button>' +
    '</div>' +
    `<pre><code class="language-${escapeAttr(dataLang)}">${highlighted}</code></pre>` +
    '</div>'
  );
}

/** 围栏代码块（含未闭合容错）。 */
function parseFenceBlock(lines, start, fence) {
  const body = [];
  let i = start + 1;
  const closeRe =
    fence.ch === '`'
      ? new RegExp('^ {0,3}`{' + fence.len + ',}[ \\t]*$')
      : new RegExp('^ {0,3}~{' + fence.len + ',}[ \\t]*$');
  while (i < lines.length) {
    if (closeRe.test(lines[i])) {
      i++;
      break;
    }
    body.push(lines[i]);
    i++;
  }
  const lang = fence.info ? fence.info.split(/\s+/)[0] : '';
  return { code: body.join('\n'), lang, next: i };
}

/** 缩进代码块（顶层、4 空格 / Tab）。 */
function parseIndentedCode(lines, start) {
  const body = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      let k = i + 1;
      while (k < lines.length && !lines[k].trim()) k++;
      if (k < lines.length && countIndent(lines[k]) >= 4) {
        body.push('');
        i++;
        continue;
      }
      break;
    }
    if (countIndent(line) < 4) break;
    body.push(stripIndent(line, 4));
    i++;
  }
  return { code: body.join('\n'), next: i };
}

/** 块引用（可嵌套；支持 > 空行与惰性续行）。 */
function parseBlockquote(lines, start, ctx) {
  const buf = [];
  let i = start;
  while (i < lines.length) {
    const m = /^ {0,3}> ?(.*)$/.exec(lines[i]);
    if (m) {
      buf.push(m[1]);
      i++;
      continue;
    }
    if (!lines[i].trim()) {
      let k = i + 1;
      while (k < lines.length && !lines[k].trim()) k++;
      if (k < lines.length && RE_BQ.test(lines[k])) {
        buf.push('');
        i++;
        continue;
      }
      break;
    }
    // 惰性续行
    buf.push(lines[i]);
    i++;
  }
  return {
    html: `<blockquote>\n${renderBlocks(buf, ctx)}\n</blockquote>`,
    next: i,
  };
}

/** 列表（有序/无序/嵌套/任务列表/start 属性）。 */
function parseListBlock(lines, start, ctx) {
  const first = parseListMarker(lines[start]);
  const ordered = first.ordered;
  const baseIndent = first.indent;
  const items = [];
  let loose = false;
  let i = start;
  let separatorBlank = false; // 上一项与下一项之间是否隔着空行

  while (i < lines.length) {
    const m = parseListMarker(lines[i]);
    if (!m || m.indent !== baseIndent) break;
    if (m.ordered !== ordered) break;
    if (m.kind !== first.kind) break; // 不同符号 = 新列表
    // 项之间出现空行 → 整个列表变松散（末尾空行不影响）
    if (separatorBlank) loose = true;

    const contentIndent = m.indent + m.marker.length + m.spaces;
    const bodyLines = [m.content];
    let j = i + 1;
    let pendingBlanks = 0; // 尾部挂起的空行

    while (j < lines.length) {
      const line = lines[j];
      if (!line.trim()) {
        pendingBlanks++;
        j++;
        continue;
      }
      const indent = countIndent(line);
      const nextMarker = parseListMarker(line);
      if (nextMarker && indent === baseIndent) break; // 同级下一个 item / 新列表

      let content = null;
      if (indent >= contentIndent) content = stripIndent(line, contentIndent);
      else if (indent > baseIndent) content = stripIndent(line, Math.min(indent, baseIndent + 2));

      if (content !== null) {
        // 空行之后还有缩进内容 → item 内部空行，列表松散
        if (pendingBlanks > 0) {
          for (let b = 0; b < pendingBlanks; b++) bodyLines.push('');
          loose = true;
          pendingBlanks = 0;
        }
        bodyLines.push(content);
        j++;
        continue;
      }
      if (pendingBlanks > 0) break; // 空行后的顶格内容：item 结束
      bodyLines.push(line.trim()); // 惰性续行
      j++;
    }

    items.push(bodyLines);
    i = j;
    separatorBlank = pendingBlanks > 0;
  }

  let hasTask = false;
  const lis = [];
  for (const bodyLines of items) {
    const itemLines = bodyLines.slice();
    let task = null;
    const tm = /^\[([ xX])\](?:[ \t]+(.*)|$)/.exec(itemLines[0] || '');
    if (tm) {
      task = tm[1].toLowerCase() === 'x';
      hasTask = true;
      itemLines[0] = tm[2] || '';
    }

    let inner = renderBlocks(itemLines, ctx);
    if (!loose) inner = inner.replace(/^<p>([\s\S]*?)<\/p>(?:\n|$)/, '$1');

    let checkbox = '';
    if (task !== null) {
      checkbox = `<input class="task-checkbox" type="checkbox" disabled${task ? ' checked' : ''}> `;
      if (inner.startsWith('<p>')) inner = `<p>${checkbox}${inner.slice(3)}`;
      else inner = checkbox + inner;
    }

    const cls = task !== null ? ' class="task-list-item"' : '';
    lis.push(`<li${cls}>${inner}</li>`);
  }

  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && first.number !== 1 ? ` start="${first.number}"` : '';
  const listCls = hasTask ? ' class="task-list"' : '';
  return {
    html: `<${tag}${startAttr}${listCls}>\n${lis.join('\n')}\n</${tag}>`,
    next: i,
  };
}

/** 表格（含 :---: 对齐；单元格内联解析）。 */
function parseTableBlock(lines, start, ctx) {
  const header = splitTableRow(lines[start]);
  const aligns = splitTableRow(lines[start + 1]).map((cell) => {
    const t = cell.trim();
    const left = t.startsWith(':');
    const right = t.endsWith(':');
    if (left && right) return 'center';
    if (left) return 'left';
    if (right) return 'right';
    return '';
  });

  const rows = [];
  let i = start + 2;
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    rows.push(splitTableRow(lines[i]));
    i++;
  }

  const cols = Math.max(header.length, aligns.length, 1);
  const styleAttr = (align) => (align ? ` style="text-align:${align}"` : '');

  let html = '<table>\n<thead>\n<tr>';
  for (let c = 0; c < cols; c++) {
    html += `<th${styleAttr(aligns[c] || '')}>${renderInline(header[c] || '', ctx)}</th>`;
  }
  html += '</tr>\n</thead>';

  if (rows.length) {
    html += '\n<tbody>';
    for (const row of rows) {
      html += '\n<tr>';
      for (let c = 0; c < cols; c++) {
        html += `<td${styleAttr(aligns[c] || '')}>${renderInline(row[c] || '', ctx)}</td>`;
      }
      html += '</tr>';
    }
    html += '\n</tbody>';
  }
  html += '\n</table>';
  return { html, next: i };
}

/** 块级数学：$$...$$ / \[...\]（单行或多行，未闭合也容错）。 */
function parseMathBlock(lines, start) {
  const line = lines[start].trim();

  if (line.startsWith('$$')) {
    if (line.length > 4 && line.endsWith('$$')) {
      return { html: renderMath(line.slice(2, -2), true), next: start + 1 };
    }
    const buf = [];
    const first = line.slice(2);
    if (first.trim()) buf.push(first);
    let j = start + 1;
    while (j < lines.length) {
      const t = lines[j].trim();
      if (t === '$$') {
        j++;
        break;
      }
      if (t.endsWith('$$') && !t.startsWith('$$')) {
        buf.push(lines[j].slice(0, lines[j].lastIndexOf('$$')));
        j++;
        break;
      }
      buf.push(lines[j]);
      j++;
    }
    return { html: renderMath(buf.join('\n'), true), next: j };
  }

  if (line.startsWith('\\[')) {
    const endIdx = line.indexOf('\\]');
    if (endIdx > 2) {
      return { html: renderMath(line.slice(2, endIdx), true), next: start + 1 };
    }
    const buf = [];
    if (line.length > 2) buf.push(line.slice(2));
    let j = start + 1;
    while (j < lines.length) {
      const t = lines[j].trim();
      if (t === '\\]') {
        j++;
        break;
      }
      if (t.endsWith('\\]')) {
        buf.push(lines[j].slice(0, lines[j].lastIndexOf('\\]')));
        j++;
        break;
      }
      buf.push(lines[j]);
      j++;
    }
    return { html: renderMath(buf.join('\n'), true), next: j };
  }

  return null;
}

/** 块级渲染主循环。 */
function renderBlocks(lines, ctx) {
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 空行
    if (!line || !line.trim()) {
      i++;
      continue;
    }

    // 1) 围栏代码块
    const fence = matchFenceStart(line);
    if (fence) {
      const parsed = parseFenceBlock(lines, i, fence);
      out.push(renderCodeBlock(parsed.code, parsed.lang, ctx));
      i = parsed.next;
      continue;
    }

    // 2) 块级数学 $$ / \[
    const mathBlock = parseMathBlock(lines, i);
    if (mathBlock) {
      out.push(mathBlock.html);
      i = mathBlock.next;
      continue;
    }

    // 3) ATX 标题
    const atx = RE_ATX.exec(line);
    if (atx) {
      const level = atx[1].length;
      const text = (atx[2] || '').replace(/[ \t]+#+[ \t]*$/, '');
      out.push(`<h${level}>${renderInline(text, ctx)}</h${level}>`);
      i++;
      continue;
    }

    // 4) setext 标题（标题行 + ===/---）
    if (i + 1 < lines.length && line.trim()) {
      const setext = RE_SETEXT.exec(lines[i + 1]);
      const lineIsBlock =
        matchFenceStart(line) || RE_ATX.test(line) || isHrLine(line) || RE_BQ.test(line) || parseListMarker(line);
      if (setext && !lineIsBlock) {
        const level = setext[1][0] === '=' ? 1 : 2;
        out.push(`<h${level}>${renderInline(line.trim(), ctx)}</h${level}>`);
        i += 2;
        continue;
      }
    }

    // 5) 分隔线（放在列表之前，保证 "- - -" 是 hr）
    if (isHrLine(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // 6) 引用
    if (RE_BQ.test(line)) {
      const parsed = parseBlockquote(lines, i, ctx);
      out.push(parsed.html);
      i = parsed.next;
      continue;
    }

    // 7) 列表
    if (parseListMarker(line)) {
      const parsed = parseListBlock(lines, i, ctx);
      out.push(parsed.html);
      i = parsed.next;
      continue;
    }

    // 8) 表格
    if (i + 1 < lines.length && line.includes('|') && isTableDelim(lines[i + 1])) {
      const parsed = parseTableBlock(lines, i, ctx);
      out.push(parsed.html);
      i = parsed.next;
      continue;
    }

    // 9) 缩进代码块（顶层）
    if (countIndent(line) >= 4) {
      const parsed = parseIndentedCode(lines, i);
      out.push(renderCodeBlock(parsed.code, '', ctx));
      i = parsed.next;
      continue;
    }

    // 10) 段落：收集到空行或下一个块开始
    const buf = [line];
    let j = i + 1;
    while (j < lines.length && !isBlockStartAt(lines, j)) {
      buf.push(lines[j]);
      j++;
    }
    out.push(`<p>${renderInline(buf.join('\n'), ctx)}</p>`);
    i = j;
  }

  return out.join('\n');
}

/* ============================================================
 * 六、对外入口：renderMarkdown
 * ============================================================ */

/**
 * 渲染 Markdown 为安全 HTML。
 * @param {string} md
 * @param {{citeNumbers?: Set<number>|number[], highlight?: boolean, math?: boolean}} [opts]
 * @returns {string}
 */
export function renderMarkdown(md, opts = {}) {
  if (md === null || md === undefined) return '';
  const src = String(md);
  if (!src.trim()) return '';

  const options = opts || {};
  const cite = options.citeNumbers instanceof Set
    ? options.citeNumbers
    : new Set(Array.isArray(options.citeNumbers) ? options.citeNumbers : []);

  const ctx = {
    cite,
    highlight: options.highlight !== false,
    math: options.math !== false,
  };

  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  return renderBlocks(lines, ctx);
}

/*
 * ------------------------------------------------------------------
 * 已知取舍（GFM 未实现/近似项）：
 *  1. 引用式链接 [text][id] / [id]: url、脚注 [^1]、定义列表：不支持；
 *  2. 原始 HTML 一律转义（安全优先），因此不支持 <details>/<kbd> 等直出；
 *  3. 段内软换行渲染为 <br>（聊天界面更自然），与 CommonMark「合并为空格」不同；
 *  4. 强调解析为简化版：不支持复杂嵌套的分隔符配对（如 *a **b*** 的完美语义）；
 *  5. 表格不支持单元格内换行/转义转义的复杂情形；不支持 colspan/rowspan；
 *  6. 列表松散/紧凑判定用「出现空行」近似；深层缩进（>3 空格）的兄弟列表按嵌套处理；
 *  7. 代码高亮是词法级近似（不做语法分析）：JS 正则字面量不区分除法、
 *     模板字符串不递归解析 ${}、Rust 原始字符串仅做近似匹配；
 *  8. 数学只覆盖契约要求的 TeX 子集：\begin{...} 环境（matrix/cases）降级为
 *     math-fallback 文本；\color/\cancel 等未列出的命令同样降级。
 * ------------------------------------------------------------------
 */
