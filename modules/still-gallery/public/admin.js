/** Admin console: authenticate, generate, import images by URL, edit metadata, export. */
import {
  toast,
  el,
  formatBytes,
  formatDate,
  api,
  copyText,
  readText,
  promptBudget,
  PROMPT_BUDGET,
  containRect,
  pointerToImagePixel,
  bboxTag,
  pointTag,
} from './ui.js';
import { markdownSummary, markdownToText, renderMarkdown, renderMarkdownForClipboard } from './markdown.js';

const fields = {
  url: document.getElementById('fieldUrl'),
  title: document.getElementById('fieldTitle'),
  prompt: document.getElementById('fieldPrompt'),
  negativePrompt: document.getElementById('fieldNegative'),
  model: document.getElementById('fieldModel'),
  aspectRatio: document.getElementById('fieldAspect'),
  seed: document.getElementById('fieldSeed'),
  steps: document.getElementById('fieldSteps'),
  guidance: document.getElementById('fieldGuidance'),
  tags: document.getElementById('fieldTags'),
};

const gate = document.getElementById('gate');
const consoleSection = document.getElementById('console');
const gateForm = document.getElementById('gateForm');
const gateTitle = document.getElementById('gateTitle');
const gateNote = document.getElementById('gateNote');
const gatePassword = document.getElementById('gatePassword');
const gateConfirmField = document.getElementById('gateConfirmField');
const gateConfirm = document.getElementById('gateConfirm');
const gateSubmit = document.getElementById('gateSubmit');
const gateHint = document.getElementById('gateHint');
const urlField = document.getElementById('urlField');
const formTitle = document.getElementById('formTitle');
const formBanner = document.getElementById('formBanner');
const submitBtn = document.getElementById('submitBtn');
const cancelEditBtn = document.getElementById('cancelEditBtn');
const managedList = document.getElementById('managedList');
const managedCount = document.getElementById('managedCount');
const previewFrame = document.getElementById('previewFrame');
const logoutBtn = document.getElementById('logoutBtn');

const state = { configured: false, authenticated: false, images: [], editingId: null };

/* ------------------------------ auth ------------------------------ */

function renderGate() {
  gate.hidden = false;
  consoleSection.hidden = true;
  logoutBtn.hidden = true;
  state.authenticated = false;
  const setupMode = !state.configured;
  gateTitle.textContent = setupMode ? '首次使用 · 设置管理密码' : '管理者登录';
  gateNote.textContent = setupMode
    ? '这个部署还没有管理者账户。请设置一个至少 10 位的密码，用于保护导入与删除操作。'
    : '请输入管理密码以继续。';
  gateConfirmField.hidden = !setupMode;
  gateSubmit.textContent = setupMode ? '设置密码并进入' : '进入后台';
  gateHint.hidden = false;
  gatePassword.value = '';
  gateConfirm.value = '';
}

function renderConsole() {
  gate.hidden = true;
  consoleSection.hidden = false;
  logoutBtn.hidden = false;
  state.authenticated = true;
  urlField.hidden = state.editingId !== null;
}

gateForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = gatePassword.value;
  const setupMode = !state.configured;

  if (setupMode) {
    if (password.length < 10) {
      toast('密码至少需要 10 个字符', 'error');
      return;
    }
    if (password !== gateConfirm.value) {
      toast('两次输入的密码不一致', 'error');
      return;
    }
  } else if (!password) {
    toast('请输入密码', 'error');
    return;
  }

  gateSubmit.disabled = true;
  try {
    await api(setupMode ? '/api/auth/setup' : '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    state.configured = true;
    toast(setupMode ? '管理密码已设置' : '登录成功', 'ok');
    renderConsole();
    await Promise.all([loadImages(), loadGenConfig()]);
    await loadQueue();
    // 登录前 setTab 只切了面板不加载数据（当时还没权限），这里补一次。
    setTab(rememberedTab());
  } catch (error) {
    toast(error.message, 'error', 4200);
  } finally {
    gateSubmit.disabled = false;
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    /* the cookie is cleared server-side on success; a failure is not fatal */
  }
  state.images = [];
  state.editingId = null;
  resetLogPanel();
  resetQueuePanel();
  resetGenPanel();
  scheduleEventRefresh(false);
  toast('已退出登录');
  renderGate();
});

/**
 * 会话过期时后端一律回 401。不统一处理的话，每个面板只会自己写一句「加载失败」，
 * 人却还停在控制台上，点哪儿都像没反应——尤其是只在进入时才拉数据的「生成记录」
 * 和「运行日志」。这里统一退回登录页，并把原因说清楚。
 */
window.addEventListener('sg:unauthorized', () => {
  if (!state.authenticated) return;
  state.authenticated = false;
  scheduleEventRefresh(false);
  toast('登录已过期，请重新登录', 'error', 5200);
  renderGate();
  gateHint.textContent = '登录状态已过期（服务重启或超过 24 小时），请重新输入管理密码。';
});

/* ------------------------------ preview ------------------------------ */

function renderPreview() {
  previewFrame.replaceChildren();
  const url = fields.url.value.trim();
  if (!url) {
    previewFrame.appendChild(el('p', 'preview-empty', '尚未填写图片地址'));
    return;
  }
  const img = document.createElement('img');
  img.alt = '图片地址预览';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('load', () => {
    previewFrame.replaceChildren(img);
  });
  img.addEventListener('error', () => {
    previewFrame.replaceChildren(
      el('p', 'preview-empty', '浏览器无法直接预览该地址（可能禁止外链）。服务器仍会尝试下载，导入时以服务端结果为准。'),
    );
  });
  img.src = url;
  previewFrame.replaceChildren(el('p', 'preview-empty', '正在加载预览…'));
}

document.getElementById('previewBtn').addEventListener('click', renderPreview);
fields.url.addEventListener('change', renderPreview);

/* ------------------------------ form ------------------------------ */

function readForm() {
  return {
    url: fields.url.value.trim(),
    title: fields.title.value.trim(),
    prompt: fields.prompt.value.trim(),
    negativePrompt: fields.negativePrompt.value.trim(),
    model: fields.model.value.trim(),
    aspectRatio: fields.aspectRatio.value.trim(),
    seed: fields.seed.value.trim(),
    steps: fields.steps.value.trim(),
    guidance: fields.guidance.value.trim(),
    tags: fields.tags.value.trim(),
  };
}

function fillForm(image) {
  fields.url.value = image.sourceUrl || '';
  fields.title.value = image.title || '';
  fields.prompt.value = image.prompt || '';
  fields.negativePrompt.value = image.negativePrompt || '';
  fields.model.value = image.model || '';
  fields.aspectRatio.value = image.aspectRatio || '';
  fields.seed.value = image.seed || '';
  fields.steps.value = image.steps || '';
  fields.guidance.value = image.guidance || '';
  fields.tags.value = (image.tags || []).join(', ');
}

function clearForm() {
  for (const input of Object.values(fields)) input.value = '';
  formBanner.hidden = true;
  renderPreview();
}

function enterEditMode(image) {
  state.editingId = image.id;
  fillForm(image);
  formTitle.textContent = `编辑《${image.title}》`;
  submitBtn.textContent = '保存修改';
  cancelEditBtn.hidden = false;
  renderConsole();
  formBanner.hidden = false;
  formBanner.className = 'banner warn';
  formBanner.textContent = '编辑模式下只能修改提示词与生成参数，图片地址保持原样。';
  window.scrollTo({ top: 0, behavior: 'smooth' });
  fields.title.focus();
}

function exitEditMode() {
  state.editingId = null;
  formTitle.textContent = '导入新图片';
  submitBtn.textContent = '下载并导入';
  cancelEditBtn.hidden = true;
  formBanner.hidden = true;
  clearForm();
  renderConsole();
}

cancelEditBtn.addEventListener('click', exitEditMode);
document.getElementById('resetBtn').addEventListener('click', () => {
  if (state.editingId) {
    exitEditMode();
    return;
  }
  clearForm();
  toast('表单已清空');
});

