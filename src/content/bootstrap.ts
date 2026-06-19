/**
 * Bootstrap content script — ISOLATED world, document_start.
 *
 * This is the ONLY content script now. It does two things:
 *
 * 1. Immediately injects the MAIN world script as a synchronous <script> tag.
 *    This guarantees the getUserMedia patch runs BEFORE the meeting app's JS.
 *    (CRXJS wraps content scripts in async loaders which breaks this guarantee.)
 *
 * 2. Bridges communication between the service worker (chrome.runtime)
 *    and the MAIN world script (window.postMessage).
 *
 * 3. Shows/hides the "AirDraw LIVE" status badge.
 *
 * 4. Persists enabled state in chrome.storage.local so it survives page refresh.
 */

import type { AirDrawMessage, WorldBridgeEvent } from '../types/messages';

// ─── Step 1: Inject MAIN world script synchronously ───
// This MUST happen before any meeting app JS runs.
const scriptUrl = chrome.runtime.getURL('main-world.js');
const scriptEl = document.createElement('script');
scriptEl.src = scriptUrl;
scriptEl.type = 'text/javascript';
// Synchronous injection — blocks parsing until loaded
(document.head || document.documentElement).appendChild(scriptEl);

console.log('[AirDraw] Bootstrap: MAIN world script injected');

// ─── Step 2: Status badge (created when DOM is ready) ───

let statusBadge: HTMLElement | null = null;

function createStatusBadge(): HTMLElement {
  const badge = document.createElement('div');
  badge.id = 'airdraw-status-badge';
  badge.innerHTML = `
    <style>
      #airdraw-status-badge {
        position: fixed;
        top: 12px;
        right: 12px;
        z-index: 999999;
        display: none;
        align-items: center;
        gap: 8px;
        padding: 8px 14px;
        background: rgba(0, 0, 0, 0.85);
        backdrop-filter: blur(8px);
        border: 1px solid rgba(255, 51, 102, 0.6);
        border-radius: 20px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        color: #fff;
        cursor: pointer;
        user-select: none;
        transition: all 0.2s ease;
        box-shadow: 0 2px 12px rgba(255, 51, 102, 0.3);
      }
      #airdraw-status-badge:hover {
        background: rgba(0, 0, 0, 0.95);
        transform: scale(1.03);
      }
      #airdraw-status-badge.active {
        display: flex;
      }
      #airdraw-status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #FF3366;
        animation: airdraw-pulse 1.5s infinite;
      }
      @keyframes airdraw-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.5; transform: scale(0.8); }
      }
    </style>
    <span id="airdraw-status-dot"></span>
    <span>AirDraw LIVE</span>
  `;

  badge.addEventListener('click', () => {
    sendToMainWorld('TOGGLE');
  });

  return badge;
}

function ensureBadge(): HTMLElement {
  if (!statusBadge) {
    statusBadge = createStatusBadge();
    // Append when body is available
    if (document.body) {
      document.body.appendChild(statusBadge);
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        document.body.appendChild(statusBadge!);
      });
    }
  }
  return statusBadge;
}

function showBadge(show: boolean): void {
  const badge = ensureBadge();
  badge.classList.toggle('active', show);
}

// ─── Step 3: MAIN world communication ───

function sendToMainWorld(type: string, payload?: unknown): void {
  window.postMessage({
    source: 'airdraw-isolated',
    type,
    payload,
  }, '*');
}

// Listen for responses from MAIN world
window.addEventListener('message', (event: MessageEvent) => {
  if (event.data?.source !== 'airdraw-main') return;

  const msg = event.data as WorldBridgeEvent;

  if (msg.type === 'STATUS') {
    const payload = msg.payload as { enabled: boolean; tracking: boolean };
    showBadge(payload.enabled);

    // Persist enabled state
    chrome.storage.local.set({ airdraw_enabled: payload.enabled });

    // Relay to service worker
    chrome.runtime.sendMessage({
      type: 'STATUS_RESPONSE',
      enabled: payload.enabled,
      tracking: payload.tracking,
    } satisfies AirDrawMessage).catch(() => {});
  }
});

// ─── Step 4: Service worker communication ───

chrome.runtime.onMessage.addListener((
  message: AirDrawMessage,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
) => {
  switch (message.type) {
    case 'TOGGLE_AIRDRAW':
      sendToMainWorld('TOGGLE');
      break;
    case 'CLEAR_CANVAS':
      sendToMainWorld('CLEAR');
      break;
    case 'UNDO_STROKE':
      sendToMainWorld('UNDO');
      break;
    case 'STATUS_REQUEST':
      sendToMainWorld('STATUS');
      break;
    case 'SETTINGS_UPDATE':
      sendToMainWorld('SETTINGS', message.settings);
      break;
  }
  sendResponse({ received: true });
  return true;
});

// ─── Step 5: Auto-restore on page load ───
// If AirDraw was enabled before refresh, re-enable it
chrome.storage.local.get('airdraw_enabled', (result) => {
  if (result.airdraw_enabled) {
    // Wait for MAIN world script to be ready, then enable
    const waitForReady = () => {
      sendToMainWorld('ENABLE_IF_SAVED');
    };
    // Give MAIN world script time to initialize
    setTimeout(waitForReady, 1000);
  }
});

console.log('[AirDraw] Bootstrap content script loaded');
