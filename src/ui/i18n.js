/**
 * Localisation helpers for the extension pages.
 *
 * Strings always come from _locales via chrome.i18n; sentences are never built
 * by concatenating fragments, and numbers and dates go through Intl so they
 * follow the browser's locale.
 */

const I18N_TEXT_ATTRIBUTE = 'data-i18n';
const I18N_ATTRIBUTE_MAP = Object.freeze({
  'data-i18n-title': 'title',
  'data-i18n-placeholder': 'placeholder',
  'data-i18n-aria-label': 'aria-label',
});

/** Returns the localised message, or the key itself if it is missing. */
export function t(key, substitutions) {
  const message = chrome.i18n.getMessage(key, substitutions);
  return message === '' ? key : message;
}

/** Replaces the text of every [data-i18n] element in a document fragment. */
export function localiseDocument(root = document) {
  for (const element of root.querySelectorAll(`[${I18N_TEXT_ATTRIBUTE}]`)) {
    element.textContent = t(element.getAttribute(I18N_TEXT_ATTRIBUTE));
  }
  for (const [attribute, target] of Object.entries(I18N_ATTRIBUTE_MAP)) {
    for (const element of root.querySelectorAll(`[${attribute}]`)) {
      element.setAttribute(target, t(element.getAttribute(attribute)));
    }
  }
  document.documentElement.lang = chrome.i18n.getUILanguage();
}

const numberFormat = new Intl.NumberFormat(undefined);
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' });

export function formatNumber(value) {
  return numberFormat.format(Number(value) || 0);
}

export function formatDateTime(isoString) {
  if (!isoString) return null;
  const date = new Date(isoString);
  return Number.isNaN(date.getTime()) ? null : dateTimeFormat.format(date);
}

export function formatTime(isoString) {
  const date = new Date(isoString);
  return Number.isNaN(date.getTime()) ? '' : timeFormat.format(date);
}
