/**
 * The rules that decide how big things are drawn and how hard they are hit.
 *
 * These run against a hand-written dex rather than the generated one: they are
 * about the arithmetic, and a fixture states the cases far more plainly than
 * hunting for a species that happens to have them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { setGameData } from '../../app/renderer/core/data.mjs';
import { Sprite } from '../../app/renderer/core/assets.mjs';
import { ACTOR_SCALE, actorHeight, actorScale, POKEMON_SCALE, TRAINER_SCALE } from '../../app/renderer/render/field.mjs';
import { BATTLE_SCALE } from '../../app/renderer/render/battler.mjs';
import { companionArmour } from '../../app/renderer/engine/battle.mjs';
import { treeFor } from '../../app/renderer/scenes/fieldevents.mjs';
import { COMPANION_DAMAGE_TAKEN, COMPANION_WEAKNESS, FIELD_ZOOM } from '../../app/shared/constants.mjs';

/** Heights in decimetres, as PokeAPI files them. */
setGameData(
  /** @type {any} */ ({
    species: {
      10: { id: 10, height: 3 }, // Caterpie, 0.3 m
      143: { id: 143, height: 21 }, // Snorlax, 2.1 m
      302: { id: 302, height: 5 }, // Sableye, 0.5 m
      321: { id: 321, height: 145 }, // Wailord, 14.5 m
    },
  }),
);

/** A sprite is only ever measured, so its own art need not exist. */
const sprite = (width, height) => ({ width, height });

test('every Pokémon is drawn at one scale, so all of them share one size of pixel', () => {
  // Small art and large, small Pokémon and huge: the art is already sized to
  // the Pokémon, and scaling it again is what made the pixels differ.
  const scales = [
    actorScale(sprite(14, 16), { speciesId: 10 }),
    actorScale(sprite(31, 30), { speciesId: 302 }),
    actorScale(sprite(88, 67), { speciesId: 130 }),
    actorScale(sprite(68, 44), { speciesId: 321 }),
    actorScale(sprite(20, 20), { speciesId: 999 }),
  ];
  assert.deepEqual(new Set(scales), new Set([POKEMON_SCALE]));
  // And a whole number of screen pixels per art pixel: one, the sprite as it
  // is, rather than a copy with half its pixels thrown away.
  assert.equal(POKEMON_SCALE * FIELD_ZOOM, 1);
});

test('a trainer on the road is drawn larger than its sheet, in whole screen pixels', () => {
  assert.ok(TRAINER_SCALE > ACTOR_SCALE);
  assert.ok(Number.isInteger(TRAINER_SCALE * FIELD_ZOOM));
});

test('a bigger Pokémon is bigger because its art is', () => {
  assert.ok(actorHeight(sprite(88, 67), { speciesId: 130 }) > actorHeight(sprite(14, 16), { speciesId: 10 }));
  assert.equal(actorScale(null, { speciesId: 10 }), ACTOR_SCALE, 'no sprite falls back to the prop scale');
});

test('a battle draws both sides in whole screen pixels, and shrinks nothing to fit', () => {
  // Both sides at the map's own size of pixel, twice the road's Pokémon.
  assert.equal(BATTLE_SCALE * FIELD_ZOOM, 2);
  assert.equal(BATTLE_SCALE, POKEMON_SCALE * 2);
});

test('a strip that times its frames unequally plays them for their own lengths', () => {
  const strip = new Sprite(/** @type {any} */ ({}), { width: 10, height: 10, frames: 3, delay: 100, durations: [300, 50, 50] });
  assert.equal(strip.duration, 400);
  assert.equal(strip.frameAt(0), 0);
  assert.equal(strip.frameAt(299), 0);
  assert.equal(strip.frameAt(300), 1);
  assert.equal(strip.frameAt(360), 2);
  // It loops.
  assert.equal(strip.frameAt(400), 0);
  // A strip with no timings of its own holds every frame for the one delay.
  assert.equal(new Sprite(/** @type {any} */ ({}), { width: 10, height: 10, frames: 3, delay: 100 }).frameAt(250), 2);
});

