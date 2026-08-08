import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import gsap from 'gsap';
import html2canvas from 'html2canvas';

// ==================== STATE VARIABLES ====================
let cards = [];
let platforms = [];
let poolPlatform = null;
let draggedCard = null;
let hoveredCard = null;
let hoveredPlatform = null;
let isDragging = false;
let lastMousePos = { x: 0, y: 0 };
let dragSourceColor; // assigned from the active skin palette below
let mouse = new THREE.Vector2();
let raycaster = new THREE.Raycaster();
let intersectionPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const reticlePlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); // z=0 plane for HUD coordinate readout
let dragOffset = new THREE.Vector3();
let activeBurstParticles = [];
let activeDragTrails = [];
let activeLockBeams = [];
let scanLineMeshes = [];
let poolScanMesh = null; // 待判定域 constant radar-sweep strip
let dragSpinSpeed = 0;
// 全景模式（全息领奖台）总开关 —— 拖拽/悬停/待机视差都以此为门
let panoActive = false;

const clock = new THREE.Clock();

// ==================== HUD SYSTEM (2D layer behavior) ====================
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const hudReticle = document.getElementById('hud-reticle');
const retCoords = document.getElementById('ret-coords');
let reticleTarget = { x: -100, y: -100 };
let reticlePos = { x: -100, y: -100 };
let mouseParallax = { x: 0, y: 0 }; // smoothed NDC for camera drift

function showHudToast(message) {
  const toast = document.getElementById('hud-toast');
  const text = document.getElementById('hud-toast-text');
  if (!toast || !text) return;
  text.textContent = message;
  toast.classList.add('show');
  clearTimeout(showHudToast._timer);
  showHudToast._timer = setTimeout(() => toast.classList.remove('show'), 2400);
}

// Text decode/scramble effect for the title on boot
function scrambleText(el, finalText, duration = 900) {
  if (REDUCED_MOTION) { el.textContent = finalText; return; }
  const glyphs = '01<>[]/\\#*+=◆▮';
  const start = performance.now();
  function frame(now) {
    const t = Math.min((now - start) / duration, 1);
    const settled = Math.floor(t * finalText.length);
    let out = finalText.slice(0, settled);
    for (let i = settled; i < finalText.length; i++) {
      out += finalText[i] === ' ' ? ' ' : glyphs[Math.floor(Math.random() * glyphs.length)];
    }
    el.textContent = out;
    if (t < 1) requestAnimationFrame(frame);
    else el.textContent = finalText;
  }
  requestAnimationFrame(frame);
}

// Rotating interaction tips
const TIP_MESSAGES = [
  'HOVER行触发扫光 <em class="sep">◆</em> HOVER卡牌悬浮旋转 <em class="sep">◆</em> 拖拽火花尾迹 <em class="sep">◆</em> 放置液压锁止',
  '双击卡牌翻转至铭牌背面 <em class="sep">◆</em> 拖至右下角区域粉碎回收',
  '上传图片或注入文本标识符 <em class="sep">◆</em> 进度可随时存档至本地数据库',
  '视角锁定默认开启 <em class="sep">◆</em> 解锁后可自由环绕观察重装矩阵',
];
let tipIndex = 0;
function rotateTip() {
  const tipEl = document.getElementById('tip-text');
  if (!tipEl || REDUCED_MOTION) return;
  tipEl.classList.add('fading');
  setTimeout(() => {
    tipIndex = (tipIndex + 1) % TIP_MESSAGES.length;
    tipEl.innerHTML = TIP_MESSAGES[tipIndex];
    tipEl.classList.remove('fading');
  }, 300);
}

// Live HUD stats (UNITS / RANKED)
let lastStatUnits = -1;
let lastStatRanked = -1;
function updateHudStats() {
  const unitsEl = document.getElementById('stat-units');
  const rankedEl = document.getElementById('stat-ranked');
  if (!unitsEl || !rankedEl) return;
  const units = cards.length;
  const ranked = cards.filter(c => c.userData.platform && c.userData.platform.userData.type === 'tier').length;
  if (units !== lastStatUnits) {
    unitsEl.textContent = units;
    unitsEl.classList.remove('bump'); void unitsEl.offsetWidth; unitsEl.classList.add('bump');
    lastStatUnits = units;
  }
  if (ranked !== lastStatRanked) {
    rankedEl.textContent = ranked;
    rankedEl.classList.remove('bump'); void rankedEl.offsetWidth; rankedEl.classList.add('bump');
    lastStatRanked = ranked;
  }
}

// ==================== DRAFT BRIDGE（与 2D 页共享草稿 hangdaola2_state） ====================
const DRAFT_KEY = 'hangdaola2_state';
function snapshotDraft() {
  try {
    const titleEl = document.getElementById('rankTitle');
    const labelSpans = document.querySelectorAll('.tier-label span[contenteditable]');
    const tierNames = Array.from(labelSpans).map(sp => sp.innerText);
    const cardsData = cards.map(c => {
      let tier = -1;
      const pf = c.userData.platform;
      if (pf && pf.userData && pf.userData.type === 'tier') tier = pf.userData.index;
      return { type: c.userData.cardType, text: c.userData.text || null, src: c.userData.src || null, tier };
    });
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ title: titleEl ? titleEl.innerText : '', tiers: tierNames, cards: cardsData }));
  } catch (e) {}
}
function hydrateDraft() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) {}
  if (!d || !Array.isArray(d.cards) || !d.cards.length) return false;
  cards.forEach(c => scene.remove(c));
  cards = [];
  platforms.forEach(pf => { if (pf.userData) pf.userData.cards = pf.userData.type === 'tier' ? new Array(slotCount).fill(null) : []; });
  if (poolPlatform && poolPlatform.userData) poolPlatform.userData.cards = [];
  const titleEl = document.getElementById('rankTitle');
  if (titleEl && d.title) titleEl.innerText = d.title;
  const labelSpans = document.querySelectorAll('.tier-label span[contenteditable]');
  if (Array.isArray(d.tiers)) d.tiers.forEach((nm, i) => { if (labelSpans[i]) labelSpans[i].innerText = nm; if (tiers[i]) tiers[i].name = nm; });
  d.cards.forEach(cd => {
    if (cd.type === 'image' && cd.src) createImageCard(cd.src);
    else if (cd.type === 'text' && cd.text) createTextCard(cd.text);
  });
  setTimeout(() => {
    cards.forEach((c, i) => {
      const cd = d.cards[i];
      if (!cd || typeof cd.tier !== 'number' || cd.tier < 0) return;
      const target = platforms[cd.tier];
      if (!target || !target.userData) return;
      if (poolPlatform && poolPlatform.userData.cards) poolPlatform.userData.cards = poolPlatform.userData.cards.filter(x => x !== c);
      c.userData.platform = target;
      const free = target.userData.cards.indexOf(null);
      c.userData.slotIndex = free >= 0 ? free : 0;
      if (free >= 0) target.userData.cards[free] = c;
    });
    arrangeAllPlatforms();
  }, 350);
  return true;
}

// ==================== SKIN PALETTES ====================
// Two full skins: 重装机械 (mech) & 全息赛博 (cyber).
// Picked via the header skin menu, stored in localStorage, applied at boot.
const SKIN_ID = (() => {
  try { return localStorage.getItem('hangdaola_skin') === 'cyber' ? 'cyber' : 'mech'; }
  catch (e) { return 'mech'; }
})();

const THEMES = {
  mech: {
    accent: 0xffb42e,        // primary instrument glow
    accentHex: '#ffb42e',
    cssAccent: '255, 180, 46',
    signal: 0xff5247,        // danger / delete burst
    cssSignal: '255, 82, 71',
    steel: 0x7d94a8,         // cool metal contrast
    cssAccent2: '255, 122, 26',
    cssScanCore: '255, 205, 90',
    green: 0x52d273,
    deepBg: 0x0b0d10,        // must match --bg-deep in style.css
    bgHex: '#0b0d10',
    panelDark: 0x171a1f,
    cssPanel: '16, 18, 22',
    cssPanel2: '30, 34, 40',
    panelHex: '#101216',
    white: 0xece9e2,
    cssWarm: '245, 234, 214',
    textHex: '#f2ede3',
    textHex2: '#f5ead6',
    cardBody: 0x1b1e23,
    ambient: 0x2a2d33, ambientI: 0.7,
    keyLight: 0xffd9a0,
    fillLight: 0x7d94a8, fillI: 0.5,
    rimLight: 0xff8c1a,
    pointRight: 0xff7a1a,
    tierColors: [0xff453a, 0xff9f0a, 0xffd60a, 0x52d273, 0x4da3ff]
  },
  cyber: {
    accent: 0x00f0ff,
    accentHex: '#00f0ff',
    cssAccent: '0, 240, 255',
    signal: 0xff6b9d,
    cssSignal: '255, 0, 170',
    steel: 0x8b5cf6,
    cssAccent2: '139, 92, 246',
    cssScanCore: '0, 255, 255',
    green: 0x00ff88,
    deepBg: 0x020816,        // must match --bg-deep in cyber.css
    bgHex: '#020816',
    panelDark: 0x050c1e,
    cssPanel: '4, 14, 32',
    cssPanel2: '8, 22, 48',
    panelHex: '#040a18',
    white: 0xe0f4ff,
    cssWarm: '200, 250, 255',
    textHex: '#eefaff',
    textHex2: '#d8f6ff',
    cardBody: 0x080e1e,
    ambient: 0x0a1a3a, ambientI: 0.6,
    keyLight: 0x00aaff,
    fillLight: 0xff6b9d, fillI: 0.6,
    rimLight: 0x8b5cf6,
    pointRight: 0xff6b9d,
    tierColors: [0xff0055, 0xff6600, 0xffcc00, 0x00ff88, 0x00ccff]
  }
};

// Active skin palette — every visual below reads from T
const T = THEMES[SKIN_ID];
dragSourceColor = T.accent;

// ==================== SCENE SETUP ====================
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(T.deepBg);
scene.fog = new THREE.FogExp2(T.deepBg, 0.008);

// Camera - 3D Perspective angle
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
const DEFAULT_CAM_POS = new THREE.Vector3(0, -0.5, 26);
const DEFAULT_CAM_TARGET = new THREE.Vector3(0, -0.5, 0);
camera.position.copy(DEFAULT_CAM_POS);
camera.lookAt(DEFAULT_CAM_TARGET);

// Renderer
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
container.appendChild(renderer.domElement);

// Orbit Controls - default locked, can be unlocked
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(DEFAULT_CAM_TARGET);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.maxPolarAngle = Math.PI / 1.6;
controls.minDistance = 8.0;
controls.maxDistance = 50.0;
controls.autoRotate = false;
controls.enabled = false; // Locked by default

// Post-Processing - Strong Neon Bloom
const renderScene = new RenderPass(scene, camera);
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.4, 0.35, 0.5
);
bloomPass.threshold = 0.35;
bloomPass.strength = 0.55;
bloomPass.radius = 0.35;

const composer = new EffectComposer(renderer);
composer.addPass(renderScene);
composer.addPass(bloomPass);

// ==================== SKIN LIGHTING ====================
const ambientLight = new THREE.AmbientLight(T.ambient, T.ambientI);
scene.add(ambientLight);

// Key light
const keyLight = new THREE.DirectionalLight(T.keyLight, 1.2);
keyLight.position.set(10, 18, 15);
scene.add(keyLight);

// Fill light
const fillLight = new THREE.DirectionalLight(T.fillLight, T.fillI);
fillLight.position.set(-12, -6, 12);
scene.add(fillLight);

// Rim light
const rimLight = new THREE.DirectionalLight(T.rimLight, 0.7);
rimLight.position.set(0, 15, -10);
scene.add(rimLight);

// Side point lights - pulled back & widened into soft area-light washes (no sharp hotspots)
const neonLeft = new THREE.PointLight(T.accent, 0.9, 70, 2);
neonLeft.position.set(-16, 4, 16);
scene.add(neonLeft);

const neonRight = new THREE.PointLight(T.pointRight, 0.85, 70, 2);
neonRight.position.set(16, 4, 16);
scene.add(neonRight);

const neonTop = new THREE.PointLight(T.steel, 0.5, 70, 2);
neonTop.position.set(0, 16, 12);
scene.add(neonTop);

// ==================== TEXTURE GENERATORS ====================

