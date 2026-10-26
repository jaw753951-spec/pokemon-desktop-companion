/**
 * The battle log as the screen reads it.
 *
 * These run against a fixture of two species and a handful of moves rather
 * than the generated data, so the rules about what an entry carries are
 * checked in a checkout that has never run the asset pipeline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { gameData, setGameData, typeEffectiveness } from '../../app/renderer/core/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';

/** A species with nothing remarkable about it but its typing. */
const species = (id, slug, types, moves) => ({
  id,
  slug,
  name: { ko: slug, en: slug },
  types,
  stats: { hp: 60, atk: 60, def: 60, spa: 60, spd: 60, spe: 60 },
  abilities: [{ name: 'nothing', hidden: false }],
  growthRate: 'medium',
  baseExperience: 60,
  captureRate: 45,
  genderRate: 4,
  height: 10,
  weight: 100,
  effort: {},
  items: [],
  evolutions: [],
  learnset: { level: moves.map((move) => [1, move]), machine: [] },
  forms: [],
});

/** A move, with only the fields the engine actually reads off one. */
const move = (slug, extra = {}) => ({
  id: 1,
  name: { ko: slug, en: slug },
  type: 'normal',
  damageClass: 'physical',
  power: 40,
  accuracy: 100,
  pp: 35,
  priority: 0,
  target: 'selected-pokemon',
  text: { ko: '', en: '' },
  flags: [],
  meta: null,
  statChanges: [],
  ...extra,
});

setGameData(/** @type {any} */ ({
  species: {
    1: species(1, 'alpha', ['normal'], ['tackle']),
    2: species(2, 'beta', ['normal'], ['tackle']),
  },
  moves: {
    tackle: move('tackle'),
    'sand-attack': move('sand-attack', {
      damageClass: 'status',
      power: null,
      statChanges: [{ stat: 'accuracy', change: -1 }],
    }),
    'swords-dance': move('swords-dance', {
      damageClass: 'status',
      power: null,
      statChanges: [{ stat: 'atk', change: 2 }],
    }),
  },
  items: {},
  machines: {},
  natures: { hardy: { name: { ko: 'hardy', en: 'hardy' }, increased: null, decreased: null } },
  abilities: {},
  types: { normal: { name: { ko: 'normal', en: 'normal' }, effectiveness: {} } },
  areas: [],
  sprites: {},
  actors: { portraits: {}, overworld: {}, props: {} },
  bgm: { cues: {}, tracks: {} },
  itemTiers: {},
  leaders: [],
  leagues: [],
}));

const { Battle, STRUGGLE, bestDamageMove } = await import('../../app/renderer/engine/battle.mjs');
const { createPokemon, maxHp, setMove } = await import('../../app/renderer/engine/pokemon.mjs');

/** @param {number} id */
function makeOne(id, level = 20, moves = ['tackle']) {
  const pokemon = createPokemon(new Rng(7), id, level, { ivFloor: 31 });
  pokemon.nature = 'hardy';
  pokemon.moves = [];
  moves.forEach((slug, index) => setMove(pokemon, index, slug));
  pokemon.hp = maxHp(pokemon);
  return pokemon;
}

/** @param {any} options */
const makeBattle = (options = {}) =>
  new Battle({
    rng: new Rng(3),
    player: options.player ?? makeOne(1),
    foes: options.foes ?? [makeOne(2)],
    policy: { conditions: {} },
    items: { choose: () => null, throw: () => false },
    ...options,
  });

test('a faint entry carries the Pokémon that fell', () => {
  const foe = makeOne(2);
  const battle = makeBattle({ foes: [foe] });
  foe.hp = 1;

  /** @type {any[]} */
  let faints = [];
  for (let turn = 0; turn < 20 && battle.running; turn++) {
    faints = faints.concat(battle.takeTurn().filter((entry) => entry.kind === 'faint'));
  }

  const fallen = faints.find((entry) => entry.side === 'foe');
  assert.ok(fallen, 'the foe should have gone down');
  // The screen reads the log after the engine has finished the turn, and by
  // then the last foe to fall has been cleared off the battle — so the entry
  // has to carry it, or the message has no name in it and nothing can be
  // offered to the player to catch.
  assert.equal(battle.foe, null);
  assert.equal(fallen.data.pokemon, foe);
  assert.equal(fallen.data.speciesId, foe.speciesId);
});

