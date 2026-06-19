/**
 * Bootstrap content script — ISOLATED world, document_start.
 *
 * 1. Injects main-world.js synchronously (getUserMedia patch)
 * 2. Runs MediaPipe hand tracking in THIS world (extension CSP allows CDN)
 * 3. Relays landmarks to MAIN world via postMessage
 * 4. Shows/hides LIVE badge
 * 5. Bridges chrome.runtime <-> postMessage
 */

// ─── Step 1: Inject MAIN world script ───
const scriptUrl = chrome.runtime.getURL('main-world.js');
const scriptEl = document.createElement('script');
scriptEl.src = scriptUrl;
scriptEl.type = 'text/javascript';
(document.head || document.documentElement).appendChild(scriptEl);

// ─── Hand tracking state ───
let handTracker: any = null;
let trackingVideo: HTMLVideoElement | null = null;
let trackingLoop: number | null = null;
let trackingWidth = 640;
let trackingHeight = 480;

async function initHandTracking(): Promise<void> {
  if (handTracker) return;

  console.log('[AirDraw] Loading MediaPipe in ISOLATED world...');

  try {
    // Dynamic import works here because ISOLATED world uses EXTENSION CSP
    const vision = await import(
      /* webpackIgnore: true */
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest'
    );

    const wasmFileset = await vision.FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
    );

    handTracker = await vision.HandLandmarker.createFromOptions(wasmFileset, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    console.log('[AirDraw] MediaPipe Hand Landmarker ready');
  } catch (e) {
    console.error('[AirDraw] MediaPipe init failed:', e);
  }
}

async function startTracking(width: number, height: number): Promise<void> {
  trackingWidth = width;
  trackingHeight = height;

  await initHandTracking();
  if (!handTracker) return;

  // Get our own camera stream for tracking (ISOLATED world has access)
  if (!trackingVideo) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: width }, height: { ideal: height } }
      });
      trackingVideo = document.createElement('video');
      trackingVideo.srcObject = stream;
      trackingVideo.autoplay = true;
      trackingVideo.playsInline = true;
      trackingVideo.muted = true;
      trackingVideo.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
      document.documentElement.appendChild(trackingVideo);
      await trackingVideo.play();
      console.log('[AirDraw] Tracking video ready');
    } catch (e) {
      console.error('[AirDraw] Cannot get camera for tracking:', e);
      return;
    }
  }

  if (trackingLoop !== null) return;

  function process(): void {
    trackingLoop = requestAnimationFrame(process);

    if (!handTracker || !trackingVideo || trackingVideo.readyState < 2) return;

    try {
      const result = handTracker.detectForVideo(trackingVideo, performance.now());
      let landmarks: any[] | null = null;
      if (result.landmarks && result.landmarks.length > 0) {
        landmarks = result.landmarks[0];
      }

      // Relay landmarks to MAIN world
      window.postMessage({
        source: 'airdraw-isolated',
        type: 'LANDMARKS',
        payload: { landmarks: landmarks }
      }, '*');
    } catch (_e) {
      // skip frame
    }
  }

  trackingLoop = requestAnimationFrame(process);
  console.log('[AirDraw] Hand tracking loop started');
}

function stopTrackingLoop(): void {
  if (trackingLoop !== null) {
    cancelAnimationFrame(trackingLoop);
    trackingLoop = null;
  }
  if (trackingVideo) {
    const stream = trackingVideo.srcObject as MediaStream;
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
    }
    trackingVideo.remove();
    trackingVideo = null;
  }
}

// ─── Status badge ───
let statusBadge: HTMLElement | null = null;

function createBadge(): HTMLElement {
  const badge = document.createElement('div');
  badge.id = 'airdraw-status-badge';

  const style = document.createElement('style');
  style.textContent = [
    '#airdraw-status-badge {',
    '  position: fixed; top: 12px; right: 12px; z-index: 999999;',
    '  display: none; align-items: center; gap: 8px;',
    '  padding: 8px 14px;',
    '  background: rgba(0,0,0,0.85); backdrop-filter: blur(8px);',
    '  border: 1px solid rgba(255,51,102,0.6); border-radius: 20px;',
    '  font-family: -apple-system,BlinkMacSystemFont,sans-serif;',
    '  font-size: 13px; color: #fff; cursor: pointer; user-select: none;',
    '  box-shadow: 0 2px 12px rgba(255,51,102,0.3);',
    '}',
    '#airdraw-status-badge.active { display: flex; }',
    '#airdraw-status-dot {',
    '  width: 8px; height: 8px; border-radius: 50%; background: #FF3366;',
    '  animation: airdraw-pulse 1.5s infinite;',
    '}',
    '@keyframes airdraw-pulse {',
    '  0%,100% { opacity:1; transform:scale(1); }',
    '  50% { opacity:0.5; transform:scale(0.8); }',
    '}',
  ].join('\n');

  const dot = document.createElement('span');
  dot.id = 'airdraw-status-dot';
  const label = document.createElement('span');
  label.textContent = 'AirDraw LIVE';

  badge.appendChild(style);
  badge.appendChild(dot);
  badge.appendChild(label);
  badge.addEventListener('click', function () { sendToMain('TOGGLE'); });
  return badge;
}

function showBadge(show: boolean): void {
  if (!statusBadge) {
    statusBadge = createBadge();
    const attach = function () {
      if (document.body && statusBadge) document.body.appendChild(statusBadge);
    };
    if (document.body) attach();
    else document.addEventListener('DOMContentLoaded', attach);
  }
  if (statusBadge) {
    if (show) statusBadge.classList.add('active');
    else statusBadge.classList.remove('active');
  }
}

// ─── Message bridge ───
function sendToMain(type: string, payload?: unknown): void {
  window.postMessage({ source: 'airdraw-isolated', type: type, payload: payload }, '*');
}

window.addEventListener('message', function (event) {
  if (!event.data || event.data.source !== 'airdraw-main') return;

  if (event.data.type === 'STATUS') {
    const payload = event.data.payload;
    showBadge(payload.enabled);
    chrome.storage.local.set({ airdraw_enabled: payload.enabled });
    chrome.runtime.sendMessage({
      type: 'STATUS_RESPONSE',
      enabled: payload.enabled,
      tracking: payload.tracking,
    }).catch(function () {});
  }

  if (event.data.type === 'START_TRACKING') {
    const p = event.data.payload;
    startTracking(p.width, p.height);
  }

  if (event.data.type === 'STOP_TRACKING') {
    stopTrackingLoop();
  }
});

chrome.runtime.onMessage.addListener(function (
  message: { type: string; settings?: unknown },
  _sender: chrome.runtime.MessageSender,
  sendResponse: (r?: unknown) => void
) {
  switch (message.type) {
    case 'TOGGLE_AIRDRAW': sendToMain('TOGGLE'); break;
    case 'CLEAR_CANVAS': sendToMain('CLEAR'); break;
    case 'UNDO_STROKE': sendToMain('UNDO'); break;
    case 'STATUS_REQUEST': sendToMain('STATUS'); break;
    case 'SETTINGS_UPDATE': sendToMain('SETTINGS', message.settings); break;
  }
  sendResponse({ received: true });
  return true;
});

// Auto-restore
chrome.storage.local.get('airdraw_enabled', function (result) {
  if (result.airdraw_enabled) {
    setTimeout(function () { sendToMain('ENABLE_IF_SAVED'); }, 1500);
  }
});
