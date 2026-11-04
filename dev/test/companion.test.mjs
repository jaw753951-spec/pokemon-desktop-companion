/**
 * Two promises the companion makes to a player who is not watching: it always
 * has something it can hit with, and a berry handed to it is a berry it takes.
 *
 * Both run against a hand-written dex, so the cases are stated here — a
 * species that learns nothing but status moves for its first several levels,
 * a berry that is both edible and holdable — rather than found by searching
 * the generated data for one that happens to have them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { setGameData } from '../../app/renderer/core/data.mjs';
import { DEFAULT_ATTACK, defaultMoves, ensureAttack, isAttack, maxHp } from '../../app/renderer/engine/pokemon.mjs';
import { canHold, equipItem, itemActions, useItem } from '../../app/renderer/engine/items.mjs';

const moves = {
  tackle: { name: { en: 'Tackle' }, type: 'normal', damageClass: 'physical', power: 40, pp: 35 },
  harden: { name: { en: 'Harden' }, type: 'normal', damageClass: 'status', power: null, pp: 30 },
  'string-shot': { name: { en: 'String Shot' }, type: 'bug', damageClass: 'status', power: null, pp: 40 },
  'bug-bite': { name: { en: 'Bug Bite' }, type: 'bug', damageClass: 'physical', power: 60, pp: 20 },
  splash: { name: { en: 'Splash' }, type: 'normal', damageClass: 'status', power: null, pp: 40 },
};

const species = {
  // Learns nothing but status moves until level twenty, and something that
  // hits after that — Metapod's shape, and the case that broke.
  11: {
    id: 11,
    slug: 'metapod',
    growthRate: 'medium',
    stats: { hp: 50, atk: 20, def: 55, spa: 25, spd: 25, spe: 30 },
    types: ['bug'],
    abilities: [{ name: 'shed-skin', hidden: false }],
    learnset: { level: [[1, 'harden'], [7, 'string-shot'], [20, 'bug-bite']], machine: [] },
  },
  // And one that learns nothing that hits at any level at all.
  129: {
    id: 129,
    slug: 'splasher',
    growthRate: 'medium',
    stats: { hp: 20, atk: 10, def: 55, spa: 15, spd: 20, spe: 80 },
    types: ['water'],
    abilities: [{ name: 'swift-swim', hidden: false }],
    learnset: { level: [[1, 'splash']], machine: [] },
  },
};

const items = {
  'oran-berry': {
    name: { en: 'Oran Berry' },
    pocket: 'berries',
    category: 'medicine',
    attributes: ['holdable', 'consumable'],
    sprite: true,
    use: { hp: 10 },
    works: true,
  },
  'escape-rope': {
    name: { en: 'Escape Rope' },
    pocket: 'misc',
    category: 'field',
    attributes: [],
    sprite: true,
    works: false,
  },
};

const natures = { hardy: { increased: null, decreased: null } };

setGameData(/** @type {any} */ ({ species, moves, items, natures, abilities: {}, types: {} }));

/** The six stats, all untrained, which is all these cases need. */
const flat = () => ({ hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 });

/** @param {number} speciesId @param {string[]} known */
const pokemon = (speciesId, known) => ({
  speciesId,
  nickname: null,
  experience: 1,
  nature: 'hardy',
  ivs: flat(),
  moves: known.map((move) => ({ move, pp: moves[move]?.pp ?? 5 })),
  hp: 30,
  status: null,
  statusTurns: 0,
  heldItem: null,
  ability: 'shed-skin',
  gender: null,
  shiny: false,
  caughtAt: 0,
  ball: null,
});

test('isAttack tells a move that hits from one that does not', () => {
  assert.equal(isAttack('tackle'), true);
  assert.equal(isAttack('harden'), false);
  assert.equal(isAttack('splash'), false);
  assert.equal(isAttack('not-a-move'), false);
});

test('a fresh Pokémon always gets something that hits', () => {
  // At level one a Metapod would know Harden and nothing else.
  const fresh = defaultMoves(pokemon(11, []));
  assert.ok(fresh.some(isAttack), `nothing in ${fresh} hits`);
  // And it is the species' own move, not a move it was never meant to know.
  assert.ok(fresh.includes('bug-bite'), `${fresh} should carry the species' own attack`);
});

test('a species that learns nothing that hits falls back on Tackle', () => {
  const fresh = defaultMoves(pokemon(129, []));
  assert.ok(fresh.includes(DEFAULT_ATTACK), `${fresh} should fall back on ${DEFAULT_ATTACK}`);
  assert.ok(fresh.includes('splash'), 'and keep what it did learn');
});

test('a save full of Pokémon that cannot fight is repaired on the way in', () => {
  const stuck = pokemon(11, ['harden', 'string-shot']);
  const taught = ensureAttack(stuck);

  assert.equal(taught, 'bug-bite');
  assert.ok(stuck.moves.map((entry) => entry.move).some(isAttack));
  // Nothing it already knew was taken away to make room.
  assert.deepEqual(stuck.moves.map((entry) => entry.move), ['harden', 'string-shot', 'bug-bite']);
  assert.equal(stuck.moves.at(-1).pp, moves['bug-bite'].pp);
});

