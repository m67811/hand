/**
 * SignBridge - Frontend Application
 * WebSocket client for real-time gesture detection + Avatar TTS animation
 */

'use strict';

// ── Configuration ──────────────────────────────────────────────────────────
const isServedOverHttp = window.location.protocol === 'http:' || window.location.protocol === 'https:';
const serverOrigin = isServedOverHttp ? window.location.origin : 'http://localhost:8000';
const websocketOrigin = serverOrigin.replace(/^http/, 'ws');

const CONFIG = {
  WS_GESTURE: `${websocketOrigin}/ws/gesture`,
  WS_AVATAR:  `${websocketOrigin}/ws/avatar`,
  API_BASE:   `${serverOrigin}/api/v1`,
  FRAME_INTERVAL: 80,     // ms between frames sent to server (≈12 fps)
  RECONNECT_DELAY: 2000,  // ms before reconnect attempt
  MAX_CAPTURE_WIDTH: 640,
  MAX_CAPTURE_HEIGHT: 480,
  CLIENT_TRACKER_INTERVAL: 66,
  MEDIAPIPE_VISION_MODULE: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs',
  MEDIAPIPE_VISION_WASM: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm',
};

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  // Camera
  stream: null,
  cameraRunning: false,
  frameTimer: null,
  frameTimeout: null,
  frameInFlight: false,
  captureCanvas: null,
  handLandmarker: null,
  handTrackerLoading: false,
  handTrackerActive: false,
  handTrackerFrame: null,
  handTrackerLastTime: 0,
  handTrackerLastVideoTime: -1,
  activeTab: 'detect',
  isClosing: false,

  // WebSocket
  wsGesture: null,
  wsAvatar: null,
  wsConnected: false,
  reconnectTimer: null,
  avatarReconnectTimer: null,

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
  avatarIdleTimer: null,
  avatarAnimating: false,
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
  initializeTabs();
  connectWebSockets();
  drawAvatarIdle();
  registerServiceWorker();
});

window.addEventListener('beforeunload', () => {
  state.isClosing = true;
  clearInterval(state.frameTimer);
  clearTimeout(state.frameTimeout);
  cancelAnimationFrame(state.handTrackerFrame);
  state.handLandmarker?.close();
  clearTimeout(state.reconnectTimer);
  clearTimeout(state.avatarReconnectTimer);
  if (state.stream) state.stream.getTracks().forEach(track => track.stop());
  state.wsGesture?.close();
  state.wsAvatar?.close();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearInterval(state.frameTimer);
    state.frameTimer = null;
  } else if (state.cameraRunning && state.activeTab === 'detect' && !state.frameTimer) {
    state.frameTimer = setInterval(captureAndSendFrame, CONFIG.FRAME_INTERVAL);
  }
});

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !isServedOverHttp) return;
  try {
    await navigator.serviceWorker.register('/service-worker.js');
  } catch (error) {
    console.warn('Service worker registration failed:', error);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// WebSocket Management
// ══════════════════════════════════════════════════════════════════════════

function connectWebSockets() {
  connectGestureWS();
  connectAvatarWS();
}

function connectGestureWS() {
  if (state.wsGesture && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.wsGesture.readyState)) return;

  try {
    state.wsGesture = new WebSocket(CONFIG.WS_GESTURE);

    state.wsGesture.onopen = () => {
      console.log('[WS] Gesture connected');
      clearTimeout(state.reconnectTimer);
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
      clearTimeout(state.frameTimeout);
      state.frameInFlight = false;
      setConnected(false);
      if (!state.isClosing) scheduleReconnect();
    };

    state.wsGesture.onerror = (e) => {
      console.error('[WS] Gesture error', e);
      clearTimeout(state.frameTimeout);
      state.frameInFlight = false;
      setConnected(false);
    };
  } catch (e) {
    console.error('[WS] Failed to connect:', e);
    setConnected(false);
    scheduleReconnect();
  }
}

