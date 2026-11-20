/**
 * render.js 单元测试
 * 运行：node --test test/render.test.mjs
 *
 * 覆盖契约（docs/CONTRACTS.md 第三节）：
 *  - XSS 五类 + 属性注入
 *  - 代码围栏（转义/语言/未闭合/~~~）
 *  - 表格对齐、嵌套列表、引用嵌套、任务列表
 *  - 行内代码含反引号、自动链接、图片
 *  - 数学（行内/块级/未知命令/货币不误判/优先级）
 *  - 引用角标
 *  - escapeHtml
 *  - 8KB 性能
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, highlight, renderMath, renderMarkdown } from '../public/js/render.js';

/** 断言输出中不含任何「可执行/可嵌入」的危险标签。 */
function assertNoDangerTags(html) {
  assert.doesNotMatch(html, /<script[\s>]/i, '不应出现 <script>');
  assert.doesNotMatch(html, /<style[\s>]/i, '不应出现 <style>');
  assert.doesNotMatch(html, /<iframe[\s>]/i, '不应出现 <iframe>');
  assert.doesNotMatch(html, /<object[\s>]/i, '不应出现 <object>');
  assert.doesNotMatch(html, /<embed[\s>]/i, '不应出现 <embed>');
  assert.doesNotMatch(html, /<form[\s>]/i, '不应出现 <form>');
  assert.doesNotMatch(html, /<svg[\s>]/i, '不应出现 <svg>');
  assert.doesNotMatch(html, /<[^>]*\son\w+\s*=/i, '不应出现 on* 事件属性');
}

/** 空元素集合：不需要闭合标签。 */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** 断言 HTML 标签闭合平衡（用于验证数学/环境的 span 结构合法）。 */
function assertBalancedHtml(html) {
  const re = /<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[^>]*)?)>/g;
  const stack = [];
  let m;
  while ((m = re.exec(html))) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (VOID_TAGS.has(tag)) {
      assert.equal(closing, false, `空元素 <${tag}> 不应出现闭合标签`);
      continue;
    }
    if (closing) {
      assert.equal(stack.pop(), tag, `标签闭合顺序错误：</${tag}>`);
    } else {
      stack.push(tag);
    }
  }
  assert.deepEqual(stack, [], '存在未闭合的 HTML 标签');
}

/* ============================================================
 * escapeHtml
 * ============================================================ */

describe('escapeHtml', () => {
  it('转义 & < > " \'', () => {
    assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  });

  it('普通文本与中文保持不变', () => {
    assert.equal(escapeHtml('你好，世界 123 abc'), '你好，世界 123 abc');
  });

  it('空值与数字安全处理', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(0), '0');
  });

  it('多个特殊字符全部转义', () => {
    assert.equal(
      escapeHtml('<a href="x">&</a>'),
      '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;'
    );
  });
});

/* ============================================================
 * XSS 安全
 * ============================================================ */

describe('XSS 安全', () => {
  it('<script> 被转义', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    assertNoDangerTags(html);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script/i);
  });

  it('<img onerror> 被转义', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>');
    assertNoDangerTags(html);
    assert.doesNotMatch(html, /<img/i);
    assert.match(html, /&lt;img/);
  });

  it('javascript: 链接被拒绝（大小写混写也不行）', () => {
    const html = renderMarkdown('[点我](javascript:alert(1)) [再点](JaVaScRiPt:alert(2))');
    assertNoDangerTags(html);
    assert.doesNotMatch(html, /javascript:/i);
    assert.doesNotMatch(html, /href=/i);
  });

  it('data:text/html 链接被拒绝', () => {
    const html = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)');
    assertNoDangerTags(html);
    assert.doesNotMatch(html, /data:text\/html/i);
    assert.doesNotMatch(html, /href=/i);
  });

  it('<iframe> 被转义', () => {
    const html = renderMarkdown('<iframe src="https://evil.example"></iframe>');
    assertNoDangerTags(html);
    assert.match(html, /&lt;iframe/);
  });

  it('<svg onload> 被转义', () => {
    const html = renderMarkdown('<svg onload=alert(1)></svg>');
    assertNoDangerTags(html);
    assert.match(html, /&lt;svg/);
  });

  it('vbscript: / ftp: 等非白名单协议被拒绝', () => {
    const html = renderMarkdown('[a](vbscript:msgbox(1)) [b](ftp://example.com/x)');
    assert.doesNotMatch(html, /vbscript:/i);
    assert.doesNotMatch(html, /ftp:\/\//i);
    assert.doesNotMatch(html, /href=/i);
  });

  it('代码围栏内 HTML 被转义（不透视）', () => {
    const html = renderMarkdown('```html\n<script>alert(1)</script>\n```');
    assertNoDangerTags(html);
    assert.match(html, /&lt;script/);
    assert.doesNotMatch(html, /<script/i);
  });

  it('数学公式内的 HTML 被转义', () => {
    const html = renderMath('<script>alert(1)</script>');
    assertNoDangerTags(html);
    assert.match(html, /&lt;/);
    assert.doesNotMatch(html, /<script/i);
  });

  it('属性值引号注入被拒绝/转义', () => {
    const html = renderMarkdown('[x](https://a.example/"><img src=x onerror=alert(1)>)');
    assertNoDangerTags(html);
    assert.doesNotMatch(html, /<img/i);
    assert.doesNotMatch(html, /<a /);
  });

  it('图片 alt 中的事件属性样式文本不落入标签属性区', () => {
    const html = renderMarkdown('![a" onerror="x](https://example.com/a.png)');
    assertNoDangerTags(html);
    assert.match(html, /<img /);
  });

  it('正常带 & 查询参数的 URL 被正确转义', () => {
    const html = renderMarkdown('[q](https://example.com/?a=1&b=2)');
    assert.match(html, /href="https:\/\/example\.com\/\?a=1&amp;b=2"/);
  });

  it('link 使用 target=_blank + noopener noreferrer nofollow', () => {
    const html = renderMarkdown('[示例](https://example.com/a)');
    assert.match(
      html,
      /<a href="https:\/\/example\.com\/a" target="_blank" rel="noopener noreferrer nofollow">示例<\/a>/
    );
  });

  it('安全协议白名单：mailto / tel / # 锚点可用', () => {
    const html = renderMarkdown('[信](mailto:a@b.com) [电话](tel:+8613800000000) [锚](#ref-1)');
    assert.match(html, /href="mailto:a@b\.com"/);
    assert.match(html, /href="tel:\+8613800000000"/);
    assert.match(html, /href="#ref-1"/);
  });

  it('data:image 图片允许，data:text/html 拒绝', () => {
    const ok = renderMarkdown('![d](data:image/png;base64,iVBORw0KGgo=)');
    assert.match(ok, /<img /);
    const bad = renderMarkdown('![d](data:text/html;base64,PHNjcmlwdD4=)');
    assert.doesNotMatch(bad, /<img /);
  });
});

