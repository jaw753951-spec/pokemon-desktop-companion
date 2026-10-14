/**
 * The items the audit found doing nothing, or doing the wrong thing: the balls
 * that were all a Poké Ball, the Power items' missing effort, the key items
 * with no forme to give, and the held items nobody read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { gameData, speciesIdBySlug, speciesOf } from '../../app/renderer/core/data.mjs';
import { Battle } from '../../app/renderer/engine/battle.mjs';
import { ballBonus, catchValue } from '../../app/renderer/engine/capture.mjs';
import { EventScheduler } from '../../app/renderer/engine/events.mjs';
import {
  battleMedicine,
  canHold,
  eventModifiers,
  heldPassive,
  itemNeedsChoice,
  itemSuits,
  LEARNABLE_MACHINE_SHARE,
  learnsMachine,
  pickFind,
  useItem,
} from '../../app/renderer/engine/items.mjs';
import { createPokemon, gainFromDefeat, maxHp, maxPp, setMove } from '../../app/renderer/engine/pokemon.mjs';
import { defaultAutoBattle } from '../../app/renderer/engine/session.mjs';
import { experienceForLevel } from '../../app/renderer/engine/stats.mjs';
import { VOLATILE } from '../../app/renderer/engine/volatile.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

/** @param {string} slug @param {number} level @param {string[]} [moves] */
function make(slug, level, moves = []) {
  const pokemon = createPokemon(new Rng(1), /** @type {number} */ (speciesIdBySlug(slug)), level, { ivFloor: 31, shiny: false });
  pokemon.nature = 'hardy';
  pokemon.heldItem = null;
  if (moves.length) {
    pokemon.moves = [];
    moves.forEach((move, index) => setMove(pokemon, index, move));
  }
  pokemon.hp = maxHp(pokemon);
  return pokemon;
}

/** A session with just a bag and a companion, which is all an item needs. */
function bag(contents, pokemon) {
  return /** @type {any} */ ({
    bag: { ...contents },
    active: pokemon,
    machines: [],
    events: new EventScheduler(),
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
  });
}

test('each ball earns its bonus only where it should', options, () => {
  const magikarp = make('magikarp', 5);
  const onix = make('onix', 40);
  // A special ball is worse than a Poké Ball out of its element (0.6) and
  // half again better than the games make it in it.
  // A Net Ball wants the type in its element: a Water type on or by the
  // water, a Bug type in the grass or the trees.
  assert.equal(ballBonus('net-ball', magikarp, { areaTags: ['beach'] }), 5.25);
  assert.equal(ballBonus('net-ball', { ...magikarp, fromWater: true }, { areaTags: ['cave'] }), 5.25);
  assert.equal(ballBonus('net-ball', magikarp, { areaTags: ['mountain'] }), 0.6);
  assert.equal(ballBonus('net-ball', make('caterpie', 5), { areaTags: ['forest'] }), 5.25);
  assert.equal(ballBonus('net-ball', make('caterpie', 5), { areaTags: ['cave'] }), 0.6);
  assert.equal(ballBonus('net-ball', onix, { areaTags: ['water'] }), 0.6);
  assert.equal(ballBonus('quick-ball', onix, { throws: 0 }), 7.5);
  assert.equal(ballBonus('quick-ball', onix, { throws: 1 }), 0.6);
  assert.equal(ballBonus('dusk-ball', onix, { time: 'night' }), 4.5);
  assert.equal(ballBonus('dusk-ball', onix, { time: 'day', areaTags: ['cave'] }), 4.5);
  assert.equal(ballBonus('dusk-ball', onix, { time: 'day' }), 0.6);
  assert.equal(ballBonus('nest-ball', magikarp), 5.4);
  assert.equal(ballBonus('nest-ball', onix), 0.6);
  assert.equal(ballBonus('repeat-ball', onix, { caught: new Set([onix.speciesId]) }), 5.25);
  assert.equal(ballBonus('repeat-ball', onix), 0.6);
  // A Dive Ball is for what was met surfing or fishing, not for everything
  // on a route with water on it.
  assert.equal(ballBonus('dive-ball', { ...magikarp, fromWater: true }), 5.25);
  assert.equal(ballBonus('dive-ball', magikarp, { areaTags: ['beach', 'water'] }), 0.6);
  // A Lure Ball is for what was fished up.
  assert.equal(ballBonus('lure-ball', { ...magikarp, fromWater: true, fished: true }), 7.5);
  assert.equal(ballBonus('lure-ball', { ...magikarp, fromWater: true }), 0.6);
  // A Timer Ball climbs with each ball, from a Poké Ball's worth to its best
  // on the last of the three.
  assert.equal(ballBonus('timer-ball', onix, { throws: 0 }), 1);
  assert.equal(ballBonus('timer-ball', onix, { throws: 1 }), 3.5);
  assert.equal(ballBonus('timer-ball', onix, { throws: 2 }), 6);
  assert.equal(ballBonus('level-ball', magikarp, { active: make('pikachu', 25) }), 12);
  assert.equal(ballBonus('level-ball', onix, { active: make('pikachu', 25) }), 0.6);
  assert.equal(ballBonus('moon-ball', make('clefairy', 20)), 6);
  assert.equal(ballBonus('fast-ball', make('jolteon', 30)), 6);
  assert.equal(ballBonus('fast-ball', onix), 0.6);
  assert.equal(ballBonus('beast-ball', onix), 0.1);
  assert.equal(ballBonus('beast-ball', make('nihilego', 50)), 7.5);
  assert.equal(ballBonus('ultra-ball', make('nihilego', 50)), 0.1);
  // The plain balls are untouched.
  assert.equal(ballBonus('poke-ball', onix), 1);
  assert.equal(ballBonus('great-ball', onix), 1.5);
  // A Heavy Ball moves the rate itself: Onix is 210 kg.
  assert.ok(catchValue(onix, 'heavy-ball') > catchValue(onix, 'poke-ball'));
  assert.ok(catchValue(magikarp, 'heavy-ball') < catchValue(magikarp, 'poke-ball'));
});

