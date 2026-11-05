import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { gameData } from '../../app/renderer/core/data.mjs';
import { iconCandidates } from '../tools/build/items.mjs';
import { SPRITES } from '../tools/sources.mjs';

const ready = await useRealGameData();
const withData = { skip: ready ? false : NEEDS_ASSETS };
const ITEM_ICONS = fileURLToPath(new URL('../../assets/items/', import.meta.url));

const MOVES = { 'water-pulse': { type: 'water' }, surf: { type: 'water' }, 'blaze-kick': { type: 'fire' } };
const MACHINES = { tm11: 'water-pulse', hm03: 'surf', tr41: 'blaze-kick', tm999: 'no-such-move' };
const machine = { pocket: 'machines' };

test('a machine is drawn as the disc of its move’s type, never under its own number', () => {
  // PokeAPI draws tm11.png as the orange disc of whatever another game's TM11
  // taught; the Water Pulse it teaches here is a blue, water disc.
  assert.deepEqual(iconCandidates('tm11', machine, MACHINES, MOVES), [
    `${SPRITES}/items/tm-water.png`,
    `${SPRITES}/items/tm-normal.png`,
  ]);
  assert.deepEqual(iconCandidates('hm03', machine, MACHINES, MOVES), [
    `${SPRITES}/items/hm-water.png`,
    `${SPRITES}/items/hm-normal.png`,
  ]);
  // A Technical Record is a disc too, in the TM's colours.
  assert.equal(iconCandidates('tr41', machine, MACHINES, MOVES)[0], `${SPRITES}/items/tm-fire.png`);
  // A move we know nothing of falls back to the plain disc, not to the number.
  assert.deepEqual(iconCandidates('tm999', machine, MACHINES, MOVES), [`${SPRITES}/items/tm-normal.png`]);
  for (const name of Object.keys(MACHINES)) {
    for (const url of iconCandidates(name, machine, MACHINES, MOVES)) {
      assert.ok(!url.includes(`/${name}.png`), `${name} must not look for its own numbered picture: ${url}`);
    }
  }
});

test('every shipped machine looks first for its own move’s type disc', withData, () => {
  const { items, moves, machines } = gameData();
  for (const [slug, item] of Object.entries(items)) {
    if (item.pocket !== 'machines') continue;
    const type = moves[item.move]?.type;
    assert.ok(type, `${slug} teaches a move with a type`);
    const prefix = slug.startsWith('hm') ? 'hm' : 'tm';
    assert.equal(iconCandidates(slug, item, machines, moves)[0], `${SPRITES}/items/${prefix}-${type}.png`, slug);
  }
});

test('machines of one type share one icon, and machines of different types do not', withData, (t) => {
  const { items, moves } = gameData();
  /** @type {Map<string, {slug: string, png: string}>} */
  const byKind = new Map();
  /** @type {Map<string, string>} picture to the move type it was first seen as */
  const kindOf = new Map();
  let checked = 0;
  for (const [slug, item] of Object.entries(items)) {
    if (item.pocket !== 'machines') continue;
    const file = `${ITEM_ICONS}${slug}.png`;
    if (!existsSync(file)) continue;
    const kind = `${slug.startsWith('hm') ? 'hm' : 'tm'}-${moves[item.move].type}`;
    const png = readFileSync(file).toString('base64');
    const first = byKind.get(kind);
    if (first) assert.equal(png, first.png, `${slug} (${item.move}) should look like ${first.slug}: both are ${kind}`);
    else byKind.set(kind, { slug, png });
    // An HM may share its TM's picture (PokeAPI's plain HM and TM discs are
    // one drawing), but never another type's.
    const type = moves[item.move].type;
    const seenAs = kindOf.get(png);
    if (seenAs) assert.equal(seenAs, type, `${slug} (${type}) is drawn as a ${seenAs} disc`);
    else kindOf.set(png, type);
    checked++;
  }
  if (!checked) t.skip('item icons have not been built');
});
