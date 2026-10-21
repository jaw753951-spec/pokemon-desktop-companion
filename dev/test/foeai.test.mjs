/**
 * How the other side picks its moves: a knock-out when there is one, a sleep
 * before a trade of blows, a heal when the health has run low, a set-up while
 * there is time for it, and a priority move when about to go down first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { speciesIdBySlug } from '../../app/renderer/core/data.mjs';
import { Battle, STATUS } from '../../app/renderer/engine/battle.mjs';
import { expectedThreat, scoreMove, sizeUp } from '../../app/renderer/engine/foeai.mjs';
import { TERRAIN } from '../../app/renderer/engine/field.mjs';
import { createPokemon, maxHp, setMove } from '../../app/renderer/engine/pokemon.mjs';
import { defaultAutoBattle } from '../../app/renderer/engine/session.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

/** @param {string} slug @param {number} level @param {string[]} moves */
function make(slug, level, moves) {
  const pokemon = createPokemon(new Rng(1), /** @type {number} */ (speciesIdBySlug(slug)), level, { ivFloor: 31 });
  pokemon.nature = 'hardy';
  pokemon.heldItem = null;
  pokemon.moves = [];
  moves.forEach((move, index) => setMove(pokemon, index, move));
  pokemon.hp = maxHp(pokemon);
  return pokemon;
}

/** @param {any} player @param {any} foe @param {boolean} [trainerBattle] */
const fight = (player, foe, trainerBattle = false) =>
  new Battle({ rng: new Rng(3), player, foes: [foe], policy: defaultAutoBattle(), trainerBattle });

/** @param {Battle} battle */
const foePicks = (battle) => battle.chooseMove(/** @type {any} */ (battle.foe), battle.player);

test('a healthy target is put to sleep before the blows are traded', options, () => {
  const battle = fight(make('pikachu', 30, ['thunderbolt']), make('breloom', 30, ['seed-bomb', 'spore']));
  assert.equal(foePicks(battle), 'spore');
  battle.player.pokemon.status = STATUS.SLEEP;
  assert.equal(foePicks(battle), 'seed-bomb');
});

test('a knock-out on the table is taken', options, () => {
  const battle = fight(make('pikachu', 30, ['thunderbolt']), make('breloom', 30, ['spore', 'seed-bomb', 'swords-dance']));
  battle.player.pokemon.hp = 5;
  assert.equal(foePicks(battle), 'seed-bomb');
});

test('a Pokémon about to go down first reaches for its priority move', options, () => {
  const battle = fight(make('eevee', 40, ['tackle']), make('machop', 40, ['karate-chop', 'mach-punch']));
  assert.equal(foePicks(battle), 'karate-chop');
  battle.foe.pokemon.hp = 1;
  assert.equal(foePicks(battle), 'mach-punch');
  // Something faster has no need to: it gets its full swing in first.
  const quick = fight(make('eevee', 30, ['tackle']), make('pidgeot', 40, ['wing-attack', 'quick-attack']));
  quick.foe.pokemon.hp = 1;
  assert.equal(foePicks(quick), 'wing-attack');
});

test('it heals when the health has run low, not at the top of it', options, () => {
  const battle = fight(make('eevee', 30, ['tackle']), make('chansey', 30, ['pound', 'soft-boiled']));
  assert.equal(foePicks(battle), 'pound');
  battle.foe.pokemon.hp = Math.floor(maxHp(battle.foe.pokemon) * 0.3);
  assert.equal(foePicks(battle), 'soft-boiled');
});

test('it sets up while there is time, and stops once it has', options, () => {
  const battle = fight(make('chansey', 40, ['pound']), make('scyther', 40, ['swords-dance', 'quick-attack']));
  assert.equal(foePicks(battle), 'swords-dance');
  battle.foe.stages.atk = 4;
  assert.equal(foePicks(battle), 'quick-attack');
  // Not with the other side able to take it down this turn, either.
  battle.foe.stages.atk = 0;
  battle.foe.pokemon.hp = 1;
  assert.equal(foePicks(battle), 'quick-attack');
});

test('an Explosion waits for the end, and a trap for the companion is never laid', options, () => {
  const battle = fight(make('charmander', 25, ['ember']), make('geodude', 25, ['rock-throw', 'self-destruct', 'stealth-rock']));
  assert.equal(foePicks(battle), 'rock-throw');
});

test('the companion\'s moves are not known until shown, and only a trainer remembers them', options, () => {
  const vaporeon = () => make('vaporeon', 40, ['water-gun', 'thunderbolt']);
  const gyarados = () => make('gyarados', 40, ['waterfall']);

  // What anyone can see is a Water type, and Water does little to Gyarados.
  const wild = fight(vaporeon(), gyarados());
  const guessed = expectedThreat(wild, /** @type {any} */ (wild.foe), wild.player).threat;
  wild.takeTurn();
  assert.ok(wild.seenMoves.size > 0);
  wild.foe.pokemon.hp = maxHp(wild.foe.pokemon);
  assert.equal(expectedThreat(wild, /** @type {any} */ (wild.foe), wild.player).threat, guessed, 'a wild Pokémon pays it no mind');

  // A trainer that has watched the Thunderbolt land knows better.
  const trainer = fight(vaporeon(), gyarados(), true);
  assert.equal(expectedThreat(trainer, /** @type {any} */ (trainer.foe), trainer.player).threat, guessed);
  trainer.seenMoves.add('thunderbolt');
  assert.ok(expectedThreat(trainer, /** @type {any} */ (trainer.foe), trainer.player).threat > guessed * 3);
});

