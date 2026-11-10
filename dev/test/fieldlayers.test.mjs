/**
 * The road drawn as layers: the weather's repeating tile loops without a jump,
 * and an event's prop is painted again exactly when its picture changes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { marksPerTile, skyOf, weatherTile } from '../../app/renderer/render/weather.mjs';
import { FIELD_WIDTH } from '../../app/shared/constants.mjs';
import { BALL_FADE_MS, propLook } from '../../app/renderer/scenes/fieldevents.mjs';

test('each sky slides one repeat of its tile along the way it blows, and comes back round', () => {
  for (const weather of ['rain', 'snow', 'sandstorm', 'hail']) {
    const sky = /** @type {any} */ (skyOf(weather));
    const tile = weatherTile(sky);
    // Never narrower than the view, so the repeat is never seen across it.
    assert.ok(tile.width >= FIELD_WIDTH && tile.width <= 330, `${weather}: ${tile.width}`);
    assert.ok(tile.across >= 1 && tile.down >= 1, weather);
    // Across and down in the sky's own slant, to within the tile's rounding.
    const sideways = (Math.abs(sky.speed.x) / sky.speed.y) * tile.down * tile.height;
    assert.ok(Math.abs(sideways - tile.across * tile.width) <= tile.across / 2 + 1e-9, `${weather}: ${sideways} vs ${tile.across * tile.width}`);
    assert.ok(marksPerTile(sky, tile) > 0, weather);
  }
  // Sun has a wash and no marks; a clear sky has nothing.
  assert.equal(/** @type {any} */ (skyOf('sun')).marks, 0);
  assert.equal(skyOf(null), null);
  assert.equal(skyOf('fog'), null);
});

test("a prop's picture is named by what moves it, and nothing else", () => {
  const sprite = { frameAt: (/** @type {number} */ ms) => Math.floor(ms / 200) % 2 };
  const tree = (shown) => ({ shown, prop: { kind: 'berry-tree', frame: 'ripe', sprite } });
  // A tree sways on its own clock: the same frame is the same picture.
  assert.equal(propLook(tree(0)), propLook(tree(100)));
  assert.notEqual(propLook(tree(0)), propLook(tree(400)));
  // Picking it is a different picture.
  assert.notEqual(propLook(tree(0)), propLook({ shown: 0, prop: { kind: 'berry-tree', frame: 'picked', sprite } }));

  // A closed ball never changes; an opened one does every frame of its fade,
  // and then not again.
  const ball = (elapsed, frame = 'open') => ({ elapsed, prop: { kind: 'ball', frame, sprite, openedAt: 1000 } });
  assert.equal(propLook(ball(0, 'closed')), propLook(ball(5000, 'closed')));
  assert.notEqual(propLook(ball(1100)), propLook(ball(1200)));
  assert.equal(propLook(ball(1000 + BALL_FADE_MS)), propLook(ball(9000)));

  // A trainer steps through its sheet.
  const trainer = (shown) => ({ shown, prop: { kind: 'trainer', sprite } });
  assert.notEqual(propLook(trainer(0)), propLook(trainer(250)));

  // Nothing loaded yet is nothing to draw.
  assert.equal(propLook({ prop: { kind: 'trainer', sprite: null } }), 'none');
});

test('the title stands in the area the most recently saved run was left in', async () => {
  const { useRealGameData } = await import('./helpers/data.mjs');
  if (!(await useRealGameData())) return;
  const { titleArea } = await import('../../app/renderer/scenes/title.mjs');
  const slot = (areaId, savedAt) => ({ empty: false, summary: { areaId, savedAt } });
  const empty = { empty: true, summary: null };
  assert.equal(titleArea([slot('route101', 100), slot('route119', 300), empty]).id, 'route119');
  assert.equal(titleArea([slot('route119', 300), slot('route101', 500)]).id, 'route101');
  // A save from before the area was listed, or one the game no longer has,
  // leaves it to chance — among the areas there are.
  assert.equal(titleArea([slot('nowhere', 900)], () => 0).id, titleArea([empty], () => 0).id);
  assert.equal(titleArea([slot(null, 900), slot('route119', 1)]).id, 'route119');
});
