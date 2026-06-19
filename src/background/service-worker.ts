/**
 * Background Service Worker — self-contained, no cross-entry imports.
 */

const tabState = new Map<number, { enabled: boolean; tracking: boolean }>();

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
  message: { type: string; enabled?: boolean; tracking?: boolean; settings?: unknown },
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
) {
  const tabId = sender.tab?.id;

  if (message.type === 'STATUS_RESPONSE' && tabId !== undefined) {
    tabState.set(tabId, {
      enabled: message.enabled || false,
      tracking: message.tracking || false,
    });
    updateBadge(tabId, message.enabled || false);
  }

  sendResponse({ received: true });
  return true;
});

// ─── Helpers ───
async function sendToTab(tabId: number, message: { type: string }): Promise<void> {
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
});
