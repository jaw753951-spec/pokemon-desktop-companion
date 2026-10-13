import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { moveOf, typeEffectiveness } from '../../app/renderer/core/data.mjs';
import {
  Battle,
  categoryOf,
  choosePolicyMove,
  moveCondition,
  secondCondition,
  effectiveStat,
  expectedDamage,
  STATUS,
} from '../../app/renderer/engine/battle.mjs';
import { createPokemon, maxHp, setMove } from '../../app/renderer/engine/pokemon.mjs';
import { defaultAutoBattle, normalizeAutoBattle } from '../../app/renderer/engine/session.mjs';
import { computeStat, experienceForLevel, levelForExperience, stageMultiplier } from '../../app/renderer/engine/stats.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

/** Charizard, Blastoise and Venusaur, for type matchups everybody knows. */
const CHARIZARD = 6;
const BLASTOISE = 9;
const VENUSAUR = 3;

/** A Pokémon with fixed, maximal IVs so a test's numbers are reproducible. */
function makeFixed(speciesId, level, moves = []) {
  const pokemon = createPokemon(new Rng(1), speciesId, level, { ivFloor: 31 });
  pokemon.nature = 'hardy'; // neutral, so nature cannot skew a stat assertion
  if (moves.length) {
    pokemon.moves = [];
    moves.forEach((move, index) => setMove(pokemon, index, move));
  }
  pokemon.hp = maxHp(pokemon);
  return pokemon;
}

test('stat formula follows the main series, with no effort in it', options, () => {
  // A level-78 Garchomp with 108 base HP and 24 IV: floor((216 + 24) * 78 / 100)
  // = 187, then the level and ten on top.
  assert.equal(computeStat(108, 24, 78, 1, true), 275);

  // Its Attack, step by step: floor((2*130 + 12) * 78 / 100) = 212, then
  // (212 + 5) * 1.1 = 238.7.
  assert.equal(computeStat(130, 12, 78, 1.1, false), 238);
  // A hindering nature rounds the same way: 217 * 0.9 = 195.3.
  assert.equal(computeStat(130, 12, 78, 0.9, false), 195);
  // And a neutral one is the inner term plus five.
  assert.equal(computeStat(130, 12, 78, 1, false), 217);

  // A level-1 Pokémon still has the flat +10 on HP and +5 elsewhere.
  assert.equal(computeStat(45, 0, 1, 1, true), 11);
  assert.equal(computeStat(49, 0, 1, 1, false), 5);
});

test('stage multipliers follow the main-series table', options, () => {
  assert.equal(stageMultiplier(0), 1);
  assert.equal(stageMultiplier(1), 1.5);
  assert.equal(stageMultiplier(2), 2);
  assert.equal(stageMultiplier(6), 4);
  assert.equal(stageMultiplier(-1), 2 / 3);
  assert.equal(stageMultiplier(-6), 0.25);
  // Accuracy uses its own table.
  assert.equal(stageMultiplier(1, true), 4 / 3);
  assert.equal(stageMultiplier(-6, true), 1 / 3);
  // Out-of-range stages clamp rather than reading off the end of the table.
  assert.equal(stageMultiplier(99), 4);
  assert.equal(stageMultiplier(-99), 0.25);
});

test('experience curves round-trip through level lookup', options, () => {
  for (const rate of ['medium', 'fast', 'slow', 'medium-slow', 'slow-then-very-fast', 'fast-then-very-slow']) {
    for (const level of [1, 5, 17, 50, 99, 100]) {
      const total = experienceForLevel(rate, level);
      assert.equal(levelForExperience(rate, total), level, `${rate} at level ${level}`);
    }
  }
});

test('type chart reproduces the matchups it is famous for', options, () => {
  assert.equal(typeEffectiveness('water', ['fire']), 2);
  assert.equal(typeEffectiveness('electric', ['ground']), 0);
  assert.equal(typeEffectiveness('fighting', ['ghost']), 0);
  // Doubly effective against a dual type.
  assert.equal(typeEffectiveness('rock', ['fire', 'flying']), 4);
  // And doubly resisted.
  assert.equal(typeEffectiveness('grass', ['fire', 'flying']), 0.25);
});

test('a battle runs to a decisive end', options, () => {
  const battle = new Battle({
    rng: new Rng(42),
    player: makeFixed(CHARIZARD, 50, ['flamethrower']),
    foes: [makeFixed(VENUSAUR, 50, ['vine-whip'])],
    policy: null,
  });

  let turns = 0;
  while (battle.running && turns < 100) {
    battle.takeTurn();
    turns++;
  }

  assert.ok(!battle.running, 'the battle ended');
  assert.equal(battle.outcome, 'won', 'Fire beats Grass at equal level');
  assert.ok(battle.rewards.length > 0, 'experience was awarded');
  assert.ok(battle.rewards[0].experience > 0);
});