// 1. Laser Flare Particle Texture
function createLaserFlareTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(0.15, 'rgba(' + T.cssAccent + ', 0.9)');
  gradient.addColorStop(0.5, 'rgba(' + T.cssAccent2 + ', 0.4)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

// 2. Data Fragment Texture (replaces gold coin)
function createDataFragmentTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d');

  // Hexagonal shard shape
  ctx.fillStyle = 'rgba(0, 0, 0, 0)';
  ctx.fillRect(0, 0, 64, 64);

  const grad = ctx.createLinearGradient(0, 0, 64, 64);
  grad.addColorStop(0, 'rgba(' + T.cssAccent + ', 1)');
  grad.addColorStop(0.5, 'rgba(' + T.cssAccent2 + ', 0.8)');
  grad.addColorStop(1, 'rgba(' + T.cssSignal + ', 0.6)');

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(32, 4); ctx.lineTo(58, 18); ctx.lineTo(58, 46);
  ctx.lineTo(32, 60); ctx.lineTo(6, 46); ctx.lineTo(6, 18);
  ctx.closePath();
  ctx.fill();

  // Inner glow core
  const innerGrad = ctx.createRadialGradient(32, 32, 0, 32, 32, 18);
  innerGrad.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
  innerGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = innerGrad;
  ctx.fillRect(14, 14, 36, 36);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// 3. Cyber Starburst Flare
function createCyberStarTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d');

  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 60);
  grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
  grad.addColorStop(0.15, 'rgba(' + T.cssAccent + ', 0.9)');
  grad.addColorStop(0.4, 'rgba(' + T.cssAccent2 + ', 0.4)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);

  // Cross flare lines
  ctx.strokeStyle = 'rgba(' + T.cssAccent + ', 0.6)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(64, 4); ctx.lineTo(64, 124);
  ctx.moveTo(4, 64); ctx.lineTo(124, 64);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(' + T.cssAccent2 + ', 0.4)';
  ctx.lineWidth = 1.5;
  ctx.save();
  ctx.translate(64, 64);
  ctx.rotate(Math.PI / 4);
  ctx.beginPath();
  ctx.moveTo(0, -56); ctx.lineTo(0, 56);
  ctx.moveTo(-56, 0); ctx.lineTo(56, 0);
  ctx.stroke();
  ctx.restore();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// 4. Soft Ambient Glow Texture (no white-hot core — for wide, weak halo motes)
function createSoftGlowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
  grad.addColorStop(0.4, 'rgba(255, 255, 255, 0.16)');
  grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

const laserFlareTex = createLaserFlareTexture();
const dataFragTex = createDataFragmentTexture();
const cyberStarTex = createCyberStarTexture();
const softGlowTex = createSoftGlowTexture();

// 4. Cyber Circuit Card Back Texture
function createCyberCardBackTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 512;
  const ctx = canvas.getContext('2d');

  // Deep dark base
  const bgGrad = ctx.createLinearGradient(0, 0, 512, 512);
  bgGrad.addColorStop(0, 'rgba(' + T.cssPanel + ', 0.4)');
  bgGrad.addColorStop(0.5, 'rgba(' + T.cssPanel2 + ', 0.2)');
  bgGrad.addColorStop(1, 'rgba(' + T.cssPanel + ', 0.4)');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, 512, 512);

  // Circuit grid pattern
  ctx.strokeStyle = 'rgba(' + T.cssAccent + ', 0.08)';
  ctx.lineWidth = 1;
  const step = 24;
  for (let x = 0; x < 512; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 512); ctx.stroke();
  }
  for (let y = 0; y < 512; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(512, y); ctx.stroke();
  }

  // Random circuit traces
  ctx.strokeStyle = 'rgba(' + T.cssAccent + ', 0.15)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 18; i++) {
    ctx.beginPath();
    let x = Math.random() * 512;
    let y = Math.random() * 512;
    ctx.moveTo(x, y);
    for (let j = 0; j < 4; j++) {
      if (Math.random() > 0.5) x += (Math.random() - 0.5) * 120;
      else y += (Math.random() - 0.5) * 120;
      ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Circuit node dots
    ctx.fillStyle = 'rgba(' + T.cssAccent + ', 0.4)';
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Neon border frame
  ctx.strokeStyle = 'rgba(' + T.cssAccent + ', 0.7)';
  ctx.lineWidth = 3;
  ctx.strokeRect(14, 14, 512 - 28, 512 - 28);

  // Corner accents
  const cornerSize = 40;
  ctx.strokeStyle = 'rgba(' + T.cssAccent + ', 1.0)';
  ctx.lineWidth = 2;
  // Top-left
  ctx.beginPath(); ctx.moveTo(14, 54); ctx.lineTo(14, 14); ctx.lineTo(54, 14); ctx.stroke();
  // Top-right
  ctx.beginPath(); ctx.moveTo(458, 14); ctx.lineTo(498, 14); ctx.lineTo(498, 54); ctx.stroke();
  // Bottom-right
  ctx.beginPath(); ctx.moveTo(498, 458); ctx.lineTo(498, 498); ctx.lineTo(458, 498); ctx.stroke();
  // Bottom-left
  ctx.beginPath(); ctx.moveTo(54, 498); ctx.lineTo(14, 498); ctx.lineTo(14, 458); ctx.stroke();

  // Central hologram emblem
  const cx = 256, cy = 256;

  // Rotating hexagon rings
  ctx.save();
  ctx.translate(cx, cy);
  for (let ring = 0; ring < 3; ring++) {
    const radius = 60 + ring * 30;
    ctx.strokeStyle = `rgba(${T.cssAccent}, ${0.4 - ring * 0.1})`;
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    for (let i = 0; i <= 6; i++) {
      const angle = (Math.PI / 3) * i + (ring * Math.PI / 12);
      const px = Math.cos(angle) * radius;
      const py = Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.restore();

  // Center circle + text
  ctx.fillStyle = 'rgba(' + T.cssPanel + ', 0.6)';
  ctx.beginPath();
  ctx.arc(cx, cy, 50, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(' + T.cssAccent + ', 1.0)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.font = '900 42px "Orbitron", "Noto Sans SC", sans-serif';
  ctx.fillStyle = 'rgba(' + T.cssAccent + ', 0.9)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(' + T.cssAccent + ', 1.0)';
  ctx.shadowBlur = 20;
  ctx.fillText('夯', cx, cy);
  ctx.shadowBlur = 0;

  // Sub-label
  ctx.font = '600 12px "Orbitron", sans-serif';
  ctx.fillStyle = 'rgba(' + T.cssAccent + ', 0.7)';
  ctx.fillText('◆ ALLOY DATA PLATE ◆', cx, cy + 80);

  ctx.font = '500 11px "Chakra Petch", sans-serif';
  ctx.fillStyle = 'rgba(' + T.cssAccent + ', 0.5)';
  ctx.fillText('TIER SYSTEM V3.0 // MECH EDITION', cx, 480);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const cardBackTex = createCyberCardBackTexture();

// 5. Holographic Slot Number Texture
function createSlotNumberTexture(slotNum) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.fillRect(0, 0, 256, 64);

  ctx.font = '600 20px "Orbitron", sans-serif';
  ctx.fillStyle = 'rgba(' + T.cssAccent + ', 0.3)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`#${String(slotNum).padStart(2, '0')}`, 128, 32);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// 6. Wide Gradient Scan Line Texture
function createScanLineTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0)');
  grad.addColorStop(0.4, 'rgba(' + T.cssAccent + ', 0.2)');
  grad.addColorStop(0.48, 'rgba(' + T.cssScanCore + ', 0.9)');
  grad.addColorStop(0.5, 'rgba(255, 255, 255, 1.0)');
  grad.addColorStop(0.52, 'rgba(' + T.cssScanCore + ', 0.9)');
  grad.addColorStop(0.6, 'rgba(' + T.cssAccent + ', 0.2)');
  grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
  
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 256);
  
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
const scanLineTex = createScanLineTexture();

// ==================== MECH PARTICLE SYSTEMS ====================

// Data Stream Particles (replaces fortune dust)
let dataStreamMesh, streamPositions, streamPhases, streamSpeeds;
function createDataStreamSystem() {
  const count = 300;
  const geometry = new THREE.BufferGeometry();
  streamPositions = new Float32Array(count * 3);
  streamPhases = new Float32Array(count);
  streamSpeeds = new Float32Array(count);
  const colors = new Float32Array(count * 3);

  const cyberPalette = [
    new THREE.Color(T.amber),
    new THREE.Color(T.steel),
    new THREE.Color(T.signal),
    new THREE.Color(T.green)
  ];

  for (let i = 0; i < count; i++) {
    streamPositions[i * 3] = (Math.random() - 0.5) * 65;
    streamPositions[i * 3 + 1] = (Math.random() - 0.5) * 50;
    streamPositions[i * 3 + 2] = (Math.random() - 0.5) * 20 - 18; // Pushed deep into Z background

    streamPhases[i] = Math.random() * Math.PI * 2;
    streamSpeeds[i] = 0.008 + Math.random() * 0.015;

    const col = cyberPalette[Math.floor(Math.random() * cyberPalette.length)];
    colors[i * 3] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(streamPositions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    // Wide, weak, soft-edged motes instead of pin-point glare dots
    size: 0.45,
    map: softGlowTex,
    transparent: true,
    opacity: 0.07,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });

  dataStreamMesh = new THREE.Points(geometry, material);
  dataStreamMesh.raycast = () => {};
  scene.add(dataStreamMesh);
}
createDataStreamSystem();

// ==================== HIGH-END 3D FLUID WIREFRAME MESH GRID ====================
let fluidGridMesh, fluidWireMesh, fluidPointsMesh, fluidGridGeometry;
let fluidGridInitial;
const GRID_WIDTH = 110;
const GRID_DEPTH = 85;
const GRID_SEG_X = 75;
const GRID_SEG_Z = 55;

function createFluidWaveGrid() {
  // Create Plane Geometry aligned on XZ plane
  fluidGridGeometry = new THREE.PlaneGeometry(GRID_WIDTH, GRID_DEPTH, GRID_SEG_X, GRID_SEG_Z);
  fluidGridGeometry.rotateX(-Math.PI / 2); // Lay horizontal
  
  const count = fluidGridGeometry.attributes.position.count;
  const positions = fluidGridGeometry.attributes.position;
  fluidGridInitial = new Float32Array(count * 3);

  // Store initial vertex positions
  for (let i = 0; i < count; i++) {
    fluidGridInitial[i * 3] = positions.getX(i);
    fluidGridInitial[i * 3 + 1] = positions.getY(i);
    fluidGridInitial[i * 3 + 2] = positions.getZ(i);
  }

  // Cyber Gradient Colors (Cyan -> Purple -> Magenta)
  const colors = new Float32Array(count * 3);
  const colCyan = new THREE.Color(T.amber);
  const colPurple = new THREE.Color(T.steel);
  const colMagenta = new THREE.Color(T.signal);

  for (let i = 0; i < count; i++) {
    const x = fluidGridInitial[i * 3];
    const z = fluidGridInitial[i * 3 + 2];
    
    // Normalized distance & coordinate blend
    const mixX = (x / (GRID_WIDTH * 0.5) + 1) * 0.5;
    const mixZ = (z / (GRID_DEPTH * 0.5) + 1) * 0.5;
    
    const col = colCyan.clone().lerp(colPurple, mixX).lerp(colMagenta, mixZ * 0.7);
    
    colors[i * 3] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
  }
  fluidGridGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  // 1. Semi-transparent Fluid Holographic Glass Surface Mesh (Very subtle dark tint)
  // Unlit material: the old metal surface produced harsh roaming specular
  // glints under the point lights (the glaring dots); basic keeps only the tint
  const surfaceMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.05,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  fluidGridMesh = new THREE.Mesh(fluidGridGeometry, surfaceMat);
  fluidGridMesh.position.set(0, -11.5, -12);
  fluidGridMesh.rotation.x = 0.35; // Positioned deep in background depth
  fluidGridMesh.raycast = () => {};
  scene.add(fluidGridMesh);

  // 2. Wireframe Overlay Mesh (Subtle, soft sci-fi lines)
  const wireMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    wireframe: true,
    transparent: true,
    opacity: 0.09,
    blending: THREE.AdditiveBlending
  });
  fluidWireMesh = new THREE.Mesh(fluidGridGeometry, wireMat);
  fluidWireMesh.position.copy(fluidGridMesh.position);
  fluidWireMesh.rotation.copy(fluidGridMesh.rotation);
  fluidWireMesh.raycast = () => {};
  scene.add(fluidWireMesh);

  // 3. Ambient glow motes riding the wave vertices (soft, wide, weak)
  const pointsMat = new THREE.PointsMaterial({
    size: 0.3,
    map: softGlowTex,
    transparent: true,
    opacity: 0.05,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  fluidPointsMesh = new THREE.Points(fluidGridGeometry, pointsMat);
  fluidPointsMesh.position.copy(fluidGridMesh.position);
  fluidPointsMesh.rotation.copy(fluidGridMesh.rotation);
  fluidPointsMesh.raycast = () => {};
  scene.add(fluidPointsMesh);
}
createFluidWaveGrid();

// Cyber Burst Shockwave (replaces fortune burst)
function triggerCyberBurst(pos, colorHex = T.amber) {
  // Hexagonal shockwave ring
  const ringGeo = new THREE.RingGeometry(0.1, 0.35, 6);
  const ringMat = new THREE.MeshBasicMaterial({
    color: colorHex,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending
  });
  const ringMesh = new THREE.Mesh(ringGeo, ringMat);
  ringMesh.position.copy(pos);
  ringMesh.position.z += 0.2;
  scene.add(ringMesh);

  gsap.to(ringMesh.scale, { x: 5.5, y: 5.5, z: 1, duration: 0.5, ease: "power2.out" });
  gsap.to(ringMat, { opacity: 0, duration: 0.5, ease: "power2.out", onComplete: () => {
    scene.remove(ringMesh);
    ringGeo.dispose();
    ringMat.dispose();
  }});

  // Data fragment particles
  const particleCount = 22;
  for (let i = 0; i < particleCount; i++) {
    const isHex = Math.random() > 0.5;
    const tex = isHex ? dataFragTex : cyberStarTex;
    const size = 0.18 + Math.random() * 0.15;

    const geo = new THREE.PlaneGeometry(size, size);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      color: colorHex,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const pMesh = new THREE.Mesh(geo, mat);
    pMesh.position.copy(pos);
    pMesh.position.z += 0.1;
    pMesh.raycast = () => {};
    scene.add(pMesh);

    const angle = Math.random() * Math.PI * 2;
    const speed = 1.5 + Math.random() * 3.0;

    activeBurstParticles.push({
      mesh: pMesh, mat, geo,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      vz: (Math.random() - 0.3) * 1.5,
      life: 1.0,
      rotSpeed: (Math.random() - 0.5) * 0.3
    });
  }
}

function updateBurstParticles(delta) {
  for (let i = activeBurstParticles.length - 1; i >= 0; i--) {
    const p = activeBurstParticles[i];
    p.life -= delta * 1.8;
    p.mesh.position.x += p.vx * delta;
    p.mesh.position.y += p.vy * delta;
    p.mesh.position.z += p.vz * delta;
    p.mesh.rotation.z += p.rotSpeed;
    p.vy -= delta * 0.8;
    p.mat.opacity = Math.max(0, p.life * 0.85);

    if (p.life <= 0) {
      scene.remove(p.mesh);
      p.geo.dispose();
      p.mat.dispose();
      activeBurstParticles.splice(i, 1);
    }
  }
}

// Laser Trail (replaces spark trail)
function emitLaserTrail(pos, colorHex = T.amber) {
  if (activeDragTrails.length >= 60) return;

  const geo = new THREE.PlaneGeometry(0.2, 0.2);
  const mat = new THREE.MeshBasicMaterial({
    map: laserFlareTex,
    color: colorHex,
    transparent: true,
    opacity: 0.7,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const spark = new THREE.Mesh(geo, mat);
  spark.position.copy(pos);
  spark.position.x += (Math.random() - 0.5) * 0.4;
  spark.position.y += (Math.random() - 0.5) * 0.4;
  spark.position.z += (Math.random() - 0.5) * 0.2;
  spark.raycast = () => {};
  scene.add(spark);

  activeDragTrails.push({
    mesh: spark, mat, geo,
    life: 1.0
  });
}

function updateDragTrails() {
  for (let i = activeDragTrails.length - 1; i >= 0; i--) {
    const p = activeDragTrails[i];
    p.life -= 0.06;
    p.mesh.scale.multiplyScalar(0.92);
    p.mat.opacity = p.life * 0.7;
    if (p.life <= 0) {
      scene.remove(p.mesh);
      p.geo.dispose();
      p.mat.dispose();
      activeDragTrails.splice(i, 1);
    }
  }
}

// Lock Beam Effect - Four corner beams converge when card is placed
function triggerLockBeam(cardObj, colorHex = T.amber) {
  const pos = cardObj.position.clone();
  const beamLength = 2.5;

  // Four corner beam origins
  const corners = [
    { x: pos.x - beamLength, y: pos.y + beamLength },
    { x: pos.x + beamLength, y: pos.y + beamLength },
    { x: pos.x + beamLength, y: pos.y - beamLength },
    { x: pos.x - beamLength, y: pos.y - beamLength },
  ];

  corners.forEach((corner, idx) => {
    // Beam line from corner to card center
    const points = [
      new THREE.Vector3(corner.x, corner.y, pos.z + 0.3),
      new THREE.Vector3(pos.x, pos.y, pos.z + 0.3)
    ];
    const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
    const lineMat = new THREE.LineBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: 1.0,
      blending: THREE.AdditiveBlending
    });
    const beam = new THREE.Line(lineGeo, lineMat);
    beam.raycast = () => {};
    scene.add(beam);

    // Corner flare
    const flareGeo = new THREE.PlaneGeometry(0.4, 0.4);
    const flareMat = new THREE.MeshBasicMaterial({
      map: cyberStarTex,
      color: colorHex,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const flare = new THREE.Mesh(flareGeo, flareMat);
    flare.position.set(corner.x, corner.y, pos.z + 0.3);
    flare.raycast = () => {};
    scene.add(flare);

    // Animate beam convergence
    const startCorner = { x: corner.x, y: corner.y };
    gsap.to(startCorner, {
      x: pos.x, y: pos.y,
      duration: 0.35,
      delay: idx * 0.06,
      ease: "power3.in",
      onUpdate: () => {
        const positions = lineGeo.attributes.position.array;
        positions[0] = startCorner.x;
        positions[1] = startCorner.y;
        lineGeo.attributes.position.needsUpdate = true;
        flare.position.x = startCorner.x;
        flare.position.y = startCorner.y;
      },
      onComplete: () => {
        gsap.to(lineMat, { opacity: 0, duration: 0.3 });
        gsap.to(flareMat, { opacity: 0, duration: 0.3, onComplete: () => {
          scene.remove(beam); scene.remove(flare);
          lineGeo.dispose(); lineMat.dispose();
          flareGeo.dispose(); flareMat.dispose();
        }});
      }
    });
  });

  // Center lock flash
  const flashGeo = new THREE.PlaneGeometry(0.6, 0.6);
  const flashMat = new THREE.MeshBasicMaterial({
    map: cyberStarTex,
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const flash = new THREE.Mesh(flashGeo, flashMat);
  flash.position.set(pos.x, pos.y, pos.z + 0.35);
  flash.raycast = () => {};
  scene.add(flash);

  gsap.to(flashMat, {
    opacity: 1.0, duration: 0.15, delay: 0.3,
    onComplete: () => {
      gsap.to(flash.scale, { x: 3, y: 3, duration: 0.3 });
      gsap.to(flashMat, { opacity: 0, duration: 0.4, onComplete: () => {
        scene.remove(flash);
        flashGeo.dispose(); flashMat.dispose();
      }});
    }
  });

  // "LOCKED" text flash
  const lockCanvas = document.createElement('canvas');
  lockCanvas.width = 256; lockCanvas.height = 64;
  const lockCtx = lockCanvas.getContext('2d');
  lockCtx.font = '700 28px "Orbitron", sans-serif';
  lockCtx.fillStyle = T.accentHex;
  lockCtx.textAlign = 'center';
  lockCtx.textBaseline = 'middle';
  lockCtx.shadowColor = 'rgba(' + T.cssAccent + ', 0.9)';
  lockCtx.shadowBlur = 15;
  lockCtx.fillText('◆ LOCKED ◆', 128, 32);
  const lockTex = new THREE.CanvasTexture(lockCanvas);
  const lockGeo = new THREE.PlaneGeometry(2.0, 0.5);
  const lockMat = new THREE.MeshBasicMaterial({
    map: lockTex,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const lockMesh = new THREE.Mesh(lockGeo, lockMat);
  lockMesh.position.set(pos.x, pos.y + 1.5, pos.z + 0.4);
  lockMesh.raycast = () => {};
  scene.add(lockMesh);

  gsap.to(lockMat, {
    opacity: 1.0, duration: 0.15, delay: 0.35,
    onComplete: () => {
      gsap.to(lockMesh.position, { y: pos.y + 2.0, duration: 0.6 });
      gsap.to(lockMat, { opacity: 0, duration: 0.8, delay: 0.3, onComplete: () => {
        scene.remove(lockMesh);
        lockGeo.dispose(); lockMat.dispose(); lockTex.dispose();
      }});
    }
  });
}

// ==================== BINDER PLATFORMS & SLOTS ====================
const tiers = [
  { name: '夯', color: T.tierColors[0], y: 6.2, rankCode: 'SSR' },
  { name: '顶级', color: T.tierColors[1], y: 3.6, rankCode: 'SR' },
  { name: '人上人', color: T.tierColors[2], y: 1.0, rankCode: 'S' },
  { name: 'NPC', color: T.green, y: -1.6, rankCode: 'A' },
  { name: '拉', color: T.tierColors[4], y: -4.2, rankCode: 'B' },
];

const platformWidth = 18.0;
const platformHeight = 2.2;
const platformDepth = 0.6;

const slotCount = 7;
const slotWidth = 1.9;
const slotHeight = 1.9;
const slotSpacing = 2.15;

function getSlotX(slotIndex) {
  return -((slotCount - 1) * slotSpacing) / 2 + slotIndex * slotSpacing;
}

// Helper to create 3D Holographic Tier Label Texture
function create3DTierLabelTexture(tier) {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 256;
  const ctx = canvas.getContext('2d');

  // Background panel with dark cyber gradient
  const bgGrad = ctx.createLinearGradient(0, 0, 512, 256);
  bgGrad.addColorStop(0, 'rgba(' + T.cssPanel + ', 0.95)');
  bgGrad.addColorStop(1, 'rgba(' + T.cssPanel2 + ', 0.85)');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, 512, 256);

  // Subtle circuit grid background
  ctx.strokeStyle = 'rgba(' + T.cssAccent + ', 0.12)';
  ctx.lineWidth = 1;
  for (let x = 0; x < 512; x += 32) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 256); ctx.stroke();
  }

  // Tier Color accent block / dot
  const colorHex = '#' + tier.color.toString(16).padStart(6, '0');
  ctx.fillStyle = colorHex;
  ctx.shadowColor = colorHex;
  ctx.shadowBlur = 15;
  ctx.fillRect(32, 96, 28, 64);

  // Tier Name Text ("夯", "顶级", "人上人", "NPC", "拉")
  ctx.font = '900 72px "Orbitron", "Noto Sans SC", sans-serif';
  ctx.fillStyle = T.textHex;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = colorHex;
  ctx.shadowBlur = 10;
  ctx.fillText(tier.name, 80, 128);

  // Rank Code Tag (SSR, SR, S, A, B)
  ctx.font = '700 28px "Orbitron", sans-serif';
  ctx.fillStyle = colorHex;
  ctx.textAlign = 'right';
  ctx.shadowBlur = 5;
  ctx.fillText(tier.rankCode, 470, 128);

  ctx.shadowBlur = 0;

  // Cyber corner accents & outer stroke frame
  ctx.strokeStyle = colorHex;
  ctx.lineWidth = 6;
  ctx.strokeRect(12, 12, 512 - 24, 256 - 24);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Create Holographic Platform Row
function createBinderPlatform(tier, index) {
  const group = new THREE.Group();

  // Main platform body - dark anodized metal slab
  const baseGeo = new THREE.BoxGeometry(platformWidth, platformHeight, platformDepth);
  const baseMat = new THREE.MeshPhysicalMaterial({
    color: tier.color,
    emissive: tier.color,
    emissiveIntensity: 0.12,
    roughness: 0.4,
    metalness: 0.85,
    transmission: 0.55,
    transparent: true,
    opacity: 0.22,
    depthWrite: false
  });
  const baseMesh = new THREE.Mesh(baseGeo, baseMat);
  group.add(baseMesh);

  // Crisp neon edge wireframe
  const edges = new THREE.EdgesGeometry(baseGeo);
  const lineMat = new THREE.LineBasicMaterial({
    color: tier.color,
    transparent: true,
    opacity: 0.85
  });
  const line = new THREE.LineSegments(edges, lineMat);
  line.raycast = () => {};
  baseMesh.add(line);

  // 3D Left Extension Tab for Tier Name Label
  const tabWidth = 3.2;
  const tabHeight = 1.8;
  const tabDepth = 0.5;
  const tabX = -platformWidth / 2 - tabWidth / 2 + 0.15; // Extended out directly from left end of platform

  const tabGeo = new THREE.BoxGeometry(tabWidth, tabHeight, tabDepth);
  const tabMat = baseMat.clone();
  const tabMesh = new THREE.Mesh(tabGeo, tabMat);
  tabMesh.position.set(tabX, 0, 0);
  group.add(tabMesh);

  const tabEdges = new THREE.EdgesGeometry(tabGeo);
  const tabLineMat = new THREE.LineBasicMaterial({
    color: tier.color,
    transparent: true,
    opacity: 0.85
  });
  const tabLine = new THREE.LineSegments(tabEdges, tabLineMat);
  tabLine.raycast = () => {};
  tabMesh.add(tabLine);

  const labelTex = create3DTierLabelTexture(tier);
  const labelGeo = new THREE.PlaneGeometry(tabWidth - 0.2, tabHeight - 0.2);
  const labelMat = new THREE.MeshBasicMaterial({
    map: labelTex,
    transparent: true,
    opacity: 0.95,
    depthWrite: false
  });
  const labelMesh = new THREE.Mesh(labelGeo, labelMat);
  labelMesh.position.set(tabX, 0, tabDepth / 2 + 0.02);
  labelMesh.raycast = () => {};
  group.add(labelMesh);

  // Scanning line plane (for hover animation)
  const scanGeo = new THREE.PlaneGeometry(platformWidth, 1.2);
  const scanMat = new THREE.MeshBasicMaterial({
    map: scanLineTex,
    color: tier.color,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const scanLine = new THREE.Mesh(scanGeo, scanMat);
  scanLine.position.set(0, -platformHeight / 2, platformDepth / 2 + 0.05);
  scanLine.raycast = () => {};
  group.add(scanLine);
  scanLineMeshes.push({ mesh: scanLine, mat: scanMat, platformIndex: index });

  // 7 Recessed Holographic Slot Pockets
  const slotMeshes = [];
  for (let s = 0; s < slotCount; s++) {
    const sx = getSlotX(s);

    const slotBaseGeo = new THREE.BoxGeometry(slotWidth, slotHeight, 0.02);
    const slotBaseMat = new THREE.MeshBasicMaterial({
      color: tier.color,
      transparent: true,
      opacity: 0.05,
      depthWrite: false
    });
    const slotMesh = new THREE.Mesh(slotBaseGeo, slotBaseMat);
    slotMesh.position.set(sx, 0, platformDepth / 2 + 0.02);

    // Clean outer rectangular wireframe (NO 'X' diagonals!)
    const slotEdges = new THREE.EdgesGeometry(slotBaseGeo);
    const slotLineMat = new THREE.LineBasicMaterial({
      color: tier.color,
      transparent: true,
      opacity: 0.6
    });
    const slotLine = new THREE.LineSegments(slotEdges, slotLineMat);
    slotLine.raycast = () => {};
    slotMesh.add(slotLine);

    // Corner bracket accents (neon color)
    const bracketGeo = new THREE.BufferGeometry();
    const w2 = slotWidth / 2; const h2 = slotHeight / 2; const bl = 0.25;
    const vertices = new Float32Array([
      -w2, h2 - bl, 0.04,  -w2, h2, 0.04,  -w2 + bl, h2, 0.04,
      w2 - bl, h2, 0.04,   w2, h2, 0.04,   w2, h2 - bl, 0.04,
      w2, -h2 + bl, 0.04,  w2, -h2, 0.04,  w2 - bl, -h2, 0.04,
      -w2 + bl, -h2, 0.04, -w2, -h2, 0.04, -w2, -h2 + bl, 0.04
    ]);
    bracketGeo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    const bracketMat = new THREE.LineBasicMaterial({
      color: tier.color,
      transparent: true,
      opacity: 0.5
    });
    const bracketLine = new THREE.LineSegments(bracketGeo, bracketMat);
    bracketLine.raycast = () => {};
    slotMesh.add(bracketLine);

    const numTex = createSlotNumberTexture(s + 1);
    const numGeo = new THREE.PlaneGeometry(1.2, 0.3);
    const numMat = new THREE.MeshBasicMaterial({ map: numTex, transparent: true, depthWrite: false });
    const numMesh = new THREE.Mesh(numGeo, numMat);
    numMesh.position.set(0, -h2 + 0.22, 0.04);
    numMesh.raycast = () => {};
    slotMesh.add(numMesh);

    group.add(slotMesh);
    slotMeshes.push(slotMesh);
  }

  group.position.set(0, tier.y, 0);
  scene.add(group);

  baseMesh.userData = {
    isPlatform: true,
    type: 'tier',
    index: index,
    color: tier.color,
    cards: new Array(slotCount).fill(null),
    slotMeshes: slotMeshes,
    group: group,
    baseMat: baseMat,
    lineMat: lineMat,
    scanMat: scanMat,
    scanLine: scanLine,
    isHovered: false,
    baseEmissiveIntensity: 0.08
  };

  platforms.push(baseMesh);
}

tiers.forEach((tier, index) => {
  createBinderPlatform(tier, index);
});

// Chamfered HUD nameplate texture for the pool platform — mirrors the 2D header language
function createPoolLabelTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const cyan = T.accentHex; // name kept — every usage below reads this plate accent

  // Rounded glass plate (clean futurism — no chamfers)
  const m = 14;
  const plate = new Path2D();
  plate.roundRect(m, m, 1024 - m * 2, 256 - m * 2, 28);

  ctx.fillStyle = 'rgba(' + T.cssPanel + ', 0.72)';
  ctx.fill(plate);
  ctx.save();
  ctx.shadowColor = cyan;
  ctx.shadowBlur = 14;
  ctx.strokeStyle = cyan;
  ctx.lineWidth = 4;
  ctx.stroke(plate);
  ctx.restore();

  // Inner hairline echo
  const m2 = 26;
  const inner = new Path2D();
  inner.roundRect(m2, m2, 1024 - m2 * 2, 256 - m2 * 2, 20);
  ctx.strokeStyle = 'rgba(' + T.cssAccent + ', 0.28)';
  ctx.lineWidth = 1.5;
  ctx.stroke(inner);

  // Side tick marks (mirroring the 2D header end-caps)
  ctx.fillStyle = 'rgba(' + T.cssAccent + ', 0.55)';
  for (let i = 0; i < 3; i++) {
    ctx.fillRect(54 + i * 12, 96, 5, 64);
    ctx.fillRect(1024 - 59 - i * 12, 96, 5, 64);
  }

  // Main title
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '900 64px "Orbitron", "Noto Sans SC", sans-serif';
  ctx.strokeStyle = T.bgHex;
  ctx.lineWidth = 8;
  ctx.strokeText('◆ 待 判 定 域 ◆', 512, 104);
  ctx.save();
  ctx.shadowColor = cyan;
  ctx.shadowBlur = 7;
  ctx.fillStyle = T.textHex2;
  ctx.fillText('◆ 待 判 定 域 ◆', 512, 104);
  ctx.restore();

  // Micro readout line
  ctx.font = '600 24px "Orbitron", sans-serif';
  ctx.letterSpacing = '8px';
  ctx.fillStyle = 'rgba(' + T.cssAccent + ', 0.55)';
  ctx.fillText('HOLDING.BAY // AWAITING.RANK', 512, 190);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Pool Platform (Pending Ranking)
function createPoolPlatform() {
  const poolHeight = 2.4;
  const poolGeo = new THREE.BoxGeometry(platformWidth, poolHeight, platformDepth);
  const poolMat = new THREE.MeshPhysicalMaterial({
    color: T.amber,
    emissive: T.amber,
    emissiveIntensity: 0.1,
    roughness: 0.4,
    metalness: 0.85,
    transmission: 0.55,
    transparent: true,
    opacity: 0.22,
    depthWrite: false
  });
  poolPlatform = new THREE.Mesh(poolGeo, poolMat);
  poolPlatform.position.set(0, -7.5, 0);
  scene.add(poolPlatform);

  const poolEdges = new THREE.EdgesGeometry(poolGeo);
  const poolLineMat = new THREE.LineBasicMaterial({
    color: T.amber,
    transparent: true,
    opacity: 0.8
  });
  const poolLine = new THREE.LineSegments(poolEdges, poolLineMat);
  poolLine.raycast = () => {};
  poolPlatform.add(poolLine);

  // Pool label - chamfered HUD nameplate (mirrors the 2D command-header language)
  const texture = createPoolLabelTexture();
  const labelGeo = new THREE.PlaneGeometry(7.5, 1.87);
  const labelMat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.95,
    depthWrite: false
  });
  const labelMesh = new THREE.Mesh(labelGeo, labelMat);
  labelMesh.position.set(0, 0, platformDepth / 2 + 0.05);
  labelMesh.raycast = () => {};
  poolPlatform.add(labelMesh);

  // --- Premium HUD frame dressing (decorative only, raycast disabled) ---
  const frontZ = platformDepth / 2 + 0.03;
  const pw2 = platformWidth / 2;
  const ph2 = poolHeight / 2;

  // 1. Oversized neon corner brackets on the front face
  const bl = 0.85;
  const bracketVerts = new Float32Array([
    -pw2, ph2 - bl, 0,  -pw2, ph2, 0,   -pw2, ph2, 0,  -pw2 + bl, ph2, 0, // top-left
    pw2 - bl, ph2, 0,   pw2, ph2, 0,    pw2, ph2, 0,   pw2, ph2 - bl, 0,  // top-right
    pw2, -ph2 + bl, 0,  pw2, -ph2, 0,   pw2, -ph2, 0,  pw2 - bl, -ph2, 0, // bottom-right
    -pw2 + bl, -ph2, 0, -pw2, -ph2, 0,  -pw2, -ph2, 0, -pw2, -ph2 + bl, 0 // bottom-left
  ]);
  const bracketGeo = new THREE.BufferGeometry();
  bracketGeo.setAttribute('position', new THREE.BufferAttribute(bracketVerts, 3));
  const brackets = new THREE.LineSegments(bracketGeo, new THREE.LineBasicMaterial({
    color: T.amber,
    transparent: true,
    opacity: 0.9
  }));
  brackets.position.z = frontZ;
  brackets.raycast = () => {};
  poolPlatform.add(brackets);

  // 2. Inset hairline frame (double-frame HUD detail)
  const iw = pw2 - 0.18, ih = ph2 - 0.18;
  const frameVerts = new Float32Array([
    -iw, ih, 0,   iw, ih, 0,
    iw, ih, 0,    iw, -ih, 0,
    iw, -ih, 0,  -iw, -ih, 0,
    -iw, -ih, 0, -iw, ih, 0
  ]);
  const frameGeo = new THREE.BufferGeometry();
  frameGeo.setAttribute('position', new THREE.BufferAttribute(frameVerts, 3));
  const innerFrame = new THREE.LineSegments(frameGeo, new THREE.LineBasicMaterial({
    color: T.amber,
    transparent: true,
    opacity: 0.28
  }));
  innerFrame.position.z = frontZ;
  innerFrame.raycast = () => {};
  poolPlatform.add(innerFrame);

  // 3. Ruler tick marks along the bottom inner edge
  const tickVerts = [];
  const tickY = -ph2 + 0.12;
  let tickIdx = 0;
  for (let x = -pw2 + 0.5; x <= pw2 - 0.5; x += 0.5, tickIdx++) {
    const len = tickIdx % 5 === 0 ? 0.2 : 0.09;
    tickVerts.push(x, tickY, 0, x, tickY + len, 0);
  }
  const tickGeo = new THREE.BufferGeometry();
  tickGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tickVerts), 3));
  const rulerTicks = new THREE.LineSegments(tickGeo, new THREE.LineBasicMaterial({
    color: T.amber,
    transparent: true,
    opacity: 0.35
  }));
  rulerTicks.position.z = frontZ;
  rulerTicks.raycast = () => {};
  poolPlatform.add(rulerTicks);

  // 4. Ambient radar sweep strip (animated in the render loop)
  const poolScanGeo = new THREE.PlaneGeometry(platformWidth, 1.0);
  const poolScanMat = new THREE.MeshBasicMaterial({
    map: scanLineTex,
    color: T.amber,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  poolScanMesh = new THREE.Mesh(poolScanGeo, poolScanMat);
  poolScanMesh.position.set(0, 0, platformDepth / 2 + 0.04);
  poolScanMesh.raycast = () => {};
  poolPlatform.add(poolScanMesh);

  poolPlatform.userData = {
    isPlatform: true,
    type: 'pool',
    cards: [],
    baseMat: poolMat,
    lineMat: poolLineMat,
    isHovered: false,
    baseEmissiveIntensity: 0.06
  };
  platforms.push(poolPlatform);
}
createPoolPlatform();

// ==================== LABEL POSITIONING ====================
function updateLabelsPosition() {
  // Tier labels are built directly into the 3D binder platforms (no DOM tracking needed)
}

function updateMousePos(clientX, clientY) {
  mouse.x = (clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(clientY / window.innerHeight) * 2 + 1;
}

function getCardFromObject(obj) {
  while (obj) {
    if (obj.userData && obj.userData.isCard) return obj;
    obj = obj.parent;
  }
  return null;
}

function getPlatformFromObject(obj) {
  while (obj) {
    if (obj.userData && obj.userData.isPlatform) return obj;
    obj = obj.parent;
  }
  return null;
}

// ==================== 3D MECH CARD MESH BUILDER ====================
function create3DCardMesh(frontTexture, cardType, srcOrText) {
  const cardGroup = new THREE.Group();

  const width = 1.8;
  const height = 1.8;
  const depth = 0.06;

  // 1. Card Body - dark with neon edge glow
  const boxGeo = new THREE.BoxGeometry(width, height, depth);
  const boxMat = new THREE.MeshStandardMaterial({
    color: T.cardBody,
    roughness: 0.35,
    metalness: 0.9,
    emissive: T.amber,
    emissiveIntensity: 0.06
  });
  const boxMesh = new THREE.Mesh(boxGeo, boxMat);
  cardGroup.add(boxMesh);

  // Neon edge lines
  const edges = new THREE.EdgesGeometry(boxGeo);
  const edgeMat = new THREE.LineBasicMaterial({
    color: T.amber,
    transparent: true,
    opacity: 0.65
  });
  const edgeLine = new THREE.LineSegments(edges, edgeMat);
  edgeLine.raycast = () => {};
  cardGroup.add(edgeLine);

  // 2. Front Face
  const faceGeo = new THREE.PlaneGeometry(width - 0.08, height - 0.08);
  const frontMat = new THREE.MeshStandardMaterial({
    map: frontTexture,
    roughness: 0.2,
    metalness: 0.1,
    emissive: 0xffffff,
    emissiveIntensity: 0.03
  });
  const frontMesh = new THREE.Mesh(faceGeo, frontMat);
  frontMesh.position.z = depth / 2 + 0.005;
  cardGroup.add(frontMesh);

  // Holographic scan overlay
  const scanOverlayMat = new THREE.MeshBasicMaterial({
    color: T.amber,
    transparent: true,
    opacity: 0.1,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const scanOverlay = new THREE.Mesh(faceGeo, scanOverlayMat);
  scanOverlay.position.z = depth / 2 + 0.008;
  scanOverlay.raycast = () => {};
  cardGroup.add(scanOverlay);

  // 3. Back Face - Cyber circuit
  const backMat = new THREE.MeshStandardMaterial({
    map: cardBackTex,
    roughness: 0.15,
    metalness: 0.2,
    emissive: T.amber,
    emissiveIntensity: 0.05
  });
  const backMesh = new THREE.Mesh(faceGeo, backMat);
  backMesh.position.z = -depth / 2 - 0.005;
  backMesh.rotation.y = Math.PI;
  cardGroup.add(backMesh);

  // 4. Corner neon accent markers (instead of gold rivets)
  const markerGeo = new THREE.PlaneGeometry(0.12, 0.12);
  const markerMat = new THREE.MeshBasicMaterial({
    color: T.amber,
    transparent: true,
    opacity: 0.7,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });

  [-(width / 2 - 0.1), width / 2 - 0.1].forEach(rx => {
    [-(height / 2 - 0.1), height / 2 - 0.1].forEach(ry => {
      const marker = new THREE.Mesh(markerGeo, markerMat.clone());
      marker.position.set(rx, ry, depth / 2 + 0.01);
      marker.raycast = () => {};
      cardGroup.add(marker);
    });
  });

  // UserData
  cardGroup.userData = {
    isCard: true,
    cardType: cardType,
    src: cardType === 'image' ? srcOrText : null,
    text: cardType === 'text' ? srcOrText : null,
    platform: poolPlatform,
    slotIndex: -1,
    baseTime: Math.random() * 100,
    isFlipped: false,
    boxMat: boxMat,
    edgeMat: edgeMat,
    scanOverlayMat: scanOverlayMat,
    baseEdgeOpacity: 0.65,
    hoverSpinY: 0
  };

  cardGroup.position.set(
    (Math.random() - 0.5) * 6,
    poolPlatform.position.y,
    poolPlatform.position.z + 0.5
  );

  cardGroup.rotation.x = -0.22;

  scene.add(cardGroup);
  cards.push(cardGroup);
  if (poolPlatform.userData.cards) poolPlatform.userData.cards.push(cardGroup);
  arrangePlatform(poolPlatform);
  setTimeout(snapshotDraft, 0);

  triggerCyberBurst(cardGroup.position.clone(), T.amber);
  return cardGroup;
}

// Image Card Creation
function createImageCard(imgSrc) {
  const img = new Image();
  img.onload = function() {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 512;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = T.panelHex;
    ctx.fillRect(0, 0, 512, 512);

    const aspect = img.width / img.height;
    const targetAspect = 1.0; // 512 / 512
    let sw, sh, sx, sy;
    if (aspect > targetAspect) {
      sh = img.height; sw = img.height * targetAspect;
      sx = (img.width - sw) / 2; sy = 0;
    } else {
      sw = img.width; sh = img.width / targetAspect;
      sx = 0; sy = (img.height - sh) / 2;
    }
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, 512, 512);

    // Neon border frame
    ctx.strokeStyle = 'rgba(' + T.cssAccent + ', 0.6)';
    ctx.lineWidth = 4;
    ctx.strokeRect(8, 8, 512 - 16, 512 - 16);

    // Inner thin line
    ctx.strokeStyle = 'rgba(' + T.cssAccent2 + ', 0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(14, 14, 512 - 28, 512 - 28);

    // Corner accents
    ctx.strokeStyle = 'rgba(' + T.cssAccent + ', 0.9)';
    ctx.lineWidth = 3;
    const cs = 30;
    // TL
    ctx.beginPath(); ctx.moveTo(8, 38); ctx.lineTo(8, 8); ctx.lineTo(38, 8); ctx.stroke();
    // TR
    ctx.beginPath(); ctx.moveTo(474, 8); ctx.lineTo(504, 8); ctx.lineTo(504, 38); ctx.stroke();
    // BR
    ctx.beginPath(); ctx.moveTo(504, 474); ctx.lineTo(504, 504); ctx.lineTo(474, 504); ctx.stroke();
    // BL
    ctx.beginPath(); ctx.moveTo(38, 504); ctx.lineTo(8, 504); ctx.lineTo(8, 474); ctx.stroke();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    create3DCardMesh(texture, 'image', imgSrc);
  };
  img.src = imgSrc;
}

// Text Card Creation - Element Periodic Table Wireframe Style
function createTextCard(text) {
  if (!text || !text.trim()) return;

  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 512;
  const ctx = canvas.getContext('2d');

  // Semi-transparent base to allow glass effect
  ctx.fillStyle = 'rgba(' + T.cssPanel + ', 0.2)';
  ctx.fillRect(0, 0, 512, 512);

  // Wireframe grid background
  ctx.strokeStyle = 'rgba(' + T.cssAccent + ', 0.15)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= 512; x += 32) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 512); ctx.stroke();
  }
  for (let y = 0; y <= 512; y += 32) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(512, y); ctx.stroke();
  }

  // Periodic Table style borders (double line)
  ctx.strokeStyle = 'rgba(' + T.cssAccent + ', 0.8)';
  ctx.lineWidth = 4;
  ctx.strokeRect(16, 16, 512 - 32, 512 - 32);
  ctx.strokeStyle = 'rgba(' + T.cssAccent + ', 0.3)';
  ctx.lineWidth = 2;
  ctx.strokeRect(24, 24, 512 - 48, 512 - 48);

  // Decorative text (atomic number style)
  ctx.font = '700 24px "Orbitron", sans-serif';
  ctx.fillStyle = 'rgba(' + T.cssAccent + ', 0.8)';
  ctx.textAlign = 'left';
  ctx.fillText('99', 36, 60);
  
  ctx.textAlign = 'right';
  ctx.fillText('MECH', 476, 60);

  // Main text rendering (Stroked/Wireframe glow)
  ctx.font = '900 80px "Chakra Petch", "Noto Sans SC", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  
  const words = text.trim().split('');
  let line = '';
  let lines = [];
  for (let i = 0; i < words.length; i++) {
    let testLine = line + words[i];
    let metrics = ctx.measureText(testLine);
    if (metrics.width > 400 && i > 0) {
      lines.push(line);
      line = words[i];
    } else {
      line = testLine;
    }
  }
  lines.push(line);

  const startY = 256 - ((lines.length - 1) * 45);
  
  lines.forEach((l, idx) => {
    const yPos = startY + idx * 90;
    
    // Outer intense glow
    ctx.shadowColor = 'rgba(' + T.cssAccent + ', 1.0)';
    ctx.shadowBlur = 30;
    ctx.strokeStyle = 'rgba(' + T.cssAccent + ', 0.9)';
    ctx.lineWidth = 3;
    ctx.strokeText(l, 256, yPos);
    
    // Inner bright core
    ctx.shadowBlur = 10;
    ctx.fillStyle = 'rgba(' + T.cssWarm + ', 0.9)';
    ctx.fillText(l, 256, yPos);
  });

  ctx.shadowBlur = 0;

  // Bottom text
  ctx.font = '600 20px "Orbitron", sans-serif';
  ctx.fillStyle = 'rgba(' + T.cssAccent + ', 0.6)';
  ctx.textAlign = 'center';
  ctx.fillText('ALLOY.MASS: 256.08', 256, 460);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  create3DCardMesh(texture, 'text', text);
}

// Initial Sample Cards
function initSampleCards() {
  const samples = ['夯神A', '顶级B', 'NPC卡片'];
  samples.forEach((txt) => createTextCard(txt));
}

// ==================== CARD ARRANGE & SLOTS ====================
function arrangePlatform(platform) {
  if (!platform || !platform.userData) return;

  const targetRotX = -0.22;

  if (platform.userData.type === 'tier') {
    const pCards = platform.userData.cards;
    const tierGroup = platform.userData.group;
    if (!tierGroup || !Array.isArray(pCards)) return;

    for (let s = 0; s < slotCount; s++) {
      const card = pCards[s];
      if (card) {
        const slotX = getSlotX(s);
        const targetX = tierGroup.position.x + slotX;
        const targetY = tierGroup.position.y + 0.05;
        const targetZ = tierGroup.position.z + 0.45;

        gsap.to(card.position, {
          x: targetX, y: targetY, z: targetZ,
          duration: 0.45, ease: "back.out(1.2)"
        });

        const targetRotY = card.userData.isFlipped ? Math.PI : 0;
        gsap.to(card.rotation, {
          x: targetRotX, y: targetRotY, z: 0,
          duration: 0.45
        });
      }
    }
  } else if (platform.userData.type === 'pool') {
    // Compact away null holes (deleted cards) before computing the grid
    const pCards = platform.userData.cards.filter(c => c);
    platform.userData.cards = pCards;
    if (pCards.length === 0) return;

    const cardWidth = 1.8;
    const padding = 0.22;
    const maxPerRow = Math.floor((platformWidth - 1) / (cardWidth + padding));
    const totalWidth = Math.min(pCards.length, maxPerRow) * (cardWidth + padding) - padding;
    let startX = -totalWidth / 2 + cardWidth / 2;

    pCards.forEach((card, index) => {
      const row = Math.floor(index / maxPerRow);
      const col = index % maxPerRow;

      if (row > 0 && col === 0) {
        const remaining = pCards.length - index;
        const rowWidth = Math.min(remaining, maxPerRow) * (cardWidth + padding) - padding;
        startX = -rowWidth / 2 + cardWidth / 2;
      }

      const targetX = platform.position.x + startX + col * (cardWidth + padding);
      const targetY = platform.position.y - row * (cardWidth + padding) * 0.12;
      const targetZ = platform.position.z + 0.5 + row * 0.08;

      gsap.to(card.position, {
        x: targetX, y: targetY, z: targetZ,
        duration: 0.45, ease: "power3.out"
      });

      const targetRotY = card.userData.isFlipped ? Math.PI : 0;
      gsap.to(card.rotation, {
        x: targetRotX, y: targetRotY, z: 0,
        duration: 0.45
      });
    });
  }
}

function arrangeAllPlatforms() {
  platforms.forEach(p => arrangePlatform(p));
}

// ==================== HOVER EFFECTS ====================

// Platform/Row hover effect
function onPlatformHoverEnter(platform) {
  if (platform.userData.isHovered) return;
  platform.userData.isHovered = true;

  const ud = platform.userData;

  // Brighten platform emissive
  if (ud.baseMat) {
    gsap.to(ud.baseMat, { emissiveIntensity: 0.3, opacity: 0.3, duration: 0.3 });
  }
  // Brighten edge lines
  if (ud.lineMat) {
    gsap.to(ud.lineMat, { opacity: 1.0, duration: 0.3 });
  }

  // Trigger scan line animation
  if (ud.scanLine && ud.scanMat) {
    ud.scanMat.opacity = 0.8;
    ud.scanLine.position.y = -platformHeight / 2;
    gsap.to(ud.scanLine.position, {
      y: platformHeight / 2,
      duration: 0.6,
      ease: "none",
      onComplete: () => {
        if (ud.scanMat) ud.scanMat.opacity = 0;
      }
    });
  }

  // Float up all cards in this row
  if (ud.type === 'tier' && ud.cards) {
    ud.cards.forEach((card, idx) => {
      if (card && card !== draggedCard && card !== hoveredCard) {
        gsap.to(card.position, {
          z: (ud.group ? ud.group.position.z : 0) + 0.75,
          duration: 0.3,
          delay: idx * 0.03
        });
        gsap.to(card.rotation, { x: -0.12, duration: 0.3 });
        // Subtle edge glow pulse on cards
        if (card.userData.edgeMat) {
          gsap.to(card.userData.edgeMat, { opacity: 1.0, duration: 0.3 });
        }
        if (card.userData.scanOverlayMat) {
          gsap.to(card.userData.scanOverlayMat, { opacity: 0.2, duration: 0.3 });
        }
      }
    });
  }
}

function onPlatformHoverExit(platform) {
  if (!platform.userData.isHovered) return;
  platform.userData.isHovered = false;

  const ud = platform.userData;

  if (ud.baseMat) {
    gsap.to(ud.baseMat, {
      emissiveIntensity: ud.baseEmissiveIntensity || 0.12,
      opacity: 0.12,
      duration: 0.4
    });
  }
  if (ud.lineMat) {
    gsap.to(ud.lineMat, { opacity: 0.85, duration: 0.4 });
  }

  // Settle cards back
  if (ud.type === 'tier' && ud.cards) {
    ud.cards.forEach(card => {
      if (card && card !== draggedCard && card !== hoveredCard) {
        const tierGroup = ud.group;
        if (tierGroup) {
          gsap.to(card.position, {
            z: tierGroup.position.z + 0.45,
            duration: 0.3
          });
        }
        gsap.to(card.rotation, { x: -0.22, duration: 0.3 });
        if (card.userData.edgeMat) {
          gsap.to(card.userData.edgeMat, { opacity: card.userData.baseEdgeOpacity, duration: 0.3 });
        }
        if (card.userData.scanOverlayMat) {
          gsap.to(card.userData.scanOverlayMat, { opacity: 0.1, duration: 0.3 });
        }
      }
    });
  }
}

// Card hover effect
function onCardHoverEnter(card) {
  if (card === draggedCard) return;

  // Float up + scale - lift Z sufficiently far forward so spinning Y never intersects the backplate
  gsap.to(card.scale, { x: 1.15, y: 1.15, z: 1.15, duration: 0.25 });
  
  const baseZ = card.userData.platform
    ? (card.userData.platform.userData.type === 'pool' 
        ? card.userData.platform.position.z + 0.5 
        : card.userData.platform.userData.group.position.z + 0.45)
    : card.position.z;
    
  gsap.to(card.position, { z: baseZ + 1.25, duration: 0.25 });

  // Start slow spin
  card.userData.hoverSpinY = 1;

  // Neon edge glow up
  if (card.userData.edgeMat) {
    gsap.to(card.userData.edgeMat, { opacity: 1.0, duration: 0.2 });
  }
  if (card.userData.boxMat) {
    gsap.to(card.userData.boxMat, { emissiveIntensity: 0.15, duration: 0.2 });
  }
  if (card.userData.scanOverlayMat) {
    gsap.to(card.userData.scanOverlayMat, { opacity: 0.25, duration: 0.2 });
  }

  // Emit a few orbit particles around the card
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2;
    const pGeo = new THREE.PlaneGeometry(0.12, 0.12);
    const pMat = new THREE.MeshBasicMaterial({
      map: laserFlareTex,
      color: T.amber,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const particle = new THREE.Mesh(pGeo, pMat);
    particle.position.set(
      card.position.x + Math.cos(angle) * 1.2,
      card.position.y + Math.sin(angle) * 1.2,
      card.position.z + 0.2
    );
    particle.raycast = () => {};
    scene.add(particle);

    activeBurstParticles.push({
      mesh: particle, mat: pMat, geo: pGeo,
      vx: Math.cos(angle) * 0.3,
      vy: Math.sin(angle) * 0.3,
      vz: 0.1,
      life: 0.8,
      rotSpeed: 0.05
    });
  }
}

function onCardHoverExit(card) {
  if (card === draggedCard) return;

  gsap.to(card.scale, { x: 1, y: 1, z: 1, duration: 0.3 });
  card.userData.hoverSpinY = 0;

  // Return to slot position
  const baseRotY = card.userData.isFlipped ? Math.PI : 0;
  gsap.to(card.rotation, { x: -0.22, y: baseRotY, z: 0, duration: 0.35 });

  if (card.userData.edgeMat) {
    gsap.to(card.userData.edgeMat, { opacity: card.userData.baseEdgeOpacity, duration: 0.3 });
  }
  if (card.userData.boxMat) {
    gsap.to(card.userData.boxMat, { emissiveIntensity: 0.06, duration: 0.3 });
  }
  if (card.userData.scanOverlayMat) {
    gsap.to(card.userData.scanOverlayMat, { opacity: 0.1, duration: 0.3 });
  }

  // Settle Z back to platform
  if (card.userData.platform) {
    const p = card.userData.platform;
    if (p.userData.type === 'pool') {
      gsap.to(card.position, { z: p.position.z + 0.5, duration: 0.3 });
    } else if (p.userData.group) {
      gsap.to(card.position, { z: p.userData.group.position.z + 0.45, duration: 0.3 });
    }
  }
}

// ==================== EVENT LISTENERS ====================
window.addEventListener('mousemove', onMouseMove);
window.addEventListener('mousedown', onMouseDown);
window.addEventListener('mouseup', onMouseUp);
window.addEventListener('dblclick', onDoubleClick);
window.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('touchmove', (e) => { if (e.touches.length > 0) onMouseMove(e.touches[0]); }, { passive: true });
window.addEventListener('touchstart', (e) => { if (e.touches.length > 0) onMouseDown(e.touches[0]); }, { passive: true });
window.addEventListener('touchend', (e) => { onMouseUp(e.changedTouches ? e.changedTouches[0] : e); });
window.addEventListener('resize', onWindowResize);

function onMouseMove(event) {
  updateMousePos(event.clientX, event.clientY);
  lastMousePos = { x: event.clientX, y: event.clientY };

  // HUD reticle follows the cursor over the 3D canvas with live world coords
  if (hudReticle && !REDUCED_MOTION) {
    const overCanvas = !event.target || event.target.tagName === 'CANVAS';
    hudReticle.classList.toggle('visible', overCanvas || isDragging);
    if (overCanvas || isDragging) {
      reticleTarget.x = event.clientX;
      reticleTarget.y = event.clientY;
      raycaster.setFromCamera(mouse, camera);
      const hit = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(reticlePlane, hit)) {
        const fx = (hit.x >= 0 ? '+' : '-') + Math.abs(hit.x).toFixed(1).padStart(4, '0');
        const fy = (hit.y >= 0 ? '+' : '-') + Math.abs(hit.y).toFixed(1).padStart(4, '0');
        retCoords.textContent = `X ${fx} · Y ${fy}`;
      }
    }
  }

  if (!isDragging && !panoActive) {
    raycaster.setFromCamera(mouse, camera);

    // Check card hover
    const cardIntersects = raycaster.intersectObjects(cards, true);
    if (cardIntersects.length > 0) {
      const cardObj = getCardFromObject(cardIntersects[0].object);
      if (cardObj && cardObj !== hoveredCard) {
        // Exit previous hovered card
        if (hoveredCard && hoveredCard !== draggedCard) {
          onCardHoverExit(hoveredCard);
        }
        hoveredCard = cardObj;
        document.body.style.cursor = 'pointer';
        onCardHoverEnter(hoveredCard);
      }
    } else {
      if (hoveredCard && hoveredCard !== draggedCard) {
        onCardHoverExit(hoveredCard);
        hoveredCard = null;
        document.body.style.cursor = 'default';
      }
    }

    // Check platform hover
    const platIntersects = raycaster.intersectObjects(platforms, true);
    if (platIntersects.length > 0) {
      let platObj = getPlatformFromObject(platIntersects[0].object);
      if (!platObj) {
        // Try to find platform by checking parent hierarchy
        let obj = platIntersects[0].object;
        while (obj) {
          if (obj.userData && obj.userData.isPlatform) { platObj = obj; break; }
          obj = obj.parent;
        }
      }
      if (platObj && platObj !== hoveredPlatform) {
        if (hoveredPlatform) onPlatformHoverExit(hoveredPlatform);
        hoveredPlatform = platObj;
        onPlatformHoverEnter(hoveredPlatform);
      }
    } else {
      if (hoveredPlatform) {
        onPlatformHoverExit(hoveredPlatform);
        hoveredPlatform = null;
      }
    }
  }

  // Dragging card
  if (isDragging && draggedCard) {
    emitLaserTrail(draggedCard.position, dragSourceColor);

    raycaster.setFromCamera(mouse, camera);
    const intersect = new THREE.Vector3();
    raycaster.ray.intersectPlane(intersectionPlane, intersect);

    gsap.to(draggedCard.position, {
      x: intersect.x - dragOffset.x,
      y: intersect.y - dragOffset.y,
      duration: 0.05
    });

    // Delete zone check
    const deleteZone = document.getElementById('delete-zone');
    if (deleteZone) {
      const rect = deleteZone.getBoundingClientRect();
      if (event.clientX > rect.left && event.clientX < rect.right &&
          event.clientY > rect.top && event.clientY < rect.bottom) {
        deleteZone.classList.add('active');
      } else {
        deleteZone.classList.remove('active');
      }
    }
  }
}

function onMouseDown(event) {
  if (panoActive) return;
  if (event.target && event.target.tagName !== 'CANVAS') return;

  updateMousePos(event.clientX, event.clientY);
  lastMousePos = { x: event.clientX, y: event.clientY };

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(cards, true);

  // Left click card drag
  if ((event.button === 0 || event.button === undefined) && intersects.length > 0) {
    const cardObj = getCardFromObject(intersects[0].object);
    if (cardObj) {
      isDragging = true;
      draggedCard = cardObj;
      dragSpinSpeed = 0;
      controls.enabled = false;
      document.body.style.cursor = 'grabbing';
      if (hudReticle) hudReticle.classList.add('dragging');

      if (draggedCard.userData.platform) {
        dragSourceColor = draggedCard.userData.platform.userData.color || T.amber;
        const srcPlatform = draggedCard.userData.platform;
        const pCards = srcPlatform.userData.cards;
        if (Array.isArray(pCards)) {
          const idx = pCards.indexOf(draggedCard);
          if (idx > -1) {
            // Pool uses a compact grid — splice to avoid null holes that crash arrangePlatform;
            // tier rows keep slot semantics (null = empty slot)
            if (srcPlatform.userData.type === 'pool') pCards.splice(idx, 1);
            else pCards[idx] = null;
          }
        }
        draggedCard.userData.platform = null;
      }

      draggedCard.position.z = 2.2;

      intersectionPlane.setFromNormalAndCoplanarPoint(
        new THREE.Vector3(0, 0, 1),
        draggedCard.position
      );

      const intersect = new THREE.Vector3();
      raycaster.ray.intersectPlane(intersectionPlane, intersect);
      dragOffset.copy(intersect).sub(draggedCard.position);

      gsap.to(draggedCard.scale, { x: 1.15, y: 1.15, z: 1.15, duration: 0.15 });

      // Start accelerating spin
      dragSpinSpeed = 8; // Initial fast spin speed (radians per second)
    }
  }
}

function onMouseUp(event) {
  document.body.style.cursor = 'default';
  if (hudReticle) hudReticle.classList.remove('dragging');

  // Re-enable orbit controls only if toggle says so
  const orbitBtn = document.getElementById('toggle-orbit-btn');
  if (orbitBtn && orbitBtn.dataset.orbitEnabled === 'true') {
    controls.enabled = true;
  }

  const deleteZone = document.getElementById('delete-zone');
  if (deleteZone) deleteZone.classList.remove('active');

  if (isDragging && draggedCard) {
    isDragging = false;
    dragSpinSpeed = 0;

    gsap.to(draggedCard.scale, { x: 1, y: 1, z: 1, duration: 0.25 });
    draggedCard.position.z = 0.5;

    // Stop spinning - reset Y rotation
    const baseRotY = draggedCard.userData.isFlipped ? Math.PI : 0;
    gsap.to(draggedCard.rotation, { y: baseRotY, x: -0.22, z: 0, duration: 0.3 });

    // Delete zone check
    if (deleteZone && event.clientX && event.clientY) {
      const rect = deleteZone.getBoundingClientRect();
      if (event.clientX > rect.left && event.clientX < rect.right &&
          event.clientY > rect.top && event.clientY < rect.bottom) {
        triggerCyberBurst(draggedCard.position.clone(), T.signal);
        scene.remove(draggedCard);
        cards = cards.filter(c => c !== draggedCard);
        draggedCard = null;
        arrangeAllPlatforms();
        setTimeout(snapshotDraft, 0);
        return;
      }
    }

    // Find target platform
    updateMousePos(event.clientX || window.innerWidth / 2, event.clientY || window.innerHeight / 2);
    raycaster.setFromCamera(mouse, camera);
    const platformIntersects = raycaster.intersectObjects(platforms, true);

    let targetPlatform = poolPlatform;
    if (platformIntersects.length > 0) {
      let hitObj = platformIntersects[0].object;
      while (hitObj && !hitObj.userData?.isPlatform && hitObj.parent) {
        hitObj = hitObj.parent;
      }
      if (hitObj && hitObj.userData?.isPlatform) {
        targetPlatform = hitObj;
      }
    } else {
      let minDist = Infinity;
      platforms.forEach(p => {
        const posY = p.userData.group ? p.userData.group.position.y : p.position.y;
        const dist = Math.abs(draggedCard.position.y - posY);
        if (dist < minDist) {
          minDist = dist;
          targetPlatform = p;
        }
      });
    }

    if (targetPlatform && targetPlatform.userData) {
      if (targetPlatform.userData.type === 'tier') {
        const pCards = targetPlatform.userData.cards;
        let closestSlot = 0;
        let minDistX = Infinity;
        for (let s = 0; s < slotCount; s++) {
          const sx = getSlotX(s);
          const dist = Math.abs(draggedCard.position.x - sx);
          if (dist < minDistX) {
            minDistX = dist;
            closestSlot = s;
          }
        }

        if (pCards[closestSlot] && pCards[closestSlot] !== draggedCard) {
          let freeSlot = -1;
          for (let offset = 1; offset < slotCount; offset++) {
            if (closestSlot - offset >= 0 && !pCards[closestSlot - offset]) { freeSlot = closestSlot - offset; break; }
            if (closestSlot + offset < slotCount && !pCards[closestSlot + offset]) { freeSlot = closestSlot + offset; break; }
          }
          if (freeSlot !== -1) closestSlot = freeSlot;
        }

        pCards[closestSlot] = draggedCard;
        draggedCard.userData.platform = targetPlatform;
        draggedCard.userData.slotIndex = closestSlot;

        arrangePlatform(targetPlatform);
        setTimeout(snapshotDraft, 0);
        const platformColor = targetPlatform.userData.color || T.amber;
        triggerCyberBurst(draggedCard.position.clone(), platformColor);
        triggerLockBeam(draggedCard, platformColor);

      } else {
        if (!Array.isArray(targetPlatform.userData.cards)) targetPlatform.userData.cards = [];
        targetPlatform.userData.cards.push(draggedCard);
        draggedCard.userData.platform = targetPlatform;
        arrangePlatform(targetPlatform);
        setTimeout(snapshotDraft, 0);
        triggerCyberBurst(draggedCard.position.clone(), T.amber);
        triggerLockBeam(draggedCard, T.amber);
      }
    }

    draggedCard = null;
  }
}

// Double Click to Flip Card
function onDoubleClick(event) {
  if (panoActive) return;
  if (event.target && event.target.tagName !== 'CANVAS') return;

  updateMousePos(event.clientX, event.clientY);
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(cards, true);

  if (intersects.length > 0) {
    const cardObj = getCardFromObject(intersects[0].object);
    if (cardObj) {
      cardObj.userData.isFlipped = !cardObj.userData.isFlipped;
      const targetRotY = cardObj.userData.isFlipped ? Math.PI : 0;

      gsap.to(cardObj.position, { z: cardObj.position.z + 1.0, duration: 0.2, yoyo: true, repeat: 1 });
      gsap.to(cardObj.rotation, {
        y: targetRotY, x: -0.22,
        duration: 0.55, ease: "back.out(1.5)"
      });

      triggerCyberBurst(cardObj.position.clone(), T.steel);
    }
  }
}

// ==================== CONTROL BUTTONS ====================

// Skin Switcher (重装机械 / 全息赛博)
const skinBtn = document.getElementById('skin-btn');
const skinDropdown = document.getElementById('skin-dropdown');
if (skinBtn && skinDropdown) {
  skinDropdown.querySelectorAll('.skin-option').forEach(opt => {
    if (opt.dataset.skin === SKIN_ID) opt.classList.add('active');
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      if (opt.dataset.skin === SKIN_ID) {
        skinDropdown.classList.add('hidden');
        return;
      }
      try { localStorage.setItem('hangdaola_skin', opt.dataset.skin); } catch (err) {}
      location.reload();
    });
  });
  skinBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    skinDropdown.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!skinDropdown.classList.contains('hidden') && !e.target.closest('.skin-menu')) {
      skinDropdown.classList.add('hidden');
    }
  });
}

