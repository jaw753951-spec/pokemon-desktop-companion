/**
 * The abilities the audit found acting wrongly or not at all: a Trace that
 * copied for good, an Intimidate nothing could shrug off, the Prankster that
 * reached a Dark type, and the rest.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { speciesIdBySlug } from '../../app/renderer/core/data.mjs';
import { abilityInert, abilityWorks } from '../../app/renderer/engine/abilities.mjs';
import { Battle } from '../../app/renderer/engine/battle.mjs';
import { WEATHER } from '../../app/renderer/engine/field.mjs';
import { createPokemon, maxHp, setMove } from '../../app/renderer/engine/pokemon.mjs';
import { defaultAutoBattle } from '../../app/renderer/engine/session.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

/** @param {string} slug @param {number} level @param {string[]} moves @param {string} [ability] */
function make(slug, level, moves = [], ability) {
  const pokemon = createPokemon(new Rng(1), /** @type {number} */ (speciesIdBySlug(slug)), level, { ivFloor: 31 });
  pokemon.nature = 'hardy';
  pokemon.heldItem = null;
  if (moves.length) {
    pokemon.moves = [];
    moves.forEach((move, index) => setMove(pokemon, index, move));
  }
  if (ability) pokemon.ability = ability;
  pokemon.hp = maxHp(pokemon);
  return pokemon;
}

/** @param {any} player @param {any} foe @param {Record<string, any>} [extra] */
const fight = (player, foe, extra = {}) =>
  new Battle({ rng: new Rng(3), player, foes: [foe], policy: defaultAutoBattle(), ...extra });

test('a Trace copies for the battle only, and the copy acts on the way in', options, () => {
  const porygon = make('porygon2', 50, ['tackle'], 'trace');
  const battle = fight(porygon, make('gyarados', 50, ['splash'], 'intimidate'));
  // The Gyarados' own Intimidate, and then the traced one.
  assert.equal(battle.abilitySlugOf(battle.player), 'intimidate');
  assert.equal(battle.foe.stages.atk, -1);
  assert.equal(porygon.ability, 'trace', 'the save keeps the ability it had');
});

test('an Intimidate acts on the way in, and is shrugged off, turned round, or run from', options, () => {
  // Before a blow is struck, it says so and the Attack is down.
  const plain = fight(make('pikachu', 50, ['splash'], 'static'), make('gyarados', 50, ['splash'], 'intimidate'));
  assert.equal(plain.player.stages.atk, -1);
  assert.ok(plain.opening.some((entry) => entry.kind === 'ability' && entry.side === 'foe'));

  const steady = fight(make('lucario', 50, ['splash'], 'inner-focus'), make('gyarados', 50, ['splash'], 'intimidate'));
  assert.equal(steady.player.stages.atk, 0);

  const rattled = fight(make('dunsparce', 50, ['splash'], 'rattled'), make('gyarados', 50, ['splash'], 'intimidate'));
  assert.equal(rattled.player.stages.atk, -1);
  assert.equal(rattled.player.stages.spe, 1);

  const dog = fight(make('mabosstiff', 50, ['splash'], 'guard-dog'), make('gyarados', 50, ['splash'], 'intimidate'));
  assert.equal(dog.player.stages.atk, 1);

  const orb = make('dunsparce', 50, ['splash'], 'serene-grace');
  orb.heldItem = 'adrenaline-orb';
  const scared = fight(orb, make('gyarados', 50, ['splash'], 'intimidate'));
  assert.equal(scared.player.stages.spe, 1);
  assert.equal(orb.heldItem, null);
});

test('a Prankster’s status move does nothing to a Dark type', options, () => {
  const sableye = make('sableye', 50, ['thunder-wave'], 'prankster');
  const battle = fight(sableye, make('umbreon', 50, ['splash']));
  battle.takeTurn();
  assert.equal(battle.foe.pokemon.status, null);

  const plain = fight(make('sableye', 50, ['thunder-wave'], 'prankster'), make('chansey', 50, ['splash']));
  plain.player.stages.acc = 6;
  plain.takeTurn();
  assert.equal(plain.foe.pokemon.status, 'par');
});