test('the companion takes half of everything, and a weakness costs it half again', () => {
  const player = /** @type {any} */ ({ side: 'player' });
  const foe = /** @type {any} */ ({ side: 'foe' });

  assert.equal(COMPANION_DAMAGE_TAKEN, 0.5);
  assert.equal(COMPANION_WEAKNESS, 1.5);
  // Neutral and resisted hits: the chart's multiplier, then half.
  assert.equal(companionArmour(player, 1), 0.5);
  assert.equal(companionArmour(player, 0.5), 0.5);
  // A weakness lands at 1.5x rather than 2x, before the half comes off.
  assert.equal(2 * companionArmour(player, 2), 1.5 * 0.5);
  assert.equal(4 * companionArmour(player, 4), 1.5 * 1.5 * 0.5);

  // What the companion deals is untouched, whoever it is hitting.
  assert.equal(companionArmour(foe, 1), 1);
  assert.equal(companionArmour(foe, 2), 1);
  assert.equal(companionArmour(null, 2), 1);
});

test('every berry grows on a tree, and always the same one', () => {
  const trees = { cheri: {}, oran: {}, pecha: {}, sitrus: {} };

  // A berry Emerald drew a tree for grows on its own.
  assert.equal(treeFor('oran-berry', trees), 'oran');
  assert.equal(treeFor('cheri-berry', trees), 'cheri');

  // One it never drew is given one of them — the same one every time, and not
  // the same one as every other berry.
  const roseli = treeFor('roseli-berry', trees);
  assert.ok(Object.keys(trees).includes(roseli), `roseli landed on ${roseli}`);
  assert.equal(treeFor('roseli-berry', trees), roseli, 'the same berry keeps the same tree');

  const spread = new Set(
    ['roseli', 'babiri', 'occa', 'passho', 'wacan', 'rindo', 'yache', 'chople']
      .map((name) => treeFor(`${name}-berry`, trees)),
  );
  assert.ok(spread.size > 1, `eight berries all landed on ${[...spread]}`);

  // And a build with no berry trees at all says so rather than throwing.
  assert.equal(treeFor('oran-berry', {}), null);
});

test('no berry grows on a tree the build found no fruit on', () => {
  const fruit = [4, 5];
  const trees = { cheri: { fruit }, oran: { fruit: null }, pecha: { fruit }, sitrus: { fruit: null } };
  const berries = ['kasib', 'roseli', 'babiri', 'occa', 'passho', 'wacan', 'rindo', 'yache', 'chople', 'oran', 'sitrus'];
  for (const name of berries) {
    const tree = treeFor(`${name}-berry`, trees);
    assert.ok(tree === 'cheri' || tree === 'pecha', `${name} landed on the bare ${tree}`);
  }
  // Its own tree still wins when it has fruit on it.
  assert.equal(treeFor('pecha-berry', trees), 'pecha');
});

test('a Hoenn berry grows on the tree Emerald gives it, and no other berry on a faint one', () => {
  const fruit = [4, 5];
  const trees = Object.fromEntries(['grepa', 'kelpsy', 'leppa', 'durin', 'spelon', 'cheri', 'pecha'].map((name) => [name, { fruit }]));
  assert.equal(treeFor('apicot-berry', trees), 'grepa');
  assert.equal(treeFor('kelpsy-berry', trees), 'kelpsy', 'a faint sheet is still its own berry’s');
  for (const name of ['kasib', 'roseli', 'babiri', 'occa', 'passho', 'wacan', 'rindo', 'yache', 'chople', 'haban']) {
    const tree = treeFor(`${name}-berry`, trees);
    assert.ok(!['kelpsy', 'leppa', 'durin', 'spelon'].includes(tree), `${name} landed on the faint ${tree}`);
  }
});
