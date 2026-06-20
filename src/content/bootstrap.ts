/**
 * Bootstrap content script — ISOLATED world, document_start.
 *
 * 1. Injects main-world.js (getUserMedia patch)
 * 2. Bridges chrome.runtime <-> postMessage for all commands
 * 3. Relays tracking start/stop to service worker (which runs offscreen doc)
 * 4. Relays landmarks from service worker to MAIN world
 * 5. Shows/hides LIVE badge
 */
export {}; // Ensure this file is treated as an ES module by TypeScript

// ─── Step 1: Inject MAIN world script ───
const scriptUrl = chrome.runtime.getURL('main-world.js');
const scriptEl = document.createElement('script');
scriptEl.src = scriptUrl;
scriptEl.type = 'text/javascript';
(document.head || document.documentElement).appendChild(scriptEl);

// ─── Step 1b: Load MediaPipe vision bundle and create blob URL ───
// Meet's CSP allows blob: URLs in script-src. We fetch the vision bundle
// from extension files (no CSP restriction here in ISOLATED world),
// create a blob URL, and pass it to the MAIN world which can import() it.
(async function loadMediaPipeBundle() {
  try {
    const bundleUrl = chrome.runtime.getURL('mediapipe/vision_bundle.mjs');
    const resp = await fetch(bundleUrl);
    let bundleText = await resp.text();

    // The vision bundle internally loads WASM files relative to its own URL.
    // We need to rewrite those paths to point to our extension's WASM files.
    // The bundle uses FilesetResolver which takes a basePath for WASM files.
    // We'll pass the WASM path separately to the MAIN world.

    const blobUrl = URL.createObjectURL(new Blob([bundleText], { type: 'application/javascript' }));
    const wasmPath = chrome.runtime.getURL('mediapipe/wasm');
    const modelPath = chrome.runtime.getURL('mediapipe/hand_landmarker.task');

    // Send blob URL + paths to MAIN world
    window.postMessage({
      source: 'airdraw-isolated',
      type: 'MEDIAPIPE_BUNDLE',
      payload: {
        blobUrl: blobUrl,
        wasmPath: wasmPath,
        modelPath: modelPath,
      }
    }, '*');

    console.log('[AirDraw] MediaPipe bundle blob URL created and sent to MAIN world');
  } catch (e) {
    console.error('[AirDraw] Failed to load MediaPipe bundle:', e);
  }
})();

// ─── Status badge ───
let statusBadge: HTMLElement | null = null;
let currentGhostState = 'idle';

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
  badge.addEventListener('click', function () {
    // During ghost mode, clicking badge should deactivate ghost, not toggle AirDraw
    if (currentGhostState === 'active') {
      sendToMain('TOGGLE_GHOST');
    } else {
      sendToMain('TOGGLE');
    }
  });
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

// ─── Ghost Mode badge updates ───
function updateGhostBadge(ghostState: string): void {
  currentGhostState = ghostState;
  if (!statusBadge) return;

  const dot = statusBadge.querySelector('#airdraw-status-dot') as HTMLElement | null;
  const label = statusBadge.querySelector('span:last-child') as HTMLElement | null;

  if (ghostState === 'active') {
    // HIDE badge during ghost — it's visible on screen share and blows cover
    statusBadge.classList.remove('active');
  } else if (ghostState === 'recording') {
    statusBadge.classList.add('active');
    if (dot) dot.style.background = '#EF4444';
    if (label) label.textContent = 'Recording...';
  } else if (ghostState === 'previewing') {
    statusBadge.classList.add('active');
    if (dot) dot.style.background = '#F59E0B';
    if (label) label.textContent = 'Preview Loop';
  } else {
    // Restore to AirDraw state
    if (dot) dot.style.background = '#FF3366';
    if (label) label.textContent = 'AirDraw LIVE';
  }
}

// ─── Message bridge: MAIN world <-> chrome.runtime ───
function sendToMain(type: string, payload?: unknown): void {
  window.postMessage({ source: 'airdraw-isolated', type: type, payload: payload }, '*');
}

