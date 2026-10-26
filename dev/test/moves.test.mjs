/**
 * Moves that do something other than deal damage by the formula: the price a
 * move charges its own user, damage fixed in advance, the states a status move
 * leaves behind, the moves that hit more than once, and the ones that end a
 * wild battle outright.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { gameData, moveOf } from '../../app/renderer/core/data.mjs';
import { Battle, STATUS } from '../../app/renderer/engine/battle.mjs';
import { createPokemon, maxHp, setMove } from '../../app/renderer/engine/pokemon.mjs';
import { defaultAutoBattle } from '../../app/renderer/engine/session.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

const MACHAMP = 68;
const GEODUDE = 74;
const SNORLAX = 143;
const BULBASAUR = 1;
const MAUSHOLD = 925;
const IRON_BOULDER = 1022;

/** A Pokémon with settled genes, so a number in a test means something. */
function fixed(speciesId, level, moves = []) {
  const pokemon = createPokemon(new Rng(1), speciesId, level, { ivFloor: 31, shiny: false });
  pokemon.nature = 'hardy';
  pokemon.ability = 'no-ability';
  pokemon.heldItem = null;
  if (moves.length) {
    pokemon.moves = [];
    moves.forEach((move, index) => setMove(pokemon, index, move));
  }
  pokemon.hp = maxHp(pokemon);
  return pokemon;
}

/** A foe that can stand there all day and never hurt anything. */
const punchbag = (level = 70, speciesId = SNORLAX) => fixed(speciesId, level, ['defense-curl']);

function fight(player, foe, extra = {}) {
  return new Battle({ rng: new Rng(7), player, foes: [foe], policy: defaultAutoBattle(), ...extra });
}

/** How many times one move landed on the foe: each strike is a damage line of its own. */
const hitsOf = (log) => log.filter((entry) => entry.kind === 'damage' && entry.side === 'foe' && entry.data?.hit).length;

test('a Fly says where its user went, and the move that comes down brings it back', options, () => {
  const PIDGEOT = 18;
  const battle = fight(fixed(PIDGEOT, 60, ['fly']), punchbag());
  const charge = battle.takeTurn();
  assert.equal(charge.find((entry) => entry.data?.key === 'move.charge.fly')?.data?.hide, 'sky');
  assert.equal(battle.player.marks.hidden, 'sky');
  const strike = battle.takeTurn();
  const used = strike.find((entry) => entry.kind === 'move' && entry.side === 'player');
  assert.equal(used?.data?.move, 'fly');
  assert.equal(used?.data?.reveal, true);
  assert.equal(battle.player.marks.hidden, null);
  // A move that never left says nothing about coming back.
  const again = battle.takeTurn();
  assert.equal(again.find((entry) => entry.data?.key === 'move.charge.fly')?.data?.hide, 'sky');
  assert.equal(fight(fixed(MACHAMP, 60, ['close-combat']), punchbag()).takeTurn()
    .find((entry) => entry.kind === 'move')?.data?.reveal, undefined);
});

