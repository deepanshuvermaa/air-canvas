/**
 * MAIN WORLD content script — injected at document_start.
 *
 * This runs in the page's actual JS context (not the extension's isolated
 * sandbox). It MUST run before the meeting app's JS executes, because we
 * need to patch getUserMedia before the app calls it.
 *
 * Why MAIN world?
 * ───────────────
 * Chrome extensions normally run content scripts in an "ISOLATED" world —
 * they share the DOM but have separate JS globals. That means if we patch
 * navigator.mediaDevices.getUserMedia in ISOLATED world, the page's own
 * JS still sees the original, unpatched version. Useless for our purpose.
 *
 * In MAIN world, we modify the same navigator object the page uses.
 * The tradeoff: we can't use chrome.runtime APIs here (no message passing,
 * no storage). We communicate with the ISOLATED world script via
 * window.postMessage / CustomEvent.
 */

import { StreamHijack } from './stream-hijack';
import type { WorldBridgeEvent } from '../types/messages';

// ─── Initialize stream hijack immediately ───
const streamHijack = new StreamHijack();
streamHijack.patchGetUserMedia();

// ─── Listen for commands from the ISOLATED world script ───
window.addEventListener('message', async (event: MessageEvent) => {
  // Only handle our own messages
  if (event.data?.source !== 'airdraw-isolated') return;

  const msg = event.data as WorldBridgeEvent;

  switch (msg.type) {
    case 'TOGGLE': {
      const enabled = await streamHijack.toggle();
      // Report back
      window.postMessage({
        source: 'airdraw-main',
        type: 'STATUS',
        payload: { enabled, tracking: streamHijack.isTracking() },
      } satisfies WorldBridgeEvent, '*');
      break;
    }

    case 'STATUS': {
      window.postMessage({
        source: 'airdraw-main',
        type: 'STATUS',
        payload: {
          enabled: streamHijack.isEnabled(),
          tracking: streamHijack.isTracking(),
        },
      } satisfies WorldBridgeEvent, '*');
      break;
    }

    case 'SETTINGS': {
      if (msg.payload && typeof msg.payload === 'object') {
        streamHijack.updateSettings(msg.payload as Record<string, unknown>);
      }
      break;
    }

    case 'CLEAR': {
      streamHijack.clearCanvas();
      break;
    }

    case 'UNDO': {
      streamHijack.undoStroke();
      break;
    }
  }
});

// Signal that the MAIN world script is loaded and ready
window.postMessage({
  source: 'airdraw-main',
  type: 'STATUS',
  payload: { enabled: false, tracking: false, ready: true },
} satisfies WorldBridgeEvent, '*');

console.log('[AirDraw] Main world injector loaded');