/** @param {any} player @param {any[]} foes */
const trainerFight = (player, foes) =>
  new Battle({ rng: new Rng(3), player, foes, policy: defaultAutoBattle(), trainerBattle: true });

/** @param {Battle} battle @param {string} slug */
const foeScore = (battle, slug) => {
  const foe = /** @type {any} */ (battle.foe);
  return scoreMove(battle, sizeUp(battle, foe, battle.player, battle.movesOf(foe)), slug);
};

test('a stat that has gone as far as it goes is not pushed again', options, () => {
  const battle = fight(make('machop', 30, ['karate-chop']), make('clefairy', 30, ['charm', 'pound']));
  battle.player.stages.atk = -6;
  assert.equal(foePicks(battle), 'pound');
  assert.ok(battle.alreadyInPlace(/** @type {any} */ (battle.foe), battle.player, 'charm'));

  const shell = fight(make('pikachu', 30, ['thunder-shock']), make('squirtle', 30, ['withdraw', 'tackle']));
  shell.foe.stages.def = 6;
  assert.ok(shell.alreadyInPlace(/** @type {any} */ (shell.foe), shell.player, 'withdraw'));
  assert.equal(foePicks(shell), 'tackle');

  // A Mist keeps a Growl off as surely as a stage at -6 does.
  const misted = fight(make('machop', 30, ['karate-chop']), make('eevee', 30, ['growl', 'tackle']));
  assert.ok(!misted.alreadyInPlace(/** @type {any} */ (misted.foe), misted.player, 'growl'));
  misted.field.sides.player.mist = 5;
  assert.ok(misted.alreadyInPlace(/** @type {any} */ (misted.foe), misted.player, 'growl'));
});

test('a heal at full health, a Yawn into Electric Terrain and a Venom Drench at the unpoisoned are passed over', options, () => {
  const battle = fight(make('eevee', 30, ['tackle']), make('chansey', 30, ['pound', 'soft-boiled', 'yawn']));
  const foe = /** @type {any} */ (battle.foe);
  assert.ok(battle.alreadyInPlace(foe, battle.player, 'soft-boiled'));
  foe.pokemon.hp = Math.floor(maxHp(foe.pokemon) / 2);
  assert.ok(!battle.alreadyInPlace(foe, battle.player, 'soft-boiled'));

  assert.ok(!battle.visiblyUseless(foe, battle.player, 'yawn'));
  battle.field.terrain = TERRAIN.ELECTRIC;
  assert.ok(battle.visiblyUseless(foe, battle.player, 'yawn'));

  assert.ok(battle.alreadyInPlace(foe, battle.player, 'venom-drench'));
  battle.player.pokemon.status = STATUS.POISON;
  assert.ok(!battle.alreadyInPlace(foe, battle.player, 'venom-drench'));
});

test('the last Pokémon a trainer has does not throw itself away', options, () => {
  const mementoUser = () => make('murkrow', 30, ['peck', 'memento']);
  const alone = trainerFight(make('machop', 30, ['karate-chop']), [mementoUser()]);
  alone.foe.pokemon.hp = 2;
  assert.equal(foeScore(alone, 'memento'), 0);
  assert.equal(foePicks(alone), 'peck');
  // With someone still to come, a Memento on the way down is a parting gift.
  const backed = trainerFight(make('machop', 30, ['karate-chop']), [mementoUser(), make('pidgey', 30, ['tackle'])]);
  backed.foe.pokemon.hp = 2;
  assert.ok(foeScore(backed, 'memento') > 0);

  // An Explosion from the last one only to take the other side down with it.
  const geodude = trainerFight(make('chansey', 40, ['pound']), [make('geodude', 40, ['tackle', 'self-destruct'])]);
  geodude.foe.pokemon.hp = 1;
  assert.equal(foeScore(geodude, 'self-destruct'), 0);
  geodude.player.pokemon.hp = 5;
  assert.ok(foeScore(geodude, 'self-destruct') > 0);
});

test('a status move seen to come to nothing against this target is a poor bet after', options, () => {
  const battle = fight(make('machop', 30, ['karate-chop']), make('clefairy', 30, ['charm', 'pound']));
  const before = foeScore(battle, 'charm');
  battle.foe.marks.fizzled = { target: battle.player, moves: new Set(['charm']) };
  assert.ok(foeScore(battle, 'charm') < before * 0.2);
});