test('type advantage decides an otherwise even matchup', options, () => {
  // Same level, same power move — only the matchup differs, so Water should
  // beat Fire far more often than not.
  let waterWins = 0;
  for (let seed = 0; seed < 30; seed++) {
    const battle = new Battle({
      rng: new Rng(seed + 1),
      player: makeFixed(BLASTOISE, 50, ['surf']),
      foes: [makeFixed(CHARIZARD, 50, ['flamethrower'])],
      policy: null,
    });
    while (battle.running) battle.takeTurn();
    if (battle.outcome === 'won') waterWins++;
  }
  assert.ok(waterWins >= 28, `water won ${waterWins}/30`);
});

test('a fainted Pokémon ends the battle and is reported once', options, () => {
  const battle = new Battle({
    rng: new Rng(7),
    player: makeFixed(CHARIZARD, 5, ['ember']),
    foes: [makeFixed(BLASTOISE, 60, ['surf'])],
    policy: null,
  });

  /** @type {import('../../app/renderer/engine/battle.mjs').LogEntry[]} */
  const log = [];
  while (battle.running) log.push(...battle.takeTurn());

  assert.equal(battle.outcome, 'lost');
  assert.equal(log.filter((entry) => entry.kind === 'end').length, 1);
  assert.equal(battle.player.pokemon.hp, 0);
});

test('a trainer sends out their next Pokémon', options, () => {
  const battle = new Battle({
    rng: new Rng(3),
    player: makeFixed(CHARIZARD, 60, ['flamethrower']),
    foes: [makeFixed(VENUSAUR, 20, ['tackle']), makeFixed(VENUSAUR, 20, ['tackle'])],
    policy: null,
    trainerBattle: true,
  });

  /** @type {any[]} */
  const log = [];
  while (battle.running) log.push(...battle.takeTurn());

  assert.equal(battle.outcome, 'won');
  assert.equal(log.filter((entry) => entry.kind === 'faint' && entry.side === 'foe').length, 2);
  assert.equal(log.filter((entry) => entry.kind === 'sendOut').length, 1);
  assert.equal(battle.rewards.length, 2, 'experience for each Pokémon defeated');
});

test('burn halves physical damage but not special', options, () => {
  const attacker = makeFixed(CHARIZARD, 50, ['slash']);
  const defender = makeFixed(VENUSAUR, 50, ['tackle']);

  const healthy = new Battle({ rng: new Rng(11), player: attacker, foes: [defender], policy: null });
  const physical = healthy.computeDamage(healthy.player, /** @type {any} */ (healthy.foe), {
    ...moveFixture('physical', 70, 'normal'),
  });

  healthy.player.pokemon.status = STATUS.BURN;
  const burned = new Battle({ rng: new Rng(11), player: healthy.player.pokemon, foes: [defender], policy: null });
  const burnedDamage = burned.computeDamage(burned.player, /** @type {any} */ (burned.foe), {
    ...moveFixture('physical', 70, 'normal'),
  });

  assert.ok(burnedDamage.damage < physical.damage, 'burn reduced the physical hit');
});

test('status immunities are respected', options, () => {
  const battle = new Battle({
    rng: new Rng(5),
    player: makeFixed(CHARIZARD, 50, ['ember']),
    foes: [makeFixed(CHARIZARD, 50, ['ember'])],
    policy: null,
  });

  // A Fire type cannot be burned, so this must be refused.
  const applied = battle.inflictStatus(/** @type {any} */ (battle.foe), 'burn', []);
  assert.equal(applied, false);
  assert.equal(battle.foe?.pokemon.status, null);

  // A Grass type can be.
  const grassBattle = new Battle({
    rng: new Rng(5),
    player: makeFixed(CHARIZARD, 50, ['ember']),
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: null,
  });
  assert.equal(grassBattle.inflictStatus(/** @type {any} */ (grassBattle.foe), 'burn', []), true);
  assert.equal(grassBattle.foe?.pokemon.status, STATUS.BURN);
});

test('a poison takes an eighth a turn and a burn a sixteenth, as since Gold and Silver', options, () => {
  const battle = new Battle({
    rng: new Rng(5),
    player: makeFixed(CHARIZARD, 50, ['ember']),
    foes: [makeFixed(VENUSAUR, 50, ['tackle']), makeFixed(BLASTOISE, 50, ['tackle'])],
    policy: null,
  });
  const foe = /** @type {any} */ (battle.foe);
  foe.pokemon.status = STATUS.POISON;
  foe.pokemon.toxic = false;
  const full = foe.pokemon.hp;
  battle.endOfTurnStatus(foe, battle.makeLog());
  assert.equal(full - foe.pokemon.hp, Math.floor(foe.maxHp / 8));

  foe.pokemon.hp = full;
  foe.pokemon.status = STATUS.BURN;
  battle.endOfTurnStatus(foe, battle.makeLog());
  assert.equal(full - foe.pokemon.hp, Math.floor(foe.maxHp / 16));
});

test('every log line carries what condition each side was under, for the nameplates', options, () => {
  const battle = new Battle({
    rng: new Rng(5),
    player: makeFixed(CHARIZARD, 50, ['ember']),
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: null,
  });
  const log = battle.makeLog();
  log.push({ kind: 'marker' });
  battle.inflictStatus(/** @type {any} */ (battle.foe), 'burn', log);
  // Before the burn the plate shows nothing; the line that burns it shows it.
  assert.deepEqual(log[0].statuses, { player: null, foe: null });
  const burned = log.find((entry) => entry.kind === 'status');
  assert.deepEqual(burned?.statuses, { player: null, foe: STATUS.BURN });
});

