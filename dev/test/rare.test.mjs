/**
 * The rare Pokémon's clock, and the key items that decide who comes next.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { gameData, speciesIdBySlug, speciesOf } from '../../app/renderer/core/data.mjs';
import { isRare, rollWildPokemon } from '../../app/renderer/engine/encounter.mjs';
import { createPokemon } from '../../app/renderer/engine/pokemon.mjs';
import {
  CALLED_CEILING,
  calledSpecies,
  callingFind,
  callingItems,
  pickRare,
  RARE_CEILING,
  RARE_CHANCE,
  rareChance,
  rollRare,
} from '../../app/renderer/engine/rare.mjs';
import { Session } from '../../app/renderer/engine/session.mjs';
import { priceOf } from '../../app/renderer/engine/shop.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

const HOUR = 60 * 60 * 1000;

/** @param {string} slug */
const id = (slug) => /** @type {number} */ (speciesIdBySlug(slug));

/**
 * A save that has had its champion, unless `firstRun`: the first run turns
 * the clock and the key items off.
 *
 * @param {Record<string, any>} [progress]
 */
function sessionOf(progress = {}, seed = 1, { firstRun = false } = {}) {
  return new Session({
    slot: 0,
    save: {
      seed,
      party: { active: createPokemon(new Rng(1), 25, 40), box: [] },
      progress,
      dex: { champions: firstRun ? [] : [25] },
    },
  });
}

test('the odds stay low until the wait tells, and are certain past the ceiling', () => {
  assert.equal(rareChance(0), RARE_CHANCE);
  assert.equal(rareChance(RARE_CEILING.soft), RARE_CHANCE);
  assert.equal(rareChance(RARE_CEILING.hard), 1);
  assert.equal(rareChance(RARE_CEILING.hard * 3), 1);

  let last = 0;
  for (let since = 0; since <= RARE_CEILING.hard; since += HOUR / 4) {
    const chance = rareChance(since);
    assert.ok(chance >= last, `the odds fell at ${since / HOUR}h`);
    last = chance;
  }

  // A key item with a Pokémon waiting runs to a much shorter ceiling.
  assert.ok(CALLED_CEILING.hard < RARE_CEILING.soft);
  assert.equal(rareChance(CALLED_CEILING.hard, true), 1);
  assert.ok(rareChance(HOUR, true) > rareChance(HOUR));
});

test('a rare Pokémon is never more than the ceiling apart on the road', options, () => {
  const session = sessionOf();
  // About fifteen wild Pokémon an hour: one every four minutes of walking.
  const step = 4 * 60 * 1000;
  const gaps = [];
  let last = session.playtime;
  for (let wild = 0; wild < 15 * 24 * 30; wild++) {
    session.playtime += step;
    const rare = rollRare(session);
    if (rare === null) continue;
    assert.ok(isRare(speciesOf(rare)), `${speciesOf(rare)?.slug} is not rare`);
    gaps.push(session.playtime - last);
    last = session.playtime;
  }
  assert.ok(gaps.every((gap) => gap <= RARE_CEILING.hard + step), `a gap of ${Math.max(...gaps) / HOUR}h`);
  // About four and a half hours apart on average.
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length / HOUR;
  assert.ok(mean > 3.5 && mean < 5.5, `on average ${mean.toFixed(2)}h apart`);
});

test('the first run has no clock: a rare Pokémon is only ever the low odds', options, () => {
  const session = sessionOf({}, 1, { firstRun: true });
  /** @type {number[]} */
  const asked = [];
  session.rng = /** @type {any} */ ({ chance: (/** @type {number} */ odds) => (asked.push(odds), false) });
  for (let hour = 0; hour <= RARE_CEILING.hard / HOUR * 3; hour++) {
    session.playtime += HOUR;
    assert.equal(rollRare(session), null);
  }
  assert.ok(asked.every((odds) => odds === RARE_CHANCE), 'the odds climbed');

  // And the clock starts from the champion, rather than owing the first run.
  session.champions.add(id('pikachu'));
  session.playtime += 1000;
  rollRare(session);
  assert.equal(asked[asked.length - 1], RARE_CHANCE);
});

test('the draw prefers what is not caught yet, and leaves the key items\' Pokémon to them', options, () => {
  const reserved = new Set(callingItems().flatMap(({ calls }) => calls));
  for (const slug of ['lugia', 'ho-oh', 'darkrai', 'arceus', 'latias', 'nihilego', 'blacephalon']) {
    assert.ok(reserved.has(id(slug)), `${slug} is led to by a key item`);
  }

  const rng = new Rng(5);
  for (let roll = 0; roll < 3000; roll++) {
    const rare = /** @type {number} */ (pickRare(rng, { tags: ['sea'] }));
    assert.ok(isRare(speciesOf(rare)));
    assert.ok(!reserved.has(rare), `${speciesOf(rare)?.slug} came without its key item`);
  }

  // With all but one caught, it is the one left.
  const pool = Object.values(gameData().species).filter((species) => isRare(species) && !reserved.has(species.id));
  const left = pool[0].id;
  const caught = new Set(pool.slice(1).map((species) => species.id));
  for (let roll = 0; roll < 50; roll++) assert.equal(pickRare(rng, { tags: ['grass'] }, caught), left);
  // And with every one caught, any of them again rather than none.
  caught.add(left);
  assert.ok(isRare(speciesOf(/** @type {number} */ (pickRare(rng, { tags: ['grass'] }, caught)))));
});

