/**
 * A move's line of numbers: a move a Pokémon knows shows the PP its slot
 * holds, PP Ups and all, and one it does not know shows the move's own.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { setGameData } from '../../app/renderer/core/data.mjs';
import { moveSummary } from '../../app/renderer/ui/movecard.mjs';

setGameData(
  /** @type {any} */ ({
    moves: { tackle: { pp: 35, type: 'normal', damageClass: 'physical', power: 40, accuracy: 100 } },
    types: {},
  }),
);

const ppOf = (summary) => summary.split('  ·  ').at(-1);

test("a move no slot holds shows the move's own PP", () => {
  assert.equal(ppOf(moveSummary('tackle')), 'PP 35');
});

test('a known move shows the PP its PP Ups raised it to', () => {
  assert.equal(ppOf(moveSummary('tackle', { move: 'tackle', pp: 35, ppUp: 0 })), 'PP 35');
  assert.equal(ppOf(moveSummary('tackle', { move: 'tackle', pp: 42, ppUp: 0.2 })), 'PP 42');
  assert.equal(ppOf(moveSummary('tackle', { move: 'tackle', pp: 10, ppUp: 0.6 })), 'PP 56');
});
