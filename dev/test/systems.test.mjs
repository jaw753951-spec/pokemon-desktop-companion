/**
 * The systems the game carried the data for without ever reading it: shiny
 * Pokémon, abilities, move classifications, the field, and the items that used
 * to do nothing.
 *
 * Everything here runs against the real generated data rather than a fixture,
 * so a change to the pipeline that stopped producing a move's classification
 * or an ability's name is caught here rather than in a battle.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { MOVE_FLAGS } from '../../app/shared/move-flags.mjs';
import { weatherForArea } from '../../app/shared/area-tags.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { abilityOf, artOf, gameData, itemOf, moveHasFlag, moveOf, spriteKey } from '../../app/renderer/core/data.mjs';
import { ABILITIES, abilityWorks } from '../../app/renderer/engine/abilities.mjs';
import { Battle, STATUS } from '../../app/renderer/engine/battle.mjs';
import {
  Field,
  FIELD_MOVES,
  TERRAIN,
  terrainBlocksStatus,
  terrainDamage,
  WEATHER,
  weatherAccuracy,
  weatherBites,
  weatherDamage,
  weatherHealing,
} from '../../app/renderer/engine/field.mjs';
import { useItem } from '../../app/renderer/engine/items.mjs';
import {
  abilitySlot,
  createPokemon,
  evolveInto,
  levelOf,
  maxHp,
  maxPp,
  pendingEvolution,
  setMove,
  SHINY_ODDS,
} from '../../app/renderer/engine/pokemon.mjs';
import { rollWildPokemon, wildLevelDrop } from '../../app/renderer/engine/encounter.mjs';
import { FIRST_RUN_WILD_LEVEL_DROP, FIRST_RUN_WILD_UNTIL } from '../../app/shared/constants.mjs';
import { defaultAutoBattle } from '../../app/renderer/engine/session.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

const CHARIZARD = 6;
const BLASTOISE = 9;
const PIKACHU = 25;
const GEODUDE = 74;
const DITTO = 132;

/**
 * A foe that can stand there all day and never hurt anything, for the tests
 * about what happens between turns rather than during one.
 */
const punchbag = (level = 70) => fixed(GEODUDE, level, ['defense-curl']);

/** A Pokémon with settled genes, so a number in a test means something. */
function fixed(speciesId, level, moves = []) {
  const pokemon = createPokemon(new Rng(1), speciesId, level, { ivFloor: 31, shiny: false });
  pokemon.nature = 'hardy';
  if (moves.length) {
    pokemon.moves = [];
    moves.forEach((move, index) => setMove(pokemon, index, move));
  }
  pokemon.hp = maxHp(pokemon);
  return pokemon;
}

/** A battle of two, with the player's policy left at its defaults. */
function fight(player, foe, extra = {}) {
  return new Battle({
    rng: new Rng(7),
    player,
    foes: [foe],
    policy: defaultAutoBattle(),
    ...extra,
  });
}

// ------------------------------------------------------------------ shiny

test('a shiny is rolled at the odds the newest games use', options, () => {
  // 1/4096 since X and Y; the rate itself is the claim, so it is asserted
  // rather than sampled — sampling it would need millions of rolls.
  assert.equal(SHINY_ODDS, 1 / 4096);

  // And it is rolled, rather than being a field nothing ever sets: forcing
  // the roll both ways has to reach the Pokémon.
  assert.equal(createPokemon(new Rng(1), PIKACHU, 5, { shiny: true }).shiny, true);
  assert.equal(createPokemon(new Rng(1), PIKACHU, 5, { shiny: false }).shiny, false);

  // Over a long run of ordinary rolls, essentially none of them come up.
  const rng = new Rng(99);
  let shiny = 0;
  for (let roll = 0; roll < 4000; roll++) if (rng.chance(SHINY_ODDS)) shiny++;
  assert.ok(shiny <= 5, `expected a handful at most, got ${shiny}`);
});

test('a shiny is drawn from its own art', options, () => {
  const plain = { speciesId: CHARIZARD, shiny: false };
  const shiny = { speciesId: CHARIZARD, shiny: true };

  assert.equal(artOf(plain)?.path, 'pokemon/6/art.png');
  assert.equal(artOf(shiny)?.path, 'pokemon/6/art-shiny.png');

  // A screen that caches a decoded sprite has to be able to tell them apart.
  assert.notEqual(spriteKey(plain), spriteKey(shiny));
});

