/**
 * Rules the battle had wrong against the main series, found by using every
 * move once and reading every ability against the games: abilities that acted
 * on the wrong side or on the wrong moves, moves that failed where they work,
 * and states that let a Pokémon do what the games do not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { gameData, moveOf } from '../../app/renderer/core/data.mjs';
import { abilityInert, abilityWorks, hasSecondary } from '../../app/renderer/engine/abilities.mjs';
import { Battle } from '../../app/renderer/engine/battle.mjs';
import { createPokemon, maxHp, setMove } from '../../app/renderer/engine/pokemon.mjs';
import { defaultAutoBattle } from '../../app/renderer/engine/session.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

/** Dice that always come up: every chance taken, every roll at its lowest. */
class Yes extends Rng {
  next() { return 0; }
  int(min) { return min; }
  chance(chance) { return chance > 0; }
  pick(list) { return list[0]; }
}

/** Dice that never do: no chance under a certainty, every roll at its highest. */
class No extends Rng {
  next() { return 0.999999; }
  int(min, max) { return max; }
  chance(chance) { return chance >= 1; }
  pick(list) { return list[0]; }
}

/** @param {string} slug */
const idOf = (slug) => {
  const found = Object.values(gameData().species).find((species) => species.slug === slug);
  assert.ok(found, `no species ${slug}`);
  return found.id;
};

/** A Pokémon with settled genes, so a number in a test means something. */
function make(slug, { level = 50, moves = ['splash'], ability = 'no-ability', item = null, hp = 1, status = null } = {}) {
  const pokemon = createPokemon(new Rng(1), idOf(slug), level, { ivFloor: 31, shiny: false });
  pokemon.nature = 'hardy';
  pokemon.ability = ability;
  pokemon.heldItem = item;
  pokemon.moves = [];
  moves.forEach((move, index) => setMove(pokemon, index, move));
  pokemon.hp = Math.max(1, Math.floor(maxHp(pokemon) * hp));
  if (status) pokemon.status = status;
  return pokemon;
}

function fight(player, foes, extra = {}) {
  return new Battle({
    rng: new No(1), player, foes: Array.isArray(foes) ? foes : [foes], policy: defaultAutoBattle(), trainerBattle: true, ...extra,
  });
}

const kinds = (log, side, kind) => log.filter((entry) => entry.side === side && entry.kind === kind);
const hitsOn = (log, side) => kinds(log, side, 'damage').filter((entry) => entry.data?.hit).length;
const damageTo = (log, side) => kinds(log, side, 'damage').reduce((sum, entry) => sum + (entry.data?.amount ?? 0), 0);

test('a Poison Touch poisons what its holder touches, not what touches its holder', options, () => {
  const striking = fight(make('grimer', { ability: 'poison-touch', moves: ['tackle'] }), make('wailord'), { rng: new Yes(1) });
  striking.takeTurn();
  assert.equal(striking.foe.pokemon.status, 'psn');

  const struck = fight(make('wailord', { moves: ['tackle'] }), make('grimer', { ability: 'poison-touch' }), { rng: new Yes(1) });
  struck.takeTurn();
  assert.equal(struck.player.pokemon.status, null);

  // A Covert Cloak keeps it off, as it does any side effect.
  const cloaked = fight(make('grimer', { ability: 'poison-touch', moves: ['tackle'] }), make('wailord', { item: 'covert-cloak' }), { rng: new Yes(1) });
  cloaked.takeTurn();
  assert.equal(cloaked.foe.pokemon.status, null);
});

test('a Toxic Chain leaves the bad poison', options, () => {
  const battle = fight(make('pecharunt', { ability: 'toxic-chain', moves: ['tackle'] }), make('wailord'), { rng: new Yes(1) });
  battle.takeTurn();
  assert.equal(battle.foe.pokemon.status, 'psn');
  assert.equal(battle.foe.pokemon.toxic, true);
});

