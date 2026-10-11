import test from 'node:test';
import assert from 'node:assert/strict';

import {
  behindRoof,
  boostPace,
  COMPANION_X,
  drawWalker,
  idleBob,
  nearOverpass,
  nextBoost,
  POKEMON_SCALE,
  ROOF_MARGIN,
  STRIDE,
  walkFrame,
} from '../../app/renderer/render/field.mjs';
import { HOLD_BOOST_GLIDE_MS, HOLD_BOOST_WALK } from '../../app/shared/constants.mjs';
import {
  BALL_SIZE,
  ballSupply,
  BERRY_HARVEST,
  foundCount,
  CENTER_STEPS,
  centerBeat,
  GYM_STEPS,
  visitBeat,
  closingDoorFrame,
  doorStep,
  gatherBob,
  keepInSight,
  lookClock,
} from '../../app/renderer/scenes/fieldevents.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';

test('the walk cycle is driven by distance, not by the clock', () => {
  // Standing on the same spot must not advance the legs, however long the
  // frame took — that is the difference between a walk and an idle animation.
  assert.deepEqual(walkFrame(0), walkFrame(0));
  assert.deepEqual(walkFrame(3), walkFrame(0));
  assert.notDeepEqual(walkFrame(STRIDE), walkFrame(0));
});

test('a step lands every stride, and the cycle has four beats', () => {
  const beats = [0, 1, 2, 3].map((step) => walkFrame(step * STRIDE));

  // Plant, step, plant, step: the picture hops on the odd beats.
  assert.deepEqual(
    beats.map((beat) => beat.lift),
    [0, 1, 0, 1],
  );
});

test('the cycle repeats forever and never leaves the walk', () => {
  for (const distance of [0, 8, 37, 1000, 123456.7]) {
    const frame = walkFrame(distance);
    assert.ok([0, 1].includes(frame.lift), `lift ${frame.lift}`);
  }

  // Four strides on, the sprite is back where the cycle started.
  assert.deepEqual(walkFrame(4 * STRIDE), walkFrame(0));
  assert.deepEqual(walkFrame(400 * STRIDE), walkFrame(0));
});

test('a negative distance still resolves to a real beat', () => {
  // The offset only ever grows in play, but a rewound or restored save must
  // not put the renderer into an undefined frame.
  assert.deepEqual(walkFrame(-STRIDE), walkFrame(3 * STRIDE));
  assert.ok(walkFrame(-1));
});

// ------------------------------------------------------- hurrying the road

test('the hurry comes on quickly and glides off after the pointer is let go', () => {
  // Pressed, it is at full pace within a few frames rather than on the first.
  let level = nextBoost(0, true, 16);
  assert.ok(level > 0 && level < 1, 'the first frame of a press is not yet a run');
  for (let frame = 0; frame < 20; frame++) level = nextBoost(level, true, 16);
  assert.equal(level, 1);
  assert.equal(boostPace(level, HOLD_BOOST_WALK), HOLD_BOOST_WALK);

  // Let go, the pace falls away over the glide instead of on the next frame…
  const paces = [];
  for (let ms = 0; ms < HOLD_BOOST_GLIDE_MS; ms += 16) {
    level = nextBoost(level, false, 16);
    paces.push(boostPace(level, HOLD_BOOST_WALK));
  }
  assert.ok(paces[0] > 2, `the frame after letting go still runs at ${paces[0]}`);
  for (let index = 1; index < paces.length; index++) assert.ok(paces[index] <= paces[index - 1]);

  // …and is back to a walk once it has, with nothing banked.
  level = nextBoost(level, false, 16);
  assert.equal(level, 0);
  assert.equal(boostPace(level, HOLD_BOOST_WALK), 1);
});

test('the glide has no corner at either end', () => {
  // Eased, so the step between one frame's pace and the next is smallest at
  // the ends: it leaves the run and arrives at the walk gently.
  const step = (level) => boostPace(level, HOLD_BOOST_WALK) - boostPace(level - 0.02, HOLD_BOOST_WALK);
  assert.ok(step(1) < step(0.5));
  assert.ok(step(0.02) < step(0.5));
});

// ------------------------------------------------- the rest stop's own script