document.getElementById('imageForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = readForm();
  const editing = state.editingId;

  if (!editing && !payload.url) {
    toast('请填写图片地址', 'error');
    return;
  }
  if (!payload.title) {
    toast('请填写标题', 'error');
    return;
  }
  if (!payload.prompt) {
    toast('请填写正向提示词', 'error');
    return;
  }

  const original = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.replaceChildren(el('span', 'spinner'), el('span', null, editing ? '保存中…' : '下载中…'));

  try {
    if (editing) {
      await api(`/api/images/${encodeURIComponent(editing)}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      toast('修改已保存', 'ok');
      exitEditMode();
    } else {
      const result = await api('/api/images', { method: 'POST', body: JSON.stringify(payload) });
      toast(`《${result.image.title}》已导入`, 'ok');
      clearForm();
    }
    await loadImages();
  } catch (error) {
    toast(error.message, 'error', 5200);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = state.editingId ? '保存修改' : '下载并导入';
    if (!state.editingId && original === '保存修改') submitBtn.textContent = '下载并导入';
  }
});

/* ------------------------------ tabs ------------------------------ */

const adminTabs = document.getElementById('adminTabs');
const TAB_KEY = 'still-gallery:tab';

/**
 * 标签名**从 DOM 读**，不写死一份数组。写死的副本一旦和 HTML 走散，多出来的那个
 * 标签点下去就会被静默回落成「AI 生成」——表现正是「点了没反应」。之前加「生成
 * 记录」「运行日志」时踩的就是这个坑：按钮在页面上，JS 却不认识它。
 */
function tabNames() {
  return [...adminTabs.querySelectorAll('.tab')].map((tab) => tab.dataset.tab).filter(Boolean);
}

function setTab(name) {
  // 只认「既有按钮又有面板」的名字。标签在、面板不在的时候切过去会是一屏空白，
  // 和「点了没反应」是同一个观感。
  const names = tabNames().filter((tab) => document.getElementById(`panel-${tab}`));
  const wanted = names.includes(name) ? name : names[0] || 'generate';
  for (const tab of adminTabs.querySelectorAll('.tab')) {
    const active = tab.dataset.tab === wanted;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.tabIndex = active ? 0 : -1;
    const panel = document.getElementById(`panel-${tab.dataset.tab}`);
    if (panel) panel.hidden = !active;
  }
  // 窄屏上标签栏是横向滚动的，第 5 个往后的标签一开始在视野外。只改 scrollLeft，
  // 不用 scrollIntoView——那会连带把整页纵向拽回顶部。
  const activeTab = adminTabs.querySelector('.tab.active');
  if (activeTab) {
    const bar = adminTabs.getBoundingClientRect();
    const box = activeTab.getBoundingClientRect();
    if (box.left < bar.left) adminTabs.scrollLeft += box.left - bar.left - 8;
    else if (box.right > bar.right) adminTabs.scrollLeft += box.right - bar.right + 8;
  }
  // 面板切换了，但页面还停在下方（「AI 生成」那一屏很长）：短面板（运行日志、
  // 生成记录）切过来时内容全在视野上方，看着和没点一样。只在面板顶被滚出视野
  // 时才把页面拉回来，别抢用户自己的滚动位置。
  const panel = document.getElementById(`panel-${wanted}`);
  if (panel && !panel.hidden) {
    const box = panel.getBoundingClientRect();
    if (box.top < 0) window.scrollTo({ top: Math.max(0, window.scrollY + box.top - 12) });
  }
  // Metrics are a snapshot of a moving target, so refresh on entry rather than
  // showing whatever was on screen the last time the tab was open. Guarded on
  // auth: the remembered tab may be this one while the gate is still showing.
  if (wanted === 'metrics' && state.authenticated) void loadMetrics();
  if (wanted === 'events' && state.authenticated) void loadEvents({ immediate: true });
  if (wanted === 'recent' && state.authenticated) void loadRecent();
  if (wanted === 'vault' && state.authenticated) void loadVault();
  if (wanted === 'clipboard' && state.authenticated) void loadClipboard();
  // 运行日志是「持续变化」的面板：离开就停轮询，回来立刻补一次，别在后台空转。
  scheduleEventRefresh(wanted === 'events' && state.authenticated);
  try {
    window.localStorage.setItem(TAB_KEY, wanted);
  } catch {
    /* private mode — the choice just won't be remembered */
  }
}

function rememberedTab() {
  try {
    return window.localStorage.getItem(TAB_KEY) || 'generate';
  } catch {
    return 'generate';
  }
}

// 事件挂在 document 上而不是标签栏节点上：标签栏被整体重绘（或将来换成别的
// 容器）也不会把点击丢掉，一个 `[data-tab]` 就能命中。
document.addEventListener('click', (event) => {
  const tab = event.target.closest('#adminTabs .tab');
  if (tab) setTab(tab.dataset.tab);
});

// Arrow keys move between tabs, per the ARIA tabs pattern.
adminTabs.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
  const tabs = [...adminTabs.querySelectorAll('.tab')];
  const index = tabs.findIndex((tab) => tab.classList.contains('active'));
  if (index === -1) return;
  event.preventDefault();
  const step = event.key === 'ArrowRight' ? 1 : -1;
  const next = tabs[(index + step + tabs.length) % tabs.length];
  setTab(next.dataset.tab);
  next.focus();
});

/* ------------------------------ library ------------------------------ */

/** One short label describing where an image came from. */
function provenanceChip(provenance) {
  if (provenance.sessionId) return `日志 #${provenance.sessionId}`;
  if (provenance.source === 'AI 生成') {
    const mode = { text2image: '文生图', text2group: '文生组图', image2image: '图生图' }[provenance.mode];
    return provenance.groupIndex && provenance.groupTotal > 1
      ? `AI 生成 · ${mode || '组图'} ${provenance.groupIndex}/${provenance.groupTotal}`
      : `AI 生成 · ${mode || '单图'}`;
  }
  return provenance.source || '外部导入';
}

/** Collapse the many provenance shapes into the four buckets the filter offers. */
function sourceKind(image) {
  if (image.demo) return 'demo';
  const provenance = image.provenance || {};
  if (provenance.source === 'AI 生成') return 'ai';
  if (provenance.sessionId || provenance.source === 'whiteboard_agent.log') return 'log';
  return 'external';
}

const LIB_PAGE_SIZES = [12, 24, 48, 96];

const libEl = {
  search: document.getElementById('libSearch'),
  time: document.getElementById('libTime'),
  source: document.getElementById('libSource'),
  sort: document.getElementById('libSort'),
  pageSize: document.getElementById('libPageSize'),
  reset: document.getElementById('libResetBtn'),
  rangeRow: document.getElementById('libRangeRow'),
  from: document.getElementById('libFrom'),
  to: document.getElementById('libTo'),
  selectAll: document.getElementById('libSelectAll'),
  selCount: document.getElementById('libSelCount'),
  batchTags: document.getElementById('libBatchTags'),
  batchTag: document.getElementById('libBatchTagBtn'),
  batchExport: document.getElementById('libBatchExportBtn'),
  batchDelete: document.getElementById('libBatchDeleteBtn'),
  clearSel: document.getElementById('libClearSelBtn'),
  pager: document.getElementById('libPager'),
  tabCount: document.getElementById('tabLibraryCount'),
};

const libState = {
  keyword: '',
  time: 'all',
  from: '',
  to: '',
  source: 'all',
  sort: 'newest',
  pageSize: 24,
  page: 1,
  selected: new Set(),
};

/** Lower bound implied by the time filter, as a timestamp, or null for "no bound". */
function timeWindow() {
  if (libState.time === 'all') return null;
  if (libState.time === 'custom') {
    const from = libState.from ? new Date(`${libState.from}T00:00:00`) : null;
    const to = libState.to ? new Date(`${libState.to}T23:59:59.999`) : null;
    if (!from && !to) return null;
    return { from: from ? from.getTime() : null, to: to ? to.getTime() : null };
  }
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (libState.time !== 'today') {
    // "最近 7 天" means today plus the six days before it.
    start.setDate(start.getDate() - (Number(libState.time.replace('d', '')) - 1));
  }
  return { from: start.getTime(), to: null };
}

function activeFilterCount() {
  let count = 0;
  if (libState.keyword.trim()) count += 1;
  if (libState.time !== 'all') count += 1;
  if (libState.source !== 'all') count += 1;
  if (libState.sort !== 'newest') count += 1;
  return count;
}

function filteredImages() {
  const keyword = libState.keyword.trim().toLowerCase();
  const window_ = timeWindow();

  const list = state.images.filter((image) => {
    if (libState.source !== 'all' && sourceKind(image) !== libState.source) return false;
    if (window_) {
      const stamp = Date.parse(image.createdAt || '');
      if (Number.isNaN(stamp)) return false;
      if (window_.from !== null && stamp < window_.from) return false;
      if (window_.to !== null && stamp > window_.to) return false;
    }
    if (keyword) {
      const haystack = [
        image.title,
        image.prompt,
        image.negativePrompt,
        image.model,
        (image.tags || []).join(' '),
        (image.provenance && image.provenance.source) || '',
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  });

  if (libState.sort === 'title') {
    list.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN'));
  } else {
    const direction = libState.sort === 'oldest' ? 1 : -1;
    list.sort((a, b) => direction * String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  }
  return list;
}

/** The filtered set sliced down to the page currently being shown. */
function currentPage() {
  const all = filteredImages();
  const pages = Math.max(1, Math.ceil(all.length / libState.pageSize));
  const page = Math.min(Math.max(1, libState.page), pages);
  const start = (page - 1) * libState.pageSize;
  return { all, pages, page, visible: all.slice(start, start + libState.pageSize) };
}

/** Compact page list: first and last always, plus a window around the current page. */
function pageWindow(current, total, span = 1) {
  const pages = new Set([1, total]);
  for (let page = current - span; page <= current + span; page += 1) {
    if (page >= 1 && page <= total) pages.add(page);
  }
  const out = [];
  let previous = 0;
  for (const page of [...pages].sort((a, b) => a - b)) {
    if (previous && page - previous > 1) out.push('…');
    out.push(page);
    previous = page;
  }
  return out;
}

function libraryCard(image) {
  const item = el('div', 'managed-item');
  const picked = libState.selected.has(image.id);
  if (picked) item.classList.add('picked');

  const pick = el('label', 'managed-pick');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = picked;
  box.setAttribute('aria-label', `选择《${image.title}》`);
  box.addEventListener('change', () => {
    if (box.checked) libState.selected.add(image.id);
    else libState.selected.delete(image.id);
    item.classList.toggle('picked', box.checked);
    syncBulkBar();
  });
  pick.appendChild(box);
  item.appendChild(pick);

  const thumb = document.createElement('img');
  thumb.src = image.imageUrl;
  thumb.alt = image.title;
  thumb.loading = 'lazy';
  item.appendChild(thumb);

  const info = el('div', 'managed-info');
  info.appendChild(el('strong', null, image.title));
  info.appendChild(el('p', null, image.prompt));
  const meta = el('div', 'card-meta');
  meta.appendChild(el('span', 'chip', formatDate(image.createdAt)));
  if (image.bytes) meta.appendChild(el('span', 'chip', formatBytes(image.bytes)));
  if (image.model) meta.appendChild(el('span', 'chip', image.model));
  if (image.provenance) meta.appendChild(el('span', 'chip', provenanceChip(image.provenance)));
  if (image.demo) meta.appendChild(el('span', 'chip', '示例'));
  info.appendChild(meta);

  // Tags are the one piece of metadata the batch actions change, so they need to
  // be visible here — otherwise "batch add tags" has no observable result.
  const tags = Array.isArray(image.tags) ? image.tags : [];
  if (tags.length) {
    const row = el('div', 'managed-tags');
    for (const tag of tags.slice(0, 3)) row.appendChild(el('span', 'tag-mini', tag));
    if (tags.length > 3) row.appendChild(el('span', 'tag-mini more', `+${tags.length - 3}`));
    info.appendChild(row);
  }

  item.appendChild(info);

  const actions = el('div', 'managed-actions');
  const editBtn = el('button', 'btn btn-sm', '编辑');
  editBtn.type = 'button';
  editBtn.addEventListener('click', () => {
    // The edit form lives in the import tab; go there so the change is visible.
    setTab('import');
    enterEditMode(image);
  });

  const delBtn = el('button', 'btn btn-sm btn-danger', '删除');
  delBtn.type = 'button';
  delBtn.addEventListener('click', async () => {
    if (!window.confirm(`确定删除《${image.title}》吗？该操作不可撤销。`)) return;
    delBtn.disabled = true;
    try {
      await api(`/api/images/${encodeURIComponent(image.id)}`, { method: 'DELETE' });
      libState.selected.delete(image.id);
      toast('已删除', 'ok');
      if (state.editingId === image.id) exitEditMode();
      await loadImages();
    } catch (error) {
      toast(error.message, 'error');
      delBtn.disabled = false;
    }
  });

  actions.appendChild(editBtn);
  actions.appendChild(delBtn);
  item.appendChild(actions);
  return item;
}

/** Keeps the bulk bar, the select-all box and the count badge in step with state. */
function syncBulkBar(visible = currentPage().visible) {
  const total = libState.selected.size;
  libEl.selCount.textContent = total ? `已选 ${total} 张` : '已选 0 张';
  for (const button of [libEl.batchTag, libEl.batchExport, libEl.batchDelete, libEl.clearSel]) {
    button.disabled = total === 0;
  }
  libEl.batchTags.disabled = total === 0;

  const picked = visible.filter((image) => libState.selected.has(image.id)).length;
  libEl.selectAll.checked = visible.length > 0 && picked === visible.length;
  libEl.selectAll.indeterminate = picked > 0 && picked < visible.length;
  libEl.selectAll.disabled = visible.length === 0;
}

function renderPager(pages, total) {
  libEl.pager.replaceChildren();
  if (!total) return;

  const makeButton = (label, page, { disabled = false, active = false } = {}) => {
    const button = el('button', `btn btn-sm pager-btn${active ? ' active' : ''}`, label);
    button.type = 'button';
    button.disabled = disabled;
    if (active) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => {
      libState.page = page;
      renderLibrary();
      managedList.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    return button;
  };

  libEl.pager.appendChild(makeButton('上一页', libState.page - 1, { disabled: libState.page <= 1 }));
  for (const entry of pageWindow(libState.page, pages)) {
    if (entry === '…') {
      libEl.pager.appendChild(el('span', 'pager-info', '…'));
      continue;
    }
    libEl.pager.appendChild(makeButton(String(entry), entry, { active: entry === libState.page }));
  }
  libEl.pager.appendChild(makeButton('下一页', libState.page + 1, { disabled: libState.page >= pages }));
  libEl.pager.appendChild(el('span', 'pager-info', `共 ${total} 张 · ${pages} 页`));
}

function renderLibrary() {
  const { all, pages, visible } = currentPage();
  libState.page = Math.min(libState.page, pages);

  libEl.tabCount.textContent = String(state.images.length);
  const filters = activeFilterCount();
  managedCount.textContent = filters
    ? `共 ${state.images.length} 张，筛选后 ${all.length} 张 · 第 ${libState.page}/${pages} 页`
    : `共 ${state.images.length} 张 · 第 ${libState.page}/${pages} 页`;

  managedList.replaceChildren();
  if (!all.length) {
    managedList.appendChild(
      el(
        'p',
        'preview-empty',
        state.images.length
          ? '没有符合当前筛选条件的作品，试试放宽条件或重置筛选。'
          : '还没有任何作品，先到「AI 生成」或「导入图片」添加一张吧。',
      ),
    );
  } else {
    for (const image of visible) managedList.appendChild(libraryCard(image));
  }

  renderPager(pages, all.length);
  syncBulkBar(visible);
}

async function loadImages() {
  try {
    const data = await api('/api/images');
    state.images = Array.isArray(data.images) ? data.images : [];
    // Drop selections whose records no longer exist.
    const live = new Set(state.images.map((image) => image.id));
    for (const id of [...libState.selected]) if (!live.has(id)) libState.selected.delete(id);
    renderLibrary();
  } catch (error) {
    toast(`列表加载失败：${error.message}`, 'error');
  }
}

/* ------------------------- library filters ------------------------- */

function resetLibraryFilters() {
  libState.keyword = '';
  libState.time = 'all';
  libState.from = '';
  libState.to = '';
  libState.source = 'all';
  libState.sort = 'newest';
  libState.pageSize = 24;
  libEl.search.value = '';
  libEl.time.value = 'all';
  libEl.source.value = 'all';
  libEl.sort.value = 'newest';
  libEl.pageSize.value = '24';
  libEl.from.value = '';
  libEl.to.value = '';
  libEl.rangeRow.hidden = true;
  libState.page = 1;
  renderLibrary();
}

/** Any filter change rewinds to page 1 — staying on page 7 of a 2-page result is a trap. */
function applyFilter(mutate) {
  return () => {
    mutate();
    libState.page = 1;
    renderLibrary();
  };
}

let searchDebounce = 0;
libEl.search.addEventListener('input', () => {
  window.clearTimeout(searchDebounce);
  searchDebounce = window.setTimeout(
    applyFilter(() => {
      libState.keyword = libEl.search.value;
    }),
    160,
  );
});

libEl.time.addEventListener(
  'change',
  applyFilter(() => {
    libState.time = libEl.time.value;
    libEl.rangeRow.hidden = libState.time !== 'custom';
  }),
);

libEl.from.addEventListener(
  'change',
  applyFilter(() => {
    libState.from = libEl.from.value;
  }),
);

libEl.to.addEventListener(
  'change',
  applyFilter(() => {
    libState.to = libEl.to.value;
  }),
);

libEl.source.addEventListener(
  'change',
  applyFilter(() => {
    libState.source = libEl.source.value;
  }),
);

libEl.sort.addEventListener(
  'change',
  applyFilter(() => {
    libState.sort = libEl.sort.value;
  }),
);

libEl.pageSize.addEventListener(
  'change',
  applyFilter(() => {
    libState.pageSize = Number(libEl.pageSize.value) || 24;
  }),
);

libEl.reset.addEventListener('click', () => {
  resetLibraryFilters();
  toast('筛选已重置');
});

libEl.selectAll.addEventListener('change', () => {
  const { visible } = currentPage();
  if (libEl.selectAll.checked) for (const image of visible) libState.selected.add(image.id);
  else for (const image of visible) libState.selected.delete(image.id);
  renderLibrary();
});

libEl.clearSel.addEventListener('click', () => {
  libState.selected.clear();
  renderLibrary();
});

/* -------------------------- library batch ops -------------------------- */

/** Shared tail for every bulk action: POST, adopt the returned list, re-render. */
async function runBatch(action, extra, { confirmText, successText }) {
  const ids = [...libState.selected];
  if (!ids.length) return;
  if (confirmText && !window.confirm(confirmText)) return;

  const buttons = [libEl.batchTag, libEl.batchExport, libEl.batchDelete];
  for (const button of buttons) button.disabled = true;
  try {
    const result = await api('/api/images/batch', {
      method: 'POST',
      body: JSON.stringify({ action, ids, ...extra }),
    });
    state.images = Array.isArray(result.images) ? result.images : state.images;
    if (action === 'delete') libState.selected.clear();
    if (state.editingId && !state.images.some((image) => image.id === state.editingId)) exitEditMode();
    renderLibrary();
    const note = result.truncated ? `，其中 ${result.truncated} 张已达 12 个标签上限` : '';
    toast(`${successText}：${result.affected} 张${note}`, 'ok');
  } catch (error) {
    toast(error.message, 'error');
    syncBulkBar();
  }
}

libEl.batchTag.addEventListener('click', async () => {
  const tags = libEl.batchTags.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
  if (!tags.length) {
    toast('请先填写要添加的标签', 'error');
    libEl.batchTags.focus();
    return;
  }
  await runBatch('tag', { tags }, { successText: '已批量加标签' });
  libEl.batchTags.value = '';
});

libEl.batchDelete.addEventListener('click', async () => {
  const count = libState.selected.size;
  await runBatch('delete', {}, {
    confirmText: `确定删除选中的 ${count} 张作品吗？图片文件会一并删除，该操作不可撤销。`,
    successText: '已批量删除',
  });
});

libEl.batchExport.addEventListener('click', () => {
  const picked = state.images.filter((image) => libState.selected.has(image.id));
  if (!picked.length) return;
  downloadJson(
    { version: 1, exportedAt: new Date().toISOString(), images: picked },
    `still-gallery-selection-${new Date().toISOString().slice(0, 10)}.json`,
  );
  toast(`已导出 ${picked.length} 张`, 'ok');
});


/* ------------------------------ log import ------------------------------ */

const LOG_MAX_BYTES = 16 * 1024 * 1024;
const IMPORT_BATCH = 4;

const logDrop = document.getElementById('logDrop');
const logFileInput = document.getElementById('logFile');
const logDropTitle = document.getElementById('logDropTitle');
const logDropHint = document.getElementById('logDropHint');
const logTagField = document.getElementById('logTagField');
const logTags = document.getElementById('logTags');
const logActions = document.getElementById('logActions');
const logParseBtn = document.getElementById('logParseBtn');
const logClearBtn = document.getElementById('logClearBtn');
const logPreview = document.getElementById('logPreview');
const logStats = document.getElementById('logStats');
const logWarnings = document.getElementById('logWarnings');
const logPlanList = document.getElementById('logPlanList');
const logPlanLabel = document.getElementById('logPlanLabel');
const logImportBtn = document.getElementById('logImportBtn');
const logProgress = document.getElementById('logProgress');
const logReport = document.getElementById('logReport');

const logState = { fileName: '', text: '', parsed: null, selected: new Set(), busy: false };

function logTagList() {
  return logTags.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
}

function resetLogPanel() {
  logState.fileName = '';
  logState.text = '';
  logState.parsed = null;
  logState.selected = new Set();
  logFileInput.value = '';
  logDrop.classList.remove('has-file');
  logDropTitle.textContent = '点击选择日志文件，或拖拽到此处';
  logDropHint.textContent = '支持 .log / .txt，单文件不超过 16MB';
  logActions.hidden = true;
  logTagField.hidden = true;
  logPreview.hidden = true;
  logReport.replaceChildren();
  logProgress.textContent = '';
}

async function acceptLogFile(file) {
  if (!file) return;
  if (file.size > LOG_MAX_BYTES) {
    toast(`文件超过 ${Math.round(LOG_MAX_BYTES / 1024 / 1024)}MB 上限`, 'error');
    return;
  }
  let text;
  try {
    text = await file.text();
  } catch {
    toast('读取文件失败', 'error');
    return;
  }
  if (!text.trim()) {
    toast('文件内容为空', 'error');
    return;
  }
  logState.fileName = file.name;
  logState.text = text;
  logState.parsed = null;
  logState.selected = new Set();
  logDrop.classList.add('has-file');
  logDropTitle.textContent = file.name;
  logDropHint.textContent = `${(file.size / 1024).toFixed(0)} KB · 点击可重新选择`;
  logActions.hidden = false;
  logTagField.hidden = false;
  logPreview.hidden = true;
  logReport.replaceChildren();
  logProgress.textContent = '';
  toast(`已载入 ${file.name}，点击「解析日志」查看结果`);
}

logDrop.addEventListener('click', () => logFileInput.click());
logDrop.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    logFileInput.click();
  }
});
logFileInput.addEventListener('change', () => acceptLogFile(logFileInput.files[0]));

for (const type of ['dragenter', 'dragover']) {
  logDrop.addEventListener(type, (event) => {
    event.preventDefault();
    logDrop.classList.add('dragover');
  });
}
for (const type of ['dragleave', 'drop']) {
  logDrop.addEventListener(type, (event) => {
    event.preventDefault();
    logDrop.classList.remove('dragover');
  });
}
logDrop.addEventListener('drop', (event) => {
  const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  acceptLogFile(file);
});

logClearBtn.addEventListener('click', resetLogPanel);

function renderLogPlan() {
  const data = logState.parsed;
  logPlanList.replaceChildren();

  if (!data) return;

  const importable = data.plan.filter((item) => !item.alreadyImported && !item.urlExpired);
  logPlanLabel.textContent = `解析结果 · 可导入 ${importable.length} / 共 ${data.plan.length} 条`;

  if (!data.plan.length) {
    logPlanList.appendChild(el('p', 'preview-empty', '没有解析到可导入的生成记录。'));
  }

  for (const item of data.plan) {
    const disabled = item.alreadyImported || item.urlExpired;
    const row = el('div', `plan-item${disabled ? ' muted' : ''}`);

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = logState.selected.has(item.index);
    box.disabled = disabled || logState.busy;
    box.setAttribute('aria-label', `选择第 ${item.index} 条`);
    box.addEventListener('change', () => {
      if (box.checked) logState.selected.add(item.index);
      else logState.selected.delete(item.index);
      renderLogPlan();
    });
    row.appendChild(box);
    row.appendChild(el('span', 'plan-index', `#${item.index}`));

    const body = el('div', 'plan-body');
    body.appendChild(el('p', 'plan-title', item.title || '（无标题）'));
    body.appendChild(el('p', 'plan-prompt', item.promptPreview || '（无提示词）'));

    const meta = el('div', 'plan-meta');
    meta.appendChild(el('span', 'chip', item.mode === 'image2image' ? '图生图' : '文生图'));
    if (item.imageModel) meta.appendChild(el('span', 'chip', item.imageModel));
    if (item.size) meta.appendChild(el('span', 'chip', item.size));
    if (item.latencySeconds !== null && item.latencySeconds !== undefined) {
      meta.appendChild(el('span', 'chip', `${item.latencySeconds.toFixed(1)}s`));
    }
    if (item.promptLength) meta.appendChild(el('span', 'chip', `提示词 ${item.promptLength} 字`));
    if (item.promptTruncated) meta.appendChild(el('span', 'chip', '提示词被日志截断'));
    if (item.urlExpiresAt) {
      const expires = new Date(item.urlExpiresAt);
      meta.appendChild(
        el('span', `chip ${item.urlExpired ? 'danger' : ''}`, `链接有效期至 ${expires.toLocaleString('zh-CN')}`),
      );
    }
    if (item.alreadyImported) meta.appendChild(el('span', 'chip ok', '已在库中'));
    else if (item.urlExpired) meta.appendChild(el('span', 'chip danger', '链接已过期'));
    body.appendChild(meta);

    row.appendChild(body);
    logPlanList.appendChild(row);
  }
}

logParseBtn.addEventListener('click', async () => {
  if (!logState.text) return;
  logParseBtn.disabled = true;
  logParseBtn.replaceChildren(el('span', 'spinner'), el('span', null, '解析中…'));
  try {
    const data = await api('/api/logs/parse', {
      method: 'POST',
      body: JSON.stringify({ fileName: logState.fileName, logText: logState.text, tags: logTagList() }),
    });
    logState.parsed = data;
    logState.selected = new Set(
      data.plan.filter((item) => !item.alreadyImported && !item.urlExpired).map((item) => item.index),
    );

    const { stats } = data;
    logStats.textContent =
      `识别到 ${stats.total} 个生成会话：${stats.withImage} 个产出图片（文生图 ${stats.text2image} / 图生图 ${stats.image2image}），` +
      `${stats.withoutImage} 个仅文字回复（无法导入）。`;

    if (data.warnings && data.warnings.length) {
      logWarnings.hidden = false;
      logWarnings.textContent = `注意：${data.warnings.join('；')}`;
    } else {
      logWarnings.hidden = true;
    }

    logPreview.hidden = false;
    logReport.replaceChildren();
    logProgress.textContent = '';
    renderLogPlan();
    toast(`解析完成，可导入 ${logState.selected.size} 条`, 'ok');
  } catch (error) {
    toast(error.message, 'error', 5000);
  } finally {
    logParseBtn.disabled = false;
    logParseBtn.textContent = '重新解析';
  }
});

document.getElementById('logSelectAllBtn').addEventListener('click', () => {
  if (!logState.parsed) return;
  logState.selected = new Set(
    logState.parsed.plan.filter((item) => !item.alreadyImported && !item.urlExpired).map((item) => item.index),
  );
  renderLogPlan();
});

document.getElementById('logSelectNoneBtn').addEventListener('click', () => {
  logState.selected = new Set();
  renderLogPlan();
});

function renderLogReport({ imported, failed, skipped }) {
  logReport.replaceChildren();
  const wrap = el('div', 'report-list');
  for (const item of imported) {
    wrap.appendChild(el('div', 'report-row ok', `#${item.index} ${item.title} → ${item.imageUrl}`));
  }
  for (const item of failed) {
    wrap.appendChild(el('div', 'report-row fail', `#${item.index} ${item.title}：${item.reason}`));
  }
  for (const item of skipped) {
    wrap.appendChild(el('div', 'report-row skip', `#${item.index} ${item.title}：${item.reason}`));
  }
  logReport.appendChild(wrap);
}

logImportBtn.addEventListener('click', async () => {
  if (logState.busy) return;
  const indexes = [...logState.selected].sort((a, b) => a - b);
  if (!indexes.length) {
    toast('请先勾选要导入的条目', 'error');
    return;
  }

  logState.busy = true;
  logImportBtn.disabled = true;
  const collected = { imported: [], failed: [], skipped: [] };

  try {
    for (let start = 0; start < indexes.length; start += IMPORT_BATCH) {
      const batch = indexes.slice(start, start + IMPORT_BATCH);
      logProgress.textContent = `正在导入 ${start + 1}–${Math.min(start + IMPORT_BATCH, indexes.length)} / ${indexes.length} …`;
      const result = await api('/api/logs/import', {
        method: 'POST',
        body: JSON.stringify({
          fileName: logState.fileName,
          logText: logState.text,
          tags: logTagList(),
          sessionIndexes: batch,
        }),
      });
      collected.imported.push(...result.imported);
      collected.failed.push(...result.failed);
      collected.skipped.push(...result.skipped);
      renderLogReport(collected);
    }

    logProgress.textContent = `完成：成功 ${collected.imported.length}，失败 ${collected.failed.length}，跳过 ${collected.skipped.length}`;
    toast(`导入完成，新增 ${collected.imported.length} 张`, collected.failed.length ? 'info' : 'ok', 4000);

    await loadImages();
    // Refresh the plan so freshly imported rows flip to "已在库中".
    logState.parsed = await api('/api/logs/parse', {
      method: 'POST',
      body: JSON.stringify({ fileName: logState.fileName, logText: logState.text, tags: logTagList() }),
    });
    logState.selected = new Set();
    renderLogPlan();
  } catch (error) {
    toast(error.message, 'error', 5200);
  } finally {
    logState.busy = false;
    logImportBtn.disabled = false;
    renderLogPlan();
  }
});

/* ------------------------------ AI generation ------------------------------ */

const GEN_MODES = {
  text2image: {
    label: '文生图',
    note: '只给文字提示词，生成一张图片。适合构图明确、一次成型的画面。',
    references: false,
    group: false,
  },
  text2group: {
    label: '文生组图',
    note: '只给文字提示词，一次生成一组内容关联的图片（最多 15 张）。适合分镜、系列稿、多方案对比。',
    references: false,
    group: true,
  },
  image2image: {
    label: '图生图',
    note: '给出 1–14 张参考图，在此基础上改写画面。可勾选「同时生成组图」一次拿到多个变体。',
    references: true,
    group: false,
  },
};

const REF_LIMIT_FALLBACK = 14;
const REF_FILE_MAX_BYTES = 6 * 1024 * 1024;
const REF_TOTAL_WARN_BYTES = 36 * 1024 * 1024;
const GROUP_CEILING_FALLBACK = 15;
/** Mirrors DEFAULT_CAPABILITIES for an uncatalogued model id — the permissive union. */
const SIZE_SUGGESTIONS_FALLBACK = [
  '1K',
  '2K',
  '3K',
  '4K',
  '1024x1024',
  '1536x1024',
  '1024x1536',
  '2048x2048',
  '2304x1728',
  '1728x2304',
];

const genEl = {
  tabs: document.getElementById('genTabs'),
  modeNote: document.getElementById('genModeNote'),
  modelNote: document.getElementById('genModelNote'),
  form: document.getElementById('genForm'),
  keyBanner: document.getElementById('genKeyBanner'),
  banner: document.getElementById('genBanner'),
  refField: document.getElementById('genRefField'),
  refList: document.getElementById('genRefList'),
  refAddBtn: document.getElementById('genRefAddBtn'),
  refUploadBtn: document.getElementById('genRefUploadBtn'),
  refFile: document.getElementById('genRefFile'),
  refClearBtn: document.getElementById('genRefClearBtn'),
  refCount: document.getElementById('genRefCount'),
  refHint: document.getElementById('genRefHint'),
  prompt: document.getElementById('genPrompt'),
  promptPasteBtn: document.getElementById('genPromptPasteBtn'),
  promptClearBtn: document.getElementById('genPromptClearBtn'),
  promptHistory: document.getElementById('promptHistory'),
  promptHistoryList: document.getElementById('promptHistoryList'),
  promptHistoryCount: document.getElementById('promptHistoryCount'),
  promptHistoryClear: document.getElementById('promptHistoryClear'),
  promptHistoryEmpty: document.getElementById('promptHistoryEmpty'),
  model: document.getElementById('genModel'),
  modelList: document.getElementById('genModelList'),
  modelToggle: document.getElementById('genModelToggle'),
  modelMenu: document.getElementById('genModelMenu'),
  size: document.getElementById('genSize'),
  sizeList: document.getElementById('genSizeList'),
  sizeToggle: document.getElementById('genSizeToggle'),
  sizeMenu: document.getElementById('genSizeMenu'),
  countField: document.getElementById('genCountField'),
  maxImages: document.getElementById('genMaxImages'),
  optimize: document.getElementById('genOptimize'),
  outputFormat: document.getElementById('genOutputFormat'),
  background: document.getElementById('genBackground'),
  watermark: document.getElementById('genWatermark'),
  groupWrap: document.getElementById('genGroupSwitchWrap'),
  group: document.getElementById('genGroup'),
  watermarkWrap: document.getElementById('genWatermarkWrap'),
  optionsField: document.getElementById('genOptionsField'),
  metaRow: document.getElementById('genMetaRow'),
  promptCount: document.getElementById('genPromptCount'),
  promptMarkBtn: document.getElementById('genPromptMarkBtn'),
  markOverlay: document.getElementById('genMarkOverlay'),
  markStage: document.getElementById('genMarkStage'),
  markImage: document.getElementById('genMarkImage'),
  markLayer: document.getElementById('genMarkLayer'),
  markHint: document.getElementById('genMarkHint'),
  markCloseBtn: document.getElementById('genMarkCloseBtn'),
  webSearch: document.getElementById('genWebSearch'),
  webSearchWrap: document.getElementById('genWebSearchWrap'),
  tags: document.getElementById('genTags'),
  submitBtn: document.getElementById('genSubmitBtn'),
  defaultChip: document.getElementById('genDefaultChip'),
  setDefaultBtn: document.getElementById('genSetDefaultBtn'),
  progress: document.getElementById('genProgress'),
  results: document.getElementById('genResults'),
  resultLabel: document.getElementById('genResultLabel'),
  grid: document.getElementById('genGrid'),
  report: document.getElementById('genReport'),
  importAllBtn: document.getElementById('genImportAllBtn'),
  clearResultsBtn: document.getElementById('genClearResultsBtn'),
  queuePanel: document.getElementById('genQueue'),
  queueCounts: document.getElementById('queueCounts'),
  queuePauseBtn: document.getElementById('queuePauseBtn'),
  queueClearBtn: document.getElementById('queueClearBtn'),
  queueRefreshBtn: document.getElementById('queueRefreshBtn'),
  queueConcurrency: document.getElementById('queueConcurrency'),
  queueConcurrencySave: document.getElementById('queueConcurrencySave'),
  queueConcurrencyHint: document.getElementById('queueConcurrencyHint'),
  queueList: document.getElementById('queueList'),
  settings: document.getElementById('genSettings'),
  configForm: document.getElementById('genConfigForm'),
  configBanner: document.getElementById('genConfigBanner'),
  apiKey: document.getElementById('genApiKey'),
  apiKeyHint: document.getElementById('genApiKeyHint'),
  baseUrl: document.getElementById('genBaseUrl'),
  defaultModel: document.getElementById('genDefaultModel'),
  configSaveBtn: document.getElementById('genConfigSaveBtn'),
  configClearBtn: document.getElementById('genConfigClearBtn'),
  relayToken: document.getElementById('genRelayToken'),
  relayTokenHint: document.getElementById('genRelayTokenHint'),
  relayBaseUrl: document.getElementById('genRelayBaseUrl'),
  relayLocalHint: document.getElementById('genRelayLocalHint'),
  relayClearBtn: document.getElementById('genRelayClearBtn'),
  providerTabs: document.getElementById('genProviderTabs'),
  providerNote: document.getElementById('genProviderNote'),
  modelField: document.getElementById('genModelField'),
  sizeField: document.getElementById('genSizeField'),
  aspectField: document.getElementById('genAspectField'),
  aspect: document.getElementById('genAspect'),
  aspectToggle: document.getElementById('genAspectToggle'),
  aspectMenu: document.getElementById('genAspectMenu'),
  aspectList: document.getElementById('genAspectList'),
  aspectHint: document.getElementById('genAspectHint'),
  advancedRow: document.getElementById('genAdvancedRow'),
  defaultRow: document.getElementById('genDefaultRow'),
  relayParams: document.getElementById('genRelayParams'),
  relayModel: document.getElementById('genRelayModel'),
  relayAspects: document.getElementById('genRelayAspects'),
  relayPrompt: document.getElementById('genRelayPrompt'),
  relayRefs: document.getElementById('genRelayRefs'),
};

const genState = {
  mode: 'text2image',
  /** 'ark' | 'relay'，以服务端 settings 为准（切换要落盘，不是纯前端状态）。 */
  provider: 'ark',
  config: null,
  refs: [],
  results: [],
  request: null,
  /** The prompt that produced the current results, frozen at request time. */
  prompt: '',
  generatedAt: '',
  busy: false,
  /**
   * 已提交、还没出结果的队列任务：`jobId → { prompt }`。
   * 提交后按钮立刻解锁（要能连续入队），所以完成事件只能从队列轮询里取，
   * 这里记下「哪些是我提交的」，以及用来生成标题的提示词。
   * @type {Map<string, {prompt: string}>}
   */
  watching: new Map(),
};

/**
 * Limits for the model currently typed in the field. The catalogue comes from the
 * server, so the rules live in exactly one place (lib/image-gen.mjs). A model that
 * is not in the catalogue — a custom gateway, or something released later — gets
 * the permissive general limits; the server still validates authoritatively on
 * submit, so a mismatch here can never produce a bad request.
 */
function currentCapabilities() {
  const catalog = (genState.config && genState.config.modelCatalog) || [];
  const id = genEl.model.value.trim();
  const entry = catalog.find((item) => item.id === id);
  if (entry) return entry;
  return {
    id,
    label: '',
    maxReferences: REF_LIMIT_FALLBACK,
    groupCeiling: GROUP_CEILING_FALLBACK,
    supportsGroup: true,
    supportsWebSearch: false,
    sizeSuggestions: SIZE_SUGGESTIONS_FALLBACK,
    note: id ? '未收录的模型 ID，按通用上限处理（参考图 14 张、组图 15 张）；实际限制以接口返回为准。' : '',
  };
}

function isRelay() {
  return genState.provider === 'relay';
}

function refLimit() {
  // 网关的 `image` 是单值字段，不是数组：一次只能带一张参考图。
  if (isRelay()) return 1;
  return currentCapabilities().maxReferences;
}

function genGroupEnabled() {
  if (genState.mode === 'text2group') return true;
  if (genState.mode === 'image2image') return genEl.group.checked;
  return false;
}

/** Reference images plus generated images may not exceed the family ceiling. */
function genGroupCeiling() {
  const caps = currentCapabilities();
  return Math.max(1, caps.groupCeiling - genState.refs.length);
}

function genMaxImagesValue() {
  const ceiling = genGroupCeiling();
  const parsed = Number.parseInt(genEl.maxImages.value, 10);
  if (!Number.isFinite(parsed)) return Math.min(4, ceiling);
  return Math.min(Math.max(parsed, 1), ceiling);
}

/** Reflect the selected model's documented limits in the form. */
/**
 * Rebuild the size datalist for the selected model. The options are per family:
 * `4K` is offered on Seedream 4.0 / 4.5 / 5.0 lite and must never be offered on
 * Seedream 5.0 pro, which answers it with an opaque `InvalidParameter` 400.
 */
function syncSizeSuggestions(caps) {
  const options = caps.sizeSuggestions || SIZE_SUGGESTIONS_FALLBACK;
  genEl.sizeList.replaceChildren();
  for (const size of options) {
    const option = document.createElement('option');
    option.value = size;
    genEl.sizeList.appendChild(option);
  }
  genEl.size.placeholder = options[0] || '2K';

  // A preset chosen for the previous model may be illegal for this one (4K is
  // the common case). Clear only presets: an explicit WxH may still be legal
  // even when it is not one of our suggestions, so let the server judge that.
  const typed = genEl.size.value.trim().toUpperCase();
  const presets = caps.sizePresets || [];
  if (/^(1K|2K|3K|4K)$/.test(typed) && !options.includes(typed)) {
    genEl.size.value = '';
    toast(`当前模型不支持 ${typed} 尺寸，已清空；可选 ${presets.join(' / ')}`, 'info', 5000);
  }
}

function syncModelCapabilities() {
  const caps = currentCapabilities();
  renderDefaultChip();
  genEl.modelNote.textContent = caps.note || '';
  genEl.modelNote.hidden = !caps.note;
  syncSizeSuggestions(caps);

  genEl.group.disabled = !caps.supportsGroup;
  genEl.groupWrap.title = caps.supportsGroup ? '' : `${caps.id || '该模型'} 不支持组图生成`;
  for (const tab of genEl.tabs.querySelectorAll('.mode-tab')) {
    if (tab.dataset.mode !== 'text2group') continue;
    tab.disabled = !caps.supportsGroup;
    tab.title = caps.supportsGroup ? '' : `${caps.id || '该模型'} 不支持组图生成`;
  }
  if (!caps.supportsGroup) {
    genEl.group.checked = false;
    // 文生组图 is entirely unavailable for this family, so fall back to 文生图.
    if (genState.mode === 'text2group') {
      genState.mode = 'text2image';
      for (const tab of genEl.tabs.querySelectorAll('.mode-tab')) {
        const active = tab.dataset.mode === 'text2image';
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
      }
      genEl.modeNote.textContent = GEN_MODES.text2image.note;
      genEl.refField.hidden = true;
      genEl.groupWrap.hidden = true;
    }
  }

  genEl.webSearch.disabled = !caps.supportsWebSearch;
  genEl.webSearchWrap.title = caps.supportsWebSearch ? '' : '只有 Seedream 5.0 lite 支持联网搜索';
  if (!caps.supportsWebSearch) genEl.webSearch.checked = false;

  // 手册：fast 仅 5.0 pro；透明背景仅 5.0 pro / flash。选项置灰而不是隐藏——
  // 下拉里留一个说明，比让用户以为「这个功能不存在」更好。
  const fastOption = genEl.optimize.querySelector('option[value="fast"]');
  if (fastOption) {
    fastOption.disabled = !caps.supportsFastMode;
    fastOption.textContent = caps.supportsFastMode ? 'fast' : 'fast（当前模型不支持）';
  }
  if (!caps.supportsFastMode && genEl.optimize.value === 'fast') genEl.optimize.value = 'standard';

  const alphaOption = genEl.background.querySelector('option[value="transparent"]');
  if (alphaOption) {
    alphaOption.disabled = !caps.supportsTransparentBackground;
    alphaOption.textContent = caps.supportsTransparentBackground ? '透明' : '透明（当前模型不支持）';
  }
  if (!caps.supportsTransparentBackground && genEl.background.value === 'transparent') {
    genEl.background.value = '';
  }

  // Trim any reference rows that now exceed the model's limit.
  if (genState.refs.length > caps.maxReferences) {
    for (const ref of genState.refs.splice(caps.maxReferences)) revokePreview(ref);
    toast(`该模型最多 ${caps.maxReferences} 张参考图片，超出的已移除`, 'info', 4000);
  }

  syncCountField();
  renderRefs();
}

function setMode(mode) {
  if (!GEN_MODES[mode]) return;
  if (mode === 'text2group' && !currentCapabilities().supportsGroup) {
    toast(`${genEl.model.value.trim() || '当前模型'} 不支持组图生成`, 'error', 4000);
    return;
  }
  genState.mode = mode;
  for (const tab of genEl.tabs.querySelectorAll('.mode-tab')) {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  const config = GEN_MODES[mode];
  genEl.modeNote.textContent = config.note;
  genEl.refField.hidden = !config.references;
  genEl.groupWrap.hidden = !config.references;
  if (!config.references) genEl.group.checked = false;
  syncCountField();
  syncMarkEntry();
}

function syncCountField() {
  const group = genGroupEnabled();
  genEl.countField.hidden = !group;
  // 这一行是三列网格。张数藏起来后只剩模型和尺寸两个控件，不降列的话右侧会
  // 空出一整格，看着像少渲染了一个字段。
  const row = genEl.countField.parentElement;
  if (row) row.classList.toggle('two', !group);
  if (!group) return;
  const ceiling = genGroupCeiling();
  genEl.maxImages.max = String(ceiling);
  if (Number(genEl.maxImages.value) > ceiling) genEl.maxImages.value = String(ceiling);
  if (Number(genEl.maxImages.value) < 1) genEl.maxImages.value = '1';
}

for (const tab of genEl.tabs.querySelectorAll('.mode-tab')) {
  tab.addEventListener('click', () => setMode(tab.dataset.mode));
}

genEl.group.addEventListener('change', syncCountField);

// Changing the model changes the documented limits, so re-apply them.
genEl.model.addEventListener('change', syncModelCapabilities);
genEl.model.addEventListener('input', syncModelCapabilities);

// JPEG cannot carry an alpha channel, so picking a transparent background moves
// the format off its jpeg default instead of letting the request contradict itself.
genEl.background.addEventListener('change', () => {
  if (genEl.background.value === 'transparent' && (genEl.outputFormat.value === '' || genEl.outputFormat.value === 'jpeg')) {
    genEl.outputFormat.value = 'png';
  }
});

/* ---- reference images ---- */

function revokePreview(ref) {
  if (ref.kind === 'file' && ref.preview) URL.revokeObjectURL(ref.preview);
}

function renderRefs() {
  genEl.refList.replaceChildren();

  for (const [index, ref] of genState.refs.entries()) {
    const row = el('div', 'ref-row');

    if (ref.preview) {
      const thumb = document.createElement('img');
      thumb.className = 'ref-thumb';
      thumb.src = ref.preview;
      thumb.alt = `参考图 ${index + 1}`;
      thumb.referrerPolicy = 'no-referrer';
      row.appendChild(thumb);
    } else {
      const thumb = el('div', 'ref-thumb placeholder', `#${index + 1}`);
      row.appendChild(thumb);
    }

    const body = el('div', 'ref-body');
    if (ref.kind === 'file') {
      const locked = document.createElement('input');
      locked.type = 'text';
      locked.value = ref.name;
      locked.disabled = true;
      body.appendChild(locked);
      body.appendChild(el('span', 'ref-tag', `本机文件 · ${formatBytes(ref.bytes)} · 以 base64 发送`));
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = ref.value;
      input.placeholder = 'https://example.com/reference.png';
      input.addEventListener('input', () => {
        ref.value = input.value.trim();
      });
      body.appendChild(input);
      body.appendChild(el('span', 'ref-tag', '公网图片直链'));
    }
    row.appendChild(body);

    const remove = el('button', 'btn btn-sm btn-danger', '移除');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      revokePreview(ref);
      genState.refs.splice(index, 1);
      renderRefs();
    });
    row.appendChild(remove);

    genEl.refList.appendChild(row);
  }

  genEl.refCount.textContent = `${genState.refs.length} / ${refLimit()} 张`;
  syncCountField();
  // 参考图增减会改变「在参考图上框选」是否可用。
  syncMarkEntry();
}

function addRefUrl(value = '') {
  const limit = refLimit();
  if (genState.refs.length >= limit) {
    toast(`当前模型最多 ${limit} 张参考图片`, 'error');
    return;
  }
  genState.refs.push({ kind: 'url', value: value.trim(), preview: value.trim() });
  renderRefs();
}

genEl.refAddBtn.addEventListener('click', () => addRefUrl(''));
genEl.refUploadBtn.addEventListener('click', () => genEl.refFile.click());
genEl.refClearBtn.addEventListener('click', () => {
  for (const ref of genState.refs) revokePreview(ref);
  genState.refs = [];
  renderRefs();
});

genEl.refFile.addEventListener('change', async () => {
  const files = [...(genEl.refFile.files || [])];
  genEl.refFile.value = '';
  for (const file of files) {
    if (genState.refs.length >= refLimit()) {
      toast(`当前模型最多 ${refLimit()} 张参考图片，其余文件已忽略`, 'error');
      break;
    }
    if (!file.type.startsWith('image/')) {
      toast(`${file.name} 不是图片文件，已忽略`, 'error');
      continue;
    }
    if (file.size > REF_FILE_MAX_BYTES) {
      toast(`${file.name} 超过 ${formatBytes(REF_FILE_MAX_BYTES)} 上限，已忽略`, 'error');
      continue;
    }
    let dataUrl;
    try {
      dataUrl = await readAsDataUrl(file);
    } catch {
      toast(`${file.name} 读取失败`, 'error');
      continue;
    }
    genState.refs.push({
      kind: 'file',
      value: dataUrl,
      name: file.name,
      bytes: file.size,
      preview: URL.createObjectURL(file),
    });
  }
  renderRefs();
});

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('read-failed'));
    reader.readAsDataURL(file);
  });
}