test('a Lucky Egg’s share is in the experience reported', options, () => {
  const plain = make('pikachu', 20);
  const egged = make('pikachu', 20);
  const defeated = { baseStats: { hp: 20, atk: 10, def: 55, spa: 15, spd: 20, spe: 80 }, baseExp: 40, level: 20 };
  const base = gainFromDefeat(plain, defeated).experience;
  assert.equal(gainFromDefeat(egged, defeated, { experienceMultiplier: 1.5 }).experience, Math.round(base * 1.5));
});

test('a Destiny Knot ties the one who infatuated its holder', options, () => {
  const holder = make('pikachu', 30);
  holder.gender = 'female';
  holder.heldItem = 'destiny-knot';
  const suitor = make('pikachu', 30);
  suitor.gender = 'male';
  const battle = new Battle({ rng: new Rng(3), player: holder, foes: [suitor], policy: defaultAutoBattle() });
  assert.ok(battle.infatuate(battle.foe, battle.player, []));
  assert.ok(battle.foe.volatile[VOLATILE.INFATUATION]);
});

test('a Cleanse Tag keeps a third of the wild Pokémon away, and Honey calls one', options, () => {
  const pokemon = make('pikachu', 20);
  pokemon.heldItem = 'cleanse-tag';
  const session = bag({ honey: 1 }, pokemon);
  assert.deepEqual(eventModifiers(session), { wild: 2 / 3 });
  pokemon.heldItem = null;
  assert.deepEqual(eventModifiers(session), {});

  assert.equal(useItem(session, 'honey').ok, true);
  assert.equal(session.events.roll(new Rng(1)), 'wild');
});

test('a nectar sets an Oricorio’s style and is drunk; a catalog turns Rotom and swaps its move', options, () => {
  const oricorio = make('oricorio', 30);
  const session = bag({ 'yellow-nectar': 1, 'rotom-catalog': 1 }, oricorio);
  assert.equal(useItem(session, 'yellow-nectar').ok, true);
  assert.equal(oricorio.forme, 'oricorio-pom-pom');
  assert.equal(session.bag['yellow-nectar'], undefined);

  // Out of its own shape, a Rotom keeps its Thunder Shock and learns the
  // appliance's move beside it.
  const rotom = make('rotom', 30, ['thunder-shock', 'thunderbolt']);
  session.active = rotom;
  assert.equal(useItem(session, 'rotom-catalog').ok, true);
  assert.equal(rotom.forme, 'rotom-heat');
  assert.deepEqual(rotom.moves.map((slot) => slot.move), ['thunder-shock', 'thunderbolt', 'overheat']);
  assert.equal(session.bag['rotom-catalog'], 1);
});

