/**
 * The evolution screen's flashing: the old shape first, then the two in
 * turn, each held a little less than the last.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { morphShowsNew } from '../../app/renderer/scenes/evolution.mjs';

test('the flashing starts on the old shape and speeds up', () => {
  assert.equal(morphShowsNew(0), false);
  assert.equal(morphShowsNew(639), false);
  assert.equal(morphShowsNew(640), true);

  // Count the turns in the first second and in a later one.
  const turns = (from, to) => {
    let count = 0;
    for (let at = from + 1; at <= to; at++) if (morphShowsNew(at) !== morphShowsNew(at - 1)) count++;
    return count;
  };
  assert.ok(turns(4000, 5000) > turns(0, 1000) * 4, `${turns(0, 1000)} then ${turns(4000, 5000)}`);
  // But never faster than a sixteenth of a second a shape.
  assert.ok(turns(4000, 5000) <= 17);
});