function connectAvatarWS() {
  if (state.wsAvatar && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.wsAvatar.readyState)) return;

  try {
    state.wsAvatar = new WebSocket(CONFIG.WS_AVATAR);
    state.wsAvatar.onopen = () => {
      clearTimeout(state.avatarReconnectTimer);
      console.log('[WS] Avatar connected');
    };
    state.wsAvatar.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleAvatarResponse(data);
      } catch (e) { console.error('Avatar WS parse error', e); }
    };
    state.wsAvatar.onclose = () => {
      if (!state.isClosing) scheduleAvatarReconnect();
    };
    state.wsAvatar.onerror = error => console.error('[WS Avatar] Error:', error);
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
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera API is not supported by this browser.');
    }

    if (state.cameraRunning) stopCamera();
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: CONFIG.MAX_CAPTURE_WIDTH, max: CONFIG.MAX_CAPTURE_WIDTH },
        height: { ideal: CONFIG.MAX_CAPTURE_HEIGHT, max: CONFIG.MAX_CAPTURE_HEIGHT },
      },
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
    void startClientHandTracking();

    // Set canvas size to match video
    video.onloadedmetadata = () => {
      canvasOverlay.width = video.videoWidth;
      canvasOverlay.height = video.videoHeight;
    };

    // Start sending frames
    if (!document.hidden && state.activeTab === 'detect') {
      state.frameTimer = setInterval(captureAndSendFrame, CONFIG.FRAME_INTERVAL);
    }
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
  clearTimeout(state.frameTimeout);
  stopClientHandTracking();
  state.frameTimer = null;
  state.frameTimeout = null;
  state.frameInFlight = false;
  if (canvasOverlay.getContext) {
    const ctx = canvasOverlay.getContext('2d');
    ctx?.clearRect(0, 0, canvasOverlay.width, canvasOverlay.height);
  }
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
  if (!state.cameraRunning || state.activeTab !== 'detect' || !state.wsGesture ||
      state.wsGesture.readyState !== WebSocket.OPEN || state.frameInFlight || document.hidden) return;

  const canvas = state.captureCanvas || document.createElement('canvas');
  state.captureCanvas = canvas;
  const sourceWidth = video.videoWidth || 640;
  const sourceHeight = video.videoHeight || 480;
  const scale = Math.min(1, CONFIG.MAX_CAPTURE_WIDTH / sourceWidth, CONFIG.MAX_CAPTURE_HEIGHT / sourceHeight);
  canvas.width = Math.round(sourceWidth * scale);
  canvas.height = Math.round(sourceHeight * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  state.frameInFlight = true;
  clearTimeout(state.frameTimeout);
  state.frameTimeout = setTimeout(() => {
    state.frameInFlight = false;
    state.frameTimeout = null;
  }, 2000);

  canvas.toBlob(blob => {
    if (!blob) {
      state.frameInFlight = false;
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = typeof reader.result === 'string' ? reader.result.split(',')[1] : null;
      if (base64 && state.wsGesture?.readyState === WebSocket.OPEN) {
        try {
          state.wsGesture.send(JSON.stringify({ type: 'frame', frame: base64, annotate: false }));
        } catch (error) {
          console.error('Frame send failed:', error);
          state.frameInFlight = false;
        }
      } else {
        state.frameInFlight = false;
      }
    };
    reader.onerror = () => { state.frameInFlight = false; };
    reader.readAsDataURL(blob);
  }, 'image/jpeg', 0.72);
}

// ══════════════════════════════════════════════════════════════════════════
// Handle Gesture Detection Results
// ══════════════════════════════════════════════════════════════════════════

function handleGestureResult(data) {
  if (!data || data.type === 'pong') return;
  clearTimeout(state.frameTimeout);
  state.frameTimeout = null;
  state.frameInFlight = false;
  if (data.type === 'error') {
    toast(data.message || 'Gesture processing error', 'error');
    return;
  }

  const {
    gesture,
    confidence,
    gesture_type,
    type: messageType,
    translation,
    word,
    hand_landmarks: handLandmarks,
    annotated_frame: annotatedFrame,
  } = data;
  const type = gesture_type || (messageType === 'gesture_result' ? 'none' : messageType);
  const confidenceValue = Number.isFinite(confidence) ? confidence : 0;

  // Draw annotated frame on overlay canvas
  if (!state.handTrackerActive && Array.isArray(handLandmarks)) {
    drawHandLandmarks(handLandmarks);
  } else if (!state.handTrackerActive && annotatedFrame) {
    drawAnnotatedFrame(annotatedFrame);
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
    $('confidence-bar').style.width = (confidenceValue * 100) + '%';

    // Result panel
    $('result-gesture').textContent = gesture;
    $('result-type').textContent = type === 'dynamic'
      ? `🌀 Динамический жест (${Math.round(confidenceValue * 100)}%)`
      : `✋ Статический знак (${Math.round(confidenceValue * 100)}%)`;

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
    $('detected-gesture').textContent = '-';
    $('confidence-bar').style.width = '0%';
  }

  // Update accumulated word
  if (word !== undefined) {
    $('word-display').textContent = word || '';
  }
}

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

