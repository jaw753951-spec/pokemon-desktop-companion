/**
 * Effort values, as the main series has them: each species' own yield paid
 * on its defeat, 252 a stat and 510 in all, a Macho Brace doubling it and a
 * Power item adding eight, and the items that train it — vitamins, feathers
 * and mochi — or take it away — the six berries and the Fresh-Start Mochi.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { gameData, speciesIdBySlug, speciesOf } from '../../app/renderer/core/data.mjs';
import { Battle, effectiveStat } from '../../app/renderer/engine/battle.mjs';
import { itemActions, useItem } from '../../app/renderer/engine/items.mjs';
import { pocketOrder } from '../../app/renderer/engine/bagorder.mjs';
import { createPokemon, friendshipOf, gainFromDefeat, levelOf, maxHp, statsOf } from '../../app/renderer/engine/pokemon.mjs';
import { defaultAutoBattle, Session } from '../../app/renderer/engine/session.mjs';
import { addEffort, effortTotal, settledEffort } from '../../app/renderer/engine/stats.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

const id = (slug) => /** @type {number} */ (speciesIdBySlug(slug));

/** @param {string} slug @param {number} level */
function make(slug, level) {
  const pokemon = createPokemon(new Rng(4), id(slug), level, { ivFloor: 31, shiny: false });
  pokemon.heldItem = null;
  pokemon.friendship = 0;
  return pokemon;
}

/** A bag holding what a test needs, and the Pokémon it is used on. */
function bag(contents, pokemon) {
  return /** @type {any} */ ({
    bag: { ...contents },
    active: pokemon,
    machines: [],
    box: [],
    area: { tags: [] },
    countOf(slug) {
      return this.bag[slug] ?? 0;
    },
    removeItem(slug, count = 1) {
      const held = this.bag[slug] ?? 0;
      if (held < count) return false;
      this.bag[slug] = held - count;
      return true;
    },
  });
}

/** What defeating one Pokémon pays, with the item the winner holds. */
function defeat(winner, loserSlug, held = null) {
  const species = speciesOf(id(loserSlug));
  const item = held ? gameData().items[held]?.held : null;
  return gainFromDefeat(
    winner,
    { baseStats: species.stats, baseExp: species.baseExp, level: 5, effort: species.effort },
    { effortMultiplier: item?.multiplier ?? 1, effortBonus: item?.bonus ?? null },
  );
}

test("every species carries its own yield, as the games' data has it", options, () => {
  assert.deepEqual(speciesOf(id('geodude')).effort, { def: 1 });
  assert.deepEqual(speciesOf(id('garchomp')).effort, { atk: 3 });
  assert.deepEqual(speciesOf(id('pikachu')).effort, { spe: 2 });
  // A regional variety has its own: an Alolan Geodude is still Defense.
  assert.deepEqual(speciesOf(id('geodude-alola')).effort, { def: 1 });
});

test('the 32 items are all in the bag again', options, () => {
  const items = gameData().items;
  const stats = ['health', 'muscle', 'resist', 'genius', 'clever', 'swift'];
  const slugs = [
    'hp-up', 'protein', 'iron', 'calcium', 'zinc', 'carbos',
    ...stats.map((stat) => `${stat}-wing`),
    'pomeg-berry', 'kelpsy-berry', 'qualot-berry', 'hondew-berry', 'grepa-berry', 'tamato-berry',
    ...stats.map((stat) => `${stat}-mochi`), 'fresh-start-mochi',
    'macho-brace', 'power-weight', 'power-bracer', 'power-belt', 'power-lens', 'power-band', 'power-anklet',
  ];
  assert.equal(slugs.length, 32);
  for (const slug of slugs) assert.ok(items[slug], `${slug} is carried`);
  assert.deepEqual(items['protein'].use.effort, { stat: 'atk', amount: 10, friendship: [5, 3, 2] });
  assert.deepEqual(items['swift-wing'].use.effort, { stat: 'spe', amount: 1, friendship: [3, 2, 1] });
  assert.deepEqual(items['tamato-berry'].use.effort, { stat: 'spe', amount: -10, friendship: [10, 5, 2] });
  assert.deepEqual(items['genius-mochi'].use.effort, { stat: 'spa', amount: 10 });
  assert.deepEqual(items['power-anklet'].held.bonus, { stat: 'spe', amount: 8 });
  assert.equal(items['macho-brace'].held.multiplier, 2);
});

