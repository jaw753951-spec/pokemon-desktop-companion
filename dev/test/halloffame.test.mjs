/**
 * The Hall of Fame's ceremony: its parts in the order Emerald plays them, and
 * a press moving it on one part at a time rather than skipping it whole.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FAME_CUES, famePhase, nextFameCue } from '../../app/renderer/scenes/halloffame.mjs';

test('the ceremony plays its parts in order and ends by itself', () => {
  const seen = [];
  for (let at = 0; at <= FAME_CUES.end; at += 10) {
    const phase = famePhase(at);
    if (seen.at(-1) !== phase) seen.push(phase);
  }
  assert.deepEqual(seen, ['flash', 'enter', 'plate', 'welcome', 'crown', 'fade', 'done']);
});

test('a press moves on to the next part, and from the last one to the end', () => {
  assert.equal(nextFameCue(0), FAME_CUES.enter);
  assert.equal(nextFameCue(FAME_CUES.enter), FAME_CUES.plate);
  assert.equal(famePhase(nextFameCue(FAME_CUES.welcome + 1)), 'crown');
  assert.equal(famePhase(nextFameCue(FAME_CUES.crown + 1)), 'fade');
  assert.equal(nextFameCue(FAME_CUES.end - 1), FAME_CUES.end);
});