test('a Keen Eye keeps its accuracy', options, () => {
  const battle = fight(make('pidgey', 30, ['splash'], 'keen-eye'), make('sandshrew', 30, ['sand-attack']));
  battle.foe.stages.acc = 6;
  battle.takeTurn();
  assert.equal(battle.player.stages.acc, 0);
});

test('a Heatproof takes half the burn', options, () => {
  const bronzong = make('bronzong', 50, ['splash'], 'heatproof');
  bronzong.status = 'brn';
  const battle = fight(bronzong, make('chansey', 50, ['splash']));
  battle.takeTurn();
  assert.equal(maxHp(bronzong) - bronzong.hp, Math.floor(maxHp(bronzong) / 32));
});

test('a Galarian Darmanitan has a Zen Mode too', options, () => {
  const darmanitan = make('darmanitan-galar-standard', 50, ['splash'], 'zen-mode');
  const battle = fight(darmanitan, make('chansey', 50, ['splash']));
  darmanitan.hp = Math.floor(maxHp(darmanitan) / 2);
  battle.evaluateFormes([]);
  assert.equal(battle.player.marks.forme, 'darmanitan-galar-zen');
});

test('a Minior in its shell takes no condition', options, () => {
  const minior = make('minior', 50, ['splash'], 'shields-down');
  const battle = fight(make('chansey', 50, ['thunder-wave']), minior);
  battle.player.stages.acc = 6;
  battle.takeTurn();
  assert.equal(minior.status, null);
});

test('a wild Wimp Out runs from the hit that halves it', options, () => {
  const wimpod = make('wimpod', 30, ['splash'], 'wimp-out');
  const battle = fight(make('machamp', 30, ['seismic-toss']), wimpod);
  wimpod.hp = Math.floor(maxHp(wimpod) / 2) + 5;
  battle.takeTurn();
  assert.equal(battle.outcome, 'fled');
});

test('a Gorilla Tactics sticks to its first move', options, () => {
  const battle = fight(make('darmanitan-galar-standard', 50, ['ice-punch', 'fire-punch'], 'gorilla-tactics'), make('chansey', 70, ['splash']));
  const first = battle.chooseMove(battle.player, battle.foe);
  for (let i = 0; i < 5; i++) assert.equal(battle.chooseMove(battle.player, battle.foe), first);
});

test('a Harvest always regrows under the sun', options, () => {
  const exeggutor = make('exeggutor', 50, ['splash'], 'harvest');
  const battle = fight(exeggutor, make('chansey', 50, ['splash']), { weather: WEATHER.SUN });
  battle.player.marks.ateBerry = 'sitrus-berry';
  battle.regrowBerry(battle.player, []);
  assert.equal(exeggutor.heldItem, 'sitrus-berry');
});

test('the abilities a single battle never lets act say so', options, () => {
  for (const slug of ['plus', 'healer', 'telepathy', 'stalwart', 'commander']) {
    assert.ok(abilityWorks(slug) && abilityInert(slug), slug);
  }
  assert.ok(!abilityInert('intimidate'));
});

test('a wild Pokémon held by a Shadow Tag or a Mean Look cannot Teleport away', options, () => {
  const free = fight(make('wobbuffet', 30, ['splash'], 'telepathy'), make('abra', 20, ['teleport']));
  free.takeTurn();
  assert.equal(free.outcome, 'fled');

  const tagged = fight(make('wobbuffet', 30, ['splash'], 'shadow-tag'), make('abra', 20, ['teleport']));
  tagged.takeTurn();
  assert.equal(tagged.outcome, 'ongoing');

  // A Ghost type slips it all.
  const ghost = fight(make('wobbuffet', 30, ['splash'], 'shadow-tag'), make('gastly', 20, ['teleport']));
  ghost.takeTurn();
  assert.equal(ghost.outcome, 'fled');
});

test('a Dancer dances along to the other side’s dance', options, () => {
  const battle = fight(make('oricorio', 50, ['splash'], 'dancer'), make('volcarona', 50, ['quiver-dance']));
  battle.takeTurn();
  assert.equal(battle.foe.stages.spa, 1);
  assert.equal(battle.player.stages.spa, 1);
  assert.equal(battle.player.stages.spe, 1);
});