test('a defeat pays the species yield, doubled by a Macho Brace, eight more by a Power item', options, () => {
  const pokemon = make('machop', 30);
  assert.deepEqual(defeat(pokemon, 'geodude').effort, { hp: 0, atk: 0, def: 1, spa: 0, spd: 0, spe: 0 });
  assert.equal(pokemon.evs.def, 1);

  assert.equal(defeat(pokemon, 'geodude', 'macho-brace').effort.def, 2);
  // A Power Bracer pays its eight in Attack on top of the Defense the
  // Geodude was worth.
  const bracer = defeat(pokemon, 'geodude', 'power-bracer').effort;
  assert.equal(bracer.def, 1);
  assert.equal(bracer.atk, 8);
  assert.deepEqual(pokemon.evs, { hp: 0, atk: 8, def: 4, spa: 0, spd: 0, spe: 0 });
});

test('effort stops at 252 a stat and 510 in all', () => {
  assert.deepEqual(addEffort({ atk: 250 }, { atk: 10 }).atk, 252);
  const full = addEffort({ atk: 252, spe: 252 }, { hp: 10 });
  assert.equal(full.hp, 6, 'only six of the ten fit under 510');
  assert.equal(effortTotal(full), 510);
  assert.equal(effortTotal(addEffort(full, { def: 4 })), 510);
  // And whatever a save carries is held to the same.
  assert.deepEqual(settledEffort({ atk: 300, spe: 300, hp: 'x' }), { hp: 0, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 });
});

test('effort counts in the stats, four points to one at level 100', options, () => {
  const pokemon = make('garchomp', 100);
  const before = statsOf(pokemon);
  pokemon.evs = { hp: 0, atk: 252, def: 0, spa: 0, spd: 0, spe: 4 };
  const after = statsOf(pokemon);
  // 252 is 63 points in the sum, which at level 100 is 63 points of stat
  // before the nature.
  assert.ok(after.atk - before.atk >= 56 && after.atk - before.atk <= 70, `${before.atk} -> ${after.atk}`);
  assert.ok(after.spe - before.spe >= 1, 'four points are one');
  assert.equal(after.def, before.def);
});

test('a vitamin trains ten points and befriends; at the limit it does nothing', options, () => {
  const pokemon = make('machop', 30);
  const session = bag({ protein: 30 }, pokemon);
  assert.equal(itemActions(session, 'protein').use, true);

  assert.ok(useItem(session, 'protein').ok);
  assert.equal(pokemon.evs.atk, 10);
  assert.equal(friendshipOf(pokemon), 5, 'five while friendship is under 100');

  pokemon.evs.atk = 248;
  assert.ok(useItem(session, 'protein').ok);
  assert.equal(pokemon.evs.atk, 252, 'only as far as 252');

  const fond = friendshipOf(pokemon);
  const left = session.countOf('protein');
  assert.equal(useItem(session, 'protein').ok, false, 'nothing left to train');
  assert.equal(session.countOf('protein'), left, 'and the vitamin is kept');
  assert.equal(friendshipOf(pokemon), fond);
});

test('a feather is one point; a mochi ten, with no friendship', options, () => {
  const pokemon = make('machop', 30);
  const session = bag({ 'swift-wing': 1, 'swift-mochi': 1 }, pokemon);
  useItem(session, 'swift-wing');
  assert.equal(pokemon.evs.spe, 1);
  assert.equal(friendshipOf(pokemon), 3);
  useItem(session, 'swift-mochi');
  assert.equal(pokemon.evs.spe, 11);
  assert.equal(friendshipOf(pokemon), 3, 'a mochi brings none');
});

