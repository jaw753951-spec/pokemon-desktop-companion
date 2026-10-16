/**
 * Finding an item in a pocket by what it is called or what it says, for the
 * bag's item tab and the shop alike — and a machine by its move's numbers
 * too: "불 특수" is the special Fire-type moves, "불 50" the Fire-type ones
 * with 50 power or 50 accuracy.
 *
 * Both rebuild their whole page on every press, and a search box rebuilt on
 * every letter would lose the caret after each one. So the box only hides
 * and shows the rows already on the page, and the words in it are kept in
 * the tab's own state for whatever the next rebuild puts there.
 */
import { gameData, itemOf, moveOf } from '../core/data.mjs';
import { el } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';

/** The kinds of move, by the key their names are under. */
const MOVE_CLASSES = ['physical', 'special', 'status'];

/**
 * What an item can be found by. Its name and description always; for a
 * machine, also the move it teaches — its name and what it does — and the
 * move's type, kind and numbers, each matched only as what it is.
 *
 * @typedef {{text: string, type?: string, kind?: string, numbers?: number[]}} SearchEntry
 *   `type` and `kind` are the move's, in the words the screen shows them;
 *   `numbers` its power, accuracy and PP
 */

/**
 * @param {string} slug
 * @returns {SearchEntry}
 */
export function searchEntry(slug) {
  const item = itemOf(slug);
  if (!item) return { text: '' };
  const move = item.pocket === 'machines' && item.move ? moveOf(item.move) : null;
  const text = [
    localized(item.name, slug),
    localized(item.text, ''),
    move ? localized(move.name, item.move) : '',
    move ? localized(move.text, '') : '',
  ].join('\n').toLowerCase();
  if (!move) return { text };
  return {
    text,
    type: typeName(move.type).toLowerCase(),
    kind: t(`move.class.${move.damageClass ?? 'status'}`).toLowerCase(),
    numbers: [move.power, move.accuracy, move.pp].filter((value) => typeof value === 'number'),
  };
}

/** @param {string|undefined} type */
const typeName = (type) => localized(gameData().types?.[type ?? '']?.name, type ?? '');

/**
 * What a word of a search asks for, where it is more than a word to find in
 * the text: a number, or the name of a type or a kind of move — the whole of
 * one, or the start of one ("불" for 불꽃). A word that is the whole name of
 * one is that one alone: "물" is the Water type, not Water and 물리 both.
 *
 * @param {string} word lower-cased
 * @returns {{number: number}|{types: string[], kinds: string[]}|null}
 */
function fieldWord(word) {
  if (/^\d+$/.test(word)) return { number: Number(word) };
  const types = Object.keys(gameData().types ?? {}).map((type) => typeName(type).toLowerCase()).filter(Boolean);
  const kinds = MOVE_CLASSES.map((kind) => t(`move.class.${kind}`).toLowerCase());
  const whole = { types: types.filter((name) => name === word), kinds: kinds.filter((name) => name === word) };
  if (whole.types.length || whole.kinds.length) return whole;
  const start = { types: types.filter((name) => name.startsWith(word)), kinds: kinds.filter((name) => name.startsWith(word)) };
  return start.types.length || start.kinds.length ? start : null;
}

/**
 * Whether an item has every word of a search, in any order. An empty search
 * matches everything.
 *
 * For a machine a number is one of its move's numbers, and a type or a kind
 * is the move's own: a move whose description happens to say 특수공격 is not
 * a special move. Anything else — and every word, for any other item — is
 * looked for in the names and the descriptions.
 *
 * @param {SearchEntry} entry
 * @param {string} query
 */
export function matchesSearch(entry, query) {
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => {
    const field = entry.numbers ? fieldWord(word) : null;
    if (!field) return entry.text.includes(word);
    if ('number' in field) return /** @type {number[]} */ (entry.numbers).includes(field.number);
    return field.types.includes(entry.type ?? '') || field.kinds.includes(entry.kind ?? '');
  });
}

/**
 * Hide the rows of a list the search does not match, and say so when none is
 * left. A row that is not an item — a badge — is found by what it shows.
 *
 * @param {HTMLElement} list
 * @param {string} query
 */
export function applySearch(list, query) {
  let left = 0;
  for (const node of list.querySelectorAll('.item-row')) {
    const row = /** @type {HTMLElement} */ (node);
    const slug = row.dataset.slug ?? '';
    const entry = itemOf(slug) ? searchEntry(slug) : { text: (row.textContent ?? '').toLowerCase() };
    row.hidden = !matchesSearch(entry, query);
    if (!row.hidden) left++;
  }
  // The badges' heading goes with the last of its badges.
  for (const heading of list.querySelectorAll('.pocket-heading')) {
    /** @type {HTMLElement} */ (heading).hidden = !list.querySelector('.badge-row:not([hidden])');
  }
  let none = /** @type {HTMLElement|null} */ (list.querySelector('.search-empty'));
  if (!none) {
    none = el('div.empty.search-empty', { text: t('items.noMatch') });
    list.append(none);
  }
  none.hidden = left > 0 || list.querySelectorAll('.item-row').length === 0;
}

/**
 * The search box at the end of a row of pockets.
 *
 * @param {{query?: string}} state where the words are kept between rebuilds
 * @param {() => HTMLElement|null} list the list it narrows, as it stands now
 * @returns {HTMLInputElement}
 */
export function searchBox(state, list) {
  const input = /** @type {HTMLInputElement} */ (el('input.item-search', {
    type: 'search',
    value: state.query ?? '',
    // No words while it is empty, only the magnifier the style draws; a
    // placeholder is still given, a blank one, for the style to tell an empty
    // box by. The label is for a screen reader.
    placeholder: ' ',
    'aria-label': t('items.search'),
  }));
  input.addEventListener('input', () => {
    state.query = input.value;
    const shown = list();
    if (shown) applySearch(shown, state.query);
  });
  return input;
}