async function startClientHandTracking() {
  if (state.handTrackerActive) {
    scheduleClientHandTracking();
    return;
  }
  if (state.handTrackerLoading) return;
  if (state.handLandmarker) {
    state.handTrackerActive = true;
    scheduleClientHandTracking();
    return;
  }

  state.handTrackerLoading = true;
  try {
    const { FilesetResolver, HandLandmarker } = await import(CONFIG.MEDIAPIPE_VISION_MODULE);
    const vision = await FilesetResolver.forVisionTasks(CONFIG.MEDIAPIPE_VISION_WASM);
    state.handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: `${serverOrigin}/models/hand_landmarker.task` },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    state.handTrackerActive = true;
    scheduleClientHandTracking();
  } catch (error) {
    console.warn('Client hand tracking is unavailable; using server overlay.', error);
  } finally {
    state.handTrackerLoading = false;
  }
}

function stopClientHandTracking() {
  cancelAnimationFrame(state.handTrackerFrame);
  state.handTrackerFrame = null;
  state.handTrackerActive = false;
  state.handTrackerLastVideoTime = -1;
}

function scheduleClientHandTracking() {
  if (!state.handTrackerActive || !state.cameraRunning || state.handTrackerFrame !== null) return;
  state.handTrackerFrame = requestAnimationFrame(trackHandInCurrentVideoFrame);
}

function trackHandInCurrentVideoFrame(timestamp) {
  state.handTrackerFrame = null;
  if (!state.handTrackerActive || !state.cameraRunning || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

  if (timestamp - state.handTrackerLastTime >= CONFIG.CLIENT_TRACKER_INTERVAL &&
      video.currentTime !== state.handTrackerLastVideoTime) {
    try {
      const result = state.handLandmarker.detectForVideo(video, timestamp);
      state.handTrackerLastTime = timestamp;
      state.handTrackerLastVideoTime = video.currentTime;
      drawHandLandmarks(result.landmarks || []);
    } catch (error) {
      console.warn('Client hand tracking failed; using server overlay.', error);
      state.handTrackerActive = false;
    }
  }
  scheduleClientHandTracking();
}

function drawHandLandmarks(hands) {
  const ctx = canvasOverlay.getContext('2d');
  if (!ctx) return;

  const width = canvasOverlay.width;
  const height = canvasOverlay.height;
  ctx.clearRect(0, 0, width, height);
  if (!hands.length) return;

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#00dcff';
  ctx.fillStyle = '#9d5cff';
  ctx.lineWidth = Math.max(2, width / 360);

  hands.forEach(hand => {
    if (!Array.isArray(hand) || hand.length < 21) return;
    const points = hand.map(point => {
      const x = Array.isArray(point) ? point[0] : point?.x;
      const y = Array.isArray(point) ? point[1] : point?.y;
      return Number.isFinite(x) && Number.isFinite(y) ? [(1 - x) * width, y * height] : null;
    });

    ctx.beginPath();
    HAND_CONNECTIONS.forEach(([from, to]) => {
      const start = points[from];
      const end = points[to];
      if (!start || !end) return;
      ctx.moveTo(start[0], start[1]);
      ctx.lineTo(end[0], end[1]);
    });
    ctx.stroke();

    points.forEach(point => {
      if (!point) return;
      const [x, y] = point;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(3, width / 180), 0, Math.PI * 2);
      ctx.fill();
    });
  });
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
  list.replaceChildren();
  if (state.history.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'История пуста';
    list.appendChild(empty);
    return;
  }
  state.history.slice(0, 15).forEach(item => {
    const historyItem = document.createElement('div');
    historyItem.className = 'history-item';
    historyItem.title = item.translation;
    historyItem.textContent = item.gesture;
    list.appendChild(historyItem);
  });
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
  if (!translation || translation === '-') return;
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
    const data = await readApiResponse(res);
    if (!data.audio_base64) throw new Error('Server did not return audio.');
    const audio = new Audio('data:audio/mp3;base64,' + data.audio_base64);
    await audio.play();
  } catch (e) {
    console.error('TTS error:', e);
    toast('Серверное озвучивание недоступно, используется голос браузера', 'info');
    browserSpeak(text, lang);
  }
}

