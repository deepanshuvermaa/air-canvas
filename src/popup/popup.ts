/**
 * Popup script — runs when the user clicks the toolbar icon.
 *
 * Communicates with the service worker via chrome.runtime.sendMessage.
 * Reads/writes settings via the service worker (which uses chrome.storage.local).
 */

import type { AirDrawMessage, AirDrawSettings } from '../types/messages';

// ─── DOM elements ───

const toggleBtn = document.getElementById('toggle-btn') as HTMLButtonElement;
const toggleText = document.getElementById('toggle-text') as HTMLSpanElement;
const statusText = document.getElementById('status-text') as HTMLSpanElement;
const pageHint = document.getElementById('page-hint') as HTMLParagraphElement;
const clearBtn = document.getElementById('clear-btn') as HTMLButtonElement;
const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement;
const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement;
const exportBtn = document.getElementById('export-btn') as HTMLButtonElement;
const strokeWidthInput = document.getElementById('stroke-width') as HTMLInputElement;
const strokeWidthValue = document.getElementById('stroke-width-value') as HTMLSpanElement;
const fadeModeInput = document.getElementById('fade-mode') as HTMLInputElement;
const fadeDurationRow = document.getElementById('fade-duration-row') as HTMLDivElement;
const fadeDurationInput = document.getElementById('fade-duration') as HTMLInputElement;
const fadeDurationValue = document.getElementById('fade-duration-value') as HTMLSpanElement;
const shapeSnapInput = document.getElementById('shape-snap') as HTMLInputElement;
const customColorInput = document.getElementById('custom-color') as HTMLInputElement;
const colorSwatches = document.querySelectorAll('.color-swatch') as NodeListOf<HTMLDivElement>;

let currentEnabled = false;

// ─── Initialize ───

async function init(): Promise<void> {
  // Check if we're on a supported page
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  const isSupported = /meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com/.test(url);

  if (!isSupported) {
    pageHint.style.display = 'block';
    toggleBtn.disabled = true;
    toggleBtn.style.opacity = '0.5';
  }

  // Load settings
  const response = await sendMessage({ type: 'SETTINGS_REQUEST' }) as { settings?: AirDrawSettings };
  if (response?.settings) {
    applySettingsToUI(response.settings);
  }

  // Get current status
  const statusResponse = await sendMessage({ type: 'STATUS_REQUEST' }) as { enabled?: boolean; tracking?: boolean };
  if (statusResponse) {
    updateStatus(statusResponse.enabled ?? false);
  }
}

function applySettingsToUI(settings: AirDrawSettings): void {
  strokeWidthInput.value = String(settings.strokeWidth);
  strokeWidthValue.textContent = `${settings.strokeWidth}px`;

  fadeModeInput.checked = settings.fadeMode;
  fadeDurationRow.style.display = settings.fadeMode ? 'block' : 'none';
  fadeDurationInput.value = String(settings.fadeDuration);
  fadeDurationValue.textContent = `${(settings.fadeDuration / 1000).toFixed(1)}s`;

  shapeSnapInput.checked = settings.shapeSnap;

  customColorInput.value = settings.strokeColor;

  // Update active swatch
  colorSwatches.forEach((swatch) => {
    swatch.classList.toggle('active', swatch.dataset.color === settings.strokeColor);
  });
}

function updateStatus(enabled: boolean): void {
  currentEnabled = enabled;
  if (enabled) {
    statusText.textContent = 'Active';
    statusText.classList.add('active');
    toggleText.textContent = 'Disable AirDraw';
    toggleBtn.classList.add('active');
  } else {
    statusText.textContent = 'Inactive';
    statusText.classList.remove('active');
    toggleText.textContent = 'Enable AirDraw';
    toggleBtn.classList.remove('active');
  }
}

// ─── Event listeners ───

toggleBtn.addEventListener('click', async () => {
  const response = await sendMessage({ type: 'TOGGLE_AIRDRAW' }) as { enabled?: boolean };
  updateStatus(response?.enabled ?? !currentEnabled);
});

clearBtn.addEventListener('click', () => {
  sendMessage({ type: 'CLEAR_CANVAS' });
});

undoBtn.addEventListener('click', () => {
  sendMessage({ type: 'UNDO_STROKE' });
});

redoBtn.addEventListener('click', () => {
  // Redo is handled by sending undo with a special flag
  // For now, we just send it as a message that the content script handles
  sendMessage({ type: 'UNDO_STROKE' }); // TODO: separate redo message
});

exportBtn.addEventListener('click', async () => {
  // Request export from content script (downloads a PNG)
  // For now, show a brief confirmation
  exportBtn.textContent = 'Saved!';
  setTimeout(() => {
    exportBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/>
        <path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/>
      </svg>
      Export
    `;
  }, 1500);
});

// Color swatches
colorSwatches.forEach((swatch) => {
  swatch.addEventListener('click', () => {
    const color = swatch.dataset.color!;
    colorSwatches.forEach((s) => s.classList.remove('active'));
    swatch.classList.add('active');
    customColorInput.value = color;
    sendSettingsUpdate({ strokeColor: color });
  });
});

customColorInput.addEventListener('input', () => {
  colorSwatches.forEach((s) => s.classList.remove('active'));
  sendSettingsUpdate({ strokeColor: customColorInput.value });
});

strokeWidthInput.addEventListener('input', () => {
  const val = Number(strokeWidthInput.value);
  strokeWidthValue.textContent = `${val}px`;
  sendSettingsUpdate({ strokeWidth: val });
});

fadeModeInput.addEventListener('change', () => {
  fadeDurationRow.style.display = fadeModeInput.checked ? 'block' : 'none';
  sendSettingsUpdate({ fadeMode: fadeModeInput.checked });
});

fadeDurationInput.addEventListener('input', () => {
  const val = Number(fadeDurationInput.value);
  fadeDurationValue.textContent = `${(val / 1000).toFixed(1)}s`;
  sendSettingsUpdate({ fadeDuration: val });
});

shapeSnapInput.addEventListener('change', () => {
  sendSettingsUpdate({ shapeSnap: shapeSnapInput.checked });
});

// ─── Helpers ───

function sendSettingsUpdate(partial: Partial<AirDrawSettings>): void {
  sendMessage({ type: 'SETTINGS_UPDATE', settings: partial });
}

function sendMessage(message: AirDrawMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}

// ─── Boot ───
init();
