/**
 * The box's search: a Pokémon is found by its name — its species' or its
 * nickname — and by nothing else.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { setGameData } from '../../app/renderer/core/data.mjs';
import { matchesName } from '../../app/renderer/engine/pokemon.mjs';

setGameData(/** @type {any} */ ({
  species: {
    25: { id: 25, slug: 'pikachu', name: { ko: '피카츄' }, types: ['electric'] },
    26: { id: 26, slug: 'raichu', name: { ko: '라이츄' }, types: ['electric'] },
  },
}));

const pikachu = /** @type {any} */ ({ speciesId: 25 });
const named = /** @type {any} */ ({ speciesId: 26, nickname: 'Sparky' });

test("a Pokémon is found by any part of its species' name", () => {
  assert.equal(matchesName(pikachu, '피카'), true);
  assert.equal(matchesName(pikachu, '츄'), true);
  assert.equal(matchesName(pikachu, '라이'), false);
});

test('a nicknamed one is found by its nickname, in any case, and by its species too', () => {
  assert.equal(matchesName(named, 'spark'), true);
  assert.equal(matchesName(named, '라이츄'), true);
});

test('nothing but the name finds it: not its type, nor its number', () => {
  assert.equal(matchesName(pikachu, 'electric'), false);
  assert.equal(matchesName(pikachu, '25'), false);
});

test('an empty search finds every Pokémon, and an empty space never', () => {
  assert.equal(matchesName(pikachu, '  '), true);
  assert.equal(matchesName(null, ''), false);
});