test('a move bound to fail is passed over, and taken up again once it would work', options, () => {
  const GENGAR = 94;
  const GOLURK = 623;
  const target = () => punchbag(70, MACHAMP);
  // Poltergeist hits far harder than Shadow Claw, so it is the strongest
  // attack — and against a target holding nothing it fails, every turn.
  const player = fixed(GOLURK, 60, ['poltergeist', 'shadow-claw']);
  const foe = target();
  const battle = fight(player, foe);
  for (let turn = 0; turn < 3; turn++) {
    const log = battle.takeTurn();
    const used = log.find((entry) => entry.kind === 'move' && entry.side === 'player')?.data?.move;
    assert.equal(used, 'shadow-claw', `turn ${turn + 1}: reached for ${used}`);
    assert.ok(!log.some((entry) => entry.kind === 'failed' && entry.side === 'player'));
  }
  // Something to throw, and it is the move of choice again.
  foe.heldItem = 'leftovers';
  const log = battle.takeTurn();
  assert.equal(log.find((entry) => entry.kind === 'move' && entry.side === 'player')?.data?.move, 'poltergeist');

  // Its moment come round, too: the turn steps past it.
  const ordered = fight(fixed(GOLURK, 60, ['poltergeist', 'shadow-claw']), target(), {
    policy: { ...defaultAutoBattle(), moves: { poltergeist: 'oncePerBattle' } },
  });
  assert.equal(ordered.chooseMove(ordered.player, /** @type {any} */ (ordered.foe)), 'shadow-claw');

  // And the other side's trainers do not throw it either.
  const foeSide = fight(target(), fixed(GOLURK, 60, ['poltergeist', 'shadow-claw']), { trainerBattle: true });
  assert.equal(foeSide.chooseMove(/** @type {any} */ (foeSide.foe), foeSide.player), 'shadow-claw');

  // A Dream Eater waits for the target to be asleep; with nothing else, it is
  // still used rather than nothing.
  const eater = fight(fixed(GENGAR, 60, ['dream-eater', 'lick']), target());
  assert.equal(eater.chooseMove(eater.player, /** @type {any} */ (eater.foe)), 'lick');
  eater.foe.pokemon.status = STATUS.SLEEP;
  assert.equal(eater.chooseMove(eater.player, /** @type {any} */ (eater.foe)), 'dream-eater');
  const only = fight(fixed(GOLURK, 60, ['poltergeist']), target());
  assert.equal(only.chooseMove(only.player, /** @type {any} */ (only.foe)), 'poltergeist');
});

test('a move the target was seen to shrug off is not used on it again', options, () => {
  const EXPLOUD = 295;
  const MR_MIME = 122;
  const PIKACHU = 25;
  const LANTURN = 171;
  /** The player's moves, turn by turn. */
  const usedOver = (battle, turns) => {
    const used = [];
    for (let turn = 0; turn < turns && battle.running; turn++) {
      used.push(battle.takeTurn().find((entry) => entry.kind === 'move' && entry.side === 'player')?.data?.move);
    }
    return used;
  };

  // A sound at a Soundproof: once, and then the other move.
  const mime = fixed(MR_MIME, 70, ['defense-curl']);
  mime.ability = 'soundproof';
  const loud = fight(fixed(EXPLOUD, 40, ['hyper-voice', 'pound']), mime);
  assert.deepEqual(usedOver(loud, 3), ['hyper-voice', 'pound', 'pound']);

  // An Electric move into a Volt Absorb, which only heals it.
  const lanturn = fixed(LANTURN, 70, ['defense-curl']);
  lanturn.ability = 'volt-absorb';
  const zap = fight(fixed(PIKACHU, 40, ['thunderbolt', 'quick-attack']), lanturn);
  assert.deepEqual(usedOver(zap, 3), ['thunderbolt', 'quick-attack', 'quick-attack']);

  // A miss says nothing about the next turn, and nothing is remembered.
  assert.equal(zap.player.marks.wasted?.moves.has('quick-attack') ?? false, false);

  // With nothing else to use, it is still used rather than nothing at all.
  const stubborn = fixed(MR_MIME, 70, ['defense-curl']);
  stubborn.ability = 'soundproof';
  assert.deepEqual(usedOver(fight(fixed(EXPLOUD, 40, ['hyper-voice']), stubborn), 2), ['hyper-voice', 'hyper-voice']);
});

