/**
 * Every way a Pokémon evolves here: the regional varieties as Pokémon of
 * their own, the rules each version had, a Linking Cord for a trade, and a
 * Nincada leaving its shell behind.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { experienceForLevel } from '../../app/renderer/engine/stats.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { gameData, speciesIdBySlug, speciesOf } from '../../app/renderer/core/data.mjs';
import { completeEvolution, shedAfterEvolving, useItem } from '../../app/renderer/engine/items.mjs';
import {
  createPokemon,
  friendshipForLevels,
  gainFriendship,
  offeredEvolution,
  pendingEvolution,
  setMove,
  stopEvolution,
  TRADE_ITEM,
  walkSteps,
} from '../../app/renderer/engine/pokemon.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

const id = (slug) => /** @type {number} */ (speciesIdBySlug(slug));

/** @param {string} slug @param {number} level */
function make(slug, level) {
  const pokemon = createPokemon(new Rng(2), id(slug), level);
  pokemon.heldItem = null;
  return pokemon;
}

/** @param {Record<string, number>} bag @param {any} active */
function fakeSession(bag, active) {
  const box = [];
  return /** @type {any} */ ({
    bag,
    active,
    box,
    rng: new Rng(1),
    get boxFull() {
      return false;
    },
    countOf: (slug) => bag[slug] ?? 0,
    removeItem: (slug) => {
      bag[slug] -= 1;
      return true;
    },
    markCaught() {},
    storeInBox(pokemon) {
      box.push(pokemon);
      return true;
    },
  });
}

test('a regional variety is a Pokémon of its own, under its species number', options, () => {
  const galar = speciesOf(id('zigzagoon-galar'));
  assert.equal(galar.dex, 263);
  assert.deepEqual(galar.types, ['dark', 'normal']);
  // Named as the games name it — a Zigzagoon — with the form beside it.
  assert.equal(galar.name.ko, speciesOf(263).name.ko);
  assert.equal(galar.form?.ko, '가라르의 모습');

  // Only the Galarian line reaches Obstagoon; the Hoenn Linoone stops.
  assert.deepEqual(speciesOf(264).evolutions, []);
  const linoone = make('linoone-galar', 40);
  assert.equal(pendingEvolution(linoone, { timeOfDay: 'night' })?.to, id('obstagoon'));
  assert.equal(pendingEvolution(linoone, { timeOfDay: 'day' }), null);
  assert.equal(speciesOf(id('obstagoon')).evolvesFrom, id('linoone-galar'));

  // And an Alolan Vulpix wants an Ice Stone, not a Fire Stone.
  const vulpix = make('vulpix-alola', 20);
  assert.equal(pendingEvolution(vulpix, { item: 'ice-stone' })?.to, id('ninetales-alola'));
  assert.equal(pendingEvolution(vulpix, { item: 'fire-stone' }), null);

  // A Corsola from Hoenn never becomes a Cursola.
  assert.equal(pendingEvolution(make('corsola', 60)), null);
  assert.equal(pendingEvolution(make('corsola-galar', 60))?.to, id('cursola'));
});

test("a later game's rule stands in for one this game cannot meet", options, () => {
  // Mt. Coronet has no map here; Sword's Thunder Stone does the job.
  assert.equal(pendingEvolution(make('magneton', 40), { item: 'thunder-stone' })?.to, id('magnezone'));
  assert.equal(pendingEvolution(make('eevee', 20), { item: 'leaf-stone' })?.to, id('leafeon'));

  // Knowing the move is enough for a Tangela.
  const tangela = make('tangela', 30);
  tangela.moves = [];
  setMove(tangela, 0, 'vine-whip');
  assert.equal(pendingEvolution(tangela), null);
  setMove(tangela, 1, 'ancient-power');
  assert.equal(pendingEvolution(tangela)?.to, id('tangrowth'));

  // A move of a type, and enough friendship, for a Sylveon.
  const eevee = make('eevee', 25);
  eevee.friendship = 200;
  eevee.moves = [];
  setMove(eevee, 0, 'tackle');
  setMove(eevee, 1, 'baby-doll-eyes');
  assert.equal(pendingEvolution(eevee)?.to, id('sylveon'));

});