test('moves are sorted into auto-battle categories', options, () => {
  assert.equal(categoryOf(moveFixture('physical', 40, 'normal')), 'damage');
  assert.equal(categoryOf({ damageClass: 'status', meta: { healing: 50 }, statChanges: [] }), 'heal');
  assert.equal(
    categoryOf({ damageClass: 'status', meta: { ailment: 'sleep', healing: 0 }, statChanges: [] }),
    'status',
  );
  assert.equal(
    categoryOf({ damageClass: 'status', meta: { ailment: 'none', healing: 0 }, statChanges: [{ stat: 'atk', change: 2 }] }),
    'stat',
  );
  assert.equal(categoryOf({ damageClass: 'status', meta: { ailment: 'none', healing: 0 }, statChanges: [] }), 'field');
});

test('every two, three or four turns counts from the turn the move was last used', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['flamethrower', 'ember', 'slash', 'scratch']);
  const battle = new Battle({
    rng: new Rng(2),
    player,
    foes: [makeFixed(VENUSAUR, 90, ['tackle'])],
    policy: { conditions: {}, moves: { ember: 'everyTwoTurns', slash: 'everyThreeTurns', scratch: 'everyFourTurns' } },
  });

  const picks = [];
  for (let turn = 0; turn < 8; turn++) {
    const pick = choosePolicyMove(battle, battle.player, /** @type {any} */ (battle.foe), player.moves);
    picks.push(pick);
    battle.player.turnsTaken++;
    battle.player.usedOn[pick] = battle.player.turnsTaken;
  }
  // Scratch, due on the fourth, gives way to Ember and goes on the fifth;
  // Slash, used on the third, is next due on the sixth, where Ember is
  // ahead of it, and so goes on the seventh.
  assert.deepEqual(picks, ['flamethrower', 'ember', 'slash', 'ember', 'scratch', 'ember', 'slash', 'ember']);
});

test('a move used on the first turn goes every two turns from there', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['tackle', 'growl']);
  const battle = new Battle({
    rng: new Rng(2),
    player,
    foes: [makeFixed(VENUSAUR, 90, ['growl'])],
    policy: { ...defaultAutoBattle(), moves: { growl: 'firstTurn' }, second: { growl: 'everyTwoTurns' } },
  });

  // Played out, so the battle itself records which turn each move went on.
  const picks = [];
  for (let turn = 0; turn < 5; turn++) {
    const log = battle.takeTurn();
    picks.push(log.find((entry) => entry.kind === 'move' && entry.side === 'player')?.data?.move);
  }
  assert.deepEqual(picks, ['growl', 'tackle', 'growl', 'tackle', 'growl']);
});

test('every move\'s first condition is looked at before any move\'s second', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['flamethrower', 'ember', 'recover']);
  const foe = makeFixed(VENUSAUR, 50, ['tackle']);
  const battle = new Battle({
    rng: new Rng(2),
    player,
    foes: [foe],
    policy: {
      ...defaultAutoBattle(),
      // Ember waits for the foe at a quarter, or failing that every other turn;
      // Recover for half health only.
      moves: { ember: 'foeHpQuarter', recover: 'hpHalf' },
      second: { ember: 'everyTwoTurns' },
    },
  });
  const pick = () => choosePolicyMove(battle, battle.player, /** @type {any} */ (battle.foe), player.moves);

  assert.equal(secondCondition(battle.policy, 'flamethrower'), 'never', 'a move starts with no second');
  assert.equal(pick(), 'flamethrower', 'nothing is due on the first turn');
  battle.player.turnsTaken = 1;
  assert.equal(pick(), 'ember', 'the second comes round when no first has');
  player.hp = Math.floor(maxHp(player) / 2);
  assert.equal(pick(), 'recover', 'a first in a later slot comes before a second in an earlier one');
  foe.hp = Math.floor(maxHp(foe) / 4);
  assert.equal(pick(), 'ember', 'and the earlier slot wins among firsts');
});

test('a move with always as its second is allowed even when its first is never', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['ember', 'flamethrower']);
  const battle = new Battle({
    rng: new Rng(2),
    player,
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: { ...defaultAutoBattle(), moves: { ember: 'never', flamethrower: 'never' }, second: { ember: 'always' } },
  });
  assert.equal(choosePolicyMove(battle, battle.player, /** @type {any} */ (battle.foe), player.moves), 'ember');
});

test('the conditions outrank the hardest hit: attacks switched off are not used', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['ember', 'flamethrower', 'growl']);
  const battle = new Battle({
    rng: new Rng(2),
    player,
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: { conditions: { damage: 'never', stat: 'always' } },
  });

  assert.equal(choosePolicyMove(battle, battle.player, /** @type {any} */ (battle.foe), player.moves), 'growl');
});

