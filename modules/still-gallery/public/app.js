/** Public gallery: browse images, open the viewer, copy the prompt behind any image. */
import { toast, copyText, el, formatBytes, formatDate, api } from './ui.js';

const state = {
  images: [],
  query: '',
  tag: null,
  sort: 'newest',
  active: null,
};

const grid = document.getElementById('grid');
const tagBar = document.getElementById('tagBar');
const statCount = document.getElementById('statCount');
const searchInput = document.getElementById('searchInput');
const sortSelect = document.getElementById('sortSelect');
const viewer = document.getElementById('viewer');
const viewerImage = document.getElementById('viewerImage');
const viewerTitle = document.getElementById('viewerTitle');
const viewerTags = document.getElementById('viewerTags');
const viewerPrompt = document.getElementById('viewerPrompt');
const viewerNegative = document.getElementById('viewerNegative');
const negativeBlock = document.getElementById('negativeBlock');
const viewerMeta = document.getElementById('viewerMeta');
const viewerDownload = document.getElementById('viewerDownload');
const viewerSource = document.getElementById('viewerSource');

/** Text that the viewer's copy buttons should place on the clipboard. */
function copyPayload(kind) {
  const image = state.active;
  if (!image) return '';
  if (kind === 'prompt') return image.prompt;
  if (kind === 'negativePrompt') return image.negativePrompt;
  const lines = [`# ${image.title}`, '', '## 正向提示词', image.prompt];
  if (image.negativePrompt) lines.push('', '## 反向提示词', image.negativePrompt);
  const meta = [
    ['模型', image.model],
    ['画面比例', image.aspectRatio],
    ['随机种子', image.seed],
    ['采样步数', image.steps],
    ['引导强度', image.guidance],
    ['标签', (image.tags || []).join(', ')],
  ].filter(([, value]) => value);
  if (meta.length) {
    lines.push('', '## 生成参数');
    for (const [key, value] of meta) lines.push(`${key}: ${value}`);
  }
  const source = image.provenance;
  if (source) {
    lines.push('', '## 来源');
    lines.push(`来源: ${source.source || '—'}`);
    if (source.sessionId) lines.push(`会话 ID: ${source.sessionId}`);
    const modeLabel =
      source.mode === 'image2image' ? '图生图' : source.mode === 'text2group' ? '文生组图' : '文生图';
    lines.push(`生成方式: ${modeLabel}`);
    if (source.size) lines.push(`生成尺寸: ${source.size}`);
    if (source.groupIndex && source.groupTotal > 1) {
      lines.push(`组图序号: 第 ${source.groupIndex} / ${source.groupTotal} 张`);
    }
    if (source.referenceCount) lines.push(`参考图数量: ${source.referenceCount} 张`);
    if (source.llmModel) lines.push(`规划模型: ${source.llmModel}`);
    if (source.generatedAt) lines.push(`生成时间: ${source.generatedAt}`);
    if (source.latencySeconds != null) lines.push(`生成耗时: ${source.latencySeconds} 秒`);
  }
  return lines.join('\n');
}

