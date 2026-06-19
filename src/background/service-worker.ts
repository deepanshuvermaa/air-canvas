/**
 * Background Service Worker.
 *
 * Creates an offscreen document for MediaPipe hand tracking.
 * Relays landmarks between offscreen doc and content scripts.
 */

const tabState = new Map<number, { enabled: boolean; tracking: boolean }>();
let offscreenCreated = false;
let activeTrackingTabId: number | null = null;

// ─── Offscreen document management ───

async function ensureOffscreenDocument(): Promise<void> {
  if (offscreenCreated) return;

  try {
    // Check if already exists
    const existingContexts = await (chrome as any).runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    if (existingContexts && existingContexts.length > 0) {
      offscreenCreated = true;
      return;
    }
  } catch (_e) {
    // getContexts may not exist in older Chrome
  }

  try {
    await (chrome as any).offscreen.createDocument({
      url: 'tracker.html',
      reasons: ['USER_MEDIA'],
      justification: 'Hand tracking for AirDraw — camera access for MediaPipe hand landmark detection'
    });
    offscreenCreated = true;
    console.log('[AirDraw SW] Offscreen document created');
  } catch (e) {
    console.error('[AirDraw SW] Failed to create offscreen document:', e);
  }
}

// ─── Keyboard shortcuts ───

chrome.commands.onCommand.addListener(async function (command: string) {
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

chrome.runtime.onMessage.addListener(function (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
) {
  const tabId = sender.tab?.id;

  switch (message.type) {
    case 'STATUS_RESPONSE':
      if (tabId !== undefined) {
        tabState.set(tabId, {
          enabled: message.enabled || false,
          tracking: message.tracking || false,
        });
        updateBadge(tabId, message.enabled || false);
      }
      break;

    case 'START_TRACKING':
      // Content script wants tracking → create offscreen doc and start
      if (tabId !== undefined) {
        activeTrackingTabId = tabId;
        ensureOffscreenDocument().then(function () {
          // Forward to offscreen document
          chrome.runtime.sendMessage({
            type: 'START_TRACKING',
            width: message.width,
            height: message.height,
          }).catch(function () {});
        });
      }
      break;

    case 'STOP_TRACKING':
      activeTrackingTabId = null;
      chrome.runtime.sendMessage({ type: 'STOP_TRACKING' }).catch(function () {});
      break;

    case 'LANDMARKS':
      // From offscreen doc → relay to the active tab's content script
      if (activeTrackingTabId !== null) {
        sendToTab(activeTrackingTabId, {
          type: 'LANDMARKS',
          landmarks: message.landmarks,
        });
      }
      break;
  }

  sendResponse({ received: true });
  return true;
});

// ─── Helpers ───

async function sendToTab(tabId: number, message: any): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Content script not loaded
  }
}

function updateBadge(tabId: number, enabled: boolean): void {
  if (enabled) {
    chrome.action.setBadgeText({ text: 'ON', tabId: tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#FF3366', tabId: tabId });
  } else {
    chrome.action.setBadgeText({ text: '', tabId: tabId });
  }
}

chrome.tabs.onRemoved.addListener(function (tabId: number) {
  tabState.delete(tabId);
  if (activeTrackingTabId === tabId) {
    activeTrackingTabId = null;
    chrome.runtime.sendMessage({ type: 'STOP_TRACKING' }).catch(function () {});
  }
});
