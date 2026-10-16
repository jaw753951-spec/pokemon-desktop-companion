/**
 * The battle health bar.
 *
 * The one thing it has to get right is that it moves at a constant speed: the
 * games drain at a fixed rate, so how long a bar takes to fall is how a player
 * reads what a hit cost. A fixed duration for every change — which is what a
 * CSS transition gives — makes a scratch and a near-knockout look identical.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** The DOM the bar builds, reduced to the parts it writes to. */
class Element {
  constructor(tag) {
    this.tagName = tag;
    this.className = '';
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.textContent = '';
  }
  append(...nodes) { this.children.push(...nodes); }
  addEventListener() {}
  setAttribute() {}
  get classList() { return { add: () => {}, remove: () => {} }; }
}
// `el` checks `child instanceof Node` before appending, so the stub has to be
// the thing that check names.
globalThis.Node = /** @type {any} */ (Element);
globalThis.document = /** @type {any} */ ({
  createElement: (tag) => new Element(tag),
  createTextNode: (text) => Object.assign(new Element('#text'), { textContent: String(text) }),
});

const { setGameData } = await import('../../app/renderer/core/data.mjs');
setGameData(/** @type {any} */ ({
  species: {
    1: {
      id: 1, slug: 'alpha', name: { en: 'alpha' }, types: ['normal'],
      stats: { hp: 50, atk: 50, def: 50, spa: 50, spd: 50, spe: 50 },
      abilities: [], growthRate: 'medium', baseExperience: 60, captureRate: 45,
      genderRate: 4, height: 1, weight: 1, effort: {}, items: [], evolutions: [],
      learnset: { level: [], machine: [] }, forms: [],
    },
  },
  moves: {}, items: {}, machines: {}, natures: {}, abilities: {}, types: {},
  areas: [], sprites: {}, actors: { portraits: {}, overworld: {}, props: {} },
  bgm: { cues: {}, tracks: {} }, itemTiers: {}, leaders: [], leagues: [],
}));

const { healthBar } = await import('../../app/renderer/scenes/battle.mjs');
const { maxHp } = await import('../../app/renderer/engine/pokemon.mjs');

/** A Pokémon with a round number of hit points to reason about. */
const subject = () => ({
  speciesId: 1, nickname: null, experience: 8000, nature: 'hardy',
  ivs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
  moves: [], hp: 0, status: null, statusTurns: 0, heldItem: null,
  ability: '', gender: null, shiny: false, caughtAt: 0, ball: null,
});

/** How many 16ms frames the bar takes to settle after losing `lost` points. */
function framesToDrain(lost) {
  const pokemon = subject();
  const full = maxHp(pokemon);
  pokemon.hp = full;

  const bar = healthBar();
  bar.set(pokemon);
  const width = () => Number.parseFloat(/** @type {any} */ (bar.root.children[0]).style.width);
  assert.equal(width(), 100);

  pokemon.hp = full - lost;
  bar.set(pokemon);

  let frames = 0;
  while (frames < 1000) {
    frames++;
    bar.update(16);
    if (Math.abs(width() - ((full - lost) / full) * 100) < 1e-6) break;
  }
  return { frames, full };
}

test('a bigger hit takes proportionally longer to drain', () => {
  const { full } = framesToDrain(1);
  const small = framesToDrain(Math.round(full * 0.3)).frames;
  const large = framesToDrain(Math.round(full * 0.9)).frames;

  // Three times the damage, three times the drain — within the rounding of
  // whole frames. (Below the floor on small changes, every one takes the same.)
  const ratio = large / small;
  assert.ok(ratio > 2.6 && ratio < 3.4, `expected roughly three times as long, got ${ratio.toFixed(1)}`);
});

test('even a scratch is seen to move rather than jump', () => {
  // A quarter of a second and more: a one-point scratch, a tenth of the bar.
  const { full, frames } = framesToDrain(1);
  assert.ok(frames >= 16, `a one-point hit settled in ${frames} frames`);
  assert.ok(framesToDrain(Math.round(full * 0.1)).frames >= 16, 'a tenth of the bar');
});

test('the number never disagrees with the bar', () => {
  const pokemon = subject();
  const full = maxHp(pokemon);
  pokemon.hp = full;

  const bar = healthBar();
  bar.set(pokemon);
  pokemon.hp = 0;
  bar.set(pokemon);

  const [fill, text] = /** @type {any} */ (bar.root.children);
  for (let frame = 0; frame < 200; frame++) {
    bar.update(16);
    const width = Number.parseFloat(fill.style.width);
    const [shown] = text.textContent.split('/').map(Number);
    // The caption is the bar, rounded — never a count that has already reached
    // zero over a bar that is still falling.
    assert.ok(Math.abs(shown - (width / 100) * full) <= 0.5 + 1e-9, `${shown} against ${width}%`);
  }
  assert.equal(Number.parseFloat(fill.style.width), 0);
  assert.equal(text.textContent, `0/${full}`);
});

test('the bar changes colour where the games change it', () => {
  const pokemon = subject();
  const full = maxHp(pokemon);
  const bar = healthBar();
  const fill = () => /** @type {any} */ (bar.root.children[0]);

  const settle = (hp) => {
    pokemon.hp = hp;
    bar.set(pokemon);
    for (let frame = 0; frame < 400; frame++) bar.update(16);
  };

  settle(full);
  assert.equal(fill().style.background, '#63bb5b');
  settle(Math.floor(full * 0.4));
  assert.equal(fill().style.background, '#f3d23b');
  settle(Math.floor(full * 0.1));
  assert.equal(fill().style.background, '#d8443c');
});