test('an Annihilape and a Sirfetch\'d evolve the way the games have them', options, () => {
  // Twenty Rage Fists, counted on the Pokémon across battles.
  const primeape = make('primeape', 40);
  primeape.moveUses = { 'rage-fist': 19 };
  assert.equal(pendingEvolution(primeape)?.to ?? null, null);
  primeape.moveUses['rage-fist'] = 20;
  assert.equal(pendingEvolution(primeape)?.to, id('annihilape'));

  // Three critical hits in the battle just won.
  const farfetchd = make('farfetchd-galar', 30);
  assert.equal(pendingEvolution(farfetchd, { crits: 2 }), null);
  assert.equal(pendingEvolution(farfetchd, { crits: 3 })?.to, id('sirfetchd'));
});

test('an item that is not the one it is waiting for does not set off a levelling evolution', options, () => {
  const charmeleon = make('charmander', 40);
  assert.equal(pendingEvolution(charmeleon)?.to, id('charmeleon'));
  assert.equal(pendingEvolution(charmeleon, { item: 'potion' }), null);
});

test('a Linking Cord is a trade, and the item held says which one', options, () => {
  const kadabra = make('kadabra', 30);
  const session = fakeSession({ [TRADE_ITEM]: 1 }, kadabra);
  const used = useItem(session, TRADE_ITEM);
  assert.ok(used.ok);
  // The evolution screen plays it out, and cannot be told to stop it.
  assert.deepEqual(used.evolution, { to: id('alakazam'), stoppable: false });
  assert.equal(kadabra.speciesId, id('kadabra'), 'nothing evolves before the screen');
  completeEvolution(session, kadabra, used.evolution.to);
  assert.equal(kadabra.speciesId, id('alakazam'));
  assert.equal(session.bag[TRADE_ITEM], 1, 'the cord is kept, as every evolution item is');

  const clamperl = make('clamperl', 30);
  clamperl.heldItem = 'deep-sea-scale';
  assert.equal(pendingEvolution(clamperl, { item: TRADE_ITEM })?.to, id('gorebyss'));
  clamperl.heldItem = 'deep-sea-tooth';
  assert.equal(pendingEvolution(clamperl, { item: TRADE_ITEM })?.to, id('huntail'));
});

test('a Nincada that becomes a Ninjask leaves a Shedinja, given a ball to put it in', options, () => {
  const ninjask = make('ninjask', 20);
  const session = fakeSession({ 'poke-ball': 1 }, ninjask);
  const shell = shedAfterEvolving(session, id('nincada'), ninjask);
  assert.equal(shell?.speciesId, id('shedinja'));
  assert.equal(session.box.length, 1);
  assert.equal(session.bag['poke-ball'], 0);
  assert.equal(shedAfterEvolving(session, id('nincada'), ninjask), null, 'no ball, no Shedinja');
  assert.equal(shedAfterEvolving(fakeSession({ 'poke-ball': 1 }, ninjask), id('charmander'), ninjask), null);
});

test('every evolution the dex carries has a way here', options, () => {
  const unreachable = [];
  for (const species of Object.values(gameData().species)) {
    for (const evolution of species.evolutions ?? []) {
      const ok =
        evolution.trigger === 'use-move' ||
        evolution.trigger === 'three-critical-hits' ||
        evolution.trigger === 'use-item' ||
        evolution.trigger === 'trade' ||
        evolution.trigger === 'shed' ||
        Boolean(evolution.region) ||
        (evolution.trigger === 'level-up' &&
          !evolution.location &&
          Boolean(
            evolution.minLevel ||
              evolution.happiness ||
              evolution.knownMove ||
              evolution.knownMoveType ||
              evolution.heldItem ||
              evolution.heldItems?.length ||
              evolution.steps ||
              evolution.recoil ||
              evolution.partySpecies,
          ));
      if (!ok) unreachable.push(`${species.slug}->${speciesOf(evolution.to)?.slug} (${evolution.trigger})`);
    }
  }
  assert.deepEqual(unreachable, []);
});

test('friendship is earned, and friendship evolutions wait for it', options, () => {
  const pichu = make('pichu', 30);
  pichu.friendship = 100;
  assert.equal(pendingEvolution(pichu), null, 'not fond enough yet');
  friendshipForLevels(pichu, 10);
  walkSteps(pichu, 128 * 20);
  assert.ok(pichu.friendship >= 150);
  pichu.heldItem = 'soothe-bell';
  gainFriendship(pichu, 100);
  assert.equal(pendingEvolution(pichu)?.to, id('pikachu'));
  assert.ok(pichu.friendship <= 255);
});

