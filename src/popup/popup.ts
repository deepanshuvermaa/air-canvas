/**
 * Popup script — self-contained, no cross-entry imports.
 */

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

async function init(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  const isSupported = /meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com/.test(url);

  if (!isSupported) {
    pageHint.style.display = 'block';
    toggleBtn.disabled = true;
    toggleBtn.style.opacity = '0.5';
  }

  // Load settings
  const stored = await chrome.storage.local.get(['airdraw_settings', 'airdraw_enabled']);
  if (stored.airdraw_settings) {
    applySettingsToUI(stored.airdraw_settings);
  }
  updateStatus(stored.airdraw_enabled || false);
}

function applySettingsToUI(s: Record<string, unknown>): void {
  if (s.strokeWidth) {
    strokeWidthInput.value = String(s.strokeWidth);
    strokeWidthValue.textContent = s.strokeWidth + 'px';
  }
  if (typeof s.fadeMode === 'boolean') {
    fadeModeInput.checked = s.fadeMode;
    fadeDurationRow.style.display = s.fadeMode ? 'block' : 'none';
  }
  if (s.fadeDuration) {
    fadeDurationInput.value = String(s.fadeDuration);
    fadeDurationValue.textContent = (Number(s.fadeDuration) / 1000).toFixed(1) + 's';
  }
  if (typeof s.shapeSnap === 'boolean') {
    shapeSnapInput.checked = s.shapeSnap;
  }
  if (s.strokeColor) {
    customColorInput.value = String(s.strokeColor);
    colorSwatches.forEach(function (sw) {
      sw.classList.toggle('active', sw.dataset.color === s.strokeColor);
    });
  }
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

toggleBtn.addEventListener('click', async function () {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_AIRDRAW' });
    }
  } catch (e) {
    // Content script not loaded
  }
  // Optimistically toggle UI
  updateStatus(!currentEnabled);
});

clearBtn.addEventListener('click', async function () {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_CANVAS' }).catch(function () {});
});

undoBtn.addEventListener('click', async function () {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'UNDO_STROKE' }).catch(function () {});
});

redoBtn.addEventListener('click', async function () {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'REDO_STROKE' }).catch(function () {});
});

exportBtn.addEventListener('click', function () {
  exportBtn.textContent = 'Saved!';
  setTimeout(function () { exportBtn.textContent = 'Export'; }, 1500);
});

colorSwatches.forEach(function (swatch) {
  swatch.addEventListener('click', function () {
    const color = swatch.dataset.color!;
    colorSwatches.forEach(function (s) { s.classList.remove('active'); });
    swatch.classList.add('active');
    customColorInput.value = color;
    saveAndSendSettings({ strokeColor: color });
  });
});

customColorInput.addEventListener('input', function () {
  colorSwatches.forEach(function (s) { s.classList.remove('active'); });
  saveAndSendSettings({ strokeColor: customColorInput.value });
});

strokeWidthInput.addEventListener('input', function () {
  const val = Number(strokeWidthInput.value);
  strokeWidthValue.textContent = val + 'px';
  saveAndSendSettings({ strokeWidth: val });
});

fadeModeInput.addEventListener('change', function () {
  fadeDurationRow.style.display = fadeModeInput.checked ? 'block' : 'none';
  saveAndSendSettings({ fadeMode: fadeModeInput.checked });
});

fadeDurationInput.addEventListener('input', function () {
  const val = Number(fadeDurationInput.value);
  fadeDurationValue.textContent = (val / 1000).toFixed(1) + 's';
  saveAndSendSettings({ fadeDuration: val });
});

shapeSnapInput.addEventListener('change', function () {
  saveAndSendSettings({ shapeSnap: shapeSnapInput.checked });
});

async function saveAndSendSettings(partial: Record<string, unknown>): Promise<void> {
  // Merge with existing
  const stored = await chrome.storage.local.get('airdraw_settings');
  const current = stored.airdraw_settings || {};
  const updated = { ...current, ...partial };
  await chrome.storage.local.set({ airdraw_settings: updated });

  // Send to content script
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATE', settings: partial }).catch(function () {});
  }
}

init();