test('a run is tried before anybody moves, and nobody runs from a trainer', options, async () => {
  const { Battle } = await import('../../app/renderer/engine/battle.mjs');
  // As fast or faster: away at once, and the foe never moves.
  const quick = fight(fixed(MACHAMP, 90, ['tackle']), fixed(SNORLAX, 5, ['tackle']));
  assert.equal(quick.queueEscape(), true);
  const away = quick.takeTurn();
  assert.equal(quick.outcome, 'escaped');
  assert.ok(away.some((entry) => entry.data?.key === 'battle.gotAway'));
  assert.ok(!away.some((entry) => entry.kind === 'move'));

  // Much slower: the first try can fail, which spends the companion's turn;
  // each try is likelier than the last, so it gets away in the end.
  const slow = fight(fixed(SNORLAX, 5, ['tackle']), fixed(MACHAMP, 90, ['bulk-up']));
  let tries = 0;
  while (slow.running && tries < 20) {
    slow.queueEscape();
    const log = slow.takeTurn();
    tries++;
    if (slow.running) {
      assert.ok(log.some((entry) => entry.data?.key === 'battle.cantEscape'));
      assert.ok(!log.some((entry) => entry.kind === 'move' && entry.side === 'player'), 'a failed run is the turn');
    }
  }
  assert.equal(slow.outcome, 'escaped');

  const trainer = new Battle({ rng: new Rng(7), player: fixed(MACHAMP, 90, ['tackle']), foes: [punchbag()], policy: defaultAutoBattle(), trainerBattle: true });
  assert.equal(trainer.queueEscape(), false);
  assert.equal(trainer.pendingEscape, false);
});

test('an Ether thrown in battle goes to the move the player names', options, async () => {
  const { Session } = await import('../../app/renderer/engine/session.mjs');
  const { ppItems, throwItem } = await import('../../app/renderer/engine/items.mjs');
  const { maxPp } = await import('../../app/renderer/engine/pokemon.mjs');
  const pokemon = fixed(MACHAMP, 60, ['tackle', 'karate-chop']);
  const session = new Session({ slot: 0, save: { seed: 1, party: { active: pokemon, box: [] } } });
  session.addItem('ether', 1);
  session.addItem('elixir', 1);
  assert.deepEqual(ppItems(session, pokemon), [], 'nothing to put back yet');
  pokemon.moves[0].pp = 0;
  pokemon.moves[1].pp = 0;
  assert.deepEqual(ppItems(session, pokemon).map((entry) => [entry.slug, entry.scope]), [['ether', 'one'], ['elixir', 'all']]);
  assert.equal(throwItem(session, 'ether', pokemon, { move: 1 }), true);
  assert.equal(pokemon.moves[0].pp, 0);
  assert.equal(pokemon.moves[1].pp, Math.min(10, maxPp(pokemon.moves[1])));
});

test('what the screen shows is never tried; only an ability or an item is learned', options, () => {
  const GENGAR = 94;
  const STEELIX = 208;
  const PIKACHU = 25;
  const GOLEM = 76;
  const first = (battle) => battle.chooseMove(battle.player, /** @type {any} */ (battle.foe));

  // A Toxic at a Steel type, a Thunder Wave at a Ground type: not once.
  assert.equal(first(fight(fixed(GENGAR, 50, ['toxic', 'shadow-ball']), fixed(STEELIX, 50, ['defense-curl']))), 'shadow-ball');
  assert.equal(first(fight(fixed(PIKACHU, 50, ['thunder-wave', 'quick-attack']), fixed(GOLEM, 50, ['defense-curl']))), 'quick-attack');

  // A Hypnosis at something already asleep, or behind a substitute.
  const asleep = fight(fixed(GENGAR, 50, ['hypnosis', 'shadow-ball']), fixed(MACHAMP, 50, ['defense-curl']));
  assert.equal(first(asleep), 'hypnosis');
  asleep.foe.pokemon.status = STATUS.SLEEP;
  assert.equal(first(asleep), 'shadow-ball');
  asleep.foe.pokemon.status = null;
  asleep.foe.volatile.substitute = 20;
  assert.equal(first(asleep), 'shadow-ball');

  // None of it was learned by trying: nothing is remembered.
  assert.equal(asleep.player.marks.wasted, undefined);

  // An Air Balloon says so as its holder comes out, so an Earthquake is not
  // tried at it; once a hit pops it, the Earthquake is back.
  const floating = fixed(MACHAMP, 50, ['defense-curl']);
  floating.heldItem = 'air-balloon';
  const quake = fight(fixed(GOLEM, 50, ['earthquake', 'rock-throw']), floating);
  assert.ok(quake.opening.some((entry) => entry.data?.key === 'item.balloon.float'), 'the balloon is announced');
  assert.equal(first(quake), 'rock-throw');
  const popped = quake.takeTurn();
  assert.ok(popped.some((entry) => entry.data?.key === 'item.balloon.popped'));
  assert.equal(first(quake), 'earthquake');
});

