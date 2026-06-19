/**
 * Bootstrap content script — ISOLATED world, document_start.
 *
 * Injects main-world.js synchronously and bridges chrome.runtime <-> postMessage.
 * NO template literals with CSS — those break in bundlers.
 */

// ─── Step 1: Inject MAIN world script synchronously ───
const scriptUrl = chrome.runtime.getURL('main-world.js');
const scriptEl = document.createElement('script');
scriptEl.src = scriptUrl;
scriptEl.type = 'text/javascript';
(document.head || document.documentElement).appendChild(scriptEl);

// ─── Step 2: Status badge ───
let statusBadge: HTMLElement | null = null;

function createBadge(): HTMLElement {
  const badge = document.createElement('div');
  badge.id = 'airdraw-status-badge';

  // Build styles via JS — no template literals
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
    sendToMain('TOGGLE');
  });

  return badge;
}

function showBadge(show: boolean): void {
  if (!statusBadge) {
    statusBadge = createBadge();
    const attach = function () {
      if (document.body && statusBadge) {
        document.body.appendChild(statusBadge);
      }
    };
    if (document.body) {
      attach();
    } else {
      document.addEventListener('DOMContentLoaded', attach);
    }
  }
  if (statusBadge) {
    if (show) {
      statusBadge.classList.add('active');
    } else {
      statusBadge.classList.remove('active');
    }
  }
}

// ─── Step 3: Message bridge ───
function sendToMain(type: string, payload?: unknown): void {
  window.postMessage({
    source: 'airdraw-isolated',
    type: type,
    payload: payload,
  }, '*');
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
});

chrome.runtime.onMessage.addListener(function (
  message: { type: string; settings?: unknown },
  _sender: chrome.runtime.MessageSender,
  sendResponse: (r?: unknown) => void
) {
  switch (message.type) {
    case 'TOGGLE_AIRDRAW':
      sendToMain('TOGGLE');
      break;
    case 'CLEAR_CANVAS':
      sendToMain('CLEAR');
      break;
    case 'UNDO_STROKE':
      sendToMain('UNDO');
      break;
    case 'STATUS_REQUEST':
      sendToMain('STATUS');
      break;
    case 'SETTINGS_UPDATE':
      sendToMain('SETTINGS', message.settings);
      break;
  }
  sendResponse({ received: true });
  return true;
});

// ─── Step 4: Auto-restore on page load ───
chrome.storage.local.get('airdraw_enabled', function (result) {
  if (result.airdraw_enabled) {
    setTimeout(function () {
      sendToMain('ENABLE_IF_SAVED');
    }, 1500);
  }
});