// Messages FROM MAIN world
window.addEventListener('message', function (event) {
  if (!event.data || event.data.source !== 'airdraw-main') return;

  const msg = event.data;

  if (msg.type === 'STATUS') {
    const payload = msg.payload;
    showBadge(payload.enabled);
    chrome.storage.local.set({ airdraw_enabled: payload.enabled });
    chrome.runtime.sendMessage({
      type: 'STATUS_RESPONSE',
      enabled: payload.enabled,
      tracking: payload.tracking,
    }).catch(function () {});
  }

  // Ghost mode status from MAIN world → relay to service worker for badge
  if (msg.type === 'GHOST_STATUS') {
    const payload = msg.payload;
    updateGhostBadge(payload.ghostState);
    chrome.runtime.sendMessage({
      type: 'GHOST_STATUS',
      ghostState: payload.ghostState,
      clipCount: payload.clipCount,
      autoMute: payload.autoMute,
      autoReturnMs: payload.autoReturnMs,
      userName: payload.userName,
    }).catch(function () {});
  }

  // Ghost alerts (name detected, timer expired, meeting events)
  if (msg.type === 'GHOST_ALERT') {
    const payload = msg.payload;
    // Show browser notification
    if (chrome.runtime) {
      chrome.runtime.sendMessage({
        type: 'GHOST_ALERT',
        alert: payload.alert,
        message: payload.message,
      }).catch(function () {});
    }
    // Also show an on-page notification overlay
    showGhostAlert(payload.message);
  }

  // Recording progress
  if (msg.type === 'GHOST_RECORDING_PROGRESS') {
    const payload = msg.payload;
    chrome.runtime.sendMessage({
      type: 'GHOST_RECORDING_PROGRESS',
      clipNum: payload.clipNum,
      totalClips: payload.totalClips,
      durationSec: payload.durationSec,
    }).catch(function () {});
  }

});

// ─── Ghost Alert Overlay ───
function showGhostAlert(message: string): void {
  const existing = document.getElementById('airdraw-ghost-alert');
  if (existing) existing.remove();

  const alert = document.createElement('div');
  alert.id = 'airdraw-ghost-alert';
  alert.innerHTML = `
    <style>
      #airdraw-ghost-alert {
        position: fixed; top: 60px; right: 12px; z-index: 999999;
        padding: 12px 18px;
        background: rgba(139,92,246,0.95); backdrop-filter: blur(8px);
        border: 1px solid rgba(255,255,255,0.2); border-radius: 12px;
        font-family: -apple-system,BlinkMacSystemFont,sans-serif;
        font-size: 14px; font-weight: 600; color: #fff;
        box-shadow: 0 4px 20px rgba(139,92,246,0.5);
        animation: airdraw-alert-in 0.3s ease, airdraw-alert-out 0.3s ease 4.7s forwards;
        max-width: 320px;
      }
      @keyframes airdraw-alert-in { from { opacity:0; transform:translateX(50px); } to { opacity:1; transform:translateX(0); } }
      @keyframes airdraw-alert-out { from { opacity:1; } to { opacity:0; transform:translateY(-10px); } }
    </style>
    <span>${message}</span>
  `;

  const attach = () => {
    if (document.body) document.body.appendChild(alert);
    setTimeout(() => { alert.remove(); }, 5000);
  };
  if (document.body) attach();
  else document.addEventListener('DOMContentLoaded', attach);
}

// Messages FROM service worker (including landmarks from offscreen doc)
chrome.runtime.onMessage.addListener(function (
  message: any,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (r?: unknown) => void
) {
  switch (message.type) {
    case 'TOGGLE_AIRDRAW': sendToMain('TOGGLE'); break;
    case 'CLEAR_CANVAS': sendToMain('CLEAR'); break;
    case 'UNDO_STROKE': sendToMain('UNDO'); break;
    case 'STATUS_REQUEST': sendToMain('STATUS'); break;
    case 'SETTINGS_UPDATE': sendToMain('SETTINGS', message.settings); break;
    case 'RECORD_GHOST': sendToMain('RECORD_GHOST'); break;
    case 'TOGGLE_GHOST': sendToMain('TOGGLE_GHOST'); break;
    case 'GHOST_STATUS_REQUEST': sendToMain('GHOST_STATUS'); break;
    case 'GHOST_ACCEPT_PREVIEW': sendToMain('GHOST_ACCEPT_PREVIEW'); break;
    case 'GHOST_REJECT_PREVIEW': sendToMain('GHOST_REJECT_PREVIEW'); break;
    case 'GHOST_SET_TIMER': sendToMain('GHOST_SET_TIMER', message.payload); break;
    case 'GHOST_SET_NAME': sendToMain('GHOST_SET_NAME', message.payload); break;
    case 'GHOST_SET_AUTOMUTE': sendToMain('GHOST_SET_AUTOMUTE', message.payload); break;
    case 'GHOST_REQUEST_PIP': sendToMain('GHOST_REQUEST_PIP'); break;
    case 'SCREEN_MODE': sendToMain('SCREEN_MODE'); break;
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