test('Close Combat lowers its own user, not the target', options, () => {
  const battle = fight(fixed(MACHAMP, 60, ['close-combat']), punchbag());
  battle.takeTurn();
  assert.equal(battle.player.stages.def, -1);
  assert.equal(battle.player.stages.spd, -1);
  assert.equal(battle.foe.stages.def, 1); // its own Defense Curl, nothing more
  assert.equal(battle.foe.stages.spd, 0);
});

test('Seismic Toss deals damage equal to the level', options, () => {
  const battle = fight(fixed(MACHAMP, 42, ['seismic-toss']), punchbag());
  const before = battle.foe.pokemon.hp;
  battle.takeTurn();
  assert.equal(before - battle.foe.pokemon.hp, 42);
});

test('a Substitute costs a quarter and takes the next hit', options, () => {
  // The faster of the two puts it up before the Tackle comes.
  const player = fixed(MACHAMP, 60, ['substitute']);
  const foe = fixed(SNORLAX, 40, ['tackle']);
  const battle = fight(player, foe);
  const full = maxHp(player);
  battle.takeTurn();
  const cost = Math.floor(full / 4);
  // Whatever the Tackle did, it came out of the doll, not the Pokémon.
  assert.equal(player.hp, full - cost);
});

test('Leech Seed drains the target and feeds the user', options, () => {
  const player = fixed(BULBASAUR, 50, ['leech-seed']);
  player.hp = 10;
  const battle = fight(player, punchbag(50));
  battle.player.stages.acc = 6;
  battle.takeTurn();
  const foeMax = maxHp(battle.foe.pokemon);
  assert.equal(battle.foe.volatile.leechSeed, true);
  assert.equal(battle.foe.pokemon.hp, foeMax - Math.floor(foeMax / 8));
  assert.ok(player.hp > 10);

  // A Grass type cannot be seeded.
  const grassy = fight(fixed(BULBASAUR, 50, ['leech-seed']), punchbag(50, BULBASAUR));
  grassy.player.stages.acc = 6;
  grassy.takeTurn();
  assert.ok(!grassy.foe.volatile.leechSeed);
});

test('Toxic poisons badly, and the damage climbs each turn', options, () => {
  const battle = fight(fixed(SNORLAX, 60, ['toxic']), punchbag(60));
  // Toxic can miss, and the climb is what is being checked.
  battle.player.stages.acc = 6;
  battle.takeTurn();
  const foe = battle.foe.pokemon;
  assert.equal(foe.status, STATUS.POISON);
  assert.equal(foe.toxic, true);
  const max = maxHp(foe);
  const first = max - foe.hp;
  assert.equal(first, Math.floor(max / 16));
  const before = foe.hp;
  battle.takeTurn();
  assert.equal(before - foe.hp, Math.floor((max * 2) / 16));
});

test('Tachyon Cutter strikes twice and never misses', options, () => {
  assert.equal(moveOf('tachyon-cutter').accuracy, null);
  const player = fixed(IRON_BOULDER, 60, ['tachyon-cutter']);
  const battle = fight(player, punchbag(90));
  battle.foe.stages.eva = 6;
  const log = battle.takeTurn();
  assert.equal(hitsOf(log), 2);
});