// Orbit Toggle (default: locked)
let orbitEnabled = false;
const toggleOrbitBtn = document.getElementById('toggle-orbit-btn');
toggleOrbitBtn.dataset.orbitEnabled = 'false';
toggleOrbitBtn.addEventListener('click', () => {
  orbitEnabled = !orbitEnabled;
  controls.enabled = orbitEnabled;
  toggleOrbitBtn.dataset.orbitEnabled = orbitEnabled ? 'true' : 'false';
  toggleOrbitBtn.innerHTML = orbitEnabled
    ? `<i class="fas fa-unlock"></i> 视角锁定: OFF`
    : `<i class="fas fa-crosshairs"></i> 视角锁定: ON`;
});

document.getElementById('reset-cam-btn').addEventListener('click', () => {
  gsap.to(camera.position, {
    x: DEFAULT_CAM_POS.x, y: DEFAULT_CAM_POS.y, z: DEFAULT_CAM_POS.z,
    duration: 0.8, ease: "power2.out"
  });
  controls.target.copy(DEFAULT_CAM_TARGET);
});

// Auto Align
document.getElementById('align-slots-btn').addEventListener('click', () => {
  arrangeAllPlatforms();
  cards.forEach(c => triggerCyberBurst(c.position.clone(), T.amber));
});