test('the Center visit plays its door script, walks past, and then ends', () => {
  /** Drive the visit the way the runner does: one beat at a time. */
  const beats = [];
  let passing = false;
  for (let step = 0; step < 100; step++) {
    const next = centerBeat(step, passing);
    if (!next) break;
    passing = next.phase === 'passing';
    beats.push(next);
  }

  // Every door frame, then exactly one walk-past.
  assert.equal(beats.filter((beat) => beat.phase === 'visit').length, CENTER_STEPS.length);
  assert.equal(beats.filter((beat) => beat.phase === 'passing').length, 1);
  assert.equal(beats[beats.length - 1].phase, 'passing');

  // And the beat after the walk-past is nothing at all: an event that never
  // returns null leaves the runner busy for good, and no event — or area
  // change — can happen for the rest of the session.
  assert.equal(centerBeat(CENTER_STEPS.length, true), null);
  assert.equal(centerBeat(CENTER_STEPS.length + 5, true), null);
});

test('the companion is healed exactly once per visit', () => {
  const heals = CENTER_STEPS.filter((beat) => beat.heal);
  assert.equal(heals.length, 1);
  // Behind the closed door, which is the point of going in.
  assert.equal(heals[0].inside, true);
});

test('the companion walks through the door rather than standing beside it', () => {
  // In through the open door, and out of it again: the beat before the visit
  // goes indoors is a step in, and the last beat of all is a step out.
  const firstInside = CENTER_STEPS.findIndex((beat) => beat.inside);
  assert.equal(CENTER_STEPS[firstInside - 1].step, 'in');
  assert.equal(CENTER_STEPS[firstInside - 1].frame, 3, 'it steps in through an open door');
  const last = CENTER_STEPS[CENTER_STEPS.length - 1];
  assert.equal(last.step, 'out');
  assert.equal(last.frame, 3, 'it steps out through an open door');
  assert.ok(!last.inside);

  // Nothing after it has the companion standing at the door while it shuts:
  // the walk-past starts the moment it is out.
  const stood = CENTER_STEPS.filter((beat) => !beat.inside && !beat.step).reduce((sum, beat) => sum + beat.ms, 0);
  assert.ok(stood <= 400, `the companion waits ${stood}ms at the door`);
});

// ------------------------------------------------------------ the gym's own

test('the gym visit walks in, fights once, walks out, and then ends', () => {
  const beats = [];
  let passing = false;
  for (let step = 0; step < 100; step++) {
    const next = visitBeat(GYM_STEPS, step, passing);
    if (!next) break;
    passing = next.phase === 'passing';
    beats.push(next);
  }
  assert.equal(beats.filter((beat) => beat.phase === 'visit').length, GYM_STEPS.length);
  assert.equal(beats[beats.length - 1].phase, 'passing');
  assert.equal(visitBeat(GYM_STEPS, GYM_STEPS.length, true), null);

  // One battle, opened the moment the companion is through the door.
  const battles = GYM_STEPS.map((beat, index) => ({ beat, index })).filter(({ beat }) => beat.battle);
  assert.equal(battles.length, 1);
  const { beat, index } = battles[0];
  assert.equal(beat.inside, true);
  assert.equal(GYM_STEPS[index - 1].step, 'in', 'the battle starts as it steps in');
  assert.equal(GYM_STEPS[index - 1].frame, 3, 'through an open door');

  // And it comes back out the same door.
  const last = GYM_STEPS[GYM_STEPS.length - 1];
  assert.equal(last.step, 'out');
  assert.equal(last.frame, 3);
  assert.ok(!GYM_STEPS.some((step) => step.heal), 'a gym heals nobody');
});

test('a step through the door fades the companion in or out', () => {
  const into = { step: 'in', ms: 300 };
  assert.deepEqual(doorStep(into, 300), { lift: 0, alpha: 1 });
  assert.equal(doorStep(into, 0).alpha, 0);
  assert.ok(doorStep(into, 0).lift > 0, 'it steps up into the doorway');

  const out = { step: 'out', ms: 300 };
  assert.equal(doorStep(out, 300).alpha, 0);
  assert.deepEqual(doorStep(out, 0), { lift: 0, alpha: 1 });

  // Any other beat leaves it whole and on the ground.
  assert.deepEqual(doorStep({ frame: 3, ms: 90 }, 40), { lift: 0, alpha: 1 });
  assert.deepEqual(doorStep(null, 0), { lift: 0, alpha: 1 });
});