function browserSpeak(text, lang) {
  if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
    toast('Озвучивание не поддерживается этим браузером', 'error');
    return;
  }
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
// Every supported word is rendered by the articulated avatar below.  Keeping
// the sign name here (rather than falling back to a large letter) makes the
// sequence usable even for newly added vocabulary.
const AVATAR_GESTURES = [
  'wave', 'goodbye', 'please', 'thank_you', 'sorry', 'yes', 'no', 'good', 'bad', 'stop', 'wait',
  'me', 'you', 'name', 'friend', 'mother', 'father', 'family', 'understand', 'again', 'slow',
  'want', 'need', 'help', 'water', 'drink', 'food', 'eat', 'home', 'school', 'work', 'money', 'phone',
  'who', 'what', 'where', 'when', 'how', 'why', 'today', 'tomorrow', 'morning', 'night', 'left', 'right',
  'doctor', 'hospital', 'pain', 'emergency', 'bathroom', 'love', 'peace', 'happy', 'sad',
  // Legacy names are retained so API clients from an older frontend still work.
  'thumbs_up', 'thumbs_down', 'open_palm', 'fist', 'point_up', 'bow', 'I-LOVE-YOU'
];
const SIGN_DRAWERS = {
  ...Object.fromEntries(AVATAR_GESTURES.map(gesture => [gesture,
    (ctx, W, H, t) => drawSignAvatar(ctx, W, H, t, gesture)])),
  'PAUSE': drawPause,
  'DEFAULT': drawDefaultLetter,
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

// ── Articulated signing avatar ─────────────────────────────────────────
// Coordinates are deliberately stored as poses: it makes adding vocabulary a
// data change and, unlike the former icon-like drawings, always shows a body,
// elbows, wrists and two independently shaped hands.
const SIGN_POSES = {
  wave:       { r:[302,126, 'open'],  l:[108,265, 'flat'], emotion:'happy', motion:'wave', label:'Приветствие' },
  goodbye:    { r:[300,132, 'open'],  l:[108,265, 'flat'], emotion:'happy', motion:'wave', label:'До свидания' },
  please:     { r:[245,276, 'flat'],  l:[155,276, 'flat'], label:'Пожалуйста' },
  thank_you:  { r:[230,174, 'flat'],  l:[125,262, 'flat'], emotion:'happy', motion:'out', label:'Спасибо' },
  sorry:      { r:[236,250, 'fist'],  l:[162,270, 'flat'], emotion:'sad', motion:'circle', label:'Извините' },
  yes:        { r:[255,210, 'fist'],  l:[130,275, 'flat'], motion:'nod', label:'Да' },
  no:         { r:[240,204, 'point'], l:[160,204, 'point'], emotion:'sad', motion:'side', label:'Нет' },
  good:       { r:[270,230, 'thumb'], l:[125,270, 'flat'], emotion:'happy', label:'Хорошо' },
  bad:        { r:[270,258, 'thumb'], l:[125,270, 'flat'], emotion:'sad', label:'Плохо' },
  stop:       { r:[270,205, 'open'],  l:[130,270, 'flat'], emotion:'alert', label:'Стоп' },
  wait:       { r:[280,200, 'flat'],  l:[120,205, 'flat'], motion:'hold', label:'Подождите' },
  me:         { r:[220,232, 'point'], l:[135,270, 'flat'], label:'Я / мне' },
  you:        { r:[325,220, 'point'], l:[130,270, 'flat'], motion:'out', label:'Ты / вы' },
  name:       { r:[245,180, 'flat'],  l:[155,180, 'flat'], motion:'tap', label:'Имя' },
  friend:     { r:[230,245, 'hook'],  l:[170,245, 'hook'], motion:'link', label:'Друг' },
  mother:     { r:[166,145, 'thumb'], l:[125,270, 'flat'], emotion:'happy', label:'Мама' },
  father:     { r:[173,115, 'thumb'], l:[125,270, 'flat'], emotion:'happy', label:'Папа' },
  family:     { r:[265,230, 'open'],  l:[135,230, 'open'], motion:'circle', label:'Семья' },
  understand: { r:[230,152, 'flat'],  l:[140,270, 'flat'], motion:'out', label:'Понимаю' },
  again:      { r:[255,220, 'flat'],  l:[145,220, 'flat'], motion:'repeat', label:'Ещё раз' },
  slow:       { r:[260,235, 'flat'],  l:[140,235, 'flat'], motion:'down', label:'Медленнее' },
  want:       { r:[250,225, 'open'],  l:[150,225, 'open'], motion:'pull', label:'Хочу' },
  need:       { r:[245,188, 'hook'],  l:[150,270, 'flat'], motion:'down', label:'Нужно' },
  help:       { r:[200,215, 'fist'],  l:[200,260, 'open'], motion:'lift', label:'Помощь' },
  water:      { r:[208,182, 'point'], l:[135,270, 'flat'], label:'Вода' },
  drink:      { r:[210,180, 'cup'],   l:[135,270, 'flat'], motion:'tilt', label:'Пить' },
  food:       { r:[215,190, 'open'],  l:[135,270, 'flat'], motion:'tap', label:'Еда' },
  eat:        { r:[210,185, 'pinch'], l:[135,270, 'flat'], motion:'tap', label:'Есть' },
  home:       { r:[260,200, 'flat'],  l:[140,200, 'flat'], motion:'roof', label:'Дом' },
  school:     { r:[245,238, 'flat'],  l:[155,255, 'flat'], motion:'book', label:'Школа' },
  work:       { r:[245,248, 'fist'],  l:[155,248, 'fist'], motion:'tap', label:'Работа' },
  money:      { r:[248,240, 'flat'],  l:[152,240, 'flat'], motion:'rub', label:'Деньги' },
  phone:      { r:[295,184, 'phone'], l:[130,270, 'flat'], motion:'phone', label:'Телефон / позвонить' },
  who:        { r:[300,195, 'point'], l:[135,270, 'flat'], motion:'side', label:'Кто?' },
  what:       { r:[260,220, 'open'],  l:[140,220, 'open'], motion:'shake', label:'Что?' },
  where:      { r:[300,210, 'point'], l:[120,210, 'point'], motion:'side', label:'Где?' },
  when:       { r:[250,155, 'point'], l:[135,270, 'flat'], motion:'circle', label:'Когда?' },
  how:        { r:[250,225, 'hook'],  l:[150,225, 'hook'], motion:'turn', label:'Как?' },
  why:        { r:[250,165, 'open'],  l:[145,270, 'flat'], motion:'out', label:'Почему?' },
  today:      { r:[205,225, 'flat'],  l:[155,225, 'flat'], motion:'circle', label:'Сегодня' },
  tomorrow:   { r:[245,150, 'flat'],  l:[140,270, 'flat'], motion:'out', label:'Завтра' },
  morning:    { r:[255,140, 'open'],  l:[130,270, 'flat'], motion:'rise', label:'Утро' },
  night:      { r:[255,145, 'flat'],  l:[130,270, 'flat'], emotion:'sad', motion:'down', label:'Ночь' },
  left:       { r:[70,220, 'point'],  l:[135,270, 'flat'], motion:'side', label:'Налево' },
  right:      { r:[330,220, 'point'], l:[135,270, 'flat'], motion:'side', label:'Направо' },
  doctor:     { r:[204,180, 'point'], l:[135,270, 'flat'], label:'Врач' },
  hospital:   { r:[246,210, 'cross'], l:[150,250, 'flat'], emotion:'alert', label:'Больница' },
  pain:       { r:[242,250, 'claw'],  l:[158,250, 'claw'], emotion:'sad', motion:'twist', label:'Боль' },
  emergency:  { r:[300,165, 'open'],  l:[100,165, 'open'], emotion:'alert', motion:'shake', label:'Срочно!' },
  bathroom:   { r:[250,240, 'T'],     l:[135,270, 'flat'], label:'Туалет' },
  love:       { r:[228,232, 'heart'], l:[172,232, 'heart'], emotion:'happy', motion:'heart', label:'Любовь' },
  peace:      { r:[270,195, 'v'],     l:[130,270, 'flat'], emotion:'happy', label:'Мир' },
  happy:      { r:[240,166, 'open'],  l:[160,166, 'open'], emotion:'happy', motion:'rise', label:'Радость' },
  sad:        { r:[238,240, 'flat'],  l:[162,240, 'flat'], emotion:'sad', motion:'down', label:'Грустно' },
};

const LEGACY_GESTURES = { thumbs_up:'good', thumbs_down:'bad', open_palm:'stop', fist:'no', point_up:'yes', bow:'thank_you', 'I-LOVE-YOU':'love' };

function drawSignAvatar(ctx, W, H, t, gesture) {
  const key = LEGACY_GESTURES[gesture] || gesture;
  const pose = SIGN_POSES[key] || SIGN_POSES.wave;
  const color = pose.emotion === 'alert' ? '#f59e0b' : pose.emotion === 'sad' ? '#a78bfa' : pose.emotion === 'happy' ? '#34d399' : '#22d3ee';
  clearCanvas(pose.emotion === 'alert' ? 'angry' : pose.emotion || 'neutral');
  const breathing = Math.sin(t * 0.003) * 2;
  const motion = gestureOffset(pose.motion, t);

  // A stronger upper-body silhouette grounds the hands in a readable signing space.
  ctx.save();
  ctx.translate(0, breathing);
  ctx.fillStyle = 'rgba(19, 73, 100, 0.23)';
  ctx.beginPath(); ctx.moveTo(105, 395); ctx.lineTo(125, 245); ctx.quadraticCurveTo(200, 218, 275, 245); ctx.lineTo(295, 395); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(34, 211, 238, 0.35)'; ctx.lineWidth = 2; ctx.stroke();
  drawPoseArm(ctx, [128, 258], pose.l, 'left', color, motion);
  drawPoseArm(ctx, [272, 258], pose.r, 'right', color, motion);
  ctx.restore();
  drawLabel(ctx, pose.label, W / 2, H - 18);
}

function gestureOffset(kind, t) {
  const s = Math.sin(t * 0.008), c = Math.cos(t * 0.007);
  const offsets = { wave:[s * 20, 0], side:[s * 13, 0], out:[s * 8, -s * 5], down:[0, Math.abs(s) * 12], rise:[0, -Math.abs(s) * 14], shake:[s * 7, c * 3], circle:[c * 8, s * 8], repeat:[s * 7, 0], lift:[0, -Math.abs(s) * 15], pull:[-Math.abs(s) * 10, 0], phone:[s * 5, s * 5], tilt:[s * 6, 0], heart:[0, -Math.abs(s) * 5] };
  return offsets[kind] || [0, 0];
}

function drawPoseArm(ctx, shoulder, hand, side, color, offset) {
  const wrist = [hand[0] + offset[0], hand[1] + offset[1]];
  const elbow = [(shoulder[0] + wrist[0]) / 2 + (side === 'left' ? -20 : 20), (shoulder[1] + wrist[1]) / 2 + 18];
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = 14; ctx.lineCap = 'round'; ctx.globalAlpha = 0.2;
  ctx.beginPath(); ctx.moveTo(...shoulder); ctx.lineTo(...elbow); ctx.lineTo(...wrist); ctx.stroke();
  ctx.globalAlpha = 0.85; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(...shoulder); ctx.lineTo(...elbow); ctx.lineTo(...wrist); ctx.stroke();
  [shoulder, elbow].forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); });
  drawPoseHand(ctx, wrist[0], wrist[1], hand[2], side, color);
  ctx.restore();
}