/* ---- prompt helpers ---- */

/** 提示词上限。textarea 的 maxlength 只拦键盘输入，程序赋值要自己截断。 */
const PROMPT_MAX = 8000;

/**
 * 提示词框下面那行字数：方舟按手册的「中文 ≤300 字 / 英文 ≤600 词」建议提示，
 * 网关按它自己的 4000 字硬上限。只提示，不拦——上游并不会因为 301 个字报错。
 */
function refreshPromptCount() {
  const node = genEl.promptCount;
  if (!node) return;
  const text = genEl.prompt.value;

  if (isRelay()) {
    node.textContent = `${text.length} / ${RELAY_PROMPT_MAX} 字`;
    node.classList.toggle('is-over', text.length > RELAY_PROMPT_MAX);
    node.title = '网关的提示词硬上限';
    return;
  }

  const { cjk, words, over } = promptBudget(text);
  const parts = [];
  if (cjk || !words) parts.push(`中文 ${cjk} / ${PROMPT_BUDGET.chars} 字`);
  if (words) parts.push(`英文 ${words} / ${PROMPT_BUDGET.words} 词`);
  node.textContent = parts.join(' · ') + (over ? '（超出建议）' : '');
  node.classList.toggle('is-over', over);
  node.title = over
    ? '超出手册建议的字数，模型可能忽略部分细节'
    : '手册建议：中文不超过 300 字、英文不超过 600 词';
}

genEl.prompt.addEventListener('input', refreshPromptCount);

genEl.promptClearBtn.addEventListener('click', () => {
  if (!genEl.prompt.value) {
    toast('提示词已经是空的');
    return;
  }
  genEl.prompt.value = '';
  refreshPromptCount();
  genEl.prompt.focus();
  toast('已清空提示词', 'ok');
});

genEl.promptPasteBtn.addEventListener('click', async () => {
  let text;
  try {
    // 必须在点击手势里直接读：iOS Safari 只认手势内的第一次剪贴板调用。
    text = await readText();
  } catch {
    toast('浏览器不允许读取剪贴板，请直接按 Ctrl/⌘+V 粘贴', 'error', 4200);
    genEl.prompt.focus();
    return;
  }
  const next = String(text || '').trim().slice(0, PROMPT_MAX);
  if (!next) {
    toast('剪贴板里没有文字', 'error');
    return;
  }
  // 已经写好的提示词不能被一次误点冲掉，替换前确认一次。
  if (genEl.prompt.value.trim() && !window.confirm('用剪贴板里的内容替换当前提示词吗？')) return;
  genEl.prompt.value = next;
  refreshPromptCount();
  genEl.prompt.focus();
  toast(`已从剪贴板替换（${next.length} 字）`, 'ok');
});

/* ---- 提示词记录（最近 10 条，先进先出，只存这台浏览器） ---- */

/**
 * 提示词是这台机器上的创作草稿，不是服务端数据：存 localStorage，不进
 * `data/settings.json`，也不进运行日志（日志只记路径和状态码）。换浏览器或清站点数据
 * 就没了，这是有意的——多一份落盘就多一处会泄漏提示词的地方。
 */
const PROMPT_HISTORY_KEY = 'still-gallery:prompt-history';
const PROMPT_HISTORY_MAX = 10;

function readPromptHistory() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(PROMPT_HISTORY_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    // 手工改过 localStorage、或者旧版本留下的脏数据，都在这里收敛掉。
    const seen = new Set();
    const out = [];
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      const text = item.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
      if (out.length >= PROMPT_HISTORY_MAX) break;
    }
    return out;
  } catch {
    return [];
  }
}

function writePromptHistory(list) {
  try {
    window.localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(list));
  } catch {
    /* 隐私模式：这一次会话里还能用，刷新就没了，不该因此打断生成 */
  }
}

let promptHistory = readPromptHistory();

/** 记一条。同一条重复生成不堆十份，而是挪到最前面——容量和顺序都还是先进先出。 */
function rememberPrompt(text) {
  const value = String(text || '').trim();
  if (!value) return;
  promptHistory = [value, ...promptHistory.filter((item) => item !== value)].slice(0, PROMPT_HISTORY_MAX);
  writePromptHistory(promptHistory);
  renderPromptHistory();
}

function usePromptHistory(text) {
  const current = genEl.prompt.value.trim();
  // 已经提交过的提示词本身就躺在列表里，替换它没有损失，不用弹确认；
  // 只有「还没生成过」的草稿才值得拦一下。
  if (current && current !== text && !promptHistory.includes(current)) {
    if (!window.confirm('当前提示词还没生成过，用这条记录替换吗？')) return;
  }
  genEl.prompt.value = text;
  refreshPromptCount();
  genEl.prompt.focus();
  toast(`已填入记录（${text.length} 字）`, 'ok');
}

function renderPromptHistory() {
  genEl.promptHistoryCount.textContent = `${promptHistory.length}/${PROMPT_HISTORY_MAX}`;
  genEl.promptHistoryEmpty.hidden = promptHistory.length > 0;
  genEl.promptHistoryClear.disabled = promptHistory.length === 0;

  genEl.promptHistoryList.replaceChildren(
    ...promptHistory.map((text) => {
      const item = document.createElement('li');
      const button = el('button', 'prompt-history-item');
      button.type = 'button';
      button.title = `点击填入提示词（${text.length} 字）\n\n${text}`;
      button.appendChild(el('span', 'prompt-history-text', text));
      button.addEventListener('click', () => usePromptHistory(text));
      item.appendChild(button);
      return item;
    }),
  );
}

genEl.promptHistoryClear.addEventListener('click', () => {
  if (!promptHistory.length) return;
  if (!window.confirm(`清空这 ${promptHistory.length} 条提示词记录吗？只清列表，不影响已生成的作品。`)) return;
  promptHistory = [];
  writePromptHistory(promptHistory);
  renderPromptHistory();
  toast('提示词记录已清空', 'ok');
});

renderPromptHistory();

/* ---- 交互编辑：在参考图上框选，把 <bbox> / <point> 插进提示词 ---- */

const markState = { start: null, startClient: null, rect: null, dragging: false, pointerId: null };

/** 网关没有交互编辑这个通道；其余模型按能力矩阵判断。 */
function markAvailable() {
  if (isRelay()) return false;
  const caps = currentCapabilities();
  return Boolean(caps && caps.supportsInteractiveEdit);
}

/** 只有「图生图 + 有参考图 + 模型支持」时才露出入口。 */
function syncMarkEntry() {
  const usable = genState.mode === 'image2image' && genState.refs.length > 0 && markAvailable();
  genEl.promptMarkBtn.hidden = !usable;
  if (!usable) closeMarkOverlay();
}

function openMarkOverlay() {
  const ref = genState.refs[0];
  if (!ref) {
    toast('先加一张参考图', 'error');
    return;
  }
  markState.start = null;
  markState.pointerId = null;
  genEl.markLayer.replaceChildren();
  genEl.markImage.src = ref.preview || ref.value;
  genEl.markHint.textContent = '拖动框出要编辑的区域，或轻点标记一个点。松开即插入提示词。';
  genEl.markOverlay.hidden = false;
  // 锁住背后页面的滚动：否则移动端拖框会把整页一起拖走。
  document.body.classList.add('mark-open');
}

function closeMarkOverlay() {
  if (genEl.markOverlay.hidden) return;
  genEl.markOverlay.hidden = true;
  document.body.classList.remove('mark-open');
  genEl.markLayer.replaceChildren();
  markState.start = null;
  markState.pointerId = null;
  markState.rect = null;
  markState.dragging = false;
}

/** 屏幕坐标 → 原图像素。stage 与 img 是同一个盒子（见 styles.css）。 */
function markPoint(event) {
  const img = genEl.markImage;
  if (!img.naturalWidth || !img.naturalHeight) return null;
  return pointerToImagePixel({
    clientX: event.clientX,
    clientY: event.clientY,
    rect: genEl.markStage.getBoundingClientRect(),
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
  });
}

/** 把原图坐标画回屏幕上（含 contain 的留白偏移）。 */
function paintMarkRect(start, end) {
  const rect = markState.rect;
  const img = genEl.markImage;
  if (!rect || !img.naturalWidth) return;
  const box = genEl.markStage.getBoundingClientRect();
  const fit = containRect({
    boxWidth: box.width,
    boxHeight: box.height,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
  });
  if (!fit) return;
  const x1 = Math.min(start.x, end.x);
  const y1 = Math.min(start.y, end.y);
  rect.style.left = `${fit.offsetX + x1 * fit.scale}px`;
  rect.style.top = `${fit.offsetY + y1 * fit.scale}px`;
  rect.style.width = `${Math.abs(end.x - start.x) * fit.scale}px`;
  rect.style.height = `${Math.abs(end.y - start.y) * fit.scale}px`;
}

/** 在光标处插入标签；超上限就拒绝并提示，不静默截断。 */
function insertPromptTag(tag) {
  const area = genEl.prompt;
  const start = area.selectionStart ?? area.value.length;
  const end = area.selectionEnd ?? start;
  const before = area.value.slice(0, start);
  const after = area.value.slice(end);
  // 前一个字符不是空白就补一个空格，避免标签和文字粘在一起。
  const pad = before && !/\s$/.test(before) ? ' ' : '';
  const next = `${before}${pad}${tag}${after}`;
  const limit = area.maxLength > 0 ? area.maxLength : PROMPT_MAX;
  if (next.length > limit) {
    toast(`插入后超过 ${limit} 字上限，先把提示词缩短一点`, 'error', 4200);
    return false;
  }
  area.value = next;
  const caret = before.length + pad.length + tag.length;
  try {
    area.setSelectionRange(caret, caret);
  } catch {
    /* 没聚焦时个别浏览器会抛，忽略即可 */
  }
  refreshPromptCount();
  return true;
}

genEl.promptMarkBtn.addEventListener('click', openMarkOverlay);
genEl.markCloseBtn.addEventListener('click', closeMarkOverlay);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !genEl.markOverlay.hidden) closeMarkOverlay();
});

genEl.markLayer.addEventListener('pointerdown', (event) => {
  // 只认主键 / 触摸 / 笔；右键与多指手势直接放过。
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const point = markPoint(event);
  if (!point) return;
  event.preventDefault();
  try {
    genEl.markLayer.setPointerCapture(event.pointerId);
  } catch {
    /* 某些老浏览器不支持捕获，退化成普通事件流也能用 */
  }
  markState.pointerId = event.pointerId;
  markState.start = point;
  markState.startClient = { x: event.clientX, y: event.clientY };
  markState.dragging = false;
  markState.rect = document.createElement('div');
  markState.rect.className = 'mark-rect';
  genEl.markLayer.replaceChildren(markState.rect);
  paintMarkRect(point, point);
});

genEl.markLayer.addEventListener('pointermove', (event) => {
  if (markState.pointerId !== event.pointerId || !markState.start) return;
  const point = markPoint(event);
  if (!point) return;
  const dx = event.clientX - markState.startClient.x;
  const dy = event.clientY - markState.startClient.y;
  // 手指抖动总会带几像素位移，超过阈值才算「拖框」，否则当成点选。
  if (!markState.dragging && Math.hypot(dx, dy) > 10) markState.dragging = true;
  paintMarkRect(markState.start, point);
  if (markState.dragging) {
    const x1 = Math.min(markState.start.x, point.x);
    const y1 = Math.min(markState.start.y, point.y);
    const x2 = Math.max(markState.start.x, point.x);
    const y2 = Math.max(markState.start.y, point.y);
    genEl.markHint.textContent = `${x1}, ${y1} → ${x2}, ${y2}`;
  }
});

genEl.markLayer.addEventListener('pointerup', (event) => {
  if (markState.pointerId !== event.pointerId || !markState.start) return;
  const start = markState.start;
  const end = markPoint(event);
  const dragged = markState.dragging;
  markState.pointerId = null;
  markState.start = null;
  markState.dragging = false;
  if (!end) return;

  let tag;
  if (dragged) {
    tag = bboxTag(start, end);
  } else {
    tag = pointTag(end);
    // 点选：把那个 0×0 的框换成一个小圆点，位置一目了然。
    if (markState.rect) {
      markState.rect.className = 'mark-dot';
      markState.rect.style.width = '';
      markState.rect.style.height = '';
    }
  }

  if (insertPromptTag(tag)) {
    genEl.markHint.textContent = `已插入 ${tag}`;
  }
});

genEl.markLayer.addEventListener('pointercancel', () => {
  markState.pointerId = null;
  markState.start = null;
  markState.dragging = false;
});

/* 透明背景的额外前提（手册 4.5）：图生图 + 正好 1 张带透明通道的图。
   这里只提示不重置选择——用户常常先选背景再传图。 */
genEl.background.addEventListener('change', () => {
  if (genEl.background.value !== 'transparent') return;
  if (genState.mode === 'image2image' && genState.refs.length === 1) return;
  toast('透明背景需要「图生图 + 正好 1 张带透明通道的参考图（png / webp）」', 'info', 5200);
});

/* ---- 模型 / 尺寸下拉按钮 ---- */

/**
 * 给「可以自由输入、但有建议值」的字段挂一个下拉按钮。
 *
 * 建议值仍然放在 datalist 里（模型来自 `modelSuggestions`，尺寸按模型家族由
 * `syncSizeSuggestions()` 重算），这里只负责把 datalist 渲染成可点的菜单 ——
 * 每次打开都重新读一遍，所以模型一换尺寸候选自动跟着变。输入框保持可编辑，
 * 服务端仍然会校验手填的任意值。
 */