test('a Sheer Force is paid for a secondary effect, and not for the price of a move', options, () => {
  // What the games count: a Flamethrower's burn, a Salt Cure's salt, a Stone
  // Axe's splinters — not a Close Combat's drops or a Fire Spin's hold.
  for (const slug of ['flamethrower', 'salt-cure', 'stone-axe', 'flame-charge', 'spirit-shackle']) assert.ok(hasSecondary(moveOf(slug)), slug);
  for (const slug of ['close-combat', 'overheat', 'fire-spin', 'meteor-beam', 'tackle', 'swords-dance']) assert.ok(!hasSecondary(moveOf(slug)), slug);

  const hit = (ability, move) => {
    const battle = fight(make('machamp', { ability, moves: [move] }), make('wailord'));
    return damageTo(battle.takeTurn(), 'foe');
  };
  assert.equal(hit('sheer-force', 'close-combat'), hit('no-ability', 'close-combat'));
  assert.ok(hit('sheer-force', 'ice-punch') > hit('no-ability', 'ice-punch'));

  // And the effect it traded away does not happen.
  const salted = fight(make('garganacl', { ability: 'sheer-force', moves: ['salt-cure'] }), make('wailord'));
  salted.takeTurn();
  assert.ok(!salted.foe.volatile.saltCure);
  const plain = fight(make('garganacl', { moves: ['salt-cure'] }), make('wailord'));
  plain.takeTurn();
  assert.ok(plain.foe.volatile.saltCure);
});

test('a Clear Amulet turns an Intimidate away', options, () => {
  const battle = fight(make('wailord', { item: 'clear-amulet' }), make('gyarados', { ability: 'intimidate' }));
  assert.equal(battle.player.stages.atk, 0);
  assert.equal(battle.player.pokemon.heldItem, 'clear-amulet');
  // Without it, the Attack goes down.
  assert.equal(fight(make('wailord'), make('gyarados', { ability: 'intimidate' })).player.stages.atk, -1);
});

test('a Taunt leaves a Pokémon that knows only status moves a Struggle', options, () => {
  const battle = fight(make('mew', { moves: ['taunt'], level: 80 }), make('wailord', { moves: ['growl', 'splash'] }));
  // The Taunt lands first: the Growl already chosen is not used.
  const first = battle.takeTurn();
  assert.equal(kinds(first, 'foe', 'volatileBlocked')[0]?.data?.move, 'growl');
  assert.equal(battle.player.stages.atk, 0);
  // And from then on there is nothing it may choose.
  assert.equal(battle.chooseMove(battle.foe, battle.player), 'struggle');
});

test('a Queenly Majesty and Psychic Terrain refuse a move that cuts in, and nothing else', options, () => {
  const majesty = fight(make('rattata', { moves: ['quick-attack'] }), make('tsareena', { ability: 'queenly-majesty' }));
  assert.equal(damageTo(majesty.takeTurn(), 'foe'), 0);
  assert.equal(damageTo(fight(make('rattata', { moves: ['tackle'] }), make('tsareena', { ability: 'queenly-majesty' })).takeTurn(), 'foe') > 0, true);

  // On Psychic Terrain a priority attack fails, a Prankster's status move
  // with it — and a Protect, which is aimed at nobody, goes up as ever.
  const terrain = (player) => fight(player, make('indeedee', { ability: 'psychic-surge', moves: ['tackle'] }), { rng: new Yes(1) });
  assert.equal(damageTo(terrain(make('rattata', { moves: ['quick-attack'] })).takeTurn(), 'foe'), 0);
  const pranked = terrain(make('sableye', { ability: 'prankster', moves: ['thunder-wave'] }));
  pranked.takeTurn();
  assert.equal(pranked.foe.pokemon.status, null);
  const guarded = terrain(make('mew', { moves: ['protect'] }));
  const log = guarded.takeTurn();
  assert.equal(kinds(log, 'player', 'protect').length, 1);
  assert.equal(damageTo(log, 'player'), 0);
});

