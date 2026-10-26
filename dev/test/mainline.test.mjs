/**
 * Rules brought back in line with the main series: a one-hit KO against
 * something higher, the primal weathers, a wild Pokémon's random moves, the
 * hit points a level brings, a levelling evolution that waits for a level,
 * a tutor move that waits for its TM, and the potions' current numbers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { gameData, itemOf, moveOf, speciesIdBySlug } from '../../app/renderer/core/data.mjs';
import { Battle } from '../../app/renderer/engine/battle.mjs';
import { WEATHER } from '../../app/renderer/engine/field.mjs';
import { settleForme } from '../../app/renderer/engine/forms.mjs';
import { learnsMachine } from '../../app/renderer/engine/items.mjs';
import { availableMoves, createPokemon, gainFromDefeat, maxHp, pendingEvolution, setMove } from '../../app/renderer/engine/pokemon.mjs';
import { defaultAutoBattle } from '../../app/renderer/engine/session.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

/** @param {string} slug @param {number} level @param {string[]} [moves] @param {string|null} [item] */
function make(slug, level, moves = [], item = null) {
  const pokemon = createPokemon(new Rng(1), /** @type {number} */ (speciesIdBySlug(slug)), level, { ivFloor: 31 });
  pokemon.nature = 'hardy';
  pokemon.heldItem = item;
  settleForme(pokemon);
  if (moves.length) {
    pokemon.moves = [];
    moves.forEach((move, index) => setMove(pokemon, index, move));
  }
  pokemon.hp = maxHp(pokemon);
  return pokemon;
}

/** @param {any} player @param {any[]} foes @param {boolean} [trainerBattle] */
const fight = (player, foes, trainerBattle = false) =>
  new Battle({ rng: new Rng(5), player, foes, policy: defaultAutoBattle(), trainerBattle });

test('a one-hit KO at something higher fails without a roll, rather than missing', options, () => {
  const battle = fight(make('dugtrio', 30, ['fissure']), [make('geodude', 40, ['defense-curl'])]);
  const fissure = moveOf('fissure');
  for (let roll = 0; roll < 20; roll++) assert.equal(battle.rollAccuracy(battle.player, /** @type {any} */ (battle.foe), fissure), true);
  const log = battle.takeTurn();
  assert.ok(log.some((entry) => entry.kind === 'move' && entry.side === 'player' && entry.data?.move === 'fissure'));
  assert.ok(log.some((entry) => entry.kind === 'failed' && entry.side === 'player'));
  assert.ok(!log.some((entry) => entry.kind === 'miss' && entry.side === 'player'));
  assert.ok(/** @type {any} */ (battle.foe).pokemon.hp > 0);
});

test('a heavy rain puts out every Fire attack, and no ordinary weather replaces it', options, () => {
  const kyogre = make('kyogre', 70, ['surf'], 'blue-orb');
  const battle = fight(kyogre, [make('torkoal', 40, ['ember', 'sunny-day'])], true);
  // Torkoal's Drought walked in after the Primordial Sea and changed nothing.
  assert.equal(battle.field.weather, WEATHER.RAIN);
  assert.equal(battle.field.primal, true);
  assert.ok(battle.alreadyInPlace(/** @type {any} */ (battle.foe), battle.player, 'sunny-day'));
  // Nor does a Sunny Day, and an Ember goes out in the rain.
  assert.equal(battle.startWeather(WEATHER.SUN, /** @type {any} */ (battle.foe), []), false);
  assert.equal(battle.washedOut(moveOf('ember')), 'weather.rain.fizzled');
  assert.equal(battle.washedOut(moveOf('surf')), null);
});

test('a primal weather lifts with the Pokémon that called it', options, () => {
  const groudon = make('groudon', 40, ['bulk-up'], 'red-orb');
  groudon.hp = 1;
  const battle = fight(make('glaceon', 70, ['ice-beam']), [groudon, make('geodude', 40, ['defense-curl'])], true);
  assert.equal(battle.field.weather, WEATHER.SUN);
  assert.equal(battle.field.primal, true);
  assert.equal(battle.washedOut(moveOf('surf')), 'weather.sun.evaporated');
  const log = battle.takeTurn();
  assert.ok(log.some((entry) => entry.kind === 'weatherEnded' && entry.data?.primal));
  assert.equal(battle.field.weather, null);
  assert.equal(battle.field.primal, false);
});