test('what is allowed always comes down to the hardest hit the other side can take', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['scratch', 'ember', 'flamethrower', 'growl']);
  const pick = (foe) => {
    const battle = new Battle({
      rng: new Rng(2),
      player,
      foes: [makeFixed(foe, 50, ['tackle'])],
      policy: { conditions: {} },
    });
    return choosePolicyMove(battle, battle.player, /** @type {any} */ (battle.foe), player.moves);
  };
  assert.equal(pick(VENUSAUR), 'flamethrower');
  assert.equal(pick(92), 'flamethrower', 'a Gastly, which a Scratch cannot touch');
});

test('a move the foe cannot take hands its turn to the next slot', options, () => {
  const player = makeFixed(4, 12, ['scratch', 'ember']);
  const battle = new Battle({
    rng: new Rng(2),
    player,
    foes: [makeFixed(92, 12, ['lick'])],
    // Scratch is due every turn it can be, and Gastly cannot take it.
    policy: { conditions: {}, second: { scratch: 'everyTwoTurns' }, moves: { scratch: 'firstTurn' } },
  });
  const picks = [];
  for (let turn = 0; turn < 3; turn++) {
    picks.push(choosePolicyMove(battle, battle.player, /** @type {any} */ (battle.foe), player.moves));
    battle.player.turnsTaken++;
  }
  assert.deepEqual(picks, ['ember', 'ember', 'ember']);
});

test('a kind set to never takes a category out of the running', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['ember', 'growl']);
  const battle = new Battle({
    rng: new Rng(4),
    player,
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: { conditions: { damage: 'always', stat: 'never' } },
  });

  for (let attempt = 0; attempt < 20; attempt++) {
    assert.equal(choosePolicyMove(battle, battle.player, /** @type {any} */ (battle.foe), player.moves), 'ember');
    battle.player.turnsTaken++;
  }
});

test('by default, several attacks come down to the hardest-hitting one', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['tackle', 'ember', 'flamethrower']);
  const battle = new Battle({
    rng: new Rng(7),
    player,
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: defaultAutoBattle(),
  });

  // Attacks never compete with each other, so this holds on every roll.
  for (let attempt = 0; attempt < 20; attempt++) {
    assert.equal(choosePolicyMove(battle, battle.player, /** @type {any} */ (battle.foe), player.moves), 'flamethrower');
  }
});

test('a healing move waits for the health its condition names', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['recover', 'flamethrower']);
  const battle = new Battle({
    rng: new Rng(3),
    player,
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: { conditions: { damage: 'never', heal: 'hpThird' } },
  });

  const pick = () => choosePolicyMove(battle, battle.player, /** @type {any} */ (battle.foe), player.moves);

  // Above a third, healing is out and nothing else is allowed, so the fallback
  // attack is all that is left.
  player.hp = Math.ceil(maxHp(player) * 0.5);
  assert.equal(pick(), 'flamethrower');

  player.hp = Math.floor(maxHp(player) / 3);
  assert.equal(pick(), 'recover');
});

test('a condition that names a moment is answered before any attack', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['flamethrower', 'swords-dance', 'recover']);
  const battle = new Battle({
    rng: new Rng(3),
    player,
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: defaultAutoBattle(),
  });
  const pick = () => choosePolicyMove(battle, battle.player, /** @type {any} */ (battle.foe), player.moves);

  // The first turn sets up; after that, it attacks until half health.
  assert.equal(pick(), 'swords-dance');
  battle.player.turnsTaken = 3;
  assert.equal(pick(), 'flamethrower');
  player.hp = Math.floor(maxHp(player) / 2);
  assert.equal(pick(), 'recover');
});

test('each move has its own condition, ahead of its kind, and the foe\'s health is one', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['ember', 'flamethrower', 'growl']);
  const foe = makeFixed(VENUSAUR, 50, ['tackle']);
  const battle = new Battle({
    rng: new Rng(2),
    player,
    foes: [foe],
    // Ember is the finisher: kept back until the foe is down to a quarter.
    policy: { ...defaultAutoBattle(), moves: { ember: 'foeHpQuarter', growl: 'never' } },
  });
  const pick = () => choosePolicyMove(battle, battle.player, /** @type {any} */ (battle.foe), player.moves);

  assert.equal(moveCondition(battle.policy, 'ember'), 'foeHpQuarter');
  assert.equal(moveCondition(battle.policy, 'flamethrower'), 'always', 'an attack starts at always');
  assert.equal(pick(), 'flamethrower');
  foe.hp = Math.floor(maxHp(foe) / 4);
  assert.equal(pick(), 'ember', 'the foe at a quarter brings the finisher out');
});

test('a move can wait on either side\'s stat ranks going up or down', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['flamethrower', 'swords-dance', 'ember']);
  const foe = makeFixed(VENUSAUR, 50, ['tackle']);
  const battle = new Battle({
    rng: new Rng(4),
    player,
    foes: [foe],
    policy: { ...defaultAutoBattle(), moves: { 'swords-dance': 'rankDown', ember: 'foeRankUp' } },
  });
  const pick = () => choosePolicyMove(battle, battle.player, /** @type {any} */ (battle.foe), player.moves);

  assert.equal(pick(), 'flamethrower', 'with no ranks moved, neither waits its turn');
  battle.player.stages.atk = -1;
  assert.equal(pick(), 'swords-dance', 'a lowered rank brings the setup back out');
  battle.player.stages.atk = 0;
  battle.foe.stages.spe = 2;
  assert.equal(pick(), 'ember', 'the foe\'s raised rank brings its answer out');
  battle.foe.stages.spe = -2;
  assert.equal(pick(), 'flamethrower', 'a lowered foe rank is not a raised one');
});

