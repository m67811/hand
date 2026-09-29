/**
 * SignBridge — Frontend Application
 * WebSocket client for real-time gesture detection + Avatar TTS animation
 */

'use strict';

// ── Configuration ──────────────────────────────────────────────────────────
const CONFIG = {
  WS_GESTURE: 'ws://localhost:8000/ws/gesture',
  WS_AVATAR:  'ws://localhost:8000/ws/avatar',
  API_BASE:   'http://localhost:8000',
  FRAME_INTERVAL: 80,     // ms between frames sent to server (≈12 fps)
  RECONNECT_DELAY: 2000,  // ms before reconnect attempt
};

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  // Camera
  stream: null,
  cameraRunning: false,
  frameTimer: null,

  // WebSocket
  wsGesture: null,
  wsAvatar: null,
  wsConnected: false,
  reconnectTimer: null,

  // Detection
  currentLang: 'en',
  avatarLang: 'en',
  history: [],
  lastGesture: null,
  lastSpoken: null,

  // Avatar animation
  avatarSequence: [],
  avatarIndex: 0,
  avatarTimer: null,
  avatarCanvas: null,
  avatarCtx: null,
};

// ── DOM References ─────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const video         = $('video');
const canvasOverlay = $('canvas-overlay');
const statusDot     = $('status-dot');
const statusText    = $('status-text');

// ── Init ───────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  initAvatarCanvas();
  connectWebSockets();
  drawAvatarIdle();
});

// ══════════════════════════════════════════════════════════════════════════
// WebSocket Management
// ══════════════════════════════════════════════════════════════════════════

function connectWebSockets() {
  connectGestureWS();
  connectAvatarWS();
}

function connectGestureWS() {
  try {
    state.wsGesture = new WebSocket(CONFIG.WS_GESTURE);

    state.wsGesture.onopen = () => {
      console.log('[WS] Gesture connected');
      setConnected(true);
      toast('✅ Сервер подключён', 'success');
    };

    state.wsGesture.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleGestureResult(data);
      } catch (e) { console.error('WS parse error', e); }
    };

    state.wsGesture.onclose = () => {
      console.log('[WS] Gesture disconnected');
      setConnected(false);
      scheduleReconnect();
    };

    state.wsGesture.onerror = (e) => {
      console.error('[WS] Gesture error', e);
      setConnected(false);
    };
  } catch (e) {
    console.error('[WS] Failed to connect:', e);
    setConnected(false);
    scheduleReconnect();
  }
}

function connectAvatarWS() {
  try {
    state.wsAvatar = new WebSocket(CONFIG.WS_AVATAR);
    state.wsAvatar.onopen = () => console.log('[WS] Avatar connected');
    state.wsAvatar.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleAvatarResponse(data);
      } catch (e) { console.error('Avatar WS parse error', e); }
    };
    state.wsAvatar.onclose = () => {
      setTimeout(connectAvatarWS, CONFIG.RECONNECT_DELAY * 2);
    };
  } catch (e) {
    console.error('[WS Avatar] Failed:', e);
  }
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => {
    console.log('[WS] Attempting reconnect...');
    statusText.textContent = 'Переподключение...';
    connectGestureWS();
  }, CONFIG.RECONNECT_DELAY);
}

function setConnected(connected) {
  state.wsConnected = connected;
  statusDot.className = 'status-dot ' + (connected ? 'connected' : 'error');
  statusText.textContent = connected ? 'Подключено' : 'Не подключено';
}

// ══════════════════════════════════════════════════════════════════════════
// Camera Management
// ══════════════════════════════════════════════════════════════════════════

