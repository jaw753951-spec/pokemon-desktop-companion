/**
 * Finding an item in a pocket: by its name, by what it says, and a machine
 * by the move it teaches — its type, its kind and its numbers as well.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { setGameData } from '../../app/renderer/core/data.mjs';
import { resetLanguages, setLanguage } from '../../app/renderer/core/i18n.mjs';
import { matchesSearch, searchEntry } from '../../app/renderer/ui/itemsearch.mjs';

// The move kinds' names, which the search reads in the language in use.
const SHEET = {
  'i18n/languages.json': { languages: [{ code: 'ko', label: '한국어', strings: 'i18n/ko.json', grammar: 'korean', default: true }] },
  'i18n/ko.json': { 'move.class.physical': '물리', 'move.class.special': '특수', 'move.class.status': '변화' },
};
const original = { fetch: globalThis.fetch, document: globalThis.document };
globalThis.fetch = /** @type {any} */ (async (url) => {
  const path = String(url).replace('pdc://authored/', '');
  return path in SHEET ? { ok: true, status: 200, json: async () => SHEET[path] } : { ok: false, status: 404, json: async () => ({}) };
});
globalThis.document = /** @type {any} */ ({ documentElement: { lang: '' } });
await setLanguage('ko');
test.after(() => {
  globalThis.fetch = original.fetch;
  globalThis.document = original.document;
  resetLanguages();
});

/** A machine for a move, named after its number. */
const machine = (number, move) => ({ pocket: 'machines', move, name: { ko: `기술머신${number}` }, text: { ko: '' } });

setGameData(
  /** @type {any} */ ({
    types: { fire: { name: { ko: '불꽃' } }, water: { name: { ko: '물' } }, electric: { name: { ko: '전기' } } },
    items: {
      potion: { pocket: 'medicine', name: { ko: '상처약' }, text: { ko: 'HP를 20 회복한다.' } },
      'sitrus-berry': { pocket: 'berries', name: { ko: '자뭉열매' }, text: { ko: '지니게 하면 HP가 1/2 이하일 때 회복한다.' } },
      tm24: machine('24', 'thunderbolt'),
      tm38: machine('38', 'fire-blast'),
      tm35: machine('35', 'flamethrower'),
      tm11: machine('11', 'will-o-wisp'),
      tm07: machine('07', 'flame-charge'),
      tm55: machine('55', 'scald'),
      tm03: machine('03', 'water-pulse'),
    },
    moves: {
      thunderbolt: { type: 'electric', damageClass: 'special', power: 90, accuracy: 100, pp: 15, name: { ko: '10만볼트' }, text: { ko: '강한 전격으로 공격한다. 마비될 때가 있다.' } },
      'fire-blast': { type: 'fire', damageClass: 'special', power: 110, accuracy: 85, pp: 5, name: { ko: '불대문자' }, text: { ko: '불꽃으로 공격한다.' } },
      flamethrower: { type: 'fire', damageClass: 'special', power: 90, accuracy: 100, pp: 15, name: { ko: '화염방사' }, text: { ko: '불꽃을 뿜는다.' } },
      'will-o-wisp': { type: 'fire', damageClass: 'status', power: null, accuracy: 85, pp: 15, name: { ko: '도깨비불' }, text: { ko: '화상 상태로 만든다.' } },
      'flame-charge': { type: 'fire', damageClass: 'physical', power: 50, accuracy: 100, pp: 20, name: { ko: '니트로차지' }, text: { ko: '불꽃을 두르고 공격한다.' } },
      scald: { type: 'water', damageClass: 'special', power: 80, accuracy: 100, pp: 15, name: { ko: '열탕' }, text: { ko: '뜨거운 물로 공격한다. 상대를 불태울 때가 있다.' } },
      'water-pulse': { type: 'water', damageClass: 'special', power: 60, accuracy: 100, pp: 20, name: { ko: '물의파동' }, text: { ko: '특수공격의 파동.' } },
    },
  }),
);

const ALL = ['potion', 'sitrus-berry', 'tm24', 'tm38', 'tm35', 'tm11', 'tm07', 'tm55', 'tm03'];
const MACHINES = ALL.filter((slug) => slug.startsWith('tm'));
const find = (query, among = ALL) => among.filter((slug) => matchesSearch(searchEntry(slug), query));

test('an empty search finds everything', () => {
  assert.deepEqual(find(''), ALL);
  assert.deepEqual(find('   '), ALL);
});

test('a name or a description finds it', () => {
  assert.deepEqual(find('상처'), ['potion']);
  assert.deepEqual(find('회복'), ['potion', 'sitrus-berry']);
  assert.deepEqual(find('hp'), ['potion', 'sitrus-berry'], 'in either case');
  assert.deepEqual(find('20', ['potion', 'sitrus-berry']), ['potion'], "a number is any item's text");
});

test('every word has to be there, in any order', () => {
  assert.deepEqual(find('회복 지니게'), ['sitrus-berry']);
  assert.deepEqual(find('지니게 상처'), []);
});

test('a machine is found by the move it teaches and what that does', () => {
  assert.deepEqual(find('10만'), ['tm24']);
  assert.deepEqual(find('마비'), ['tm24']);
  assert.deepEqual(find('기술머신2'), ['tm24']);
});

test("a type is the move's type, from the start of its name", () => {
  // 열탕 is a Water move whatever its description says about burning.
  assert.deepEqual(find('불', MACHINES), ['tm38', 'tm35', 'tm11', 'tm07']);
  assert.deepEqual(find('불꽃', MACHINES), ['tm38', 'tm35', 'tm11', 'tm07']);
  // The whole of a type's name is that type alone, not 물리 as well.
  assert.deepEqual(find('물', MACHINES), ['tm55', 'tm03']);
});

test("a kind is the move's kind, not a word in its description", () => {
  assert.deepEqual(find('불 특수', MACHINES), ['tm38', 'tm35']);
  assert.deepEqual(find('특수', MACHINES), ['tm24', 'tm38', 'tm35', 'tm55', 'tm03']);
  assert.deepEqual(find('물리', MACHINES), ['tm07']);
  assert.deepEqual(find('변화 불', MACHINES), ['tm11']);
});

test("a number is the move's power, accuracy or PP, exactly", () => {
  // Flame Charge has 50 power; nothing Fire has 50 accuracy here.
  assert.deepEqual(find('불 50', MACHINES), ['tm07']);
  assert.deepEqual(find('불 85', MACHINES), ['tm38', 'tm11'], 'accuracy');
  assert.deepEqual(find('불 5', MACHINES), ['tm38'], 'PP, and not the 5 in 85 or 15');
  assert.deepEqual(find('특수 100 15', MACHINES), ['tm24', 'tm35', 'tm55']);
});
