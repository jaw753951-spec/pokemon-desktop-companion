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
  // And not on a name that is only a word: a Magmarizer's 마그마 is magma.
  assert.match(items.magmarizer.text.ko, /마그마가 좋아하는/);
});

test('an item made for one species names it', options, () => {
  const { items } = gameData();
  assert.match(items['fire-memory'].text.ko, /실버디가 지니면/);
  assert.match(items['fire-memory'].text.en, /held by Silvally/);
  assert.match(items['red-nectar'].text.ko, /춤추새의 모습을/);
  assert.match(items['red-nectar'].text.en, /form of Oricorio/);
});

test('a catch back at level 5 knows what its line knows by then, not what the move reminder lists', options, () => {
  // Granbull lists Outrage at level 1, for the reminder; no Snubbull learns it.
  const granbull = caught('granbull');
  assert.ok(!granbull.includes('outrage'), `${granbull}`);
  // What it does know is what a Snubbull knows by level 5.
  const snubbull = gameData().species[/** @type {number} */ (speciesIdBySlug('snubbull'))].learnset.level
    .filter(([at]) => at <= 5)
    .map(([, move]) => move);
  assert.ok(granbull.length > 0 && granbull.every((move) => snubbull.includes(move)), `${granbull}`);
  // A species that evolves from nothing keeps its own level-1 moves.
  assert.ok(caught('snubbull').length > 0);
});

test('a catch from before level 5 was given its own moves is given them when the save loads', options, async () => {
  const { refreshCaughtMoves, FRESH_CATCH_MOVES_SINCE, levelOf } = await import('../../app/renderer/engine/pokemon.mjs');
  const old = createPokemon(new Rng(1), /** @type {number} */ (speciesIdBySlug('granbull')), 60, {});
  resetToLevel(old, CAUGHT_LEVEL);
  const fresh = old.moves.map((slot) => slot.move);
  // What the old rule gave it: the reminder's Outrage among them.
  old.moves = ['outrage', 'tackle', 'scary-face', 'tail-whip'].map((move) => ({ move, pp: 5 }));
  old.caughtAt = FRESH_CATCH_MOVES_SINCE - 1000;
  assert.equal(refreshCaughtMoves(old), true);
  assert.deepEqual(old.moves.map((slot) => slot.move), fresh);
  assert.equal(levelOf(old), CAUGHT_LEVEL);
  // A second load leaves it as it is.
  assert.equal(refreshCaughtMoves(old), false);

  // One raised since keeps what it has, and so does one caught since.
  const raised = { ...old, moves: [{ move: 'outrage', pp: 5 }], experience: old.experience + 1 };
  assert.equal(refreshCaughtMoves(raised), false);
  const recent = { ...old, moves: [{ move: 'outrage', pp: 5 }], caughtAt: FRESH_CATCH_MOVES_SINCE + 1000 };
  assert.equal(refreshCaughtMoves(recent), false);
});
