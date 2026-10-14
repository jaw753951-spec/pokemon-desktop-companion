import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { gameData } from '../../app/renderer/core/data.mjs';
import { createPokemon } from '../../app/renderer/engine/pokemon.mjs';
import { rollTrainer } from '../../app/renderer/engine/encounter.mjs';
import { nearOverpass, waterDrop } from '../../app/renderer/render/field.mjs';
import { eventGround } from '../../app/renderer/scenes/fieldevents.mjs';
import { aboveTopLayer, stripRuns } from '../tools/build/areas.mjs';

const ready = await useRealGameData();
const withData = { skip: ready ? false : NEEDS_ASSETS };

test('water beside the lane is laid out the way the strip is', () => {
  // Four blocks of two pixels, water a row out from the last one: the band,
  // then its mirror, then again.
  const runs = stripRuns([null, null, null, 1], 2, 20);
  // band: ......WW  mirror: WW......  → ......WWWW......  twice
  assert.deepEqual(runs, [[6, 10, 1], [22, 26, 1]]);
  // Runs of different rows are kept apart.
  assert.deepEqual(stripRuns([1, -1], 1, 1), [[0, 1, 1], [1, 3, -1], [3, 4, 1]]);
});

test('a lane up on a bridge deck walks over the top layer, one below it walks under', () => {
  // Victory Road's upper floor, elevation 4, over a plank bridge marked 15:
  // the planks keep the height the walker came onto them at.
  assert.deepEqual(aboveTopLayer([4, 4, 15, 15, 4]), [true, true, true, true, true]);
  // Route 110's lane at ground level under the Cycling Road.
  assert.deepEqual(aboveTopLayer([3, 3, 15, 3]), [false, false, false, false]);
  // A stairway between floors takes the height of the nearer one.
  assert.deepEqual(aboveTopLayer([3, 0, 0, 0, 4]), [false, false, false, true, true]);
  assert.deepEqual(aboveTopLayer([15, 15]), [false, false], 'nothing to go by');
});

test('every area leaves some road for an event to start on', withData, () => {
  // Route 7's four roofs, each held a bridge's width of road either side,
  // left none at all, and nothing ever happened there.
  for (const area of gameData().areas) {
    let open = 0;
    for (let x = 0; x < area.width; x += 2) if (!nearOverpass(area, eventGround(x))) open++;
    assert.ok(open / (area.width / 2) > 0.1, `${area.id}: ${open} open spots`);
  }
});

test('a stretch is over water only when all of it is, and says how far out', () => {
  const area = /** @type {{width: number, water: Array<[number, number, number]>}} */ ({ width: 100, water: [[40, 60, 32]] });
  assert.equal(waterDrop(area, 50, 10), 32);
  assert.equal(waterDrop(area, 45, 10), null, 'reaches past the span');
  assert.equal(waterDrop(area, 150, 10), 32, 'a later copy of the strip');
  assert.equal(waterDrop({ width: 100 }, 50, 10), null, 'no water at all');
});

test('a Swimmer is only ever met where there is water', withData, async () => {
  const { readFile } = await import('node:fs/promises');
  const raw = JSON.parse(await readFile(new URL('../../data/authored/trainer-classes.json', import.meta.url), 'utf8'));
  const classes = raw.classes;
  assert.ok(classes.some((entry) => entry.water), 'the swimming classes are marked');
  const beach = { ...(gameData().areas[0] ?? {}), tags: ['water', 'beach'] };
  const companion = createPokemon(new Rng(1), 7, 30);
  const rng = new Rng(9);

  let swimmers = 0;
  for (let roll = 0; roll < 300; roll++) {
    const dry = rollTrainer(rng, beach, companion, classes, { onWater: false });
    assert.ok(!dry.trainerClass.water, `${dry.trainerClass.id} on dry road`);
    if (rollTrainer(rng, beach, companion, classes, { onWater: true }).trainerClass.water) swimmers++;
  }
  assert.ok(swimmers > 0, 'a beach with water in front of the lane has Swimmers');
});

test('nobody drawn in the water or in a rubber ring walks the dry road', async () => {
  const { readFile } = await import('node:fs/promises');
  const raw = JSON.parse(await readFile(new URL('../../data/authored/trainer-classes.json', import.meta.url), 'utf8'));
  // A Tuber is a child bobbing in a ring, as much as a Swimmer is a head in
  // the water; standing on a grassy road in one read as a Swimmer come ashore.
  for (const entry of raw.classes.filter((entry) => /^(swimmer|tuber)/.test(entry.id))) {
    assert.equal(entry.water, true, `${entry.id} is met only in the water`);
  }
  assert.equal(raw.classes.find((entry) => entry.id === 'tuber-m').field, 'tuber_m_swimming', "the Tuber♂ swims in Emerald's own picture of it");
});