test('a Keldeo that learns Secret Sword stands Resolute', options, () => {
  const keldeo = make('keldeo', 60, ['surf']);
  assert.equal(keldeo.forme ?? null, null);
  setMove(keldeo, 1, 'secret-sword');
  assert.equal(keldeo.forme, 'keldeo-resolute');
  setMove(keldeo, 1, 'aqua-jet');
  assert.equal(keldeo.forme ?? null, null);
});

test('a regional form swings its species’ item', options, () => {
  const alolan = make('marowak-alola', 40);
  alolan.heldItem = 'thick-club';
  assert.ok(itemSuits(heldPassive(alolan, 'stat'), alolan));
  const galarian = make('farfetchd-galar', 40);
  galarian.heldItem = 'stick';
  assert.ok(itemSuits(heldPassive(galarian, 'crit'), galarian));
});

test('an Ether and a Bottle Cap go where the player points them', options, () => {
  assert.equal(itemNeedsChoice('ether'), 'move');
  assert.equal(itemNeedsChoice('pp-up'), 'move');
  assert.equal(itemNeedsChoice('bottle-cap'), 'stat');
  assert.equal(itemNeedsChoice('elixir'), null);

  const pokemon = make('pikachu', 30, ['thunderbolt', 'quick-attack']);
  pokemon.moves[0].pp = 1;
  pokemon.moves[1].pp = 1;
  const session = bag({ ether: 1, 'bottle-cap': 1 }, pokemon);
  assert.equal(useItem(session, 'ether', { move: 1 }).ok, true);
  assert.equal(pokemon.moves[0].pp, 1);
  assert.equal(pokemon.moves[1].pp, Math.min(maxPp(pokemon.moves[1]), 11));

  pokemon.ivs = { hp: 1, atk: 2, def: 3, spa: 4, spd: 5, spe: 6 };
  assert.equal(useItem(session, 'bottle-cap', { stat: 'spe' }).ok, true);
  assert.equal(pokemon.ivs.spe, 31);
  assert.equal(pokemon.ivs.hp, 1);
});

test('a Life Orb still costs a Rock Head, and not a Magic Guard', options, () => {
  const run = (ability) => {
    const attacker = make('aerodactyl', 50, ['wing-attack']);
    attacker.ability = ability;
    attacker.heldItem = 'life-orb';
    const battle = new Battle({ rng: new Rng(3), player: attacker, foes: [make('snorlax', 80, ['defense-curl'])], policy: defaultAutoBattle() });
    battle.player.stages.acc = 6;
    battle.takeTurn();
    return maxHp(attacker) - attacker.hp;
  };
  assert.ok(run('rock-head') > 0);
  assert.equal(run('magic-guard'), 0);
});

test('a Razz Berry makes the catch easier, and a catching berry is not held', options, () => {
  const onix = make('onix', 40);
  assert.ok(catchValue(onix, 'poke-ball', { berry: 'golden-razz-berry' }) > catchValue(onix, 'poke-ball', { berry: 'silver-razz-berry' }));
  assert.ok(catchValue(onix, 'poke-ball', { berry: 'silver-razz-berry' }) > catchValue(onix, 'poke-ball'));
  // The ones that meant nothing without Let's Go's systems are not in the game.
  assert.equal(gameData().items['golden-nanab-berry'], undefined);
  assert.equal(gameData().items['silver-pinap-berry'], undefined);
  assert.equal(canHold('golden-razz-berry'), false);
  assert.equal(canHold('sitrus-berry'), true);
});

test('a candy that lifts the level says so, and one that does not stays quiet', options, () => {
  const pokemon = make('pikachu', 10);
  const session = bag({ 'rare-candy': 1, 'exp-candy-xs': 1 }, pokemon);

  const candy = useItem(session, 'rare-candy');
  assert.ok(candy.ok);
  assert.ok(candy.message?.includes('battle.levelUp'), candy.message);

  // A hundred points is not a level at eleven.
  const small = useItem(session, 'exp-candy-xs');
  assert.ok(small.ok);
  assert.ok(!small.message?.includes('battle.levelUp'), small.message);
});