// ---------------------------------------------------------------- abilities

test('a wild Pokémon draws from its whole ability pool, hidden included', options, () => {
  // Ditto: Limber is its ordinary ability and Imposter its hidden one, and it
  // never evolves into something with a different list.
  const area = { id: 'test', tags: ['grass'], encounters: [{ species: 'ditto' }] };
  const companion = fixed(PIKACHU, 30);

  const seen = new Set();
  const rng = new Rng(5);
  // Some of the wild comes from the whole Pokédex; only the Dittos count.
  for (let roll = 0; roll < 300; roll++) {
    const wild = rollWildPokemon(rng, area, companion);
    if (wild.speciesId === DITTO) seen.add(wild.ability);
  }
  assert.deepEqual([...seen].sort(), ['imposter', 'limber']);

  // A Pokémon a trainer sends out draws from the ordinary ones only, which is
  // what the games give them.
  const ordinary = new Set();
  for (let roll = 0; roll < 100; roll++) ordinary.add(createPokemon(rng, DITTO, 30).ability);
  assert.deepEqual([...ordinary], ['limber']);
});

test('evolving keeps the ability slot rather than the ability', options, () => {
  // Eevee's second slot is Adaptability; Vaporeon's is Hydration.
  const eevee = fixed(133, 30);
  eevee.ability = 'adaptability';
  assert.equal(abilitySlot(eevee), 1);

  evolveInto(eevee, 134);
  assert.equal(eevee.ability, 'hydration');
  assert.equal(abilitySlot(eevee), 1);
});

test('every ability the engine reads is one the dex ships', options, () => {
  const dex = gameData().abilities;
  for (const slug of Object.keys(ABILITIES)) {
    assert.ok(dex[slug], `${slug} is not an ability the pipeline built`);
    assert.ok(abilityOf(slug)?.name, `${slug} has no official name`);
  }
  // Half the dex or better, so the screens are not mostly "no effect yet".
  assert.ok(Object.keys(ABILITIES).length >= Object.keys(dex).length / 2);
  assert.equal(abilityWorks('static'), true);
  assert.equal(abilityWorks('not-an-ability'), false);
});

test('an ability changes what a stat comes to', options, () => {
  const pikachu = fixed(PIKACHU, 50);
  const foe = fixed(GEODUDE, 50);

  const battle = fight(pikachu, foe);
  const plain = battle.stat(battle.player, 'atk');

  pikachu.ability = 'huge-power';
  assert.equal(battle.stat(battle.player, 'atk'), plain * 2);

  // And a weather ability only acts while its weather is out.
  pikachu.ability = 'chlorophyll';
  const speed = battle.stat(battle.player, 'spe');
  battle.field.setWeather(WEATHER.SUN, 5);
  assert.equal(battle.stat(battle.player, 'spe'), speed * 2);

  // A Cloud Nine on the other side takes the sky out of the fight.
  foe.ability = 'cloud-nine';
  assert.equal(battle.stat(battle.player, 'spe'), speed);
});

test('Intimidate acts on the way in, before a blow is struck', options, () => {
  const player = fixed(PIKACHU, 50);
  player.ability = 'intimidate';
  const foe = fixed(GEODUDE, 50);
  foe.ability = 'static';

  const battle = fight(player, foe);
  assert.equal(battle.foe?.stages.atk, -1);
  assert.ok(battle.opening.some((entry) => entry.kind === 'ability'));
});

test('a contact move answers to what it touched, and a non-contact one does not', options, () => {
  const player = fixed(PIKACHU, 50, ['tackle']);
  const foe = punchbag();
  foe.ability = 'rough-skin';

  const battle = fight(player, foe);
  const before = player.hp;
  for (let turn = 0; turn < 4 && battle.running; turn++) battle.takeTurn();
  assert.ok(player.hp < before);

  // Ember is the same power bracket and does not touch, so a Rough Skin has
  // nothing to answer.
  const safe = fixed(PIKACHU, 50, ['ember']);
  const other = punchbag();
  other.ability = 'rough-skin';
  const second = fight(safe, other);
  const log = second.takeTurn();
  assert.ok(!log.some((entry) => entry.kind === 'abilityDamage' && entry.side === 'player'));
});

