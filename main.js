/* MAKER® — 职业形象转盘
   纯静态，无外部依赖。内容全部来自个人经历记录，数字与事实原样保留。
   照片槽位：assets/stages/stage-01.jpg ~ stage-06.jpg，文件存在时自动替换 SVG 占位剪影。 */

'use strict';

const STAGES = [
  {
    id: 'stage-01', num: '01', en: 'CAMPUS', zh: '校园',
    years: '2012–2016', org: '广东工业大学',
    color: '#33565d', dark: '#22393f', prop: 'book',
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
    tags: ['Java', 'HarmonyOS', '开源治理', '漏洞管理', 'AI 工具栏'],
  },
  {
    id: 'stage-06', num: '06', en: 'MAKER', zh: '造物者',
    years: '2025–至今', org: '重新找回创造力',
    color: '#b4452f', dark: '#8c3524', prop: 'spark',
    duration: '进行中',
    summary: '老兵开始造自己的东西',
    items: [
      '重新找回创造力的程序员',
      '微信公众号 OoneAI：AI 生图与视频生成',
      'Seedream 5.5 深度测评：高赞案例汇总',
      'Minimax H3 视频生成 + ComfyUI',
    ],
    tags: ['OoneAI', 'Seedream', 'Minimax H3', 'ComfyUI', 'AI 生图'],
  },
];