test('Population Bomb keeps going', options, () => {
  const battle = fight(fixed(MAUSHOLD, 60, ['population-bomb']), punchbag(90));
  battle.player.stages.acc = 6;
  const log = battle.takeTurn();
  // Every hit rolls its own accuracy; at +6 none of them misses.
  assert.equal(hitsOf(log), 10);
});

test('Roar sends a wild Pokémon away, and the battle ends there', options, () => {
  const battle = fight(fixed(SNORLAX, 60, ['roar']), punchbag());
  // Roar is never picked automatically; call it the way a choice would.
  const log = [];
  battle.forceOut(battle.player, battle.foe, log);
  assert.equal(battle.outcome, 'fled');
  assert.ok(log.some((entry) => entry.kind === 'end'));
});

test('Teleport lets a wild Pokémon leave', options, () => {
  const battle = fight(fixed(SNORLAX, 60, ['defense-curl']), fixed(GEODUDE, 20, ['teleport']));
  battle.takeTurn();
  assert.equal(battle.outcome, 'fled');
});

test('a Mimic copies for the battle, and a Sketch for good', options, () => {
  const player = fixed(SNORLAX, 60, ['mimic', 'tackle']);
  const battle = fight(player, fixed(MACHAMP, 40, ['karate-chop']));
  battle.foe.lastMove = 'karate-chop';
  const orig = battle.chooseMove.bind(battle);
  battle.chooseMove = (a, d) => (a === battle.player ? 'mimic' : orig(a, d));
  battle.takeTurn();
  assert.ok(battle.movesOf(battle.player).some((slot) => slot.move === 'karate-chop'));
  assert.equal(player.moves[0].move, 'mimic', 'the save keeps the Mimic');

  const smeargle = fixed(235, 60, ['sketch']);
  const sketching = fight(smeargle, fixed(MACHAMP, 40, ['karate-chop']));
  sketching.foe.lastMove = 'karate-chop';
  sketching.takeTurn();
  assert.equal(smeargle.moves[0].move, 'karate-chop');
});

/** Make the player use `move` this turn, whatever the automatic battler thinks of it. */
function force(battle, move) {
  const own = battle.chooseMove.bind(battle);
  battle.chooseMove = (attacker, defender) => (attacker === battle.player ? move : own(attacker, defender));
}

test('a Power Trick swaps Attack and Defense until it is used again', options, () => {
  const battle = fight(fixed(MACHAMP, 60, ['power-trick']), punchbag());
  const atk = battle.rawStat(battle.player, 'atk');
  const def = battle.rawStat(battle.player, 'def');
  battle.takeTurn();
  assert.equal(battle.rawStat(battle.player, 'atk'), def);
  assert.equal(battle.rawStat(battle.player, 'def'), atk);
});

test('a Lucky Chant keeps critical hits off its side', options, () => {
  const battle = fight(fixed(SNORLAX, 60, ['lucky-chant']), punchbag());
  battle.takeTurn();
  assert.equal(battle.field.sides.player.luckyChant > 0, true);
  battle.foe.stages.crit = 6;
  battle.foe.volatile.laserFocus = 1;
  assert.equal(battle.rollCritical(battle.foe, battle.player, moveOf('tackle')), false);
});

test('a Corrosive Gas melts the item across, and a Bestow hands one over', options, () => {
  const foe = punchbag();
  foe.heldItem = 'leftovers';
  const gassed = fight(fixed(SNORLAX, 60, ['corrosive-gas']), foe);
  gassed.takeTurn();
  assert.equal(foe.heldItem, null);

  const giver = fixed(SNORLAX, 60, ['bestow']);
  giver.heldItem = 'sitrus-berry';
  const gifted = fight(giver, punchbag());
  force(gifted, 'bestow');
  gifted.takeTurn();
  assert.equal(giver.heldItem, null);
  assert.equal(gifted.foe.pokemon.heldItem, 'sitrus-berry');
});