async function startCamera() {
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false
    });

    video.srcObject = state.stream;
    video.classList.add('active');
    canvasOverlay.classList.add('active');

    $('camera-placeholder').style.display = 'none';
    $('live-badge').classList.remove('hidden');
    $('gesture-overlay').classList.add('active');
    $('btn-start-camera').classList.add('hidden');
    $('btn-stop-camera').classList.remove('hidden');
    $('btn-speak').disabled = false;
    $('btn-speak-gesture').disabled = false;

    state.cameraRunning = true;

    // Set canvas size to match video
    video.addEventListener('loadedmetadata', () => {
      canvasOverlay.width = video.videoWidth;
      canvasOverlay.height = video.videoHeight;
    });

    // Start sending frames
    state.frameTimer = setInterval(captureAndSendFrame, CONFIG.FRAME_INTERVAL);
    toast('📷 Камера запущена', 'info');

  } catch (err) {
    console.error('Camera error:', err);
    toast('❌ Ошибка камеры: ' + err.message, 'error');
  }
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
  }

  clearInterval(state.frameTimer);
  state.cameraRunning = false;

  video.srcObject = null;
  video.classList.remove('active');
  canvasOverlay.classList.remove('active');

  $('camera-placeholder').style.display = '';
  $('live-badge').classList.add('hidden');
  $('gesture-overlay').classList.remove('active');
  $('btn-start-camera').classList.remove('hidden');
  $('btn-stop-camera').classList.add('hidden');
  $('btn-speak').disabled = true;
  $('btn-speak-gesture').disabled = true;

  toast('⏹ Камера остановлена', 'info');
}

// ══════════════════════════════════════════════════════════════════════════
// Frame Capture & Send
// ══════════════════════════════════════════════════════════════════════════

function captureAndSendFrame() {
  if (!state.cameraRunning || !state.wsGesture ||
      state.wsGesture.readyState !== WebSocket.OPEN) return;

  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth  || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext('2d');

  // Mirror the image (video is already mirrored via CSS, but for server we need original)
  ctx.drawImage(video, 0, 0);

  canvas.toBlob(blob => {
    if (!blob) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      if (state.wsGesture.readyState === WebSocket.OPEN) {
        state.wsGesture.send(JSON.stringify({ type: 'frame', frame: base64 }));
      }
    };
    reader.readAsDataURL(blob);
  }, 'image/jpeg', 0.7);
}

// ══════════════════════════════════════════════════════════════════════════
// Handle Gesture Detection Results
// ══════════════════════════════════════════════════════════════════════════

function handleGestureResult(data) {
  if (!data || data.type === 'pong') return;

  const { gesture, confidence, type, translation, word, landmarks, annotated_frame } = data;

  // Draw annotated frame on overlay canvas
  if (annotated_frame) {
    drawAnnotatedFrame(annotated_frame);
  }

  // Update gesture display
  if (gesture && type !== 'none') {
    // Extract language specific translation
    let displayTranslation = translation;
    if (translation && translation.includes(' / ')) {
       const parts = translation.split(' / ').map(p => p.trim());
       if (state.currentLang === 'en') displayTranslation = parts[0];
       else if (state.currentLang === 'ru') displayTranslation = parts[1] || parts[0];
       else if (state.currentLang === 'uz') displayTranslation = parts[2] || parts[0];
    }

    // Big gesture display overlay
    $('detected-gesture').textContent = gesture;
    $('confidence-bar').style.width = (confidence * 100) + '%';

    // Result panel
    $('result-gesture').textContent = gesture;
    $('result-type').textContent = type === 'dynamic'
      ? `🌀 Динамический жест (${Math.round(confidence * 100)}%)`
      : `✋ Статический знак (${Math.round(confidence * 100)}%)`;

    $('result-translation').textContent = displayTranslation || gesture;

    // Add to history (avoid duplicates)
    if (gesture !== state.lastGesture && gesture !== 'UNKNOWN') {
      addToHistory(gesture, displayTranslation);
      state.lastGesture = gesture;
    }

    // Auto-speak dynamic gestures
    if (type === 'dynamic' && displayTranslation && displayTranslation !== state.lastSpoken) {
      speakText(displayTranslation, state.currentLang);
      state.lastSpoken = displayTranslation;
      setTimeout(() => { state.lastSpoken = null; }, 3000);
    }
  } else {
    $('detected-gesture').textContent = '—';
    $('confidence-bar').style.width = '0%';
  }

  // Update accumulated word
  if (word !== undefined) {
    $('word-display').textContent = word || '';
  }
}

function drawAnnotatedFrame(base64) {
  const ctx = canvasOverlay.getContext('2d');
  const img = new Image();
  img.onload = () => {
    ctx.clearRect(0, 0, canvasOverlay.width, canvasOverlay.height);
    // Draw mirrored (since server processes unmirrored but camera shows mirrored)
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(img, -canvasOverlay.width, 0, canvasOverlay.width, canvasOverlay.height);
    ctx.restore();
  };
  img.src = 'data:image/jpeg;base64,' + base64;
}