test('steps, recoil, company in the box and rain are counted as the games count them', options, () => {
  const pawmo = make('pawmo', 30);
  walkSteps(pawmo, 999);
  assert.equal(pendingEvolution(pawmo), null);
  walkSteps(pawmo, 1);
  assert.equal(pendingEvolution(pawmo)?.to, id('pawmot'));

  const basculin = make('basculin-white-striped', 30);
  basculin.recoilTaken = 293;
  assert.equal(pendingEvolution(basculin), null);
  basculin.recoilTaken = 294;
  assert.equal(pendingEvolution(basculin)?.to, id('basculegion'));

  const mantyke = make('mantyke', 30);
  assert.equal(pendingEvolution(mantyke, { box: [] }), null);
  assert.equal(pendingEvolution(mantyke, { box: [make('remoraid', 20)] })?.to, id('mantine'));

  const pancham = make('pancham', 40);
  assert.equal(pendingEvolution(pancham, { box: [make('pikachu', 20)] }), null);
  assert.equal(pendingEvolution(pancham, { box: [make('umbreon', 20)] })?.to, id('pangoro'));

  const sliggoo = make('sliggoo', 55);
  assert.equal(pendingEvolution(sliggoo, { raining: false }), null);
  assert.equal(pendingEvolution(sliggoo, { raining: true })?.to, id('goodra'));
});

test('Cosmoem by the hour, Urshifu by the scroll, Melmetal by its candy, Gimmighoul by its coin', options, () => {
  const gimmighoul = make('gimmighoul', 30);
  assert.equal(pendingEvolution(gimmighoul), null, 'not by levelling');
  assert.equal(pendingEvolution(gimmighoul, { item: 'gimmighoul-coin' })?.to, id('gholdengo'));

  const cosmoem = make('cosmoem', 55);
  assert.equal(pendingEvolution(cosmoem, { timeOfDay: 'day' })?.to, id('solgaleo'));
  assert.equal(pendingEvolution(cosmoem, { timeOfDay: 'night' })?.to, id('lunala'));

  const kubfu = make('kubfu', 30);
  assert.equal(pendingEvolution(kubfu, { item: 'scroll-of-darkness' })?.to, id('urshifu'));
  assert.equal(pendingEvolution(kubfu, { item: 'scroll-of-waters' })?.to, id('urshifu-rapid-strike'));
  assert.deepEqual(speciesOf(id('urshifu-rapid-strike')).types, ['fighting', 'water']);

  assert.equal(pendingEvolution(make('meltan', 40), { item: 'meltan-candy' }), null, 'too young');
  assert.equal(pendingEvolution(make('meltan', 48), { item: 'meltan-candy' })?.to, id('melmetal'));
});

test('a Wurmple is always the same one of its two, and not always the first', options, () => {
  const seen = new Set();
  for (let seed = 1; seed < 30; seed++) {
    const wurmple = createPokemon(new Rng(seed), id('wurmple'), 10);
    wurmple.caughtAt = seed * 7919000;
    const first = pendingEvolution(wurmple)?.to;
    assert.equal(pendingEvolution(wurmple)?.to, first, 'the same answer twice');
    seen.add(first);
  }
  assert.deepEqual([...seen].sort(), [id('silcoon'), id('cascoon')].sort());
});

test('an evolution stopped at a level is not asked again until the next one', options, () => {
  const charmander = make('charmander', 16);
  assert.equal(offeredEvolution(charmander)?.to, id('charmeleon'));
  stopEvolution(charmander);
  assert.equal(offeredEvolution(charmander), null, 'not after the next battle at the same level');
  assert.equal(pendingEvolution(charmander)?.to, id('charmeleon'), 'it is still due');

  charmander.experience = experienceForLevel(speciesOf(charmander.speciesId).growthRate, 17);
  assert.equal(offeredEvolution(charmander)?.to, id('charmeleon'), 'asked again at the next level');

  // An item chosen by the player is not held back by a stop.
  const pikachu = make('pikachu', 20);
  stopEvolution(pikachu);
  assert.equal(offeredEvolution(pikachu, { item: 'thunder-stone' })?.to, id('raichu'));

  // Evolving clears it.
  const session = fakeSession({}, charmander);
  completeEvolution(session, charmander, id('charmeleon'));
  assert.equal(charmander.evolutionStopped, undefined);
});