// Upload
document.getElementById('upload-input').addEventListener('change', function(e) {
  const files = e.target.files;
  for (let i = 0; i < files.length; i++) {
    const reader = new FileReader();
    reader.onload = function(event) {
      createImageCard(event.target.result);
    };
    reader.readAsDataURL(files[i]);
  }
  this.value = '';
});

// Text Card
document.getElementById('add-text-btn').addEventListener('click', () => {
  const input = document.getElementById('text-card-input');
  createTextCard(input.value);
  input.value = '';
});

document.getElementById('text-card-input').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    const input = document.getElementById('text-card-input');
    createTextCard(input.value);
    input.value = '';
  }
});

// Clear All
document.getElementById('clear-btn').addEventListener('click', () => {
  if (confirm('确定要清空面板上的所有卡片吗？')) {
    cards.forEach(c => {
      triggerCyberBurst(c.position, T.signal);
      scene.remove(c);
    });
    cards = [];
    platforms.forEach(p => {
      if (p.userData) {
        p.userData.cards = p.userData.type === 'tier' ? new Array(slotCount).fill(null) : [];
      }
    });
    setTimeout(snapshotDraft, 0);
    showHudToast('面板已清空 // MATRIX.PURGED');
  }
});

// ==================== SAVE / LOAD ====================
document.getElementById('save-storage-btn').addEventListener('click', () => {
  saveToLocalStorage();
});