function drawPoseHand(ctx, x, y, shape, side, color) {
  const flip = side === 'left' ? -1 : 1;
  ctx.save(); ctx.translate(x, y); ctx.scale(flip, 1);
  ctx.shadowColor = color; ctx.shadowBlur = 16;
  ctx.fillStyle = color; ctx.globalAlpha = 0.18; ctx.beginPath(); ctx.ellipse(0, 5, 21, 28, 0, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 0.95; ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.lineCap = 'round';
  const finger = (a, length = 30) => { ctx.beginPath(); ctx.moveTo(0, -3); ctx.lineTo(Math.sin(a) * length, -Math.cos(a) * length); ctx.stroke(); };
  if (shape === 'fist') { ctx.beginPath(); ctx.roundRect(-18, -19, 36, 34, 12); ctx.stroke(); }
  else if (shape === 'point') { finger(0, 42); finger(-1.1, 18); }
  else if (shape === 'thumb') { ctx.beginPath(); ctx.moveTo(-5, 5); ctx.lineTo(-23, -24); ctx.stroke(); ctx.beginPath(); ctx.roundRect(-13, -5, 28, 22, 9); ctx.stroke(); }
  else if (shape === 'v') { finger(-0.28, 39); finger(0.28, 39); finger(-1.25, 17); }
  else if (shape === 'pinch' || shape === 'cup') { finger(-0.5, 24); finger(0.6, 24); ctx.beginPath(); ctx.arc(0, -18, 9, 0, Math.PI * 2); ctx.stroke(); }
  else if (shape === 'phone') { finger(-1.15, 30); finger(0.82, 30); ctx.beginPath(); ctx.moveTo(-12, 8); ctx.lineTo(12, 8); ctx.stroke(); }
  else if (shape === 'heart') { ctx.beginPath(); ctx.moveTo(0, 9); ctx.bezierCurveTo(-35, -15, -13, -37, 0, -18); ctx.bezierCurveTo(13, -37, 35, -15, 0, 9); ctx.stroke(); }
  else if (shape === 'hook' || shape === 'claw') { [-0.45, 0, 0.45].forEach(a => { ctx.beginPath(); ctx.arc(Math.sin(a)*10, -15, 12, 0.3, 2.7); ctx.stroke(); }); }
  else if (shape === 'cross') { finger(-0.55, 28); finger(0.55, 28); }
  else if (shape === 'T') { finger(-Math.PI/2, 28); ctx.beginPath(); ctx.moveTo(-20, -25); ctx.lineTo(20, -25); ctx.stroke(); }
  else { [-0.65, -0.23, 0.18, 0.58].forEach((a, i) => finger(a, i === 2 ? 40 : 33)); finger(-1.2, 24); }
  ctx.restore();
}

function drawAvatarIdle() {
  if (state.avatarAnimating) return;
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

  state.avatarIdleTimer = requestAnimationFrame(drawAvatarIdle);
}

// ══════════════════════════════════════════════════════════════════════════
// Avatar: Text → Sign Animation
// ══════════════════════════════════════════════════════════════════════════

async function sendToAvatar() {
  const text = $('avatar-input').value.trim();
  if (!text) { toast('Введите текст', 'info'); return; }

  if (state.wsAvatar && state.wsAvatar.readyState === WebSocket.OPEN) {
    state.wsAvatar.send(JSON.stringify({ text, lang: state.avatarLang }));
    $('avatar-status').textContent = 'Генерация...';
  } else {
    $('avatar-status').textContent = 'Генерация...';
    try {
      const response = await fetch(`${CONFIG.API_BASE}/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, lang: state.avatarLang })
      });
      const data = await readApiResponse(response);
      renderTranslationPlan(data);
      startAvatarAnimation(data.sequence, data.text);
    } catch (error) {
      console.error('Avatar fallback error:', error);
      $('avatar-status').textContent = 'Недоступен';
      toast('Ошибка: сервер недоступен', 'error');
    }
  }
}

function handleAvatarResponse(data) {
  if (data?.type === 'error') {
    toast(data.message || 'Translation service error', 'error');
    return;
  }
  if (data?.type !== 'animation') return;

  $('avatar-status').textContent = 'Анимация...';
  $('avatar-idle').style.display = 'none';

  // Play TTS audio
  if (data.audio_base64) {
    const audio = $('tts-audio');
    audio.src = 'data:audio/mp3;base64,' + data.audio_base64;
    $('audio-player').style.display = 'block';
    audio.play().catch(() => {});
  }

  renderTranslationPlan(data);
  startAvatarAnimation(data.sequence, data.text);
}

function renderTranslationPlan(plan) {
  const targets = [
    {
      coverage: $('translation-coverage'),
      meta: $('translation-meta'),
      glosses: $('gloss-list'),
      unknown: $('unknown-words')
    },
    {
      coverage: $('detect-translation-coverage'),
      meta: $('detect-translation-meta'),
      glosses: $('detect-gloss-list'),
      unknown: $('detect-unknown-words')
    }
  ].filter(target => target.coverage && target.meta && target.glosses && target.unknown);

  if (!targets.length) return;

  const languageNames = { en: 'English', ru: 'Русский', uz: 'O‘zbek' };
  const percentage = Number.isFinite(plan.coverage) ? plan.coverage : 0;
  const missing = plan.unknown_words || [];
  const dropped = plan.dropped_words || [];
  const notices = [];
  if (missing.length) notices.push(`По буквам: ${missing.join(', ')}. Добавьте эти слова в словарь после проверки жеста.`);
  if (dropped.length) notices.push(`Пропущены служебные слова: ${dropped.join(', ')}.`);
  const metaText = `Язык: ${languageNames[plan.language] || plan.language || '-'} · Глоссы - порядок жестов для аватара`;
  const unknownText = notices.length ? notices.join(' ') : 'Все слова найдены в текущем словаре.';

  targets.forEach(({ coverage, meta, glosses, unknown }) => {
    coverage.textContent = `${percentage}% словаря`;
    meta.textContent = metaText;
    glosses.replaceChildren();
    (plan.glosses || []).forEach(gloss => {
      const token = document.createElement('span');
      token.className = 'gloss-token';
      token.textContent = gloss;
      glosses.appendChild(token);
    });
    unknown.textContent = unknownText;
  });
}

function startAvatarAnimation(sequence, text) {
  // Clear previous
  state.avatarAnimating = true;
  cancelAnimationFrame(state.avatarTimer);
  cancelAnimationFrame(state.avatarIdleTimer);
  $('avatar-idle').style.display = 'none';
  $('avatar-status').textContent = 'Анимация...';
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
    state.avatarAnimating = false;
    drawAvatarIdle();
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
  const containers = [$('seq-chips'), $('detect-seq-chips')].filter(Boolean);
  if (!containers.length) return;

  containers.forEach(container => {
    container.replaceChildren();
    (sequence || []).forEach(sign => {
      const chip = document.createElement('div');
      chip.className = 'seq-chip';
      chip.title = sign.label || sign.gesture || '';
      chip.textContent = sign.gesture || '-';
      container.appendChild(chip);
    });
  });
}

function scheduleAvatarReconnect() {
  clearTimeout(state.avatarReconnectTimer);
  state.avatarReconnectTimer = setTimeout(connectAvatarWS, CONFIG.RECONNECT_DELAY * 2);
}

function updateSeqChips(activeIndex) {
  document.querySelectorAll('.seq-chips').forEach(container => {
    container.querySelectorAll('.seq-chip').forEach((chip, i) => {
      chip.className = 'seq-chip' +
        (i === activeIndex ? ' active' : i < activeIndex ? ' done' : '');
    });
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
  const nextPanel = $(`tab-${tabName}`);
  const nextButton = document.querySelector(`[data-tab="${tabName}"]`);
  if (!nextPanel || !nextButton) return;

  document.querySelectorAll('.tab-section').forEach(section => {
    section.classList.remove('active');
    section.setAttribute('aria-hidden', 'true');
  });
  document.querySelectorAll('.nav-btn').forEach(button => {
    button.classList.remove('active');
    button.setAttribute('aria-selected', 'false');
  });
  nextPanel.classList.add('active');
  nextPanel.setAttribute('aria-hidden', 'false');
  nextButton.classList.add('active');
  nextButton.setAttribute('aria-selected', 'true');
  state.activeTab = tabName;

  if (tabName === 'detect' && state.cameraRunning && !document.hidden && !state.frameTimer) {
    state.frameTimer = setInterval(captureAndSendFrame, CONFIG.FRAME_INTERVAL);
  } else if (tabName !== 'detect') {
    clearInterval(state.frameTimer);
    state.frameTimer = null;
  }
}

function initializeTabs() {
  const tabs = Array.from(document.querySelectorAll('.nav-btn[data-tab]'));
  tabs.forEach(tab => {
    tab.addEventListener('keydown', event => {
      const currentIndex = tabs.indexOf(tab);
      let targetIndex = currentIndex;

      if (event.key === 'ArrowRight') targetIndex = (currentIndex + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') targetIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') targetIndex = 0;
      else if (event.key === 'End') targetIndex = tabs.length - 1;
      else return;

      event.preventDefault();
      const target = tabs[targetIndex];
      target.focus();
      switchTab(target.dataset.tab);
    });
  });
}

async function readApiResponse(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // The HTTP status below still creates a useful browser-side error.
  }

  if (!response.ok) {
    const message = payload?.detail || payload?.message || `Request failed (${response.status}).`;
    throw new Error(message);
  }
  return payload || {};
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