test('two moves whose moments both hold go in slot order, which the player sets', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['flamethrower', 'swords-dance', 'recover']);
  const battle = new Battle({
    rng: new Rng(3),
    player,
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: defaultAutoBattle(),
  });
  const pick = () => choosePolicyMove(battle, battle.player, /** @type {any} */ (battle.foe), player.moves);
  // The first turn, at half health: a boost and a heal are both due.
  player.hp = Math.floor(maxHp(player) / 2);
  assert.equal(pick(), 'swords-dance');
  [player.moves[1], player.moves[2]] = [player.moves[2], player.moves[1]];
  assert.equal(pick(), 'recover', 'moved ahead, the heal goes first');
});

test('a stored policy from either older shape becomes conditions', options, () => {
  // Weights, where zero meant "never".
  const weighted = normalizeAutoBattle({
    mode: 'repeatAll',
    weights: { damage: 10, stat: 0 },
    conditions: { damage: 'always', stat: 'firstTurn' },
  });
  assert.equal(weighted.conditions.damage, 'always');
  assert.equal(weighted.conditions.stat, 'never');
  assert.equal(weighted.weights, undefined);

  // Tick boxes, where an unticked kind meant the same.
  const ticked = normalizeAutoBattle({ mode: 'repeatAll', use: { heal: false } });
  assert.equal(ticked.conditions.heal, 'never');
  assert.equal(ticked.use, undefined);

  // And half health, which used to have a name of its own.
  assert.equal(normalizeAutoBattle(null).conditions.heal, 'hpHalf');

  // A move order and a mode are both dropped.
  const unordered = normalizeAutoBattle({ mode: 'repeatAll', order: [null, null, null, null], conditions: {} });
  assert.equal(unordered.mode, undefined);
  assert.equal(unordered.order, undefined);
  // Each move's own two conditions are kept; a policy from before has none.
  const kept = normalizeAutoBattle({ moves: { ember: 'foeHpHalf', bad: 3 }, second: { ember: 'everyThreeTurns', bad: null } });
  assert.deepEqual(kept.moves, { ember: 'foeHpHalf' });
  assert.deepEqual(kept.second, { ember: 'everyThreeTurns' });
  assert.deepEqual(normalizeAutoBattle({ mode: 'repeatAll', conditions: {} }).moves, {});
  assert.deepEqual(normalizeAutoBattle({ mode: 'repeatAll', conditions: {} }).second, {});
});

test('an item takes the companion\'s turn instead of a move', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['flamethrower']);
  player.hp = 20;

  const thrown = [];
  const battle = new Battle({
    rng: new Rng(11),
    player,
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: defaultAutoBattle(),
    items: {
      choose: () => null,
      throw: (slug, pokemon) => {
        thrown.push(slug);
        pokemon.hp += 60;
        return true;
      },
    },
  });

  battle.queueItem('super-potion');
  const log = battle.takeTurn();

  assert.deepEqual(thrown, ['super-potion']);
  const item = log.find((entry) => entry.kind === 'item');
  assert.ok(item && item.data.used);
  // The turn went on the item, so no move of the companion's was used.
  assert.equal(player.moves[0].pp, 15);
  assert.ok(log.some((entry) => entry.kind === 'move' && entry.side === 'foe'));
  assert.ok(!log.some((entry) => entry.kind === 'move' && entry.side === 'player'));
  // And only once: the next turn is fought normally.
  assert.equal(battle.pendingItem, null);
});

test('an item from the bag is used before anybody moves, however fast the foe', options, () => {
  // A slow companion against a fast foe with a priority move: the item still
  // comes first, as it does in the games.
  const player = makeFixed(VENUSAUR, 50, ['tackle']);
  const battle = new Battle({
    rng: new Rng(3),
    player,
    foes: [makeFixed(CHARIZARD, 60, ['quick-attack'])],
    policy: defaultAutoBattle(),
    items: { choose: () => null, throw: () => true },
  });

  battle.queueItem('potion');
  const log = battle.takeTurn();
  const item = log.findIndex((entry) => entry.kind === 'item');
  const foeMove = log.findIndex((entry) => entry.kind === 'move' && entry.side === 'foe');
  assert.ok(item >= 0 && foeMove >= 0);
  assert.ok(item < foeMove, 'the item is used before the faster foe acts');
});