test('a type a Pokémon drinks does nothing to it', options, () => {
  const player = fixed(PIKACHU, 50, ['thunder-shock']);
  const foe = punchbag(50);
  foe.ability = 'volt-absorb';
  foe.hp = Math.floor(maxHp(foe) / 2);

  const battle = fight(player, foe);
  const before = foe.hp;
  battle.takeTurn();
  assert.ok(foe.hp > before, 'Volt Absorb should have healed rather than taken damage');
});

test('Levitate and an Air Balloon both keep a Pokémon off the ground', options, () => {
  const player = fixed(PIKACHU, 50);
  const foe = fixed(GEODUDE, 50);
  const battle = fight(player, foe);

  assert.equal(battle.grounded(battle.player), true);
  player.ability = 'levitate';
  assert.equal(battle.grounded(battle.player), false);

  player.ability = 'static';
  player.heldItem = 'air-balloon';
  assert.equal(battle.grounded(battle.player), false);
  // Until something pops it.
  battle.player.marks.popped = true;
  assert.equal(battle.grounded(battle.player), true);
});

// ------------------------------------------------------------- move classes

test('every move carries its classification, and only the ones the game ships', options, () => {
  const moves = gameData().moves;
  const shipped = new Set(MOVE_FLAGS);

  let classified = 0;
  for (const move of Object.values(moves)) {
    assert.ok(Array.isArray(move.flags), `${move.name?.en} has no classification field`);
    for (const flag of move.flags) assert.ok(shipped.has(flag), `unexpected classification ${flag}`);
    if (move.flags.length) classified++;
  }
  assert.ok(classified > 300, `only ${classified} moves classified`);

  // The ones everything else keys off, spot-checked against the games.
  assert.ok(moveHasFlag(moveOf('tackle'), 'contact'));
  assert.ok(!moveHasFlag(moveOf('flamethrower'), 'contact'));
  assert.ok(moveHasFlag(moveOf('fire-punch'), 'punch'));
  assert.ok(moveHasFlag(moveOf('crunch'), 'bite'));
  assert.ok(moveHasFlag(moveOf('sleep-powder'), 'powder'));
  assert.ok(moveHasFlag(moveOf('shadow-ball'), 'bullet'));
  assert.ok(moveHasFlag(moveOf('boomburst'), 'sound'));
  assert.ok(moveHasFlag(moveOf('psycho-cut'), 'slicing'));
  assert.ok(moveHasFlag(moveOf('solar-beam'), 'charge'));
  assert.ok(moveHasFlag(moveOf('hyper-beam'), 'recharge'));
});

test('a classification is what an ability and an item key off', options, () => {
  // Against a Blastoise, so an Electric punch is worth something at all.
  const player = fixed(PIKACHU, 50, ['thunder-punch']);
  const foe = fixed(BLASTOISE, 90);

  const plain = fight(player, foe);
  const punched = plain.computeDamage(plain.player, /** @type {any} */ (plain.foe), moveOf('thunder-punch'));

  player.ability = 'iron-fist';
  const fisted = fight(player, foe);
  const stronger = fisted.computeDamage(fisted.player, /** @type {any} */ (fisted.foe), moveOf('thunder-punch'));
  assert.ok(stronger.damage > punched.damage);

  // A Bulletproof stops a bullet and nothing else.
  const shielded = fixed(GEODUDE, 50);
  shielded.ability = 'bulletproof';
  const battle = fight(fixed(PIKACHU, 50, ['shadow-ball']), shielded);
  assert.equal(battle.movePrevented(battle.player, /** @type {any} */ (battle.foe), moveOf('shadow-ball')), true);
  assert.equal(battle.movePrevented(battle.player, /** @type {any} */ (battle.foe), moveOf('flamethrower')), false);
});