test('a key item leads to its Pokémon one at a time, soon, and stops once they are caught', options, () => {
  const session = sessionOf();
  session.addItem('eon-ticket');
  assert.deepEqual(calledSpecies(session), [id('latias')]);

  // Past the shorter ceiling, the next wild Pokémon is Latias, and the clock
  // starts again from there.
  session.playtime += CALLED_CEILING.hard;
  assert.equal(rollRare(session), id('latias'));
  assert.equal(session.rareSince, session.playtime);

  // One that got away is still waiting.
  session.playtime += CALLED_CEILING.hard;
  assert.equal(rollRare(session), id('latias'));

  session.markCaught(id('latias'));
  assert.deepEqual(calledSpecies(session), [id('latios')]);
  session.markCaught(id('latios'));
  assert.deepEqual(calledSpecies(session), []);

  // Then it is the ordinary clock again, and nothing it led to.
  session.playtime += CALLED_CEILING.hard;
  assert.ok(rareChance(session.playtime - session.rareSince) < 1);
  session.playtime += RARE_CEILING.hard;
  const rare = rollRare(session);
  assert.ok(rare !== null && ![id('latias'), id('latios')].includes(rare));
});

test('the Enigmatic Card puts the Ultra Beasts in the rare draw, and nothing else does', options, () => {
  const beasts = ['nihilego', 'buzzwole', 'pheromosa', 'xurkitree', 'kartana', 'celesteela', 'guzzlord', 'poipole', 'stakataka', 'blacephalon'].map(id);
  const draw = (/** @type {any} */ session) => {
    const met = new Set();
    for (let roll = 0; roll < 600; roll++) {
      session.playtime += RARE_CEILING.hard;
      met.add(/** @type {number} */ (rollRare(session)));
    }
    return met;
  };

  // Without it, no Ultra Beast is ever drawn.
  const without = draw(sessionOf());
  assert.ok(beasts.every((beast) => !without.has(beast)));

  // With it, they are drawn among the rest at random rather than called one
  // after another: nobody is waiting, the clock is the ordinary one, and the
  // other legendaries keep turning up beside them.
  const session = sessionOf();
  session.addItem('enigmatic-card');
  assert.deepEqual(calledSpecies(session), []);
  assert.ok(rareChance(CALLED_CEILING.hard) < 1);
  const met = draw(session);
  assert.ok(beasts.some((beast) => met.has(beast)), 'an Ultra Beast turns up');
  assert.ok([...met].some((rare) => !beasts.includes(rare)), 'and so does everyone else');
});

test('a key item is found on the road, never bought, and only after a title', options, () => {
  const always = { chance: () => true, pick: (/** @type {any[]} */ list) => list[0], next: () => 0 };
  const session = sessionOf({}, 1, { firstRun: true });
  session.rng = /** @type {any} */ (always);

  const offered = () => {
    const seen = new Set();
    for (let find = 0; find < callingItems().length; find++) {
      const found = callingFind(session);
      if (!found) break;
      seen.add(found);
      session.addItem(found);
    }
    return seen;
  };

  // The first run finds none of them.
  assert.ok(session.firstRun);
  assert.equal(offered().size, 0);

  session.champions.add(id('pikachu'));
  assert.ok(!session.firstRun);
  const after = offered();
  for (const slug of ['silver-wing', 'eon-ticket', 'member-card', 'enigmatic-card']) assert.ok(after.has(slug), `${slug} after a title`);
  // None twice: everything still to find is already in the bag.
  assert.equal(callingFind(session), null);

  // One that leads only to Pokémon already caught is not found.
  const fresh = sessionOf();
  fresh.rng = /** @type {any} */ (always);
  fresh.markCaught(id('lugia'));
  for (let find = 0; find < 20; find++) {
    const found = callingFind(fresh);
    if (!found) break;
    assert.notEqual(found, 'silver-wing');
    fresh.addItem(found);
  }

  for (const { slug, item } of callingItems()) {
    assert.equal(item.pocket, 'key', `${slug} in the key pocket`);
    assert.equal(priceOf(slug), null, `${slug} is for sale`);
  }
});

test('a rare Pokémon met is the one the clock chose, at the companion\'s level', options, () => {
  const rng = new Rng(9);
  const companion = createPokemon(rng, 25, 40);
  for (let roll = 0; roll < 20; roll++) {
    const wild = rollWildPokemon(rng, { tags: ['grass'] }, companion, id('lugia'), new Set([id('lugia')]), undefined, id('lugia'));
    assert.equal(wild.speciesId, id('lugia'));
  }
});

test('the clock is kept in the save, and an older save starts it afresh', options, () => {
  const older = sessionOf({ playtime: 50 * HOUR });
  assert.equal(older.rareSince, 50 * HOUR);

  const session = sessionOf({ playtime: 9 * HOUR, rareSince: 7 * HOUR });
  assert.equal(session.rareSince, 7 * HOUR);
  assert.equal(session.toSave().progress.rareSince, 7 * HOUR);
});
