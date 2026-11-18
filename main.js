/* MAKER® — 职业形象转盘
   引擎与交互对齐 NOWHERE 复刻页：单个 rAF 循环驱动全部人物变换，
   RING / GRID / DETAIL 三种模式共用同一组人物、逐帧插值变形；
   深度 d=(cos+1)/2 映射缩放/透明/模糊；拖拽惯性 + 吸附；详情热点
   圆点 + 标签胶囊；档案小票浮动滑入。内容数据来自个人经历记录。 */
'use strict';

const STAGES = [
  {
    id: 'stage-01', num: '01', en: 'CAMPUS', zh: '校园',
    years: '2012–2016', org: '广东工业大学',
    color: '#33565d', dark: '#22393f', prop: 'book',
    dots: [[50, 26], [58, 58], [40, 46], [50, 86]],
    duration: '4 年',
    summary: '从校园社团到写代码的起点',
    items: [
      '广东工业大学 · 计算机本科',
      '电子社团部长，带 16 人销售团队',
      '校联想 Idea 精英汇会长',
      '大学英语四级 CET-4',
    ],
    tags: ['计算机本科', '销售与培训', '创意策划', '英语四级'],
  },
  {
    id: 'stage-02', num: '02', en: 'GAME SERVER', zh: '游戏服务器',
    years: '2016–2018', org: '深圳市七大道科技有限公司',
    color: '#5b7a3a', dark: '#42592a', prop: 'gamepad',
    dots: [[50, 26], [56, 62], [42, 48], [50, 86]],
    duration: '约 2 年',
    summary: '从写模块到扛住 10+ 个版本',
    items: [
      '深圳市七大道科技有限公司 · Java',
      '神曲海外版需求开发，对接 mobage 平台',
      '维护 10+ 版本稳定运行',
      '在线 bug 产出率同比下降 56.7%',
      'Mythic Glory 核心战斗与技能 buff 模块',
      '贡献 30% 服务器功能模块',
    ],
    tags: ['Java', '游戏服务器', 'mobage', '战斗系统', 'Buff 系统'],
  },
  {
    id: 'stage-03', num: '03', en: 'LEAD DEV', zh: '主程',
    years: '2018–2019', org: '深圳市八度时空科技有限公司',
    color: '#b07d2b', dark: '#8a5f1d', prop: 'laptop',
    dots: [[50, 26], [54, 60], [40, 44], [50, 86]],
    duration: '1 年 7 个月',
    summary: '从写代码到带团队、定规范',
    items: [
      '深圳市八度时空科技有限公司 · 游戏服务器主程',
      '负责架构设计、服务器性能优化',
      '主导多个项目稳定上线，带 4 人团队',
      'SVN 切 Git，分支本地化需求 2 天 → 半天',
      '从 0 到 1 部署游戏服务器并写文档',
    ],
    tags: ['架构设计', '性能优化', '团队管理', 'Git', '部署运维'],
  },
  {
    id: 'stage-04', num: '04', en: 'SKYNET', zh: '分布式架构',
    years: '2019–2020', org: '广州君海网络科技有限公司',
    color: '#6b5b95', dark: '#4e426e', prop: 'nodes',
    dots: [[50, 26], [58, 56], [42, 46], [50, 86]],
    duration: '9 个月',
    summary: '把一套服务器架构成全球服标准',
    items: [
      '广州君海网络科技有限公司 · 服务端开发工程师',
      '搭建分布式、高并发、高可用游戏服务器架构',
      'skynet 性能探索与模块瓶颈分析',
      'SLG 服务器从 0 预研：内存 + redis 双缓存、redis 集群',
      '卡牌放置类游戏重构，重复代码减少 50%',
      '引入行为树替代状态机 AI',
    ],
    tags: ['skynet', '分布式架构', 'Redis', 'Lua', '行为树'],
  },
  {
    id: 'stage-05', num: '05', en: 'WHITEBOARD', zh: '白板',
    years: '2022–2025', org: '华为 IdeaHub 白板',
    color: '#2f5d8a', dark: '#214263', prop: 'marker',
    dots: [[50, 26], [60, 54], [40, 48], [50, 86]],
    duration: '4 年',
    summary: '从写代码到管开源与漏洞',
    items: [
      '华为 IdeaHub 白板 · 2022–2025',
      '保存 / 打开 / 导出、白板转 PPT 1:1 转换',
      '鸿蒙单框架特性（JS / TS / ArkTS）',
      'AI 工具栏、AI 问答、思维导图、一键生图',
      '漏洞管理接口人：处理 191，分发 500+，libing 任务 6000+',
      '产品开源代表；2025 年推动 Claude Code 落地',
      '培训 1 次、3 个共享 skills、4 篇实践帖',
    ],
    tags: ['HarmonyOS', '开源治理', '漏洞管理', 'AI 工具栏'],
  },
  {
    id: 'stage-06', num: '06', en: 'MAKER', zh: '造物者',
    years: '2025–至今', org: '重新找回创造力',
    color: '#b4452f', dark: '#8c3524', prop: 'spark',
    dots: [[50, 26], [58, 52], [42, 48], [50, 86]],
    duration: '进行中',
    summary: '老兵开始造自己的东西',
    items: [
      '重新找回创造力的程序员',
      '微信公众号 重构下半场：AI 生图与视频生成',
      'Seedream 5.5 深度测评：高赞案例汇总',
      'Minimax H3 视频生成 + ComfyUI',
    ],
    tags: ['重构下半场', 'Seedream', 'Minimax H3', 'ComfyUI'],
  },
];

