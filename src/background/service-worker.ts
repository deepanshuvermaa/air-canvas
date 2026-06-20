/**
 * Background Service Worker.
 * Handles keyboard shortcuts, badge state, message routing.
 */
export {}; // Ensure this file is treated as an ES module by TypeScript

const tabState = new Map<number, { enabled: boolean; tracking: boolean; ghostState?: string }>();

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
    case 'record-ghost':
      sendToTab(tab.id, { type: 'RECORD_GHOST' });
      break;
    case 'toggle-ghost':
      sendToTab(tab.id, { type: 'TOGGLE_GHOST' });
      break;
    case 'screen-mode':
      sendToTab(tab.id, { type: 'SCREEN_MODE' });
      break;
  }
});

chrome.runtime.onMessage.addListener(function (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
) {
  const tabId = sender.tab?.id;

  if (message.type === 'STATUS_RESPONSE' && tabId !== undefined) {
    tabState.set(tabId, {
      enabled: message.enabled || false,
      tracking: message.tracking || false,
    });
    updateBadge(tabId, message.enabled || false);
  }

  if (message.type === 'GHOST_STATUS' && tabId !== undefined) {
    const existing = tabState.get(tabId) || { enabled: false, tracking: false };
    existing.ghostState = message.ghostState;
    tabState.set(tabId, existing);
    updateGhostBadge(tabId, message.ghostState);
  }

  // Ghost alerts → send to popup (if open)
  if (message.type === 'GHOST_ALERT') {
    // Forward to all extension views (popup)
    chrome.runtime.sendMessage({
      type: 'GHOST_ALERT',
      alert: message.alert,
      message: message.message,
    }).catch(function () {});
  }

  // Ghost recording progress → forward to popup
  if (message.type === 'GHOST_RECORDING_PROGRESS') {
    chrome.runtime.sendMessage({
      type: 'GHOST_RECORDING_PROGRESS',
      clipNum: message.clipNum,
      totalClips: message.totalClips,
      durationSec: message.durationSec,
    }).catch(function () {});
  }

  sendResponse({ received: true });
  return true;
});

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

function updateGhostBadge(tabId: number, ghostState: string): void {
  if (ghostState === 'active') {
    chrome.action.setBadgeText({ text: 'GHO', tabId: tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#8B5CF6', tabId: tabId });
  } else if (ghostState === 'recording') {
    chrome.action.setBadgeText({ text: 'REC', tabId: tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#EF4444', tabId: tabId });
  } else if (ghostState === 'previewing') {
    chrome.action.setBadgeText({ text: 'PRV', tabId: tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#F59E0B', tabId: tabId });
  } else if (ghostState === 'ready') {
    // Restore normal badge (AirDraw ON/OFF)
    const state = tabState.get(tabId);
    updateBadge(tabId, state?.enabled || false);
  } else {
    const state = tabState.get(tabId);
    updateBadge(tabId, state?.enabled || false);
  }
}

chrome.tabs.onRemoved.addListener(function (tabId: number) {
  tabState.delete(tabId);
});