function saveToLocalStorage() {
  const title = document.getElementById('rankTitle').innerText;
  const labelSpans = document.querySelectorAll('.tier-label span[contenteditable]');
  const labelsData = Array.from(labelSpans).map(s => s.innerText);

  const cardsData = cards.map(c => {
    let platformIndex = -1;
    if (c.userData.platform) {
      if (c.userData.platform.userData.type === 'tier') {
        platformIndex = c.userData.platform.userData.index;
      } else {
        platformIndex = 99;
      }
    }
    return {
      type: c.userData.cardType,
      src: c.userData.src || null,
      text: c.userData.text || null,
      platformIndex: platformIndex,
      slotIndex: c.userData.slotIndex || 0,
      isFlipped: c.userData.isFlipped || false
    };
  });

  const archive = {
    id: Date.now(),
    title: title,
    labels: labelsData,
    cards: cardsData,
    date: new Date().toLocaleString()
  };

  const existing = JSON.parse(localStorage.getItem('hangdaola_archives') || '[]');
  existing.unshift(archive);
  localStorage.setItem('hangdaola_archives', JSON.stringify(existing));

  renderArchivesList();
  showHudToast('数据已存档 // ARCHIVE.SAVED');
}

function renderArchivesList() {
  const listEl = document.getElementById('archive-list');
  const existing = JSON.parse(localStorage.getItem('hangdaola_archives') || '[]');

  if (existing.length === 0) {
    listEl.innerHTML = '<div class="empty-archive">暂无存档记录</div>';
    return;
  }

  listEl.innerHTML = existing.map(item => `
    <div class="archive-item">
      <div class="archive-info">
        <span class="archive-title">${item.title}</span>
        <span class="archive-date">${item.date}</span>
      </div>
      <div class="archive-actions">
        <button class="archive-btn load-archive-btn" data-id="${item.id}" title="加载存档"><i class="fas fa-folder-open"></i></button>
        <button class="archive-btn del-archive-btn" data-id="${item.id}" title="删除存档"><i class="fas fa-trash"></i></button>
      </div>
    </div>
  `).join('');

  document.querySelectorAll('.load-archive-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = parseInt(e.currentTarget.getAttribute('data-id'));
      loadArchive(id);
    });
  });

  document.querySelectorAll('.del-archive-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = parseInt(e.currentTarget.getAttribute('data-id'));
      deleteArchive(id);
    });
  });
}