test('a stage that cannot move says so instead of passing silently', () => {
  const battle = makeBattle();
  /** @type {any[]} */
  const log = [];

  assert.equal(battle.applyStage(battle.player, 'atk', 6, log), true);
  assert.equal(log.at(-1).kind, 'stat');

  // Already at the ceiling: nothing moves, and the games say as much.
  assert.equal(battle.applyStage(battle.player, 'atk', 1, log), false);
  assert.equal(log.at(-1).kind, 'statFailed');
  assert.equal(log.at(-1).data.stat, 'atk');
});

test('accuracy and evasion land on the stages the hit roll reads', () => {
  const battle = makeBattle();
  const log = [];

  // The move data spells these two out; every other stat is already short.
  battle.applyStage(battle.foe, 'accuracy', -1, log);
  battle.applyStage(battle.player, 'evasion', 1, log);

  assert.equal(battle.foe.stages.acc, -1);
  assert.equal(battle.player.stages.eva, 1);
  assert.equal(battle.foe.stages.accuracy, undefined);
  assert.equal(battle.player.stages.evasion, undefined);
  // And the entry names the stage the rest of the game knows it by.
  assert.deepEqual(log.map((entry) => entry.data.stat), ['acc', 'eva']);
});

test('a stage an item could not move is not announced', () => {
  const battle = makeBattle();
  const log = [];
  battle.applyStage(battle.player, 'atk', 6, log);
  log.length = 0;

  // A berry that finds its stat already maxed stays in the hand, so there is
  // nothing to say about it.
  assert.equal(battle.applyStage(battle.player, 'atk', 1, log, { quiet: true }), false);
  assert.deepEqual(log, []);
});

test('struggle is typeless, never misses, and costs a quarter of a bar', () => {
  // The move list has a Normal-typed `struggle` in it; using that one meant a
  // Ghost was immune to the one move that is supposed to always land, and two
  // Pokémon out of PP could announce it at each other for ever.
  assert.equal(STRUGGLE.accuracy, null);
  assert.equal(typeEffectiveness(STRUGGLE.type, ['ghost']), 1);
  assert.equal(typeEffectiveness(STRUGGLE.type, ['steel', 'rock']), 1);

  const battle = makeBattle();
  const before = battle.player.pokemon.hp;
  battle.player.pokemon.moves.forEach((slot) => { slot.pp = 0; });

  let recoil = null;
  for (let turn = 0; turn < 4 && battle.running && recoil === null; turn++) {
    recoil = battle.takeTurn().find((entry) => entry.side === 'player' && entry.data?.recoil) ?? null;
  }
  assert.ok(recoil, 'struggling should cost its user something');
  assert.ok(battle.player.pokemon.hp < before);
});

test('a battle where both sides go down at once is not a win', () => {
  const battle = makeBattle();
  // Both on their last legs, and the companion's own recoil finishes it.
  battle.player.pokemon.hp = 1;
  battle.foe.pokemon.hp = 1;
  const log = [];
  battle.checkFaint(log);
  assert.equal(battle.outcome, 'ongoing');

  battle.player.pokemon.hp = 0;
  battle.foe.pokemon.hp = 0;
  battle.checkFaint(log);

  // The knock-out it earned still counts, but a companion on no hit points is
  // not left walking away from the fight as the winner.
  assert.deepEqual(log.filter((entry) => entry.kind === 'faint').map((entry) => entry.side), ['foe', 'player']);
  assert.equal(battle.outcome, 'lost');
  assert.equal(log.filter((entry) => entry.kind === 'end').length, 1);
});