test('a Last Resort works once every other move has been used', options, () => {
  const battle = fight(make('eevee', { moves: ['tackle', 'last-resort'] }), make('wailord'));
  const use = (move) => {
    battle.chooseMove = (attacker) => (attacker.side === 'player' ? move : 'splash');
    return battle.takeTurn();
  };
  assert.equal(damageTo(use('last-resort'), 'foe'), 0, 'not before the Tackle');
  assert.ok(damageTo(use('tackle'), 'foe') > 0);
  assert.ok(damageTo(use('last-resort'), 'foe') > 0, 'and after it');
  // Alone, it never works.
  assert.equal(damageTo(fight(make('eevee', { moves: ['last-resort'] }), make('wailord')).takeTurn(), 'foe'), 0);
});

test('a Cud Chew brings its berry back up once, the turn after, and not again', options, () => {
  const battle = fight(
    make('farigiraf', { ability: 'cud-chew', item: 'sitrus-berry', hp: 0.3 }),
    make('wailord', { level: 20, moves: ['tackle'] }),
  );
  const eaten = () => [1, 2, 3, 4].map(() => kinds(battle.takeTurn(), 'player', 'berry').length);
  assert.deepEqual(eaten(), [1, 1, 0, 0]);
  assert.equal(battle.player.pokemon.heldItem, null);
});

test('a Skill Link aims a Triple Axel once for all three', options, () => {
  const strikes = (ability) => {
    const battle = fight(make('cinccino', { ability, moves: ['triple-axel'] }), make('wailord'));
    // The first aim is true and every one after it would miss.
    let aims = 0;
    battle.rollAccuracy = () => aims++ === 0;
    return hitsOn(battle.takeTurn(), 'foe');
  };
  assert.equal(strikes('skill-link'), 3);
  assert.equal(strikes('no-ability'), 1);
});

test('a Download raises Sp. Atk when the two walls are level', options, () => {
  // A Mew's Defense and Sp. Def are the same number.
  const battle = fight(make('porygon2', { ability: 'download' }), make('mew'));
  assert.equal(battle.player.stages.spa, 1);
  assert.equal(battle.player.stages.atk, 0);
});

test('an Orichalcum Pulse and a Hadron Engine feed on what they call up', options, () => {
  const koraidon = fight(make('koraidon', { ability: 'orichalcum-pulse' }), make('wailord'));
  const plain = fight(make('koraidon', { ability: 'drought' }), make('wailord'));
  assert.equal(koraidon.stat(koraidon.player, 'atk'), Math.floor(plain.stat(plain.player, 'atk') * 4 / 3));
  const miraidon = fight(make('miraidon', { ability: 'hadron-engine' }), make('wailord'));
  const surge = fight(make('miraidon', { ability: 'electric-surge' }), make('wailord'));
  assert.equal(miraidon.stat(miraidon.player, 'spa'), Math.floor(surge.stat(surge.player, 'spa') * 4 / 3));
});

test('a Beat Up lands once for each of its side that can fight', options, () => {
  // The companion travels alone.
  assert.equal(hitsOn(fight(make('weavile', { moves: ['beat-up'] }), make('wailord')).takeTurn(), 'foe'), 1);
  // A trainer's has the rest of the party behind it — but not one asleep.
  const party = [make('weavile', { moves: ['beat-up'] }), make('pikachu'), make('eevee'), make('snorlax', { status: 'slp' })];
  assert.equal(hitsOn(fight(make('wailord'), party).takeTurn(), 'player'), 3);
});