test('a Sitrus Berry is eaten at half health, for a quarter of the bar', options, () => {
  // Two Tackles rather than anything decisive: the berry is the point, and a
  // battle that ends on turn one has no turn two to eat it in.
  const player = makeFixed(CHARIZARD, 50, ['tackle']);
  player.heldItem = 'sitrus-berry';

  const battle = new Battle({
    rng: new Rng(12),
    player,
    foes: [makeFixed(BLASTOISE, 60, ['tackle'])],
    policy: defaultAutoBattle(),
  });

  // Above half, nothing happens.
  player.hp = maxHp(player);
  battle.takeTurn();
  assert.equal(player.heldItem, 'sitrus-berry');

  const half = Math.floor(maxHp(player) / 2) - 1;
  player.hp = half;
  const log = battle.takeTurn();

  assert.ok(log.some((entry) => entry.kind === 'berry'));
  assert.equal(player.heldItem, null, 'the berry is gone once eaten');
  // A quarter of the bar, on top of whatever the turn did to it.
  assert.ok(player.hp >= half - 40 + Math.floor(maxHp(player) / 4));
});

test('a Cheri Berry waits for the paralysis it cures', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['tackle']);
  player.heldItem = 'cheri-berry';

  const battle = new Battle({
    rng: new Rng(13),
    player,
    foes: [makeFixed(BLASTOISE, 60, ['tackle'])],
    policy: defaultAutoBattle(),
  });

  battle.takeTurn();
  assert.equal(player.heldItem, 'cheri-berry', 'nothing to cure yet');

  player.status = STATUS.PARALYSIS;
  battle.takeTurn();
  assert.equal(player.status, null);
  assert.equal(player.heldItem, null);
});

test('a Liechi Berry waits for a quarter, and raises a stage', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['tackle']);
  player.heldItem = 'liechi-berry';

  const battle = new Battle({
    rng: new Rng(14),
    player,
    foes: [makeFixed(BLASTOISE, 60, ['tackle'])],
    policy: defaultAutoBattle(),
  });

  // Half health is not a pinch as far as this berry is concerned.
  player.hp = Math.floor(maxHp(player) / 2);
  battle.takeTurn();
  assert.equal(player.heldItem, 'liechi-berry');

  player.hp = Math.floor(maxHp(player) / 4);
  battle.takeTurn();
  assert.equal(player.heldItem, null);
  assert.equal(battle.player.stages.atk, 1);
});

test('an item that moves a stage is named before the stage moves', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['tackle']);
  const battle = new Battle({
    rng: new Rng(14),
    player,
    foes: [makeFixed(BLASTOISE, 60, ['tackle'])],
    policy: defaultAutoBattle(),
  });
  const order = (log) => log.filter((entry) => ['berry', 'heldFired', 'stat'].includes(entry.kind)).map((entry) => entry.kind);

  // A pinch berry: eaten, and then the Attack it raised.
  player.heldItem = 'liechi-berry';
  player.hp = Math.floor(maxHp(player) / 4);
  const eaten = [];
  battle.eatOneBerry(battle.player, eaten);
  assert.deepEqual(order(eaten), ['berry', 'stat']);

  // A Weakness Policy: set off by the hit, and then both stats it raised.
  player.heldItem = 'weakness-policy';
  const hit = [];
  battle.answerWithItem(/** @type {any} */ (battle.foe), battle.player, moveOf('surf'), 2, hit);
  assert.deepEqual(order(hit), ['berry', 'stat', 'stat']);
});

test('Leftovers pays a sixteenth at the end of each turn', options, () => {
  // Both sides have to last the turn out: the upkeep is paid at the end of
  // one, and a battle that ends first never reaches it.
  const player = makeFixed(CHARIZARD, 50, ['tackle']);
  player.heldItem = 'leftovers';
  player.hp = maxHp(player) - 40;

  const battle = new Battle({
    rng: new Rng(21),
    player,
    foes: [makeFixed(BLASTOISE, 50, ['tackle'])],
    policy: defaultAutoBattle(),
  });

  const log = battle.takeTurn();
  const healed = log.find((entry) => entry.kind === 'heal' && entry.side === 'player');

  assert.ok(healed, 'nothing was restored');
  assert.equal(healed.data.amount, Math.floor(maxHp(player) / 16));
  assert.equal(healed.data.item, 'leftovers');
});

test('a Choice Band lifts Attack and holds the move it picked', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['tackle', 'flamethrower']);
  const battle = new Battle({
    rng: new Rng(22),
    player,
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: defaultAutoBattle(),
  });

  const plain = effectiveStat(battle.player, 'atk');
  player.heldItem = 'choice-band';
  assert.equal(effectiveStat(battle.player, 'atk'), Math.floor(plain * 1.5));

  // The first choice sticks, even though the policy would otherwise reconsider
  // once the better move is the only sensible answer.
  const first = battle.chooseMove(battle.player, /** @type {any} */ (battle.foe));
  battle.player.lockedMove = first;
  for (let turn = 0; turn < 5; turn++) {
    assert.equal(battle.chooseMove(battle.player, /** @type {any} */ (battle.foe)), first);
  }
});

