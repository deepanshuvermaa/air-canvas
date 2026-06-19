/**
 * Bootstrap content script — ISOLATED world, document_start.
 *
 * 1. Injects main-world.js (getUserMedia patch)
 * 2. Bridges chrome.runtime <-> postMessage for all commands
 * 3. Relays tracking start/stop to service worker (which runs offscreen doc)
 * 4. Relays landmarks from service worker to MAIN world
 * 5. Shows/hides LIVE badge
 */

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

});

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