test('a two-turn move charges, and a recharging one costs the turn after', options, () => {
  const player = fixed(1, 60, ['solar-beam']);
  const battle = fight(player, punchbag());

  // A Solar Beam charges with its own line: "빛을 흡수했다!".
  const charging = (entry) => entry.kind === 'charging' || String(entry.data?.key ?? '').startsWith('move.charge.');
  const first = battle.takeTurn();
  assert.ok(first.some((entry) => charging(entry) && entry.side === 'player'));
  assert.equal(battle.player.charging, 'solar-beam');

  const second = battle.takeTurn();
  assert.equal(battle.player.charging, null);
  assert.ok(second.some((entry) => entry.kind === 'move' && entry.data?.move === 'solar-beam'));

  // A Power Herb buys the charge turn outright.
  const quick = fixed(1, 60, ['solar-beam']);
  quick.heldItem = 'power-herb';
  const rushed = fight(quick, punchbag());
  const log = rushed.takeTurn();
  assert.ok(!log.some(charging));
  assert.equal(quick.heldItem, null);

  // And the sun makes the charge unnecessary in the first place.
  const sunny = fight(fixed(1, 60, ['solar-beam']), punchbag());
  sunny.field.setWeather(WEATHER.SUN, 5);
  assert.ok(!sunny.takeTurn().some(charging));
});

// ----------------------------------------------------------- field effects

test('the weather decides what a type is worth', options, () => {
  assert.equal(weatherDamage(WEATHER.SUN, 'fire'), 1.5);
  assert.equal(weatherDamage(WEATHER.SUN, 'water'), 0.5);
  assert.equal(weatherDamage(WEATHER.RAIN, 'water'), 1.5);
  assert.equal(weatherDamage(WEATHER.RAIN, 'fire'), 0.5);
  assert.equal(weatherDamage(null, 'fire'), 1);

  // Thunder cannot miss in rain and is half as likely to land in sunshine.
  assert.equal(weatherAccuracy(WEATHER.RAIN, 'thunder'), 'always');
  assert.equal(weatherAccuracy(WEATHER.SUN, 'thunder'), 0.5);
  assert.equal(weatherAccuracy(WEATHER.RAIN, 'tackle'), 1);

  // A Synthesis is worth two thirds of a bar in sunshine and a quarter in
  // anything else.
  assert.ok(weatherHealing(WEATHER.SUN, 'synthesis', 50) > 66);
  assert.equal(weatherHealing(WEATHER.RAIN, 'synthesis', 50), 25);
  assert.equal(weatherHealing(null, 'synthesis', 50), 50);
  assert.equal(weatherHealing(WEATHER.SUN, 'recover', 50), 50);

  // Sand bites anything that is not built for it.
  assert.equal(weatherBites(WEATHER.SANDSTORM, ['rock']), false);
  assert.equal(weatherBites(WEATHER.SANDSTORM, ['fire']), true);
  assert.equal(weatherBites(WEATHER.HAIL, ['ice']), false);
  assert.equal(weatherBites(WEATHER.SNOW, ['fire']), false);
});

test('the terrain only reaches what is standing on it', options, () => {
  assert.equal(terrainDamage(TERRAIN.ELECTRIC, 'electric', true, true), 1.3);
  assert.equal(terrainDamage(TERRAIN.ELECTRIC, 'electric', false, true), 1);
  assert.equal(terrainDamage(TERRAIN.GRASSY, 'grass', true, true), 1.3);
  assert.equal(terrainDamage(TERRAIN.MISTY, 'dragon', true, true), 0.5);
  assert.equal(terrainDamage(TERRAIN.MISTY, 'dragon', true, false), 1);

  assert.equal(terrainBlocksStatus(TERRAIN.MISTY, 'brn'), true);
  assert.equal(terrainBlocksStatus(TERRAIN.ELECTRIC, 'slp'), true);
  assert.equal(terrainBlocksStatus(TERRAIN.ELECTRIC, 'brn'), false);
});