test('a full set of status moves gives up its oldest slot', () => {
  const stuck = pokemon(11, ['harden', 'string-shot', 'harden', 'string-shot']);
  assert.equal(ensureAttack(stuck), 'bug-bite');
  assert.equal(stuck.moves.length, 4);
  assert.equal(stuck.moves[3].move, 'bug-bite');
});

test('a Pokémon that can already fight is left alone', () => {
  const fine = pokemon(11, ['harden', 'bug-bite']);
  assert.equal(ensureAttack(fine), null);
  assert.deepEqual(fine.moves.map((entry) => entry.move), ['harden', 'bug-bite']);
});

/** A session, reduced to the three things the bag asks of one. */
function session(active, bag) {
  return {
    active,
    bag: { ...bag },
    countOf(slug) {
      return this.bag[slug] ?? 0;
    },
    addItem(slug, count = 1) {
      this.bag[slug] = (this.bag[slug] ?? 0) + count;
    },
    removeItem(slug, count = 1) {
      const held = this.bag[slug] ?? 0;
      if (held < count) return false;
      if (held === count) delete this.bag[slug];
      else this.bag[slug] = held - count;
      return true;
    },
    machines: [],
  };
}

test('a berry can be handed over to be carried', () => {
  const mon = pokemon(11, ['tackle']);
  const run = /** @type {any} */ (session(mon, { 'oran-berry': 2 }));

  assert.equal(canHold('oran-berry'), true);
  const result = equipItem(run, 'oran-berry');

  assert.equal(result.ok, true);
  assert.equal(mon.heldItem, 'oran-berry');
  assert.equal(run.countOf('oran-berry'), 1, 'one came out of the bag');
});

test('the bag never offers to hand over something the engine would refuse', () => {
  const mon = pokemon(11, ['tackle']);
  const run = /** @type {any} */ (session(mon, { 'oran-berry': 1, 'escape-rope': 1 }));

  // The berry pocket is holdable by definition, whatever the record's own
  // `attributes` happen to spell — the menu offering "give to hold" and the
  // engine then answering "that cannot be held" was the reported bug.
  for (const slug of ['oran-berry', 'escape-rope']) {
    const offered = itemActions(run, slug).equip;
    assert.equal(offered, canHold(slug), `${slug}: the menu and the engine disagree`);
    if (offered) assert.notEqual(equipItem(run, slug).ok, false, `${slug} was offered and refused`);
  }
});

test('a berry whose record forgot to say it is holdable is still held', () => {
  // PokeAPI does not spell every berry's attributes the same way; the pocket
  // is what makes it a held item.
  const plain = { ...items['oran-berry'], attributes: [] };
  setGameData(/** @type {any} */ ({ species, moves, items: { ...items, 'plain-berry': plain }, natures, abilities: {}, types: {} }));

  const mon = pokemon(11, ['tackle']);
  const run = /** @type {any} */ (session(mon, { 'plain-berry': 1 }));
  assert.equal(canHold('plain-berry'), true);
  assert.equal(equipItem(run, 'plain-berry').ok, true);
  assert.equal(mon.heldItem, 'plain-berry');

  setGameData(/** @type {any} */ ({ species, moves, items, natures, abilities: {}, types: {} }));
});

test('what it was already carrying goes back in the bag', () => {
  const mon = pokemon(11, ['tackle']);
  mon.heldItem = 'escape-rope';
  const run = /** @type {any} */ (session(mon, { 'oran-berry': 1 }));

  const result = equipItem(run, 'oran-berry');
  assert.equal(mon.heldItem, 'oran-berry');
  assert.equal(run.countOf('escape-rope'), 1);
  // And says so, as the games do: what came back, and what went on.
  assert.match(result.message, /swapped|가져오고/);
});

test('an item nothing can carry says so, rather than being lost', () => {
  const mon = pokemon(11, ['tackle']);
  const run = /** @type {any} */ (session(mon, { 'escape-rope': 1 }));

  const result = equipItem(run, 'escape-rope');
  assert.equal(result.ok, false);
  assert.equal(result.used, false);
  assert.equal(mon.heldItem, null);
  assert.equal(run.countOf('escape-rope'), 1, 'and it stays in the bag');
});

test('using a berry on a Pokémon that needs no healing hands it over instead, and one that does is eaten', () => {
  const mon = pokemon(11, ['tackle']);
  // Nothing to restore: this is the case that used to answer "that cannot be
  // used right now" and leave the berry in the bag.
  mon.hp = maxHp(mon);
  const run = /** @type {any} */ (session(mon, { 'oran-berry': 1 }));

  const result = useItem(run, 'oran-berry');
  assert.equal(result.ok, true);
  assert.equal(mon.heldItem, 'oran-berry');
  assert.equal(run.countOf('oran-berry'), 0);

  // One that does need healing still eats it.
  const hurt = pokemon(11, ['tackle']);
  hurt.hp = 1;
  const fed = /** @type {any} */ (session(hurt, { 'oran-berry': 1 }));
  assert.equal(useItem(fed, 'oran-berry').ok, true);
  assert.equal(hurt.heldItem, null, 'eaten, not pocketed');
  assert.equal(hurt.hp, 11);
  assert.equal(fed.countOf('oran-berry'), 0);
});
