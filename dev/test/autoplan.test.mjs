/**
 * The auto-battle screen's one-press setup: what each kind of move is given,
 * and the order they are put in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { speciesIdBySlug } from '../../app/renderer/core/data.mjs';
import { suggestPolicy } from '../../app/renderer/engine/autoplan.mjs';
import { createPokemon, setMove } from '../../app/renderer/engine/pokemon.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

/** @param {string} slug @param {string[]} moves */
function make(slug, moves) {
  const pokemon = createPokemon(new Rng(1), /** @type {number} */ (speciesIdBySlug(slug)), 50, { ivFloor: 31 });
  pokemon.moves = [];
  moves.forEach((move, index) => setMove(pokemon, index, move));
  return pokemon;
}

test('each kind of move gets the conditions that suit it', options, () => {
  const plan = suggestPolicy(make('gengar', ['shadow-ball', 'hypnosis', 'nasty-plot', 'protect']));
  assert.equal(plan.moves['shadow-ball'], 'always');
  assert.equal(plan.moves.hypnosis, 'foeHpAboveHalf');
  assert.equal(plan.moves['nasty-plot'], 'oncePerBattle');
  assert.equal(plan.moves.protect, 'never');
  assert.equal(plan.second.protect, 'never');
});

test('a heal goes first, a priority attack is kept for finishing, and the attacks follow strongest first', options, () => {
  const plan = suggestPolicy(make('dragonite', ['quick-attack', 'dragon-claw', 'roost', 'outrage']));
  assert.deepEqual(plan.order, ['roost', 'quick-attack', 'outrage', 'dragon-claw']);
  assert.equal(plan.moves.roost, 'hpHalf');
  assert.equal(plan.moves['quick-attack'], 'foeHpQuarter');
  assert.equal(plan.second['quick-attack'], 'always');
});

test('a boost that feeds none of its attacks, and a Growl, are switched off', options, () => {
  const plan = suggestPolicy(make('alakazam', ['psychic', 'swords-dance', 'growl']));
  assert.equal(plan.moves['swords-dance'], 'never');
  assert.equal(plan.moves.growl, 'never');
  assert.deepEqual(plan.order.slice(-2).sort(), ['growl', 'swords-dance']);
});

test('field moves that pay off over turns are kept for trainers, and only when they help', options, () => {
  assert.equal(suggestPolicy(make('charizard', ['flamethrower', 'sunny-day'])).moves['sunny-day'], 'trainerBattle');
  assert.equal(suggestPolicy(make('charizard', ['air-slash', 'rain-dance'])).moves['rain-dance'], 'never');
  assert.equal(suggestPolicy(make('forretress', ['gyro-ball', 'spikes'])).moves.spikes, 'trainerBattle');
});