test('a field effect runs out, and a rock makes it last longer', options, () => {
  const field = new Field();
  assert.equal(field.quiet, true);

  field.setWeather(WEATHER.RAIN, 2);
  assert.equal(field.quiet, false);
  assert.equal(field.tick().length, 0);
  assert.deepEqual(field.tick(), [{ kind: 'weather', value: WEATHER.RAIN }]);
  assert.equal(field.weather, null);

  // A Heat Rock holder's Sunny Day lasts eight rounds rather than five.
  const player = fixed(CHARIZARD, 50, ['sunny-day']);
  player.heldItem = 'heat-rock';
  const battle = fight(player, punchbag());
  battle.startWeather(WEATHER.SUN, battle.player, []);
  assert.equal(battle.field.weatherTurns, 8);
});

test('a move that calls the weather actually calls it', options, () => {
  // The nine that set one are named rather than parsed, so the table has to
  // agree with the moves the dex shipped.
  for (const slug of Object.keys(FIELD_MOVES)) {
    assert.ok(moveOf(slug), `${slug} is in the field table but not in the dex`);
  }

  const player = fixed(CHARIZARD, 50, ['sunny-day']);
  const battle = fight(player, punchbag());
  const log = battle.takeTurn();
  assert.equal(battle.field.weather, WEATHER.SUN);
  assert.ok(log.some((entry) => entry.kind === 'weather'));
});

test('a screen halves what comes at the side that put it up', options, () => {
  const battle = fight(fixed(PIKACHU, 50, ['tackle']), punchbag());
  const move = moveOf('tackle');

  assert.equal(battle.screenMultiplier(battle.player, move, false), 1);
  battle.field.setScreen('player', 'physical', 5);
  assert.equal(battle.screenMultiplier(battle.player, move, false), 0.5);
  // A critical hit goes straight through one.
  assert.equal(battle.screenMultiplier(battle.player, move, true), 1);
});

test('an area with weather in its name fights under it', options, () => {
  assert.equal(weatherForArea({ tags: ['jungle', 'rain'] }), WEATHER.RAIN);
  assert.equal(weatherForArea({ tags: ['desert', 'sand'] }), WEATHER.SANDSTORM);
  assert.equal(weatherForArea({ tags: ['cave', 'ice'] }), WEATHER.SNOW);
  assert.equal(weatherForArea({ tags: ['grass', 'plain'] }), null);

  // And it does not run out, because nobody called for it.
  const battle = fight(fixed(PIKACHU, 50), fixed(GEODUDE, 50), { weather: WEATHER.RAIN });
  assert.equal(battle.field.weather, WEATHER.RAIN);
  battle.takeTurn();
  assert.equal(battle.field.weather, WEATHER.RAIN);
});

test('the auto-battle "no field effect" condition finally has something to read', options, () => {
  const battle = fight(fixed(CHARIZARD, 50, ['sunny-day', 'ember']), punchbag());
  assert.equal(battle.field.quiet, true);
  battle.field.setWeather(WEATHER.SUN, 5);
  assert.equal(battle.field.quiet, false);
});

// --------------------------------------------------------------- the items

test('the items that used to do nothing now say what they do', options, () => {
  const expected = {
    'occa-berry': 'resist',
    'rocky-helmet': 'contact',
    'safety-goggles': 'shield',
    'air-balloon': 'immune',
    'weakness-policy': 'hurt',
    'absorb-bulb': 'hurt',
    'white-herb': 'restore',
    'power-herb': 'charge',
    'toxic-orb': 'selfStatus',
    'wide-lens': 'accuracy',
    'bright-powder': 'evasion',
    'light-clay': 'extend',
    'heat-rock': 'extend',
    'terrain-extender': 'extend',
    everstone: 'noEvolve',
    'kings-rock': 'flinch',
    'lagging-tail': 'last',
    'electric-seed': 'terrain',
    'light-ball': 'stat',
    'thick-club': 'stat',
    metronome: 'damage',
  };
  for (const [slug, on] of Object.entries(expected)) {
    assert.equal(itemOf(slug)?.held?.on, on, `${slug} should be read as "${on}"`);
    assert.equal(itemOf(slug)?.works, true, `${slug} should be marked as working`);
  }

  // And the ones used from the bag.
  assert.deepEqual(itemOf('adamant-mint')?.use, { nature: 'adamant' });
  assert.deepEqual(itemOf('ability-capsule')?.use, { ability: 'swap' });
  assert.deepEqual(itemOf('ability-patch')?.use, { ability: 'hidden' });
  assert.deepEqual(itemOf('bottle-cap')?.use, { genes: 'one' });
  assert.deepEqual(itemOf('gold-bottle-cap')?.use, { genes: 'all' });
  assert.deepEqual(itemOf('paralyze-heal')?.use, { status: 'par' });
  assert.deepEqual(itemOf('burn-heal')?.use, { status: 'brn' });
});

