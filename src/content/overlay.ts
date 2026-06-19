/**
 * ISOLATED WORLD content script — injected at document_idle.
 *
 * This script runs in the extension's isolated sandbox. It CAN use
 * chrome.runtime APIs (message passing to service worker, storage, etc.)
 * but CANNOT access the page's JS globals.
 *
 * Responsibilities:
 * 1. Bridge between service worker (chrome.runtime) and MAIN world (postMessage)
 * 2. Inject the status indicator UI into the page DOM
 * 3. Handle keyboard shortcuts relayed from the service worker
 *
 * Communication flow:
 *   Service Worker ──chrome.runtime.onMessage──▶ Overlay (ISOLATED)
 *   Overlay (ISOLATED) ──window.postMessage──▶ Injector (MAIN)
 *   Injector (MAIN) ──window.postMessage──▶ Overlay (ISOLATED)
 *   Overlay (ISOLATED) ──chrome.runtime.sendMessage──▶ Service Worker
 */

import type { AirDrawMessage, WorldBridgeEvent } from '../types/messages';

// ─── Status indicator badge ───

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

  document.body.appendChild(badge);
  return badge;
}

let statusBadge: HTMLElement | null = null;

function showBadge(show: boolean): void {
  if (!statusBadge) {
    statusBadge = createStatusBadge();
  }
  statusBadge.classList.toggle('active', show);
}

// ─── MAIN world communication ───

function sendToMainWorld(type: WorldBridgeEvent['type'], payload?: unknown): void {
  window.postMessage({
    source: 'airdraw-isolated',
    type,
    payload,
  } satisfies WorldBridgeEvent, '*');
}

// Listen for responses from MAIN world
window.addEventListener('message', (event: MessageEvent) => {
  if (event.data?.source !== 'airdraw-main') return;

  const msg = event.data as WorldBridgeEvent;

  if (msg.type === 'STATUS') {
    const payload = msg.payload as { enabled: boolean; tracking: boolean };
    showBadge(payload.enabled);

    // Relay status back to service worker
    chrome.runtime.sendMessage({
      type: 'STATUS_RESPONSE',
      enabled: payload.enabled,
      tracking: payload.tracking,
    } satisfies AirDrawMessage);
  }
});

// ─── Service worker communication ───

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

// ─── Initial status request ───
// Wait a moment for the MAIN world script to load, then request status
setTimeout(() => {
  sendToMainWorld('STATUS');
}, 500);

console.log('[AirDraw] Overlay content script loaded');