test('the door shuts behind the companion as it walks away', () => {
  assert.equal(closingDoorFrame(0), 3);
  const frames = [];
  for (let ms = 0; ms <= 1000; ms += 30) frames.push(closingDoorFrame(ms));
  // Open, then closing one frame at a time, and shut for good.
  assert.deepEqual([...new Set(frames)], [3, 2, 1, 0]);
  assert.equal(frames[frames.length - 1], 0);
});

// ------------------------------------------------------ gathering on the spot

test('a companion bobs while it gathers and stands still otherwise', () => {
  // Nothing running, and phases that are not a gather, leave it on the ground.
  assert.equal(gatherBob(null), 0);
  assert.equal(gatherBob({ phase: 'approach', elapsed: 200 }), 0);
  assert.equal(gatherBob({ phase: 'show', elapsed: 200 }), 0);
  assert.equal(gatherBob({ phase: 'battle', elapsed: 200 }), 0);

  const heights = [];
  for (let elapsed = 0; elapsed <= 2000; elapsed += 40) {
    heights.push(gatherBob({ phase: 'gather', elapsed }));
  }

  // It leaves the ground and comes back to it, over and over, and never sinks
  // into the road.
  assert.ok(Math.max(...heights) > 0, 'the bob should lift the sprite');
  assert.ok(Math.min(...heights) >= 0, 'the bob should never go below the ground');
  assert.ok(heights.includes(0), 'the bob should come back down');
  // More than one rise across two seconds, so it reads as busy rather than as
  // one hop.
  const rises = heights.filter((height, index) => index > 0 && height > heights[index - 1]).length;
  assert.ok(rises > 3, `expected a repeating bob, saw ${rises} rises`);
});

test('holding to hurry a gather makes it end sooner, not shake', () => {
  // Two seconds with the event hurried six times over and the motions twice:
  // the bob follows its own clock, not the hurried progress.
  const hurried = [];
  const double = [];
  for (let real = 0; real <= 2000; real += 20) {
    hurried.push(gatherBob({ phase: 'gather', elapsed: real * 6, shown: real * 2 }));
    double.push(gatherBob({ phase: 'gather', elapsed: real * 2 }));
  }
  assert.deepEqual(hurried, double);
  assert.equal(lookClock({ elapsed: 900, shown: 150 }), 150);
  assert.equal(lookClock({ elapsed: 900 }), 900, 'an event from before the clock existed');
});

test('a bobbing companion leaves its shadow on the ground', () => {
  /** A canvas that remembers the shadow ellipse and where the sprite landed. */
  const recorder = () => {
    const calls = { ellipse: [], image: [] };
    return {
      calls,
      globalAlpha: 1,
      fillStyle: '',
      save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, fill() {},
      ellipse(x, y) { calls.ellipse.push([x, y]); },
      drawImage(...args) { calls.image.push(args); },
    };
  };
  const sprite = { image: {}, width: 20, height: 24 };
  const walk = { x: 60, y: 100, distance: 0, moving: false, flip: false };

  const grounded = recorder();
  drawWalker(/** @type {any} */ (grounded), /** @type {any} */ (sprite), walk);
  const lifted = recorder();
  drawWalker(/** @type {any} */ (lifted), /** @type {any} */ (sprite), { ...walk, lift: 3 });

  // The shadow stays exactly where it was — that is what makes the bob read as
  // leaving the ground rather than the whole thing sliding up the screen.
  assert.deepEqual(lifted.calls.ellipse, grounded.calls.ellipse);

  // And the sprite is drawn three pixels higher. `drawImage` is called with
  // the nine-argument form, so the destination top is the seventh.
  const topOf = (recorded) => recorded.calls.image[0][6];
  assert.equal(topOf(grounded) - topOf(lifted), 3);

  // A busy companion at the bottom of its bob is on the ground, not on its
  // idle bob: nought is a lift like any other. Over a stretch of standing
  // time, the lift of nought stays put while the idle bob moves.
  const at = (lift, time) => {
    const recorded = recorder();
    drawWalker(/** @type {any} */ (recorded), /** @type {any} */ (sprite), { ...walk, lift, time });
    return topOf(recorded);
  };
  const busy = new Set([0, 100, 230, 345].map((time) => at(0, time)));
  const idle = new Set([0, 100, 230, 345].map((time) => at(null, time)));
  assert.equal(busy.size, 1, 'a lift of nought holds still');
  assert.ok(idle.size > 1, 'with no lift it bobs on its own clock');
});