function visibleImages() {
  const query = state.query.trim().toLowerCase();
  let list = state.images.filter((image) => {
    if (state.tag && !(image.tags || []).includes(state.tag)) return false;
    if (!query) return true;
    return (
      image.title.toLowerCase().includes(query) ||
      image.prompt.toLowerCase().includes(query) ||
      (image.negativePrompt || '').toLowerCase().includes(query) ||
      (image.model || '').toLowerCase().includes(query) ||
      (image.tags || []).some((tag) => tag.toLowerCase().includes(query))
    );
  });
  list = list.slice();
  if (state.sort === 'oldest') {
    list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  } else if (state.sort === 'title') {
    list.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  } else {
    list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  return list;
}

function renderTags() {
  const counts = new Map();
  for (const image of state.images) {
    for (const tag of image.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  tagBar.replaceChildren();
  if (!counts.size) return;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'));

  const makeChip = (label, value, count) => {
    const chip = el('button', `tag-chip${state.tag === value ? ' active' : ''}`, label);
    chip.type = 'button';
    if (count !== undefined) chip.appendChild(el('span', 'count', String(count)));
    chip.addEventListener('click', () => {
      state.tag = state.tag === value ? null : value;
      renderTags();
      renderGrid();
    });
    return chip;
  };

  tagBar.appendChild(makeChip('全部', null, state.images.length));
  for (const [tag, count] of sorted) tagBar.appendChild(makeChip(tag, tag, count));
}

/**
 * Best-effort aspect ratio for a record, as width / height.
 *
 * The stored `aspectRatio` field is not trustworthy: imports have written the
 * `size` parameter into it, so it holds presets like "2K" next to real ratios
 * ("4:3") and raw dimensions ("1664x2496"). Parse the two usable shapes and
 * return null for anything else — the caller falls back to a square box, which
 * the bitmap then corrects once it loads.
 */
function aspectRatioOf(image) {
  const match = String(image.aspectRatio || '')
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!(width > 0) || !(height > 0)) return null;
  return width / height;
}

function renderGrid() {
  const list = visibleImages();
  grid.replaceChildren();

  if (!list.length) {
    const empty = el('div', 'empty');
    const hasFilter = Boolean(state.query.trim() || state.tag);
    empty.appendChild(el('h2', null, hasFilter ? '没有匹配的作品' : '画廊还是空的'));
    empty.appendChild(
      el(
        'p',
        null,
        hasFilter ? '换个关键词或标签试试。' : '前往管理后台，粘贴图片地址与提示词即可导入第一张作品。',
      ),
    );
    const link = el('a', 'btn btn-primary', hasFilter ? '重置筛选' : '进入管理后台');
    link.href = hasFilter ? '#' : '/admin';
    if (hasFilter) {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        state.query = '';
        state.tag = null;
        searchInput.value = '';
        renderTags();
        renderGrid();
      });
    }
    empty.appendChild(link);
    grid.appendChild(empty);
    return;
  }

  for (const image of list) {
    // The whole tile is the button. Clicking navigates to the detail view, which
    // is the only place the prompt is rendered — nothing prompt-shaped lives on
    // this page.
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    tile.setAttribute('aria-label', `查看《${image.title}》的提示词与参数`);

    const img = document.createElement('img');
    img.src = image.imageUrl;
    img.alt = image.title;
    img.loading = 'lazy';
    img.decoding = 'async';
    // Reserve the right box up front so the columns do not reflow as bitmaps
    // stream in; `load` then corrects it if the guess was wrong.
    const ratio = aspectRatioOf(image);
    img.style.aspectRatio = String(ratio || 1);
    img.addEventListener(
      'load',
      () => {
        if (!img.naturalWidth || !img.naturalHeight) return;
        const natural = img.naturalWidth / img.naturalHeight;
        if (Math.abs(natural - (ratio || 1)) > 0.01) img.style.aspectRatio = String(natural);
      },
      { once: true },
    );
    tile.appendChild(img);

    const veil = el('span', 'tile-veil');
    veil.appendChild(el('span', 'tile-title', image.title));
    const tags = (image.tags || [])
      .slice(0, 2)
      .map((tag) => `#${tag}`)
      .join(' ');
    veil.appendChild(el('span', 'tile-hint', tags ? `${tags} · 查看提示词` : '查看提示词'));
    tile.appendChild(veil);

    tile.addEventListener('click', () => openViewer(image));
    grid.appendChild(tile);
  }
}