function attachCombo({ input, toggle, menu, list }) {
  let options = [];
  let active = -1;

  const isOpen = () => !menu.hidden;
  const optionNodes = () => [...menu.querySelectorAll('.combo-option')];

  function renderOptions() {
    options = [...list.querySelectorAll('option')]
      .map((option) => String(option.value || '').trim())
      .filter(Boolean);
    const current = input.value.trim();
    active = -1;
    menu.replaceChildren();

    if (!options.length) {
      menu.appendChild(el('div', 'combo-empty', '暂无建议值，可直接输入'));
      return;
    }

    options.forEach((value, index) => {
      const item = el('button', 'combo-option', value);
      item.type = 'button';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', value === current ? 'true' : 'false');
      if (value === current) active = index;
      item.addEventListener('click', () => choose(value));
      menu.appendChild(item);
    });
  }

  function setActive(next, scroll = false) {
    if (!options.length) return;
    active = (next + options.length) % options.length;
    optionNodes().forEach((node, index) => {
      node.classList.toggle('is-active', index === active);
    });
    // 只在键盘导航时滚动。打开菜单就滚动的话，菜单若有一半在视口外会把整页
    // 拽一下，用户看到的画面会莫名跳动。
    const node = optionNodes()[active];
    if (scroll && node) node.scrollIntoView({ block: 'nearest' });
  }

  function open() {
    renderOptions();
    menu.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    // 字段贴近视口底部时向上展开，否则最后几项会被截在屏幕外。
    menu.classList.remove('combo-menu--up');
    const box = input.getBoundingClientRect();
    const below = window.innerHeight - box.bottom;
    if (menu.offsetHeight + 12 > below && box.top > below) menu.classList.add('combo-menu--up');
    setActive(active >= 0 ? active : 0);
  }

  function close() {
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    active = -1;
  }

  function choose(value) {
    input.value = value;
    // 模型字段靠 input/change 重算能力矩阵和尺寸候选，两个都发，免得漏。
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    close();
    input.focus();
  }

  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (isOpen()) close();
    else open();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (isOpen()) setActive(active + 1, true);
      else open();
    } else if (event.key === 'ArrowUp') {
      if (!isOpen()) return;
      event.preventDefault();
      setActive(active - 1, true);
    } else if (event.key === 'Enter' && isOpen()) {
      event.preventDefault();
      const node = optionNodes()[active];
      if (node) choose(node.textContent);
    } else if (event.key === 'Escape' && isOpen()) {
      event.preventDefault();
      close();
    }
  });

  // 点别处收起。不能只靠 blur：点选项时输入框会先失焦，blur 里收菜单会让点击落空。
  document.addEventListener('click', (event) => {
    if (!isOpen()) return;
    if (menu.contains(event.target) || toggle.contains(event.target) || event.target === input) return;
    close();
  });
}

attachCombo({
  input: genEl.model,
  toggle: genEl.modelToggle,
  menu: genEl.modelMenu,
  list: genEl.modelList,
});

attachCombo({
  input: genEl.size,
  toggle: genEl.sizeToggle,
  menu: genEl.sizeMenu,
  list: genEl.sizeList,
});

attachCombo({
  input: genEl.aspect,
  toggle: genEl.aspectToggle,
  menu: genEl.aspectMenu,
  list: genEl.aspectList,
});

/* ---- 上游切换（火山方舟 / 01ai 网关）---- */

/** 网关的提示词上限，与 lib/relay-gen.mjs 的 RELAY_MAX_PROMPT_CHARS 对齐。 */
const RELAY_PROMPT_MAX = 4000;
/** 网关的 `image` 是单值字段，所以一次只能带一张参考图。 */
const RELAY_REF_MAX = 1;

/** 网关这一侧真正会生效的参数，全部来自 `config.relay`（服务端是唯一真相来源）。 */
function relayConfig() {
  const relay = (genState.config && genState.config.relay) || {};
  return {
    modelLabel: relay.modelLabel || 'mago-relay',
    aspects: Array.isArray(relay.aspects) && relay.aspects.length ? relay.aspects : ['1:1', '4:3', '3:4', '16:9', '9:16'],
    aspectPixels: relay.aspectPixels || {},
    maxPromptChars: Number(relay.maxPromptChars) > 0 ? Number(relay.maxPromptChars) : RELAY_PROMPT_MAX,
    maxReferenceImages: Number(relay.maxReferenceImages) > 0 ? Number(relay.maxReferenceImages) : RELAY_REF_MAX,
  };
}

/**
 * 两套上游的参数根本不同：方舟有模型、尺寸档、提示词优化、输出格式、背景、
 * 联网、组图；网关只有提示词、画幅、一张参考图，其余字段传了也会被静默忽略。
 * 所以这里**整块隐藏**而不是置灰——留着一个不生效的模型下拉框，等于骗人。
 * 同理，方舟那句「参考图最多 14 张、尺寸支持 1K/2K/4K」的模型说明也必须收起来，
 * 否则网关界面上会挂着一条来自 Seedream 的参数，看着就像没切换成功。
 */
function applyProvider() {
  const relay = isRelay();
  const params = relayConfig();

  for (const tab of genEl.providerTabs.querySelectorAll('[data-provider]')) {
    const on = tab.dataset.provider === genState.provider;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
  }

  genEl.providerNote.hidden = !relay;
  genEl.providerNote.textContent = relay
    ? '网关只认提示词、画幅和一张参考图：模型、种子、负向提示词、尺寸像素、优化、输出格式、背景、联网、组图都没有通道，传了也不生效。'
    : '';

  // 网关没有这些通道，整块隐藏而不是置灰——留个能点但没作用的控件是撒谎。
  for (const node of [genEl.modelField, genEl.sizeField, genEl.defaultRow, genEl.advancedRow, genEl.optionsField]) {
    if (node) node.hidden = relay;
  }
  // 模型/尺寸/张数那一整行在网关模式下三个字段全空，留着会撑出一段空白。
  const modelRow = genEl.modelField.parentElement;
  if (modelRow) modelRow.hidden = relay;
  // 「选项」整列消失后，标签输入框独占一行，否则右边会留一块空白。
  genEl.metaRow.classList.toggle('solo', relay);
  genEl.aspectField.hidden = !relay;

  // 网关自己的参数清单：列的是真正会生效的五个，而不是方舟那套的残影。
  genEl.relayParams.hidden = !relay;
  if (relay) {
    genEl.relayModel.textContent = params.modelLabel;
    // 只列档位、不列像素：像素已经在下面的画幅说明里逐条写过了，重复一遍会让
    // 这一行撑成两屏宽。
    genEl.relayAspects.textContent = params.aspects.join(' / ');
    genEl.relayPrompt.textContent = `${params.maxPromptChars} 字符上限`;
    genEl.relayRefs.textContent = `最多 ${params.maxReferenceImages} 张`;
  }

  genEl.refHint.textContent = relay
    ? `只能带 ${params.maxReferenceImages} 张：公网图片直链，或从本机上传（以 base64 随请求发送，单张不超过 10MB）。`
    : '可填 1–14 张：公网图片直链，或从本机上传（上传的图片会以 base64 随请求发送，单张不超过 10MB）。';

  const groupTab = genEl.tabs.querySelector('.mode-tab[data-mode="text2group"]');
  if (groupTab) {
    groupTab.hidden = relay;
    groupTab.disabled = relay;
    groupTab.title = relay ? '01ai 网关不支持组图' : '';
  }
  if (relay && genState.mode === 'text2group') setMode('text2image');

  genEl.prompt.maxLength = relay ? params.maxPromptChars : PROMPT_MAX;
  refreshPromptCount();
  if (relay && genEl.prompt.value.length > params.maxPromptChars) {
    toast(
      `网关提示词上限 ${params.maxPromptChars} 字符，当前 ${genEl.prompt.value.length} 字符，提交会被拒绝`,
      'error',
      5200,
    );
  }

  // 参考图上限从 14 掉到 1：超出的先摘掉，而不是等提交时被服务端拒。
  if (relay && genState.refs.length > params.maxReferenceImages) {
    for (const ref of genState.refs.splice(params.maxReferenceImages)) revokePreview(ref);
    toast(`网关一次只能带 ${params.maxReferenceImages} 张参考图，多余的已移除`, 'info', 4200);
  }

  if (relay) {
    // 组图开关可能还留着方舟时的勾选状态，不清掉的话「生成张数」会跟着冒出来。
    genEl.group.checked = false;
    // 方舟的模型说明（参考图 14 张 / 尺寸 1K-4K）在网关模式下必须收起来。
    genEl.modelNote.hidden = true;
    genEl.modelNote.textContent = '';
    syncCountField();
    renderRefs();
  } else {
    syncModelCapabilities();
  }

  renderKeyBanner();
  // 网关没有交互编辑通道；切换上游时入口要跟着消失。
  syncMarkEntry();
}

/** 凭据缺失的横幅要跟着上游走：方舟缺 Key 和网关缺口令是两回事。 */
function renderKeyBanner() {
  const config = genState.config;
  const relay = isRelay();
  const ready = relay
    ? Boolean(config && config.relay && config.relay.configured)
    : Boolean(config && config.configured);

  if (ready) {
    genEl.keyBanner.hidden = true;
    genEl.submitBtn.disabled = false;
    return;
  }
  genEl.keyBanner.hidden = false;
  genEl.keyBanner.textContent = relay
    ? '还没有配置 01ai 网关口令，请先在下方「生成接口设置」中填写。'
    : '还没有配置生图 API Key，请先在下方「生成接口设置」中填写。';
  genEl.settings.open = true;
  genEl.submitBtn.disabled = true;
}

/**
 * 切换上游要落盘：真正决定请求发给谁的是服务端的 settings.provider。
 * 失败就把界面回滚到切换前，不能让按钮状态和实际请求对不上。
 *
 * 提交之后**必须核对服务端的回显**：如果对面把 provider 吞掉了（旧版本进程、
 * 或者根本没实现这个字段），`renderGenConfig()` 会把界面照原样刷回去，而
 * 「已切换到 01ai 网关」的提示已经弹出来了——界面看着就是「点了没切换」。
 */
async function switchProvider(next) {
  if (next !== 'ark' && next !== 'relay') return;
  if (next === genState.provider) return;
  const previous = genState.provider;
  genState.provider = next;
  try {
    applyProvider();
    const config = await api('/api/generate/config', {
      method: 'PUT',
      body: JSON.stringify({ provider: next }),
    });
    if (config.provider !== next) {
      throw new Error('服务端没有接受这次切换，可能正在跑旧版本，重启服务后再试');
    }
    genState.config = config;
    renderGenConfig();
    toast(next === 'relay' ? '已切换到 01ai 网关' : '已切换到火山方舟', 'ok');
  } catch (error) {
    genState.provider = previous;
    applyProvider();
    toast(`切换上游失败：${error.message}`, 'error', 5200);
  }
}

genEl.providerTabs.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-provider]');
  if (!tab) return;
  void switchProvider(tab.dataset.provider);
});

/* ---- config ---- */

/**
 * Show which model the server will fall back to. Kept next to the model field
 * rather than buried in the settings drawer, because "which model does this
 * actually call" is the question the field raises.
 */
function renderDefaultChip() {
  const config = genState.config;
  const fallback = (config && config.defaultModel) || '';
  const current = genEl.model.value.trim();
  genEl.defaultChip.textContent = fallback ? `默认模型：${fallback}` : '默认模型：未设置';
  genEl.defaultChip.classList.toggle('ok', Boolean(fallback) && fallback === current);
  genEl.setDefaultBtn.disabled = !current || current === fallback;
  genEl.setDefaultBtn.title = !current
    ? '先在「模型」里填写一个模型 ID'
    : current === fallback
      ? '当前模型已经是默认模型'
      : `把默认模型改为 ${current}`;
}

/** Persist a default model. `PUT` only touches the fields it is given. */
async function saveDefaultModel(model) {
  genEl.setDefaultBtn.disabled = true;
  try {
    genState.config = await api('/api/generate/config', {
      method: 'PUT',
      body: JSON.stringify({ defaultModel: model }),
    });
    genEl.defaultModel.value = genState.config.defaultModel || '';
    renderGenConfig();
    toast(`默认模型已设为 ${genState.config.defaultModel}`, 'ok');
    return true;
  } catch (error) {
    toast(`保存默认模型失败：${error.message}`, 'error', 5200);
    renderDefaultChip();
    return false;
  }
}

genEl.setDefaultBtn.addEventListener('click', () => {
  const model = genEl.model.value.trim();
  if (!model) {
    toast('请先填写模型 ID', 'error');
    return;
  }
  void saveDefaultModel(model);
});

function renderGenConfig() {
  const config = genState.config;
  if (!config) return;

  // 服务端才是上游的唯一真相来源。
  genState.provider = config.provider === 'relay' ? 'relay' : 'ark';

  // 并发数存在同一份配置里，跟着一起刷新（控件在队列面板上）。
  syncQueueConcurrency(config);

  genEl.modelList.replaceChildren();
  for (const model of config.modelSuggestions || []) {
    const option = document.createElement('option');
    option.value = model;
    genEl.modelList.appendChild(option);
  }
  // The size datalist is per model, so syncModelCapabilities() builds it below —
  // and rebuilds it every time the model field changes.

  genEl.baseUrl.value = config.baseUrl || '';
  genEl.defaultModel.value = config.defaultModel || '';
  if (!genEl.model.value) genEl.model.value = config.defaultModel || '';
  renderDefaultChip();

  const relay = config.relay || {};
  const relayParams = relayConfig();
  genEl.aspectList.replaceChildren();
  for (const aspect of relayParams.aspects) {
    const option = document.createElement('option');
    option.value = aspect;
    genEl.aspectList.appendChild(option);
  }
  const defaultAspect = relay.defaultAspect || relayParams.aspects[0] || '4:3';
  genEl.aspect.placeholder = defaultAspect;
  if (!genEl.aspect.value) genEl.aspect.value = defaultAspect;
  const pixels = relayParams.aspectPixels;
  const sizes = relayParams.aspects
    .map((aspect) => `${aspect} ${pixels[aspect] || ''}`.trim())
    .join(' · ');
  genEl.aspectHint.textContent = sizes
    ? `${sizes}。边长会对齐到 32 的倍数，所以 4:3 实际是 1184×864；未知取值会静默回落 4:3。`
    : '网关唯一的画幅开关。';

  genEl.relayBaseUrl.value = relay.baseUrl || '';
  genEl.relayLocalHint.textContent = relay.localFallback
    ? `每次生成先试 ${relay.localBaseUrl}，连不上或那里没有网关路由才用上面的地址。`
    : '本机优先已关闭，请求只会打上面的地址。';
  genEl.relayLocalHint.hidden = !relay.localBaseUrl && !relay.localFallback;
  if (relay.envLocked) {
    genEl.relayToken.value = '';
    genEl.relayToken.disabled = true;
    genEl.relayToken.placeholder = '由 IMAGE_RELAY_TOKEN 环境变量提供';
    genEl.relayClearBtn.disabled = true;
    genEl.relayTokenHint.textContent = '当前口令来自 IMAGE_RELAY_TOKEN 环境变量，优先级最高，界面上的修改不会生效。';
  } else {
    genEl.relayToken.disabled = false;
    genEl.relayToken.placeholder = relay.configured ? '留空表示不修改' : '粘贴网关口令';
    genEl.relayClearBtn.disabled = !relay.configured;
    genEl.relayTokenHint.textContent = relay.configured
      ? `已保存口令 ${relay.tokenHint}，与方舟 API Key 分开保存，切换上游不需要重新填。`
      : '与方舟的 API Key 分开保存，切换上游不需要重新填。只写本机 data/settings.json，不回传浏览器。';
  }

  if (config.envLocked) {
    genEl.apiKey.value = '';
    genEl.apiKey.disabled = true;
    genEl.apiKey.placeholder = '由 ARK_API_KEY 环境变量提供';
    genEl.configClearBtn.disabled = true;
    genEl.apiKeyHint.textContent =
      '当前密钥来自 ARK_API_KEY 环境变量，优先级最高，界面上的修改不会生效。';
  } else {
    genEl.apiKey.disabled = false;
    genEl.apiKey.placeholder = config.configured ? '留空表示不修改' : '粘贴方舟 API Key';
    genEl.configClearBtn.disabled = !config.configured;
    genEl.apiKeyHint.textContent = config.configured
      ? `已保存密钥 ${config.apiKeyHint}，存放在本机 data/settings.json（权限 600，已被 .gitignore 忽略）。留空提交即保持不变。`
      : '密钥只保存在本机 data/settings.json（权限 600，已被 .gitignore 忽略），不会写进源码，也不会回传到浏览器。';
  }

  applyProvider();
}

async function loadGenConfig() {
  try {
    genState.config = await api('/api/generate/config');
    renderGenConfig();
  } catch (error) {
    toast(`生成配置加载失败：${error.message}`, 'error');
  }
}

genEl.configForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = {
    baseUrl: genEl.baseUrl.value.trim(),
    defaultModel: genEl.defaultModel.value.trim(),
    relayBaseUrl: genEl.relayBaseUrl.value.trim(),
  };
  const key = genEl.apiKey.value.trim();
  if (key) payload.apiKey = key;
  const relayToken = genEl.relayToken.value.trim();
  if (relayToken) payload.relayToken = relayToken;

  genEl.configSaveBtn.disabled = true;
  try {
    genState.config = await api('/api/generate/config', { method: 'PUT', body: JSON.stringify(payload) });
    genEl.apiKey.value = '';
    genEl.relayToken.value = '';
    genEl.configBanner.hidden = false;
    genEl.configBanner.className = 'banner';
    genEl.configBanner.textContent = '设置已保存。';
    renderGenConfig();
    toast('生成接口设置已保存', 'ok');
  } catch (error) {
    genEl.configBanner.hidden = false;
    genEl.configBanner.className = 'banner warn';
    genEl.configBanner.textContent = error.message;
    toast(error.message, 'error', 5200);
  } finally {
    genEl.configSaveBtn.disabled = false;
  }
});

genEl.configClearBtn.addEventListener('click', async () => {
  if (!window.confirm('确定清除本机保存的 API Key 吗？清除后将无法继续生成图片。')) return;
  try {
    genState.config = await api('/api/generate/config', {
      method: 'PUT',
      body: JSON.stringify({ clearApiKey: true }),
    });
    genEl.apiKey.value = '';
    genEl.configBanner.hidden = false;
    genEl.configBanner.className = 'banner';
    genEl.configBanner.textContent = '已清除本机保存的 API Key。';
    renderGenConfig();
    toast('已清除密钥', 'ok');
  } catch (error) {
    toast(error.message, 'error', 5200);
  }
});

genEl.relayClearBtn.addEventListener('click', async () => {
  if (!window.confirm('确定清除本机保存的 01ai 网关口令吗？清除后网关将无法继续出图。')) return;
  try {
    genState.config = await api('/api/generate/config', {
      method: 'PUT',
      body: JSON.stringify({ clearRelayToken: true }),
    });
    genEl.relayToken.value = '';
    genEl.configBanner.hidden = false;
    genEl.configBanner.className = 'banner';
    genEl.configBanner.textContent = '已清除本机保存的网关口令。';
    renderGenConfig();
    toast('已清除网关口令', 'ok');
  } catch (error) {
    toast(error.message, 'error', 5200);
  }
});

/* ---- generation ---- */

function readGenForm() {
  const payload = {
    mode: genState.mode,
    prompt: genEl.prompt.value.trim(),
    watermark: genEl.watermark.checked,
  };

  if (isRelay()) {
    // 网关只有提示词和画幅。把 model / size / 优化 / 格式 / 背景 / 联网 一起
    // 发过去毫无意义——服务端会忽略，留着只会让人以为它们生效了。
    const aspect = genEl.aspect.value.trim();
    if (aspect) payload.aspect = aspect;
  } else {
    payload.model = genEl.model.value.trim();
    payload.size = genEl.size.value.trim();
    payload.optimizeMode = genEl.optimize.value;
    if (genEl.outputFormat.value) payload.outputFormat = genEl.outputFormat.value;
    if (genEl.background.value) payload.background = genEl.background.value;
    if (genEl.webSearch.checked && !genEl.webSearch.disabled) payload.webSearch = true;
  }

  if (genState.mode === 'image2image') {
    payload.referenceImages = genState.refs.map((ref) => ref.value.trim()).filter(Boolean);
  }
  if (!isRelay() && genGroupEnabled()) payload.maxImages = genMaxImagesValue();
  return payload;
}

function autoTitle(prompt, index, total) {
  const text = String(prompt || '').trim().replace(/\s+/g, ' ');
  const base = text.length > 28 ? `${text.slice(0, 28)}…` : text || 'AI 生成';
  return total > 1 ? `${base}（${index}）` : base;
}

function formatRemaining(expiresAt) {
  if (!expiresAt) return null;
  const diff = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(diff)) return null;
  if (diff <= 0) return { text: '链接已过期，无法再导入', danger: true };
  const hours = diff / 3_600_000;
  if (hours < 1) return { text: `链接约 ${Math.max(1, Math.round(diff / 60_000))} 分钟后失效`, danger: true };
  return { text: `链接约 ${Math.round(hours)} 小时后失效`, danger: hours < 6 };
}

/**
 * Mount the preview bitmap for one result.
 *
 * The preferred source is the same-origin proxy handle, because the raw signed
 * URL is fetched by the browser over the public internet and dies after 24h —
 * when that happens the `<img>` used to just stay blank with no explanation.
 * If the proxy fails (server restarted, upstream refused) fall back to the
 * signed URL exactly once, then show a recoverable message.
 */
function mountGenImage(result, stage) {
  const preferred = result.previewUrl || result.url;
  if (!preferred) {
    stage.appendChild(el('p', 'gen-pending', '该结果以内联数据返回，暂不支持导入图库'));
    return null;
  }

  const img = document.createElement('img');
  img.alt = result.title;
  // Not lazy: a handful of cards, and deferring the load until scroll is one of
  // the ways the preview appears to "not work".
  img.loading = 'eager';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';

  img.addEventListener('load', () => {
    stage.classList.remove('is-loading', 'is-failed');
    const failed = stage.querySelector('.gen-fail');
    if (failed) failed.remove();
  });

  img.addEventListener('error', () => {
    // 只对公网 https 地址做一次回退。网关部署在本机时原始地址是
    // `http://127.0.0.1:4399/...`：浏览器去打它只会得到一串 404，既救不回图，
    // 又让人以为「网关坏了」。这种就直接显示失败原因。
    if (result.previewUrl && img.dataset.fellBack !== '1' && /^https:\/\//i.test(result.url || '')) {
      img.dataset.fellBack = '1';
      img.src = result.url;
      return;
    }
    stage.classList.add('is-failed');
    showGenFailure(result, stage, img);
  });

  stage.classList.add('is-loading');
  img.src = preferred;
  stage.appendChild(img);
  return img;
}

/** A failed preview must be visible and recoverable, never a silent grey box. */
function showGenFailure(result, stage, img) {
  stage.classList.remove('is-loading');
  if (stage.querySelector('.gen-fail')) return;

  const box = el('div', 'gen-fail');
  box.appendChild(
    el(
      'p',
      'gen-pending',
      '预览加载失败。可直接「导入图库」——导入由服务器下载，不依赖浏览器网络。',
    ),
  );
  const retry = el('button', 'btn btn-sm', '重试预览');
  retry.type = 'button';
  retry.addEventListener('click', () => {
    box.remove();
    img.dataset.fellBack = '';
    stage.classList.add('is-loading');
    img.src = `${result.previewUrl || result.url}`;
  });
  box.appendChild(retry);
  stage.appendChild(box);
}

/** Refresh only the parts of a card that change, so the bitmap is never reloaded. */
function syncGenCard(result) {
  const { card, meta, importBtn, message } = result.ui;

  card.classList.toggle('imported', result.status === 'imported');

  meta.replaceChildren();
  meta.appendChild(el('span', 'chip', `#${result.index}`));
  if (result.size) meta.appendChild(el('span', 'chip', result.size));
  const remaining = formatRemaining(result.expiresAt);
  if (remaining) meta.appendChild(el('span', `chip${remaining.danger ? ' danger' : ''}`, remaining.text));
  if (result.status === 'imported') meta.appendChild(el('span', 'chip ok', '已导入'));

  importBtn.textContent = result.status === 'imported' ? '已导入图库' : '导入图库';
  importBtn.disabled = genState.busy || result.status === 'imported' || !result.url;

  if (result.message) {
    message.textContent = result.message;
    message.hidden = false;
  } else {
    message.hidden = true;
  }
}