test('a Charcoal lifts fire moves and leaves the rest alone', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['flamethrower', 'slash']);
  const battle = new Battle({
    rng: new Rng(23),
    player,
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: defaultAutoBattle(),
  });

  const fire = expectedDamage(battle.player, /** @type {any} */ (battle.foe), moveOf('flamethrower'));
  player.heldItem = 'charcoal';

  // `expectedDamage` is the planner's view and does not read held items, so
  // the real roll is what this compares: twenty per cent more, every time.
  const roll = (seed) => {
    const fight = new Battle({
      rng: new Rng(seed),
      player,
      foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
      policy: defaultAutoBattle(),
    });
    return fight.computeDamage(fight.player, /** @type {any} */ (fight.foe), moveOf('flamethrower')).damage;
  };
  const withCharcoal = roll(5);
  player.heldItem = null;
  const without = roll(5);

  assert.ok(fire > 0);
  assert.ok(withCharcoal > without, `${withCharcoal} should beat ${without}`);
  assert.equal(withCharcoal, Math.max(1, Math.floor(without * 1.2)));
});

test('a Focus Sash leaves one hit point, once', options, () => {
  const player = makeFixed(CHARIZARD, 5, ['tackle']);
  player.heldItem = 'focus-sash';
  player.hp = maxHp(player);

  const battle = new Battle({
    rng: new Rng(24),
    player,
    // A Blastoise fifty levels up would end this in one hit.
    foes: [makeFixed(BLASTOISE, 60, ['surf'])],
    policy: defaultAutoBattle(),
  });

  battle.takeTurn();
  assert.equal(player.hp, 1, 'the sash should have held');
  assert.equal(player.heldItem, null, 'and been used up');
});

test('expected damage ranks a super-effective move above a resisted one', options, () => {
  const battle = new Battle({
    rng: new Rng(1),
    player: makeFixed(CHARIZARD, 50, ['flamethrower', 'surf']),
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: null,
  });

  const fire = expectedDamage(battle.player, /** @type {any} */ (battle.foe), moveFixture('special', 90, 'fire'));
  const water = expectedDamage(battle.player, /** @type {any} */ (battle.foe), moveFixture('special', 90, 'water'));
  assert.ok(fire > water, 'Fire beats Water into a Grass type');
});

/** A minimal move record, for damage maths that does not need real data. */
function moveFixture(damageClass, power, type) {
  return {
    damageClass,
    power,
    type,
    accuracy: 100,
    priority: 0,
    statChanges: [],
    meta: { ailment: 'none', ailmentChance: 0, critRate: 0, drain: 0, healing: 0, flinchChance: 0, statChance: 0 },
  };
}

test('a Fake Out works on the first turn out and fails after it', options, () => {
  // Nothing else to use, so the second turn has to try it and find it fails.
  const player = makeFixed(CHARIZARD, 50, ['fake-out']);
  const battle = new Battle({
    rng: new Rng(5),
    player,
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: defaultAutoBattle(),
  });

  const first = battle.takeTurn();
  assert.ok(first.some((entry) => entry.kind === 'damage' && entry.side === 'foe'), 'the first one lands');
  assert.ok(!first.some((entry) => entry.kind === 'failed' && entry.side === 'player'));

  const second = battle.takeTurn();
  assert.ok(second.some((entry) => entry.kind === 'failed' && entry.side === 'player'), 'the second one fails');
  assert.ok(!second.some((entry) => entry.kind === 'damage' && entry.side === 'foe'));
});

test('after the first turn out, a Fake Out is not reached for when there is anything else', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['fake-out', 'tackle']);
  const battle = new Battle({
    rng: new Rng(5),
    player,
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    // Every three turns brings the Fake Out round again on the third.
    policy: { ...defaultAutoBattle(), moves: { 'fake-out': 'everyThreeTurns' } },
  });

  battle.takeTurn();
  battle.takeTurn();
  const moves = battle.takeTurn().filter((entry) => entry.kind === 'move' && entry.side === 'player');
  assert.deepEqual(moves.map((entry) => entry.data.move), ['tackle']);
});

test('inside a Trick Room the slower side moves first, and a second one takes it down', options, () => {
  // Venusaur is slower than Charizard at the same level.
  const battle = new Battle({
    rng: new Rng(2),
    player: makeFixed(VENUSAUR, 50, ['tackle']),
    foes: [makeFixed(CHARIZARD, 50, ['tackle'])],
    policy: defaultAutoBattle(),
  });
  assert.equal(battle.orderOfPlay()[0], battle.foe, 'the faster foe first, normally');

  assert.equal(battle.field.toggleTrickRoom(), 'started');
  assert.equal(battle.orderOfPlay()[0], battle.player, 'the slower companion first, in the room');
  assert.ok(!battle.field.quiet, 'a room standing is something going on');

  assert.equal(battle.field.toggleTrickRoom(), 'ended');
  assert.equal(battle.orderOfPlay()[0], battle.foe);
});

test('a Trick Room runs out after five turns', options, () => {
  const battle = new Battle({
    rng: new Rng(2),
    player: makeFixed(VENUSAUR, 50, ['tackle']),
    foes: [makeFixed(CHARIZARD, 50, ['tackle'])],
    policy: defaultAutoBattle(),
  });
  battle.field.toggleTrickRoom();
  const ended = [];
  for (let turn = 0; turn < 5; turn++) ended.push(...battle.field.tick());
  assert.deepEqual(ended.map((entry) => entry.kind), ['trickRoom']);
  assert.equal(battle.field.trickRoom, 0);
});