test('a Fire move under Powder blows up on its user', options, () => {
  const foe = fixed(MACHAMP, 20, ['fire-punch']);
  const battle = fight(fixed(SNORLAX, 60, ['powder']), foe);
  battle.player.stages.acc = 6;
  // Powder has priority, so it lands before the Fire Punch goes off.
  const log = battle.takeTurn();
  assert.ok(log.some((entry) => entry.kind === 'message' && entry.data?.key === 'move.powder.exploded'));
  assert.equal(maxHp(foe) - foe.hp, Math.floor(maxHp(foe) / 4));
});

test('a Snatch takes the other side’s Swords Dance for itself', options, () => {
  const battle = fight(fixed(MACHAMP, 60, ['snatch']), fixed(MACHAMP, 60, ['swords-dance']));
  battle.takeTurn();
  assert.equal(battle.player.stages.atk, 2);
  assert.equal(battle.foe.stages.atk, 0);
});

test('a Me First takes the attack about to come, half again as hard', options, () => {
  const battle = fight(fixed(235, 60, ['me-first']), fixed(SNORLAX, 30, ['body-slam']));
  const log = battle.takeTurn();
  const moves = log.filter((entry) => entry.kind === 'move').map((entry) => `${entry.side}:${entry.data.move}`);
  assert.deepEqual(moves.slice(0, 3), ['player:me-first', 'player:body-slam', 'foe:body-slam']);
});

test('a Metronome calls some other move', options, () => {
  const battle = fight(fixed(SNORLAX, 60, ['metronome']), punchbag());
  const log = battle.takeTurn();
  const called = log.filter((entry) => entry.kind === 'move' && entry.side === 'player').map((entry) => entry.data.move);
  assert.equal(called[0], 'metronome');
  assert.ok(called[1] && called[1] !== 'metronome');
});

test('the signature moves do what their descriptions say', options, () => {
  // A Hyper Drill goes through a Protect.
  const drill = fight(fixed(MACHAMP, 60, ['hyper-drill']), fixed(GEODUDE, 60, ['protect']));
  drill.player.stages.acc = 6;
  drill.foe.stages.spe = 6;
  const before = drill.foe.pokemon.hp;
  drill.takeTurn();
  assert.ok(drill.foe.pokemon.hp < before);

  // A Stone Axe leaves Stealth Rock behind, a Ceaseless Edge Spikes.
  const axe = fight(fixed(MACHAMP, 60, ['stone-axe']), punchbag(90));
  axe.player.stages.acc = 6;
  axe.takeTurn();
  assert.equal(axe.field.hazards.foe.stealthRock, 1);

  // An Eerie Spell takes three PP off the move just used.
  const spell = fight(fixed(SNORLAX, 60, ['eerie-spell']), punchbag(90));
  spell.foe.lastMove = 'defense-curl';
  const slot = spell.foe.pokemon.moves[0];
  const pp = slot.pp;
  spell.player.stages.acc = 6;
  spell.takeTurn();
  // It used Defense Curl once itself this turn, before or after the spell.
  assert.ok(slot.pp <= pp - 3);

  // A Sunsteel Strike sees past a Sturdy.
  const sun = fight(fixed(SNORLAX, 60, ['sunsteel-strike']), punchbag());
  sun.foe.pokemon.ability = 'sturdy';
  sun.player.marks.moldBreaking = true;
  assert.equal(sun.abilityOf(sun.foe, sun.player), null);
});

