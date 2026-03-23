const API = '';

// Theme toggle
const themeToggle = document.getElementById('theme-toggle');
const html = document.documentElement;

// Check saved theme
const savedTheme = localStorage.getItem('theme') || 'dark';
html.setAttribute('data-theme', savedTheme);

// Theme toggle handler
themeToggle.addEventListener('click', () => {
  const current = html.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
});

// DOM Elements
const emptyState = document.getElementById('empty-state');
const previewStage = document.getElementById('preview-stage');
const controlDock = document.getElementById('control-dock');
const fileInput = document.getElementById('file-input');
const uploadBtn = document.getElementById('upload-btn');
const btnRun = document.getElementById('btn-run');
const btnDownload = document.getElementById('btn-download');
const loadingLayer = document.getElementById('loading-layer');
const topBar = document.getElementById('top-bar');
const toast = document.getElementById('toast');
const statusDot = document.getElementById('status-dot');
const deviceBadge = document.getElementById('device-badge');

const imgOriginal = document.getElementById('img-original');
const imgResult = document.getElementById('img-result');
const splitBar = document.getElementById('split-bar');
const viewLayerOriginal = document.querySelector('.view-layer.original');

const bgModelSel = document.getElementById('bg-model');
const upModelSel = document.getElementById('up-model');
const bgModelGroup = document.getElementById('bg-model-group');
const upModelGroup = document.getElementById('up-model-group');
const btnLoadBg = document.getElementById('btn-load-bg');
const btnLoadUp = document.getElementById('btn-load-up');

const infoDims = document.getElementById('info-dims');
const infoTime = document.getElementById('info-time');

// State
let currentFile = null;
let currentMode = 'rembg';
let resultBlob = null;
const bgState = {};
const upState = {};
let isDragging = false;

// ─── Init ───────────────────────────────────────────────────────────────────

async function init() {
  checkHealth();
  setInterval(checkHealth, 10000);
  await Promise.all([fetchDevice(), fetchModels()]);
  initSplitView();
}

async function fetchDevice() {
  try {
    const r = await fetch(`${API}/device`);
    if (!r.ok) return;
    const d = await r.json();
    deviceBadge.textContent = d.gpu ? 'GPU' : 'CPU';
    deviceBadge.className = 'device-badge ' + (d.gpu ? 'gpu' : 'cpu');
  } catch { deviceBadge.textContent = ''; }
}

async function fetchModels() {
  try {
    const r = await fetch(`${API}/models`);
    if (!r.ok) return;
    const data = await r.json();

    // Populate BG model select from backend list
    bgModelSel.innerHTML = data.bg_models
      .map(m => `<option value="${m.id}">${m.label}</option>`)
      .join('');

    Object.assign(bgState, data.bg_removal);
    Object.assign(upState, data.upscaling);
    refreshBgStatus();
    refreshUpStatus();
  } catch (e) { console.warn('fetchModels failed', e); }
}

async function checkHealth() {
  try {
    const r = await fetch(`${API}/health`);
    statusDot.className = r.ok ? 'status-dot online' : 'status-dot offline';
  } catch { statusDot.className = 'status-dot offline'; }
}

// ─── Split View ─────────────────────────────────────────────────────────────

function initSplitView() {
  const splitView = document.getElementById('split-view');
  
  splitBar.addEventListener('mousedown', (e) => {
    isDragging = true;
    e.preventDefault();
    document.body.style.cursor = 'ew-resize';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const rect = splitView.getBoundingClientRect();
    let x = e.clientX - rect.left;
    x = Math.max(0, Math.min(x, rect.width));
    const pct = (x / rect.width) * 100;
    splitBar.style.left = pct + '%';
    viewLayerOriginal.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    document.body.style.cursor = '';
  });

  // Touch
  splitBar.addEventListener('touchstart', (e) => {
    isDragging = true;
    e.preventDefault();
  });

  document.addEventListener('touchmove', (e) => {
    if (!isDragging) return;
    const rect = splitView.getBoundingClientRect();
    let x = e.touches[0].clientX - rect.left;
    x = Math.max(0, Math.min(x, rect.width));
    const pct = (x / rect.width) * 100;
    splitBar.style.left = pct + '%';
    viewLayerOriginal.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
  });

  document.addEventListener('touchend', () => {
    isDragging = false;
  });
}

// ─── Mode Switch ────────────────────────────────────────────────────────────

document.querySelectorAll('.switch-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.switch-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    applyMode(btn.dataset.mode);
  });
});

function applyMode(mode) {
  currentMode = mode;
  bgModelGroup.hidden = mode === 'upscale';
  upModelGroup.hidden = mode === 'rembg';
}

applyMode('rembg');

// ─── Model Status ───────────────────────────────────────────────────────────

function setModelBtn(btn, state) {
  if (state === 'loaded') {
    btn.textContent = 'Ready';
    btn.disabled = true;
    btn.dataset.state = 'loaded';
  } else if (state === 'cached') {
    btn.textContent = 'Load';
    btn.disabled = false;
    btn.dataset.state = 'cached';
  } else {
    btn.textContent = 'Download';
    btn.disabled = false;
    btn.dataset.state = 'not_downloaded';
  }
}

function refreshBgStatus() {
  const s = bgState[bgModelSel.value] || 'not_downloaded';
  setModelBtn(btnLoadBg, s);
}

function refreshUpStatus() {
  const ok = upState[upModelSel.value] ?? false;
  setModelBtn(btnLoadUp, ok ? 'loaded' : 'not_downloaded');
}