test('two layers of Toxic Spikes are the bad poison', options, () => {
  const battle = fight(make('garchomp', { level: 100, moves: ['toxic-spikes', 'earthquake'] }), [make('pikachu', { level: 5 }), make('wailord')]);
  const use = (move) => {
    battle.chooseMove = (attacker) => (attacker.side === 'player' ? move : 'splash');
    battle.takeTurn();
  };
  use('toxic-spikes');
  use('toxic-spikes');
  use('earthquake');
  assert.equal(battle.foe.pokemon.status, 'psn');
  assert.equal(battle.foe.pokemon.toxic, true);
});

test('grass underfoot halves an Earthquake, and a sandstorm fills a Shore Up', options, () => {
  const quake = (ability) => damageTo(fight(make('rillaboom', { ability, moves: ['earthquake'] }), make('wailord')).takeTurn(), 'foe');
  assert.equal(quake('grassy-surge'), Math.floor(quake('no-ability') / 2));

  const healed = (weather) => {
    const battle = fight(make('sandaconda', { moves: ['shore-up'], hp: 0.1 }), make('wailord'), { weather });
    return kinds(battle.takeTurn(), 'player', 'heal')[0]?.data?.amount;
  };
  const max = maxHp(make('sandaconda'));
  assert.equal(healed(null), Math.floor(max / 2));
  assert.equal(healed('sandstorm'), Math.floor((max * 2) / 3));
});

test('a Mold Breaker goes through a Sturdy', options, () => {
  const through = fight(make('haxorus', { level: 100, ability: 'mold-breaker', moves: ['earthquake'] }), make('geodude', { level: 5, ability: 'sturdy' }));
  through.takeTurn();
  assert.equal(through.outcome, 'won');
  const held = fight(make('haxorus', { level: 100, moves: ['earthquake'] }), make('geodude', { level: 5, ability: 'sturdy' }));
  held.takeTurn();
  assert.equal(held.foe.pokemon.hp, 1);
});

test('a Protean changes type once each time out', options, () => {
  const battle = fight(make('greninja', { ability: 'protean', moves: ['ember', 'water-gun'] }), make('wailord'));
  const use = (move) => {
    battle.chooseMove = (attacker) => (attacker.side === 'player' ? move : 'splash');
    battle.takeTurn();
  };
  use('ember');
  assert.deepEqual(battle.typesOf(battle.player), ['fire']);
  use('water-gun');
  assert.deepEqual(battle.typesOf(battle.player), ['fire']);
});

test('an Effect Spore does nothing to a Grass type', options, () => {
  const battle = fight(make('bulbasaur', { moves: ['tackle'] }), make('breloom', { ability: 'effect-spore' }), { rng: new Yes(1) });
  battle.takeTurn();
  assert.equal(battle.player.pokemon.status, null);
  const other = fight(make('rattata', { moves: ['tackle'] }), make('breloom', { ability: 'effect-spore' }), { rng: new Yes(1) });
  other.takeTurn();
  assert.ok(other.player.pokemon.status);
});

test('a Heal Block and an Embargo take hold', options, () => {
  const blocked = fight(make('mew', { moves: ['heal-block'] }), make('wailord', { moves: ['recover'], hp: 0.5 }), { rng: new Yes(1) });
  blocked.takeTurn();
  assert.ok(blocked.foe.volatile.healBlock > 0);
  const embargoed = fight(make('mew', { moves: ['embargo'] }), make('wailord', { item: 'leftovers', hp: 0.5 }), { rng: new Yes(1) });
  const log = embargoed.takeTurn();
  assert.ok(embargoed.foe.volatile.embargo > 0);
  assert.equal(kinds(log, 'foe', 'heal').length, 0, 'the Leftovers do nothing under it');
});