test('a Tailwind doubles the Speed of the side it blows behind, for four turns', options, () => {
  const battle = new Battle({
    rng: new Rng(2),
    player: makeFixed(VENUSAUR, 50, ['tackle']),
    foes: [makeFixed(CHARIZARD, 50, ['tackle'])],
    policy: defaultAutoBattle(),
  });
  const before = battle.speedOf(battle.player);
  assert.ok(battle.field.setTailwind('player'));
  assert.equal(battle.speedOf(battle.player), before * 2);
  assert.ok(!battle.field.setTailwind('player'), 'one already blowing is not restarted');
  // Twice as fast is faster than the Charizard.
  assert.equal(battle.orderOfPlay()[0], battle.player);

  const ended = [];
  for (let turn = 0; turn < 4; turn++) ended.push(...battle.field.tick());
  assert.deepEqual(ended.map((entry) => [entry.kind, entry.side]), [['tailwind', 'player']]);
  assert.equal(battle.speedOf(battle.player), before);
});

test('using Trick Room and Tailwind puts them up', options, () => {
  const player = makeFixed(VENUSAUR, 50, ['trick-room']);
  const battle = new Battle({
    rng: new Rng(4),
    player,
    foes: [makeFixed(CHARIZARD, 50, ['tailwind'])],
    policy: defaultAutoBattle(),
  });
  const log = battle.takeTurn();
  assert.ok(log.some((entry) => entry.kind === 'trickRoom' && entry.data.state === 'started'));
  assert.ok(battle.field.trickRoom > 0);
});

test('a flinch landed by the slower side does not carry into the next turn', options, () => {
  // Every hit flinches, and the slower side lands it after the faster one has
  // already moved: it must not take the faster one's next turn instead.
  const battle = new Battle({
    rng: new Rng(9),
    player: makeFixed(CHARIZARD, 50, ['tackle']),
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: defaultAutoBattle(),
  });
  const flinchingTackle = { ...moveOf('tackle'), meta: { ...moveOf('tackle').meta, flinchChance: 100 } };
  battle.effectiveMove = (attacker, defender, base) => (attacker.side === 'foe' ? flinchingTackle : base);

  battle.takeTurn();
  assert.equal(battle.player.flinched, false, 'the flinch is gone once the turn is over');
  const next = battle.takeTurn();
  assert.ok(!next.some((entry) => entry.kind === 'flinch' && entry.side === 'player'));
  assert.ok(next.some((entry) => entry.kind === 'move' && entry.side === 'player'));
});

test('Thunder Wave does nothing to a Ground type', options, () => {
  const DIGLETT = 50;
  const battle = new Battle({
    rng: new Rng(3),
    player: makeFixed(CHARIZARD, 50, ['thunder-wave']),
    foes: [makeFixed(DIGLETT, 50, ['scratch'])],
    policy: defaultAutoBattle(),
  });
  const log = battle.takeTurn();
  assert.ok(log.some((entry) => entry.kind === 'noEffect' && entry.side === 'foe'));
  assert.equal(battle.foe.pokemon.status, null);
});

test('a Burning Jealousy burns only a target whose stats went up this turn', options, () => {
  const battle = new Battle({
    rng: new Rng(3),
    player: makeFixed(CHARIZARD, 50, ['burning-jealousy']),
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: defaultAutoBattle(),
  });
  const move = moveOf('burning-jealousy');
  battle.player.lastMove = 'burning-jealousy';
  battle.turn = 3;

  battle.applySecondaryEffects(battle.player, battle.foe, move, []);
  assert.equal(battle.foe.pokemon.status, null, 'nothing went up: no burn');

  battle.foe.marks.raisedTurn = 3;
  battle.applySecondaryEffects(battle.player, battle.foe, move, []);
  assert.equal(battle.foe.pokemon.status, STATUS.BURN);
});

test('an Explosion takes its user down with it, hit or not', options, () => {
  // Level 5 against level 100: the blast cannot finish the foe, so whatever
  // ends the fight is the user going down.
  const battle = new Battle({
    rng: new Rng(3),
    player: makeFixed(CHARIZARD, 5, ['explosion']),
    foes: [makeFixed(BLASTOISE, 100, ['splash'])],
    policy: defaultAutoBattle(),
  });
  const log = battle.takeTurn();
  assert.equal(battle.player.pokemon.hp, 0);
  assert.ok(log.some((entry) => entry.kind === 'faint' && entry.side === 'player'));
  assert.equal(battle.outcome, 'lost');
});

test('a Damp keeps an Explosion from going off, and the user standing', options, () => {
  const foe = makeFixed(BLASTOISE, 100, ['splash']);
  foe.ability = 'damp';
  const battle = new Battle({
    rng: new Rng(3),
    player: makeFixed(CHARIZARD, 5, ['explosion']),
    foes: [foe],
    policy: defaultAutoBattle(),
  });
  const log = battle.takeTurn();
  assert.ok(battle.player.pokemon.hp > 0);
  assert.ok(log.some((entry) => entry.kind === 'failed' && entry.side === 'player'));
});
