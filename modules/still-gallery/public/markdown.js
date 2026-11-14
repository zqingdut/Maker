/**
 * 一个**只够用**的 Markdown 渲染器，给后台剪贴板用。
 *
 * 为什么不用现成的：这个项目零依赖，没有打包步骤，页面走 `script-src 'self'`
 * 的 CSP，CDN 上的 marked / markdown-it 一个都加载不了。
 *
 * 安全上的唯一规矩：**先转义，再上标签**。用户贴进来的任何字节都先过 `escapeHtml`，
 * 之后所有 `<` 都已经是 `&lt;`，我们插入的标签是自己拼的常量。链接另有一道
 * 白名单（只放 http / https / mailto / tel / 相对路径），`javascript:` 一律按
 * 纯文本渲染。
 *
 * 支持的语法（够覆盖复制来的文档）：标题、围栏代码块、引用、有序/无序列表、
 * 分隔线、行内代码、粗体、斜体、删除线、链接。**不支持**表格、图片、嵌套列表
 * ——它们要么需要额外一条渲染管线，要么会带来外部请求（远程图片就是追踪像素），
 * 真要看原文，界面里有「源码」开关。
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** 链接只认这几种前缀。`javascript:` / `data:` 会落到「按纯文本渲染」那一支。 */
const SAFE_HREF = /^(?:https?:\/\/|mailto:|tel:|\/|#|\.{1,2}\/)/i;

function renderLink(label, rawHref, forClipboard = false) {
  const href = String(rawHref || '').trim();
  if (!href || !SAFE_HREF.test(href)) return null;
  // href 已经是转义过的文本（& 变成 &amp;），可以直接放进属性里。
  return `<a href="${href}" target="_blank" rel="noopener noreferrer"${styleAttr('a', forClipboard)}>${label}</a>`;
}

/**
 * 行内语法。输入必须是**已转义**的文本。
 *
 * 先按反引号切成「代码段 / 非代码段」交替，再只对非代码段套用其它规则——否则
 * `` `**not bold**` `` 里的星号会被当成粗体。
 */
function renderInline(escaped, forClipboard = false) {
  const chunks = escaped.split(/(`[^`\n]+`)/g);
  return chunks
    .map((chunk, index) => {
      if (index % 2 === 1) return `<code${styleAttr('code', forClipboard)}>${chunk.slice(1, -1)}</code>`;
      return chunk
        .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (match, label, href) => renderLink(label, href, forClipboard) ?? match)
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
        .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
        .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
        .replace(/(^|[^A-Za-z0-9_])_([^_\n]+)_/g, '$1<em>$2</em>');
    })
    .join('');
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`~]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const QUOTE = /^\s{0,3}>\s?/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

/**
 * 写进系统剪贴板时用的行内样式。
 *
 * 页面里的排版靠 styles.css，可**粘贴目标不加载我们的 CSS**——贴到 Word、公众号
 * 编辑器里，`<pre>` 会退化成一行挤在一起的等宽字。所以这一份是「自带行李」的
 * 版本：只用行内样式，而且只给那些浏览器默认样式不够用的标签加（标题、列表、
 * 粗体交给目标自己排，那才是它该有的样子）。
 */
const CLIPBOARD_STYLE = {
  pre: 'margin:0 0 10px;padding:10px 12px;border-radius:6px;background:#f2f4f8;' +
    'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;' +
    'line-height:1.6;white-space:pre-wrap;word-break:break-word',
  code: 'padding:1px 4px;border-radius:4px;background:#f2f4f8;' +
    'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px',
  blockquote: 'margin:0 0 10px;padding:2px 0 2px 12px;border-left:3px solid #d5dbe6;color:#555',
  hr: 'border:0;border-top:1px solid #dde3ee;margin:14px 0',
  a: 'color:#4756b8',
};

function styleAttr(tag, forClipboard) {
  return forClipboard && CLIPBOARD_STYLE[tag] ? ` style="${CLIPBOARD_STYLE[tag]}"` : '';
}

/** 这一行是不是「新块的开头」——段落遇到它就得收尾。 */
function startsBlock(line) {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line);
}

/**
 * 把 Markdown 源码渲染成 HTML 片段。
 *
 * @param {string} source
 * @param {{forClipboard?: boolean}} [options] `forClipboard` 给 `pre` / `code` /
 *   `blockquote` / `hr` / `a` 加上行内样式，用于写进系统剪贴板（见 CLIPBOARD_STYLE）
 * @returns {string} 可以直接赋给 `innerHTML` 的字符串（内容已全部转义）
 */
export function renderMarkdown(source, { forClipboard = false } = {}) {
  const text = String(source ?? '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return '';
  const lines = text.split('\n');
  const out = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    /* ---- 围栏代码块 ---- */
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = /^[\w+#.-]{1,20}$/.test(fence[2]) ? fence[2] : '';
      const body = [];
      index += 1;
      while (index < lines.length) {
        const closing = FENCE.exec(lines[index]);
        // 闭合围栏必须是同一种字符、长度不短于开头那个。
        if (closing && closing[1][0] === marker[0] && closing[1].length >= marker.length) {
          index += 1;
          break;
        }
        body.push(lines[index]);
        index += 1;
      }
      const cls = lang ? ` class="language-${lang}"` : '';
      out.push(
        `<pre class="md-code"${styleAttr('pre', forClipboard)}><code${cls}${styleAttr('code', forClipboard)}>${escapeHtml(body.join('\n'))}</code></pre>`,
      );
      continue;
    }

    /* ---- 标题 ---- */
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(escapeHtml(heading[2]), forClipboard)}</h${level}>`);
      index += 1;
      continue;
    }

    /* ---- 分隔线 ---- */
    if (RULE.test(line)) {
      out.push(`<hr${styleAttr('hr', forClipboard)} />`);
      index += 1;
      continue;
    }

    /* ---- 引用 ---- */
    if (QUOTE.test(line)) {
      const body = [];
      while (index < lines.length && QUOTE.test(lines[index])) {
        body.push(lines[index].replace(QUOTE, ''));
        index += 1;
      }
      // 递归：引用里可以再有标题、列表。深度由输入决定，Markdown 里没人嵌十层。
      out.push(
        `<blockquote${styleAttr('blockquote', forClipboard)}>${renderMarkdown(body.join('\n'), { forClipboard })}</blockquote>`,
      );
      continue;
    }

    /* ---- 列表 ---- */
    const first = ITEM.exec(line);
    if (first) {
      const ordered = /\d/.test(first[2]);
      const items = [];
      while (index < lines.length) {
        const item = ITEM.exec(lines[index]);
        if (!item) break;
        // 同一段列表里混用 `-` 和 `1.` 是常见笔误，按第一行的种类统一渲染。
        items.push(item[3]);
        index += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      const start = ordered ? Number.parseInt(first[2], 10) : 1;
      const attr = ordered && start > 1 ? ` start="${start}"` : '';
      const body = items
        .map((item) => `<li>${renderInline(escapeHtml(item), forClipboard)}</li>`)
        .join('');
      out.push(`<${tag}${attr} class="md-list">${body}</${tag}>`);
      continue;
    }

    /* ---- 段落：连续的非空行，遇到空行或新块开头为止 ---- */
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !(paragraph.length && startsBlock(lines[index]))) {
      paragraph.push(lines[index]);
      index += 1;
    }
    // 行内换行保留成 <br>：贴进来的是歌词、清单、地址，压成一段反而看不懂。
    out.push(
      `<p>${paragraph.map((row) => renderInline(escapeHtml(row), forClipboard)).join('<br />')}</p>`,
    );
  }

  return out.join('');
}

/** 只取一段纯文本摘要，给列表里的「一行预览」用（不渲染 HTML）。 */
export function markdownSummary(source, max = 120) {
  const text = String(source ?? '')
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[>#\s-]*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 写进系统剪贴板用的 HTML：渲染结果 + 一份自带的行内样式。
 *
 * 外面这层 `div` 不是多余的——粘到公众号编辑器里，没有它的时候字号会继承到
 * 目标文档的默认值（通常是 16px 的正文），标题和正文的层级就看不出来了。
 */
export function renderMarkdownForClipboard(source) {
  const body = renderMarkdown(source, { forClipboard: true });
  if (!body) return '';
  return (
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;' +
    'font-size:14px;line-height:1.66;color:#2b3445">' +
    body +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * 纯文本化
 * ------------------------------------------------------------------ */

/** 行内语法 → 纯文本。输入是**原文**（不是转义后的文本）。 */
function inlineToText(value) {
  return String(value)
    // 图片先处理：`![alt](url)` 留 alt，`[](url)` 留空
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/(^|[^A-Za-z0-9_])_([^_\n]+)_/g, '$1$2')
    // 反斜杠转义：`\*` 表示一个真的星号
    .replace(/\\([\\`*_{}[\]()#+\-.!>])/g, '$1');
}

/**
 * Markdown → 纯文本，**保留行结构**。
 *
 * 这是「仅复制文本」用的：贴到微信、邮件、输入框里时，`**粗体**` 和 `# 标题`
 * 的符号必须消失，但段落、列表、代码块的行还得在——全压成一行（像
 * `markdownSummary` 那样）是摘要，不是复制。
 *
 * 列表符号的处理：无序列表的 `-` / `*` 是纯语法，换成 `· `；有序列表的 `1.`
 * 是内容的一部分（顺序本身有意义），原样保留。
 */
export function markdownToText(source) {
  const text = String(source ?? '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return '';
  const lines = text.split('\n');
  const out = [];
  let inFence = null;

  for (const line of lines) {
    const fence = FENCE.exec(line);
    if (fence) {
      // 围栏行本身去掉，里面的内容原样保留（代码里的符号不能被当成语法）。
      inFence = inFence ? null : fence[1];
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (!line.trim()) {
      out.push('');
      continue;
    }
    if (RULE.test(line)) continue;

    const heading = HEADING.exec(line);
    if (heading) {
      out.push(inlineToText(heading[2]));
      continue;
    }
    if (QUOTE.test(line)) {
      out.push(inlineToText(line.replace(QUOTE, '')));
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const marker = /\d/.test(item[2]) ? `${Number.parseInt(item[2], 10)}. ` : '· ';
      out.push(marker + inlineToText(item[3]));
      continue;
    }
    out.push(inlineToText(line));
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