function loadArchive(id) {
  const existing = JSON.parse(localStorage.getItem('hangdaola_archives') || '[]');
  const item = existing.find(a => a.id === id);
  if (!item) return;

  cards.forEach(c => scene.remove(c));
  cards = [];
  platforms.forEach(p => {
    if (p.userData) {
      p.userData.cards = p.userData.type === 'tier' ? new Array(slotCount).fill(null) : [];
    }
  });

  document.getElementById('rankTitle').innerText = item.title;
  const labelSpans = document.querySelectorAll('.tier-label span[contenteditable]');
  item.labels.forEach((lbl, i) => {
    if (labelSpans[i]) labelSpans[i].innerText = lbl;
  });

  item.cards.forEach(cData => {
    if (cData.type === 'image' && cData.src) {
      createImageCard(cData.src);
    } else if (cData.type === 'text' && cData.text) {
      createTextCard(cData.text);
    }
  });
}

function deleteArchive(id) {
  let existing = JSON.parse(localStorage.getItem('hangdaola_archives') || '[]');
  existing = existing.filter(a => a.id !== id);
  localStorage.setItem('hangdaola_archives', JSON.stringify(existing));
  renderArchivesList();
}

document.getElementById('toggle-archive-btn').addEventListener('click', () => {
  const body = document.getElementById('archive-list');
  const chevron = document.getElementById('archive-chevron');
  body.classList.toggle('hidden');
  chevron.classList.toggle('fa-chevron-up');
  chevron.classList.toggle('fa-chevron-down');
});

