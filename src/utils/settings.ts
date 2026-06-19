import { AirDrawSettings, DEFAULT_SETTINGS } from '../types/messages';

/** Load settings from chrome.storage.local, falling back to defaults */
export async function loadSettings(): Promise<AirDrawSettings> {
  const result = await chrome.storage.local.get('airdraw_settings');
  if (result.airdraw_settings) {
    return { ...DEFAULT_SETTINGS, ...result.airdraw_settings };
  }
  return { ...DEFAULT_SETTINGS };
}

/** Save partial settings update to chrome.storage.local */
export async function saveSettings(partial: Partial<AirDrawSettings>): Promise<AirDrawSettings> {
  const current = await loadSettings();
  const updated = { ...current, ...partial };
  await chrome.storage.local.set({ airdraw_settings: updated });
  return updated;
}