test('a Wonder Skin holds a status move to an even chance, and no lower', options, () => {
  const battle = fight(make('mew', { moves: ['will-o-wisp'] }), make('sigilyph', { ability: 'wonder-skin' }));
  const chanceOf = (slug) => {
    // The roll that just lands tells the chance it was held against.
    let low = 0;
    let high = 1;
    for (let step = 0; step < 20; step++) {
      const middle = (low + high) / 2;
      battle.rng.next = () => middle;
      if (battle.rollAccuracy(battle.player, battle.foe, moveOf(slug))) low = middle;
      else high = middle;
    }
    return Math.round(low * 100);
  };
  assert.equal(chanceOf('will-o-wisp'), 50, '85 becomes 50, not 42');
  assert.equal(chanceOf('thunder-wave'), 50, '90 becomes 50');
  assert.equal(chanceOf('flamethrower'), 100, 'an attack is left alone');
});

test('a Telekinesis holds its target up for three turns: no ground under it, nothing misses it', options, () => {
  const battle = fight(make('mew', { moves: ['telekinesis', 'earthquake', 'zap-cannon'] }), make('snorlax'));
  const use = (move) => {
    battle.chooseMove = (attacker) => (attacker.side === 'player' ? move : 'splash');
    return battle.takeTurn();
  };
  use('telekinesis');
  assert.equal(battle.grounded(battle.foe), false);
  assert.equal(damageTo(use('earthquake'), 'foe'), 0, 'the ground does not reach it');
  // A Zap Cannon lands half the time; these dice never let it, but for this.
  assert.ok(damageTo(use('zap-cannon'), 'foe') > 0, 'and nothing aimed at it misses');
  assert.equal(battle.grounded(battle.foe), true, 'down again after the third turn');
  assert.equal(damageTo(use('zap-cannon'), 'foe'), 0);

  // Not something too heavy to lift, nor anything while Gravity is on.
  const heavy = fight(make('mew', { moves: ['telekinesis'] }), make('dugtrio'));
  heavy.takeTurn();
  assert.ok(!heavy.foe.volatile.telekinesis);
});

test('a Supreme Overlord is a tenth stronger for each of its side that fell before it', options, () => {
  // A trainer's, sent out third behind two that went down.
  const battle = fight(
    make('garchomp', { level: 100, moves: ['dragon-claw'] }),
    [make('pikachu', { level: 5 }), make('rattata', { level: 5 }), make('kingambit', { level: 100, ability: 'supreme-overlord', moves: ['night-slash'] })],
  );
  battle.takeTurn();
  const sentOut = battle.takeTurn();
  assert.equal(battle.foe.marks.fallen, 2);
  assert.ok(sentOut.some((entry) => entry.data?.key === 'ability.supremeOverlord'), 'and says so as it comes out');
  const hit = (from) => from.computeDamage(from.foe, from.player, moveOf('night-slash'), { peek: true }).damage;
  const first = fight(make('garchomp', { level: 100, moves: ['dragon-claw'] }), make('kingambit', { level: 100, ability: 'supreme-overlord', moves: ['night-slash'] }));
  assert.equal(first.foe.marks.fallen, 0);
  const ratio = hit(battle) / hit(first);
  assert.ok(ratio > 1.15 && ratio < 1.25, `two fallen is a fifth more, not ${ratio}`);

  // The companion has nobody to fall for it, and a knock-out raises nothing.
  const alone = fight(make('kingambit', { level: 100, ability: 'supreme-overlord', moves: ['tackle'] }), [make('pikachu', { level: 5 }), make('wailord')]);
  alone.takeTurn();
  assert.equal(alone.player.marks.fallen, 0);
  assert.deepEqual([alone.player.stages.atk, alone.player.stages.spa], [0, 0]);
});

test('a Take Heart has the fifteen PP Scarlet and Violet give it', options, () => {
  assert.equal(moveOf('take-heart').pp, 15);
});

test('the abilities that wait on a party or on Terastallization say so', options, () => {
  for (const slug of ['illusion', 'zero-to-hero', 'tera-shell', 'teraform-zero']) {
    assert.ok(abilityWorks(slug) && abilityInert(slug), slug);
  }
  // And every ability in the data is one the engine knows.
  for (const slug of Object.keys(gameData().abilities)) assert.ok(abilityWorks(slug), slug);
});
