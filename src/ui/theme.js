/**
 * Theme handling for the extension pages: follow the system by default, with an
 * explicit light and dark choice. The preference is shared by popup and options.
 */

import { DEFAULT_THEME, THEMES, THEME_STORAGE_KEY } from '../constants.js';

const THEME_ATTRIBUTE = 'data-theme';

export async function loadTheme() {
  try {
    const stored = await chrome.storage.local.get(THEME_STORAGE_KEY);
    const theme = stored?.[THEME_STORAGE_KEY];
    return THEMES.includes(theme) ? theme : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(theme) {
  const effective = THEMES.includes(theme) ? theme : DEFAULT_THEME;
  if (effective === DEFAULT_THEME) {
    document.documentElement.removeAttribute(THEME_ATTRIBUTE);
  } else {
    document.documentElement.setAttribute(THEME_ATTRIBUTE, effective);
  }
}

export async function saveTheme(theme) {
  const effective = THEMES.includes(theme) ? theme : DEFAULT_THEME;
  await chrome.storage.local.set({ [THEME_STORAGE_KEY]: effective });
  applyTheme(effective);
  return effective;
}

/** Applies the stored theme as early as possible and keeps it in sync. */
export async function initTheme() {
  const theme = await loadTheme();
  applyTheme(theme);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[THEME_STORAGE_KEY]) {
      applyTheme(changes[THEME_STORAGE_KEY].newValue);
    }
  });
  return theme;
}