test('a Mint rewrites the nature and a Bottle Cap the genes', options, () => {
  const pokemon = createPokemon(new Rng(3), PIKACHU, 30);
  pokemon.nature = 'hardy';
  pokemon.ivs = { hp: 5, atk: 2, def: 9, spa: 12, spd: 20, spe: 30 };
  const session = bag({ 'adamant-mint': 1, 'bottle-cap': 1, 'gold-bottle-cap': 1 }, pokemon);

  assert.equal(useItem(session, 'adamant-mint').ok, true);
  assert.equal(pokemon.nature, 'adamant');
  assert.equal(session.bag['adamant-mint'], undefined);

  // One cap goes on the worst gene.
  assert.equal(useItem(session, 'bottle-cap').ok, true);
  assert.equal(pokemon.ivs.atk, 31);
  assert.equal(pokemon.ivs.hp, 5);

  assert.equal(useItem(session, 'gold-bottle-cap').ok, true);
  assert.deepEqual(Object.values(pokemon.ivs), [31, 31, 31, 31, 31, 31]);
});

test('an Ability Capsule swaps, and a Patch reaches the hidden one', options, () => {
  // Bulbasaur: Overgrow ordinary, Chlorophyll hidden — one ordinary ability,
  // so there is nothing for a Capsule to swap with.
  const bulbasaur = createPokemon(new Rng(3), 1, 20);
  bulbasaur.ability = 'overgrow';
  const session = bag({ 'ability-capsule': 1, 'ability-patch': 2 }, bulbasaur);
  assert.equal(useItem(session, 'ability-capsule').ok, false);

  assert.equal(useItem(session, 'ability-patch').ok, true);
  assert.equal(bulbasaur.ability, 'chlorophyll');
  // And back again, as the games allow.
  assert.equal(useItem(session, 'ability-patch').ok, true);
  assert.equal(bulbasaur.ability, 'overgrow');
});

test('a PP Up raises the ceiling rather than filling the bar', options, () => {
  const pokemon = fixed(PIKACHU, 30, ['thunder-shock']);
  const base = moveOf('thunder-shock').pp;
  assert.equal(maxPp(pokemon.moves[0]), base);

  const session = bag({ 'pp-up': 3, 'pp-max': 1 }, pokemon);
  assert.equal(useItem(session, 'pp-up').ok, true);
  assert.equal(maxPp(pokemon.moves[0]), base + Math.floor(base * 0.2));
  assert.equal(pokemon.moves[0].pp, maxPp(pokemon.moves[0]));

  // Three of them reach the cap, and a fourth has nothing left to buy.
  useItem(session, 'pp-up');
  useItem(session, 'pp-up');
  assert.equal(maxPp(pokemon.moves[0]), base + Math.floor(base * 0.6));
  assert.equal(useItem(session, 'pp-max').ok, false);

  // A different move in the slot starts again from its own ceiling.
  setMove(pokemon, 0, 'quick-attack');
  assert.equal(maxPp(pokemon.moves[0]), moveOf('quick-attack').pp);
});

test('an Everstone stops the levelling kind of evolution and nothing else', options, () => {
  // Pichu evolves on friendship, which this one has plenty of.
  const pichu = createPokemon(new Rng(3), 172, 30);
  pichu.friendship = 230;
  assert.ok(pendingEvolution(pichu), 'a fond Pichu should be ready');

  pichu.heldItem = 'everstone';
  assert.equal(pendingEvolution(pichu), null);

  // A stone still works while one is held: the Everstone only refuses levels.
  const eevee = createPokemon(new Rng(3), 133, 30);
  eevee.heldItem = 'everstone';
  assert.ok(pendingEvolution(eevee, { item: 'water-stone' }));
});