test('an attack the other side cannot take is not the move it reaches for', () => {
  // Alpha is Normal and beta is made a Ghost for this: Tackle can never land.
  gameData().species[2].types = ['ghost'];
  gameData().types.normal.effectiveness = { ghost: 0 };
  try {
    const battle = makeBattle({ player: makeOne(1, 20, ['tackle', 'swords-dance']) });
    const usable = battle.player.pokemon.moves;
    assert.equal(bestDamageMove(battle, battle.player, battle.foe, usable), null);

    // Over many turns it must never settle into repeating the dead move.
    const used = new Set();
    for (let turn = 0; turn < 20; turn++) used.add(battle.chooseMove(battle.player, battle.foe));
    assert.deepEqual([...used], ['swords-dance']);
  } finally {
    gameData().species[2].types = ['normal'];
    gameData().types.normal.effectiveness = {};
  }
});

test('every line of a turn carries what the bars stood at when it was written', () => {
  const battle = makeBattle();
  const log = battle.takeTurn();

  // The screen plays this back after the engine has finished the turn, so a
  // bar reading the Pokémon's own hit points reads the end of the turn — both
  // bars falling together on whichever blow happened to land first.
  assert.ok(log.length > 0);
  for (const entry of log) {
    assert.equal(typeof entry.hp?.player, 'number', `${entry.kind} carries no player hp`);
    assert.equal(typeof entry.hp?.foe, 'number', `${entry.kind} carries no foe hp`);
  }

  // The first damage of the turn shows the side it landed on already down and
  // the other side still whole.
  const hit = log.find((entry) => entry.kind === 'damage');
  assert.ok(hit, 'the fixture should land a hit');
  const before = log[log.indexOf(hit) - 1];
  const hurt = hit.side === 'player' ? 'player' : 'foe';
  const other = hit.side === 'player' ? 'foe' : 'player';
  assert.ok(hit.hp[hurt] < before.hp[hurt], 'the side that was hit should have dropped');
  assert.equal(hit.hp[other], before.hp[other], 'the other side should not have moved yet');
});

test('a stamp is never rewritten by a later line', () => {
  const battle = makeBattle();
  const log = battle.takeTurn();
  const stamps = log.map((entry) => entry.hp.player);
  // Hit points only fall or hold across a turn in this fixture; what matters
  // is that the sequence is a history rather than the same number repeated.
  assert.ok(new Set(stamps).size > 1, `every line read ${stamps[0]}`);
});

test('a line put in front of what it announces is stamped as things stood there', () => {
  // A stand-in battle: the log reads the two sides' hit points, conditions
  // and the field off it, and nothing else.
  const sides = { player: { pokemon: { hp: 50, status: null } }, foe: { pokemon: { hp: 40, status: null } } };
  const fake = {
    ...sides,
    field: { weather: null, primal: false, terrain: null },
    noteFaints() {},
    hitPoints: Battle.prototype.hitPoints,
    statuses: Battle.prototype.statuses,
    fieldState: Battle.prototype.fieldState,
  };
  const log = Battle.prototype.makeLog.call(fake);

  log.push({ kind: 'move', side: 'foe', data: {} });
  sides.player.pokemon.hp = 20;
  log.push({ kind: 'damage', side: 'player', data: {} });
  // The berry is eaten after the hit, and named in front of its heal.
  const mark = log.length;
  sides.player.pokemon.hp = 45;
  log.push({ kind: 'heal', side: 'player', data: {} });
  log.splice(mark, 0, { kind: 'berry', side: 'player', data: {} });

  assert.deepEqual(log.map((entry) => [entry.kind, entry.hp.player]), [['move', 50], ['damage', 20], ['berry', 20], ['heal', 45]]);

  // At the very start of the turn, it stands where the turn began.
  log.splice(0, 0, { kind: 'message', side: 'player', data: {} });
  assert.equal(log[0].hp.player, 50);
});
