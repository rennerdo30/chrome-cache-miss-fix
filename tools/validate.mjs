/**
 * Static checks that catch the mistakes Chrome only reports at runtime:
 * missing files referenced from the manifest, and translation keys that exist
 * in one locale but not the other (or are used without being defined at all).
 *
 * Run: node tools/validate.mjs
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES_DIR = join(ROOT, '_locales');
const REFERENCE_LOCALE = 'en';
const SOURCE_EXTENSIONS = ['.js', '.mjs', '.html'];
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'icons']);

const MESSAGE_KEY_PATTERNS = [
  /__MSG_([A-Za-z0-9_]+)__/g,          // manifest and CSS
  /data-i18n(?:-[a-z-]+)?="([^"]+)"/g, // markup
  /\bt\(\s*'([A-Za-z0-9_]+)'/g,        // t('key') in scripts
];

/** Keys built at runtime from a known set, so they cannot be found by regex. */
const DYNAMIC_KEYS = ['levelError', 'levelWarn', 'levelInfo', 'levelDebug', 'levelTrace'];

const problems = [];
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      files.push(...walk(join(directory, entry.name)));
    } else if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

/* ------------------------------------------------------- manifest references */

const manifest = readJson(join(ROOT, 'manifest.json'));
const referencedPaths = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_ui?.page,
  ...Object.values(manifest.action?.default_icon ?? {}),
  ...Object.values(manifest.icons ?? {}),
].filter(Boolean);

for (const path of new Set(referencedPaths)) {
  if (!existsSync(join(ROOT, path))) problems.push(`manifest references missing file: ${path}`);
}

/* --------------------------------------------------------- locale completeness */

const locales = readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

if (!locales.includes(REFERENCE_LOCALE)) {
  problems.push(`missing reference locale "${REFERENCE_LOCALE}"`);
}

const messagesByLocale = new Map();
for (const locale of locales) {
  messagesByLocale.set(locale, readJson(join(LOCALES_DIR, locale, 'messages.json')));
}

const referenceKeys = Object.keys(messagesByLocale.get(REFERENCE_LOCALE) ?? {});
for (const [locale, messages] of messagesByLocale) {
  if (locale === REFERENCE_LOCALE) continue;
  const keys = Object.keys(messages);
  for (const key of referenceKeys) {
    if (!keys.includes(key)) problems.push(`${locale}: missing translation for "${key}"`);
  }
  for (const key of keys) {
    if (!referenceKeys.includes(key)) problems.push(`${locale}: extra key "${key}"`);
  }
  for (const [key, entry] of Object.entries(messages)) {
    const reference = messagesByLocale.get(REFERENCE_LOCALE)[key];
    const placeholders = Object.keys(entry.placeholders ?? {}).sort();
    const referencePlaceholders = Object.keys(reference?.placeholders ?? {}).sort();
    if (placeholders.join(',') !== referencePlaceholders.join(',')) {
      problems.push(`${locale}: placeholders of "${key}" do not match ${REFERENCE_LOCALE}`);
    }
  }
}

/* -------------------------------------------------------------- key usage */

const usedKeys = new Set(DYNAMIC_KEYS);
const sourceFiles = [join(ROOT, 'manifest.json'), ...walk(join(ROOT, 'src'))];

for (const file of sourceFiles) {
  const content = readFileSync(file, 'utf8');
  for (const pattern of MESSAGE_KEY_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const key = match[1];
      usedKeys.add(key);
      if (!referenceKeys.includes(key)) {
        problems.push(`${relative(ROOT, file)}: uses undefined message "${key}"`);
      }
    }
  }
}

// Keys can also reach t() through a variable or a ternary, which no regex can
// follow, so a plain quoted-literal search decides whether a key is unused.
const allSources = sourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
for (const key of referenceKeys) {
  if (usedKeys.has(key) || allSources.includes(`'${key}'`)) continue;
  problems.push(`unused message "${key}" in ${REFERENCE_LOCALE}`);
}

/* ------------------------------------------------------------------ report */

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`✖ ${problem}\n`);
  process.stderr.write(`\n${problems.length} problem(s) found.\n`);
  process.exit(1);
}

process.stdout.write(
  `✔ manifest, ${locales.length} locale(s) and ${referenceKeys.length} message(s) look consistent\n`,
);