/* 热点位置（占人物框的百分比）：每阶段取前 4 个关键词 */
const DOTS = [[50, 30], [40, 48], [58, 66], [50, 86]];
const CHIP_CROPS = ['50% 16%', '50% 48%', '50% 84%'];
const RATIO = 0.3228; /* 抠图宽高比 w/h，全站统一 */

/* ---------- SVG 剪影（抠图与原图都加载失败时的最后保底） ---------- */
function propSVG(s) {
  const d = s.dark, c = s.color;
  switch (s.prop) {
    case 'book':
      return `<g transform="translate(148 92)"><rect width="26" height="34" rx="3" fill="#fff" stroke="${d}" stroke-width="2"/><line x1="6" y1="10" x2="20" y2="10" stroke="${d}" stroke-width="2"/><line x1="6" y1="17" x2="20" y2="17" stroke="${d}" stroke-width="2"/><line x1="6" y1="24" x2="16" y2="24" stroke="${d}" stroke-width="2"/></g>`;
    case 'gamepad':
      return `<g transform="translate(136 100)"><rect width="48" height="28" rx="13" fill="#222"/><circle cx="13" cy="14" r="3" fill="#fff"/><circle cx="36" cy="11" r="2.4" fill="#fff"/><circle cx="36" cy="17" r="2.4" fill="#fff"/></g>`;
    case 'laptop':
      return `<g transform="translate(140 100)"><rect width="42" height="28" rx="3" fill="#222"/><rect x="8" y="7" width="26" height="14" fill="#fff" opacity=".85"/><rect x="-4" y="28" width="50" height="4" rx="2" fill="#222"/></g>`;
    case 'nodes':
      return `<g stroke="${d}" stroke-width="2" fill="#fff"><line x1="150" y1="98" x2="166" y2="116"/><line x1="166" y1="116" x2="148" y2="130"/><circle cx="150" cy="98" r="6"/><circle cx="166" cy="116" r="6"/><circle cx="148" cy="130" r="6"/></g>`;
    case 'marker':
      return `<g transform="translate(154 88) rotate(24)"><rect width="10" height="38" rx="5" fill="${c}" stroke="#fff" stroke-width="1.5"/><path d="M0 38 L5 48 L10 38 Z" fill="${d}"/></g>`;
    case 'spark':
      return `<path d="M158 88 L163 102 L178 106 L163 111 L158 126 L153 111 L138 106 L153 102 Z" fill="#f5b301" stroke="#fff" stroke-width="1"/>`;
    default:
      return '';
  }
}
function figureSVG(s) {
  const c = s.color, d = s.dark;
  return `<svg viewBox="0 0 200 240" aria-hidden="true" style="width:100%;height:100%;display:block">
    <ellipse cx="100" cy="226" rx="54" ry="10" fill="rgba(20,20,20,.12)"/>
    <rect x="76" y="148" width="20" height="66" rx="9" fill="${d}"/>
    <rect x="104" y="148" width="20" height="66" rx="9" fill="${d}"/>
    <ellipse cx="86" cy="218" rx="12" ry="6" fill="#1c1c1c"/>
    <ellipse cx="114" cy="218" rx="12" ry="6" fill="#1c1c1c"/>
    <rect x="44" y="84" width="18" height="64" rx="9" fill="${d}" transform="rotate(8 53 116)"/>
    <rect x="138" y="84" width="18" height="64" rx="9" fill="${d}" transform="rotate(-8 147 116)"/>
    <circle cx="52" cy="150" r="8" fill="#e9be9a"/>
    <circle cx="148" cy="150" r="8" fill="#e9be9a"/>
    <path d="M62 80 Q100 64 138 80 L146 152 Q100 164 54 152 Z" fill="${c}"/>
    <path d="M88 76 L100 92 L112 76 L112 70 L88 70 Z" fill="rgba(255,255,255,.28)"/>
    <circle cx="100" cy="48" r="24" fill="#e9be9a"/>
    <path d="M76 50 Q74 22 100 22 Q126 22 124 50 Q114 34 100 34 Q86 34 76 50 Z" fill="#262626"/>
    ${propSVG(s)}
  </svg>`;
}

const N = STAGES.length, STEP = Math.PI * 2 / N, TAU = Math.PI * 2;
const GRID_SLOTS = [
  { x: 17, y: 40 }, { x: 50, y: 37 }, { x: 83, y: 40 },
  { x: 17, y: 84 }, { x: 50, y: 82 }, { x: 83, y: 84 },
];
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const stage = document.getElementById('stage');
const screenEl = document.getElementById('screen');
const cntNum = document.getElementById('cntNum');
const lookNameEl = document.getElementById('lookName');
const lookSubEl = document.getElementById('lookSub');
const chipsEl = document.getElementById('chips');
const playBtn = document.getElementById('playBtn');
const archiveBtn = document.getElementById('archiveBtn');
const cursorEl = document.getElementById('cursor');
const receiptEl = document.getElementById('receipt');
const receiptWrap = document.getElementById('receiptWrap');
const detailTitle = document.getElementById('detailTitle');
const tglRing = document.getElementById('tglRing');
const tglGrid = document.getElementById('tglGrid');
const ringTicksEl = document.getElementById('ringTicks');
const masterBackdrop = document.getElementById('masterBackdrop');
const masterReceipt = document.getElementById('masterReceipt');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const detailNavLabel = document.getElementById('detailNavLabel');
const receiptHandle = document.getElementById('receiptHandle');

