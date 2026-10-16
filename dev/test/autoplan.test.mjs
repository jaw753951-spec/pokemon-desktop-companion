/**
 * The auto-battle screen's one-press setup: the conditions each move is given
 * by its rules, and the order they are put in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { speciesIdBySlug } from '../../app/renderer/core/data.mjs';
import { optimizeMoves, profileOf, suggestPolicy } from '../../app/renderer/engine/autoplan.mjs';
import { createPokemon, setMove } from '../../app/renderer/engine/pokemon.mjs';
import { defaultAutoBattle, Session } from '../../app/renderer/engine/session.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

/** @param {string} slug @param {string[]} moves @param {string} [ability] */
function make(slug, moves, ability) {
  const pokemon = createPokemon(new Rng(1), /** @type {number} */ (speciesIdBySlug(slug)), 50, { ivFloor: 31 });
  pokemon.nature = 'hardy';
  pokemon.moves = [];
  moves.forEach((move, index) => setMove(pokemon, index, move));
  if (ability) pokemon.ability = ability;
  return pokemon;
}

/**
 * Each move's first and second, as `first/second`.
 * @param {string} species @param {string[]} moves @param {string} [ability]
 */
const pairs = (species, moves, ability) => {
  const plan = suggestPolicy(make(species, moves, ability));
  return Object.fromEntries(plan.order.map((slug) => [slug, `${plan.moves[slug]}/${plan.second[slug]}`]));
};

test('the build is read from the stats: bulky or not, fast or slow', options, () => {
  assert.equal(profileOf(make('blissey', ['pound'])).bulky, true);
  assert.equal(profileOf(make('alakazam', ['psychic'])).bulky, false);
  assert.equal(profileOf(make('alakazam', ['psychic'])).fast, true);
  assert.equal(profileOf(make('snorlax', ['body-slam'])).slow, true);
});

test('attacks are left to the hardest hit; the costly ones are kept to finish', options, () => {
  const plan = pairs('charizard', ['flamethrower', 'overheat', 'hyper-beam', 'solar-beam']);
  assert.equal(plan.flamethrower, 'always/never');
  assert.equal(plan.overheat, 'canFinish/never', 'a sharp fall in its own Sp. Atk');
  assert.equal(plan['hyper-beam'], 'canFinish/never', 'a turn recharging');
  assert.equal(plan['solar-beam'], 'never/never', 'a turn standing still, with something else to hit with');
  // With nothing else to do the work, each is just an attack.
  assert.equal(pairs('charizard', ['overheat'])['overheat'], 'always/never');
  assert.equal(pairs('charizard', ['hyper-beam', 'scratch'])['hyper-beam'], 'always/never');
});

test('a weak priority attack finishes or swings last; a strong one is just an attack', options, () => {
  const plan = pairs('dragonite', ['quick-attack', 'extreme-speed', 'dragon-claw']);
  assert.equal(plan['quick-attack'], 'canFinish/hpQuarter');
  assert.equal(plan['extreme-speed'], 'always/never');
});

test('an attack with a moment of its own is used at it, and is an ordinary attack otherwise', options, () => {
  const plan = pairs('gengar', ['hex', 'dream-eater', 'shadow-ball', 'fake-out']);
  assert.equal(plan.hex, 'foeStatus/always');
  assert.equal(plan['dream-eater'], 'foeAsleep/never');
  assert.equal(plan['fake-out'], 'oncePerFoe/never', 'once against each foe, its first turn out unless something comes first');
  assert.equal(pairs('hawlucha', ['acrobatics', 'close-combat'])['acrobatics'], 'noItem/always');
  assert.equal(pairs('zapdos', ['thunder', 'drill-peck'])['thunder'], 'always/never', 'an ordinary attack, the weather aside');
  assert.equal(pairs('gengar', ['nightmare', 'shadow-ball'])['nightmare'], 'foeAsleep/never');
  const ursaring = pairs('ursaring', ['facade', 'reversal', 'slash', 'counter']);
  assert.equal(ursaring.facade, 'selfStatus/always');
  assert.equal(ursaring.reversal, 'hpQuarter/never');
  assert.equal(ursaring.counter, 'never/never');
});

test('a heal waits for half health, or a third for something fast and frail', options, () => {
  assert.equal(pairs('blissey', ['soft-boiled', 'seismic-toss'])['soft-boiled'], 'hpHalf/never');
  assert.equal(pairs('starmie', ['recover', 'surf'])['recover'], 'hpThird/never');
  assert.equal(pairs('snorlax', ['rest', 'body-slam'])['rest'], 'hpThird/never');
  const sleeper = pairs('snorlax', ['rest', 'sleep-talk', 'body-slam']);
  assert.equal(sleeper.rest, 'hpHalf/never');
  assert.equal(sleeper['sleep-talk'], 'selfStatus/never');
});