test('a Pomeg takes ten away and befriends, even with none left to take', options, () => {
  const pokemon = make('machop', 30);
  pokemon.evs.hp = 15;
  const session = bag({ 'pomeg-berry': 5 }, pokemon);
  assert.equal(itemActions(session, 'pomeg-berry').use, true, 'fed from the bag');

  useItem(session, 'pomeg-berry');
  assert.equal(pokemon.evs.hp, 5);
  assert.equal(friendshipOf(pokemon), 10);
  useItem(session, 'pomeg-berry');
  assert.equal(pokemon.evs.hp, 0);
  assert.ok(useItem(session, 'pomeg-berry').ok, 'still a treat');
  assert.equal(friendshipOf(pokemon), 30);

  pokemon.friendship = 255;
  assert.equal(useItem(session, 'pomeg-berry').ok, false, 'nothing to take and nothing to raise');
});

test('a Fresh-Start Mochi takes it all back', options, () => {
  const pokemon = make('machop', 30);
  const session = bag({ 'fresh-start-mochi': 2 }, pokemon);
  pokemon.evs = { hp: 100, atk: 252, def: 0, spa: 0, spd: 0, spe: 158 };
  assert.ok(useItem(session, 'fresh-start-mochi').ok);
  assert.equal(effortTotal(pokemon.evs), 0);
  assert.equal(useItem(session, 'fresh-start-mochi').ok, false, 'nothing to reset');
});

test('hit points follow effort in HP, up and down', options, () => {
  const pokemon = make('machop', 100);
  pokemon.hp = maxHp(pokemon) - 10;
  const session = bag({ 'hp-up': 10, 'fresh-start-mochi': 1 }, pokemon);
  const before = maxHp(pokemon);
  for (let index = 0; index < 4; index++) useItem(session, 'hp-up');
  // Forty points of HP effort is ten of HP at level 100, and it is gained.
  assert.equal(maxHp(pokemon), before + 10);
  assert.equal(pokemon.hp, maxHp(pokemon) - 10);
  useItem(session, 'fresh-start-mochi');
  assert.equal(maxHp(pokemon), before);
  assert.ok(pokemon.hp <= maxHp(pokemon));
});

test('a Macho Brace or a Power item halves its holder\'s Speed in battle', options, () => {
  const speedWith = (held) => {
    const pokemon = make('machop', 50);
    pokemon.heldItem = held;
    const battle = new Battle({ rng: new Rng(1), player: pokemon, foes: [make('geodude', 5)], policy: defaultAutoBattle() });
    return effectiveStat(battle.player, 'spe');
  };
  const bare = speedWith(null);
  assert.equal(speedWith('macho-brace'), Math.floor(bare / 2) || 1);
  assert.equal(speedWith('power-anklet'), Math.floor(bare / 2) || 1);
});

test('a won battle pays the effort, Macho Brace and all', options, () => {
  const pokemon = make('garchomp', 80);
  pokemon.heldItem = 'macho-brace';
  const battle = new Battle({ rng: new Rng(2), player: pokemon, foes: [make('geodude', 3)], policy: defaultAutoBattle() });
  for (let turn = 0; turn < 20 && battle.running; turn++) battle.takeTurn();
  assert.equal(battle.outcome, 'won');
  assert.equal(pokemon.evs.def, 2);
});

test('a save keeps its effort, and one from before has none', options, () => {
  const pokemon = make('machop', 30);
  const fresh = JSON.parse(JSON.stringify(pokemon));
  delete fresh.evs;
  const trained = { ...JSON.parse(JSON.stringify(pokemon)), evs: { atk: 300, spe: 100 } };
  const session = new Session({ slot: 1, save: { seed: 1, party: { active: fresh, box: [trained] }, bag: {} } });
  assert.deepEqual(session.active.evs, { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 });
  assert.deepEqual(session.box[0].evs, { hp: 0, atk: 252, def: 0, spa: 0, spd: 0, spe: 100 });
  assert.equal(levelOf(session.active), 30);
});

test('the bag lists vitamins, then feathers, then mochi, each in stat order', options, () => {
  const items = gameData().items;
  const slugs = ['zinc', 'hp-up', 'clever-wing', 'health-wing', 'fresh-start-mochi', 'health-mochi', 'pp-up'];
  const sorted = slugs.map((slug) => ({ slug, count: 1, item: items[slug] })).sort(pocketOrder('medicine')).map((entry) => entry.slug);
  assert.deepEqual(sorted, ['hp-up', 'zinc', 'health-wing', 'clever-wing', 'health-mochi', 'fresh-start-mochi', 'pp-up']);
});