test('one picture hops as it walks and bobs as it stands, and never leans', () => {
  const tops = (options) => {
    const calls = [];
    const context = {
      globalAlpha: 1,
      fillStyle: '',
      save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, fill() {}, ellipse() {},
      drawImage(...args) { calls.push(args); },
    };
    drawWalker(/** @type {any} */ (context), /** @type {any} */ ({ image: {}, width: 20, height: 24 }), { x: 60, y: 100, ...options });
    // One whole picture per draw — no rows sheared apart — from its only frame.
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], 0);
    return calls[0][6];
  };
  // Drawn at the road's scale: the sprite is 24 of its own pixels tall.
  const ground = 100 - 24 * POKEMON_SCALE;

  // Walking: a pixel's hop on each step, by distance, whatever the clock says.
  assert.equal(tops({ distance: 0, moving: true, time: 230 }), ground);
  assert.equal(tops({ distance: STRIDE, moving: true, time: 0 }), ground - 1);

  // Standing: the bob, by the clock, up only and by whole pixels.
  const standing = new Set();
  for (let time = 0; time < 1000; time += 20) {
    const top = tops({ distance: 0, moving: false, time });
    assert.equal(ground - top, idleBob(time));
    standing.add(top);
  }
  assert.deepEqual([...standing].sort((a, b) => a - b), [ground - 2, ground - 1, ground]);

  // A companion lifted by what it is busy with takes that lift, not its bob.
  assert.equal(tops({ distance: 0, moving: false, time: 230, lift: 3 }), ground - 3);
});

// -------------------------------------------------- the scene stack's clocks

test('a menu leaves the scene below it running, a battle does not', async () => {
  const { App } = await import('../../app/renderer/core/app.mjs');

  const ticks = { road: 0, menu: 0, fight: 0 };
  const road = { update: () => { ticks.road++; } };
  const menu = { keepBelow: true, keepBelowRunning: true, update: () => { ticks.menu++; } };
  const fight = { keepBelow: true, update: () => { ticks.fight++; } };

  // Only the stack matters here, so the shell is stood up without its DOM.
  const app = Object.create(App.prototype);
  app.stack = [{ scene: road, node: null }];
  app.toastTimer = 0;

  /** One frame of updates, without the drawing the real tick also does. */
  const frame = () => {
    for (let index = app.firstUpdateIndex(); index < app.stack.length; index++) {
      app.stack[index]?.scene.update?.(16, app);
    }
  };

  frame();
  assert.deepEqual(ticks, { road: 1, menu: 0, fight: 0 });

  // A bag over the road: both run, and the companion keeps walking.
  app.stack.push({ scene: menu, node: null });
  frame();
  assert.deepEqual(ticks, { road: 2, menu: 1, fight: 0 });

  // A battle replaces the view, so the road stops.
  app.stack = [{ scene: road, node: null }, { scene: fight, node: null }];
  frame();
  assert.deepEqual(ticks, { road: 2, menu: 1, fight: 1 });
});

test('a scene that closes itself mid-frame does not take the loop with it', async () => {
  const { App } = await import('../../app/renderer/core/app.mjs');

  let below = 0;
  const app = Object.create(App.prototype);
  app.stack = [
    { scene: { update: () => { below++; } }, node: null },
    { scene: { keepBelowRunning: true, update: () => { app.stack.pop(); } }, node: null },
  ];

  assert.doesNotThrow(() => {
    for (let index = app.firstUpdateIndex(); index < app.stack.length; index++) {
      app.stack[index]?.scene.update?.(16, app);
    }
  });
  assert.equal(below, 1);
  assert.equal(app.stack.length, 1);
});