test('each condition goes on the foe it suits', options, () => {
  // A sure sleep on a healthy foe, an unreliable one once per foe.
  assert.equal(pairs('breloom', ['spore', 'seed-bomb'])['spore'], 'foeHpAboveHalf/never');
  assert.equal(pairs('gengar', ['hypnosis', 'shadow-ball'])['hypnosis'], 'oncePerFoe/never');
  // Paralysis for something not fast; a burn for a physical foe.
  assert.equal(pairs('snorlax', ['thunder-wave', 'body-slam'])['thunder-wave'], 'slower/never');
  assert.equal(pairs('gengar', ['will-o-wisp', 'shadow-ball'])['will-o-wisp'], 'foePhysical/never');
  // The slow conditions only for something bulky.
  assert.equal(pairs('blissey', ['toxic', 'seismic-toss'])['toxic'], 'foeHpAboveHalf/never');
  assert.equal(pairs('alakazam', ['toxic', 'psychic'])['toxic'], 'never/never');
});

test('a boost is used when it feeds its own attacks, and again after it is lowered', options, () => {
  const scyther = pairs('scyther', ['swords-dance', 'x-scissor', 'agility', 'double-team']);
  assert.equal(scyther['swords-dance'], 'oncePerBattle/rankDown');
  assert.equal(scyther.agility, 'slower/never');
  assert.equal(scyther['double-team'], 'never/never');
  assert.equal(pairs('alakazam', ['swords-dance', 'psychic'])['swords-dance'], 'never/never', 'feeds nothing');
  // A guard alone only with something that pays off on it.
  assert.equal(pairs('cloyster', ['iron-defense', 'icicle-spear'])['iron-defense'], 'never/never');
  assert.equal(pairs('cloyster', ['iron-defense', 'body-press'])['iron-defense'], 'oncePerBattle/rankDown');
  // A Leer is off; two stages off what it hits into, once per foe.
  assert.equal(pairs('scyther', ['leer', 'x-scissor'])['leer'], 'never/never');
  assert.equal(pairs('scyther', ['screech', 'x-scissor'])['screech'], 'oncePerFoe/never');
});

test('the field is set where it helps: weather for its attacks, screens for the attacker they stop', options, () => {
  assert.equal(pairs('charizard', ['flamethrower', 'sunny-day'])['sunny-day'], 'noField/never');
  assert.equal(pairs('charizard', ['flamethrower', 'rain-dance'])['rain-dance'], 'never/never');
  assert.equal(pairs('charizard', ['flamethrower', 'sunny-day'], 'drought')['sunny-day'], 'never/never', 'it brings its own');
  const mime = pairs('mr-mime', ['psychic', 'reflect', 'light-screen']);
  assert.equal(mime.reflect, 'foePhysical/never');
  assert.equal(mime['light-screen'], 'foeSpecial/never');
  assert.equal(pairs('forretress', ['gyro-ball', 'spikes'])['spikes'], 'trainerBattle/never');
  // A Protect only with something ticking on the foe.
  assert.equal(pairs('blissey', ['protect', 'seismic-toss'])['protect'], 'never/never');
  assert.equal(pairs('blissey', ['protect', 'toxic', 'seismic-toss'])['protect'], 'everyThreeTurns/never');
});

test('the order: heal, the foe\'s conditions, boosts, field, moment attacks, then attacks by power', options, () => {
  assert.deepEqual(suggestPolicy(make('dragonite', ['quick-attack', 'dragon-claw', 'roost', 'outrage'])).order,
    ['roost', 'quick-attack', 'outrage', 'dragon-claw']);
  assert.deepEqual(suggestPolicy(make('gengar', ['shadow-ball', 'hex', 'will-o-wisp', 'protect'])).order,
    ['will-o-wisp', 'protect', 'hex', 'shadow-ball']);
});

test('a Pokémon setting out for the first time starts optimized, and one that has travelled keeps its own', options, () => {
  const plan = (/** @type {any} */ pokemon) => {
    const copy = structuredClone(pokemon);
    const policy = defaultAutoBattle();
    optimizeMoves(copy, policy);
    return { order: copy.moves.map((/** @type {any} */ slot) => slot.move), moves: policy.moves, second: policy.second };
  };
  const gengar = make('gengar', ['shadow-ball', 'hypnosis', 'dream-eater', 'fake-out']);
  const blissey = make('blissey', ['soft-boiled', 'body-slam', 'toxic', 'protect']);
  const veteran = make('alakazam', ['psychic', 'recover']);
  veteran.badges = ['rock'];
  const expected = plan(blissey);

  const session = new Session({ slot: 0, save: { seed: 1, party: { active: gengar, box: [blissey, veteran] } } });
  assert.ok(session.active.travelled, 'whoever is travelling counts as having travelled');
  session.autoBattle.moves['shadow-ball'] = 'hpHalf';

  session.switchActive(0);
  assert.equal(session.active, blissey);
  assert.deepEqual(blissey.moves.map((slot) => slot.move), expected.order);
  for (const slug of expected.order) {
    assert.equal(session.autoBattle.moves[slug], expected.moves[slug], `${slug}'s first`);
    assert.equal(session.autoBattle.second[slug], expected.second[slug], `${slug}'s second`);
  }
  assert.ok(blissey.travelled);

  // Back to the one that travelled before: its settings are left alone.
  session.switchActive(0);
  assert.equal(session.active, gengar);
  assert.equal(session.autoBattle.moves['shadow-ball'], 'hpHalf');

  // And one from an older save that won a badge travelling.
  const before = structuredClone(session.autoBattle);
  session.switchActive(1);
  assert.equal(session.active, veteran);
  assert.deepEqual(session.autoBattle, before);
});