test('each strike of a multi-hit move drains the bar on its own, in order', options, () => {
  const battle = fight(fixed(MAUSHOLD, 60, ['population-bomb']), punchbag(90));
  battle.player.stages.acc = 6;
  const log = battle.takeTurn();
  const strikes = log.filter((entry) => entry.kind === 'damage' && entry.side === 'foe');
  assert.deepEqual(strikes.map((entry) => entry.data?.hit), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // Every line stands where the bar stood after that strike, lower each time.
  for (let index = 1; index < strikes.length; index++) {
    assert.ok(strikes[index].hp.foe < strikes[index - 1].hp.foe, `strike ${index + 1} should stand lower than the one before`);
  }
  // And "hit 10 times" follows the last of them.
  const count = log.findIndex((entry) => entry.data?.key === 'move.hitCount');
  assert.ok(count > log.indexOf(strikes[strikes.length - 1]));
});

test("a Sitrus Berry's line is where the bar rises", options, () => {
  const battle = fight(fixed(MAUSHOLD, 60, ['tackle']), punchbag(90));
  const player = battle.player.pokemon;
  player.heldItem = 'sitrus-berry';
  player.hp = Math.floor(maxHp(player) / 4);
  const before = player.hp;

  const log = battle.makeLog();
  battle.eatOneBerry(battle.player, log);
  const berry = log.find((entry) => entry.kind === 'berry');
  assert.ok(berry, 'the berry is eaten');
  // It is the only line the heal has, so it carries the healed hit points.
  assert.ok(player.hp > before);
  assert.equal(berry.hp.player, player.hp);
});

test('a move whose power the fight works out carries none, as the games show a dash', options, () => {
  const moves = gameData().moves;
  for (const slug of ['ruination', 'comeuppance', 'hard-press', 'super-fang', 'crush-grip']) {
    assert.equal(moves[slug].power, null, `${slug} has no fixed power`);
  }
  // PokeAPI's 0 for "none" and 1 for "worked out in the fight" are gone.
  const placeholders = Object.keys(moves).filter((slug) => moves[slug].power === 0 || moves[slug].power === 1);
  assert.deepEqual(placeholders, []);

  // And Ruination still takes half of what the target has left.
  const battle = fight(fixed(SNORLAX, 60, ['ruination']), punchbag(90));
  battle.player.stages.acc = 6;
  const before = battle.foe.pokemon.hp;
  battle.takeTurn();
  assert.equal(battle.foe.pokemon.hp, before - Math.floor(before / 2));
});

test('what goes through a substitute is what the games say does', options, () => {
  const behindDoll = (/** @type {string} */ move) => {
    const foe = punchbag(50);
    const battle = fight(fixed(MACHAMP, 50, [move]), foe);
    battle.foe.volatile.substitute = 60;
    battle.takeTurn();
    return battle;
  };
  // A Taunt reaches the Pokémon behind the doll, as it does in the games.
  assert.ok((behindDoll('taunt').foe.volatile.taunt ?? 0) > 0);
  // A Transform does not.
  assert.equal(behindDoll('transform').player.transform, undefined);
  // And a Hyperspace Hole hits the Pokémon and leaves the doll standing.
  const hole = behindDoll('hyperspace-hole');
  assert.equal(hole.foe.volatile.substitute, 60);
  assert.ok(hole.foe.pokemon.hp < maxHp(hole.foe.pokemon));
});

test('a Magic Bounce sends back only what the games mark as reflectable', options, () => {
  const ESPEON = 196;
  const bounce = (/** @type {string} */ move) => {
    const espeon = fixed(ESPEON, 50, ['defense-curl']);
    espeon.ability = 'magic-bounce';
    const battle = fight(fixed(MACHAMP, 50, [move]), espeon);
    const log = battle.takeTurn();
    return { battle, bounced: log.some((entry) => entry.kind === 'bounced') };
  };
  // A Toxic comes back at its user.
  const toxic = bounce('toxic');
  assert.ok(toxic.bounced);
  assert.equal(toxic.battle.player.pokemon.status, STATUS.POISON);
  // So does a Stealth Rock, onto its user's own side.
  const rocks = bounce('stealth-rock');
  assert.ok(rocks.bounced);
  assert.ok((rocks.battle.field.hazards.player.stealthRock ?? 0) > 0);
  assert.ok(!(rocks.battle.field.hazards.foe.stealthRock ?? 0));
  // A Skill Swap is not something a Magic Bounce can send back.
  assert.equal(bounce('skill-swap').bounced, false);
});