test('each line carries the sky as it stood then, so the screen changes on the line that changes it', options, () => {
  // The battle opens under the area's rain; the Drought only takes it on its own line.
  const battle = new Battle({
    rng: new Rng(5),
    player: make('glaceon', 70, ['ice-beam']),
    foes: [make('torkoal', 40, ['ember']), make('geodude', 40, ['defense-curl'])],
    policy: defaultAutoBattle(),
    weather: WEATHER.RAIN,
    trainerBattle: true,
  });
  assert.deepEqual(battle.startingField, { weather: WEATHER.RAIN, primal: false, terrain: null });
  const log = battle.takeTurn();
  const drought = log.find((entry) => entry.kind === 'weather');
  assert.equal(drought?.field?.weather, WEATHER.SUN);
  const before = log.slice(0, log.indexOf(/** @type {any} */ (drought)));
  assert.ok(before.every((entry) => entry.field?.weather === WEATHER.RAIN), 'still raining on the lines before it');

  // A Primal Groudon that comes out and goes down in one turn: its sun is
  // shown on its own lines and gone on the line that lifts it.
  const groudon = make('groudon', 40, ['bulk-up'], 'red-orb');
  groudon.hp = 1;
  const primal = fight(make('glaceon', 70, ['ice-beam']), [groudon, make('geodude', 40, ['defense-curl'])], true);
  const turn = primal.takeTurn();
  const lit = turn.find((entry) => entry.kind === 'weather' && entry.data?.primal);
  const lifted = turn.find((entry) => entry.kind === 'weatherEnded' && entry.data?.primal);
  assert.deepEqual(lit?.field, { weather: WEATHER.SUN, primal: true, terrain: null });
  assert.deepEqual(lifted?.field, { weather: null, primal: false, terrain: null });
});

test('a wild Pokémon picks its moves at random; a trainer\'s weighs them', options, () => {
  const wild = new Battle({
    rng: new Rng(9),
    player: make('pikachu', 30, ['thunder-shock']),
    foes: [make('poliwag', 30, ['rain-dance', 'water-gun'])],
    policy: defaultAutoBattle(),
    weather: WEATHER.RAIN,
  });
  const picks = new Set(Array.from({ length: 40 }, () => wild.chooseMove(/** @type {any} */ (wild.foe), wild.player)));
  assert.deepEqual([...picks].sort(), ['rain-dance', 'water-gun'], 'a Rain Dance in the rain, now and then');

  const trainer = new Battle({
    rng: new Rng(9),
    player: make('pikachu', 30, ['thunder-shock']),
    foes: [make('poliwag', 30, ['rain-dance', 'water-gun'])],
    policy: defaultAutoBattle(),
    weather: WEATHER.RAIN,
    trainerBattle: true,
  });
  for (let turn = 0; turn < 20; turn++) assert.equal(trainer.chooseMove(/** @type {any} */ (trainer.foe), trainer.player), 'water-gun');
});

test('a level adds as many hit points as the maximum rose by', options, () => {
  const pokemon = make('chansey', 30);
  pokemon.hp = 40;
  const maxBefore = maxHp(pokemon);
  const reward = gainFromDefeat(pokemon, { baseExp: 300, level: 40, baseStats: {}, effort: {} });
  assert.ok(reward.levelsGained > 0);
  // A Chansey's 250 base HP climbs by far more than two a level.
  assert.ok(maxHp(pokemon) - maxBefore > reward.levelsGained * 2);
  assert.equal(pokemon.hp, 40 + maxHp(pokemon) - maxBefore);
});

test('a levelling evolution waits for a level; three critical hits do not', options, () => {
  const charmander = make('charmander', 16);
  assert.equal(pendingEvolution(charmander, { levelled: false }), null);
  assert.equal(pendingEvolution(charmander, {})?.to, speciesIdBySlug('charmeleon'));

  const farfetchd = make('farfetchd-galar', 20);
  assert.equal(pendingEvolution(farfetchd, { levelled: false, crits: 3 })?.to, speciesIdBySlug('sirfetchd'));
});

test('a tutor move a TM teaches waits for the TM; one no TM teaches is there already', options, () => {
  // Dual Wingbeat was a tutor move for Butterfree and is TM197 now.
  const butterfree = make('butterfree', 30);
  assert.ok(!availableMoves(butterfree).includes('dual-wingbeat'));
  assert.ok(availableMoves(butterfree, ['dual-wingbeat']).includes('dual-wingbeat'));
  assert.ok(learnsMachine(butterfree, 'tm197'));
  // No TM teaches Snore, so a Taillow still simply knows how.
  assert.ok(availableMoves(make('taillow', 5)).includes('snore'));
  // And no tutor list anywhere keeps a move one of the bag's TMs teaches.
  const taught = new Set(Object.values(gameData().items).filter((item) => item.pocket === 'machines').map((item) => item.move));
  for (const species of Object.values(gameData().species)) {
    for (const move of species.learnset?.tutor ?? []) {
      assert.ok(!taught.has(move), `${species.slug} keeps ${move} as a tutor move, which a TM teaches`);
    }
  }
});

test('the Super Potion and the Hyper Potion restore 60 and 120', options, () => {
  assert.equal(itemOf('potion')?.use?.hp, 20);
  assert.equal(itemOf('super-potion')?.use?.hp, 60);
  assert.equal(itemOf('hyper-potion')?.use?.hp, 120);
});
