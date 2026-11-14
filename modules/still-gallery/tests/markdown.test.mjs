/**
 * Markdown 渲染器的用例。
 *
 * 这里一半的用例是安全用例，理由很简单：剪贴板里的内容来自**任意来源**——网上
 * 复制的文章、别人发来的笔记。渲染器一旦漏掉一处转义，后台就多一个存储型 XSS，
 * 而这个后台的会话能删图、能花钱生图。所以「先转义再上标签」这条规矩必须有用例
 * 钉着，不能靠读代码时的信心。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  markdownSummary,
  markdownToText,
  renderMarkdown,
  renderMarkdownForClipboard,
} from '../public/markdown.js';

test('任何 HTML 都被转义，不会变成标签', () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /&lt;script&gt;/);

  const img = renderMarkdown('<img src=x onerror=alert(1)>');
  assert.equal(img.includes('<img'), false);
  assert.match(img, /&lt;img/);
});

test('链接只放行 http(s) / mailto / 相对路径，javascript: 按纯文本渲染', () => {
  const safe = renderMarkdown('[官网](https://example.com/a?b=1&c=2)');
  assert.match(safe, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2"/);
  assert.match(safe, /target="_blank"/);
  assert.match(safe, /rel="noopener noreferrer"/);

  const evil = renderMarkdown('[点我](javascript:alert(1))');
  assert.equal(evil.includes('<a '), false, 'javascript: 不能变成可点击链接');

  const data = renderMarkdown('[点我](data:text/html;base64,PHNjcmlwdD4=)');
  assert.equal(data.includes('<a '), false, 'data: 同样不能');
});

test('标题、分隔线、引用、列表都按块渲染', () => {
  assert.equal(renderMarkdown('# 一级'), '<h1>一级</h1>');
  assert.equal(renderMarkdown('### 三级'), '<h3>三级</h3>');
  assert.equal(renderMarkdown('---'), '<hr />');
  assert.equal(renderMarkdown('> 引用一行'), '<blockquote><p>引用一行</p></blockquote>');

  const ul = renderMarkdown('- 一\n- 二');
  assert.equal(ul, '<ul class="md-list"><li>一</li><li>二</li></ul>');

  const ol = renderMarkdown('1. 一\n2. 二');
  assert.equal(ol, '<ol class="md-list"><li>一</li><li>二</li></ol>');

  const fromThree = renderMarkdown('3. 三\n4. 四');
  assert.match(fromThree, /^<ol start="3"/, '从 3 开始的列表要带上 start');
});

test('围栏代码块保留原文，里面的 Markdown 不被解析', () => {
  const html = renderMarkdown('```js\nconst a = "**not bold**";\n```');
  assert.equal(html, '<pre class="md-code"><code class="language-js">const a = &quot;**not bold**&quot;;</code></pre>');

  // 没写语言也能渲染。
  assert.match(renderMarkdown('```\nplain\n```'), /<pre class="md-code"><code>plain<\/code><\/pre>/);

  // 代码块里的 `<` 照样转义。
  assert.match(renderMarkdown('```\n<div>\n```'), /&lt;div&gt;/);
});

test('行内代码优先：代码里的星号不会变成粗体', () => {
  const html = renderMarkdown('用 `**粗体**` 表示粗体');
  assert.match(html, /<code>\*\*粗体\*\*<\/code>/);
  assert.equal(html.includes('<strong>'), false);
});

test('粗体、斜体、删除线', () => {
  assert.equal(renderMarkdown('**粗**'), '<p><strong>粗</strong></p>');
  assert.equal(renderMarkdown('*斜*'), '<p><em>斜</em></p>');
  assert.equal(renderMarkdown('~~删~~'), '<p><del>删</del></p>');
  // 下划线形式只在词边界上生效，`snake_case_name` 不该被拆成斜体。
  assert.equal(renderMarkdown('snake_case_name'), '<p>snake_case_name</p>');
});

test('段落内的换行保留成 br，空行分段', () => {
  assert.equal(renderMarkdown('第一行\n第二行'), '<p>第一行<br />第二行</p>');
  assert.equal(renderMarkdown('一段\n\n另一段'), '<p>一段</p><p>另一段</p>');
});

test('空输入与纯空白返回空串', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown('   \n\n  '), '');
  assert.equal(renderMarkdown(null), '');
});

test('没闭合的围栏代码块也把剩下的都当代码，不会漏出原文', () => {
  const html = renderMarkdown('```\n第一行\n第二行');
  assert.match(html, /<pre class="md-code"><code>第一行\n第二行<\/code><\/pre>/);
});

test('摘要：去掉语法符号，压成一行', () => {
  assert.equal(markdownSummary('# 标题\n\n- 一\n- 二'), '标题 一 二');
  assert.equal(markdownSummary('[链接](https://a.com) 后面'), '链接 后面');
  assert.equal(markdownSummary('a'.repeat(200), 10), 'aaaaaaaaaa…');
});

/* ------------------------- 写进系统剪贴板 ------------------------- */

test('剪贴板用的 HTML 自带行内样式，粘贴目标不加载我们的 CSS 也不塌', () => {
  const html = renderMarkdownForClipboard('# 标题\n\n```js\ncode\n```\n\n> 引用\n\n行内 `x`');
  assert.match(html, /^<div style="[^"]+font-size:14px/, '要有一层带字号的容器');
  assert.match(html, /<pre class="md-code" style="[^"]+white-space:pre-wrap/, '代码块要自带换行样式');
  assert.match(html, /<code class="language-js" style="[^"]+font-family/, '代码块里的 code 也要带样式');
  assert.match(html, /<blockquote style="[^"]+border-left/, '引用要自带左边框');
  assert.match(html, /<code style="[^"]+font-family/, '行内代码同样');
});

test('页面里渲染的那份不带行内样式（样式表已经管了，重复一遍只会更难改）', () => {
  const html = renderMarkdown('# 标题\n\n```\ncode\n```');
  assert.equal(html.includes('style='), false);
});

test('纯文本化：去掉标记但保留行结构', () => {
  const text = markdownToText('# 标题\n\n正文**粗**和*斜*和~~删~~\n\n- 一\n- 二');
  assert.equal(text, '标题\n\n正文粗和斜和删\n\n· 一\n· 二');
});

test('纯文本化：有序列表的序号保留，链接只留文字', () => {
  assert.equal(markdownToText('1. 先做这个\n2. 再做那个'), '1. 先做这个\n2. 再做那个');
  assert.equal(markdownToText('看 [官网](https://example.com) 就行'), '看 官网 就行');
  assert.equal(markdownToText('用 `npm start` 启动'), '用 npm start 启动');
  assert.equal(markdownToText('> 引用一句'), '引用一句');
  assert.equal(markdownToText('上面\n\n---\n\n下面'), '上面\n\n下面', '分隔线整行去掉');
});

test('纯文本化：代码块里的符号原样保留，围栏本身去掉', () => {
  const text = markdownToText('```js\nconst a = "**not bold**";\n```');
  assert.equal(text, 'const a = "**not bold**";');
});

test('纯文本化：空输入返回空串', () => {
  assert.equal(markdownToText(''), '');
  assert.equal(markdownToText('   \n\n'), '');
});
