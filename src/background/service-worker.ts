/**
 * Background Service Worker — the extension's central coordinator.
 *
 * In Manifest V3, the background script is a service worker, not a
 * persistent background page. Key differences:
 *   - No DOM access (no document, no window)
 *   - Sleeps when idle, wakes on events
 *   - No persistent state — use chrome.storage for anything that
 *     needs to survive a sleep/wake cycle
 *
 * This service worker:
 * 1. Listens for keyboard shortcuts (chrome.commands)
 * 2. Relays toggle/clear/undo messages to the active tab's content script
 * 3. Manages the extension icon badge to show on/off state
 * 4. Handles settings synchronization between popup and content scripts
 */

import type { AirDrawMessage } from '../types/messages';
import { loadSettings, saveSettings } from '../utils/settings';

// ─── Track enabled state per tab ───
const tabState = new Map<number, { enabled: boolean; tracking: boolean }>();

// ─── Keyboard shortcuts ───

chrome.commands.onCommand.addListener(async (command: string) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  switch (command) {
    case 'toggle-airdraw':
      sendToTab(tab.id, { type: 'TOGGLE_AIRDRAW' });
      break;
    case 'clear-canvas':
      sendToTab(tab.id, { type: 'CLEAR_CANVAS' });
      break;
    case 'undo-stroke':
      sendToTab(tab.id, { type: 'UNDO_STROKE' });
      break;
  }
});

// ─── Message handling ───

chrome.runtime.onMessage.addListener((
  message: AirDrawMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
) => {
  const tabId = sender.tab?.id;

  switch (message.type) {
    case 'STATUS_RESPONSE': {
      if (tabId !== undefined) {
        tabState.set(tabId, {
          enabled: message.enabled,
          tracking: message.tracking,
        });
        updateBadge(tabId, message.enabled);
      }
      break;
    }

    case 'TOGGLE_AIRDRAW': {
      // From popup — relay to active tab
      handlePopupToggle().then(sendResponse);
      return true; // async response
    }

    case 'STATUS_REQUEST': {
      // From popup — relay to active tab and return result
      handlePopupStatusRequest().then(sendResponse);
      return true; // async response
    }

    case 'CLEAR_CANVAS': {
      handlePopupAction({ type: 'CLEAR_CANVAS' });
      break;
    }

    case 'UNDO_STROKE': {
      handlePopupAction({ type: 'UNDO_STROKE' });
      break;
    }

    case 'SETTINGS_UPDATE': {
      // Save settings and relay to active tab
      saveSettings(message.settings).then((updated) => {
        handlePopupAction({ type: 'SETTINGS_UPDATE', settings: updated });
      });
      break;
    }

    case 'SETTINGS_REQUEST': {
      loadSettings().then((settings) => {
        sendResponse({ type: 'SETTINGS_RESPONSE', settings });
      });
      return true; // async response
    }
  }

  sendResponse({ received: true });
});

// ─── Helpers ───

async function sendToTab(tabId: number, message: AirDrawMessage): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Tab might not have content script loaded (not a meeting page)
    console.log(`[AirDraw] Could not send to tab ${tabId} — content script not loaded`);
  }
}

async function handlePopupToggle(): Promise<{ enabled: boolean }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { enabled: false };

  await sendToTab(tab.id, { type: 'TOGGLE_AIRDRAW' });

  // Return cached state (will be updated by STATUS_RESPONSE from content script)
  const state = tabState.get(tab.id);
  return { enabled: !(state?.enabled) };
}

async function handlePopupStatusRequest(): Promise<{ enabled: boolean; tracking: boolean }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { enabled: false, tracking: false };

  await sendToTab(tab.id, { type: 'STATUS_REQUEST' });

  // Return cached state
  return tabState.get(tab.id) ?? { enabled: false, tracking: false };
}

async function handlePopupAction(message: AirDrawMessage): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await sendToTab(tab.id, message);
}

function updateBadge(tabId: number, enabled: boolean): void {
  if (enabled) {
    chrome.action.setBadgeText({ text: 'ON', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#FF3366', tabId });
  } else {
    chrome.action.setBadgeText({ text: '', tabId });
  }
}

// ─── Tab cleanup ───
chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
});

console.log('[AirDraw] Service worker loaded');