/* ---------- 俯视人物剪影（SVG 占位，照片到位后由照片替换） ---------- */
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
  return `<svg viewBox="0 0 200 240" aria-hidden="true">
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

/* 照片槽位：assets/stages/stage-0X.jpg 存在时自动替换剪影 */
function photoImg(s) {
  return `<img class="stage-photo" src="assets/stages/${s.id}.jpg?v=3" alt="${s.en} ${s.zh} 阶段照片" onload="this.closest('.fig-body').classList.add('has-photo')" onerror="this.closest('.fig-body').classList.add('photo-failed')">`;
}

/* ---------- 状态 ---------- */
let selected = null;
let dragX = 0;
let suppressClick = false;

const stageEl = document.getElementById('stage');
const hintEl = document.getElementById('stageHint');
const dragBadge = document.getElementById('dragBadge');
const numEl = document.getElementById('currentNum');
const nameEl = document.getElementById('currentName');
const tagsEl = document.getElementById('tags');
const receiptBtn = document.getElementById('receiptBtn');
const receiptEl = document.getElementById('receipt');
const receiptShadow = document.getElementById('receiptShadow');
const receiptInner = document.getElementById('receiptInner');
const scrimEl = document.getElementById('scrim');


/* ---------- 生成人物 ---------- */
const figures = STAGES.map((s, i) => {
  const btn = document.createElement('button');
  btn.className = 'figure';
  btn.type = 'button';
  btn.setAttribute('aria-label', `${s.num} ${s.en} ${s.zh}，${s.years}，点击查看档案`);
  btn.innerHTML =
    `<span class="fig-body">${figureSVG(s)}${photoImg(s)}<span class="fig-num">${s.num}</span></span>` +
    `<span class="fig-label">${s.num} · ${s.en}</span>`;
  btn.addEventListener('click', () => {
    if (suppressClick) return;
    activate(i);
  });
  stageEl.appendChild(btn);
  return btn;
});
const figBodies = figures.map((f) => f.querySelector('.fig-body'));

/* ================================================================
   轮盘引擎（移植自 NOWHERE 复刻页的环形轮盘）：
   连续角度 theta 向 targetTheta 弹性趋近；人物按角度分布在压扁的
   椭圆环上，深度 d=(cos+1)/2 映射缩放 / 透明度 / 模糊 / 层级；
   拖拽带惯性，松手回弹吸附到最近阶段；滚轮步进；空闲自动轮播。
   ================================================================ */
const N = STAGES.length;
const TAU = Math.PI * 2;
const STEP = TAU / N;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let theta = 0, targetTheta = 0;
let dragging = false, spinVel = 0, dragVel = 0, inertia = false;
let playing = !reducedMotion;
let lastInteract = performance.now(), lastAdvance = performance.now();

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
function activate(i) {
  if (i === frontIndex() && Math.abs(targetTheta - theta) < 0.3) openReceipt(i);
  else rotateTo(i);
}

/* ---------- 底部信息 + 标签 ---------- */
function restartAnim(el, cls) {
  el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
}
function updateBottom() {
  if (selected === null) {
    numEl.textContent = '— / 06';
    nameEl.innerHTML = '选择一个阶段<small>6 STAGES · 2012 — NOW</small>';
    tagsEl.innerHTML = '';
    receiptBtn.disabled = true;
    receiptBtn.textContent = '查看档案 →';
    return;
  }
  const s = STAGES[selected];
  numEl.textContent = `${s.num} / 06`;
  restartAnim(numEl, 'roll');
  nameEl.innerHTML = `${s.en}<small>${s.zh} · ${s.years}</small>`;
  restartAnim(nameEl, 'swap');
  tagsEl.innerHTML = s.tags.map((t) =>
    `<span class="tag"><i style="--tag-color:${s.color}"></i>${t}</span>`).join('');
  receiptBtn.disabled = false;
  receiptBtn.textContent = receiptEl.classList.contains('open') ? '关闭档案 ×' : '查看档案 →';
}

/* ---------- 档案收据 ---------- */
/* 详情态布局（同步 NOWHERE 复刻页 v2）：开档案时舞台左移、主角放大、
   其余人物缩小并向中心收拢，按索引逐个错峰过渡 */
let detailOn = false, detailT0 = 0;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
function detailAmt(i, now) {
  const p = Math.min(Math.max((now - detailT0 - i * 36) / 420, 0), 1);
  const e = easeOut(p);
  return detailOn ? e : 1 - e;
}

function openReceipt(i) {
  const s = STAGES[i];
  receiptInner.innerHTML =
    `<div class="r-head">MAKER<sup>®</sup></div>
     <div class="r-meta">VOL. 01 — CAREER ARCHIVE · 2012 — NOW</div>
     <div class="r-stage">STAGE ${s.num} · ${s.en} ${s.zh}</div>
     <div class="r-years">${s.years.replace('–', ' – ')} · ${s.org}</div>
     <hr class="r-rule">
     ${s.items.map((t, n) =>
       `<div class="r-row"><span class="r-no">${String(n + 1).padStart(2, '0')}</span><span>${t}</span></div>`).join('')}
     <hr class="r-rule">
     <div class="r-total"><span>TOTAL</span><span>${s.duration}</span></div>
     <div class="r-summary">${s.summary}</div>
     <div class="barcode" aria-hidden="true"></div>
     <div class="r-foot">THANKS FOR VISITING.</div>`;
  if (!receiptEl.classList.contains('open')) {
    detailOn = true; detailT0 = performance.now();
    if (receiptShadow) receiptShadow.classList.add('open');
  }
  receiptEl.classList.add('open');
  receiptEl.setAttribute('aria-hidden', 'false');
  scrimEl.hidden = false;
  updateBottom();
}

function closeReceipt() {
  if (receiptEl.classList.contains('open')) {
    detailOn = false; detailT0 = performance.now();
    if (receiptShadow) receiptShadow.classList.remove('open');
  }
  receiptEl.classList.remove('open');
  receiptEl.setAttribute('aria-hidden', 'true');
  scrimEl.hidden = true;
  updateBottom();
}

receiptBtn.addEventListener('click', () => {
  if (selected === null) return;
  if (receiptEl.classList.contains('open')) closeReceipt();
  else openReceipt(selected);
});
document.getElementById('receiptClose').addEventListener('click', closeReceipt);
scrimEl.addEventListener('click', closeReceipt);

/* ---------- 拖拽：连续旋转 + 惯性 + 回弹吸附 ----------
   不在 stage 上 setPointerCapture，否则会抢掉人物按钮的 click；
   沿用 window 监听，位移超过阈值时用 suppressClick 吞掉点击。 */
let pDown = null;
stageEl.addEventListener('pointerdown', (e) => {
  const fig = e.target.closest ? e.target.closest('.figure') : null;
  dragging = true; inertia = false; spinVel = 0; dragVel = 0;
  pDown = {
    lastX: e.clientX, t: performance.now(), moved: 0,
    idx: fig ? figures.indexOf(fig) : -1,
  };
  stageEl.classList.add('dragging');
  lastInteract = performance.now();
});
window.addEventListener('pointermove', (e) => {
  if (!dragging || !pDown) return;
  const dx = e.clientX - pDown.lastX;
  pDown.lastX = e.clientX;
  pDown.moved += Math.abs(dx);
  targetTheta += dx * 0.005;
  dragVel = dragVel * 0.6 + dx * 0.005 * 0.4;
  lastInteract = performance.now();
});
function endDrag() {
  if (!dragging) return;
  dragging = false;
  stageEl.classList.remove('dragging');
  const wasClick = pDown && pDown.moved < 6 && (performance.now() - pDown.t) < 600;
  if (wasClick) {
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 120);
    if (pDown.idx >= 0) activate(pDown.idx);
    else if (receiptEl.classList.contains('open')) closeReceipt();
  } else {
    spinVel = dragVel * 2.4;
    inertia = Math.abs(spinVel) > 0.0012;
    if (!inertia) targetTheta = Math.round(targetTheta / STEP) * STEP;
  }
  pDown = null;
  lastInteract = performance.now();
}
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

/* ---------- 滚轮步进 ---------- */
stageEl.addEventListener('wheel', (e) => {
  if (!stageViewEl.hidden) { /* 转盘可见时才接管 */ } else return;
  e.preventDefault();
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  targetTheta += d * 0.0022;
  inertia = false;
  lastInteract = performance.now();
  clearTimeout(stageEl._wt);
  stageEl._wt = setTimeout(() => { targetTheta = Math.round(targetTheta / STEP) * STEP; }, 160);
}, { passive: false });

/* ---------- 自动轮播开关 ---------- */
const playBtn = document.getElementById('playBtn');
const SVG_PAUSE = '<svg width="9" height="10" viewBox="0 0 9 10"><rect x="0" y="0" width="3" height="10" fill="currentColor"/><rect x="6" y="0" width="3" height="10" fill="currentColor"/></svg>';
const SVG_PLAY = '<svg width="9" height="10" viewBox="0 0 9 10"><path d="M0 0 L9 5 L0 10 Z" fill="currentColor"/></svg>';
function renderPlay() {
  if (!playBtn) return;
  playBtn.innerHTML = playing ? SVG_PAUSE : SVG_PLAY;
  playBtn.setAttribute('aria-label', playing ? '暂停自动旋转' : '播放自动旋转');
}
if (playBtn) playBtn.addEventListener('click', () => {
  playing = !playing; renderPlay(); lastInteract = performance.now();
});
renderPlay();

/* ---------- DRAG 跟随光标 ---------- */
const cursorEl = document.getElementById('cursor');
let curX = -100, curY = -100, curTX = -100, curTY = -100, curScale = 1;
window.addEventListener('pointermove', (e) => {
  curTX = e.clientX; curTY = e.clientY;
  if (!cursorEl) return;
  const onStage = e.target === stageEl || (e.target.closest && e.target.closest('#stage'));
  if (onStage && !stageViewEl.hidden) cursorEl.classList.add('show');
  else cursorEl.classList.remove('show');
});

/* ---------- 九宫格总览 ---------- */
const gridEl = document.getElementById('grid');
STAGES.forEach((s, i) => {
  const card = document.createElement('button');
  card.className = 'grid-card';
  card.type = 'button';
  card.setAttribute('aria-label', `${s.num} ${s.en} ${s.zh}，${s.years}`);
  card.innerHTML =
    `<span class="fig-body">${figureSVG(s)}${photoImg(s)}</span>` +
    `<h3>${s.num} · ${s.en}</h3><p>${s.zh}</p><p class="years">${s.years}</p>`;
  card.addEventListener('click', () => {
    showStages();
    selected = i;
    rotateTo(i);
    updateBottom();
    openReceipt(i);
  });
  gridEl.appendChild(card);
});

/* ---------- 视图切换 ---------- */
const stageViewEl = document.getElementById('stageView');
const gridView = document.getElementById('gridView');
const toggleStages = document.getElementById('toggleStages');
const toggleGrid = document.getElementById('toggleGrid');
const switchStages = document.getElementById('switchStages');
const switchGrid = document.getElementById('switchGrid');

function showStages() {
  stageViewEl.hidden = false;
  gridView.hidden = true;
  gridView.classList.remove('enter');
  toggleStages.classList.add('active');
  toggleGrid.classList.remove('active');
  switchStages.classList.add('active');
  switchGrid.classList.remove('active');
}
function showGrid() {
  stageViewEl.hidden = true;
  gridView.hidden = false;
  gridView.querySelectorAll('.grid-card').forEach((c, i) => c.style.setProperty('--d', `${i * 45}ms`));
  gridView.classList.remove('enter');
  void gridView.offsetWidth;
  gridView.classList.add('enter');
  toggleGrid.classList.add('active');
  toggleStages.classList.remove('active');
  switchGrid.classList.add('active');
  switchStages.classList.remove('active');
}
toggleStages.addEventListener('click', showStages);
toggleGrid.addEventListener('click', showGrid);
switchStages.addEventListener('click', showStages);
switchGrid.addEventListener('click', showGrid);

/* ---------- 键盘 ---------- */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeReceipt(); return; }
  if (stageViewEl.hidden) return;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  stepStage(e.key === 'ArrowRight' ? 1 : -1);
});

/* ---------- 正面同步 ---------- */
function syncFront() {
  const fi = frontIndex();
  if (fi !== selected && Math.abs(targetTheta - theta) < 0.35) {
    selected = fi;
    figures.forEach((el, i) => el.classList.toggle('selected', i === fi));
    updateBottom();
    if (receiptEl.classList.contains('open')) openReceipt(fi);
    hintEl.textContent = '点击正面人物查看档案 · 拖动或滚轮旋转转盘';
  }
}

/* ---------- 主循环 ---------- */
function frame(now) {
  requestAnimationFrame(frame);
  if (!stageViewEl.hidden) {
    /* 旋转物理 */
    if (!dragging && inertia) {
      targetTheta += spinVel;
      spinVel *= 0.94;
      if (Math.abs(spinVel) < 0.0012) {
        inertia = false;
        targetTheta = Math.round(targetTheta / STEP) * STEP;
      }
    }
    if (!dragging && playing && !receiptEl.classList.contains('open')
        && now - lastInteract > 2500 && now - lastAdvance > 3400) {
      stepStage(1); lastAdvance = now;
    }
    theta += (targetTheta - theta) * (dragging ? 0.45 : 0.085);
    syncFront();

    /* 环形布局 */
    const W = stageEl.clientWidth, H = stageEl.clientHeight;
    if (W > 50 && H > 50) {
      const Rx = W < 760 ? W * 0.40 : Math.min(W * 0.36, 560);
      const Ry = Rx * 0.28;
      const baseY = H * 0.96;
      const figH = figures[0].offsetHeight || 242;
      const t = now / 1000;
      for (let i = 0; i < N; i++) {
        const a = i * STEP + theta;
        const d = (Math.cos(a) + 1) / 2;
        let x = Rx * Math.sin(a);
        const y = baseY + Ry * Math.cos(a) - figH;
        let s = 0.46 + 0.72 * d;
        let o = 0.62 + 0.38 * d;
        const amt = detailAmt(i, now);
        if (amt > 0.001) {
          const shift = -Math.min(W * 0.15, 180) * amt;
          if (i === selected) { x += shift; s *= 1 + 0.10 * amt; }
          else { x = x * (1 - 0.25 * amt) + shift; s *= 1 - 0.30 * amt; o *= 1 - 0.30 * amt; }
        }
        const el = figures[i];
        el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${s.toFixed(3)})`;
        el.style.opacity = o.toFixed(3);
        el.style.zIndex = String(Math.round(d * 100));
        const blur = (1 - d) * 7;
        figBodies[i].style.filter = blur > 0.15 ? `blur(${blur.toFixed(2)}px)` : '';
        const bob = reducedMotion ? 0 : Math.sin(t * 2.2 + i * 1.7) * 4 * (0.35 + 0.65 * d);
        figBodies[i].style.transform = `translateY(${bob.toFixed(1)}px)`;
      }
    }
  }
  /* 光标跟随 */
  if (cursorEl) {
    cursorEl.classList.toggle('drag', dragging);
    curX += (curTX - curX) * 0.35; curY += (curTY - curY) * 0.35;
    const ts = dragging ? 0.78 : 1;
    curScale += (ts - curScale) * 0.3;
    cursorEl.style.transform = `translate3d(${curX}px, ${curY}px, 0) translate(-50%, -50%) scale(${curScale})`;
  }
}

/* ---------- 初始化 ---------- */
selected = 0;
figures[0].classList.add('selected');
hintEl.textContent = '拖动转盘浏览 · 点击正面人物查看档案';
updateBottom();
requestAnimationFrame(frame);