/** Build a card once per result; later renders reuse the same DOM node. */
function buildGenCard(result) {
  const card = el('div', 'gen-card');
  const stage = el('div', 'gen-stage');
  mountGenImage(result, stage);
  card.appendChild(stage);

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.maxLength = 120;
  titleInput.value = result.title;
  titleInput.placeholder = '入库标题';
  titleInput.addEventListener('input', () => {
    result.title = titleInput.value;
  });
  card.appendChild(titleInput);

  const meta = el('div', 'gen-meta');
  card.appendChild(meta);

  const actions = el('div', 'card-actions');
  const importBtn = el('button', 'btn-primary btn-sm', '导入图库');
  importBtn.type = 'button';
  importBtn.addEventListener('click', () => importResult(result, importBtn));
  actions.appendChild(importBtn);

  const copyBtn = el('button', 'btn btn-sm', '复制地址');
  copyBtn.type = 'button';
  copyBtn.disabled = !result.url;
  copyBtn.addEventListener('click', async () => {
    try {
      await copyText(result.url);
      toast('图片地址已复制', 'ok');
    } catch {
      toast('复制失败，请手动选择地址', 'error');
    }
  });
  actions.appendChild(copyBtn);

  // Copying the prompt that produced the image is the gallery's whole reason
  // for existing, so it is available here too, before the image is imported.
  const copyPromptBtn = el('button', 'btn btn-sm', '复制提示词');
  copyPromptBtn.type = 'button';
  copyPromptBtn.disabled = !genState.prompt;
  copyPromptBtn.addEventListener('click', async () => {
    try {
      await copyText(genState.prompt);
      toast('提示词已复制', 'ok');
    } catch {
      toast('复制失败，请手动选择提示词', 'error');
    }
  });
  actions.appendChild(copyPromptBtn);
  card.appendChild(actions);

  const message = el('span', 'ref-tag', '');
  message.hidden = true;
  card.appendChild(message);

  result.ui = { card, stage, meta, importBtn, message };
  syncGenCard(result);
  return card;
}

function renderGenResults() {
  if (!genState.results.length) {
    genEl.grid.replaceChildren();
    genEl.results.hidden = true;
    return;
  }
  genEl.results.hidden = false;

  const imported = genState.results.filter((item) => item.status === 'imported').length;
  genEl.resultLabel.textContent = `生成结果 · ${genState.results.length} 张，已导入 ${imported} 张`;
  genEl.importAllBtn.disabled = genState.busy || imported === genState.results.length;

  // Re-append the existing nodes rather than recreating them: moving a node does
  // not restart an <img> load, whereas rebuilding the grid aborts every in-flight
  // bitmap — which is exactly how a preview ends up permanently blank.
  genEl.grid.replaceChildren(
    ...genState.results.map((result) => {
      if (result.ui) {
        syncGenCard(result);
        return result.ui.card;
      }
      return buildGenCard(result);
    }),
  );
}

async function importResult(result, button) {
  if (result.status === 'importing') return;
  result.status = 'importing';
  if (button) {
    button.disabled = true;
    button.replaceChildren(el('span', 'spinner'), el('span', null, '导入中…'));
  }
  // The whole point of this app is the prompt-to-image association, so store the
  // prompt that actually produced this image — captured when the request was
  // sent — not whatever happens to be in the textarea now. The user may have
  // edited it, or switched mode and typed a different one, since generating.
  const prompt = genState.prompt || genEl.prompt.value.trim();
  const size = result.size || (genState.request ? genState.request.size : '');
  try {
    const payload = {
      url: result.url,
      title: result.title.trim() || autoTitle(prompt, result.index, genState.results.length),
      prompt,
      model: (genState.request && genState.request.model) || '',
      // Log-imported records carry the generation size here too, so the gallery
      // viewer and filters treat both sources the same way.
      aspectRatio: size,
      tags: genEl.tags.value.trim(),
      provenance: {
        source: 'AI 生成',
        mode: genState.request ? genState.request.mode : genState.mode,
        model: genState.request ? genState.request.model : '',
        size,
        outputFormat: (genState.request && genState.request.outputFormat) || '',
        background: (genState.request && genState.request.background) || '',
        webSearch: Boolean(genState.request && genState.request.webSearch),
        generatedAt: genState.generatedAt,
        groupIndex: result.index,
        groupTotal: genState.results.length,
        referenceCount: genState.request ? genState.request.referenceCount : 0,
        urlExpiresAt: result.expiresAt || '',
      },
    };
    // 和队列结果一样：有「生成记录」id 就走服务端那条路，原图地址不必回传。
    const created = result.recordId
      ? await api(`/api/generations/${encodeURIComponent(result.recordId)}/import`, {
          method: 'POST',
          body: JSON.stringify({ title: payload.title, prompt: payload.prompt, tags: payload.tags }),
        })
      : await api('/api/images', { method: 'POST', body: JSON.stringify(payload) });
    result.status = 'imported';
    result.message = `已入库：${created.image.imageUrl}`;
    toast(`《${created.image.title}》已导入图库`, 'ok');
    await loadImages();
  } catch (error) {
    result.status = 'failed';
    result.message = error.message;
    toast(`导入失败：${error.message}`, 'error', 5200);
  }
  renderGenResults();
}

genEl.importAllBtn.addEventListener('click', async () => {
  if (genState.busy) return;
  const pending = genState.results.filter((item) => item.status !== 'imported' && item.url);
  if (!pending.length) {
    toast('没有需要导入的结果', 'info');
    return;
  }
  genState.busy = true;
  renderGenResults();
  let ok = 0;
  for (const [index, result] of pending.entries()) {
    genEl.progress.textContent = `正在导入 ${index + 1} / ${pending.length} …`;
    await importResult(result);
    if (result.status === 'imported') ok += 1;
  }
  genState.busy = false;
  genEl.progress.textContent = `导入完成：成功 ${ok}，失败 ${pending.length - ok}`;
  renderGenResults();
});

genEl.clearResultsBtn.addEventListener('click', () => {
  genState.results = [];
  genState.request = null;
  genState.prompt = '';
  genEl.progress.textContent = '';
  genEl.report.replaceChildren();
  renderGenResults();
});

genEl.form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const payload = readGenForm();
  if (!payload.prompt) {
    toast('请填写提示词', 'error');
    return;
  }
  if (genState.mode === 'image2image' && !payload.referenceImages.length) {
    toast('图生图至少需要一张参考图片', 'error');
    return;
  }
  const totalBytes = genState.refs.reduce((sum, ref) => sum + (ref.bytes || 0), 0);
  if (totalBytes > REF_TOTAL_WARN_BYTES) {
    toast(`参考图合计 ${formatBytes(totalBytes)}，请求体较大，生成可能较慢`, 'info', 4200);
  }

  // busy 只覆盖「入队」这一次请求。任务本身在服务端跑，按钮必须马上解锁——
  // 否则并发就退化成了排队等按钮。
  genState.busy = true;
  genEl.submitBtn.disabled = true;
  genEl.submitBtn.replaceChildren(el('span', 'spinner'), el('span', null, '入队中…'));

  try {
    const data = await api('/api/generate/queue', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (data.queue) queueState.snapshot = data.queue;
    if (data.job && data.job.id) {
      // 记下这次提交，等轮询看到它结束时把结果搬进结果面板。
      genState.watching.set(data.job.id, { prompt: payload.prompt });
    }
    // 入队成功才记：写失败（400/429）的提示词不该占掉列表里的一格。
    rememberPrompt(payload.prompt);
    renderQueue({ force: true });
    scheduleQueuePoll();

    const queue = data.queue || {};
    const paused = Boolean(queue.paused);
    const running = Number(queue.running) || 0;
    const waiting = Number(queue.pending) || 0;
    genEl.banner.hidden = false;
    genEl.banner.className = paused ? 'banner warn' : 'banner';
    genEl.banner.textContent = paused
      ? '已加入队列，但队列当前处于暂停状态，点「继续队列」后才会开始。'
      : `已加入队列（同时最多 ${queue.concurrency || '—'} 个，当前 ${running} 个在跑）。结果出来后会自动显示在这里。`;
    genEl.progress.textContent = paused
      ? ''
      : waiting > 0
        ? `排队中：前面还有 ${Math.max(0, waiting - 1)} 个`
        : '';
    toast(paused ? '已加入队列，但队列处于暂停状态' : '已加入队列', paused ? 'info' : 'ok', 3200);
  } catch (error) {
    genEl.banner.hidden = false;
    genEl.banner.className = 'banner warn';
    genEl.banner.textContent = error.message;
    toast(error.message, 'error', 6000);
  } finally {
    genState.busy = false;
    genEl.submitBtn.disabled = false;
    genEl.submitBtn.textContent = '开始生成';
  }
});

/* ---- generation queue ---- */

/**
 * One duration formatter for the whole console. The metrics tab and the queue
 * rows must agree on what "1.2 s" means, and two copies of this would drift.
 */
function formatMs(value) {
  if (value === null || value === undefined || value === '') return '—';
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}

const QUEUE_STATUS = {
  queued: { text: '排队中', chip: 'chip' },
  running: { text: '生成中', chip: 'chip warn' },
  done: { text: '已完成', chip: 'chip ok' },
  failed: { text: '失败', chip: 'chip danger' },
  canceled: { text: '已取消', chip: 'chip' },
};

const QUEUE_POLL_MS = 2500;

const queueState = {
  snapshot: null,
  /** `${jobId}#${imageIndex}` for every bitmap already sent to the library. */
  imported: new Set(),
  /** Job ids whose thumbnails are expanded. */
  expanded: new Set(),
  /** Fingerprint of the last rendered snapshot, so polling can skip no-ops. */
  signature: '',
  timer: 0,
};

async function loadQueue({ announce = false, force = false } = {}) {
  try {
    queueState.snapshot = await api('/api/generate/queue');
    renderQueue({ force });
  } catch (error) {
    if (announce) toast(`队列加载失败：${error.message}`, 'error');
  }
}

/**
 * Poll only while there is something to watch. A queue that is empty or settled
 * stops the timer entirely, so an idle console makes no requests.
 */
function scheduleQueuePoll() {
  window.clearTimeout(queueState.timer);
  const snapshot = queueState.snapshot;
  if (!snapshot || (snapshot.running === 0 && snapshot.pending === 0)) return;
  queueState.timer = window.setTimeout(async () => {
    await loadQueue();
    scheduleQueuePoll();
  }, QUEUE_POLL_MS);
}

function stopQueuePoll() {
  window.clearTimeout(queueState.timer);
}

function queueThumbs(job) {
  const grid = el('div', 'queue-thumbs');
  const total = job.result.images.length;

  for (const image of job.result.images) {
    const cell = el('div', 'queue-thumb');
    const stage = el('div', 'gen-stage');

    if (image.previewUrl || image.url) {
      const img = document.createElement('img');
      img.alt = `第 ${image.index} 张`;
      // Eager, like the direct-generation cards: these go through the server's
      // cached preview proxy, and a deferred load is one of the ways a preview
      // silently never appears.
      img.loading = 'eager';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => {
        stage.replaceChildren(el('p', 'gen-pending', '预览不可用，可直接导入'));
      });
      img.src = image.previewUrl || image.url;
      stage.appendChild(img);
    } else {
      stage.appendChild(el('p', 'gen-pending', '内联数据，无法预览'));
    }
    cell.appendChild(stage);

    const key = `${job.id}#${image.index}`;
    const done = queueState.imported.has(key);
    const importBtn = el('button', `btn btn-sm${done ? '' : '-primary'}`, done ? '已导入' : '导入图库');
    importBtn.type = 'button';
    importBtn.disabled = done || !image.url;
    importBtn.addEventListener('click', () => void importQueuedImage(job, image, importBtn));
    cell.appendChild(importBtn);

    grid.appendChild(cell);
  }
  return grid;
}

function queueRow(job) {
  const status = QUEUE_STATUS[job.status] || { text: job.status, chip: 'chip' };
  const row = el('div', `queue-item is-${job.status}`);

  const head = el('div', 'queue-head');
  head.appendChild(el('span', status.chip, status.text));
  head.appendChild(el('span', 'queue-model', job.label.model || '（未指定模型）'));
  head.appendChild(el('span', 'chip', (GEN_MODES[job.label.mode] || {}).label || job.label.mode || '—'));
  if (job.label.size) head.appendChild(el('span', 'chip', job.label.size));
  if (job.label.group) head.appendChild(el('span', 'chip', `组图 ≤ ${job.label.maxImages} 张`));
  if (job.label.referenceCount) head.appendChild(el('span', 'chip', `参考图 ${job.label.referenceCount} 张`));
  if (job.result) head.appendChild(el('span', 'chip ok', `产出 ${job.result.images.length} 张`));
  head.appendChild(
    el(
      'span',
      'chip',
      job.status === 'queued' ? `加入于 ${formatDate(job.createdAt)}` : `耗时 ${formatMs(job.durationMs)}`,
    ),
  );

  const actions = el('span', 'queue-actions');
  const makeButton = (text, className, handler) => {
    const button = el('button', `btn btn-sm${className ? ` ${className}` : ''}`, text);
    button.type = 'button';
    button.addEventListener('click', handler);
    actions.appendChild(button);
    return button;
  };

  if (job.status === 'queued') {
    makeButton('取消', 'btn-ghost', () => void queueAction('cancel', job.id, '已取消排队'));
  } else if (job.status === 'running') {
    actions.appendChild(el('span', 'hint', '已开始执行，上游已计费，无法取消'));
  } else {
    if (job.status === 'done') {
      const expanded = queueState.expanded.has(job.id);
      makeButton(expanded ? '收起预览' : '预览 / 导入', '', () => {
        if (expanded) queueState.expanded.delete(job.id);
        else queueState.expanded.add(job.id);
        renderQueue({ force: true });
      });
    }
    makeButton('移除', 'btn-ghost', () => void queueAction('remove', job.id, '已从列表移除'));
  }
  head.appendChild(actions);
  row.appendChild(head);

  if (job.label.promptPreview) {
    row.appendChild(el('p', 'queue-prompt', job.label.promptPreview));
  }
  if (job.status === 'failed' && job.error) {
    row.appendChild(el('p', 'queue-error', job.error));
  }
  if (job.status === 'done' && job.result && queueState.expanded.has(job.id)) {
    row.appendChild(queueThumbs(job));
  }
  return row;
}

/**
 * A cheap fingerprint of everything the queue list draws. Polling rebuilds the
 * list only when this changes: recreating the nodes on every tick would abort
 * the in-flight preview bitmaps of an expanded job — the same failure mode the
 * direct-generation grid avoids by reusing its card nodes.
 */
function queueSignature(snapshot) {
  const jobs = snapshot.jobs
    .map((job) => `${job.id}:${job.status}:${job.durationMs === null ? '' : job.durationMs}`)
    .join(',');
  return `${snapshot.paused ? 'p' : 'r'}|${snapshot.concurrency || 0}|${jobs}`;
}

/**
 * 把一条已经结束的队列任务搬进结果面板。
 *
 * 结果面板原本是「直接请求」的产物，现在主流程走队列，所以完成事件只能从轮询里
 * 取。形状和原来一致，导入/全部导入/清空结果这些下游逻辑一行都不用改。
 */
function applyQueuedResult(job, watch) {
  const images = (job.result && job.result.images) || [];
  genState.request = job.result.request || null;
  genState.generatedAt = job.result.generatedAt || '';
  // 冻结产生这批结果的提示词：标题、入库关联都读它，而不是现在的输入框。
  genState.prompt = watch.prompt;
  genState.results = images.map((image) => ({
    index: image.index,
    url: image.url || '',
    previewUrl: image.previewUrl || '',
    // 服务端登记进「生成记录」时给的 id。导入优先走它：原图地址和网关源站都
    // 在服务端手里，不必再经浏览器回传（本机网关的地址回传会被 SSRF 规则拒掉）。
    recordId: image.recordId || '',
    size: image.size || '',
    expiresAt: image.expiresAt || null,
    title: autoTitle(watch.prompt, image.index, images.length),
    status: 'idle',
    message: '',
  }));

  genEl.banner.hidden = false;
  genEl.banner.className = 'banner';
  genEl.banner.textContent =
    `生成完成：${images.length} 张（模型 ${job.result.model}` +
    `${job.result.request && job.result.request.size ? `，尺寸 ${job.result.request.size}` : ''}）。` +
    '确认后点每张卡片上的「导入图库」。';
  genEl.progress.textContent = '';
  toast(`生成完成，共 ${images.length} 张`, 'ok');
  // 新图已经进「生成记录」了，顺手把那个标签页的数字刷新一下。
  void loadRecent();
  renderGenResults();
}

/**
 * 每次拿到队列快照时调用：我提交的任务里有结束了的，就把结果取出来。
 * 必须在 `renderQueue` 的「指纹没变就跳过重绘」之前执行，否则快照没变时
 * 完成事件会被漏掉。
 */
function harvestWatched() {
  const snapshot = queueState.snapshot;
  if (!snapshot || !genState.watching.size) return;

  for (const [jobId, watch] of [...genState.watching]) {
    const job = snapshot.jobs.find((item) => item.id === jobId);
    if (!job) continue;
    if (job.status === 'queued' || job.status === 'running') {
      genEl.progress.textContent =
        job.status === 'queued' ? '排队中…' : '正在生成…';
      continue;
    }

    genState.watching.delete(jobId);
    if (job.status === 'done' && job.result) {
      applyQueuedResult(job, watch);
    } else if (job.status === 'failed') {
      const message = job.error || '未知错误';
      genEl.banner.hidden = false;
      genEl.banner.className = 'banner warn';
      genEl.banner.textContent = `生成失败：${message}`;
      genEl.progress.textContent = '';
      toast(`生成失败：${message}`, 'error', 6000);
    } else {
      // 被取消的：用户自己点的，不用再弹一次。
      genEl.progress.textContent = '';
    }
  }
}

function renderQueue({ force = false } = {}) {
  const snapshot = queueState.snapshot;
  if (!snapshot) return;

  harvestWatched();

  const signature = queueSignature(snapshot);
  if (!force && signature === queueState.signature) return;
  queueState.signature = signature;

  genEl.queueCounts.textContent =
    `排队 ${snapshot.pending} · 进行中 ${snapshot.running}/${snapshot.concurrency || '—'} · 已结束 ${snapshot.settled}`;
  genEl.queuePauseBtn.textContent = snapshot.paused ? '继续队列' : '暂停队列';
  genEl.queuePauseBtn.classList.toggle('btn-primary', snapshot.paused);
  genEl.queueClearBtn.disabled = snapshot.settled === 0;

  genEl.queueList.replaceChildren();
  if (!snapshot.jobs.length) {
    genEl.queueList.appendChild(
      el('p', 'preview-empty', '队列是空的。填好上面的表单后点「开始生成」，任务会直接进这里。'),
    );
    return;
  }
  for (const job of snapshot.jobs) genEl.queueList.appendChild(queueRow(job));
}

