/**
 * Localization.
 *
 * Which languages exist comes from the sheet in `data/authored/i18n`; the UI
 * strings come from the file each row names, and Pokémon, move, item and area
 * names come from the generated data, where every record files its text under
 * the same language codes. `t` is for the former, `name` for the latter.
 *
 * Nothing here knows a language by name: a row in the sheet and its string file
 * are all a new one needs.
 */
import {
  defaultLanguage,
  fallbackChain,
  findLanguage,
  LANGUAGES_FILE,
  normalizeLanguages,
} from '../../shared/languages.mjs';
import { loadJson } from './bridge.mjs';
import { resolveParticles } from './korean.mjs';

/** The grammar helpers a sheet row may ask for by name. */
const GRAMMAR = {
  korean: resolveParticles,
};

/** The helper names a sheet's `grammar` column may use. */
export const GRAMMARS = Object.keys(GRAMMAR);

/** @type {import('../../shared/languages.mjs').Language[]} */
let catalogue = [];
/** @type {import('../../shared/languages.mjs').Language|null} */
let current = null;
/** Language codes in the order text is read, the current one first. */
let chain = /** @type {string[]} */ ([]);
/** Loaded string files, keyed by language code. */
let strings = /** @type {Record<string, Record<string, string>>} */ ({});

/**
 * Read the sheet, once per run.
 * @returns {Promise<import('../../shared/languages.mjs').Language[]>}
 */
export async function loadLanguages() {
  if (!catalogue.length) catalogue = normalizeLanguages(await loadJson('authored', LANGUAGES_FILE));
  return catalogue;
}

/** Every language the sheet lists, in its order. */
export const languages = () => catalogue;

/** @returns {string} */
export const language = () => current?.code ?? '';

/**
 * Switch to a language, loading the strings it reads through to.
 *
 * A code the sheet does not list — an old settings file, or a language dropped
 * from the sheet — falls back to the default rather than leaving the UI blank.
 *
 * @param {string} code
 * @returns {Promise<string>} the language actually in use
 */
export async function setLanguage(code) {
  await loadLanguages();
  current = findLanguage(catalogue, code) ?? defaultLanguage(catalogue);
  chain = current ? fallbackChain(catalogue, current.code) : [];

  // The whole chain is loaded, not just the chosen language: the string files
  // are a few kilobytes each, and it is what lets a half-written translation
  // show the rest of the game in the language it falls back to.
  await Promise.all(chain.map(loadStrings));

  document.documentElement.lang = current?.code ?? '';
  return current?.code ?? '';
}

/**
 * A missing or unreadable string file leaves that language empty rather than
 * failing the boot, so a row added to the sheet before its translation exists
 * still leaves a playable game.
 * @param {string} code
 */
async function loadStrings(code) {
  if (strings[code]) return;
  const language = findLanguage(catalogue, code);
  if (!language) return;
  try {
    strings[code] = await loadJson('authored', language.strings);
  } catch (error) {
    console.warn(`No strings for "${code}" at ${language.strings}`, error);
    strings[code] = {};
  }
}

/**
 * Look up a UI string, substituting `{placeholders}`.
 *
 * A key missing from every language returns the key itself: a visibly wrong
 * label in the UI is easier to spot and fix than a silent blank.
 *
 * @param {string} key
 * @param {Record<string, string|number>} [values]
 * @returns {string}
 */
export function t(key, values) {
  const found = lookup(key);
  const template = found?.text ?? key;
  const filled = values
    ? template.replace(/\{(\w+)\}/g, (match, name2) => (name2 in values ? String(values[name2]) : match))
    : template;
  // The grammar of the language the string was written in, which is not always
  // the chosen one when the lookup fell through to another.
  return applyGrammar(filled, found?.code);
}

/**
 * The first language along the chain that has the key.
 * @param {string} key
 * @returns {{text: string, code: string}|null}
 */
function lookup(key) {
  for (const code of chain) {
    const text = strings[code]?.[key];
    if (typeof text === 'string' && text !== '') return { text, code };
  }
  return null;
}

/**
 * @param {string} text
 * @param {string|undefined} code
 */
function applyGrammar(text, code) {
  const grammar = findLanguage(catalogue, code)?.grammar;
  const helper = grammar ? GRAMMAR[grammar] : null;
  return helper ? helper(text) : text;
}

/**
 * The current language's side of a `{ko, en, …}` bundle from the generated
 * data, falling through the same chain as the UI strings.
 *
 * @param {Record<string, string>|null|undefined} bundle
 * @param {string} [fallback]
 * @returns {string}
 */
export function name(bundle, fallback = '') {
  if (!bundle) return fallback;
  for (const code of chain) {
    if (bundle[code]) return bundle[code];
  }
  // Before a language is set — a unit test reaching into the data, say — any
  // side of the bundle beats showing nothing.
  if (!chain.length) return Object.values(bundle).find(Boolean) ?? fallback;
  return fallback;
}

/**
 * Playtime reads the same in every language the game ships, so it is formatted
 * rather than translated.
 * @param {number} milliseconds
 */
export function formatPlaytime(milliseconds) {
  const totalMinutes = Math.floor(Math.max(0, milliseconds) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Drop everything loaded, so a test can drive the module from a clean slate.
 * Not used by the game itself.
 */
export function resetLanguages() {
  catalogue = [];
  current = null;
  chain = [];
  strings = {};
}