/* ============================================================
 * 代码围栏 / 代码块结构
 * ============================================================ */

describe('代码围栏', () => {
  it('严格契约结构：code-block / code-hd / code-lang / code-copy / language-js', () => {
    const html = renderMarkdown('```js\nconst a = 1;\n```');
    assert.equal(
      html,
      '<div class="code-block" data-lang="js">' +
        '<div class="code-hd">' +
        '<span class="code-lang">JavaScript</span>' +
        '<button class="code-copy" type="button" aria-label="复制代码">复制</button>' +
        '</div>' +
        '<pre><code class="language-js"><span class="tok-kw">const</span> a <span class="tok-op">=</span> <span class="tok-num">1</span>;</code></pre>' +
        '</div>'
    );
  });

  it('语言名映射为友好显示名', () => {
    assert.match(renderMarkdown('```python\nprint(1)\n```'), /<span class="code-lang">Python<\/span>/);
    assert.match(renderMarkdown('```bash\necho hi\n```'), /<span class="code-lang">Bash<\/span>/);
    assert.match(renderMarkdown('```ts\nlet x: number = 1\n```'), /<span class="code-lang">TypeScript<\/span>/);
    assert.match(renderMarkdown('```cpp\nint main(){}\n```'), /<span class="code-lang">C\+\+<\/span>/);
  });

  it('未知语言显示原文小写，且不做高亮', () => {
    const html = renderMarkdown('```FOOBAR\nsome text\n```');
    assert.match(html, /data-lang="foobar"/);
    assert.match(html, /<span class="code-lang">foobar<\/span>/);
    assert.match(html, /<code class="language-foobar">some text<\/code>/);
    assert.doesNotMatch(html, /tok-/);
  });

  it('无语言标签降级为 Text / plain', () => {
    const html = renderMarkdown('```\nplain text\n```');
    assert.match(html, /data-lang="plain"/);
    assert.match(html, /<span class="code-lang">Text<\/span>/);
  });

  it('未闭合围栏（流式截断）也能渲染', () => {
    const html = renderMarkdown('```js\nconst a = 1;');
    assert.match(html, /class="code-block"/);
    assert.match(html, /<span class="tok-kw">const<\/span>/);
    assert.match(html, /<\/code><\/pre><\/div>$/);
  });

  it('~~~ 围栏可用', () => {
    const html = renderMarkdown('~~~html\n<div>hi</div>\n~~~');
    assert.match(html, /class="code-block"/);
    assert.match(html, /data-lang="html"/);
    assert.match(html, /&lt;div/);
  });

  it('代码内容转义且高亮 span 内的文本已转义', () => {
    const html = renderMarkdown('```html\n<img src=x onerror=alert(1)>\n```');
    assertNoDangerTags(html);
    assert.match(html, /class="tok-tag">/);
    assert.doesNotMatch(html, /<img/i);
  });

  it('opts.highlight=false 时只转义不高亮', () => {
    const html = renderMarkdown('```js\nconst a = 1;\n```', { highlight: false });
    assert.doesNotMatch(html, /tok-/);
    assert.match(html, /const a = 1;/);
  });
});

/* ============================================================
 * highlight 各语言
 * ============================================================ */

