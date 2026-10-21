/**
 * A Pokémon put back to level 5 on being caught knows what level 5 knows, and
 * an evolution item one Pokémon alone uses says whose it is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { gameData, speciesIdBySlug } from '../../app/renderer/core/data.mjs';
import { CAUGHT_LEVEL, createPokemon, isAttack, resetToLevel } from '../../app/renderer/engine/pokemon.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

/** @param {string} slug */
const caught = (slug) => {
  const pokemon = createPokemon(new Rng(1), /** @type {number} */ (speciesIdBySlug(slug)), 60, {});
  resetToLevel(pokemon, CAUGHT_LEVEL);
  return pokemon.moves.map((slot) => slot.move);
};

test('an attack with no listed power still hits; one that only answers does not', options, () => {
  assert.equal(isAttack('low-kick'), true);
  assert.equal(isAttack('seismic-toss'), true);
  assert.equal(isAttack('night-shade'), true);
  assert.equal(isAttack('counter'), false);
  assert.equal(isAttack('mirror-coat'), false);
});

test('a catch back at level 5 is given the attack nearest its level, not its strongest', options, () => {
  // Darkrai's first attack comes at 11; its Dark Pulse is a level-93 move.
  const darkrai = caught('darkrai');
  assert.ok(!darkrai.includes('dark-pulse'), `${darkrai}`);
  assert.ok(darkrai.includes('quick-attack'), `${darkrai}`);
  // A Machop's Low Kick is an attack, so it needs nothing from level 52.
  assert.ok(!caught('machop').includes('double-edge'));
  assert.ok(!caught('shaymin').includes('seed-flare'));
});

test('an evolution item only one Pokémon uses names it', options, () => {
  const { items } = gameData();
  assert.match(items.electirizer.text.ko, /에레브가 좋아하는/);
  assert.match(items.electirizer.text.en, /loved by Electabuzz/);
  // The particle after a number is read as the number is said.
  assert.match(items['dubious-disc'].text.ko, /폴리곤2가 좋아하는/);
  assert.match(items['masterpiece-teacup'].text.ko, /차데스를 진화시키는/);
  // Several users: the game's own wording stays.
  assert.match(items['fire-stone'].text.ko, /어느 특정 포켓몬/);
});