async function queueAction(action, id, successText) {
  try {
    const data = await api(`/api/generate/queue/${action}`, {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
    if (data.queue) queueState.snapshot = data.queue;
    renderQueue({ force: true });
    scheduleQueuePoll();
    toast(successText, 'ok');
  } catch (error) {
    toast(error.message, 'error', 5200);
    // The snapshot in hand is now stale (someone else may have acted too).
    await loadQueue({ force: true });
  }
}

/**
 * 并发数是服务端设置（要落盘、要重启后仍然生效），不是纯前端状态。
 * 保存走 PUT /api/generate/config，成功后服务端会立刻按新值泵任务，
 * 这里只需要重新拉一次快照把「进行中 x/y」更新掉。
 */
genEl.queueConcurrencySave.addEventListener('click', async () => {
  const raw = Number(genEl.queueConcurrency.value);
  const max = (genState.config && genState.config.limits
    ? genState.config.limits.queueConcurrencyMax
    : 32) || 32;
  if (!Number.isInteger(raw) || raw < 1 || raw > max) {
    toast(`并发数必须是 1–${max} 的整数`, 'error');
    // 把输入框恢复成服务端实际生效的值，别让一个非法数字留在里面冒充设置。
    syncQueueConcurrency(genState.config);
    return;
  }

  genEl.queueConcurrencySave.disabled = true;
  try {
    const config = await api('/api/generate/config', {
      method: 'PUT',
      body: JSON.stringify({ queueConcurrency: raw }),
    });
    genState.config = config;
    syncQueueConcurrency(config);
    await loadQueue({ force: true });
    scheduleQueuePoll();
    toast(`并发已设为 ${raw}`, 'ok');
  } catch (error) {
    toast(`保存失败：${error.message}`, 'error', 5200);
    syncQueueConcurrency(genState.config);
  } finally {
    genEl.queueConcurrencySave.disabled = false;
  }
});

/** 把服务端配置里的并发值同步到输入框与提示。 */
function syncQueueConcurrency(config) {
  if (!config || !config.limits) return;
  const limits = config.limits;
  if (genEl.queueConcurrency) {
    genEl.queueConcurrency.value = String(limits.queueConcurrency || 8);
    genEl.queueConcurrency.max = String(limits.queueConcurrencyMax || 32);
  }
  if (genEl.queueConcurrencyHint) {
    genEl.queueConcurrencyHint.textContent =
      `当前 ${limits.queueConcurrency || 8}，范围 1–${limits.queueConcurrencyMax || 32}。`;
  }
}

genEl.queuePauseBtn.addEventListener('click', async () => {
  const next = !(queueState.snapshot && queueState.snapshot.paused);
  try {
    const data = await api('/api/generate/queue/pause', {
      method: 'POST',
      body: JSON.stringify({ paused: next }),
    });
    if (data.queue) queueState.snapshot = data.queue;
    renderQueue({ force: true });
    scheduleQueuePoll();
    toast(next ? '队列已暂停，正在执行的任务仍会跑完' : '队列已继续', 'ok');
  } catch (error) {
    toast(error.message, 'error', 5200);
  }
});

genEl.queueClearBtn.addEventListener('click', async () => {
  try {
    const data = await api('/api/generate/queue/clear', { method: 'POST', body: JSON.stringify({}) });
    queueState.expanded.clear();
    if (data.queue) queueState.snapshot = data.queue;
    renderQueue({ force: true });
    toast(`已清除 ${data.removed} 条已结束的任务`, 'ok');
  } catch (error) {
    toast(error.message, 'error', 5200);
  }
});

genEl.queueRefreshBtn.addEventListener('click', async () => {
  await loadQueue({ announce: true, force: true });
  scheduleQueuePoll();
  toast('队列已刷新');
});

/**
 * Import one bitmap a queued job produced.
 *
 * The prompt comes from the job's frozen label — not from the textarea — for the
 * same reason the direct path freezes it: the operator has almost certainly
 * edited the prompt since queueing, and storing the live value would attach the
 * wrong prompt to this image.
 */
async function importQueuedImage(job, image, button) {
  const key = `${job.id}#${image.index}`;
  if (queueState.imported.has(key)) return;

  button.disabled = true;
  button.replaceChildren(el('span', 'spinner'), el('span', null, '导入中…'));

  const total = job.result.images.length;
  const prompt = job.label.prompt || '';
  const title = autoTitle(prompt, image.index, total);
  try {
    // 优先走「生成记录」那条路：服务端手里已经有这张图的原图地址、以及它所属的
    // 网关源站，不需要把地址再经浏览器传一遍。本机/内网部署的网关（例如
    // 127.0.0.1:4399）**只有这条路径能过下载校验**——把地址回传给 /api/images
    // 会被 SSRF 规则当成内网地址拒掉，表现为「生成成功但导入 400」。
    const created = image.recordId
      ? await api(`/api/generations/${encodeURIComponent(image.recordId)}/import`, {
          method: 'POST',
          body: JSON.stringify({ title, prompt, tags: genEl.tags.value.trim() }),
        })
      : await api('/api/images', {
          method: 'POST',
          body: JSON.stringify({
            url: image.url,
            title,
            prompt,
            model: job.label.model || '',
            aspectRatio: image.size || job.label.size || '',
            tags: genEl.tags.value.trim(),
            provenance: {
              source: 'AI 生成',
              mode: job.label.mode,
              model: job.label.model,
              size: image.size || job.label.size || '',
              generatedAt: job.result.generatedAt,
              groupIndex: image.index,
              groupTotal: total,
              referenceCount: job.label.referenceCount,
              urlExpiresAt: image.expiresAt || '',
              queueJobId: job.id,
            },
          }),
        });
    queueState.imported.add(key);
    toast(`《${created.image.title}》已导入图库`, 'ok');
    await loadImages();
    renderQueue({ force: true });
  } catch (error) {
    button.disabled = false;
    button.textContent = '导入图库';
    toast(`导入失败：${error.message}`, 'error', 5200);
  }
}

function resetQueuePanel() {
  stopQueuePoll();
  queueState.snapshot = { paused: false, running: 0, pending: 0, settled: 0, maxPending: 0, jobs: [] };
  queueState.imported = new Set();
  queueState.expanded = new Set();
  queueState.signature = '';
  renderQueue({ force: true });
}

function resetGenPanel() {
  for (const ref of genState.refs) revokePreview(ref);
  genState.refs = [];
  genState.results = [];
  genState.request = null;
  genState.prompt = '';
  genState.generatedAt = '';
  genState.busy = false;
  genEl.prompt.value = '';
  refreshPromptCount();
  genEl.tags.value = '';
  genEl.outputFormat.value = '';
  genEl.background.value = '';
  genEl.webSearch.checked = false;
  genEl.banner.hidden = true;
  genEl.progress.textContent = '';
  genEl.report.replaceChildren();
  genEl.configBanner.hidden = true;
  renderRefs();
  renderGenResults();
}

/* ------------------------------ metrics ------------------------------ */

const metricsEl = {
  refresh: document.getElementById('metricsRefreshBtn'),
  clear: document.getElementById('metricsClearBtn'),
  stamp: document.getElementById('metricsStamp'),
  overall: document.getElementById('metricsOverall'),
  models: document.getElementById('metricsModels'),
  images: document.getElementById('metricsImages'),
  recent: document.getElementById('metricsRecent'),
};

const metricsState = { data: null, loading: false };

function tableRow(cells) {
  const tr = document.createElement('tr');
  for (const cell of cells) {
    const td = document.createElement('td');
    if (cell && typeof cell === 'object') {
      td.textContent = cell.text === undefined || cell.text === null ? '' : String(cell.text);
      if (cell.className) td.className = cell.className;
    } else {
      td.textContent = cell === undefined || cell === null ? '' : String(cell);
    }
    tr.appendChild(td);
  }
  return tr;
}

function emptyRow(columns, text) {
  const tr = document.createElement('tr');
  const td = el('td', 'empty-cell', text);
  td.colSpan = columns;
  tr.appendChild(td);
  return tr;
}

function metricCard(label, value, note) {
  const card = el('div', 'metric-card');
  card.appendChild(el('span', 'metric-label', label));
  card.appendChild(el('strong', 'metric-value', value));
  card.appendChild(el('span', 'metric-note', note));
  return card;
}

function percent(value) {
  if (value === null || value === undefined) return '—';
  return `${Math.round(Number(value) * 100)}%`;
}

function renderMetrics() {
  const data = metricsState.data;
  if (!data) return;
  const overall = data.overall || {};

  metricsEl.stamp.textContent = `统计时间 ${formatDate(data.generatedAt)} · 最多保留 ${data.capacity} 条样本`;

  metricsEl.overall.replaceChildren(
    metricCard('请求总数', String(overall.runs ?? 0), `成功 ${overall.ok ?? 0} · 失败 ${overall.failed ?? 0}`),
    metricCard('平均出图时间', formatMs(overall.avgMs), `中位数 ${formatMs(overall.medianMs)}`),
    metricCard('P95', formatMs(overall.p95Ms), `最慢 ${formatMs(overall.maxMs)}`),
    metricCard('每张平均', formatMs(overall.avgMsPerImage), '组图按张数分摊，非逐张计时'),
    metricCard('累计出图', String(overall.images ?? 0), `覆盖 ${overall.models ?? 0} 个模型`),
  );

  const modelBody = metricsEl.models.querySelector('tbody');
  modelBody.replaceChildren();
  if (!data.models.length) {
    modelBody.appendChild(emptyRow(10, '还没有样本。生成一次之后这里会出现数据。'));
  } else {
    for (const row of data.models) {
      modelBody.appendChild(
        tableRow([
          row.model,
          `${row.ok} / ${row.runs}`,
          percent(row.successRate),
          { text: formatMs(row.avgMs), className: 'strong-cell' },
          formatMs(row.medianMs),
          formatMs(row.p95Ms),
          formatMs(row.minMs),
          formatMs(row.maxMs),
          String(row.images),
          formatMs(row.avgMsPerImage),
        ]),
      );
    }
  }

  const imageBody = metricsEl.images.querySelector('tbody');
  imageBody.replaceChildren();
  if (!data.images.length) {
    imageBody.appendChild(emptyRow(8, '还没有成功出图的样本。'));
  } else {
    for (const row of data.images) {
      imageBody.appendChild(
        tableRow([
          formatDate(row.at),
          row.model,
          (GEN_MODES[row.mode] || {}).label || row.mode || '—',
          row.size || '—',
          `${row.index} / ${row.total}`,
          formatMs(row.requestMs),
          formatMs(row.perImageMs),
          { text: row.measured ? '实测' : '按张数分摊', className: row.measured ? 'ok-cell' : 'muted-cell' },
        ]),
      );
    }
  }

  const recentBody = metricsEl.recent.querySelector('tbody');
  recentBody.replaceChildren();
  if (!data.recent.length) {
    recentBody.appendChild(emptyRow(8, '还没有请求记录。'));
  } else {
    for (const row of data.recent) {
      recentBody.appendChild(
        tableRow([
          formatDate(row.at),
          row.model,
          (GEN_MODES[row.mode] || {}).label || row.mode || '—',
          row.size || '—',
          formatMs(row.durationMs),
          {
            text: row.ok ? `成功 · ${row.imageCount} 张` : '失败',
            className: row.ok ? 'ok-cell' : 'bad-cell',
          },
          row.source === 'queue' ? '队列' : '直接',
          row.error || '',
        ]),
      );
    }
  }
}

async function loadMetrics() {
  if (metricsState.loading) return;
  metricsState.loading = true;
  try {
    metricsState.data = await api('/api/metrics');
    renderMetrics();
  } catch (error) {
    toast(`指标加载失败：${error.message}`, 'error');
  } finally {
    metricsState.loading = false;
  }
}

metricsEl.refresh.addEventListener('click', async () => {
  await loadMetrics();
  toast('指标已刷新');
});

metricsEl.clear.addEventListener('click', async () => {
  if (!window.confirm('确定清空全部耗时历史吗？这只删除统计数据，不影响已入库的作品。')) return;
  metricsEl.clear.disabled = true;
  try {
    metricsState.data = await api('/api/metrics', { method: 'DELETE' });
    renderMetrics();
    toast('耗时历史已清空', 'ok');
  } catch (error) {
    toast(error.message, 'error', 5200);
  } finally {
    metricsEl.clear.disabled = false;
  }
});

/* ------------------------------ events ------------------------------ */

const eventsEl = {
  level: document.getElementById('eventLevel'),
  auto: document.getElementById('eventAuto'),
  stats: document.getElementById('eventStats'),
  list: document.getElementById('eventList'),
  empty: document.getElementById('eventEmpty'),
  refresh: document.getElementById('eventRefreshBtn'),
  copy: document.getElementById('eventCopyBtn'),
  clear: document.getElementById('eventClearBtn'),
};

const eventsState = { entries: [], loading: false, timer: 0 };

const EVENT_LEVEL_LABEL = { debug: 'debug', info: 'info', warn: 'warn', error: 'error' };

/** `2026-10-28T12:03:39.000Z` → `20:03:39`（本地时区，日志看的是「刚才」）。 */
function eventClock(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

function renderEvents() {
  const { entries } = eventsState;
  eventsEl.list.replaceChildren();
  eventsEl.empty.hidden = entries.length > 0;
  eventsEl.empty.textContent = '暂时没有符合条件的事件。';

  for (const entry of entries) {
    const row = document.createElement('li');
    row.className = 'log-row';

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = eventClock(entry.at);
    time.title = entry.at;

    const level = document.createElement('span');
    level.className = `log-level is-${entry.level}`;
    level.textContent = EVENT_LEVEL_LABEL[entry.level] || entry.level;

    const scope = document.createElement('span');
    scope.className = 'log-scope';
    scope.textContent = entry.scope;

    const message = document.createElement('span');
    message.className = 'log-msg';
    message.textContent = entry.message;

    row.append(time, level, scope, message);
    eventsEl.list.append(row);
  }
}

async function loadEvents({ immediate = false } = {}) {
  if (eventsState.loading) return;
  eventsState.loading = true;
  try {
    const level = eventsEl.level.value || 'debug';
    const data = await api(`/api/logs?level=${encodeURIComponent(level)}&limit=200`);
    eventsState.entries = Array.isArray(data.entries) ? data.entries : [];
    eventsEl.stats.textContent = `共 ${data.size}/${data.limit} 条${data.dropped ? `（已滚掉 ${data.dropped} 条）` : ''}`;
    renderEvents();
  } catch (error) {
    // 轮询失败不该每次都弹 toast——那会把界面刷成噪音。手动点「刷新」时才提示，
    // 但**面板里**必须留一行字：否则空列表和「请求挂了」长得一模一样。
    eventsEl.stats.textContent = '加载失败';
    eventsEl.list.replaceChildren();
    eventsEl.empty.hidden = false;
    eventsEl.empty.textContent = `日志加载失败：${error.message}`;
    if (immediate) toast(`日志加载失败：${error.message}`, 'error');
  } finally {
    eventsState.loading = false;
  }
}

function scheduleEventRefresh(on) {
  window.clearInterval(eventsState.timer);
  eventsState.timer = 0;
  if (!on || !eventsEl.auto.checked) return;
  eventsState.timer = window.setInterval(() => {
    // 标签页切到后台就别再打了，回来时 setTab 会补一次。
    if (document.hidden) return;
    void loadEvents();
  }, 5000);
}

eventsEl.level.addEventListener('change', () => void loadEvents({ immediate: true }));
eventsEl.auto.addEventListener('change', () => scheduleEventRefresh(!document.getElementById('panel-events').hidden));
eventsEl.refresh.addEventListener('click', () => void loadEvents({ immediate: true }));

eventsEl.copy.addEventListener('click', async () => {
  const text = eventsState.entries
    .map((entry) => `${entry.at}\t${entry.level}\t${entry.scope}\t${entry.message}`)
    .join('\n');
  if (!text) {
    toast('当前没有可复制的日志', 'info');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制 ${eventsState.entries.length} 条日志`, 'ok');
  } catch {
    toast('浏览器拒绝了剪贴板访问，请手动选中复制', 'error', 5200);
  }
});

eventsEl.clear.addEventListener('click', async () => {
  if (!window.confirm('清空服务进程里的运行日志？这只清日志，不影响作品和指标。')) return;
  eventsEl.clear.disabled = true;
  try {
    await api('/api/logs', { method: 'DELETE' });
    await loadEvents({ immediate: true });
    toast('运行日志已清空', 'ok');
  } catch (error) {
    toast(error.message, 'error', 5200);
  } finally {
    eventsEl.clear.disabled = false;
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !document.getElementById('panel-events').hidden && state.authenticated) {
    void loadEvents();
  }
});
/* ------------------------------ export ------------------------------ */

/** Save `value` as pretty-printed JSON under `filename`. */
/* ---------------------- 最近 24 小时生成记录 ---------------------- */

const recentEl = {
  grid: document.getElementById('recentGrid'),
  stats: document.getElementById('recentStats'),
  empty: document.getElementById('recentEmpty'),
  tags: document.getElementById('recentTags'),
  refresh: document.getElementById('recentRefreshBtn'),
  importAll: document.getElementById('recentImportAllBtn'),
  clear: document.getElementById('recentClearBtn'),
  count: document.getElementById('tabRecentCount'),
};

const recentState = { entries: [], loading: false, busy: false, lightboxId: '' };

/** 「3 分钟前」比绝对时间更能回答「这是不是我刚才那张」。 */
function recentAge(iso) {
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff) || diff < 0) return '刚刚';
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  return `${Math.floor(diff / 3_600_000)} 小时前`;
}

function recentLeft(iso) {
  const diff = Date.parse(iso) - Date.now();
  if (!Number.isFinite(diff) || diff <= 0) return '即将过期';
  const hours = diff / 3_600_000;
  // 别写成「24 小时后删除」：窄屏上换行会把「删除」单独甩到下一行，看着像个按钮。
  // 「到期即删」这层意思放在 title 里。
  return hours < 1
    ? `剩 ${Math.max(1, Math.round(diff / 60_000))} 分钟`
    : `剩 ${Math.round(hours)} 小时`;
}

/**
 * 卡片上的模型名：去掉 `doubao-` 前缀和末尾的日期版本号。
 * 完整的 id 仍然放在 title 里——卡片只有 200px 宽，写全了只能被省略号切掉。
 */
function shortModel(model) {
  return String(model || '')
    .replace(/^doubao-/, '')
    .replace(/-\d{6,8}$/, '');
}

function renderRecent() {
  const { entries } = recentState;
  recentEl.count.textContent = String(entries.length);
  recentEl.empty.hidden = entries.length > 0;
  recentEl.empty.textContent = '最近 24 小时还没有生成记录。';

  const stored = entries.filter((entry) => entry.stored).length;
  const bytes = entries.reduce((sum, entry) => sum + (entry.bytes || 0), 0);
  recentEl.stats.textContent = entries.length
    ? `共 ${entries.length} 张 · 已下载 ${stored} 张 · 占用 ${formatBytes(bytes) || '—'}`
    : '还没有记录';
  recentEl.importAll.disabled = recentState.busy || !entries.some((entry) => !entry.importedId);

  recentEl.grid.replaceChildren(...entries.map(buildRecentCard));
}

function buildRecentCard(entry) {
  const card = el('div', `recent-card${entry.importedId ? ' is-imported' : ''}`);

  const thumb = el('button', 'recent-thumb');
  thumb.type = 'button';
  thumb.title = '点击放大查看';
  thumb.setAttribute('aria-label', `放大查看：${entry.promptPreview || '未命名'}`);
  if (entry.unavailable) {
    thumb.appendChild(el('span', 'recent-fallback', '原图链接已失效'));
    // 原因只留在服务端记录里就等于没留：线上挂着 CDN 时 5xx 的响应体会被换成通用
    // 错误页，用户在浏览器里永远看不到这句话。悬停能看到，放大后还能看到全文。
    thumb.title = `原图取不回来：${entry.unavailable}`;
  } else {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = entry.promptPreview || '生成结果';
    img.src = entry.fileUrl;
    // 回源失败要看得见，而不是一张永远空着的灰图。
    img.addEventListener('error', () => {
      img.remove();
      if (!thumb.querySelector('.recent-fallback')) {
        thumb.appendChild(el('span', 'recent-fallback', '原图加载失败，点开重试'));
      }
    });
    thumb.appendChild(img);
  }
  thumb.addEventListener('click', () => openLightbox(entry.id));
  card.appendChild(thumb);

  card.appendChild(el('p', 'recent-prompt', entry.promptPreview || '（没有记录到提示词）'));

  const meta = el('div', 'gen-meta');
  meta.appendChild(el('span', 'chip', recentAge(entry.createdAt)));
  if (entry.model) {
    const model = el('span', 'chip', shortModel(entry.model));
    model.title = entry.model;
    meta.appendChild(model);
  }
  if (entry.size) meta.appendChild(el('span', 'chip', entry.size));
  if (entry.importedId) meta.appendChild(el('span', 'chip ok', '已导入'));
  else {
    const left = el('span', 'chip', recentLeft(entry.expiresAt));
    left.title = '到期后这条记录与原图文件会一起删除';
    meta.appendChild(left);
  }
  card.appendChild(meta);

  const actions = el('div', 'card-actions');
  const importBtn = el('button', 'btn-primary btn-sm', entry.importedId ? '已导入图库' : '导入图库');
  importBtn.type = 'button';
  importBtn.disabled = Boolean(entry.importedId) || recentState.busy || Boolean(entry.unavailable);
  importBtn.addEventListener('click', () => importRecent(entry, importBtn));
  actions.appendChild(importBtn);

  const viewBtn = el('button', 'btn btn-sm', '放大');
  viewBtn.type = 'button';
  viewBtn.addEventListener('click', () => openLightbox(entry.id));
  actions.appendChild(viewBtn);

  const delBtn = el('button', 'btn btn-sm btn-ghost', '删除');
  delBtn.type = 'button';
  delBtn.addEventListener('click', () => deleteRecent(entry));
  actions.appendChild(delBtn);

  card.appendChild(actions);
  return card;
}

async function loadRecent({ announce = false } = {}) {
  if (recentState.loading) return;
  recentState.loading = true;
  recentEl.stats.textContent = '加载中…';
  try {
    const data = await api('/api/generations');
    recentState.entries = Array.isArray(data.entries) ? data.entries : [];
    renderRecent();
  } catch (error) {
    // 空列表和「请求挂了」必须能区分开，否则点进来只看到一片空白。
    recentEl.stats.textContent = '加载失败';
    recentEl.grid.replaceChildren();
    recentEl.empty.hidden = false;
    recentEl.empty.textContent = `生成记录加载失败：${error.message}`;
    if (announce) toast(`生成记录加载失败：${error.message}`, 'error', 5200);
  } finally {
    recentState.loading = false;
  }
}

async function importRecent(entry, button) {
  if (recentState.busy || entry.importedId) return;
  if (button) {
    button.disabled = true;
    button.replaceChildren(el('span', 'spinner'), el('span', null, '导入中…'));
  }
  try {
    const created = await api(`/api/generations/${encodeURIComponent(entry.id)}/import`, {
      method: 'POST',
      body: JSON.stringify({ tags: recentEl.tags.value.trim() }),
    });
    entry.importedId = created.image.id;
    toast(`《${created.image.title}》已导入图库`, 'ok');
    await loadImages();
  } catch (error) {
    toast(`导入失败：${error.message}`, 'error', 5200);
  } finally {
    renderRecent();
    syncLightbox();
  }
}

async function deleteRecent(entry) {
  if (!window.confirm('从生成记录里删掉这张图？它的原图文件会一起删除，不能撤销。')) return;
  try {
    await api(`/api/generations/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
    recentState.entries = recentState.entries.filter((item) => item.id !== entry.id);
    if (recentState.lightboxId === entry.id) closeLightbox();
    renderRecent();
    toast('已从生成记录里删除', 'ok');
  } catch (error) {
    toast(error.message, 'error', 5200);
  }
}

recentEl.refresh.addEventListener('click', () => void loadRecent({ announce: true }));

recentEl.importAll.addEventListener('click', async () => {
  const pending = recentState.entries.filter((entry) => !entry.importedId && !entry.unavailable);
  if (!pending.length) {
    toast('没有需要导入的记录', 'info');
    return;
  }
  recentState.busy = true;
  renderRecent();
  let ok = 0;
  for (const [index, entry] of pending.entries()) {
    recentEl.stats.textContent = `正在导入 ${index + 1} / ${pending.length} …`;
    const before = entry.importedId;
    await importRecent(entry);
    if (!before && entry.importedId) ok += 1;
  }
  recentState.busy = false;
  renderRecent();
  toast(`导入完成：成功 ${ok} 张，失败 ${pending.length - ok} 张`, ok ? 'ok' : 'error', 4200);
});

recentEl.clear.addEventListener('click', async () => {
  if (!window.confirm('清空全部生成记录？所有未导入的原图文件会被删除，不能撤销。')) return;
  recentEl.clear.disabled = true;
  try {
    const data = await api('/api/generations', { method: 'DELETE' });
    recentState.entries = [];
    renderRecent();
    toast(`已清空 ${data.removed || 0} 条生成记录`, 'ok');
  } catch (error) {
    toast(error.message, 'error', 5200);
  } finally {
    recentEl.clear.disabled = false;
  }
});

/* --------------------------- 放大查看（灯箱） --------------------------- */

const lightboxEl = {
  root: document.getElementById('lightbox'),
  image: document.getElementById('lightboxImage'),
  title: document.getElementById('lightboxTitle'),
  meta: document.getElementById('lightboxMeta'),
  close: document.getElementById('lightboxClose'),
  prev: document.getElementById('lightboxPrev'),
  next: document.getElementById('lightboxNext'),
  import: document.getElementById('lightboxImport'),
};

function lightboxIndex() {
  return recentState.entries.findIndex((entry) => entry.id === recentState.lightboxId);
}

function syncLightbox() {
  const index = lightboxIndex();
  if (index === -1) {
    closeLightbox();
    return;
  }
  const entry = recentState.entries[index];
  lightboxEl.title.textContent = entry.promptPreview || '（没有记录到提示词）';
  const meta = [
    entry.model || '未知模型',
    entry.size || '',
    `${recentAge(entry.createdAt)}生成`,
    entry.importedId ? '已导入图库' : recentLeft(entry.expiresAt),
  ].filter(Boolean);
  if (entry.unavailable) meta.push(`原图取不回来：${entry.unavailable}`);
  lightboxEl.meta.textContent = meta.join(' · ');

  // 同一张图重复打开时不要重设 src，否则每次都会重新下载一遍。
  if (lightboxEl.image.dataset.entryId !== entry.id) {
    lightboxEl.image.dataset.entryId = entry.id;
    lightboxEl.image.src = entry.fileUrl;
  }
  lightboxEl.image.alt = entry.promptPreview || '生成结果';

  const single = recentState.entries.length < 2;
  lightboxEl.prev.disabled = single;
  lightboxEl.next.disabled = single;
  lightboxEl.import.disabled = Boolean(entry.importedId) || Boolean(entry.unavailable);
  lightboxEl.import.textContent = entry.importedId ? '已导入图库' : '导入图库';
}

function openLightbox(id) {
  recentState.lightboxId = id;
  lightboxEl.root.hidden = false;
  document.body.classList.add('lightbox-open');
  syncLightbox();
  lightboxEl.close.focus();
}

function closeLightbox() {
  recentState.lightboxId = '';
  lightboxEl.root.hidden = true;
  document.body.classList.remove('lightbox-open');
  lightboxEl.image.removeAttribute('src');
  delete lightboxEl.image.dataset.entryId;
}

function stepLightbox(delta) {
  const entries = recentState.entries;
  if (entries.length < 2) return;
  const index = lightboxIndex();
  const next = (index + delta + entries.length) % entries.length;
  recentState.lightboxId = entries[next].id;
  syncLightbox();
}

lightboxEl.close.addEventListener('click', closeLightbox);
lightboxEl.prev.addEventListener('click', () => stepLightbox(-1));
lightboxEl.next.addEventListener('click', () => stepLightbox(1));
lightboxEl.root.addEventListener('click', (event) => {
  // 只有点在遮罩本身（不是面板里的任何东西）时才关闭。
  if (event.target === lightboxEl.root) closeLightbox();
});
lightboxEl.import.addEventListener('click', () => {
  const entry = recentState.entries[lightboxIndex()];
  if (entry) void importRecent(entry, lightboxEl.import);
});

document.addEventListener('keydown', (event) => {
  if (lightboxEl.root.hidden) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeLightbox();
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    stepLightbox(-1);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    stepLightbox(1);
  }
});

function downloadJson(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 4000);
}

document.getElementById('exportBtn').addEventListener('click', async () => {
  try {
    const data = await api('/api/export');
    downloadJson(data, `still-gallery-export-${new Date().toISOString().slice(0, 10)}.json`);
    toast('导出已开始下载', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
});

document.getElementById('reloadBtn').addEventListener('click', async () => {
  await loadImages();
  toast('列表已刷新');
});

/* ---------------------------- 后台图库（私有） ---------------------------- */

const vaultEl = {
  count: document.getElementById('tabVaultCount'),
  quota: document.getElementById('vaultQuota'),
  drop: document.getElementById('vaultDrop'),
  file: document.getElementById('vaultFileInput'),
  pick: document.getElementById('vaultPickBtn'),
  uploadList: document.getElementById('vaultUploadList'),
  recentBox: document.getElementById('vaultRecentBox'),
  recentStats: document.getElementById('vaultRecentStats'),
  recentGrid: document.getElementById('vaultRecentGrid'),
  recentEmpty: document.getElementById('vaultRecentEmpty'),
  recentRefresh: document.getElementById('vaultRecentRefresh'),
  recentImport: document.getElementById('vaultRecentImportBtn'),
  search: document.getElementById('vaultSearch'),
  sort: document.getElementById('vaultSort'),
  refresh: document.getElementById('vaultRefreshBtn'),
  selectAll: document.getElementById('vaultSelectAll'),
  selCount: document.getElementById('vaultSelCount'),
  download: document.getElementById('vaultDownloadBtn'),
  clearSel: document.getElementById('vaultClearSelBtn'),
  batchDelete: document.getElementById('vaultBatchDeleteBtn'),
  grid: document.getElementById('vaultGrid'),
  empty: document.getElementById('vaultEmpty'),
  pager: document.getElementById('vaultPager'),
};

/** 一个上传请求最多带几张。和 server.mjs 的 MAX_VAULT_UPLOAD_FILES 对齐。 */
const VAULT_UPLOAD_BATCH = 8;
const VAULT_PAGE_SIZE = 24;

const vaultState = {
  items: [],
  total: 0,
  stats: null,
  query: '',
  sort: 'newest',
  page: 0,
  selected: new Set(),
  loading: false,
  uploading: false,
  downloading: false,
  importing: false,
  recentLoaded: false,
  recentEntries: [],
  recentSelected: new Set(),
};

function renderVaultQuota() {
  const stats = vaultState.stats;
  if (!stats) {
    vaultEl.quota.textContent = '容量未知';
    return;
  }
  const limit = stats.maxBytes ? `${Math.round(stats.maxBytes / 1024 / 1024 / 1024)}GB` : '不限';
  const used = stats.bytes ? formatBytes(stats.bytes) : '0 B';
  vaultEl.quota.textContent = `共 ${stats.count} 张 · 占用 ${used} / 上限 ${limit} · 单张上限 15MB`;
}

function renderVaultPager() {
  const pages = Math.max(1, Math.ceil(vaultState.total / VAULT_PAGE_SIZE));
  if (pages <= 1) {
    vaultEl.pager.replaceChildren();
    return;
  }
  const prev = el('button', 'btn btn-sm', '上一页');
  prev.type = 'button';
  prev.disabled = vaultState.page === 0;
  prev.addEventListener('click', () => {
    vaultState.page = Math.max(0, vaultState.page - 1);
    void loadVault();
  });
  const next = el('button', 'btn btn-sm', '下一页');
  next.type = 'button';
  next.disabled = vaultState.page >= pages - 1;
  next.addEventListener('click', () => {
    vaultState.page += 1;
    void loadVault();
  });
  vaultEl.pager.replaceChildren(prev, el('span', 'pager-info', `第 ${vaultState.page + 1} / ${pages} 页`), next);
}

function syncVaultSelection() {
  const size = vaultState.selected.size;
  const visible = vaultState.items;
  const selectedVisible = visible.filter((item) => vaultState.selected.has(item.id));
  const bytes = selectedVisible.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);

  vaultEl.batchDelete.disabled = size === 0;
  vaultEl.batchDelete.textContent = size ? `删除选中（${size}）` : '删除选中';
  vaultEl.download.disabled = size === 0 || vaultState.downloading;
  vaultEl.download.textContent = vaultState.downloading
    ? '打包中…'
    : size
      ? `下载选中（${size}）`
      : '下载选中';
  vaultEl.clearSel.disabled = size === 0;
  vaultEl.selCount.textContent = size
    ? `已选 ${size} 张 · 约 ${bytes ? formatBytes(bytes) : '0 B'}`
    : '已选 0 张';

  // 全选框三态：全选 / 部分（横杠）/ 一个都没选。少了「部分」这一态，用户会以为
  // 点了全选其实没生效。
  vaultEl.selectAll.disabled = visible.length === 0;
  vaultEl.selectAll.checked = visible.length > 0 && selectedVisible.length === visible.length;
  vaultEl.selectAll.indeterminate =
    selectedVisible.length > 0 && selectedVisible.length < visible.length;
}

function buildVaultEditor(item, editor) {
  const titleField = document.createElement('input');
  titleField.type = 'text';
  titleField.maxLength = 120;
  titleField.value = item.title || '';
  titleField.setAttribute('aria-label', '标题');

  const tagsField = document.createElement('input');
  tagsField.type = 'text';
  tagsField.value = (item.tags || []).join(', ');
  tagsField.placeholder = '标签，英文逗号分隔';
  tagsField.setAttribute('aria-label', '标签');

  const promptField = document.createElement('textarea');
  promptField.rows = 3;
  promptField.value = item.prompt || '';
  promptField.placeholder = '提示词 / 备注（可选）';
  promptField.setAttribute('aria-label', '提示词');

  const save = el('button', 'btn btn-sm', '保存');
  save.type = 'button';
  const cancel = el('button', 'btn btn-sm btn-ghost', '取消');
  cancel.type = 'button';

  save.addEventListener('click', async () => {
    const title = titleField.value.trim();
    if (!title) {
      toast('标题不能为空', 'error');
      return;
    }
    save.disabled = true;
    try {
      const result = await api(`/api/vault/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ title, tags: tagsField.value, prompt: promptField.value }),
      });
      Object.assign(item, result.item);
      editor.hidden = true;
      renderVault();
      toast('已保存', 'ok');
    } catch (error) {
      toast(`保存失败：${error.message}`, 'error', 5200);
    } finally {
      save.disabled = false;
    }
  });
  cancel.addEventListener('click', () => {
    editor.hidden = true;
  });

  const actions = el('div', 'vault-editor-actions');
  actions.append(save, cancel);
  editor.append(titleField, tagsField, promptField, actions);
}

function buildVaultCard(item) {
  const card = el('div', 'vault-card');
  card.dataset.id = item.id;

  const thumb = document.createElement('a');
  thumb.className = 'vault-thumb';
  thumb.href = item.fileUrl;
  thumb.target = '_blank';
  thumb.rel = 'noopener';
  thumb.title = '在新标签页打开原图';
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = item.title || '图库图片';
  img.src = item.fileUrl;
  img.addEventListener('error', () => {
    img.remove();
    if (!thumb.querySelector('.recent-fallback')) {
      thumb.appendChild(el('span', 'recent-fallback', '加载失败'));
    }
  });
  thumb.appendChild(img);

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'vault-check';
  check.checked = vaultState.selected.has(item.id);
  check.setAttribute('aria-label', `选择 ${item.title || '图片'}`);
  check.addEventListener('change', () => {
    if (check.checked) vaultState.selected.add(item.id);
    else vaultState.selected.delete(item.id);
    card.classList.toggle('is-selected', check.checked);
    syncVaultSelection();
  });
  card.classList.toggle('is-selected', check.checked);
  card.append(thumb, check);

  const body = el('div', 'vault-body');
  const title = el('p', 'vault-title', item.title || '未命名');
  title.title = item.title || '';
  body.appendChild(title);

  if (item.prompt) {
    const prompt = el('p', 'vault-prompt', item.prompt);
    prompt.title = item.prompt;
    body.appendChild(prompt);
  }

  const meta = el('div', 'gen-meta');
  meta.appendChild(el('span', 'chip', item.source === 'generation' ? '来自生成' : '本地上传'));
  meta.appendChild(el('span', 'chip', formatBytes(item.bytes) || '—'));
  meta.appendChild(el('span', 'chip', formatDate(item.createdAt)));
  body.appendChild(meta);

  if (Array.isArray(item.tags) && item.tags.length) {
    const tags = el('div', 'vault-tags');
    for (const tag of item.tags) tags.appendChild(el('span', 'chip', `#${tag}`));
    body.appendChild(tags);
  }

  const actions = el('div', 'card-actions');
  const editBtn = el('button', 'btn btn-sm', '编辑');
  editBtn.type = 'button';
  const delBtn = el('button', 'btn btn-sm btn-danger', '删除');
  delBtn.type = 'button';
  actions.append(editBtn, delBtn);
  body.appendChild(actions);

  const editor = el('div', 'vault-editor');
  editor.hidden = true;
  buildVaultEditor(item, editor);
  body.appendChild(editor);

  editBtn.addEventListener('click', () => {
    editor.hidden = !editor.hidden;
    editBtn.textContent = editor.hidden ? '编辑' : '收起';
  });
  delBtn.addEventListener('click', () => void deleteVaultItem(item));

  card.appendChild(body);
  return card;
}

function renderVault() {
  vaultEl.count.textContent = String(vaultState.total);
  vaultEl.grid.replaceChildren(...vaultState.items.map(buildVaultCard));
  vaultEl.empty.hidden = vaultState.items.length > 0 || vaultState.loading;
  if (!vaultState.items.length && !vaultState.loading) {
    vaultEl.empty.textContent = vaultState.query
      ? `没有匹配「${vaultState.query}」的图片。`
      : '后台图库还是空的。上传一张，或者从生成记录里导入。';
  }
  syncVaultSelection();
  renderVaultPager();
  renderVaultQuota();
}

async function loadVault({ announce = false } = {}) {
  if (vaultState.loading) return;
  vaultState.loading = true;
  if (!vaultState.items.length) vaultEl.quota.textContent = '加载中…';
  try {
    const params = new URLSearchParams({
      q: vaultState.query,
      sort: vaultState.sort,
      limit: String(VAULT_PAGE_SIZE),
      offset: String(vaultState.page * VAULT_PAGE_SIZE),
    });
    const data = await api(`/api/vault?${params.toString()}`);
    vaultState.items = Array.isArray(data.items) ? data.items : [];
    vaultState.total = Number(data.total) || 0;
    vaultState.stats = data.stats || null;
    // 翻页/搜索后，选中集合里可能混着已经不在当前页的 id；不清空，但也不该
    // 让「删除选中」删到看不见的东西——这里按当前结果过滤一次。
    const visible = new Set(vaultState.items.map((item) => item.id));
    vaultState.selected = new Set([...vaultState.selected].filter((id) => visible.has(id)));
    renderVault();
  } catch (error) {
    vaultEl.quota.textContent = '加载失败';
    vaultEl.grid.replaceChildren();
    vaultEl.empty.hidden = false;
    vaultEl.empty.textContent = `后台图库加载失败：${error.message}`;
    if (announce) toast(`后台图库加载失败：${error.message}`, 'error', 5200);
  } finally {
    vaultState.loading = false;
  }
}

async function deleteVaultItem(item) {
  const label = item.title || '未命名';
  if (!window.confirm(`从后台图库删除《${label}》？图片文件会一起删除，不能撤销。`)) return;
  try {
    await api(`/api/vault/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    vaultState.selected.delete(item.id);
    toast('已删除', 'ok');
    await loadVault();
  } catch (error) {
    toast(`删除失败：${error.message}`, 'error', 5200);
  }
}

vaultEl.batchDelete.addEventListener('click', async () => {
  const ids = [...vaultState.selected];
  if (!ids.length) return;
  if (!window.confirm(`删除选中的 ${ids.length} 张图片？图片文件会一起删除，不能撤销。`)) return;
  try {
    const result = await api('/api/vault/batch', {
      method: 'POST',
      body: JSON.stringify({ action: 'delete', ids }),
    });
    vaultState.selected.clear();
    toast(`已删除 ${result.affected} 张`, 'ok');
    await loadVault();
  } catch (error) {
    toast(`批量删除失败：${error.message}`, 'error', 5200);
  }
});

/* ---- 批量选择与打包下载 ---- */

vaultEl.selectAll.addEventListener('change', () => {
  if (vaultEl.selectAll.checked) {
    for (const item of vaultState.items) vaultState.selected.add(item.id);
  } else {
    for (const item of vaultState.items) vaultState.selected.delete(item.id);
  }
  renderVault();
});

vaultEl.clearSel.addEventListener('click', () => {
  vaultState.selected.clear();
  renderVault();
});

/**
 * 批量下载。
 *
 * 不用「逐个 `<a download>`」：同一个用户手势里连开多个下载，浏览器通常只放行第一个，
 * 用户会以为丢图了。这里让服务端打成 zip，一次响应、一次下载。
 *
 * 也不用 `api()`——它固定按 JSON 解析响应体。二进制响应必须走原始 fetch，
 * 401 需要手动抛事件，否则会话过期时会静默变成「下载了一个 0 字节文件」。
 */
async function downloadSelectedVault() {
  const ids = [...vaultState.selected];
  if (!ids.length || vaultState.downloading) return;
  vaultState.downloading = true;
  syncVaultSelection();
  try {
    const response = await fetch('/api/vault/archive', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!response.ok) {
      if (response.status === 401) {
        window.dispatchEvent(new CustomEvent('sg:unauthorized', { detail: { path: '/api/vault/archive' } }));
      }
      let message = `打包失败（${response.status}）`;
      try {
        const payload = await response.json();
        if (payload && payload.error) message = payload.error;
      } catch {
        /* 非 JSON 响应（例如代理的错误页）就保留状态码 */
      }
      throw new Error(message);
    }

    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const matched = /filename="([^"]+)"/.exec(disposition);
    const filename = matched ? matched[1] : `still-gallery-vault-${Date.now()}.zip`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // 立刻 revoke 会让部分浏览器拿不到数据；10 秒足够大包写完。
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast(`已打包 ${ids.length} 张，开始下载`, 'ok');
  } catch (error) {
    toast(`下载失败：${error.message}`, 'error', 5200);
  } finally {
    vaultState.downloading = false;
    syncVaultSelection();
  }
}

vaultEl.download.addEventListener('click', () => void downloadSelectedVault());

/* ---- 上传 ---- */

/** 每个文件一行状态：批量上传里「哪一张失败了、为什么」必须能一眼看到。 */
function vaultUploadRow(file) {
  const row = el('div', 'vault-upload-row');
  const name = el('span', 'vault-upload-name', file.name);
  const status = el('span', 'vault-upload-status', '等待中');
  row.append(name, status);
  vaultEl.uploadList.appendChild(row);
  return { row, status };
}

async function uploadVaultFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  if (vaultState.uploading) {
    toast('上一批还在上传，请稍等', 'info');
    return;
  }
  if (files.length > VAULT_UPLOAD_BATCH) {
    toast(`一次最多 ${VAULT_UPLOAD_BATCH} 张，请分批上传`, 'error', 5200);
    return;
  }

  vaultState.uploading = true;
  vaultEl.uploadList.replaceChildren();
  // 一张一个请求：单张失败不会连累同批，服务端也不必把几十 MB 同时读进内存。
  const rows = files.map((file) => ({ file, ...vaultUploadRow(file) }));
  let ok = 0;

  for (const item of rows) {
    item.row.classList.add('is-busy');
    item.status.textContent = '上传中…';
    const form = new FormData();
    form.append('files', item.file, item.file.name);
    try {
      const result = await api('/api/vault/upload', { method: 'POST', body: form });
      const added = result.added && result.added[0];
      if (added) {
        ok += 1;
        item.row.classList.remove('is-busy');
        item.row.classList.add('is-ok');
        item.status.textContent = `已入库 · ${formatBytes(added.bytes) || '—'}`;
      } else {
        item.row.classList.remove('is-busy');
        item.row.classList.add('is-fail');
        item.status.textContent = (result.failed && result.failed[0] && result.failed[0].error) || '未入库';
      }
    } catch (error) {
      item.row.classList.remove('is-busy');
      item.row.classList.add('is-fail');
      item.status.textContent = error.message;
    }
  }

  vaultState.uploading = false;
  vaultEl.file.value = '';
  if (ok) {
    toast(`已上传 ${ok} 张到后台图库`, 'ok');
    vaultState.page = 0;
    await loadVault();
  } else {
    toast('没有图片入库', 'error', 5200);
  }
}

vaultEl.pick.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  vaultEl.file.click();
});

vaultEl.drop.addEventListener('click', (event) => {
  // 点按钮、复选框这些交互元素时不要再弹一次文件选择框。
  if (event.target.closest('button, input, a')) return;
  vaultEl.file.click();
});

vaultEl.file.addEventListener('change', () => {
  if (vaultEl.file.files && vaultEl.file.files.length) void uploadVaultFiles(vaultEl.file.files);
});

for (const name of ['dragenter', 'dragover']) {
  vaultEl.drop.addEventListener(name, (event) => {
    event.preventDefault();
    vaultEl.drop.classList.add('is-over');
  });
}
for (const name of ['dragleave', 'dragend', 'drop']) {
  vaultEl.drop.addEventListener(name, () => vaultEl.drop.classList.remove('is-over'));
}
vaultEl.drop.addEventListener('drop', (event) => {
  event.preventDefault();
  const files = event.dataTransfer && event.dataTransfer.files;
  if (files && files.length) void uploadVaultFiles(files);
});

/* ---- 从生成记录导入 ---- */

function renderVaultRecent() {
  const entries = vaultState.recentEntries;
  // 「没有可导入的记录」已经写在 stats 那一行里了，这里只留给加载失败用。
  vaultEl.recentEmpty.hidden = true;
  vaultEl.recentStats.textContent = entries.length
    ? `共 ${entries.length} 张可选 · 已选 ${vaultState.recentSelected.size} 张`
    : '没有可导入的记录';
  vaultEl.recentImport.disabled = vaultState.importing || vaultState.recentSelected.size === 0;
  vaultEl.recentImport.textContent = vaultState.importing ? '导入中…' : '导入选中';

  vaultEl.recentGrid.replaceChildren(
    ...entries.map((entry) => {
      const card = el('button', 'vault-recent-card');
      card.type = 'button';
      card.classList.toggle('is-selected', vaultState.recentSelected.has(entry.id));
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = entry.promptPreview || '生成结果';
      img.src = entry.fileUrl;
      card.appendChild(img);
      card.appendChild(el('span', 'vault-recent-age', recentAge(entry.createdAt)));
      card.title = entry.promptPreview || '生成结果';
      card.addEventListener('click', () => {
        if (vaultState.recentSelected.has(entry.id)) vaultState.recentSelected.delete(entry.id);
        else vaultState.recentSelected.add(entry.id);
        renderVaultRecent();
      });
      return card;
    }),
  );
}

async function loadVaultRecent({ announce = false } = {}) {
  vaultEl.recentStats.textContent = '加载中…';
  try {
    const data = await api('/api/generations');
    // 原图已经取不回来的记录导进来也是空壳，直接不列出来。
    vaultState.recentEntries = (Array.isArray(data.entries) ? data.entries : []).filter(
      (entry) => !entry.unavailable,
    );
    vaultState.recentSelected.clear();
    renderVaultRecent();
  } catch (error) {
    vaultEl.recentStats.textContent = `加载失败：${error.message}`;
    vaultEl.recentGrid.replaceChildren();
    vaultEl.recentEmpty.hidden = false;
    vaultEl.recentEmpty.textContent = `生成记录加载失败：${error.message}`;
    if (announce) toast(`生成记录加载失败：${error.message}`, 'error', 5200);
  }
}

vaultEl.recentBox.addEventListener('toggle', () => {
  if (vaultEl.recentBox.open && !vaultState.recentLoaded) {
    vaultState.recentLoaded = true;
    void loadVaultRecent();
  }
});

vaultEl.recentRefresh.addEventListener('click', () => {
  vaultState.recentLoaded = true;
  void loadVaultRecent({ announce: true });
});

vaultEl.recentImport.addEventListener('click', async () => {
  const ids = [...vaultState.recentSelected];
  if (!ids.length || vaultState.importing) return;
  vaultState.importing = true;
  renderVaultRecent();
  const imported = new Set();
  const errors = [];
  for (const id of ids) {
    try {
      await api('/api/vault/from-generation', { method: 'POST', body: JSON.stringify({ id }) });
      imported.add(id);
      vaultState.recentSelected.delete(id);
    } catch (error) {
      errors.push(error.message);
    }
  }
  vaultState.importing = false;
  // 导入成功的从可选列表里拿掉，避免重复点；失败的留着，可以重试。
  vaultState.recentEntries = vaultState.recentEntries.filter((entry) => !imported.has(entry.id));
  renderVaultRecent();
  if (imported.size) {
    toast(`已导入 ${imported.size} 张到后台图库`, 'ok');
    await loadVault();
  }
  if (errors.length) toast(`有 ${errors.length} 张导入失败：${errors[0]}`, 'error', 6000);
});

/* ---- 搜索 / 排序 / 刷新 ---- */

let vaultSearchTimer = 0;
vaultEl.search.addEventListener('input', () => {
  window.clearTimeout(vaultSearchTimer);
  vaultSearchTimer = window.setTimeout(() => {
    vaultState.query = vaultEl.search.value.trim();
    vaultState.page = 0;
    void loadVault();
  }, 280);
});

vaultEl.sort.addEventListener('change', () => {
  vaultState.sort = vaultEl.sort.value;
  vaultState.page = 0;
  void loadVault();
});

vaultEl.refresh.addEventListener('click', () => void loadVault({ announce: true }));

/* ------------------------------ 剪贴板 ------------------------------ */

const clipEl = {
  panel: document.getElementById('panel-clipboard'),
  compose: document.getElementById('clipCompose'),
  count: document.getElementById('tabClipboardCount'),
  text: document.getElementById('clipText'),
  paste: document.getElementById('clipPasteBtn'),
  imageBtn: document.getElementById('clipImageBtn'),
  file: document.getElementById('clipFileInput'),
  attachments: document.getElementById('clipAttachments'),
  save: document.getElementById('clipSaveBtn'),
  hint: document.getElementById('clipComposeHint'),
  search: document.getElementById('clipSearch'),
  stats: document.getElementById('clipStats'),
  refresh: document.getElementById('clipRefreshBtn'),
  clear: document.getElementById('clipClearBtn'),
  list: document.getElementById('clipList'),
  empty: document.getElementById('clipEmpty'),
};

/** 一条最多带几张图。和 lib/clipboard-store.mjs 的 CLIPBOARD_MAX_IMAGES 对齐。 */
const CLIP_MAX_IMAGES = 8;

/** 单条文字上限。和 lib/clipboard-store.mjs 的 CLIPBOARD_MAX_TEXT_CHARS 对齐。 */
const CLIP_MAX_CHARS = 100_000;

const clipState = {
  items: [],
  total: 0,
  stats: null,
  query: '',
  loading: false,
  saving: false,
  /** 待保存的图片：{ file, url }。url 是 createObjectURL，用完必须 revoke。 */
  pending: [],
};

/**
 * 服务端还是旧进程时，`/api/*` 的兜底会把剪贴板路由也回成「接口不存在」。
 * 那是路由没加载，不是内容有问题——直接说「重启」，比让人去数字符有用。
 */
function clipErrorText(error) {
  const message = String((error && error.message) || error || '');
  if (/接口不存在/.test(message) || /请求失败（404）/.test(message)) {
    return '服务端还在跑旧代码，没有剪贴板接口——重启服务后再试';
  }
  return message;
}

/** 相对时间。剪贴板是「刚刚复制的东西」，精确到分钟比完整日期有用。 */
function clipAge(iso) {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return '—';
  const diff = Date.now() - time;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前`;
  return formatDate(iso);
}

function syncClipCompose() {
  const chars = clipEl.text.value.trim().length;
  const images = clipState.pending.length;
  clipEl.save.disabled = clipState.saving || (!chars && !images);
  clipEl.save.textContent = clipState.saving ? '保存中…' : '保存到剪贴板';
  /**
   * 上限只写在服务端的话，用户永远是点了保存才知道——两万字贴进去，谁都会先
   * 怀疑是不是超长了。计数就摆在框下面，边打边看。
   */
  const over = chars > CLIP_MAX_CHARS;
  clipEl.hint.classList.toggle('is-over', over);
  const count = chars ? `${chars.toLocaleString('zh-CN')} / ${CLIP_MAX_CHARS.toLocaleString('zh-CN')} 字` : '';
  if (images) {
    clipEl.hint.textContent = `已附 ${images}/${CLIP_MAX_IMAGES} 张图片${count ? ` · ${count}` : ''}`;
  } else if (chars) {
    clipEl.hint.textContent = count;
  } else {
    clipEl.hint.textContent = '图片可以直接粘在这个框里，或拖进来';
  }
}

function renderClipAttachments() {
  clipEl.attachments.hidden = clipState.pending.length === 0;
  clipEl.attachments.replaceChildren(
    ...clipState.pending.map((item) => {
      const box = el('div', 'clip-attach-item');
      const img = document.createElement('img');
      img.src = item.url;
      img.alt = '待保存的图片';
      img.loading = 'lazy';
      const remove = el('button', 'clip-attach-remove', '×');
      remove.type = 'button';
      remove.title = '移除这张图片';
      remove.setAttribute('aria-label', '移除这张图片');
      remove.addEventListener('click', () => {
        URL.revokeObjectURL(item.url);
        clipState.pending = clipState.pending.filter((other) => other !== item);
        renderClipAttachments();
      });
      box.append(img, remove);
      return box;
    }),
  );
  syncClipCompose();
}

/** 把文件塞进待保存列表。非图片、超出张数的都挡在这里，而不是等到服务端回 415。 */
function addClipFiles(fileList) {
  const incoming = [...(fileList || [])].filter((file) => /^image\//i.test(file.type));
  if (!incoming.length) {
    toast('这些文件不是图片', 'error');
    return;
  }
  const room = CLIP_MAX_IMAGES - clipState.pending.length;
  if (room <= 0) {
    toast(`一条最多 ${CLIP_MAX_IMAGES} 张图片`, 'error');
    return;
  }
  if (incoming.length > room) {
    toast(`一条最多 ${CLIP_MAX_IMAGES} 张图片，多出的 ${incoming.length - room} 张已忽略`, 'error', 4600);
  }
  for (const file of incoming.slice(0, room)) {
    clipState.pending.push({ file, url: URL.createObjectURL(file) });
  }
  renderClipAttachments();
}

function clearClipCompose() {
  for (const item of clipState.pending) URL.revokeObjectURL(item.url);
  clipState.pending = [];
  clipEl.text.value = '';
  clipEl.file.value = '';
  renderClipAttachments();
}

/**
 * 一键粘贴。
 *
 * 文字和图片分开取：`readText()` 几乎到处都能用，而 `read()`（取图片）在多数
 * 浏览器里要额外授权。所以先拿文字，再「尽力」拿图片——任何一步被拒都不该让
 * 整个按钮失败，最差的结果是提示用户自己按 Ctrl+V。
 */
async function pasteFromSystem() {
  let text = '';
  try {
    // 必须在点击手势里直接读：iOS Safari 只认手势内的第一次剪贴板调用。
    text = String((await readText()) || '');
  } catch {
    text = '';
  }

  const images = [];
  try {
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.read) {
      for (const entry of await navigator.clipboard.read()) {
        for (const type of entry.types) {
          if (!type.startsWith('image/')) continue;
          const blob = await entry.getType(type);
          const ext = (type.split('/')[1] || 'png').replace('jpeg', 'jpg');
          images.push(new File([blob], `clipboard-${Date.now()}.${ext}`, { type }));
        }
      }
    }
  } catch {
    /* 没授权就算了，文字已经拿到了 */
  }

  if (!text.trim() && !images.length) {
    toast('浏览器没有给出剪贴板内容，请直接按 Ctrl/⌘+V 粘贴', 'error', 4600);
    clipEl.text.focus();
    return;
  }

  if (text.trim()) {
    // 编辑区里已经写好的东西不能被一次误点冲掉。
    if (clipEl.text.value.trim() && !window.confirm('用剪贴板里的内容替换编辑区吗？')) return;
    clipEl.text.value = text;
  }
  if (images.length) addClipFiles(images);
  syncClipCompose();
  clipEl.text.focus();
  const parts = [];
  if (text.trim()) parts.push(`${text.trim().length} 字`);
  if (images.length) parts.push(`${images.length} 张图片`);
  toast(`已粘贴 ${parts.join('、')}`, 'ok');
}

async function saveClipEntry() {
  if (clipState.saving) return;
  const text = clipEl.text.value;
  if (!text.trim() && !clipState.pending.length) {
    toast('内容不能为空', 'error');
    return;
  }

  clipState.saving = true;
  syncClipCompose();
  try {
    let result;
    if (clipState.pending.length) {
      // 有图就必须走 multipart：JSON 里塞 base64 会把请求体和内存都放大三分之一。
      const form = new FormData();
      form.append('text', text);
      for (const item of clipState.pending) {
        form.append('files', item.file, item.file.name || 'clipboard.png');
      }
      result = await api('/api/clipboard/upload', { method: 'POST', body: form });
    } else {
      result = await api('/api/clipboard', { method: 'POST', body: JSON.stringify({ text }) });
    }

    clearClipCompose();
    const evicted = Number(result.evicted) || 0;
    if (result.deduped) {
      toast('和最新一条完全相同，已把它移到最前', 'info');
    } else if (evicted) {
      toast(`已保存，最早的 ${evicted} 条已移出（只保留最近 100 条）`, 'ok', 4200);
    } else {
      toast('已保存到剪贴板', 'ok');
    }
    await loadClipboard();
  } catch (error) {
    toast(`保存失败：${clipErrorText(error)}`, 'error', 5200);
  } finally {
    clipState.saving = false;
    syncClipCompose();
  }
}

/** 只有图片的一条：把第一张写进系统剪贴板，写不了就退化成下载。 */
async function copyClipImage(item) {
  const first = item.images[0];
  if (!first) throw new Error('这条没有可复制的内容');
  const response = await fetch(first.url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`取图失败（${response.status}）`);
  const blob = await response.blob();

  if (window.isSecureContext && navigator.clipboard?.write && window.ClipboardItem) {
    await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
    return 'copied';
  }

  // 退路：下载。比「复制失败」有用——至少东西到了本地。
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `clipboard-${item.id.slice(0, 8)}.${(blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}

/** 取一张图转成 data URL。写进剪贴板 HTML 的图必须**自包含**，见下面的注释。 */
async function imageToDataUrl(url) {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`取图失败（${response.status}）`);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('图片编码失败'));
    reader.readAsDataURL(blob);
  });
}

/**
 * 写「富文本」到系统剪贴板：`text/html` + `text/plain` 一起给。
 *
 * 剪贴板是个多格式容器，粘到哪儿由**目标**挑它认识的最好的那份：Word / 公众号
 * 编辑器拿 HTML（标题、列表、粗体都在），输入框拿纯文本（不带任何标记）。
 * 只写一种的话，要么贴到记事本里满屏 `**`，要么贴到文档里变成一坨纯文字。
 */
async function writeRichClipboard({ html, text }) {
  if (!(window.isSecureContext && navigator.clipboard?.write && window.ClipboardItem)) return false;
  const payload = {};
  if (html) payload['text/html'] = new Blob([html], { type: 'text/html' });
  if (text) payload['text/plain'] = new Blob([text], { type: 'text/plain' });
  if (!Object.keys(payload).length) return false;
  await navigator.clipboard.write([new ClipboardItem(payload)]);
  return true;
}

/**
 * 复制渲染后的样子（所见即所得）。
 *
 * 图片一律内联成 data URL，而不是留 `/api/clipboard/:id/file/0` 这种地址：
 * 那个地址要**登录**才能取，贴到别处（文档、聊天窗口）只会得到一个 401 的破图。
 * 剪贴板里的东西必须是自包含的。
 */
async function copyClipRich(item) {
  const text = item.text ? markdownToText(item.text) : '';
  let html = item.text ? renderMarkdownForClipboard(item.text) : '';
  for (const image of item.images) {
    const dataUrl = await imageToDataUrl(image.url);
    html += `<p style="margin:10px 0"><img src="${dataUrl}" alt="" style="max-width:100%" /></p>`;
  }

  try {
    if (await writeRichClipboard({ html, text })) return 'rich';
  } catch {
    // 写富文本被拒（没权限、文档没有焦点、浏览器不支持这种组合）。不把
    // NotAllowedError 的英文原文甩给用户——退回纯文本，至少内容到得了剪贴板。
  }

  if (!text) throw new Error('浏览器不允许写入图片，请改用「复制图片」或下载');
  await copyText(text);
  return 'plain';
}

/** `copyText` 的失败只有两种原因，都不该把 'copy-failed' 这种内部错误码摆到脸上。 */
function friendlyCopyError(error) {
  if (error && error.message === 'copy-failed') {
    return '浏览器不允许写入剪贴板，请点「源码」后手动选择复制';
  }
  return `复制失败：${error && error.message ? error.message : '未知原因'}`;
}

/** 纯文本复制。失败原因只有「没权限 / 不是安全上下文」，提示里说下一步怎么做。 */
async function copyClipPlain(value, message) {
  try {
    await copyText(value);
    toast(message, 'ok', 3400);
  } catch (error) {
    toast(friendlyCopyError(error), 'error', 5200);
  }
}

/**
 * 复制一条。`mode`：
 *
 *   rich   渲染后的样子（HTML + 纯文本双格式），默认
 *   text   仅纯文本，Markdown 标记全部去掉
 *   source Markdown 源码，原样
 *   image  位图（只有带图时才有）
 */
async function copyClipItem(item, mode = 'rich') {
  try {
    if (mode === 'image' || (!item.text && item.images.length)) {
      const outcome = await copyClipImage(item);
      toast(outcome === 'copied' ? '图片已复制到剪贴板' : '浏览器不支持复制图片，已改为下载', 'ok', 4200);
      return;
    }
    if (!item.text) {
      toast('这条没有内容', 'error');
      return;
    }

    if (mode === 'text') {
      const plain = markdownToText(item.text);
      if (!plain) {
        toast('这条只有 Markdown 标记，去掉之后是空的', 'error', 4200);
        return;
      }
      await copyClipPlain(plain, `已复制纯文本（${plain.length} 字，标记已去掉）`);
      return;
    }

    if (mode === 'source') {
      await copyClipPlain(item.text, `已复制 Markdown 源码（${item.chars} 字）`);
      return;
    }

    const outcome = await copyClipRich(item);
    if (outcome === 'plain') {
      toast('已复制文本；浏览器不允许写富文本，格式没带过去', 'info', 4600);
    } else {
      toast(`已复制（保留格式${item.images.length ? `，含 ${item.images.length} 张图` : ''}）`, 'ok', 3400);
    }
  } catch (error) {
    toast(friendlyCopyError(error), 'error', 5200);
  }
}

/* ---- 复制方式菜单 ---- */

let clipMenu = null;

function closeClipMenu() {
  if (clipMenu) {
    clipMenu.remove();
    clipMenu = null;
  }
}

/**
 * 弹出复制方式菜单。
 *
 * 自己定位而不是用 `<details>`：卡片在滚动容器里，`<details>` 的内容会被
 * `overflow` 裁掉；`position: fixed` + 视口内钳制才能保证贴近屏幕边缘时不被切。
 */
function openClipMenu(anchor, items) {
  closeClipMenu();
  if (!items.length) return;

  const menu = el('div', 'clip-menu');
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    const button = el('button', 'clip-menu-item', item.label);
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', () => {
      closeClipMenu();
      void item.run();
    });
    menu.appendChild(button);
  }

  menu.style.visibility = 'hidden';
  document.body.appendChild(menu);

  const box = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8));
  // 下面放不下就翻到上面去。
  const below = box.bottom + 6;
  const top = below + height > window.innerHeight - 8 ? Math.max(8, box.top - height - 6) : below;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = 'visible';
  clipMenu = menu;
}

function copyMenuItems(item) {
  const items = [];
  if (item.text) {
    items.push({ label: '保留格式（所见即所得）', run: () => copyClipItem(item, 'rich') });
    items.push({ label: '仅复制文本（去掉 Markdown 标记）', run: () => copyClipItem(item, 'text') });
    items.push({ label: '复制 Markdown 源码', run: () => copyClipItem(item, 'source') });
  }
  if (item.images.length) {
    items.push({ label: '复制图片', run: () => copyClipItem(item, 'image') });
  }
  return items;
}

document.addEventListener('click', (event) => {
  if (!clipMenu) return;
  if (clipMenu.contains(event.target)) return;
  if (event.target.closest && event.target.closest('.clip-caret')) return;
  closeClipMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeClipMenu();
});

window.addEventListener('resize', closeClipMenu);
window.addEventListener('scroll', closeClipMenu, true);

/** 卡片里的正文：渲染视图和源码视图互相切换。 */
function clipBodyView(item) {
  const body = el('div', 'clip-body');
  const rendered = el('div', 'md');
  rendered.innerHTML = renderMarkdown(item.text);
  const source = document.createElement('pre');
  source.className = 'clip-source';
  source.hidden = true;
  source.textContent = item.text;
  body.append(rendered, source);
  return { body, rendered, source };
}

function buildClipCard(item) {
  const card = el('article', 'clip-card');
  card.dataset.id = item.id;

  const head = el('div', 'clip-head');
  const meta = el('div', 'clip-meta');
  meta.appendChild(el('span', 'chip', clipAge(item.createdAt)));
  if (item.chars) meta.appendChild(el('span', 'chip', `${item.chars} 字`));
  if (item.images.length) meta.appendChild(el('span', 'chip', `${item.images.length} 张图`));
  head.appendChild(meta);

  const actions = el('div', 'clip-actions');

  const copyBtn = el('button', 'btn btn-sm', item.text ? '复制' : '复制图片');
  copyBtn.type = 'button';
  copyBtn.title = item.text
    ? '复制渲染后的样子：贴到文档里保留标题、列表和粗体，贴到输入框里不带任何标记'
    : '把这张图片复制到系统剪贴板';
  copyBtn.addEventListener('click', () => void copyClipItem(item, item.text ? 'rich' : 'image'));

  const caret = el('button', 'btn btn-sm clip-caret');
  caret.type = 'button';
  caret.title = '更多复制方式（仅文本 / Markdown 源码 / 图片）';
  caret.setAttribute('aria-haspopup', 'menu');
  caret.setAttribute('aria-label', '更多复制方式');
  // 用 SVG 而不是 ▾：那个字符在 12px 下会缩成一个小点，看起来像个坏按钮。
  caret.innerHTML =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>';
  caret.addEventListener('click', () => openClipMenu(caret, copyMenuItems(item)));

  const sourceBtn = el('button', 'btn btn-sm btn-ghost', '源码');
  sourceBtn.type = 'button';
  sourceBtn.title = '在渲染结果和 Markdown 源码之间切换';

  const editBtn = el('button', 'btn btn-sm btn-ghost', '编辑');
  editBtn.type = 'button';

  const delBtn = el('button', 'btn btn-sm btn-danger', '删除');
  delBtn.type = 'button';

  actions.append(copyBtn, caret, sourceBtn, editBtn, delBtn);
  head.appendChild(actions);
  card.appendChild(head);

  if (item.images.length) {
    const strip = el('div', 'clip-images');
    for (const image of item.images) {
      const link = document.createElement('a');
      link.href = image.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = '在新标签页打开原图';
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = image.url;
      img.alt = '剪贴板图片';
      link.appendChild(img);
      strip.appendChild(link);
    }
    card.appendChild(strip);
  }

  let view = null;
  if (item.text) {
    view = clipBodyView(item);
    card.appendChild(view.body);
  }

  sourceBtn.hidden = !view;
  sourceBtn.addEventListener('click', () => {
    if (!view) return;
    const showingSource = !view.source.hidden;
    view.source.hidden = showingSource;
    view.rendered.hidden = !showingSource;
    sourceBtn.textContent = showingSource ? '源码' : '预览';
  });

  editBtn.addEventListener('click', () => {
    // 连点两下不要叠出两个编辑框。
    if (card.querySelector('.clip-editor')) return;
    // 编辑时先把渲染结果收起来：同一段内容上下各显示一遍，改完还得对照半天
    // 才能确认改的是哪一块。
    if (view) view.body.hidden = true;
    const editor = document.createElement('div');
    editor.className = 'clip-editor';
    const area = document.createElement('textarea');
    area.rows = Math.min(14, Math.max(4, item.text.split('\n').length + 1));
    area.value = item.text;
    area.setAttribute('aria-label', '编辑这条剪贴板内容');
    const bar = el('div', 'clip-editor-actions');
    const save = el('button', 'btn btn-sm', '保存');
    save.type = 'button';
    const cancel = el('button', 'btn btn-sm btn-ghost', '取消');
    cancel.type = 'button';
    bar.append(save, cancel);
    editor.append(area, bar);

    cancel.addEventListener('click', () => {
      editor.remove();
      if (view) view.body.hidden = false;
    });
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const result = await api(`/api/clipboard/${encodeURIComponent(item.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ text: area.value }),
        });
        Object.assign(item, result.item);
        editor.remove();
        renderClipboard();
        toast('已保存', 'ok');
      } catch (error) {
        toast(`保存失败：${clipErrorText(error)}`, 'error', 5200);
      } finally {
        save.disabled = false;
      }
    });

    card.appendChild(editor);
    area.focus();
  });

  delBtn.addEventListener('click', async () => {
    const label = item.text ? markdownSummary(item.text, 24) : '这条图片';
    if (!window.confirm(`删除「${label}」？不能撤销。`)) return;
    try {
      await api(`/api/clipboard/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      toast('已删除', 'ok');
      await loadClipboard();
    } catch (error) {
      toast(`删除失败：${clipErrorText(error)}`, 'error', 5200);
    }
  });

  return card;
}

function renderClipboard() {
  const stats = clipState.stats;
  clipEl.count.textContent = String(stats ? stats.count : clipState.total);
  clipEl.stats.textContent = stats
    ? `共 ${stats.count}/${stats.maxItems} 条${stats.bytes ? ` · 图片占用 ${formatBytes(stats.bytes)}` : ''}`
    : '';
  clipEl.clear.disabled = !stats || stats.count === 0;
  clipEl.list.replaceChildren(...clipState.items.map(buildClipCard));
  clipEl.empty.hidden = clipState.items.length > 0 || clipState.loading;
  if (!clipState.items.length && !clipState.loading) {
    clipEl.empty.textContent = clipState.query
      ? `没有匹配「${clipState.query}」的内容。`
      : '剪贴板还是空的。把要记的东西贴到上面，点「保存到剪贴板」。';
  }
}

async function loadClipboard({ announce = false } = {}) {
  if (clipState.loading) return;
  clipState.loading = true;
  try {
    const params = new URLSearchParams({ q: clipState.query });
    const data = await api(`/api/clipboard?${params.toString()}`);
    clipState.items = Array.isArray(data.items) ? data.items : [];
    clipState.total = Number(data.total) || 0;
    clipState.stats = data.stats || null;
    renderClipboard();
  } catch (error) {
    const reason = clipErrorText(error);
    clipEl.stats.textContent = '加载失败';
    clipEl.list.replaceChildren();
    clipEl.empty.hidden = false;
    clipEl.empty.textContent = `剪贴板加载失败：${reason}`;
    if (announce) toast(`剪贴板加载失败：${reason}`, 'error', 5200);
  } finally {
    clipState.loading = false;
  }
}

clipEl.text.addEventListener('input', syncClipCompose);

/** 把文字接在编辑区末尾（面板空白处粘贴时用）。 */
function appendClipText(text) {
  const value = clipEl.text.value;
  clipEl.text.value = value && !value.endsWith('\n') ? `${value}\n\n${text}` : `${value}${text}`;
  syncClipCompose();
  clipEl.text.focus();
}

/** 插到光标处（编辑区里粘「图 + 说明文字」时用）。 */
function insertClipTextAtCursor(text) {
  const start = clipEl.text.selectionStart ?? clipEl.text.value.length;
  const end = clipEl.text.selectionEnd ?? start;
  clipEl.text.setRangeText(text, start, end, 'end');
  syncClipCompose();
}

/**
 * 面板级粘贴：图片可以直接粘在剪贴板上，不必先点输入框。
 *
 * 按「此刻的意图」分四种情况：
 *
 *   - 卡片里的编辑框 → 完全不碰。浏览器原生粘贴最靠谱（光标位置、撤销栈都在）。
 *   - 编辑区里粘文字 → 也交给浏览器，理由同上。
 *   - 编辑区里粘图片 → 拦下来变附件，否则浏览器会把它当成文件名插成一行字。
 *   - 面板空白处 → 文字进编辑区、图片变附件，这就是「直接粘在剪贴板上」。
 */
clipEl.panel.addEventListener('paste', (event) => {
  const data = event.clipboardData;
  if (!data) return;
  const target = event.target;
  // 卡片里的编辑框：那是改一条已有记录，不该把内容吸到下面的新编辑区里。
  if (target.closest && target.closest('.clip-editor')) return;

  const inCompose = target === clipEl.text;
  // 搜索框、编辑框这些输入控件：文字粘贴交给浏览器（光标位置、撤销栈都在）。
  const isField =
    inCompose ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable === true;

  const images = [...(data.files || [])].filter((file) => /^image\//i.test(file.type));
  const text = data.getData('text/plain');

  if (!images.length) {
    if (isField || !text) return;
    event.preventDefault();
    appendClipText(text);
    toast('已放进编辑区，点「保存到剪贴板」入库', 'info', 3600);
    return;
  }

  // 在别的输入框里粘图片（比如搜索框）：不抢，让它按原生行为走。
  if (isField && !inCompose) return;

  event.preventDefault();
  if (text) {
    if (inCompose) insertClipTextAtCursor(text);
    else appendClipText(text);
  }
  addClipFiles(images);
  syncClipCompose();
  clipEl.text.focus();
  toast(`已粘贴 ${images.length} 张图片，点「保存到剪贴板」入库`, 'ok', 3600);
});

/* ---- 拖进来也一样（拖拽是粘贴的另一种写法） ---- */

for (const name of ['dragenter', 'dragover']) {
  clipEl.compose.addEventListener(name, (event) => {
    event.preventDefault();
    clipEl.compose.classList.add('is-over');
  });
}
for (const name of ['dragleave', 'dragend', 'drop']) {
  clipEl.compose.addEventListener(name, () => clipEl.compose.classList.remove('is-over'));
}
clipEl.compose.addEventListener('drop', (event) => {
  event.preventDefault();
  const files = event.dataTransfer && event.dataTransfer.files;
  if (files && files.length) addClipFiles(files);
});

clipEl.text.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
  event.preventDefault();
  void saveClipEntry();
});

clipEl.paste.addEventListener('click', () => void pasteFromSystem());
clipEl.save.addEventListener('click', () => void saveClipEntry());
clipEl.imageBtn.addEventListener('click', () => clipEl.file.click());
clipEl.file.addEventListener('change', () => {
  if (clipEl.file.files && clipEl.file.files.length) addClipFiles(clipEl.file.files);
});

let clipSearchTimer = 0;
clipEl.search.addEventListener('input', () => {
  window.clearTimeout(clipSearchTimer);
  clipSearchTimer = window.setTimeout(() => {
    clipState.query = clipEl.search.value.trim();
    void loadClipboard();
  }, 280);
});

clipEl.refresh.addEventListener('click', () => void loadClipboard({ announce: true }));

clipEl.clear.addEventListener('click', async () => {
  const count = clipState.stats ? clipState.stats.count : clipState.total;
  if (!count) return;
  if (!window.confirm(`清空剪贴板里的 ${count} 条内容？图片文件会一起删除，不能撤销。`)) return;
  try {
    const result = await api('/api/clipboard', { method: 'DELETE' });
    toast(`已清空 ${result.removed} 条`, 'ok');
    await loadClipboard();
  } catch (error) {
    toast(`清空失败：${clipErrorText(error)}`, 'error', 5200);
  }
});

syncClipCompose();
renderClipAttachments();

/* ------------------------------ boot ------------------------------ */

async function boot() {
  // Paint every panel's empty state *before* talking to the server. Doing this
  // afterwards would wipe whatever the loads below had just rendered — the queue
  // list in particular, since `resetQueuePanel()` swaps in an empty snapshot.
  renderPreview();
  resetLogPanel();
  resetQueuePanel();
  setMode('text2image');
  renderRefs();
  renderGenResults();
  renderDefaultChip();

  try {
    const status = await api('/api/auth/status');
    state.configured = Boolean(status.configured);
    if (status.authenticated) {
      renderConsole();
      await Promise.all([loadImages(), loadGenConfig(), loadVault(), loadClipboard()]);
      await loadQueue();
    } else {
      renderGate();
    }
  } catch (error) {
    renderGate();
    toast(`无法连接服务：${error.message}`, 'error');
  }

  // Last, because entering the metrics tab triggers a load of its own.
  setTab(rememberedTab());
}

boot();
