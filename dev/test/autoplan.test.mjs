/**
 * The auto-battle screen's one-press setup: what each kind of move is given,
 * and the order they are put in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { gameData, speciesIdBySlug } from '../../app/renderer/core/data.mjs';
import { suggestPolicy } from '../../app/renderer/engine/autoplan.mjs';
import { tunePolicy } from '../../app/renderer/engine/autotune.mjs';
import { defaultAutoBattle } from '../../app/renderer/engine/session.mjs';
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

test('a heal goes first, a priority attack is kept for striking first or finishing, and the attacks follow strongest first', options, () => {
  const plan = suggestPolicy(make('dragonite', ['quick-attack', 'dragon-claw', 'roost', 'outrage']));
  assert.deepEqual(plan.order, ['roost', 'quick-attack', 'outrage', 'dragon-claw']);
  assert.equal(plan.moves.roost, 'hpHalf');
  assert.equal(plan.moves['quick-attack'], 'inDanger');
  assert.equal(plan.second['quick-attack'], 'canFinish');
});

test('a boost that feeds none of its attacks, and a Growl, are switched off', options, () => {
  const plan = suggestPolicy(make('alakazam', ['psychic', 'swords-dance', 'growl']));
  assert.equal(plan.moves['swords-dance'], 'never');
  assert.equal(plan.moves.growl, 'never');
  assert.deepEqual(plan.order.slice(-2).sort(), ['growl', 'swords-dance']);
});

test('a screen waits for the attacker it answers', options, () => {
  const plan = suggestPolicy(make('mr-mime', ['psychic', 'reflect', 'light-screen']));
  assert.equal(plan.moves.reflect, 'foePhysical');
  assert.equal(plan.moves['light-screen'], 'foeSpecial');
});

test('the trial run keeps what wins more, against the same opponents every time', options, async () => {
  const area = gameData().areas[0];
  const pokemon = make('gengar', ['shadow-ball', 'hypnosis', 'nasty-plot', 'protect']);
  const before = JSON.stringify(pokemon);
  const seen = [];
  const run = () => tunePolicy({ pokemon, area, classes: [], current: defaultAutoBattle() }, { battles: 9, onProgress: (share) => seen.push(share) });
  const first = await run();
  assert.equal(JSON.stringify(pokemon), before, 'the companion itself is left alone');
  assert.equal(first.after.battles, 9);
  assert.deepEqual(new Set(first.order), new Set(['shadow-ball', 'hypnosis', 'nasty-plot', 'protect']));
  assert.equal(seen.at(-1), 1);
  const second = await run();
  assert.deepEqual(second, first, 'the same draw, the same answer');
});

test('field moves that pay off over turns are kept for trainers, and only when they help', options, () => {
  assert.equal(suggestPolicy(make('charizard', ['flamethrower', 'sunny-day'])).moves['sunny-day'], 'trainerBattle');
  assert.equal(suggestPolicy(make('charizard', ['air-slash', 'rain-dance'])).moves['rain-dance'], 'never');
  assert.equal(suggestPolicy(make('forretress', ['gyro-ball', 'spikes'])).moves.spikes, 'trainerBattle');
});