test('a type-resisting berry is eaten on the way in', options, () => {
  // Bulbasaur, which an Occa Berry has something to protect: fire is twice as
  // effective against it, which is what the berry waits for.
  const player = fixed(1, 50);
  player.heldItem = 'occa-berry';
  const foe = fixed(CHARIZARD, 50, ['ember']);

  const battle = fight(foe, player);
  const move = moveOf('ember');
  const plain = battle.computeDamage(battle.player, /** @type {any} */ (battle.foe), move);
  assert.equal(player.heldItem, null, 'the berry should have been eaten');

  player.heldItem = null;
  const bare = battle.computeDamage(battle.player, /** @type {any} */ (battle.foe), move);
  assert.ok(bare.damage > plain.damage, 'the berry should have softened the hit');
});

test('a Rocky Helmet charges whatever touched it', options, () => {
  const player = fixed(PIKACHU, 50, ['tackle']);
  const foe = punchbag();
  foe.heldItem = 'rocky-helmet';

  const battle = fight(player, foe);
  const before = player.hp;
  battle.takeTurn();
  assert.ok(player.hp < before);

  // A pair of Protective Pads keeps the touching from costing anything.
  const padded = fixed(PIKACHU, 50, ['tackle']);
  padded.heldItem = 'protective-pads';
  const other = punchbag();
  other.heldItem = 'rocky-helmet';
  const second = fight(padded, other);
  const full = padded.hp;
  second.takeTurn();
  assert.equal(padded.hp, full);
});

test('an orb hands its holder the condition it carries', options, () => {
  const player = fixed(PIKACHU, 50);
  player.heldItem = 'flame-orb';
  const battle = fight(player, punchbag());

  for (let turn = 0; turn < 2 && battle.running; turn++) battle.takeTurn();
  assert.equal(player.status, STATUS.BURN);
});

test('a species-specific item only works for the species it names', options, () => {
  const pikachu = fixed(PIKACHU, 50);
  const geodude = fixed(GEODUDE, 50);

  const plain = fight(pikachu, geodude);
  const before = plain.stat(plain.player, 'atk');

  pikachu.heldItem = 'light-ball';
  assert.equal(plain.stat(plain.player, 'atk'), before * 2);

  // The same item on anything else does nothing at all.
  geodude.heldItem = 'light-ball';
  const other = fight(geodude, pikachu);
  const bare = fight(fixed(GEODUDE, 50), pikachu);
  assert.equal(other.stat(other.player, 'atk'), bare.stat(bare.player, 'atk'));
});

/**
 * Just enough of a session for `useItem`: a bag it can take from and the
 * Pokémon it acts on.
 *
 * @param {Record<string, number>} contents
 * @param {any} pokemon
 */
function bag(contents, pokemon) {
  return /** @type {any} */ ({
    bag: { ...contents },
    active: pokemon,
    machines: [],
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
    markCaught() {},
  });
}

test('on the first run a wild Pokémon stands a little lower until level 30', options, () => {
  const area = { id: 'test', tags: ['grass'], encounters: [{ species: 'rattata' }] };
  assert.equal(wildLevelDrop(true, fixed(PIKACHU, 5)), FIRST_RUN_WILD_LEVEL_DROP);
  assert.equal(wildLevelDrop(true, fixed(PIKACHU, FIRST_RUN_WILD_UNTIL - 1)), FIRST_RUN_WILD_LEVEL_DROP);
  assert.equal(wildLevelDrop(true, fixed(PIKACHU, FIRST_RUN_WILD_UNTIL)), 0, 'level 30 meets the usual');
  assert.equal(wildLevelDrop(false, fixed(PIKACHU, 5)), 0, 'after a champion, the usual');

  for (const level of [2, 5, 12, 25]) {
    const companion = fixed(PIKACHU, level);
    for (let seed = 1; seed <= 30; seed++) {
      const usual = rollWildPokemon(new Rng(seed), area, companion);
      const lower = rollWildPokemon(new Rng(seed), area, companion, null, new Set(), undefined, null, wildLevelDrop(true, companion));
      assert.equal(levelOf(lower), Math.max(1, levelOf(usual) - FIRST_RUN_WILD_LEVEL_DROP), `level ${level}, seed ${seed}`);
    }
  }
});