describe('highlight 代码高亮', () => {
  it('javascript：关键字/字符串/注释/数字/函数', () => {
    const h = highlight('const x = "hi"; // 注释\nfoo(42);', 'js');
    assert.match(h, /class="tok-kw">const</);
    assert.match(h, /class="tok-str">&quot;hi&quot;</);
    assert.match(h, /class="tok-com">\/\/ 注释</);
    assert.match(h, /class="tok-fn">foo</);
    assert.match(h, /class="tok-num">42</);
  });

  it('typescript：类型关键字与泛型标识符', () => {
    const h = highlight('interface User { name: string }', 'ts');
    assert.match(h, /class="tok-kw">interface</);
    assert.match(h, /tok-type/);
  });

  it('json：键用 tok-attr，值有数字/布尔', () => {
    const h = highlight('{"name": "x", "ok": true, "n": 3}', 'json');
    assert.match(h, /class="tok-attr">&quot;name&quot;/);
    assert.match(h, /class="tok-kw">true</);
    assert.match(h, /class="tok-num">3</);
  });

  it('bash：命令/变量/字符串', () => {
    const h = highlight('echo $HOME && cd /tmp', 'bash');
    assert.match(h, /class="tok-fn">echo</);
    assert.match(h, /class="tok-var">\$HOME</);
    assert.match(h, /class="tok-fn">cd</);
  });

  it('python：def / 函数名 / 字符串', () => {
    const h = highlight('def foo(x):\n    return "a"', 'python');
    assert.match(h, /class="tok-kw">def</);
    assert.match(h, /class="tok-fn">foo</);
    assert.match(h, /class="tok-kw">return</);
    assert.match(h, /tok-str/);
  });

  it('html：标签/属性/属性值', () => {
    const h = highlight('<div class="box">hi</div>', 'html');
    assert.match(h, /class="tok-tag">&lt;div</);
    assert.match(h, /class="tok-attr">class</);
    assert.match(h, /class="tok-str">&quot;box&quot;</);
  });

  it('css：属性/颜色值/单位', () => {
    const h = highlight('.a { color: #fff; width: 10px; }', 'css');
    assert.match(h, /class="tok-attr">color</);
    assert.match(h, /class="tok-num">#fff</);
    assert.match(h, /class="tok-num">10px</);
  });

  it('sql：关键字大小写不敏感', () => {
    const h = highlight('SELECT id FROM users WHERE id = 1', 'sql');
    assert.match(h, /class="tok-kw">SELECT</);
    assert.match(h, /class="tok-kw">FROM</);
    assert.match(h, /class="tok-kw">WHERE</);
  });

  it('go：关键字/内置类型/函数', () => {
    const h = highlight('func main() { var s string }', 'go');
    assert.match(h, /class="tok-kw">func</);
    assert.match(h, /class="tok-kw">var</);
    assert.match(h, /class="tok-type">string</);
  });

  it('rust：关键字/宏/类型', () => {
    const h = highlight('fn main() { let v: Vec<u32> = vec![]; }', 'rust');
    assert.match(h, /class="tok-kw">fn</);
    assert.match(h, /class="tok-kw">let</);
    assert.match(h, /class="tok-macro">vec!/);
    assert.match(h, /class="tok-type">Vec</);
  });

  it('java：关键字/注解/类型', () => {
    const h = highlight('@Override\npublic class Demo { String s; }', 'java');
    assert.match(h, /class="tok-attr">@Override</);
    assert.match(h, /class="tok-kw">public</);
    assert.match(h, /class="tok-kw">class</);
    assert.match(h, /class="tok-type">String</);
  });

  it('c/cpp：预处理指令/类型/函数', () => {
    const h = highlight('#include <stdio.h>\nint main(void) { return 0; }', 'c');
    assert.match(h, /class="tok-kw">#include</);
    assert.match(h, /class="tok-type">int</);
    assert.match(h, /class="tok-fn">main</);
  });

  it('yaml：键/布尔/数字', () => {
    const h = highlight('name: demo\nenabled: true\nport: 8080', 'yaml');
    assert.match(h, /class="tok-attr">name</);
    assert.match(h, /class="tok-kw">true</);
    assert.match(h, /class="tok-num">8080</);
  });

  it('diff：按行着色的 add/del/hunk', () => {
    const h = highlight('@@ -1 +1 @@\n-old line\n+new line\n context', 'diff');
    assert.match(h, /class="tok-var">@@ -1 \+1 @@</);
    assert.match(h, /class="tok-del">-old line</);
    assert.match(h, /class="tok-add">\+new line</);
  });

  it('markdown：标题/代码/链接', () => {
    const h = highlight('# 标题\n\n`code` [x](https://a.b)', 'markdown');
    assert.match(h, /class="tok-kw"># 标题</);
    assert.match(h, /class="tok-str">`code`/);
    assert.match(h, /class="tok-fn">\[x\]\(https:\/\/a\.b\)/);
  });

  it('未知语言安全降级为纯转义', () => {
    assert.equal(highlight('<b>x</b>', 'unknown-lang'), '&lt;b&gt;x&lt;/b&gt;');
    assert.equal(highlight('a < b', undefined), 'a &lt; b');
  });

  it('所有 token 文本已转义（不能出现原始 <script>）', () => {
    for (const lang of ['js', 'html', 'python', 'sql', 'go', 'rust', 'bash', 'css', 'json']) {
      const h = highlight('<script>alert(1)</script>', lang);
      assert.doesNotMatch(h, /<script/i, `${lang} 高亮不应输出原始 <script>`);
    }
  });
});

/* ============================================================
 * 表格
 * ============================================================ */

describe('表格', () => {
  it('表头/表体与对齐（左/中/右）', () => {
    const html = renderMarkdown('| 左 | 中 | 右 |\n|:---|:---:|---:|\n| a | b | c |');
    assert.match(html, /<table>/);
    assert.match(html, /<thead>/);
    assert.match(html, /<th style="text-align:left">左<\/th>/);
    assert.match(html, /<th style="text-align:center">中<\/th>/);
    assert.match(html, /<th style="text-align:right">右<\/th>/);
    assert.match(html, /<td style="text-align:center">b<\/td>/);
  });

  it('默认对齐（---）不带 style', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
    assert.match(html, /<th>a<\/th>/);
    assert.match(html, /<td>1<\/td>/);
  });

  it('单元格支持行内语法', () => {
    const html = renderMarkdown('| 名称 | 说明 |\n|---|---|\n| **粗** | `code` |');
    assert.match(html, /<td><strong>粗<\/strong><\/td>/);
    assert.match(html, /<td><code>code<\/code><\/td>/);
  });

  it('单元格中的转义竖线不拆列', () => {
    const html = renderMarkdown('| 表达式 | 值 |\n|---|---|\n| a \\| b | 1 |');
    assert.match(html, /<td>a \| b<\/td>/);
  });

  it('表格后不是分隔行时按普通段落处理', () => {
    const html = renderMarkdown('| 不是表格 |\n普通段落');
    assert.doesNotMatch(html, /<table>/);
    assert.match(html, /<p>/);
  });

  it('单列表格（|---|）可识别', () => {
    const html = renderMarkdown('| 单列 |\n|---|\n| 值 |');
    assert.match(html, /<table>/);
    assert.match(html, /<th>单列<\/th>/);
    assert.match(html, /<td>值<\/td>/);
  });
});

/* ============================================================
 * 列表
 * ============================================================ */

describe('列表', () => {
  it('无序列表', () => {
    const html = renderMarkdown('- a\n- b');
    assert.match(html, /<ul>/);
    assert.equal((html.match(/<li>/g) || []).length, 2);
  });

  it('嵌套列表（两层 ul）', () => {
    const html = renderMarkdown('- a\n  - b\n  - c\n- d');
    assert.equal((html.match(/<ul>/g) || []).length, 2);
    assert.match(html, /<li>a<ul>/);
  });

  it('有序列表连续编号（一个 ol，不逐个 value）', () => {
    const html = renderMarkdown('1. 一\n2. 二\n3. 三');
    assert.match(html, /<ol>/);
    assert.equal((html.match(/<li>/g) || []).length, 3);
    assert.doesNotMatch(html, /start=/);
    assert.doesNotMatch(html, /value=/);
  });

  it('有序列表 start 属性来自首项编号', () => {
    const html = renderMarkdown('3. 三\n4. 四');
    assert.match(html, /<ol start="3">/);
    assert.equal((html.match(/<li>/g) || []).length, 2);
  });

  it('任务列表：复选框 disabled，勾选态 checked', () => {
    const html = renderMarkdown('- [x] 已完成\n- [ ] 未完成');
    assert.match(html, /<ul class="task-list">/);
    assert.match(html, /<li class="task-list-item">/);
    assert.match(html, /<input class="task-checkbox" type="checkbox" disabled checked>/);
    assert.match(html, /<input class="task-checkbox" type="checkbox" disabled>/);
    assert.equal((html.match(/disabled/g) || []).length, 2);
  });

  it('松散列表保留段落包裹', () => {
    const html = renderMarkdown('- 第一段\n\n- 第二段');
    assert.match(html, /<li><p>第一段<\/p><\/li>/);
  });

  it('末尾空行不会把列表误判为松散', () => {
    const tight = renderMarkdown('- a\n- b\n');
    assert.match(tight, /<li>a<\/li>/);
    assert.doesNotMatch(tight, /<li><p>/);
    // CRLF 文本同理
    const crlf = renderMarkdown('- a\r\n- b\r\n');
    assert.match(crlf, /<li>a<\/li>/);
  });

  it('列表项含二级段落/代码时结构完整', () => {
    const html = renderMarkdown('- 步骤\n\n  说明\n\n  ```js\n  const a = 1;\n  ```');
    assert.match(html, /<ul>/);
    assert.match(html, /code-block/);
  });
});

/* ============================================================
 * 引用 / 标题 / 分隔线 / 换行
 * ============================================================ */

describe('引用', () => {
  it('单层引用', () => {
    const html = renderMarkdown('> 引用内容');
    assert.match(html, /<blockquote>\n<p>引用内容<\/p>\n<\/blockquote>/);
  });

  it('嵌套引用', () => {
    const html = renderMarkdown('> 外层\n>\n> > 内层');
    assert.equal((html.match(/<blockquote>/g) || []).length, 2);
    assert.match(html, /外?层/);
    assert.match(html, /内层/);
  });

  it('引用内部支持列表与行内语法', () => {
    const html = renderMarkdown('> **重点**\n>\n> - 一\n> - 二');
    assert.equal((html.match(/<blockquote>/g) || []).length, 1);
    assert.match(html, /<strong>重点<\/strong>/);
    assert.equal((html.match(/<li>/g) || []).length, 2);
  });
});

describe('标题 / 分隔线 / 换行', () => {
  it('ATX 标题 1-6 级', () => {
    for (let level = 1; level <= 6; level++) {
      const html = renderMarkdown(`${'#'.repeat(level)} 标题${level}`);
      assert.match(html, new RegExp(`<h${level}>标题${level}</h${level}>`));
    }
  });

  it('ATX 标题闭合 # 被去掉', () => {
    assert.match(renderMarkdown('## 标题 ##'), /<h2>标题<\/h2>/);
  });

  it('# 后无空格不视为标题', () => {
    const html = renderMarkdown('#标题');
    assert.doesNotMatch(html, /<h1>/);
    assert.match(html, /<p>#标题<\/p>/);
  });

  it('setext 标题（=== / ---）', () => {
    assert.match(renderMarkdown('标题一\n==='), /<h1>标题一<\/h1>/);
    assert.match(renderMarkdown('标题二\n---'), /<h2>标题二<\/h2>/);
  });

  it('分隔线（--- *** ___）', () => {
    assert.match(renderMarkdown('---'), /<hr>/);
    assert.match(renderMarkdown('***'), /<hr>/);
    assert.match(renderMarkdown('___'), /<hr>/);
  });

  it('段内换行渲染为 <br>', () => {
    assert.match(renderMarkdown('第一行\n第二行'), /第一行<br>第二行/);
  });

  it('硬换行：行尾两空格', () => {
    assert.match(renderMarkdown('第一行  \n第二行'), /第一行<br>第二行/);
  });

  it('硬换行：行尾反斜杠', () => {
    assert.match(renderMarkdown('第一行\\\n第二行'), /第一行<br>第二行/);
  });

  it('未闭合强调不报错且保留字面量', () => {
    const html = renderMarkdown('**未闭合的粗体');
    assert.match(html, /\*\*未闭合的粗体/);
    assert.doesNotMatch(html, /<strong>/);
  });
});

/* ============================================================
 * 行内语法
 * ============================================================ */

describe('行内语法', () => {
  it('粗体 / 斜体 / 粗斜体 / 删除线', () => {
    assert.match(renderMarkdown('这是 **粗体** 文本'), /<strong>粗体<\/strong>/);
    assert.match(renderMarkdown('这是 *斜体* 文本'), /<em>斜体<\/em>/);
    assert.match(renderMarkdown('这是 ***粗斜体*** 文本'), /<strong><em>粗斜体<\/em><\/strong>/);
    assert.match(renderMarkdown('这是 ~~删除线~~ 文本'), /<del>删除线<\/del>/);
    assert.match(renderMarkdown('这是 __下划线粗体__ 文本'), /<strong>下划线粗体<\/strong>/);
  });

  it('词内下划线不触发斜体（snake_case）', () => {
    const html = renderMarkdown('变量 snake_case_name 保持不变');
    assert.match(html, /snake_case_name/);
    assert.doesNotMatch(html, /<em>case<\/em>/);
  });

  it('行内代码', () => {
    assert.match(renderMarkdown('使用 `npm i` 安装'), /<code>npm i<\/code>/);
  });

  it('行内代码含反引号（多反引号包裹）', () => {
    const html = renderMarkdown('这是 ``a ` b`` 代码');
    assert.match(html, /<code>a ` b<\/code>/);
  });

  it('行内代码内容被转义且不解析 Markdown', () => {
    const html = renderMarkdown('`<script>**x**</script>`');
    assert.match(html, /<code>&lt;script&gt;\*\*x\*\*&lt;\/script&gt;<\/code>/);
    assert.doesNotMatch(html, /<strong>/);
  });

  it('未闭合行内代码按字面量输出', () => {
    assert.match(renderMarkdown('反引号 ` 未闭合'), /` 未闭合/);
  });

  it('自动链接 <https://...>', () => {
    const html = renderMarkdown('<https://example.com/a?b=1>');
    assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1" target="_blank" rel="noopener noreferrer nofollow">/);
  });

  it('自动链接 <email>', () => {
    const html = renderMarkdown('<user@example.com>');
    assert.match(html, /href="mailto:user@example\.com"/);
  });

  it('裸 URL 自动链接（http/https）', () => {
    const html = renderMarkdown('访问 https://example.com/docs 查看');
    assert.match(html, /<a href="https:\/\/example\.com\/docs"/);
  });

  it('裸 www URL 自动补 https', () => {
    const html = renderMarkdown('访问 www.example.com 查看');
    assert.match(html, /href="https:\/\/www\.example\.com"/);
  });

  it('裸 URL 末尾标点不吞进链接', () => {
    const html = renderMarkdown('见 https://example.com。');
    assert.match(html, /href="https:\/\/example\.com"/);
    assert.match(html, /<\/a>。/);
  });

  it('图片：懒加载 + alt 转义', () => {
    const html = renderMarkdown('![图片 <x>](https://example.com/a.png)');
    assert.match(html, /<img src="https:\/\/example\.com\/a\.png"/);
    assert.match(html, /loading="lazy"/);
    assert.match(html, /alt="图片 &lt;x&gt;"/);
  });

  it('图片非白名单协议不生成 img', () => {
    const html = renderMarkdown('![x](javascript:alert(1))');
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /javascript:/i);
  });
});

/* ============================================================
 * 数学公式
 * ============================================================ */

describe('数学公式', () => {
  it('renderMath 行内输出 span.math-inline', () => {
    const html = renderMath('x^2');
    assert.match(html, /^<span class="math math-inline">/);
    assert.match(html, /<span class="math-sup">/);
  });

  it('renderMath 块级输出 div.math-display', () => {
    const html = renderMath('\\frac{1}{2}', true);
    assert.match(html, /^<div class="math math-display">/);
    assert.match(html, /<span class="math-frac">/);
    assert.match(html, /math-frac-num/);
    assert.match(html, /math-frac-den/);
  });

  it('sqrt / 上下标 / 希腊字母 / 运算符', () => {
    const html = renderMath('\\sqrt{x} + \\alpha \\ge \\sum_{i=1}^{n} i');
    assert.match(html, /<span class="math-sqrt">/);
    assert.match(html, /<span class="math-greek">α<\/span>/);
    assert.match(html, /<span class="math-op">≥<\/span>/);
    assert.match(html, /<span class="math-op math-op-large">∑<\/span>/);
    assert.match(html, /<span class="math-limits-sub">/);
    assert.match(html, /<span class="math-limits-sup">/);
  });

  it('\\text / \\mathrm 输出 math-text', () => {
    const html = renderMath('\\text{速度} \\mathrm{d}x');
    assert.match(html, /<span class="math-text">速度<\/span>/);
    assert.match(html, /math-text math-rm/);
  });

  it('未知命令降级为 code.math-fallback', () => {
    const html = renderMath('\\unknowncmd{x}');
    assert.match(html, /<code class="math-fallback">\\unknowncmd<\/code>/);
  });

  it('无花括号参数遵循 TeX 单 token 语义（\\frac12）', () => {
    const html = renderMath('\\frac12');
    assert.match(html, /<span class="math-num">1<\/span>/);
    assert.match(html, /<span class="math-num">2<\/span>/);
    assert.doesNotMatch(html, /<span class="math-num">12<\/span>/);
  });

  it('行内数学 $...$', () => {
    const html = renderMarkdown('质能方程 $E=mc^2$ 很重要');
    assert.match(html, /class="math math-inline"/);
    assert.match(html, /math-sup/);
  });

  it('块级数学 $$...$$（单行）', () => {
    const html = renderMarkdown('$$\\frac{1}{2}$$');
    assert.match(html, /class="math math-display"/);
    assert.match(html, /math-frac/);
  });

  it('块级数学 $$...$$（多行）', () => {
    const html = renderMarkdown('$$\n\\sqrt{a+b}\n$$');
    assert.match(html, /<div class="math math-display">/);
    assert.match(html, /math-sqrt/);
  });

  it('块级数学 \\[...\\]', () => {
    const html = renderMarkdown('\\[ \\sum_{k=1}^{n} k \\]');
    assert.match(html, /class="math math-display"/);
    assert.match(html, /math-op math-op-large">∑/);
  });

  it('行内数学 \\(...\\)', () => {
    const html = renderMarkdown('公式 \\(a+b\\) 结束');
    assert.match(html, /class="math math-inline"/);
    assert.match(html, /math-op">\+/);
  });

  it('货币 $5 / $10 不误判为公式', () => {
    const html1 = renderMarkdown('这件商品 $5。');
    assert.doesNotMatch(html1, /math-inline/);
    const html2 = renderMarkdown('价格是 $5，总共 $10。');
    assert.doesNotMatch(html2, /math-inline/);
    assert.match(html2, /\$5/);
    assert.match(html2, /\$10/);
  });

  it('行内代码优先级高于数学', () => {
    const html = renderMarkdown('`$x^2$`');
    assert.match(html, /<code>\$x\^2\$<\/code>/);
    assert.doesNotMatch(html, /math-inline/);
  });

  it('代码围栏内不解析数学', () => {
    const html = renderMarkdown('```md\n$x^2$\n```');
    assert.doesNotMatch(html, /math-inline/);
    assert.match(html, /\$x\^2\$/);
  });

  it('opts.math=false 关闭数学解析', () => {
    const html = renderMarkdown('$x^2$', { math: false });
    assert.doesNotMatch(html, /math-inline/);
  });

  it('数学内容中的 HTML 被转义', () => {
    const html = renderMath('\\text{<img onerror=x>}');
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
  });
});

/* ============================================================
 * 数学公式：扩展（环境 / 大运算符 / 根指数 / 非法输入）
 * ============================================================ */

describe('数学公式扩展：根指数与大运算符上下限', () => {
  it('\\sqrt[3]{x} 渲染根指数', () => {
    const html = renderMath('\\sqrt[3]{x}');
    assert.match(html, /<span class="math-root"><span class="math-num">3<\/span><\/span>/);
    assert.match(html, /<span class="math-radicand">/);
  });

  it('\\sqrt[n+1]{x} 根指数按数学内容解析', () => {
    const html = renderMath('\\sqrt[n+1]{x}');
    assert.match(html, /<span class="math-root">/);
    assert.match(html, /<span class="math-var">n<\/span>/);
    assert.match(html, /<span class="math-op">\+<\/span>/);
  });

  it('上下标组合 x_i^2 在同一 math-script 中', () => {
    const html = renderMath('x_i^2');
    assert.match(html, /<span class="math-script">/);
    assert.match(html, /<span class="math-sup">/);
    assert.match(html, /<span class="math-sub">/);
    // 上标和下标都应位于同一个 math-script 容器内
    assert.match(html, /<span class="math-script"><span class="math-base">[\s\S]*<span class="math-sup">[\s\S]*<span class="math-sub">[\s\S]*<\/span><\/span>/);
  });

  it('嵌套上下标 x^{a_b}', () => {
    const html = renderMath('x^{a_b}');
    assert.match(html, /<span class="math-sup"><span class="math-script">/);
    assert.match(html, /<span class="math-sub">/);
  });

  it('\\sum 带上下限使用 math-limits', () => {
    const html = renderMath('\\sum_{i=1}^{n} i', true);
    assert.match(html, /math-op math-op-large">∑/);
    assert.match(html, /<span class="math-limits">/);
    assert.match(html, /<span class="math-limits-base">/);
    assert.match(html, /<span class="math-limits-sub">/);
    assert.match(html, /<span class="math-limits-sup">/);
  });

  it('\\int / \\prod 带上下限', () => {
    assert.match(renderMath('\\int_0^1 x\\,dx', true), /<span class="math-limits">[\s\S]*math-limits-sub/);
    assert.match(renderMath('\\prod_{k=1}^{n} k', true), /math-op-large">∏/);
  });

  it('\\lim 带下标使用 math-limits', () => {
    const html = renderMath('\\lim_{x\\to 0} f(x)', true);
    assert.match(html, /math-op-large">lim/);
    assert.match(html, /math-limits-sub/);
  });

  it('\\left( \\right) 包裹 frac', () => {
    const html = renderMath('\\left( \\frac{a}{b} \\right)');
    assert.match(html, /<span class="math-op">\(<\/span><span class="math-frac">/);
    assert.match(html, /math-frac-den[\s\S]*<span class="math-op">\)<\/span>/);
  });

  it('\\left\\{ \\right. 组合 aligned', () => {
    const html = renderMath('\\left\\{ \\begin{aligned} x &= 1 \\\\ y &= 2 \\end{aligned} \\right.', true);
    assert.match(html, /<span class="math-op">\{<\/span>/);
    assert.match(html, /<span class="math-aligned">/);
  });
});

describe('数学公式扩展：矩阵 / cases / aligned', () => {
  it('pmatrix：定界符 + 行 + 单元格', () => {
    const html = renderMath('\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}', true);
    assert.match(html, /<span class="math-matrix math-matrix-pmatrix">/);
    assert.match(html, /math-matrix-delim math-matrix-open">\(/);
    assert.match(html, /math-matrix-delim math-matrix-close">\)/);
    assert.equal((html.match(/math-matrix-row/g) || []).length, 2);
    assert.equal((html.match(/math-matrix-cell/g) || []).length, 4);
  });

  it('bmatrix / matrix 定界符差异', () => {
    assert.match(renderMath('\\begin{bmatrix} a \\end{bmatrix}', true), /math-matrix-open">\[/);
    const plain = renderMath('\\begin{matrix} a & b \\end{matrix}', true);
    assert.doesNotMatch(plain, /math-matrix-delim/);
    assert.equal((plain.match(/math-matrix-cell/g) || []).length, 2);
  });

  it('cases：左大括号 + 每行表达式/条件', () => {
    const html = renderMath('\\begin{cases} x & x>0 \\\\ -x & x\\le 0 \\end{cases}', true);
    assert.match(html, /<span class="math-cases">/);
    assert.match(html, /math-cases-delim">\{/);
    assert.equal((html.match(/math-case-row/g) || []).length, 2);
    assert.equal((html.match(/math-case-cell math-case-expr/g) || []).length, 2);
    assert.equal((html.match(/math-case-cell math-case-cond/g) || []).length, 2);
  });

  it('aligned：多行多列', () => {
    const html = renderMath('\\begin{aligned} a &= b + c \\\\ d &= e - f \\end{aligned}', true);
    assert.match(html, /<span class="math-aligned">/);
    assert.equal((html.match(/math-aligned-row/g) || []).length, 2);
    assert.equal((html.match(/math-aligned-cell/g) || []).length, 4);
  });

  it('array 带列格式参数（{cc}）被忽略但内容正常', () => {
    const html = renderMath('\\begin{array}{cc} 1 & 2 \\\\ 3 & 4 \\end{array}', true);
    assert.match(html, /math-matrix-array/);
    assert.equal((html.match(/math-matrix-cell/g) || []).length, 4);
    assert.doesNotMatch(html, />cc</);
  });

  it('矩阵单元格内嵌 frac / sqrt / text / 希腊字母', () => {
    const html = renderMath('\\begin{pmatrix} \\frac{1}{2} & \\sqrt{2} \\\\ \\text{让} & \\alpha \\end{pmatrix}', true);
    assert.match(html, /math-matrix-cell"><span class="math-frac">/);
    assert.match(html, /math-matrix-cell"><span class="math-sqrt">/);
    assert.match(html, /<span class="math-text">让<\/span>/);
    assert.match(html, /<span class="math-greek">α<\/span>/);
  });

  it('矩阵可嵌入 frac，也可同名嵌套', () => {
    const outer = renderMath('\\frac{\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}}{2}', true);
    assert.match(outer, /math-frac-num"><span class="math-matrix/);
    const nested = renderMath('\\begin{pmatrix}\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}&5\\end{pmatrix}', true);
    assert.equal((nested.match(/math-matrix math-matrix-pmatrix/g) || []).length, 2);
  });

  it('环境中的 HTML 被转义（XSS）', () => {
    const html = renderMath('\\begin{pmatrix}\\text{<script>alert(1)</script>} & \\text{" onmouseover="x}\\end{pmatrix}', true);
    assertNoDangerTags(html);
    assert.match(html, /&lt;script/);
    assertBalancedHtml(html);
  });

  it('根指数中的 HTML 被转义（XSS）', () => {
    const html = renderMath('\\sqrt[<img src=x onerror=1>]{y}');
    assertNoDangerTags(html);
    assert.doesNotMatch(html, /<img/);
  });

  it('行内数学中的矩阵用 span 承载（不产生 div）', () => {
    const html = renderMarkdown('矩阵 $\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}$ 结束');
    assert.match(html, /<span class="math math-inline"><span class="math-matrix/);
    assert.doesNotMatch(html, /<div/);
  });

  it('Markdown 块级公式集成 cases / aligned', () => {
    const cases = renderMarkdown('$$\\begin{cases} x & x>0 \\\\ -x & x\\le0 \\end{cases}$$');
    assert.match(cases, /^<div class="math math-display"><span class="math-cases">/);
    const aligned = renderMarkdown('$$\n\\begin{aligned} a &= 1 \\\\ b &= 2\n\\end{aligned}\n$$');
    assert.match(aligned, /<div class="math math-display"><span class="math-aligned">/);
  });

  it('数学输出不使用 table/style/script（CSP 兼容 + span 合法嵌套）', () => {
    const outputs = [
      renderMath('\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}', true),
      renderMath('\\begin{cases}x&x>0\\\\-x&x\\le0\\end{cases}', true),
      renderMath('\\begin{aligned}a&=1\\\\b&=2\\end{aligned}', true),
      renderMath('\\sum_{i=1}^{n} i', true),
    ];
    for (const html of outputs) {
      assert.doesNotMatch(html, /<(?:table|thead|tbody|tr|td|th)[\s>]/i);
      assert.doesNotMatch(html, /style=/i);
      assert.doesNotMatch(html, /<script[\s>]/i);
      assertBalancedHtml(html);
    }
  });
});

describe('数学公式扩展：非法输入不崩', () => {
  const malformed = [
    '\\begin{pmatrix} 1 & 2', // 未闭合环境
    '\\begin{cases}', // 空且未闭合
    '\\begin{aligned} a &= b \\\\', // 未闭合 + 末尾换行
    '\\begin{}', // 空环境名
    '\\end{pmatrix}', // 孤立 end
    '\\sqrt[', // 未闭合根指数
    '\\sqrt', // 无参数
    '\\frac', // 无参数
    '\\frac{1}', // 只有一个参数
    '\\left(', // 未闭合 left
    '\\right)', // 孤立 right
    '\\text{', // 未闭合 text
    '}{}{', // 多余花括号
    '\\begin{pmatrix}\\begin{pmatrix}1\\end{pmatrix}', // 同名嵌套未闭合
    '\\begin{aligned} & \\\\ & \\end{aligned}', // 空单元格
  ];

  it('renderMath 对所有畸形输入返回平衡的 HTML 且不抛错', () => {
    for (const tex of malformed) {
      const html = renderMath(tex, true);
      assert.equal(typeof html, 'string');
      assert.match(html, /^<div class="math math-display">/);
      assertNoDangerTags(html);
      assertBalancedHtml(html);
    }
  });

  it('renderMarkdown 中的畸形公式不影响整体渲染', () => {
    for (const tex of malformed) {
      const html = renderMarkdown(`前文 $${tex}$ 后文`);
      assert.equal(typeof html, 'string');
      assert.match(html, /前文/);
      assert.match(html, /后文/);
      assertBalancedHtml(html);
    }
  });

  it('未闭合环境降级为 math-fallback，内容不丢失', () => {
    const html = renderMath('\\begin{pmatrix} 1 & 2', true);
    assert.match(html, /<code class="math-fallback">\\begin\{pmatrix\}<\/code>/);
    assert.match(html, /<span class="math-num">1<\/span>/);
  });

  it('空环境不崩且结构完整', () => {
    const html = renderMath('\\begin{pmatrix}\\end{pmatrix}', true);
    assert.match(html, /math-matrix-pmatrix/);
    assert.match(html, /math-matrix-body"><\/span>/);
    assertBalancedHtml(html);
  });

  it('超深嵌套不栈溢出（环境 / 分式 / 花括号 / 强调）', () => {
    const cases = [
      renderMath('\\begin{pmatrix}'.repeat(200) + '1' + '\\end{pmatrix}'.repeat(200), true),
      renderMath('\\frac{'.repeat(150) + '1' + '}{2}'.repeat(150), true),
      renderMath('{'.repeat(2000) + 'x' + '}'.repeat(2000), true),
      renderMarkdown('*'.repeat(400) + 'x' + '*'.repeat(400)),
      renderMarkdown('**'.repeat(300) + 'x' + '**'.repeat(300)),
    ];
    for (const html of cases) {
      assert.equal(typeof html, 'string');
      assertBalancedHtml(html);
    }
  });
});

/* ============================================================
 * 引用角标
 * ============================================================ */

describe('引用角标', () => {
  it('在 citeNumbers 内渲染为 a.cite', () => {
    const html = renderMarkdown('结论[1]。', { citeNumbers: new Set([1]) });
    assert.match(html, /<a class="cite" data-cite="1" href="#ref-1">1<\/a>/);
  });

  it('不在集合内保持字面量', () => {
    const html = renderMarkdown('参考[9]。', { citeNumbers: new Set([1, 2]) });
    assert.doesNotMatch(html, /data-cite/);
    assert.match(html, /参考\[9\]。/);
  });

  it('连续角标 [1][2]', () => {
    const html = renderMarkdown('引用[1][2]', { citeNumbers: new Set([1, 2]) });
    assert.equal((html.match(/class="cite"/g) || []).length, 2);
    assert.match(html, /data-cite="2" href="#ref-2"/);
  });

  it('citeNumbers 传数组也支持', () => {
    const html = renderMarkdown('见[3]', { citeNumbers: [2, 3] });
    assert.match(html, /data-cite="3"/);
  });

  it('没有 citeNumbers 时保持字面量', () => {
    const html = renderMarkdown('见[1]');
    assert.doesNotMatch(html, /class="cite"/);
    assert.match(html, /\[1\]/);
  });

  it('链接语法优先于角标', () => {
    const html = renderMarkdown('[1](https://example.com)', { citeNumbers: new Set([1]) });
    assert.doesNotMatch(html, /class="cite"/);
    assert.match(html, /href="https:\/\/example\.com"/);
  });
});

/* ============================================================
 * 性能：8KB 混合文本 < 20ms
 * ============================================================ */

function buildDoc() {
  const parts = [];
  for (let i = 0; i < 10; i++) {
    parts.push(`## 第 ${i + 1} 节：渲染性能`);
    parts.push('');
    parts.push(
      '中文段落，包含**粗体**、*斜体*、`行内代码`、~~删除线~~、链接 [示例](https://example.com/path?q=1)、' +
        '自动链接 https://example.com/docs 、图片 ![图](https://example.com/a.png) 与公式 $E=mc^2$，以及引用角标 [1]。'
    );
    parts.push('');
    parts.push('- 列表项一');
    parts.push('  - 嵌套项');
    parts.push('- 列表项二');
    parts.push('');
    parts.push('| 名称 | 数值 | 说明 |');
    parts.push('| --- | ---: | :---: |');
    parts.push('| 项目 | 123 | 说明文字 |');
    parts.push('');
    parts.push('$$\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}$$');
    parts.push('');
    parts.push('$$\\begin{cases} x & x>0 \\\\ -x & x\\le0 \\end{cases}$$');
    parts.push('');
    parts.push('$$\\begin{aligned} a &= 1 \\\\ b &= 2 \\end{aligned}$$');
    parts.push('');
    parts.push('```js');
    parts.push('const value = 42; // 注释');
    parts.push('function add(a, b) { return a + b; }');
    parts.push('const s = "字符串";');
    parts.push('```');
    parts.push('');
    parts.push('> 引用文字：`code` 与 $x^2$。');
    parts.push('');
  }
  return parts.join('\n');
}

describe('性能', () => {
  it('8KB 中文+代码混合文本单次渲染 < 20ms', () => {
    let doc = buildDoc();
    while (Buffer.byteLength(doc, 'utf8') < 8192) doc += '\n' + buildDoc();
    assert.ok(Buffer.byteLength(doc, 'utf8') >= 8192, '语料应至少 8KB');

    // 预热：让语言规则的正则编译缓存建立
    for (let i = 0; i < 3; i++) renderMarkdown(doc);

    const samples = [];
    let html = '';
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      html = renderMarkdown(doc);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const median = samples[3];
    const best = samples[0];
    const worst = samples[samples.length - 1];

    // 供 CI/汇报查看
    console.log(
      `[perf] 8KB renderMarkdown: best=${best.toFixed(2)}ms median=${median.toFixed(2)}ms worst=${worst.toFixed(2)}ms`
    );

    assert.ok(html.includes('class="code-block"'), '大文档应包含代码块');
    assert.ok(html.length > doc.length, '渲染结果应包含标签');
    assert.ok(median < 20, `8KB 中位耗时 ${median.toFixed(2)}ms 应小于 20ms`);
  });
});
