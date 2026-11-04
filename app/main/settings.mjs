/**
 * User settings: window scale, volumes, language and whether the field's
 * windows hide while the pointer is away.
 *
 * Kept in `userData` so it survives updates, and merged over the defaults on
 * read so a settings file written by an older version stays loadable.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { defaultLanguage, findLanguage } from '../shared/languages.mjs';
import { loadLanguages } from './languages.mjs';
import { SETTINGS_FILE } from './paths.mjs';

/** @typedef {{scale: number, masterVolume: number, musicVolume: number, effectVolume: number, cryVolume: number, hideIdleHud: boolean, language: string, windowX: number|null, windowY: number|null}} Settings */

/**
 * Everything but the language, whose default is whichever one the sheet marks
 * rather than a code written here.
 * @type {Omit<Settings, 'language'>}
 */
export const DEFAULTS = {
  scale: 1,
  masterVolume: 1,
  musicVolume: 0.6,
  effectVolume: 0.8,
  cryVolume: 0.9,
  hideIdleHud: true,
  windowX: null,
  windowY: null,
};

/** Window scale steps the settings screen offers. */
export const SCALE_STEPS = [0.75, 1, 1.25, 1.5, 2];

/** @type {Settings|null} */
let cached = null;

/** @returns {Promise<Settings>} */
export async function loadSettings() {
  if (cached) return cached;
  const languages = await loadLanguages();
  try {
    const raw = JSON.parse(await readFile(SETTINGS_FILE, 'utf8'));
    cached = sanitize({ ...DEFAULTS, ...raw }, languages);
  } catch {
    cached = sanitize({ ...DEFAULTS }, languages);
  }
  return cached;
}

/**
 * @param {Partial<Settings>} patch
 * @returns {Promise<Settings>}
 */
export async function saveSettings(patch) {
  const current = await loadSettings();
  cached = sanitize({ ...current, ...patch }, await loadLanguages());
  await mkdir(dirname(SETTINGS_FILE), { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(cached, null, 2));
  return cached;
}

/**
 * Clamp everything to a usable range: a corrupt or hand-edited file should
 * never leave the window at zero size or the audio at a broken gain.
 *
 * @param {any} settings
 * @param {import('../shared/languages.mjs').Language[]} languages
 * @returns {Settings}
 */
function sanitize(settings, languages) {
  const nearest = SCALE_STEPS.reduce((best, step) =>
    Math.abs(step - settings.scale) < Math.abs(best - settings.scale) ? step : best,
  );
  return {
    scale: nearest,
    masterVolume: clamp01(settings.masterVolume),
    musicVolume: clamp01(settings.musicVolume),
    effectVolume: clamp01(settings.effectVolume),
    cryVolume: clamp01(settings.cryVolume),
    hideIdleHud: settings.hideIdleHud !== false,
    language: pickLanguage(settings.language, languages),
    windowX: Number.isFinite(settings.windowX) ? Math.round(settings.windowX) : null,
    windowY: Number.isFinite(settings.windowY) ? Math.round(settings.windowY) : null,
  };
}

/**
 * The stored language if the sheet still lists it, the sheet's default if not.
 *
 * With no sheet to check against, whatever was stored is kept as it is: a
 * failed read is no reason to overwrite a perfectly good choice.
 *
 * @param {unknown} code
 * @param {import('../shared/languages.mjs').Language[]} languages
 * @returns {string}
 */
function pickLanguage(code, languages) {
  if (!languages.length) return typeof code === 'string' ? code : '';
  return (findLanguage(languages, /** @type {string} */ (code)) ?? defaultLanguage(languages))?.code ?? '';
}

const clamp01 = (value) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5);