bgModelSel.addEventListener('change', refreshBgStatus);
upModelSel.addEventListener('change', refreshUpStatus);

// ─── Load Models ────────────────────────────────────────────────────────────

btnLoadBg.addEventListener('click', () => {
  const model = bgModelSel.value;
  btnLoadBg.disabled = true;
  
  const es = new EventSource(`${API}/load-model/stream?model=${encodeURIComponent(model)}`);
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.phase === 'ready') {
      bgState[model] = 'loaded';
      refreshBgStatus();
      es.close();
    } else if (msg.phase === 'error') {
      refreshBgStatus();
      es.close();
    }
  };
  es.onerror = () => {
    refreshBgStatus();
    es.close();
  };
});

btnLoadUp.addEventListener('click', () => {
  const model = upModelSel.value;
  if (upState[model]) return;
  btnLoadUp.disabled = true;
  
  const es = new EventSource(`${API}/download-upscale/stream?model=${encodeURIComponent(model)}`);
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.phase === 'ready') {
      upState[model] = true;
      refreshUpStatus();
      es.close();
    } else if (msg.phase === 'error') {
      refreshUpStatus();
      es.close();
    }
  };
  es.onerror = () => {
    refreshUpStatus();
    es.close();
  };
});

// ─── Upload ─────────────────────────────────────────────────────────────────

document.querySelector('.upload-box').addEventListener('click', () => fileInput.click());
uploadBtn.addEventListener('click', () => fileInput.click());

const uploadBox = document.querySelector('.upload-box');

uploadBox.addEventListener('dragover', e => {
  e.preventDefault();
  uploadBox.style.borderColor = 'var(--text-secondary)';
});

uploadBox.addEventListener('dragleave', () => {
  uploadBox.style.borderColor = '';
});

uploadBox.addEventListener('drop', e => {
  e.preventDefault();
  uploadBox.style.borderColor = '';
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) loadFile(fileInput.files[0]);
});

async function loadFile(file) {
  if (!file.type.startsWith('image/')) {
    showToast('Please select an image file');
    return;
  }
  
  currentFile = file;
  
  const url = URL.createObjectURL(file);
  imgOriginal.src = url;
  imgResult.src = '';
  resultBlob = null;
  
  // Switch to preview
  emptyState.hidden = true;
  previewStage.hidden = false;
  btnRun.disabled = false;
  btnDownload.hidden = true;
  
  // Reset to single-image view (no split until result is ready)
  splitBar.classList.remove('visible');
  splitBar.style.left = '50%';
  viewLayerOriginal.style.clipPath = 'none';
  viewLayerOriginal.classList.remove('processing');
  
  // Update sizer and info
  const imgSizer = document.getElementById('img-sizer');
  imgSizer.src = url;
  
  const img = new Image();
  img.onload = () => {
    infoDims.textContent = `${img.naturalWidth}×${img.naturalHeight}`;
  };
  img.src = url;
  infoTime.textContent = '—';
  
  // Auto process
  runProcess();
}

// ─── Process ────────────────────────────────────────────────────────────────

btnRun.addEventListener('click', runProcess);

async function runProcess() {
  if (!currentFile || btnRun.disabled) return;

  const bgModel = bgModelSel.value;
  const upModel = upModelSel.value;

  btnRun.disabled = true;
  btnRun.querySelector('span').textContent = 'Processing';
  topBar.classList.add('active');
  loadingLayer.hidden = false;
  viewLayerOriginal.classList.add('processing');

  const startTime = Date.now();

  try {
    let blob = currentFile;
    if (currentMode === 'rembg') {
      blob = await callRemoveBg(blob, bgModel);
    } else if (currentMode === 'upscale') {
      blob = await callUpscale(blob, upModel);
    }

    resultBlob = blob;
    const resultUrl = URL.createObjectURL(blob);
    imgResult.src = resultUrl;
    btnDownload.hidden = false;

    // Reveal split view
    viewLayerOriginal.style.clipPath = 'inset(0 50% 0 0)';
    splitBar.classList.add('visible');

    const img = new Image();
    img.onload = () => {
      infoDims.textContent = `${imgOriginal.naturalWidth}×${imgOriginal.naturalHeight} → ${img.naturalWidth}×${img.naturalHeight}`;
    };
    img.src = resultUrl;

    if (currentMode !== 'upscale') {
      bgState[bgModel] = 'loaded';
      refreshBgStatus();
    }
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Processing failed');
  } finally {
    viewLayerOriginal.classList.remove('processing');
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    infoTime.textContent = `${elapsed}s`;
    
    btnRun.disabled = false;
    btnRun.querySelector('span').textContent = 'Process';
    topBar.classList.remove('active');
    loadingLayer.hidden = true;
  }
}

async function callRemoveBg(file, model) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('model', model);
  const r = await fetch(`${API}/remove-bg`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error((await r.json()).detail || 'Failed');
  return r.blob();
}

async function callUpscale(file, model) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('model', model);
  const r = await fetch(`${API}/upscale`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error((await r.json()).detail || 'Failed');
  return r.blob();
}

// ─── Download ───────────────────────────────────────────────────────────────

btnDownload.addEventListener('click', () => {
  if (!resultBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(resultBlob);
  const base = currentFile ? currentFile.name.replace(/\.[^.]+$/, '') : 'result';
  a.download = `${base}_processed.png`;
  a.click();
});

// ─── Toast ──────────────────────────────────────────────────────────────────

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

// ─── Boot ───────────────────────────────────────────────────────────────────

init();