// ------------------------------------------------------ the rest stop's balls

test('a rest stop hands over one or two balls, and the better ones early', () => {
  const rng = new Rng(7);
  const counts = new Set();
  for (let roll = 0; roll < 200; roll++) counts.add(ballSupply(rng, 10).count);
  assert.deepEqual([...counts].sort(), [1, 2]);

  assert.equal(ballSupply(rng, 5).item, 'poke-ball');
  assert.equal(ballSupply(rng, 15).item, 'great-ball');
  assert.equal(ballSupply(rng, 30).item, 'ultra-ball');
  assert.equal(ballSupply(rng, 100).item, 'ultra-ball');
});

test('a berry tree gives a handful', () => {
  assert.ok(BERRY_HARVEST.min >= 2 && BERRY_HARVEST.max > BERRY_HARVEST.min);
});

test('a ball found on the road is a handful, a dear one a couple, a Master Ball one', async (t) => {
  if (!(await useRealGameData())) return t.skip(NEEDS_ASSETS);
  const rng = new Rng(3);
  const range = (slug) => {
    const seen = new Set();
    for (let roll = 0; roll < 200; roll++) seen.add(foundCount(rng, slug));
    return [Math.min(...seen), Math.max(...seen)];
  };
  assert.deepEqual(range('poke-ball'), [3, 5]);
  assert.deepEqual(range('ultra-ball'), [3, 5]);
  assert.deepEqual(range('luxury-ball'), [2, 3]);
  assert.deepEqual(range('master-ball'), [1, 1]);
  assert.deepEqual(range('potion'), [1, 1], 'anything but a ball is found one at a time');
});

test('an event is kept off the road under a bridge, and a little way either side', () => {
  const area = { width: 1000, covered: /** @type {Array<[number, number]>} */ ([[240, 320]]) };
  assert.equal(nearOverpass(area, [100, 180]), false, 'well clear of it');
  assert.equal(nearOverpass(area, [180, 260]), true, 'reaching under it');
  assert.equal(nearOverpass(area, [330, 400]), true, 'just past it, within the margin');
  assert.equal(nearOverpass(area, [400, 480]), false);
  // The strip repeats, and so does the bridge in it.
  assert.equal(nearOverpass(area, [2250, 2300]), true);
  assert.equal(nearOverpass(area, [2100, 2180]), false);
  // An area with nothing overhead never holds one back.
  assert.equal(nearOverpass({ width: 1000 }, [240, 320]), false);
});

test('a roof the lane runs behind holds no event back, only moves a prop it would hide whole', () => {
  const area = { width: 1000, covered: /** @type {Array<[number, number, string?]>} */ ([[240, 320, 'roof']]) };
  // Its feet behind the edge, as the companion's are: the event goes ahead.
  assert.equal(nearOverpass(area, [180, 400]), false);
  assert.equal(behindRoof(area, [300, 310]), true);
  assert.equal(behindRoof(area, [330, 340]), false);

  // A ball would be gone behind it, so it is put down past the roof.
  const ball = { worldX: 280 - COMPANION_X, prop: { kind: 'ball' } };
  keepInSight(area, ball);
  assert.ok(COMPANION_X + ball.worldX - BALL_SIZE / 2 >= 320 + ROOF_MARGIN, `ball at ${COMPANION_X + ball.worldX}`);
  // One in the open is left where it is.
  const open = { worldX: 600 - COMPANION_X, prop: { kind: 'ball' } };
  keepInSight(area, open);
  assert.equal(open.worldX, 600 - COMPANION_X);
  // Nor is it moved on to under a bridge.
  const both = { width: 1000, covered: /** @type {Array<[number, number, string?]>} */ ([[240, 320, 'roof'], [330, 400]]) };
  const squeezed = { worldX: 280 - COMPANION_X, prop: { kind: 'ball' } };
  keepInSight(both, squeezed);
  assert.equal(nearOverpass(both, [COMPANION_X + squeezed.worldX - 44, COMPANION_X + squeezed.worldX + 80]), false);
  assert.equal(behindRoof(both, [COMPANION_X + squeezed.worldX - 6, COMPANION_X + squeezed.worldX + 6]), false);
});
