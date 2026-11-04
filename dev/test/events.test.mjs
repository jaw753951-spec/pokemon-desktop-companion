import test from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../../app/renderer/core/rng.mjs';
import { BASE_WEIGHT, EVENT_KINDS, EventScheduler, RECENT_WEIGHTS } from '../../app/renderer/engine/events.mjs';

/** Weights are compared loosely: they are shares of 100, not exact integers. */
const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} ≈ ${expected}`);

test('every event starts equally likely', () => {
  const weights = new EventScheduler().weights();
  for (const kind of EVENT_KINDS) close(weights[kind], BASE_WEIGHT);
  close(sum(weights), 100);
});

test('the rest stop is never rolled, only called', () => {
  assert.ok(!EVENT_KINDS.includes('heal'));
  assert.equal(new EventScheduler().weights().heal, undefined);

  const scheduler = new EventScheduler();
  const rng = new Rng(7);
  for (let i = 0; i < 5000; i++) assert.notEqual(scheduler.roll(rng), 'heal');
});

test('the last two events are damped to 1% and 10%, and what they give up is split among the rest', () => {
  const weights = new EventScheduler({ recent: ['berry', 'ball'] }).weights();
  close(weights.berry, RECENT_WEIGHTS[0]);
  close(weights.ball, RECENT_WEIGHTS[1]);
  const open = EVENT_KINDS.filter((kind) => kind !== 'berry' && kind !== 'ball');
  const expected = (100 - RECENT_WEIGHTS[0] - RECENT_WEIGHTS[1]) / open.length;
  for (const kind of open) close(weights[kind], expected);
  close(sum(weights), 100);
});

test('an event remembered twice takes the harsher figure', () => {
  const weights = new EventScheduler({ recent: ['wild', 'wild'] }).weights();
  close(weights.wild, RECENT_WEIGHTS[0]);
  for (const kind of EVENT_KINDS.filter((entry) => entry !== 'wild')) {
    close(weights[kind], (100 - RECENT_WEIGHTS[0]) / (EVENT_KINDS.length - 1));
  }
  close(sum(weights), 100);
});

test('an event three rolls back is back on full odds', () => {
  const scheduler = new EventScheduler();
  scheduler.remember('berry');
  scheduler.remember('ball');
  scheduler.remember('wild');
  close(scheduler.weights().berry, (100 - RECENT_WEIGHTS[0] - RECENT_WEIGHTS[1]) / (EVENT_KINDS.length - 2));
  assert.deepEqual(scheduler.recent, ['wild', 'ball']);
});

test('the same event twice running is all but impossible', () => {
  const scheduler = new EventScheduler();
  const rng = new Rng(1234);
  let repeats = 0;
  let flips = 0;
  let previous = null;
  let before = null;

  const rolls = 200000;
  for (let i = 0; i < rolls; i++) {
    const kind = scheduler.roll(rng);
    if (kind === previous) repeats++;
    if (kind === before && kind !== previous) flips++;
    before = previous;
    previous = kind;
  }

  // 1% of the roll, so a hair under one in a hundred.
  assert.ok(repeats / rolls < 0.02, `repeats landed on ${((repeats / rolls) * 100).toFixed(2)}%`);
  // And an A-B-A flip-flop, the thing the second slot is there for.
  assert.ok(flips / rolls < 0.12, `flip-flops landed on ${((flips / rolls) * 100).toFixed(2)}%`);
});

test('the long-run distribution stays close to even', () => {
  const scheduler = new EventScheduler();
  const rng = new Rng(99);
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(EVENT_KINDS.map((kind) => [kind, 0]));

  const rolls = 200000;
  for (let i = 0; i < rolls; i++) counts[scheduler.roll(rng)]++;

  for (const kind of EVENT_KINDS) {
    const share = (counts[kind] / rolls) * 100;
    assert.ok(Math.abs(share - BASE_WEIGHT) < 1, `${kind} landed on ${share.toFixed(2)}%`);
  }
});

test('scheduler state round-trips through a save, a forced event and all', () => {
  const scheduler = new EventScheduler();
  scheduler.roll(new Rng(3));
  scheduler.roll(new Rng(4));
  scheduler.shortages = ['balls'];
  const restored = new EventScheduler(JSON.parse(JSON.stringify(scheduler)));
  assert.deepEqual(restored.recent, scheduler.recent);
  assert.deepEqual(restored.weights(), scheduler.weights());
  assert.deepEqual(restored.shortages, ['balls']);

  // One forced before the save still fires next after the reload.
  scheduler.force('heal');
  assert.equal(new EventScheduler(JSON.parse(JSON.stringify(scheduler))).roll(new Rng(5)), 'heal');
});

test('a save written before the memory existed keeps its last event damped', () => {
  const restored = new EventScheduler({ last: 'berry', streak: 3 });
  assert.deepEqual(restored.recent, ['berry']);
  close(restored.weights().berry, RECENT_WEIGHTS[0]);
  close(sum(restored.weights()), 100);
});

test('a save that remembered a rest stop forgets it, and rolls from the rest', () => {
  const restored = new EventScheduler({ recent: ['heal', 'wild'] });
  assert.deepEqual(restored.recent, ['wild']);
  close(sum(restored.weights()), 100);
});

const sum = (weights) => Object.values(weights).reduce((total, value) => total + Number(value), 0);

test('a forced event fires next whatever the weights say', () => {
  const scheduler = new EventScheduler({ recent: ['wild', 'wild'] });
  close(scheduler.weights().wild, RECENT_WEIGHTS[0]);

  scheduler.force('wild');
  assert.equal(scheduler.roll(new Rng(1)), 'wild');
  // Recorded like any other roll, so the memory keeps damping it.
  assert.equal(scheduler.last, 'wild');
  // And only the once.
  assert.equal(scheduler.forced, null);
});

test('a called rest stop fires next, and takes no slot in the memory', () => {
  const scheduler = new EventScheduler({ recent: ['berry', 'ball'] });
  scheduler.force('heal');
  assert.equal(scheduler.roll(new Rng(1)), 'heal');
  assert.deepEqual(scheduler.recent, ['berry', 'ball']);
  assert.notEqual(scheduler.roll(new Rng(1)), 'heal');
});