function openViewer(image, { pushState = true } = {}) {
  state.active = image;
  viewerImage.src = image.imageUrl;
  viewerImage.alt = image.title;
  viewerTitle.textContent = image.title;
  viewerPrompt.textContent = image.prompt;

  viewerTags.replaceChildren();
  for (const tag of image.tags || []) viewerTags.appendChild(el('span', 'chip', `#${tag}`));

  if (image.negativePrompt) {
    negativeBlock.hidden = false;
    viewerNegative.textContent = image.negativePrompt;
  } else {
    negativeBlock.hidden = true;
  }

  const rows = [
    ['模型', image.model],
    ['画面比例', image.aspectRatio],
    ['随机种子', image.seed],
    ['采样步数', image.steps],
    ['引导强度', image.guidance],
    ['文件大小', image.bytes ? formatBytes(image.bytes) : ''],
    ['导入时间', formatDate(image.createdAt)],
    ['图片地址', image.imageUrl],
  ].filter(([, value]) => value);

  const source = image.provenance;
  if (source) {
    const generated = source.source === 'AI 生成';
    const sourceRows = [
      ['来源', source.source],
      ['会话 ID', source.sessionId],
      [
        '生成方式',
        source.mode === 'image2image'
          ? '图生图（带参考图）'
          : source.mode === 'text2group'
            ? '文生组图'
            : '文生图',
      ],
      ['生成尺寸', source.size],
      [
        '组图序号',
        source.groupIndex && source.groupTotal > 1 ? `第 ${source.groupIndex} / ${source.groupTotal} 张` : '',
      ],
      ['参考图数量', source.referenceCount ? `${source.referenceCount} 张` : ''],
      ['生成时间', source.generatedAt ? formatDate(source.generatedAt) : ''],
      ['生成耗时', source.latencySeconds != null ? `${source.latencySeconds} 秒` : ''],
      ['生图耗时', source.imageLatencySeconds != null ? `${source.imageLatencySeconds} 秒` : ''],
      ['规划模型', source.llmModel],
      ['生图模型', generated ? source.model : ''],
      ['Token 用量', source.tokens ? String(source.tokens.total) : ''],
      ['日志截断', source.promptTruncated ? '提示词被日志截断' : ''],
    ].filter(([, value]) => value);
    rows.push(...sourceRows);
  }

  viewerMeta.replaceChildren();
  for (const [key, value] of rows) {
    const cell = el('div', 'meta-cell');
    cell.appendChild(el('dt', null, key));
    cell.appendChild(el('dd', null, value));
    viewerMeta.appendChild(cell);
  }

  viewerDownload.href = image.imageUrl;
  viewerDownload.setAttribute('download', `${image.title || 'image'}`.replace(/[\\/:*?"<>|]/g, '_'));
  if (image.sourceUrl) {
    viewerSource.hidden = false;
    viewerSource.href = image.sourceUrl;
  } else {
    viewerSource.hidden = true;
    viewerSource.removeAttribute('href');
  }

  viewer.hidden = false;
  viewer.classList.add('open');
  document.body.style.overflow = 'hidden';
  if (pushState) {
    // A real history entry rather than a replace, so the browser Back button
    // closes the detail view and the URL stays shareable.
    const url = new URL(window.location.href);
    url.searchParams.set('image', image.id);
    window.history.pushState({ image: image.id }, '', url);
  }
  document.getElementById('viewerClose').focus();
}

function closeViewer({ pushState = true } = {}) {
  viewer.classList.remove('open');
  viewer.hidden = true;
  document.body.style.overflow = '';
  state.active = null;

  const url = new URL(window.location.href);
  if (!url.searchParams.has('image')) return;
  if (pushState && window.history.state && window.history.state.image) {
    // We pushed this entry when opening, so unwind it. Popping instead of
    // pushing keeps history from growing with every open/close cycle, and it is
    // what makes Back feel right in both directions.
    window.history.back();
    return;
  }
  // Opened from a deep link, so there is no entry of ours to pop.
  url.searchParams.delete('image');
  window.history.replaceState(null, '', url);
}

document.getElementById('viewerClose').addEventListener('click', () => closeViewer());
viewer.addEventListener('click', (event) => {
  if (event.target === viewer) closeViewer();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && viewer.classList.contains('open')) closeViewer();
});

// Keep the view in step with the URL, so Back/Forward move between the grid and
// an open detail view the way a normal page navigation would.
window.addEventListener('popstate', () => {
  const wanted = new URL(window.location.href).searchParams.get('image');
  if (!wanted) {
    if (viewer.classList.contains('open')) closeViewer({ pushState: false });
    return;
  }
  const match = state.images.find((image) => image.id === wanted);
  if (match) openViewer(match, { pushState: false });
  else if (viewer.classList.contains('open')) closeViewer({ pushState: false });
});

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const kind = button.dataset.copy;
    const text = copyPayload(kind);
    const labels = { prompt: '提示词', negativePrompt: '反向提示词', all: '完整参数' };
    try {
      await copyText(text);
      toast(`${labels[kind] || '内容'}已复制到剪贴板`, 'ok');
    } catch {
      toast('复制失败，请手动选择文本复制', 'error');
    }
  });
}

let searchTimer = 0;
searchInput.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    state.query = searchInput.value;
    renderGrid();
  }, 140);
});

sortSelect.addEventListener('change', () => {
  state.sort = sortSelect.value;
  renderGrid();
});

document.getElementById('clearFilters').addEventListener('click', () => {
  state.query = '';
  state.tag = null;
  searchInput.value = '';
  sortSelect.value = 'newest';
  state.sort = 'newest';
  renderTags();
  renderGrid();
});

async function boot() {
  grid.replaceChildren(...Array.from({ length: 6 }, () => el('div', 'skeleton')));

  try {
    const data = await api('/api/images');
    state.images = Array.isArray(data.images) ? data.images : [];
  } catch (error) {
    state.images = [];
    toast(`加载失败：${error.message}`, 'error', 5000);
  }

  statCount.textContent = `${state.images.length} 张作品`;
  renderTags();
  renderGrid();

  // Deep link support: /?image=<id> opens that item directly.
  const wanted = new URL(window.location.href).searchParams.get('image');
  if (wanted) {
    const match = state.images.find((image) => image.id === wanted);
    if (match) openViewer(match, { pushState: false });
  }
}

boot();
