<template>
  <div ref="wrapEl" class="fw-stage">
    <canvas ref="canvasEl" class="fw-canvas" aria-hidden="true"></canvas>
    <span class="fw-text">Hi BaudLab！</span>
  </div>
</template>

<script setup>
/* 登录弹窗问候区 —— 真实「放烟花」动画（替代原先的 🎉 emoji 占位）
 *
 * 说明：
 * - 用 <canvas> 自绘：火箭拖尾升空 → 到达顶点炸开成放射状火花 → 受重力下落并渐隐。
 * - 不引入任何第三方库；尺寸随容器（ResizeObserver + DPR 自适应），窗口缩放宽高都跟随。
 * - 与贪吃蛇 logo 一致的手动开关：控制台执行 document.documentElement.dataset.spmAnimate='0'
 *   即冻结为静态一帧，不做动画。 */
import { onBeforeUnmount, onMounted, ref } from 'vue';

const wrapEl = ref(null);
const canvasEl = ref(null);

let ctx = null;
let rafId = 0;
let width = 0;
let height = 0;
let dpr = 1;
let lastTs = 0;
let nextLaunchAt = 0;   // 下一次发射火箭的时间戳
let resizeObserver = null;

const rockets = [];     // 升空中的火箭
const sparks = [];      // 爆炸后的火花

/* 调色板：深/浅两套主题下都足够醒目，取自设计令牌的语义色相 */
const PALETTE = ['#5e6ad2', '#828fff', '#f59e0b', '#f43f5e', '#14b8a6', '#8b5cf6', '#facc15'];

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

/* 动画开关：只有显式设为 '0' 才停（与贪吃蛇 logo 同一约定） */
function animationEnabled() {
  return document.documentElement.dataset.spmAnimate !== '0';
}

function resize() {
  const wrap = wrapEl.value;
  const canvas = canvasEl.value;
  if (!wrap || !canvas) return;
  const rect = wrap.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  width = rect.width;
  height = rect.height;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function spawnRocket() {
  rockets.push({
    x: rand(width * 0.16, width * 0.84),
    y: height + 4,
    vx: rand(-14, 14),
    vy: -rand(62, 98),
    targetY: rand(height * 0.06, height * 0.42),
    color: pick(PALETTE),
  });
}

function explode(x, y, color) {
  const count = 16 + Math.floor(Math.random() * 12);
  const ring = Math.random() < 0.35;   // 约 1/3 概率形成规整环形
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + rand(-0.12, 0.12);
    const speed = ring ? rand(32, 40) : rand(16, 60);
    const life = rand(0.55, 1.05);
    sparks.push({
      x, y, px: x, py: y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      color: Math.random() < 0.75 ? color : pick(PALETTE),
      life, maxLife: life,
    });
  }
  // 中心白色闪光
  sparks.push({ x, y, px: x, py: y, vx: 0, vy: 0, color: '#ffffff', life: 0.16, maxLife: 0.16, flash: true });
}

function step(dt) {
  const gravity = 130;
  const damp = Math.exp(-2.2 * dt);   // 空气阻力（与帧率无关）

  for (let i = rockets.length - 1; i >= 0; i--) {
    const r = rockets[i];
    r.x += r.vx * dt;
    r.y += r.vy * dt;
    r.vy += gravity * dt;
    if (r.y <= r.targetY || r.vy >= 0) {
      explode(r.x, r.y, r.color);
      rockets.splice(i, 1);
    }
  }

  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.px = s.x;
    s.py = s.y;
    s.vy += gravity * dt;
    s.vx *= damp;
    s.vy *= damp;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.life -= dt;
    if (s.life <= 0) sparks.splice(i, 1);
  }
}

function draw() {
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);

  // 火箭：一小段拖尾 + 亮头
  ctx.lineCap = 'round';
  for (const r of rockets) {
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = r.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(r.x - r.vx * 0.06, r.y - r.vy * 0.06);
    ctx.lineTo(r.x, r.y);
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(r.x, r.y, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }

  // 火花：线段拖尾 + 随生命淡出
  for (const s of sparks) {
    const t = Math.max(0, s.life / s.maxLife);
    ctx.globalAlpha = t;
    ctx.fillStyle = s.color;
    if (s.flash) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, 5.5, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(s.px, s.py);
    ctx.lineTo(s.x, s.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function frame(ts) {
  rafId = requestAnimationFrame(frame);
  if (!lastTs) { lastTs = ts; return; }
  const dt = Math.min(0.05, (ts - lastTs) / 1000);   // 切后台回来时钳制，避免瞬移
  lastTs = ts;

  if (ts >= nextLaunchAt) {
    spawnRocket();
    if (Math.random() < 0.35) spawnRocket();          // 偶尔双发
    nextLaunchAt = ts + rand(700, 1500);
  }
  step(dt);
  draw();
}

/* 静态一帧：动画被手动关闭时仍展示一次展开的烟花 */
function drawStaticBurst() {
  if (!ctx) return;
  explode(width * 0.5, height * 0.46, PALETTE[0]);
  // 让火花散开到展开状态再定格
  for (let i = 0; i < 14; i++) step(0.016);
  draw();
}

onMounted(() => {
  resize();
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => resize());
    if (wrapEl.value) resizeObserver.observe(wrapEl.value);
  }
  window.addEventListener('resize', resize);

  if (animationEnabled()) {
    rafId = requestAnimationFrame(frame);
  } else {
    drawStaticBurst();
  }
});

onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  window.removeEventListener('resize', resize);
  if (resizeObserver) resizeObserver.disconnect();
  resizeObserver = null;
  rockets.length = 0;
  sparks.length = 0;
});
</script>

<style scoped>
.fw-stage {
  position: relative;
  width: 100%;
  height: 78px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.fw-canvas {
  position: absolute;
  inset: 0;
  display: block;
}

.fw-text {
  position: relative;
  z-index: 1;
  font-size: 24px;
  font-weight: 800;
  letter-spacing: 0.3px;
  white-space: nowrap;
  pointer-events: none;
  background: linear-gradient(100deg, var(--accent, #5e6ad2), var(--accent-hover, #828fff) 45%, var(--accent-amber, #f59e0b));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  -webkit-text-fill-color: transparent;
  animation: fw-text-float 3.6s ease-in-out infinite;
}

@keyframes fw-text-float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-3px); }
}
</style>