/* ---------- 阶段主题色注入（--stage-accent / --stage-dark） ---------- */
function setAccent(i) {
  const s = STAGES[i];
  document.documentElement.style.setProperty('--stage-accent', s.color);
  document.documentElement.style.setProperty('--stage-dark', s.dark);
}
setAccent(0);

/* ---------- 舞台地面刻度环：12 格刻度，随 theta 同步旋转 ---------- */
(function buildRingTicks() {
  let s = '';
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const x1 = 300 + 284 * Math.cos(a), y1 = 90 + 74 * Math.sin(a);
    const x2 = 300 + 266 * Math.cos(a), y2 = 90 + 62 * Math.sin(a);
    s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="currentColor" stroke-width="1.4" opacity="0.7"/>`;
  }
  ringTicksEl.innerHTML = s;
})();

let W = 0, H = 0, figW = 160, figH = 500;
function measure() {
  W = screenEl.clientWidth; H = screenEl.clientHeight;
  figW = W < 760 ? Math.min(H * 0.142, W * 0.40) : Math.min(H * 0.165, W * 0.30);
  figH = figW / RATIO;
}
measure();
window.addEventListener('resize', measure);

function pad(n) { return (n < 10 ? '0' : '') + n; }

/* ---------- 生成人物（抠图优先；失败退 JPG 卡片；再失败退剪影并红框显形） ---------- */
const figs = STAGES.map((s, i) => {
  const el = document.createElement('div');
  el.className = 'fig';
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', `${s.num} ${s.en} ${s.zh}，${s.years}，点击查看档案`);
  const shadow = document.createElement('div');
  shadow.className = 'fig-shadow';
  const bob = document.createElement('div');
  bob.className = 'fig-bob';
  const img = document.createElement('img');
  img.src = `assets/stages/${s.id}-alpha.webp`;
  img.alt = `${s.en} ${s.zh} 阶段照片`;
  img.draggable = false;
  img.addEventListener('error', () => {
    if (!img.dataset.fbk) {
      img.dataset.fbk = '1';
      el.classList.add('card');
      img.src = `assets/stages/${s.id}.jpg?v=3`;
    } else {
      bob.classList.add('photo-failed');
      img.remove();
      bob.insertAdjacentHTML('beforeend', figureSVG(s));
    }
  });
  bob.appendChild(img);
  const cap = document.createElement('div');
  cap.className = 'fig-cap';
  cap.style.setProperty('--capd', (i * 45) + 'ms');
  cap.innerHTML = `<b>${s.num}</b>${s.en}`;
  const spots = document.createElement('div');
  spots.className = 'spots';
  el.appendChild(shadow); el.appendChild(bob); el.appendChild(cap); el.appendChild(spots);
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (mode === 'grid') openDetail(i);
    else if (mode === 'ring') { if (i === frontIndex()) openDetail(i); else rotateTo(i); }
  });
  stage.appendChild(el);
  return { el, bob, img, shadow, spots, label: null, dots: [],
           cur: { x: 0, y: 0, s: .5, o: 0, b: 5 }, away: null,
           rect: { l: 0, r: 0, t: 0, b: 0, z: 0 }, activeDot: -1, delay: 0, hoverLift: false };
});

/* ---------- 状态 ---------- */
let mode = 'ring', prevMode = 'ring';
let theta = 0, targetTheta = 0;
let dragging = false, spinVel = 0, dragVel = 0, inertia = false;
let current = 0, detailIdx = -1;
let playing = !reduced;
let lastInteract = performance.now(), lastAdvance = performance.now();
let blendFrames = 0;
const viewed = new Set();

/* ---------- 顶栏时钟 ---------- */
const clockEl = document.getElementById('clock');
function tickClock() {
  const d = new Date();
  let h = d.getHours();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  clockEl.textContent = `${h}:${pad(d.getMinutes())} ${ap}`;
}
tickClock();
setInterval(tickClock, 20000);

/* ---------- 装饰 QR（与 NOWHERE 复刻页同法生成） ---------- */
(function buildQR() {
  let s = 1234567;
  function rnd() { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }
  const g = 25;
  let cells = '';
  function finder(x, y) {
    return `<rect x="${x}" y="${y}" width="7" height="7" fill="#111"/>` +
           `<rect x="${x + 1}" y="${y + 1}" width="5" height="5" fill="#f1f1ef"/>` +
           `<rect x="${x + 2}" y="${y + 2}" width="3" height="3" fill="#111"/>`;
  }
  for (let y = 0; y < g; y++) for (let x = 0; x < g; x++) {
    const inF = (x < 8 && y < 8) || (x > g - 9 && y < 8) || (x < 8 && y > g - 9);
    if (!inF && rnd() > 0.52) cells += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
  }
  document.getElementById('qr').innerHTML =
    `<svg viewBox="0 0 25 25" fill="#111">${cells}${finder(0, 0)}${finder(18, 0)}${finder(0, 18)}</svg>`;
})();

/* ---------- 小票锯齿撕纸边 ---------- */
(function serrate() {
  const teeth = 16, pts = ['0 0', '100% 0', '100% calc(100% - 7px)'];
  for (let i = 0; i < teeth; i++) {
    const x1 = 100 - (i + 0.5) * (100 / teeth), x2 = 100 - (i + 1) * (100 / teeth);
    pts.push(x1.toFixed(2) + '% 100%');
    pts.push(x2.toFixed(2) + '% calc(100% - 7px)');
  }
  const poly = `polygon(${pts.join(',')})`;
  receiptEl.style.clipPath = poly;
  document.querySelector('.receipt-ghost').style.clipPath = poly;
})();

/* ---------- 播放按钮 ---------- */
const SVG_PAUSE = '<svg width="9" height="10" viewBox="0 0 9 10"><rect x="0" y="0" width="3" height="10" fill="#111"/><rect x="6" y="0" width="3" height="10" fill="#111"/></svg>';
const SVG_PLAY = '<svg width="9" height="10" viewBox="0 0 9 10"><path d="M0 0 L9 5 L0 10 Z" fill="#111"/></svg>';
function renderPlay() { playBtn.innerHTML = playing ? SVG_PAUSE : SVG_PLAY; }
renderPlay();
playBtn.addEventListener('click', () => {
  playing = !playing; renderPlay(); lastInteract = performance.now();
});

/* ---------- 底部信息同步 ---------- */
function restartAnim(el, cls) {
  el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
}
function updateArchiveBtn(pop) {
  archiveBtn.textContent = `ARCHIVE (${viewed.size}/6)`;
  if (!pop) return;
  archiveBtn.classList.remove('pop'); void archiveBtn.offsetWidth; archiveBtn.classList.add('pop');
}
function updateUI(idx) {
  current = idx;
  const s = STAGES[idx];
  setAccent(idx);
  cntNum.textContent = s.num;
  restartAnim(cntNum, 'roll');
  lookNameEl.textContent = s.en;
  restartAnim(lookNameEl, 'swap');
  lookSubEl.textContent = `${s.zh} · ${s.years} · ${s.org}`;
  chipsEl.innerHTML = '';
  s.tags.slice(0, 3).forEach((tag, j) => {
    const c = document.createElement('button');
    c.type = 'button'; c.className = 'chip';
    c.style.animationDelay = (j * 70) + 'ms';
    const crop = CHIP_CROPS[j] || '50% 40%';
    c.innerHTML = `<span class="thumb"><img src="assets/stages/${s.id}-alpha.webp" alt="" style="object-position:${crop};transform-origin:${crop}"></span>` +
      `<span><span class="cname">${tag}</span><span class="cyears">KEYWORD ${pad(j + 1)}</span></span>`;
    c.addEventListener('click', () => openDetail(idx, j));
    chipsEl.appendChild(c);
  });
}
updateUI(0);

function frontIndex() {
  let best = 0, bd = -2;
  for (let i = 0; i < N; i++) {
    const d = Math.cos(i * STEP + theta);
    if (d > bd) { bd = d; best = i; }
  }
  return best;
}
function rotateTo(i) {
  const base = -i * STEP;
  const k = Math.round((targetTheta - base) / TAU);
  targetTheta = base + k * TAU;
  inertia = false; spinVel = 0;
  lastInteract = performance.now();
}
function stepStage(dir) {
  const idx = Math.round(-targetTheta / STEP);
  rotateTo(((idx + dir) % N + N) % N);
}

/* ---------- 视图模式 ---------- */
function setMode(m) {
  const pm = mode;
  mode = m;
  document.body.className = 'mode-' + m + (m === 'detail' ? ' hint-on' : '');
  tglRing.classList.toggle('on', m === 'ring');
  tglGrid.classList.toggle('on', m === 'grid');
  cursorEl.classList.remove('show');
  cursorEl.classList.remove('drag');
  if (m === 'ring') blendFrames = 42;
  if (m === 'grid') figs.forEach((f, i) => { f.delay = i * 3; });
  else if (m === 'ring' && pm === 'grid') figs.forEach((f, i) => { f.delay = i * 2; });
}
tglRing.addEventListener('click', () => { if (mode !== 'detail') setMode('ring'); });
tglGrid.addEventListener('click', () => { if (mode !== 'detail') setMode('grid'); });
document.getElementById('stagesPill').addEventListener('click', () => { if (mode !== 'detail') setMode('grid'); });
archiveBtn.addEventListener('click', () => { if (mode !== 'detail') openMaster(); });
document.getElementById('plusBtn').addEventListener('click', () => openDetail(frontIndex()));
document.getElementById('closeBtn').addEventListener('click', closeDetail);
prevBtn.addEventListener('click', () => stepDetail(-1));
nextBtn.addEventListener('click', () => stepDetail(1));
masterBackdrop.addEventListener('click', (e) => { if (e.target === masterBackdrop) closeMaster(); });

/* 小票顶部把手：点按或下拉关闭详情（移动端抽屉手势） */
let handleY = null, handleT = 0;
receiptHandle.addEventListener('pointerdown', (e) => { handleY = e.clientY; handleT = performance.now(); });
receiptHandle.addEventListener('pointerup', (e) => {
  if (handleY === null) return;
  const dy = e.clientY - handleY, dt = performance.now() - handleT;
  handleY = null;
  if (dy > 60 || (Math.abs(dy) < 8 && dt < 300)) closeDetail();
});

/* 点击舞台空白处关闭详情（人物与圆点本身不触发） */
stage.addEventListener('click', (e) => {
  if (mode !== 'detail') return;
  if (hitTest(e.clientX, e.clientY) < 0) closeDetail();
});

/* ---------- 详情：热点 + 档案小票 ---------- */
/* 热点坐标：每阶段自带 dots 配置（头部 / 核心道具 / 服饰细节），缺失时回退全局 DOTS */
function stageDots(i) { return STAGES[i].dots || DOTS; }
function buildDots(i) {
  const f = figs[i], s = STAGES[i], dots = stageDots(i);
  f.spots.innerHTML = '';
  f.dots = s.tags.slice(0, 4).map((tag, j) => {
    const d = document.createElement('button');
    d.type = 'button'; d.className = 'dot';
    d.textContent = pad(j + 1);
    d.style.left = dots[j][0] + '%';
    d.style.top = dots[j][1] + '%';
    d.style.setProperty('--dd', (320 + j * 110) + 'ms');
    d.setAttribute('aria-label', tag);
    d.addEventListener('click', (ev) => { ev.stopPropagation(); activateDot(i, j); });
    d.addEventListener('mouseenter', () => activateDot(i, j));
    f.spots.appendChild(d);
    return d;
  });
  const label = document.createElement('div');
  label.className = 'dot-label'; label.style.display = 'none';
  f.spots.appendChild(label);
  f.label = label;
  f.activeDot = -1;
}
function clearDots() {
  figs.forEach((f) => {
    f.spots.innerHTML = ''; f.label = null; f.dots = []; f.activeDot = -1;
  });
}
function openDetail(i, preselect) {
  if (mode === 'detail') return;
  prevMode = mode;
  detailIdx = i;
  figs.forEach((f, j) => {
    f.away = { x: f.cur.x, y: f.cur.y, s: f.cur.s };
    f.el.classList.toggle('detail-active', j === i);
    f.delay = j === i ? 0 : 2;
  });
  buildDots(i);
  const s = STAGES[i];
  setAccent(i);
  detailTitle.innerHTML = `<span class="dnum">${s.num}.</span><span class="dname">${s.en}</span>`;
  detailNavLabel.textContent = `${s.num} / ${pad(N)}`;
  buildReceipt(i);
  setMode('detail');
  receiptWrap.setAttribute('aria-hidden', 'false');
  if (!viewed.has(i)) {
    viewed.add(i);
    updateArchiveBtn(true);
  }
  if (typeof preselect !== 'number') preselect = 0;
  setTimeout(() => { if (mode === 'detail' && detailIdx === i) activateDot(i, preselect); }, 450);
}
/* 详情内联切页：不关闭直接换阶段，后台同步旋转 targetTheta，小票重新吐纸 */
function switchDetail(next) {
  if (mode !== 'detail' || next === detailIdx) return;
  const prev = detailIdx;
  figs[prev].away = { x: figs[prev].cur.x, y: figs[prev].cur.y, s: figs[prev].cur.s };
  detailIdx = next;
  figs.forEach((f, j) => f.el.classList.toggle('detail-active', j === next));
  buildDots(next);
  const s = STAGES[next];
  setAccent(next);
  detailTitle.innerHTML = `<span class="dnum">${s.num}.</span><span class="dname">${s.en}</span>`;
  detailNavLabel.textContent = `${s.num} / ${pad(N)}`;
  buildReceipt(next);
  rotateTo(next);
  updateUI(next);
  if (!viewed.has(next)) {
    viewed.add(next);
    updateArchiveBtn(true);
  }
  setTimeout(() => { if (mode === 'detail' && detailIdx === next) activateDot(next, 0); }, 350);
}
function stepDetail(dir) {
  if (mode !== 'detail') return;
  switchDetail(((detailIdx + dir) % N + N) % N);
}
function closeDetail() {
  if (mode !== 'detail') return;
  const back = prevMode === 'grid' ? 'grid' : 'ring';
  figs.forEach((f) => f.el.classList.remove('detail-active'));
  setTimeout(() => { if (mode !== 'detail') clearDots(); }, 480);
  receiptWrap.setAttribute('aria-hidden', 'true');
  setMode(back);
  if (back === 'ring') rotateTo(detailIdx);
  detailIdx = -1;
}
function buildReceipt(i) {
  const s = STAGES[i];
  let html = `<div class="r-head"><div class="r-logo">MAKER<sup>®</sup></div>` +
    `<div class="r-sub">VOL. 01 — CAREER ARCHIVE · EST. 2012</div>` +
    `<div class="r-look">STAGE ${s.num} — ${s.en} ${s.zh}</div>` +
    `<div class="r-org">${s.years.replace('–', ' – ')} · ${s.org}</div></div>` +
    `<div class="r-stamp">STAGE VERIFIED · ${s.years}</div><div class="r-rule"></div>`;
  s.items.forEach((t, n) => {
    html += `<div class="r-item" data-n="${n}" style="--rd:${n * 35}ms"><span class="no">${pad(n + 1)}</span><span class="tx">${t}</span></div>`;
  });
  html += `<div class="r-rule"></div>` +
    `<div class="r-tot-row"><span>KEYWORDS</span><span class="v">${s.tags.length} 项</span></div>` +
    `<div class="r-total"><span class="tl">TOTAL</span><span class="tv">${s.duration}</span></div>` +
    `<div class="r-summary">${s.summary}</div>` +
    `<div class="barcode"></div><div class="r-thanks">THANKS FOR VISITING.</div>`;
  receiptEl.innerHTML = html;
  /* 小票条目 ↔ 人物热点双向联动：点击或悬停条目，同步激活对应圆点 */
  receiptEl.querySelectorAll('.r-item').forEach((el) => {
    const n = +el.dataset.n;
    el.addEventListener('click', () => activateDot(i, n));
    el.addEventListener('mouseenter', () => activateDot(i, n));
  });
}
/* 小票侧高亮：与 activateDot 共用，条目多于圆点时只亮条目 */
function highlightReceiptItem(i, j) {
  receiptEl.querySelectorAll('.r-item').forEach((el) => {
    el.classList.toggle('active', +el.dataset.n === j);
  });
}
function activateDot(i, j) {
  const f = figs[i], s = STAGES[i], dots = stageDots(i);
  f.dots.forEach((d, k) => d.classList.toggle('active', k === j));
  f.activeDot = j;
  highlightReceiptItem(i, j);
  if (!f.dots[j]) { if (f.label) f.label.style.display = 'none'; return; }
  const dot = dots[j];
  f.label.textContent = s.tags[j];
  f.label.style.display = 'block';
  f.label.classList.remove('pop'); void f.label.offsetWidth; f.label.classList.add('pop');
  f.label.style.top = dot[1] + '%';
  if (W < 760) {
    /* 移动端：顶部圆点（≤32%）的标签放圆点下方，避开标题与提示行；
       其余圆点标签放上方，避免被底部抽屉遮住 */
    if (dot[1] <= 32) {
      f.label.style.top = `calc(${dot[1]}% + 16px)`;
      f.label.style.transform = 'translate(-50%, 0)';
    } else {
      f.label.style.top = `calc(${dot[1]}% - 24px)`;
      f.label.style.transform = 'translate(-50%,-100%)';
    }
    f.label.style.left = dot[0] + '%';
    f.label.style.right = 'auto';
    f.label.style.animation = 'none';
    f.label.classList.remove('flip');
  } else if (dot[0] > 62) {
    f.label.style.transform = ''; f.label.style.animation = '';
    f.label.style.left = 'auto'; f.label.style.right = `calc(${100 - dot[0]}% + 13px)`;
    f.label.classList.add('flip');
  } else {
    f.label.style.transform = ''; f.label.style.animation = '';
    f.label.style.right = 'auto'; f.label.style.left = `calc(${dot[0]}% + 13px)`;
    f.label.classList.remove('flip');
  }
}

/* ---------- 生涯总账单（Master Receipt） ---------- */
let masterOpen = false;
function buildMaster() {
  const rows = STAGES.map((s, i) =>
    `<div class="m-row" data-i="${i}" role="button" tabindex="0">` +
    `<span class="m-num">${s.num}</span>` +
    `<span class="m-en">${s.en} <span class="m-zh">${s.zh}</span></span>` +
    `<span class="m-years">${s.years} · ${s.org}</span>` +
    `<span class="m-dur">${s.duration}</span></div>`).join('');
  masterReceipt.innerHTML =
    `<div class="m-head"><div class="r-logo">MAKER<sup>®</sup></div>` +
    `<div class="r-sub">MASTER RECEIPT — CAREER ARCHIVE · EST. 2012</div></div>` +
    `<div class="r-rule"></div><div class="m-rows">${rows}</div><div class="r-rule"></div>` +
    `<div class="r-total"><span class="tl">TOTAL</span><span class="tv">11 年 · 6 阶段</span></div>` +
    `<div class="r-summary">2012 校园出发，2025 造物者进行中。点击任意一行跳回该阶段。</div>` +
    `<div class="m-actions"><button type="button" id="masterPrint">打印 / 保存 PDF</button>` +
    `<button type="button" id="masterClose">关闭</button></div>`;
  masterReceipt.querySelectorAll('.m-row').forEach((row) => {
    const go = () => {
      const i = +row.dataset.i;
      closeMaster();
      setMode('ring');
      rotateTo(i);
      updateUI(i);
    };
    row.addEventListener('click', go);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
  });
  document.getElementById('masterPrint').addEventListener('click', () => window.print());
  document.getElementById('masterClose').addEventListener('click', closeMaster);
}
function openMaster() {
  buildMaster();
  masterOpen = true;
  masterBackdrop.classList.add('open');
  masterBackdrop.setAttribute('aria-hidden', 'false');
}
function closeMaster() {
  masterOpen = false;
  masterBackdrop.classList.remove('open');
  masterBackdrop.setAttribute('aria-hidden', 'true');
}

/* ---------- 指针 / 拖拽 ---------- */
let pDown = null;
stage.addEventListener('pointerdown', (e) => {
  if (mode === 'detail') return;
  dragging = true; inertia = false; spinVel = 0; dragVel = 0;
  if (mode === 'ring') {
    cursorEl.classList.add('drag');
    cursorEl.textContent = 'DRAG';
    cursorEl.classList.remove('view', 'turn');
  }
  pDown = { x: e.clientX, y: e.clientY, lastX: e.clientX, t: performance.now(), moved: 0 };
  try { stage.setPointerCapture(e.pointerId); } catch (_) {}
  lastInteract = performance.now();
});
stage.addEventListener('pointermove', (e) => {
  if (!dragging || !pDown) return;
  const dx = e.clientX - pDown.lastX;
  pDown.lastX = e.clientX;
  pDown.moved += Math.abs(dx);
  if (mode === 'ring') {
    targetTheta += dx * 0.005;
    dragVel = dragVel * 0.6 + dx * 0.005 * 0.4;
  }
  lastInteract = performance.now();
});
function endPointer(e) {
  if (!dragging) return;
  dragging = false;
  cursorEl.classList.remove('drag');
  const wasClick = pDown && pDown.moved < 6 && (performance.now() - pDown.t) < 600;
  if (wasClick && e) {
    const hit = hitTest(e.clientX, e.clientY);
    if (hit >= 0) {
      if (mode === 'grid') openDetail(hit);
      else if (hit === frontIndex()) openDetail(hit);
      else rotateTo(hit);
    }
  } else if (mode === 'ring') {
    spinVel = dragVel * 2.4;
    inertia = Math.abs(spinVel) > 0.0012;
    if (!inertia) targetTheta = Math.round(targetTheta / STEP) * STEP;
  }
  pDown = null;
  lastInteract = performance.now();
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', () => endPointer(null));

stage.addEventListener('wheel', (e) => {
  if (mode !== 'ring') return;
  e.preventDefault();
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  targetTheta += d * 0.0022;
  inertia = false;
  lastInteract = performance.now();
  clearTimeout(stage._wt);
  stage._wt = setTimeout(() => { targetTheta = Math.round(targetTheta / STEP) * STEP; }, 160);
}, { passive: false });

function hitTest(px, py) {
  const r = screenEl.getBoundingClientRect();
  const x = px - r.left, y = py - r.top;
  let best = -1, bz = -1;
  figs.forEach((f, i) => {
    const shrink = mode === 'ring' ? 0.72 : 1;
    const w = (f.rect.r - f.rect.l) * shrink, cx = (f.rect.l + f.rect.r) / 2;
    if (x >= cx - w / 2 && x <= cx + w / 2 && y >= f.rect.t && y <= f.rect.b && f.rect.z >= bz) {
      if (f.cur.o > 0.25) { best = i; bz = f.rect.z; }
    }
  });
  return best;
}

/* ---------- 语义化自定义光标：VIEW / TURN / DRAG ---------- */
let curX = -100, curY = -100, curTX = -100, curTY = -100, curScale = 1;
function setCursorText(txt, cls) {
  if (cursorEl.textContent !== txt) cursorEl.textContent = txt;
  cursorEl.classList.toggle('view', cls === 'view');
  cursorEl.classList.toggle('turn', cls === 'turn');
}
window.addEventListener('pointermove', (e) => {
  curTX = e.clientX; curTY = e.clientY;
  const overUI = e.target.closest && e.target.closest('button, .receipt-wrap, .topbar, a, .dot, .master-backdrop');
  const onStage = e.target === stage || (e.target.closest && e.target.closest('#stage'));
  if (mode === 'grid' && onStage && !overUI) {
    const hit = hitTest(e.clientX, e.clientY);
    figs.forEach((f, i) => { f.hoverLift = (i === hit); });
    stage.style.cursor = hit >= 0 ? 'pointer' : '';
    cursorEl.classList.remove('show');
  } else if (mode === 'ring' && onStage && !overUI && !dragging) {
    const hit = hitTest(e.clientX, e.clientY);
    if (hit === frontIndex()) setCursorText('VIEW', 'view');
    else if (hit >= 0) setCursorText('TURN', 'turn');
    else setCursorText('DRAG', '');
    cursorEl.classList.add('show');
    figs.forEach((f) => { f.hoverLift = false; });
    stage.style.cursor = '';
  } else {
    cursorEl.classList.remove('show');
    figs.forEach((f) => { f.hoverLift = false; });
    if (mode === 'grid') stage.style.cursor = '';
  }
});

/* ---------- 键盘 ---------- */
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (masterOpen) closeMaster(); else closeDetail(); }
  else if (mode === 'detail' && e.key === 'ArrowRight') stepDetail(1);
  else if (mode === 'detail' && e.key === 'ArrowLeft') stepDetail(-1);
  else if (mode === 'ring' && e.key === 'ArrowRight') stepStage(1);
  else if (mode === 'ring' && e.key === 'ArrowLeft') stepStage(-1);
});

/* ---------- 主循环 ---------- */
function desired(i) {
  if (mode === 'ring') {
    const a = i * STEP + theta, d = (Math.cos(a) + 1) / 2;
    const Rx = W < 760 ? W * 0.40 : W * 0.365, Ry = Rx * 0.28;
    const cx = W / 2, cy = H * (W < 760 ? 0.50 : 0.48);
    return { x: cx + Rx * Math.sin(a), y: cy + Ry * Math.cos(a),
             s: .46 + .72 * d, o: .62 + .38 * d, b: (1 - d) * 7, d };
  }
  if (mode === 'grid') {
    const slot = GRID_SLOTS[i], gs = (H * 0.30) / figH;
    const lift = figs[i].hoverLift ? 1.05 : 1;
    return { x: slot.x / 100 * W, y: slot.y / 100 * H - (figs[i].hoverLift ? 8 : 0),
             s: gs * lift, o: 1, b: 0, d: .6 };
  }
  /* detail：移动端人物上移微缩，上半屏热点 + 下半屏小票抽屉 */
  if (i === detailIdx) {
    if (W < 760) {
      const ds = (H * 0.44) / figH;
      return { x: W * 0.5, y: H * 0.48, s: ds, o: 1, b: 0, d: 1 };
    }
    const ds = (H * 0.80) / figH;
    return { x: W * 0.36, y: H * 0.965, s: ds, o: 1, b: 0, d: 1 };
  }
  const aw = figs[i].away || figs[i].cur;
  const heroX = W < 760 ? W * 0.5 : W * 0.36;
  return { x: aw.x + (heroX - aw.x) * 0.05, y: aw.y + 16, s: aw.s * 0.7, o: 0, b: 6, d: 0 };
}

/* dt：帧间隔归一化（以 60Hz 为 1），120Hz 屏上阻尼与回弹手感与 60Hz 一致 */
let lastTime = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = lastTime ? Math.min((now - lastTime) / 16.67, 3) : 1;
  lastTime = now;
  const damp = (base) => 1 - Math.pow(1 - base, dt);
  if (mode === 'ring') {
    if (!dragging && inertia) {
      targetTheta += spinVel * dt;
      spinVel *= Math.pow(0.94, dt);
      if (Math.abs(spinVel) < 0.0012) {
        inertia = false;
        targetTheta = Math.round(targetTheta / STEP) * STEP;
      }
    }
    if (!dragging && playing && !reduced && now - lastInteract > 2500 && now - lastAdvance > 3600) {
      stepStage(1); lastAdvance = now;
    }
    theta += (targetTheta - theta) * damp(dragging ? 0.45 : 0.085);
    const fi = frontIndex();
    if (fi !== current && Math.abs(targetTheta - theta) < 0.3) updateUI(fi);
    ringTicksEl.setAttribute('transform', `rotate(${(-theta * 180 / Math.PI).toFixed(2)} 300 90)`);
  }
  const t = now / 1000;
  for (let i = 0; i < N; i++) {
    const f = figs[i], des = desired(i), cur = f.cur;
    if (f.delay > 0) { f.delay -= dt; }
    else {
      const k = (mode === 'ring' && blendFrames <= 0) ? 1 : damp(0.14);
      cur.x += (des.x - cur.x) * k; cur.y += (des.y - cur.y) * k;
      cur.s += (des.s - cur.s) * k; cur.o += (des.o - cur.o) * k;
      cur.b += (des.b - cur.b) * k;
    }
    let bob = 0, bobN = 0;
    if (mode === 'ring' && !reduced) {
      bobN = Math.sin(t * 2.4 + i * 1.7);
      bob = bobN * 5 * (.35 + .65 * (des.d || 0));
    }
    f.el.style.width = figW + 'px';
    f.el.style.transform = `translate3d(${cur.x}px, ${cur.y}px, 0) scale(${cur.s}) translate(-50%, -100%)`;
    f.el.style.opacity = cur.o.toFixed(3);
    f.el.style.zIndex = mode === 'detail' ? (i === detailIdx ? 300 : 40) :
                        mode === 'grid' ? 20 + i : Math.round((des.d || 0) * 100);
    f.bob.style.transform = `translateY(${bob}px)`;
    f.img.style.filter = cur.b > 0.15 ? `blur(${cur.b.toFixed(2)}px)` : '';
    const shS = 1 - bobN * 0.07;
    f.shadow.style.transform = `translateX(-50%) scale(${shS}, ${0.9 - bobN * 0.05})`;
    f.shadow.style.opacity = mode === 'ring' ? (.35 + .65 * (des.d || 0)) : .8;
    const wpx = figW * cur.s, hpx = figH * cur.s;
    f.rect = { l: cur.x - wpx / 2, r: cur.x + wpx / 2, t: cur.y - hpx, b: cur.y, z: Number(f.el.style.zIndex) || 0 };
  }
  if (blendFrames > 0) blendFrames -= dt;
  /* 光标跟随 */
  curX += (curTX - curX) * damp(0.35); curY += (curTY - curY) * damp(0.35);
  const ts = dragging ? 0.78 : 1;
  curScale += (ts - curScale) * damp(0.3);
  cursorEl.style.transform = `translate3d(${curX}px, ${curY}px, 0) translate(-50%, -50%) scale(${curScale})`;
}
requestAnimationFrame(frame);