// ══════════════════════════════════════════════════════════════════════════
// History
// ══════════════════════════════════════════════════════════════════════════

function addToHistory(gesture, translation) {
  state.history.unshift({ gesture, translation, time: new Date() });
  if (state.history.length > 30) state.history.pop();
  renderHistory();
}

function renderHistory() {
  const list = $('history-list');
  if (state.history.length === 0) {
    list.innerHTML = '<div class="history-empty">История пуста</div>';
    return;
  }
  list.innerHTML = state.history.slice(0, 15).map(h =>
    `<div class="history-item" title="${h.translation}">${h.gesture}</div>`
  ).join('');
}

function clearHistory() {
  state.history = [];
  renderHistory();
}

// ══════════════════════════════════════════════════════════════════════════
// TTS
// ══════════════════════════════════════════════════════════════════════════

function speakWord() {
  const word = $('word-display').textContent.trim();
  if (!word) { toast('Нет слова для озвучивания', 'info'); return; }
  speakText(word, state.currentLang);
}

function speakCurrentGesture() {
  const translation = $('result-translation').textContent.trim();
  if (!translation || translation === '—') return;
  speakText(translation, state.currentLang);
}

async function speakText(text, lang) {
  if (!text) return;
  try {
    const res = await fetch(`${CONFIG.API_BASE}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, lang })
    });
    const data = await res.json();
    if (data.audio_base64) {
      const audio = new Audio('data:audio/mp3;base64,' + data.audio_base64);
      audio.play();
    }
  } catch (e) {
    console.error('TTS error:', e);
    // Fallback: browser TTS
    browserSpeak(text, lang);
  }
}

function browserSpeak(text, lang) {
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang === 'ru' ? 'ru-RU' : lang === 'uz' ? 'uz-UZ' : 'en-US';
  speechSynthesis.speak(utter);
}

// ══════════════════════════════════════════════════════════════════════════
// Avatar Canvas Drawing
// ══════════════════════════════════════════════════════════════════════════

function initAvatarCanvas() {
  state.avatarCanvas = $('avatar-canvas');
  state.avatarCtx = state.avatarCanvas.getContext('2d');
  state.avatarCanvas.width  = 400;
  state.avatarCanvas.height = 400;
}

// ── Sign drawings ──────────────────────────────────────────────────────
const SIGN_DRAWERS = {
  'wave':       drawWave,
  'thumbs_up':  drawThumbsUp,
  'thumbs_down':drawThumbsDown,
  'open_palm':  drawOpenPalm,
  'fist':       drawFist,
  'peace':      drawPeace,
  'point_up':   drawPointUp,
  'bow':        drawBow,
  'PAUSE':      drawPause,
  'DEFAULT':    drawDefaultLetter,
};

function clearCanvas(emotion = 'neutral') {
  const ctx = state.avatarCtx;
  const W = state.avatarCanvas.width;
  const H = state.avatarCanvas.height;
  ctx.clearRect(0, 0, W, H);

  // Background gradient
  const grad = ctx.createRadialGradient(W/2, H/2, 0, W/2, H/2, W/2);
  grad.addColorStop(0, 'rgba(13, 18, 32, 0.95)');
  grad.addColorStop(1, 'rgba(5, 8, 20, 0.99)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // ── Draw Cybernetic Body Silhouette ──
  ctx.save();
  ctx.translate(W/2, H/2);
  
  // Torso
  ctx.beginPath();
  ctx.moveTo(-70, 180);
  ctx.lineTo(-40, 60);
  ctx.lineTo(40, 60);
  ctx.lineTo(70, 180);
  ctx.fillStyle = 'rgba(0, 212, 255, 0.03)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 212, 255, 0.15)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Head
  ctx.beginPath();
  ctx.arc(0, -10, 45, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 212, 255, 0.05)';
  ctx.fill();
  ctx.stroke();

  // Eyes (Emotions)
  ctx.fillStyle = 'rgba(0, 212, 255, 0.8)';
  ctx.shadowColor = '#00d4ff';
  ctx.shadowBlur = 10;
  
  if (emotion === 'happy') {
    // Happy eyes ^ ^
    ctx.beginPath(); ctx.arc(-15, -20, 6, Math.PI, 0); ctx.stroke();
    ctx.beginPath(); ctx.arc(15, -20, 6, Math.PI, 0); ctx.stroke();
    // Smile
    ctx.beginPath(); ctx.arc(0, 5, 15, 0, Math.PI); ctx.stroke();
  } else if (emotion === 'sad') {
    // Sad eyes
    ctx.beginPath(); ctx.ellipse(-15, -15, 5, 2, 0.2, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(15, -15, 5, 2, -0.2, 0, Math.PI*2); ctx.fill();
    // Frown
    ctx.beginPath(); ctx.arc(0, 15, 12, Math.PI, Math.PI*2); ctx.stroke();
  } else if (emotion === 'angry') {
    // Angry eyes
    ctx.beginPath(); ctx.moveTo(-25, -25); ctx.lineTo(-10, -15); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(25, -25); ctx.lineTo(10, -15); ctx.stroke();
    ctx.beginPath(); ctx.arc(-15, -15, 4, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(15, -15, 4, 0, Math.PI*2); ctx.fill();
    // Straight mouth
    ctx.beginPath(); ctx.moveTo(-10, 10); ctx.lineTo(10, 10); ctx.stroke();
  } else {
    // Neutral eyes
    ctx.beginPath(); ctx.ellipse(-15, -15, 4, 6, 0, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(15, -15, 4, 6, 0, 0, Math.PI*2); ctx.fill();
    // Neutral mouth
    ctx.beginPath(); ctx.moveTo(-8, 8); ctx.lineTo(8, 8); ctx.stroke();
  }

  // Neck core
  ctx.beginPath();
  ctx.moveTo(-10, 35); ctx.lineTo(10, 35);
  ctx.lineTo(15, 60); ctx.lineTo(-15, 60);
  ctx.fillStyle = 'rgba(0, 212, 255, 0.2)';
  ctx.fill();

  ctx.restore();
}

function drawHand(ctx, cx, cy, scale, color = '#00d4ff') {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);

  // Palm
  ctx.beginPath();
  ctx.ellipse(0, 20, 45, 55, 0, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.15;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.restore();
}

function drawFinger(ctx, x1, y1, x2, y2, color = '#00d4ff') {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 12;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Fingertip
  ctx.beginPath();
  ctx.arc(x2, y2, 7, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function drawArm(ctx, cx, cy, scale, color = '#00d4ff') {
  // Wrist / forearm
  ctx.beginPath();
  ctx.moveTo(cx - 30 * scale, cy + 60 * scale);
  ctx.lineTo(cx + 30 * scale, cy + 60 * scale);
  ctx.lineTo(cx + 25 * scale, cy + 120 * scale);
  ctx.lineTo(cx - 25 * scale, cy + 120 * scale);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0, 212, 255, 0.1)';
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawGlow(ctx, cx, cy, r, color) {
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  grad.addColorStop(0, color.replace(')', ', 0.3)').replace('rgb', 'rgba'));
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawLabel(ctx, text, cx, cy) {
  ctx.font = 'bold 18px Space Grotesk, Inter, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.textAlign = 'center';
  ctx.fillText(text, cx, cy);
}

// ── Individual sign drawings ───────────────────────────────────────────
function drawWave(ctx, W, H, t) {
  clearCanvas('happy');
  const cx = W / 2;
  const cy = H / 2 - 20;
  const swing = Math.sin(t * 0.006) * 30;

  ctx.save();
  ctx.translate(cx + swing, cy);

  drawGlow(ctx, 0, 0, 120, 'rgb(0, 212, 255)');

  // Palm
  ctx.beginPath();
  ctx.ellipse(0, 30, 40, 50, 0.2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 212, 255, 0.12)';
  ctx.fill();
  ctx.strokeStyle = '#00d4ff';
  ctx.lineWidth = 3;
  ctx.stroke();

  // 4 fingers
  const fingers = [
    {x: -30, wave: 0.2}, {x: -10, wave: 0.4},
    {x: 10, wave: 0.6},  {x: 30, wave: 0.8}
  ];
  fingers.forEach(f => {
    const bend = Math.sin(t * 0.008 + f.wave * Math.PI) * 15;
    drawFinger(ctx, f.x, -10, f.x + bend * 0.3, -70);
  });

  // Thumb
  drawFinger(ctx, -40, 20, -70, -10);

  drawArm(ctx, 0, 30, 1, '#00d4ff');
  ctx.restore();

  drawLabel(ctx, '👋 Привет / Salom', cx, H - 20);
}

function drawThumbsUp(ctx, W, H, t) {
  clearCanvas('happy');
  const cx = W / 2;
  const cy = H / 2 + 20;
  const pulse = 1 + Math.sin(t * 0.005) * 0.05;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(pulse, pulse);

  drawGlow(ctx, 0, 0, 120, 'rgb(16, 185, 129)');

  // Fist
  ctx.beginPath();
  ctx.ellipse(0, 10, 40, 45, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(16, 185, 129, 0.15)';
  ctx.fill();
  ctx.strokeStyle = '#10b981';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Thumb up
  ctx.beginPath();
  ctx.moveTo(-15, -20);
  ctx.lineTo(-30, -80);
  ctx.strokeStyle = '#10b981';
  ctx.lineWidth = 14;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-30, -80, 8, 0, Math.PI * 2);
  ctx.fillStyle = '#10b981';
  ctx.fill();

  drawArm(ctx, 0, 30, 1, '#10b981');
  ctx.restore();

  drawLabel(ctx, '👍 Хорошо / Yaxshi', cx, H - 20);
}

function drawThumbsDown(ctx, W, H, t) {
  clearCanvas('sad');
  const cx = W / 2;
  const cy = H / 2 - 20;

  ctx.save();
  ctx.translate(cx, cy);

  drawGlow(ctx, 0, 0, 120, 'rgb(239, 68, 68)');

  ctx.beginPath();
  ctx.ellipse(0, -10, 40, 45, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(239, 68, 68, 0.15)';
  ctx.fill();
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Thumb down
  ctx.beginPath();
  ctx.moveTo(-15, 20);
  ctx.lineTo(-30, 80);
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 14;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-30, 80, 8, 0, Math.PI * 2);
  ctx.fillStyle = '#ef4444';
  ctx.fill();

  ctx.restore();
  drawLabel(ctx, '👎 Плохо / Yomon', cx, H - 20);
}

function drawOpenPalm(ctx, W, H, t) {
  clearCanvas();
  const cx = W / 2;
  const cy = H / 2 + 20;
  const spread = 1 + Math.sin(t * 0.004) * 0.03;

  ctx.save();
  ctx.translate(cx, cy);

  drawGlow(ctx, 0, 0, 140, 'rgb(245, 158, 11)');

  // Palm
  ctx.beginPath();
  ctx.ellipse(0, 20, 45, 55, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(245, 158, 11, 0.12)';
  ctx.fill();
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 3;
  ctx.stroke();

  // 5 fingers spread
  const fingers5 = [
    {bx: -50, by: 0, tx: -60, ty: -60},
    {bx: -25, by: -15, tx: -28, ty: -85},
    {bx: 0,   by: -20, tx: 0,   ty: -90},
    {bx: 25,  by: -15, tx: 28,  ty: -85},
    {bx: 50,  by: 0,   tx: 60,  ty: -55},
  ];

  fingers5.forEach(f => {
    ctx.save();
    ctx.scale(spread, spread);
    drawFinger(ctx, f.bx, f.by, f.tx, f.ty, '#f59e0b');
    ctx.restore();
  });

  drawArm(ctx, 0, 40, 1, '#f59e0b');
  ctx.restore();
  drawLabel(ctx, '✋ Стоп / To\'xta', cx, H - 20);
}

function drawFist(ctx, W, H, t) {
  clearCanvas('angry');
  const cx = W / 2;
  const cy = H / 2;
  const shake = Math.sin(t * 0.01) * 5;

  ctx.save();
  ctx.translate(cx + shake, cy);

  drawGlow(ctx, 0, 0, 110, 'rgb(139, 92, 246)');

  // Fist
  ctx.beginPath();
  ctx.ellipse(0, 0, 50, 55, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(139, 92, 246, 0.15)';
  ctx.fill();
  ctx.strokeStyle = '#8b5cf6';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Knuckles
  [-30, -10, 10, 30].forEach(x => {
    ctx.beginPath();
    ctx.arc(x, -25, 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(139, 92, 246, 0.4)';
    ctx.fill();
    ctx.strokeStyle = '#8b5cf6';
    ctx.lineWidth = 2;
    ctx.stroke();
  });

  drawArm(ctx, 0, 30, 1, '#8b5cf6');
  ctx.restore();
  drawLabel(ctx, '✊ Нет / Yo\'q', cx, H - 20);
}

function drawPeace(ctx, W, H, t) {
  clearCanvas();
  const cx = W / 2;
  const cy = H / 2 + 20;
  const glow = 0.5 + Math.sin(t * 0.005) * 0.5;

  ctx.save();
  ctx.translate(cx, cy);

  ctx.shadowColor = '#ec4899';
  ctx.shadowBlur = 20 * glow;

  drawGlow(ctx, 0, 0, 120, 'rgb(236, 72, 153)');

  // Palm base
  ctx.beginPath();
  ctx.ellipse(0, 20, 38, 48, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(236, 72, 153, 0.12)';
  ctx.fill();
  ctx.strokeStyle = '#ec4899';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Index finger up
  drawFinger(ctx, -15, -10, -18, -80, '#ec4899');
  // Middle finger up
  drawFinger(ctx, 15, -10, 18, -80, '#ec4899');
  // Ring + pinky closed
  drawFinger(ctx, 30, 0, 30, -15, '#ec4899');
  drawFinger(ctx, 45, 5, 45, -10, '#ec4899');
  // Thumb
  drawFinger(ctx, -38, 20, -60, -5, '#ec4899');

  drawArm(ctx, 0, 35, 1, '#ec4899');
  ctx.restore();
  drawLabel(ctx, '✌️ Мир / Tinchlik', cx, H - 20);
}

function drawPointUp(ctx, W, H, t) {
  clearCanvas();
  const cx = W / 2;
  const cy = H / 2 + 30;

  ctx.save();
  ctx.translate(cx, cy);

  drawGlow(ctx, 0, 0, 110, 'rgb(0, 212, 255)');

  // Palm
  ctx.beginPath();
  ctx.ellipse(0, 15, 35, 45, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 212, 255, 0.1)';
  ctx.fill();
  ctx.strokeStyle = '#00d4ff';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Index pointing up
  drawFinger(ctx, -10, -10, -12, -85, '#00d4ff');

  // Other fingers closed
  drawFinger(ctx, 10, -5, 12, -20, '#00d4ff');
  drawFinger(ctx, 25, 0, 27, -12, '#00d4ff');
  drawFinger(ctx, 38, 5, 39, -5, '#00d4ff');
  drawFinger(ctx, -35, 15, -50, 0, '#00d4ff');

  // Pointing arrow
  ctx.beginPath();
  ctx.moveTo(-12, -85);
  ctx.lineTo(-25, -70);
  ctx.moveTo(-12, -85);
  ctx.lineTo(0, -70);
  ctx.strokeStyle = 'rgba(0, 212, 255, 0.5)';
  ctx.lineWidth = 2;
  ctx.stroke();

  drawArm(ctx, 0, 30, 1, '#00d4ff');
  ctx.restore();
  drawLabel(ctx, '☝️ Да / Ha', cx, H - 20);
}

function drawBow(ctx, W, H) {
  clearCanvas();
  const cx = W / 2;
  const cy = H / 2;

  ctx.save();
  ctx.translate(cx, cy);

  // Simple person silhouette bowing
  ctx.beginPath();
  ctx.arc(0, -80, 30, 0, Math.PI * 2);
  ctx.strokeStyle = '#10b981';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Bowing body
  ctx.beginPath();
  ctx.moveTo(0, -50);
  ctx.bezierCurveTo(-20, 0, -40, 40, -60, 70);
  ctx.strokeStyle = '#10b981';
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.stroke();

  ctx.restore();
  drawLabel(ctx, '🙏 Спасибо / Rahmat', cx, H - 20);
}

function drawPause(ctx, W, H) {
  clearCanvas();
  const cx = W / 2, cy = H / 2;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath();
  ctx.arc(0, 0, 40, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fillRect(-15, -20, 10, 40);
  ctx.fillRect(5, -20, 10, 40);
  ctx.restore();
}

function drawDefaultLetter(ctx, W, H, t, letter) {
  clearCanvas();
  const cx = W / 2, cy = H / 2;
  const scale = 1 + Math.sin(t * 0.005) * 0.03;

  // Large letter fingerprint
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);

  drawGlow(ctx, 0, 0, 130, 'rgb(139, 92, 246)');

  ctx.font = 'bold 140px Space Grotesk, Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(139, 92, 246, 0.15)';
  ctx.fillText(letter || '?', 0, 0);

  ctx.strokeStyle = 'rgba(139, 92, 246, 0.6)';
  ctx.lineWidth = 2;
  ctx.strokeText(letter || '?', 0, 0);

  ctx.restore();

  ctx.font = 'bold 16px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillText('ASL: ' + (letter || '?'), cx, H - 20);
}

function drawAvatarIdle() {
  const canvas = state.avatarCanvas;
  if (!canvas) return;
  const ctx = state.avatarCtx;
  const W = canvas.width, H = canvas.height;
  clearCanvas();

  const t = Date.now();
  const pulse = 0.5 + Math.sin(t * 0.002) * 0.5;

  ctx.save();
  ctx.translate(W / 2, H / 2);

  // Pulsing ring
  ctx.beginPath();
  ctx.arc(0, 0, 80 + pulse * 20, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(0, 212, 255, ${0.1 + pulse * 0.15})`;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.font = '80px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const bounce = Math.sin(t * 0.003) * 8;
  ctx.fillText('🤟', 0, bounce);

  ctx.restore();

  if (!state.avatarTimer) {
    requestAnimationFrame(drawAvatarIdle);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Avatar: Text → Sign Animation
// ══════════════════════════════════════════════════════════════════════════

function sendToAvatar() {
  const text = $('avatar-input').value.trim();
  if (!text) { toast('Введите текст', 'info'); return; }

  if (state.wsAvatar && state.wsAvatar.readyState === WebSocket.OPEN) {
    state.wsAvatar.send(JSON.stringify({ text, lang: state.avatarLang }));
    $('avatar-status').textContent = 'Генерация...';
  } else {
    // Fallback: call REST API
    fetch(`${CONFIG.API_BASE}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, lang: state.avatarLang })
    })
    .then(r => r.json())
    .then(data => startAvatarAnimation(data.sequence, null))
    .catch(e => toast('Ошибка: сервер недоступен', 'error'));
  }
}

function handleAvatarResponse(data) {
  if (data.type !== 'animation') return;

  $('avatar-status').textContent = 'Анимация...';
  $('avatar-idle').style.display = 'none';

  // Play TTS audio
  if (data.audio_base64) {
    const audio = $('tts-audio');
    audio.src = 'data:audio/mp3;base64,' + data.audio_base64;
    $('audio-player').style.display = 'block';
    audio.play().catch(() => {});
  }

  startAvatarAnimation(data.sequence, data.text);
}

function startAvatarAnimation(sequence, text) {
  // Clear previous
  clearTimeout(state.avatarTimer);
  state.avatarSequence = sequence || [];
  state.avatarIndex = 0;

  // Render sequence chips
  renderSequenceChips(sequence);

  // Start animation loop
  animateNextSign();
}

function animateNextSign() {
  if (state.avatarIndex >= state.avatarSequence.length) {
    $('avatar-status').textContent = 'Готов';
    // Return to idle animation
    state.avatarTimer = null;
    requestAnimationFrame(drawAvatarIdle);
    return;
  }

  const sign = state.avatarSequence[state.avatarIndex];
  updateSeqChips(state.avatarIndex);

  // Update info
  $('current-sign').textContent = sign.gesture;
  $('sign-label').textContent = sign.type === 'letter' ? 'Буква' :
                                 sign.type === 'gesture' ? 'Жест' : 'Пауза';

  // Animate the sign for its duration
  const startTime = Date.now();
  const duration = sign.duration * 1000;

  function animFrame() {
    const t = Date.now() - startTime;
    const canvas = state.avatarCanvas;
    const ctx = state.avatarCtx;
    const W = canvas.width, H = canvas.height;
    const frameT = Date.now();

    // Draw appropriate sign
    const drawer = SIGN_DRAWERS[sign.gesture] || SIGN_DRAWERS['DEFAULT'];
    if (sign.gesture === 'DEFAULT' || !SIGN_DRAWERS[sign.gesture]) {
      drawDefaultLetter(ctx, W, H, frameT, sign.gesture);
    } else {
      drawer(ctx, W, H, frameT);
    }

    if (t < duration) {
      state.avatarTimer = requestAnimationFrame(animFrame);
    } else {
      state.avatarIndex++;
      animateNextSign();
    }
  }

  state.avatarTimer = requestAnimationFrame(animFrame);
}

function renderSequenceChips(sequence) {
  const container = $('seq-chips');
  if (!sequence || sequence.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = sequence.map((s, i) =>
    `<div class="seq-chip" id="seq-chip-${i}" title="${s.label}">${s.gesture}</div>`
  ).join('');
}

function updateSeqChips(activeIndex) {
  document.querySelectorAll('.seq-chip').forEach((chip, i) => {
    chip.className = 'seq-chip' +
      (i === activeIndex ? ' active' : i < activeIndex ? ' done' : '');
  });
}

// ══════════════════════════════════════════════════════════════════════════
// Controls & Helpers
// ══════════════════════════════════════════════════════════════════════════

function clearWord() {
  if (state.wsGesture && state.wsGesture.readyState === WebSocket.OPEN) {
    state.wsGesture.send(JSON.stringify({ type: 'clear' }));
  }
  $('word-display').textContent = '';
  toast('🗑 Слово очищено', 'info');
}

function setLang(lang) {
  state.currentLang = lang;
  document.querySelectorAll('#tab-detect .lang-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.lang === lang);
  });
}

function setAvatarLang(lang) {
  state.avatarLang = lang;
  document.querySelectorAll('#tab-avatar .lang-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.lang === lang);
  });
}

function setPhrase(text) {
  $('avatar-input').value = text;
}

function switchTab(tabName) {
  document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  $(`tab-${tabName}`).classList.add('active');
  document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
}

// ── Toast notifications ──────────────────────────────────────────────
function toast(message, type = 'info') {
  const container = $('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ══════════════════════════════════════════════════════════════════════════
// Speech-to-Text (Voice Input)
// ══════════════════════════════════════════════════════════════════════════

let recognition = null;
let isRecording = false;

function initSpeechRecognition() {
  window.SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!window.SpeechRecognition) {
    console.warn("Speech Recognition API not supported in this browser.");
    return false;
  }
  recognition = new window.SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = false;

  recognition.onresult = (event) => {
    const text = event.results[0][0].transcript;
    $('avatar-input').value = text;
    toast('Речь распознана: ' + text, 'info');
    toggleMic(true); // Stop recording UI
  };

  recognition.onerror = (event) => {
    console.error('Speech recognition error', event.error);
    toast('Ошибка распознавания: ' + event.error, 'error');
    toggleMic(true); // Stop recording UI
  };
  
  recognition.onend = () => {
    if (isRecording) {
      toggleMic(true); // Stop recording UI if it ended unexpectedly
    }
  };

  return true;
}

function toggleMic(forceStop = false) {
  const btn = $('btn-mic');
  
  if (!recognition && !initSpeechRecognition()) {
    toast('Ваш браузер не поддерживает голосовой ввод', 'error');
    return;
  }

  if (isRecording || forceStop) {
    // Stop recording
    recognition.stop();
    isRecording = false;
    btn.classList.remove('recording');
    btn.title = "Голосовой ввод";
  } else {
    // Start recording
    // Set language based on selected pill
    let langMap = { 'en': 'en-US', 'ru': 'ru-RU', 'uz': 'uz-UZ' };
    recognition.lang = langMap[state.avatarLang] || 'en-US';
    
    try {
      recognition.start();
      isRecording = true;
      btn.classList.add('recording');
      btn.title = "Остановить запись";
      toast('Говорите...', 'info');
    } catch (e) {
      console.error(e);
      toast('Не удалось запустить микрофон', 'error');
    }
  }
}