test('a candy level does what a battle level does: moves, friendship, evolution', options, () => {
  /** @param {any} pokemon */
  const candySession = (pokemon) => {
    const session = bag({ 'rare-candy': 5 }, pokemon);
    session.caughtNow = [];
    session.markCaught = (id) => session.caughtNow.push(id);
    session.box = [];
    session.area = { tags: ['grass'] };
    session.rng = new Rng(3);
    return session;
  };

  // A move of the level crossed goes straight into a free slot.
  const charmander = make('charmander', 5, ['scratch']);
  const at = speciesOf(charmander.speciesId).learnset.level.find(([level, move]) => level > 5 && level < 16 && move !== 'scratch');
  assert.ok(at, 'Charmander learns something before it evolves');
  charmander.experience = experienceForLevel(speciesOf(charmander.speciesId).growthRate, at[0] - 1);
  const fond = charmander.friendship ?? 0;
  const learning = useItem(candySession(charmander), 'rare-candy');
  assert.ok(charmander.moves.some((slot) => slot.move === at[1]), `${at[1]} is in a slot`);
  assert.ok(learning.message?.includes('battle.learned'), learning.message);
  assert.ok((charmander.friendship ?? 0) > fond, 'a level is worth friendship');

  // And the level it evolves at evolves it there and then.
  charmander.experience = experienceForLevel(speciesOf(charmander.speciesId).growthRate, 15);
  const session = candySession(charmander);
  const evolving = useItem(session, 'rare-candy');
  assert.equal(speciesOf(charmander.speciesId).slug, 'charmeleon');
  assert.deepEqual(session.caughtNow, [charmander.speciesId]);
  assert.ok(evolving.message?.includes('battle.evolving'), evolving.message);
});

test('the battle bag lists every medicine, greying out what would do nothing', options, () => {
  const pokemon = make('pikachu', 20, ['thunder-shock']);
  const session = bag({ potion: 1, antidote: 2, 'full-heal': 1, ether: 1, elixir: 1, 'rare-candy': 1 }, pokemon);
  session.pocket = (pocket) =>
    Object.entries(session.bag)
      .filter(([slug, count]) => count > 0 && gameData().items[slug]?.pocket === pocket)
      .map(([slug, count]) => ({ slug, count, item: gameData().items[slug] }));
  const usable = () => Object.fromEntries(battleMedicine(session, pokemon).map((entry) => [entry.slug, entry.usable]));

  // Healthy, nothing wrong, every move full: all listed, none usable, and no
  // Rare Candy — that is not for a fight.
  assert.deepEqual(usable(), { potion: false, antidote: false, 'full-heal': false, ether: false, elixir: false });
  assert.deepEqual(battleMedicine(session, pokemon).map((entry) => entry.slug), ['potion', 'antidote', 'full-heal', 'ether', 'elixir']);

  pokemon.hp -= 10;
  pokemon.status = 'par';
  pokemon.moves[0].pp -= 1;
  assert.deepEqual(usable(), { potion: true, antidote: false, 'full-heal': true, ether: true, elixir: true });
  pokemon.status = 'psn';
  assert.equal(usable().antidote, true);
});


test('on the first run a TM found leans to one the companion can learn, and nothing else changes', options, () => {
  const pikachu = make('pikachu', 20);
  const machines = Object.keys(gameData().items).filter((slug) => gameData().items[slug].pocket === 'machines');
  const pool = [...machines, 'potion', 'poke-ball', 'leftovers'];
  const natural = machines.filter((slug) => learnsMachine(pikachu, slug)).length / machines.length;
  assert.ok(natural > 0.05 && natural < 0.5, `Pikachu learns ${natural.toFixed(2)} of the TMs`);

  /** @param {boolean} firstRun */
  const finds = (firstRun) => {
    const session = { ...bag({}, pikachu), rng: new Rng(5), firstRun };
    const found = Array.from({ length: 4000 }, () => /** @type {string} */ (pickFind(session, pool)));
    const tms = found.filter((slug) => machines.includes(slug));
    return { tmShare: tms.length / found.length, learnable: tms.filter((slug) => learnsMachine(pikachu, slug)).length / tms.length };
  };
  const first = finds(true);
  const later = finds(false);
  const expected = LEARNABLE_MACHINE_SHARE + (1 - LEARNABLE_MACHINE_SHARE) * natural;
  assert.ok(Math.abs(first.learnable - expected) < 0.05, `first run: ${first.learnable.toFixed(2)} learnable, expected ${expected.toFixed(2)}`);
  assert.ok(Math.abs(later.learnable - natural) < 0.05, `after a champion: ${later.learnable.toFixed(2)} learnable`);
  // How often a find is a TM at all is the pool's either way.
  assert.ok(Math.abs(first.tmShare - later.tmShare) < 0.03);

  assert.equal(pickFind({ ...bag({}, pikachu), rng: new Rng(1), firstRun: true }, []), null);
});