// Export Image
document.getElementById('export-img-btn').addEventListener('click', () => {
  document.body.classList.add('capturing');

  const oldPos = camera.position.clone();
  camera.position.set(0, -0.5, 26.0);
  camera.lookAt(0, -0.5, 0);
  composer.render();

  html2canvas(document.body, {
    backgroundColor: T.bgHex,
    ignoreElements: (el) => el.classList.contains('top-nav') || el.classList.contains('archive-drawer') || el.classList.contains('bottom-controls-right') || el.classList.contains('interaction-tip')
  }).then(canvas => {
    const link = document.createElement('a');
    link.download = `全息排行榜_${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
    document.body.classList.remove('capturing');
    camera.position.copy(oldPos);
    showHudToast('画面已捕获导出 // CAPTURE.COMPLETE');
  });
});

// Resize
function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  updateLabelsPosition();
}

// ==================== RENDER LOOP ====================
function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  const time = clock.elapsedTime;

  controls.update();

  // Gentle 3D perspective idle floating + mouse parallax when camera is locked and not dragging
  if (!controls.enabled && !isDragging && !panoActive) {
    mouseParallax.x += (mouse.x - mouseParallax.x) * 0.04;
    mouseParallax.y += (mouse.y - mouseParallax.y) * 0.04;
    if (REDUCED_MOTION) {
      camera.position.copy(DEFAULT_CAM_POS);
    } else {
      camera.position.x = DEFAULT_CAM_POS.x + Math.sin(time * 0.4) * 0.35 + mouseParallax.x * 1.15;
      camera.position.y = DEFAULT_CAM_POS.y + Math.cos(time * 0.3) * 0.25 + mouseParallax.y * 0.7;
    }
    camera.lookAt(DEFAULT_CAM_TARGET);
  }

  // HUD reticle easing toward the cursor
  if (hudReticle && !REDUCED_MOTION && hudReticle.classList.contains('visible')) {
    reticlePos.x += (reticleTarget.x - reticlePos.x) * 0.22;
    reticlePos.y += (reticleTarget.y - reticlePos.y) * 0.22;
    hudReticle.style.transform = `translate(${reticlePos.x}px, ${reticlePos.y}px)`;
  }

  // Static lighting (no sweep / breathing)

  // 1. Update 3D Fluid Wireframe Mesh Grid Wave (流体网格)
  if (fluidGridGeometry) {
    const pos = fluidGridGeometry.attributes.position;
    const count = pos.count;
    for (let i = 0; i < count; i++) {
      const ix = fluidGridInitial[i * 3];
      const iz = fluidGridInitial[i * 3 + 2];

      // Superposition of fluid liquid wave harmonics
      const w1 = Math.sin(ix * 0.12 + time * 1.1) * 1.6;
      const w2 = Math.cos(iz * 0.14 + time * 0.95) * 1.4;
      const w3 = Math.sin((ix + iz) * 0.08 + time * 1.3) * 1.1;
      const w4 = Math.cos(Math.sqrt(ix * ix + iz * iz) * 0.08 - time * 0.8) * 0.9;

      pos.setY(i, w1 + w2 + w3 + w4);
    }
    pos.needsUpdate = true;
    fluidGridGeometry.computeVertexNormals();
  }

  // 2. Update Data Stream Particles
  if (dataStreamMesh) {
    const pos = dataStreamMesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      let y = pos.getY(i);
      let x = pos.getX(i);
      y += streamSpeeds[i];
      x += Math.sin(time * 1.2 + streamPhases[i]) * 0.01;
      if (y > 25) y = -25;
      pos.setY(i, y);
      pos.setX(i, x);
    }
    pos.needsUpdate = true;
    dataStreamMesh.rotation.y = time * 0.01;
  }

  // 3. Update Burst & Trail Particles
  updateBurstParticles(delta);
  updateDragTrails();

  // 3.5 全景模式专属动画（领奖台扫光 / 卡牌环绕 / 全息彩带）
  if (panoActive) {
    updatePanoFrame(time, delta);
  }

  // 4. Card animations
  cards.forEach(card => {
    if (card === draggedCard) {
      // While dragging: fast Y-axis spin
      card.rotation.y += dragSpinSpeed * delta;
      // Gradually slow down the spin a tiny bit for more natural feel
      // (but keep it fast enough to be visible)
      return;
    }

    // Hover slow spin
    if (card === hoveredCard && card.userData.hoverSpinY) {
      card.rotation.y += 0.015;
    }

    // Floating breathing motion
    if (!panoActive && card.userData.platform) {
      const floatOffset = Math.sin(time * 2.0 + card.userData.baseTime) * 0.025;

      if (card.userData.platform.userData.type === 'pool') {
        const baseZ = card.userData.platform.position.z + 0.5;
        if (card !== hoveredCard) {
          card.position.z = baseZ + floatOffset;
        }
      } else {
        const tierGroup = card.userData.platform.userData.group;
        if (tierGroup && card !== hoveredCard) {
          const baseZ = tierGroup.position.z + 0.45;
          if (!card.userData.platform.userData.isHovered) {
            card.position.z = baseZ + floatOffset;
          }
        }
      }
    }
  });

  // 5. Pool platform ambient radar sweep (待判定域 scanline strip)
  if (poolScanMesh) {
    const sweepT = (time * 0.45) % 1;
    poolScanMesh.position.y = -1.1 + sweepT * 2.2;
    poolScanMesh.material.opacity = 0.22 * Math.sin(sweepT * Math.PI);
  }

  updateLabelsPosition();
  updateHudStats();
  composer.render();
}

// ==================== INIT ====================
// 标题/层级名编辑后同步草稿
document.getElementById('labels-container').addEventListener('input', () => setTimeout(snapshotDraft, 0));
const _rt = document.getElementById('rankTitle');
if (_rt) _rt.addEventListener('input', () => setTimeout(snapshotDraft, 0));

renderArchivesList();
updateLabelsPosition();
if (!hydrateDraft()) initSampleCards();
animate();

// Boot sequence: lift pre-boot states, decode the title, start tip rotation
setTimeout(() => {
  document.body.classList.remove('pre-boot');
  const titleEl = document.getElementById('rankTitle');
  if (titleEl) scrambleText(titleEl, titleEl.textContent.trim() || 'TIER_LIST');
}, 120);
setInterval(rotateTip, 7000);

// ==================== PANORAMA MODE · 全息领奖台 ====================
// 一键把平面榜单切换成「圆柱五层霓虹领奖台塔」：
// 平层平台折叠收起 → 领奖台塔弹性升起 → 已排名卡牌按层级环绕塔身悬浮，
// 卡池卡牌退到远处深空缓慢公转 → 顶层金色探照灯 + 全息彩带，镜头缓慢环绕。
const PANO_CFG = {
  radii:   [3.4, 5.0, 6.6, 8.2, 9.8],   // 夯(顶,最小) → 拉(底,最大)
  ys:      [5.6, 3.1, 0.6, -1.9, -4.4],
  discH: 1.5,
  cardRingGap: 1.5,   // 卡牌环绕半径 = 盘半径 + 此值
  cardLift: 1.25,     // 卡牌中心距盘面高度
  gold: 0xffd76a
};

let panoGroup = null;        // 领奖台塔整体
let panoSweeps = [];         // 每层旋转扫光条
let panoConfetti = null;     // 全息彩带粒子
let panoConfettiSpeeds = null;
let panoSpotCone = null;
let panoSpotLight = null;
let panoSaved = null;        // 进入前的完整现场，用于无损还原

// 环绕盘身的霓虹字带（层级名 · 段位码 重复一圈）
function createPanoBandTexture(tier) {
  const canvas = document.createElement('canvas');
  canvas.width = 2048; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const colorHex = '#' + tier.color.toString(16).padStart(6, '0');
  ctx.clearRect(0, 0, 2048, 128);
  ctx.font = '900 64px "Orbitron", "Noto Sans SC", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = colorHex;
  ctx.shadowColor = colorHex;
  ctx.shadowBlur = 18;
  const unit = tier.name + ' · ' + tier.rankCode + '  ◆  ';
  let x = 20;
  while (x < 2048) { ctx.fillText(unit, x, 64); x += ctx.measureText(unit).width + 40; }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

function buildPanoTower() {
  panoGroup = new THREE.Group();

  tiers.forEach((tier, i) => {
    const r = PANO_CFG.radii[i];
    const y = PANO_CFG.ys[i];
    const h = PANO_CFG.discH;
    const disc = new THREE.Group();
    disc.position.y = y;

    // 盘体 —— 暗色金属 + 层级色微发光
    const bodyGeo = new THREE.CylinderGeometry(r, r * 1.04, h, 72);
    const bodyMat = new THREE.MeshPhysicalMaterial({
      color: 0x0a0f1c, metalness: 0.85, roughness: 0.32,
      emissive: tier.color, emissiveIntensity: 0.06,
      transparent: true, opacity: 0.94
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    disc.add(body);

    // 盘面全息薄膜
    const topGeo = new THREE.CircleGeometry(r - 0.12, 72);
    const topMat = new THREE.MeshBasicMaterial({
      color: tier.color, transparent: true, opacity: 0.07,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    const topFilm = new THREE.Mesh(topGeo, topMat);
    topFilm.rotation.x = -Math.PI / 2;
    topFilm.position.y = h / 2 + 0.02;
    topFilm.raycast = () => {};
    disc.add(topFilm);

    // 盘沿霓虹环
    const rimGeo = new THREE.TorusGeometry(r, 0.055, 12, 96);
    const rimMat = new THREE.MeshBasicMaterial({ color: tier.color });
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = h / 2;
    rim.raycast = () => {};
    disc.add(rim);

    // 盘身霓虹字带
    const bandTex = createPanoBandTexture(tier);
    const bandGeo = new THREE.CylinderGeometry(r + 0.03, r + 0.03, 0.62, 72, 1, true);
    const bandMat = new THREE.MeshBasicMaterial({
      map: bandTex, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    });
    const band = new THREE.Mesh(bandGeo, bandMat);
    band.raycast = () => {};
    disc.add(band);

    // 旋转扫光条（复用扫光贴图）
    const sweepGeo = new THREE.PlaneGeometry(r * 2, 1.0);
    const sweepMat = new THREE.MeshBasicMaterial({
      map: scanLineTex, color: tier.color, transparent: true, opacity: 0.22,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    const sweep = new THREE.Mesh(sweepGeo, sweepMat);
    sweep.rotation.x = -Math.PI / 2;
    sweep.position.y = h / 2 + 0.06;
    sweep.raycast = () => {};
    disc.add(sweep);
    panoSweeps.push({ mesh: sweep, speed: 0.25 + i * 0.08 });

    panoGroup.add(disc);
  });

  // 顶层金色探照灯光锥
  const topY = PANO_CFG.ys[0] + PANO_CFG.discH / 2;
  const coneGeo = new THREE.ConeGeometry(4.4, 13, 40, 1, true);
  const coneMat = new THREE.MeshBasicMaterial({
    color: PANO_CFG.gold, transparent: true, opacity: 0.055,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
  });
  panoSpotCone = new THREE.Mesh(coneGeo, coneMat);
  panoSpotCone.position.y = topY + 6.5;
  panoSpotCone.raycast = () => {};
  panoGroup.add(panoSpotCone);

  panoSpotLight = new THREE.PointLight(PANO_CFG.gold, 1.6, 34, 2);
  panoSpotLight.position.set(0, topY + 5.5, 0);
  panoGroup.add(panoSpotLight);

  // 全息彩带粒子（层级五色 + 金）
  const count = 320;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  panoConfettiSpeeds = new Float32Array(count);
  const palette = tiers.map(t => new THREE.Color(t.color)).concat([new THREE.Color(PANO_CFG.gold)]);
  for (let k = 0; k < count; k++) {
    const a = Math.random() * Math.PI * 2;
    const rr = 2 + Math.random() * 14;
    positions[k * 3] = Math.cos(a) * rr;
    positions[k * 3 + 1] = -8 + Math.random() * 22;
    positions[k * 3 + 2] = Math.sin(a) * rr;
    const c = palette[(Math.random() * palette.length) | 0];
    colors[k * 3] = c.r; colors[k * 3 + 1] = c.g; colors[k * 3 + 2] = c.b;
    panoConfettiSpeeds[k] = 0.008 + Math.random() * 0.02;
  }
  const confettiGeo = new THREE.BufferGeometry();
  confettiGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  confettiGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const confettiMat = new THREE.PointsMaterial({
    size: 0.32, map: softGlowTex, vertexColors: true, transparent: true,
    opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false
  });
  panoConfetti = new THREE.Points(confettiGeo, confettiMat);
  panoConfetti.raycast = () => {};
  panoGroup.add(panoConfetti);

  panoGroup.visible = false;
  panoGroup.scale.setScalar(0.001);
  scene.add(panoGroup);
}

// 每帧：扫光旋转 / 彩带飘落 / 卡牌环绕悬浮
function updatePanoFrame(time, delta) {
  if (!panoGroup) return;

  panoSweeps.forEach(s => { s.mesh.rotation.z += s.speed * delta; });

  if (panoSpotCone) panoSpotCone.rotation.y += 0.15 * delta;

  if (panoConfetti) {
    const pos = panoConfetti.geometry.attributes.position;
    for (let k = 0; k < pos.count; k++) {
      let y = pos.getY(k) - panoConfettiSpeeds[k];
      if (y < -8) y = 14;
      pos.setY(k, y);
      pos.setX(k, pos.getX(k) + Math.sin(time * 1.4 + k) * 0.004);
    }
    pos.needsUpdate = true;
  }

  cards.forEach(card => {
    const p = card.userData.pano;
    if (!p || !p.settled) return;
    if (p.pool) {
      p.angle += p.orbitSpeed * delta;   // 卡池深空缓慢公转
    }
    const wobble = Math.sin(time * 1.5 + p.phase) * 0.12;
    card.position.set(
      Math.cos(p.angle) * p.radius,
      p.baseY + wobble,
      Math.sin(p.angle) * p.radius
    );
    card.rotation.y = Math.PI / 2 - p.angle + Math.sin(time * 0.9 + p.phase) * 0.06;
  });
}

function enterPanorama() {
  if (panoActive) return;
  panoActive = true;
  document.body.classList.add('pano-mode');

  // 1) 存档现场：相机 + 每张卡牌的位姿
  panoSaved = {
    camPos: camera.position.clone(),
    camTarget: controls.target.clone(),
    autoRotate: controls.autoRotate,
    cards: cards.map(c => ({
      card: c,
      pos: c.position.clone(),
      rot: c.rotation.clone(),
      scale: c.scale.clone()
    }))
  };

  // 2) 平面平台 & 卡池平台折叠收起
  platforms.forEach(pf => {
    const host = pf.userData.group || pf;
    gsap.to(host.scale, {
      x: 0.001, y: 0.001, z: 0.001, duration: 0.7, ease: 'power3.in',
      onComplete: () => { host.visible = false; }
    });
  });

  // 3) 领奖台塔弹性升起
  if (!panoGroup) buildPanoTower();
  panoGroup.visible = true;
  gsap.to(panoGroup.scale, { x: 1, y: 1, z: 1, duration: 1.4, ease: 'elastic.out(1, 0.65)', delay: 0.35 });

  // 4) 分配每张卡牌的环绕位
  let delayIdx = 0;
  tiers.forEach((tier, i) => {
    const pf = platforms[i];
    const tierCards = (pf && pf.userData.cards) ? pf.userData.cards.filter(Boolean) : [];
    const n = tierCards.length;
    const ringR = PANO_CFG.radii[i] + PANO_CFG.cardRingGap;
    const baseY = PANO_CFG.ys[i] + PANO_CFG.discH / 2 + PANO_CFG.cardLift;
    tierCards.forEach((card, k) => {
      const angle = (k / Math.max(n, 1)) * Math.PI * 2 + i * 0.55;
      const isChampion = (i === 0 && k === 0);
      card.userData.pano = {
        angle, radius: ringR, baseY: baseY + (isChampion ? 0.35 : 0),
        phase: Math.random() * Math.PI * 2, pool: false, settled: false
      };
      gsap.to(card.position, {
        x: Math.cos(angle) * ringR, y: baseY, z: Math.sin(angle) * ringR,
        duration: 1.25, delay: 0.5 + delayIdx * 0.04, ease: 'power3.inOut',
        onComplete: () => { card.userData.pano.settled = true; }
      });
      gsap.to(card.rotation, {
        y: Math.PI / 2 - angle, duration: 1.25, delay: 0.5 + delayIdx * 0.04, ease: 'power3.inOut'
      });
      if (isChampion) {
        gsap.to(card.scale, { x: 1.22, y: 1.22, z: 1.22, duration: 1.0, delay: 1.4, ease: 'back.out(2)' });
      }
      delayIdx++;
    });
  });

  // 5) 卡池卡牌退入深空缓慢公转
  const pool = platforms.find(pf => pf.userData.type === 'pool');
  if (pool && pool.userData.cards) {
    pool.userData.cards.filter(Boolean).forEach(card => {
      const angle = Math.random() * Math.PI * 2;
      const radius = 13.5 + Math.random() * 4.5;
      const baseY = -5 + Math.random() * 10;
      card.userData.pano = {
        angle, radius, baseY, phase: Math.random() * Math.PI * 2,
        pool: true, orbitSpeed: 0.04 + Math.random() * 0.05, settled: false
      };
      gsap.to(card.position, {
        x: Math.cos(angle) * radius, y: baseY, z: Math.sin(angle) * radius,
        duration: 1.5, delay: 0.4, ease: 'power3.inOut',
        onComplete: () => { card.userData.pano.settled = true; }
      });
      gsap.to(card.rotation, {
        y: Math.PI / 2 - angle, duration: 1.5, delay: 0.4, ease: 'power3.inOut'
      });
    });
  }

  // 6) 镜头：切到环绕机位，缓慢自动旋转
  controls.autoRotate = !REDUCED_MOTION;
  controls.autoRotateSpeed = 0.7;
  gsap.to(controls.target, { x: 0, y: 0.8, z: 0, duration: 1.2, ease: 'power2.inOut' });
  gsap.to(camera.position, { x: 0, y: 4.5, z: 33, duration: 1.2, ease: 'power2.inOut' });

  showHudToast('PANORAMA.MODE // 全息领奖台已升起');
}

function exitPanorama() {
  if (!panoActive) return;
  panoActive = false;
  document.body.classList.remove('pano-mode');

  // 1) 镜头还原
  controls.autoRotate = panoSaved ? panoSaved.autoRotate : false;
  if (panoSaved) {
    gsap.to(controls.target, { x: panoSaved.camTarget.x, y: panoSaved.camTarget.y, z: panoSaved.camTarget.z, duration: 1.0, ease: 'power2.inOut' });
    gsap.to(camera.position, { x: panoSaved.camPos.x, y: panoSaved.camPos.y, z: panoSaved.camPos.z, duration: 1.0, ease: 'power2.inOut' });
  }

  // 2) 领奖台塔收回
  if (panoGroup) {
    gsap.to(panoGroup.scale, {
      x: 0.001, y: 0.001, z: 0.001, duration: 0.6, ease: 'power3.in',
      onComplete: () => { panoGroup.visible = false; }
    });
  }

  // 3) 平面平台复位
  platforms.forEach(pf => {
    const host = pf.userData.group || pf;
    host.visible = true;
    gsap.to(host.scale, { x: 1, y: 1, z: 1, duration: 0.9, delay: 0.3, ease: 'elastic.out(1, 0.7)' });
  });

  // 4) 卡牌无损归位
  if (panoSaved) {
    panoSaved.cards.forEach((s, idx) => {
      gsap.killTweensOf(s.card.position);
      gsap.killTweensOf(s.card.rotation);
      gsap.killTweensOf(s.card.scale);
      gsap.to(s.card.position, { x: s.pos.x, y: s.pos.y, z: s.pos.z, duration: 1.1, delay: 0.15 + idx * 0.02, ease: 'power3.inOut' });
      gsap.to(s.card.rotation, { x: s.rot.x, y: s.rot.y, z: s.rot.z, duration: 1.1, delay: 0.15 + idx * 0.02, ease: 'power3.inOut' });
      gsap.to(s.card.scale, { x: s.scale.x, y: s.scale.y, z: s.scale.z, duration: 0.8, delay: 0.15 + idx * 0.02, ease: 'power2.inOut' });
      s.card.userData.pano = null;
    });
  }
  panoSaved = null;
  showHudToast('PANORAMA.EXIT // 返回重装矩阵');
}

const panoBtn = document.getElementById('pano-btn');
if (panoBtn) {
  panoBtn.addEventListener('click', () => {
    if (panoActive) {
      exitPanorama();
      panoBtn.innerHTML = '<i class="fas fa-panorama"></i> 全景: OFF';
    } else {
      enterPanorama();
      panoBtn.innerHTML = '<i class="fas fa-panorama"></i> 全景: ON';
    }
  });
}
