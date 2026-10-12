/**
 * The second layer of systems: gender and the items a Pokémon is found
 * carrying, the states that end with the battle, what can be laid on the
 * ground or put up in front, and the abilities that needed all of it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { gameData, itemOf, moveOf, speciesIdBySlug, speciesOf } from '../../app/renderer/core/data.mjs';
import { ABILITIES } from '../../app/renderer/engine/abilities.mjs';
import { Battle } from '../../app/renderer/engine/battle.mjs';
import { hazardToll, TERRAIN } from '../../app/renderer/engine/field.mjs';
import {
  createPokemon,
  levelOf,
  maxHp,
  rollGender,
  rollWildHeldItem,
  setMove,
  WILD_ITEM_ODDS,
  WILD_ITEM_ODDS_COMPOUND_EYES,
} from '../../app/renderer/engine/pokemon.mjs';
import { devolveToLevel, giveTrainerItems, isRare, pickSpecies, pickStray, rollTrainer, rollWildPokemon, typePool } from '../../app/renderer/engine/encounter.mjs';
import { defaultAutoBattle, Session } from '../../app/renderer/engine/session.mjs';
import {
  addVolatile,
  hasVolatile,
  oppositeGenders,
  PROTECT_MOVES,
  protectChance,
  tickVolatile,
  VOLATILE,
} from '../../app/renderer/engine/volatile.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

const PIKACHU = 25;
const GEODUDE = 74;
const DITTO = 132;
const CHANSEY = 113;
const MAGNEMITE = 81;

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

/** A foe that can stand there all day and never hurt anything. */
const punchbag = (level = 70) => fixed(GEODUDE, level, ['defense-curl']);

function fight(player, foes, extra = {}) {
  return new Battle({
    rng: new Rng(11),
    player,
    foes: Array.isArray(foes) ? foes : [foes],
    policy: defaultAutoBattle(),
    ...extra,
  });
}

// ----------------------------------------------------------------- gender

test('gender comes out of the species, in eighths', options, () => {
  const rng = new Rng(4);

  // Magnemite has none at all, and never gets one.
  assert.equal(rollGender(rng, speciesOf(MAGNEMITE)), null);
  // Chansey is all female, Nidoran♂ all male.
  assert.equal(rollGender(rng, speciesOf(CHANSEY)), 'female');
  assert.equal(rollGender(rng, speciesOf(32)), 'male');

  // And a species that is one in eight comes out mostly male.
  let female = 0;
  for (let roll = 0; roll < 800; roll++) if (rollGender(rng, speciesOf(1)) === 'female') female++;
  assert.ok(female > 40 && female < 160, `expected about an eighth, got ${female} of 800`);

  assert.equal(oppositeGenders({ gender: 'male' }, { gender: 'female' }), true);
  assert.equal(oppositeGenders({ gender: 'male' }, { gender: 'male' }), false);
  assert.equal(oppositeGenders({ gender: null }, { gender: 'female' }), false);
});

// -------------------------------------------------------------- held items

test('a species carries the two slots the cartridge gives it', options, () => {
  // Ditto: Quick Powder commonly, Metal Powder rarely — the pair the games
  // have given it since Diamond and Pearl.
  assert.deepEqual(speciesOf(DITTO).heldItems, { common: 'quick-powder', rare: 'metal-powder' });
  assert.equal(speciesOf(PIKACHU).heldItems.rare, 'light-ball');

  // And no slot names an item the bag could never hold.
  for (const entry of Object.values(gameData().species)) {
    for (const slug of Object.values(entry.heldItems ?? {})) {
      if (slug) assert.ok(itemOf(slug), `${entry.slug} carries ${slug}, which is not shipped`);
    }
  }
});

test('a wild Pokémon rolls its item the way the cartridge rolls it', options, () => {
  // 45 nothing, 50 common, 5 rare — straight out of SetWildMonHeldItem.
  assert.deepEqual(WILD_ITEM_ODDS, { nothing: 45, common: 95 });
  assert.deepEqual(WILD_ITEM_ODDS_COMPOUND_EYES, { nothing: 20, common: 80 });

  const rng = new Rng(9);
  const counts = { none: 0, common: 0, rare: 0 };
  for (let roll = 0; roll < 4000; roll++) {
    const ditto = fixed(DITTO, 20);
    ditto.heldItem = null;
    rollWildHeldItem(rng, ditto);
    if (!ditto.heldItem) counts.none++;
    else if (ditto.heldItem === 'quick-powder') counts.common++;
    else counts.rare++;
  }
  assert.ok(Math.abs(counts.none / 4000 - 0.45) < 0.05, `nothing: ${counts.none / 4000}`);
  assert.ok(Math.abs(counts.common / 4000 - 0.5) < 0.05, `common: ${counts.common / 4000}`);
  assert.ok(counts.rare > 0 && counts.rare / 4000 < 0.1, `rare: ${counts.rare / 4000}`);

  // A Compound Eyes in the lead turns up far more of them.
  let carrying = 0;
  for (let roll = 0; roll < 2000; roll++) {
    const ditto = fixed(DITTO, 20);
    ditto.heldItem = null;
    rollWildHeldItem(rng, ditto, { compoundEyes: true });
    if (ditto.heldItem) carrying++;
  }
  assert.ok(carrying / 2000 > 0.7, `with Compound Eyes: ${carrying / 2000}`);
});

test('a species whose two slots match always carries it', options, () => {
  const rng = new Rng(3);
  const pokemon = fixed(PIKACHU, 20);
  // Stand in a species table where both slots hold the same thing, which is
  // how the cartridge says "always".
  speciesOf(PIKACHU).heldItems = { common: 'oran-berry', rare: 'oran-berry' };
  try {
    for (let roll = 0; roll < 50; roll++) {
      pokemon.heldItem = null;
      rollWildHeldItem(rng, pokemon);
      assert.equal(pokemon.heldItem, 'oran-berry');
    }
  } finally {
    speciesOf(PIKACHU).heldItems = { common: null, rare: 'light-ball' };
  }
});

test('a wild encounter arrives with whatever it rolled', options, () => {
  const area = { id: 'test', tags: ['grass'], encounters: [{ species: 'ditto' }] };
  const companion = fixed(PIKACHU, 30);

  const rng = new Rng(2);
  let carrying = 0;
  for (let roll = 0; roll < 300; roll++) {
    if (rollWildPokemon(rng, area, companion).heldItem) carrying++;
  }
  assert.ok(carrying > 100, `only ${carrying} of 300 turned up carrying anything`);
});

test('a trainer hands the berry to the Pokémon they lead with last', options, () => {
  const rng = new Rng(6);

  // A gym leader's ace, and nobody else's.
  const party = [fixed(GEODUDE, 30), fixed(GEODUDE, 32), fixed(GEODUDE, 35)];
  giveTrainerItems(rng, party, 'leader');
  assert.equal(party[0].heldItem, null);
  assert.equal(party[1].heldItem, null);
  assert.equal(party[2].heldItem, 'sitrus-berry');

  // An ordinary trainer's almost never does: 55 of 1487 in Emerald.
  let carrying = 0;
  for (let roll = 0; roll < 2000; roll++) {
    const one = [fixed(GEODUDE, 20)];
    giveTrainerItems(rng, one, 'trainer');
    if (one[0].heldItem) carrying++;
  }
  assert.ok(carrying / 2000 < 0.1, `ordinary trainers carried ${carrying / 2000}`);
  assert.ok(carrying > 0, 'but not never');
});

// ------------------------------------------------------- confusion and love

test('confusion runs out, and hurts on the way', options, () => {
  const player = fixed(PIKACHU, 50, ['tackle']);
  const battle = fight(player, punchbag());

  assert.equal(battle.confuse(battle.player, []), true);
  assert.ok(hasVolatile(battle.player, VOLATILE.CONFUSION));
  // Already confused is not confused twice.
  assert.equal(battle.confuse(battle.player, []), false);

  for (let turn = 0; turn < 12 && battle.running; turn++) battle.takeTurn();
  assert.equal(hasVolatile(battle.player, VOLATILE.CONFUSION), false, 'it should have worn off');

  // A third of the turns spent confused go on hurting itself, so across a
  // few fights it does, whichever way any one of them rolls.
  let hitItself = false;
  for (let seed = 1; seed <= 6 && !hitItself; seed++) {
    const again = fixed(PIKACHU, 50, ['tackle']);
    const confused = fight(again, punchbag(), { rng: new Rng(seed) });
    confused.confuse(confused.player, []);
    const before = again.hp;
    for (let turn = 0; turn < 12 && confused.running; turn++) {
      if (confused.takeTurn().some((entry) => entry.kind === 'confusionDamage')) hitItself = true;
    }
    if (hitItself) assert.ok(again.hp < before);
  }
  assert.ok(hitItself, 'six fights confused and it never once hit itself');
});

test('a Persim Berry is eaten the moment the confusion lands', options, () => {
  const player = fixed(PIKACHU, 50);
  player.heldItem = 'persim-berry';
  const battle = fight(player, punchbag());

  const log = [];
  battle.confuse(battle.player, log);
  assert.equal(hasVolatile(battle.player, VOLATILE.CONFUSION), false);
  assert.equal(player.heldItem, null);
  assert.ok(log.some((entry) => entry.kind === 'berry'));
});

test('infatuation needs one of each', options, () => {
  const male = fixed(PIKACHU, 50);
  male.gender = 'male';
  const female = punchbag();
  female.gender = 'female';

  const battle = fight(male, female);
  assert.equal(battle.infatuate(battle.player, /** @type {any} */ (battle.foe), []), true);
  assert.ok(hasVolatile(/** @type {any} */ (battle.foe), VOLATILE.INFATUATION));

  // And refuses a pair that is not one of each.
  female.gender = 'male';
  const same = fight(male, female);
  assert.equal(same.infatuate(same.player, /** @type {any} */ (same.foe), []), false);

  // Or one that has no gender at all.
  const magnemite = fixed(MAGNEMITE, 50);
  magnemite.gender = null;
  const neither = fight(male, magnemite);
  assert.equal(neither.infatuate(neither.player, /** @type {any} */ (neither.foe), []), false);
});

test('Misty Terrain keeps both of them off whatever stands on it', options, () => {
  const battle = fight(fixed(PIKACHU, 50), punchbag());
  battle.field.setTerrain(TERRAIN.MISTY, 5);
  assert.equal(battle.confuse(battle.player, []), false);
});

// ------------------------------------------ hazards, guards and lost moves

test('what is laid on the ground bites what walks onto it', options, () => {
  const toll = (hazards, arriving) =>
    hazardToll(hazards, arriving, (attacking, types) => (types.includes('flying') ? 2 : 1));

  // Spikes only reach the ground, and stack in three layers.
  const grounded = { types: ['normal'], grounded: true };
  assert.equal(toll({ spikes: 1, toxicSpikes: 0, stealthRock: 0, stickyWeb: 0 }, grounded).damage, 1 / 8);
  assert.equal(toll({ spikes: 3, toxicSpikes: 0, stealthRock: 0, stickyWeb: 0 }, grounded).damage, 1 / 4);
  assert.equal(
    toll({ spikes: 3, toxicSpikes: 0, stealthRock: 0, stickyWeb: 0 }, { types: ['flying'], grounded: false }).damage,
    0,
  );

  // Stealth Rock reaches everything, scaled by how it takes a Rock move.
  const rocks = { spikes: 0, toxicSpikes: 0, stealthRock: 1, stickyWeb: 0 };
  assert.equal(toll(rocks, { types: ['flying'], grounded: false }).damage, 1 / 4);

  // Toxic Spikes poison what walks on them, and a grounded Poison type takes
  // them away simply by arriving.
  const poison = { spikes: 0, toxicSpikes: 1, stealthRock: 0, stickyWeb: 0 };
  assert.equal(toll(poison, grounded).status, 'psn');
  assert.equal(toll(poison, { types: ['steel'], grounded: true }).status, null);
  assert.equal(toll(poison, { types: ['poison'], grounded: true }).absorbs, true);

  // And a web takes a stage of Speed off whatever is standing on it.
  assert.equal(toll({ spikes: 0, toxicSpikes: 0, stealthRock: 0, stickyWeb: 1 }, grounded).stat, 'spe');
});

test('the next Pokémon a trainer sends out walks onto them', options, () => {
  const player = fixed(PIKACHU, 90, ['spikes', 'thunderbolt']);
  const battle = fight(player, [fixed(GEODUDE, 5), fixed(GEODUDE, 5)]);

  battle.field.addHazard('foe', 'spikes');
  const next = battle.foeQueue[0];
  const before = next.pokemon.hp;

  // Knock the first one down and the second walks in over the spikes.
  const log = [];
  while (battle.running && log.length < 200) log.push(...battle.takeTurn());
  assert.ok(next.pokemon.hp < before || next.pokemon.hp === 0, 'the second one should have been bitten');

  // A pair of Heavy-Duty Boots steps over them.
  const booted = fight(fixed(PIKACHU, 90), punchbag());
  booted.field.addHazard('player', 'spikes');
  booted.player.pokemon.heldItem = 'heavy-duty-boots';
  const full = booted.player.pokemon.hp;
  booted.walkOntoHazards(booted.player, []);
  assert.equal(booted.player.pokemon.hp, full);
});

test('a guard holds for a turn, and gets harder to put up', options, () => {
  // Every move in the table is one the dex actually ships.
  for (const slug of Object.keys(PROTECT_MOVES)) assert.ok(moveOf(slug), `${slug} is not a move`);

  assert.equal(protectChance(0), 1);
  assert.ok(protectChance(1) - 1 / 3 < 1e-9);
  assert.ok(protectChance(2) < 0.2);

  const player = fixed(PIKACHU, 50, ['protect']);
  const foe = fixed(GEODUDE, 50, ['tackle']);
  const battle = fight(player, foe);

  const log = battle.takeTurn();
  assert.ok(log.some((entry) => entry.kind === 'protect'));
  assert.ok(log.some((entry) => entry.kind === 'protected'), 'the tackle should have been stopped');
});

test('a Spiky Shield charges whatever touched it', options, () => {
  const player = fixed(PIKACHU, 50, ['spiky-shield']);
  const foe = fixed(GEODUDE, 60, ['tackle']);
  const battle = fight(player, foe);

  const before = foe.hp;
  battle.takeTurn();
  assert.ok(foe.hp < before, 'the Pokémon that ran into it should have paid');
});

test('a move can be taken away', options, () => {
  const player = fixed(PIKACHU, 50, ['taunt', 'thunderbolt']);
  const foe = fixed(GEODUDE, 60, ['defense-curl', 'tackle']);
  const battle = fight(player, foe);

  assert.ok(battle.applyLock(battle.player, /** @type {any} */ (battle.foe), { state: VOLATILE.TAUNT, turns: 3 }, []));
  // Under a Taunt it has to reach for the attack.
  const usable = battle.stillAllowed(/** @type {any} */ (battle.foe), foe.moves);
  assert.deepEqual(usable.map((slot) => slot.move), ['tackle']);

  // A Mental Herb undoes it.
  foe.heldItem = 'mental-herb';
  battle.eatMentalHerb(/** @type {any} */ (battle.foe), []);
  assert.equal(hasVolatile(/** @type {any} */ (battle.foe), VOLATILE.TAUNT), false);
  assert.equal(foe.heldItem, null);
});

test('an Encore locks a Pokémon into what it just used', options, () => {
  const foe = fixed(GEODUDE, 60, ['tackle', 'defense-curl']);
  const battle = fight(fixed(PIKACHU, 50, ['encore']), foe);
  battle.foe.lastMove = 'defense-curl';

  assert.ok(battle.applyLock(battle.player, /** @type {any} */ (battle.foe), { state: VOLATILE.ENCORE, turns: 3 }, []));
  assert.equal(battle.chooseMove(/** @type {any} */ (battle.foe), battle.player), 'defense-curl');
});

test('the clocks run down together', options, () => {
  const combatant = { volatile: {} };
  addVolatile(combatant, VOLATILE.TAUNT, 2);
  addVolatile(combatant, VOLATILE.CONFUSION, 1);

  assert.deepEqual(tickVolatile(combatant), [VOLATILE.CONFUSION]);
  assert.deepEqual(tickVolatile(combatant), [VOLATILE.TAUNT]);
  assert.deepEqual(tickVolatile(combatant), []);
});

// -------------------------------------------------------- the new abilities

test('the engine reads most of the dex now', options, () => {
  const dex = gameData().abilities;
  assert.ok(Object.keys(ABILITIES).length > Object.keys(dex).length * 0.75);
  for (const slug of Object.keys(ABILITIES)) assert.ok(dex[slug], `${slug} is not in the dex`);
});

test('a stat the other side is not allowed to touch', options, () => {
  const player = fixed(PIKACHU, 50);
  player.ability = 'clear-body';
  const battle = fight(player, punchbag());

  // The other side cannot, but its own moves still can.
  assert.equal(battle.applyStage(battle.player, 'atk', -1, []), false);
  assert.equal(battle.applyStage(battle.player, 'atk', -1, [], { source: 'self' }), true);
  assert.equal(battle.applyStage(battle.player, 'atk', 1, []), true);
});

test('Contrary reads every change the other way round', options, () => {
  const player = fixed(PIKACHU, 50);
  player.ability = 'contrary';
  const battle = fight(player, punchbag());

  battle.applyStage(battle.player, 'atk', -1, []);
  assert.equal(battle.player.stages.atk, 1);

  // And Simple reads every one twice as far.
  player.ability = 'simple';
  battle.player.stages.atk = 0;
  battle.applyStage(battle.player, 'atk', 1, [], { source: 'self' });
  assert.equal(battle.player.stages.atk, 2);
});

test('Defiant answers a drop and Unaware ignores the lot', options, () => {
  const player = fixed(PIKACHU, 50);
  player.ability = 'defiant';
  const battle = fight(player, punchbag());
  battle.applyStage(battle.player, 'def', -1, []);
  assert.equal(battle.player.stages.atk, 2);

  // Unaware reads the other side's stages as zero.
  const blind = fixed(PIKACHU, 50, ['thunderbolt']);
  blind.ability = 'unaware';
  const foe = fixed(GEODUDE, 70);
  const second = fight(blind, foe);
  const move = moveOf('thunderbolt');
  const plain = second.computeDamage(second.player, /** @type {any} */ (second.foe), move).damage;
  second.foe.stages.spd = 6;
  assert.equal(second.computeDamage(second.player, /** @type {any} */ (second.foe), move).damage, plain);
});

test('taking something down is worth a stage', options, () => {
  const player = fixed(PIKACHU, 90, ['thunderbolt']);
  player.ability = 'moxie';
  const battle = fight(player, [fixed(GEODUDE, 5), fixed(GEODUDE, 5)]);

  while (battle.running && battle.turn < 20) battle.takeTurn();
  assert.ok(battle.player.stages.atk > 0, 'Moxie should have paid for the knockout');
});

test('a Protean becomes what it is about to use', options, () => {
  const player = fixed(PIKACHU, 50, ['tackle']);
  player.ability = 'protean';
  const battle = fight(player, punchbag());

  assert.deepEqual(battle.typesOf(battle.player), ['electric']);
  battle.takeTurn();
  assert.deepEqual(battle.typesOf(battle.player), ['normal']);
});

test('a Scrappy reaches a Ghost that Normal cannot', options, () => {
  const player = fixed(PIKACHU, 50, ['tackle']);
  const gengar = fixed(94, 50);
  const battle = fight(player, gengar);
  const move = moveOf('tackle');

  assert.equal(battle.effectivenessOf(battle.player, move, /** @type {any} */ (battle.foe)), 0);
  player.ability = 'scrappy';
  assert.ok(battle.effectivenessOf(battle.player, move, /** @type {any} */ (battle.foe)) > 0);
});

test('a Truant works every other turn', options, () => {
  const player = fixed(PIKACHU, 50, ['tackle']);
  player.ability = 'truant';
  const battle = fight(player, punchbag());

  const first = battle.takeTurn();
  const second = battle.takeTurn();
  const moved = (log) => log.some((entry) => entry.kind === 'move' && entry.side === 'player');
  assert.notEqual(moved(first), moved(second), 'it should move on one turn and loaf on the other');
});

test('a Gluttony reaches for a berry early, and a Ripen doubles it', options, () => {
  const player = fixed(PIKACHU, 50);
  player.heldItem = 'liechi-berry'; // waits for a quarter
  player.ability = 'gluttony';
  const battle = fight(player, punchbag());

  player.hp = Math.floor(maxHp(player) * 0.45);
  battle.eatOneBerry(battle.player, []);
  assert.equal(player.heldItem, null, 'Gluttony should have reached at half');
  assert.equal(battle.player.stages.atk, 1);

  // A Ripen makes it worth two stages instead of one.
  const ripe = fixed(PIKACHU, 50);
  ripe.heldItem = 'liechi-berry';
  ripe.ability = 'ripen';
  const second = fight(ripe, punchbag());
  ripe.hp = Math.floor(maxHp(ripe) * 0.2);
  second.eatOneBerry(second.player, []);
  assert.equal(second.player.stages.atk, 2);
});

test('an Unnerve keeps the berry in its wrapper', options, () => {
  const player = fixed(PIKACHU, 50);
  player.heldItem = 'sitrus-berry';
  const foe = punchbag();
  foe.ability = 'unnerve';
  const battle = fight(player, foe);

  player.hp = Math.floor(maxHp(player) * 0.3);
  battle.eatOneBerry(battle.player, []);
  assert.equal(player.heldItem, 'sitrus-berry');
});

test('a Pickpocket helps itself to what touched it', options, () => {
  const player = fixed(PIKACHU, 50, ['tackle']);
  const foe = punchbag();
  foe.ability = 'pickpocket';
  foe.heldItem = null;
  player.heldItem = 'leftovers';

  const battle = fight(player, foe);
  battle.takeTurn();
  assert.equal(foe.heldItem, 'leftovers');
  assert.equal(player.heldItem, null);
});

test('the four Ruin abilities weigh on everything but their holder', options, () => {
  const player = fixed(PIKACHU, 50);
  const foe = punchbag();

  const before = fight(player, foe);
  const plain = before.stat(before.player, 'spa');
  const theirs = before.stat(/** @type {any} */ (before.foe), 'spa');

  foe.ability = 'vessel-of-ruin';
  const ruined = fight(player, foe);
  assert.equal(ruined.stat(ruined.player, 'spa'), Math.floor(plain * 0.75));
  // And not on the Pokémon carrying it.
  assert.equal(ruined.stat(/** @type {any} */ (ruined.foe), 'spa'), theirs);
});

test('the wild holds every Pokémon, not only the ones the route names', options, () => {
  const area = { id: 'test', tags: ['grass'], encounters: [{ species: 'ditto' }] };
  const companion = fixed(PIKACHU, 30);
  const rng = new Rng(4);
  const seen = new Set();
  for (let roll = 0; roll < 400; roll++) seen.add(rollWildPokemon(rng, area, companion).speciesId);
  assert.ok(seen.has(DITTO), 'the route still has its own');
  assert.ok(seen.size > 60, `only ${seen.size} species in 400 rolls`);
});

test('a stray comes at the stage its level allows, and a legendary only rarely', options, () => {
  assert.equal(devolveToLevel(6, 5), 4, 'a level-5 Charizard is a Charmander');
  assert.equal(devolveToLevel(6, 20), 5, 'at 20, a Charmeleon');
  assert.equal(devolveToLevel(6, 40), 6);
  assert.equal(devolveToLevel(134, 5), 134, 'a stone evolution has no level to be too young for');

  const rng = new Rng(9);
  const area = { id: 'test', tags: ['cave'] };
  let legends = 0;
  let suited = 0;
  const rolls = 2000;
  for (let roll = 0; roll < rolls; roll++) {
    const species = speciesOf(pickStray(rng, area, 50));
    if (species.isLegendary || species.isMythical) legends++;
    if (species.types.some((type) => ['rock', 'ground', 'dark', 'poison'].includes(type))) suited++;
  }
  assert.ok(legends / rolls < 0.02, `${legends} legendaries in ${rolls}`);
  assert.ok(suited / rolls > 0.4, 'the terrain still leans the draw');
});

test('a wild Pokémon met surfing or fishing knows it, and which, and one met on foot does not', options, () => {
  const route = /** @type {any} */ (Object.values(gameData().areas).find((area) => area.id === 'route103'));
  const water = Object.fromEntries(route.encounters.map((encounter) => [encounter.species, encounter.water ?? 0]));
  assert.equal(water.tentacool, 1, 'Tentacool is only on the water');
  assert.equal(water.poochyena, 0, 'Poochyena is only in the grass');
  assert.ok(water.wingull > 0 && water.wingull < 1, 'Wingull is met both ways');

  const companion = createPokemon(new Rng(1), PIKACHU, 20);
  const rng = new Rng(4);
  const seen = { land: 0, water: 0 };
  const tentacool = { land: 0, water: 0 };
  for (let roll = 0; roll < 3000; roll++) {
    const wild = rollWildPokemon(rng, route, companion);
    const slug = speciesOf(wild.speciesId)?.slug;
    if (slug === 'poochyena' || slug === 'mightyena') assert.ok(!wild.fromWater, 'nothing on foot is from the water');
    // A stray Tentacool from the wider Pokédex was not met on this water.
    if (slug === 'tentacool' || slug === 'tentacruel') tentacool[wild.fromWater ? 'water' : 'land']++;
    if (slug === 'wingull') seen[wild.fromWater ? 'water' : 'land']++;
    if (slug === 'wingull' || slug === 'pelipper' || slug === 'poochyena') assert.ok(!wild.fished, `${slug} is never fished`);
    if (wild.fished) assert.ok(wild.fromWater, 'what is fished is from the water');
  }
  assert.ok(tentacool.water > 10 * tentacool.land, `tentacool ${JSON.stringify(tentacool)}`);
  assert.ok(seen.land > 0 && seen.water > 0, 'a Wingull is met either way');
  assert.equal(water.magikarp, 1);
  assert.equal(route.encounters.find((encounter) => encounter.species === 'magikarp')?.fishing, 1, 'Magikarp is only fished');
  assert.ok(!route.encounters.find((encounter) => encounter.species === 'pelipper')?.fishing, 'Pelipper is only surfed');
});

test('a route meets its Pokémon about as often as the cartridge does, softened', options, () => {
  const route = /** @type {any} */ (Object.values(gameData().areas).find((area) => area.id === 'route113'));
  const share = Object.fromEntries(route.encounters.map((encounter) => [encounter.species, encounter.weight]));
  // Emerald's own slots: Spinda seven in ten, Slugma a quarter, Skarmory one in twenty.
  assert.deepEqual(share, { spinda: 70, slugma: 25, skarmory: 5 });

  // The water beside the road is met too, but walking is half the route.
  const lake = /** @type {any} */ (Object.values(gameData().areas).find((area) => area.id === 'route103'));
  const lakeShare = Object.fromEntries(lake.encounters.map((encounter) => [encounter.species, encounter.weight]));
  assert.ok(lakeShare.magikarp > 0 && lakeShare.tentacool > 0, 'the lake is still on Route 103');
  assert.equal(lakeShare.poochyena, 30, "Poochyena's 60 of the walking half");

  const rng = new Rng(5);
  const counts = new Map();
  const rolls = 20000;
  for (let roll = 0; roll < rolls; roll++) {
    const slug = speciesOf(pickSpecies(rng, route, 15))?.slug;
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  const of = (slug) => (counts.get(slug) ?? 0) / rolls;
  // The square roots of 70, 25 and 5, as shares: 54, 32 and 14.
  assert.ok(Math.abs(of('spinda') - 0.54) < 0.02, `spinda ${of('spinda')}`);
  assert.ok(Math.abs(of('skarmory') - 0.14) < 0.02, `skarmory ${of('skarmory')}`);
});

test('the same wild Pokémon twice running is drawn again', options, () => {
  const route = /** @type {any} */ (Object.values(gameData().areas).find((area) => area.id === 'route113'));
  const companion = fixed(PIKACHU, 15);
  const rng = new Rng(8);
  const spinda = /** @type {number} */ (speciesIdBySlug('spinda'));
  let again = 0;
  const rolls = 5000;
  for (let roll = 0; roll < rolls; roll++) {
    if (rollWildPokemon(rng, route, companion, spinda).speciesId === spinda) again++;
  }
  // A Spinda is 0.7 x 0.54, about 38 in a hundred; after a Spinda it has to
  // come up twice, about 14.
  assert.ok(again / rolls < 0.2, `${again} Spinda after a Spinda in ${rolls}`);
});

test('a move learned since the last look is new until the move list is opened, and listed first', options, async () => {
  const { noteLearnedMoves, movesByRecency } = await import('../../app/renderer/engine/pokemon.mjs');
  const { experienceForLevel } = await import('../../app/renderer/engine/stats.mjs');
  const charmander = createPokemon(new Rng(3), 4, 5);
  // Met today: nothing it knows is new.
  assert.deepEqual(charmander.newMoves, []);

  charmander.experience = experienceForLevel(speciesOf(4).growthRate, 20);
  noteLearnedMoves(charmander, []);
  const equipped = new Set(charmander.moves.map((slot) => slot.move));
  const learnedSince = (speciesOf(4).learnset.level ?? []).filter(([at]) => at > 5 && at <= 20).map(([, move]) => move);
  const waiting = learnedSince.filter((move) => !equipped.has(move));
  assert.ok(waiting.length > 0, 'a level-20 Charmander has learned something since 5');
  assert.deepEqual([...charmander.newMoves].sort(), [...new Set(waiting)].sort());

  // The newest is at the top of the list.
  const listed = movesByRecency(charmander, []);
  assert.equal(listed[0], learnedSince.at(-1));
  // And a second look finds nothing new that was not new before.
  noteLearnedMoves(charmander, []);
  assert.deepEqual([...charmander.newMoves].sort(), [...new Set(waiting)].sort());
});

test('the box has no limit, and favourites keep its top rows in the order they were marked', options, () => {
  const mons = [1, 4, 7, 25, 133].map((id) => fixed(id, 5));
  const session = new Session({ slot: 0, save: { seed: 1, party: { active: fixed(152, 5), box: mons.slice() } } });
  const order = () => session.box.map((pokemon) => pokemon?.speciesId ?? null);

  // A hundred and fifty more still find room.
  for (let index = 0; index < 150; index++) assert.equal(session.storeInBox(fixed(10, 2)), true);
  assert.equal(session.boxFull, false);
  session.box = session.box.slice(0, 5);

  session.toggleFavorite(3); // Pikachu first
  session.toggleFavorite(4); // then Eevee
  assert.deepEqual(order(), [25, 133, 1, 4, 7]);
  assert.ok(session.box[0]?.favorite && session.box[1]?.favorite);
  // Unmarked, it goes back to the first space after the favourites.
  session.toggleFavorite(0);
  assert.deepEqual(order(), [133, 25, 1, 4, 7]);
  assert.equal(session.box[1]?.favorite, undefined);
  // A new catch takes the first free space after the favourites.
  session.box[2] = null;
  session.storeInBox(fixed(39, 5));
  assert.deepEqual(order(), [133, 25, 39, 4, 7]);
});

test('the box sorts by Pokédex number, by who has beaten the League or by shininess, either way round, favourites always first', options, () => {
  const make = (id, champion = false, favorite = false) => {
    const pokemon = fixed(id, 5);
    if (champion) pokemon.champion = true;
    if (favorite) pokemon.favorite = true;
    return pokemon;
  };
  const box = [make(25), null, make(7, true), make(150, false, true), make(1), make(133, true), null, make(4, true, true)];
  const session = new Session({ slot: 0, save: { seed: 1, party: { active: fixed(152, 5), box } } });
  const order = () => session.box.map((pokemon) => pokemon?.speciesId ?? null);

  session.sortBox('dex');
  assert.deepEqual(order(), [4, 150, 1, 7, 25, 133], 'favourites first, then by number, gaps gone');
  session.sortBox('dex', true);
  assert.deepEqual(order(), [150, 4, 133, 25, 7, 1]);
  session.sortBox('clear');
  assert.deepEqual(order(), [4, 150, 7, 133, 1, 25], 'champions in number order, then the rest');
  session.sortBox('clear', true);
  assert.deepEqual(order(), [150, 4, 1, 25, 7, 133], 'the rest first, then the champions, each in number order');
  session.box.find((pokemon) => pokemon?.speciesId === 133).shiny = true;
  session.box.find((pokemon) => pokemon?.speciesId === 25).shiny = true;
  session.box.find((pokemon) => pokemon?.speciesId === 1).shiny = false;
  session.box.find((pokemon) => pokemon?.speciesId === 7).shiny = false;
  session.sortBox('shiny');
  assert.deepEqual(order(), [4, 150, 25, 133, 1, 7], 'favourites, then the shiny ones, then the rest, each in number order');
  session.sortBox('shiny', true);
  assert.deepEqual(order(), [4, 150, 1, 7, 25, 133], 'turned round, the rest first, still in number order');
  // And the order is remembered with the run.
  assert.deepEqual(session.toSave().boxSort, { key: 'shiny', reverse: true });
  const reloaded = new Session({ slot: 0, save: session.toSave() });
  assert.deepEqual(reloaded.boxSort, { key: 'shiny', reverse: true });
});

test('the shop sells all but the unique, prices a trainer\'s prize, and a kept item is had once', options, async () => {
  const { alreadyOwned, buy, isConsumable, lossFor, oneAtATime, priceOf, prizeFor, shopStock } = await import('../../app/renderer/engine/shop.mjs');
  const session = new Session({ slot: 0, save: { seed: 1, party: { active: fixed(4, 20), box: [] } } });
  assert.equal(session.money, 3000, 'a journey starts with the games\' 3,000');

  assert.equal(priceOf('potion'), 200);
  assert.equal(priceOf('master-ball'), 100000, 'a Master Ball is sold, dearly');
  assert.equal(priceOf('red-orb'), null, 'a legendary\'s own item is not sold');
  assert.ok(shopStock().length > 300);

  // A potion is bought by the dozen; a Leftovers once.
  assert.equal(isConsumable('potion'), true);
  assert.equal(isConsumable('leftovers'), false);
  assert.equal(buy(session, 'potion', 5), 'bought');
  assert.equal(session.countOf('potion'), 5);
  assert.equal(session.money, 2000);
  session.money = 50000;
  assert.equal(buy(session, 'leftovers', 3), 'bought');
  assert.equal(session.countOf('leftovers'), 1);
  assert.equal(buy(session, 'leftovers'), 'owned');
  // Handed to the companion, it is still had.
  session.removeItem('leftovers');
  session.active.heldItem = 'leftovers';
  assert.equal(alreadyOwned(session, 'leftovers'), true);
  // One a Pokémon in the box holds stays there with it.
  session.active.heldItem = null;
  session.storeInBox(fixed(1, 5));
  /** @type {any} */ (session.box.find(Boolean)).heldItem = 'leftovers';
  assert.equal(alreadyOwned(session, 'leftovers'), false);
  assert.equal(buy(session, 'leftovers'), 'bought');

  // Whatever a Pokémon evolves by is kept, held or used: a Metal Coat stays
  // in the Steelix's hand, and a Fire Stone goes back in the bag.
  assert.equal(isConsumable('fire-stone'), false);
  assert.equal(isConsumable('metal-coat'), false);
  assert.equal(isConsumable('razor-claw'), false);
  assert.equal(isConsumable('oval-stone'), false);
  session.money = 100000;
  assert.equal(buy(session, 'metal-coat', 3), 'bought');
  assert.equal(session.countOf('metal-coat'), 1);
  assert.equal(buy(session, 'metal-coat'), 'owned');
  assert.equal(buy(session, 'fire-stone', 3), 'bought');
  assert.equal(session.countOf('fire-stone'), 1);
  assert.equal(buy(session, 'fire-stone'), 'owned');

  // The misc pocket holds one of everything, even what a battle uses up; the
  // other pockets are supplies, stocked by the dozen.
  assert.equal(isConsumable('focus-sash'), true);
  assert.equal(oneAtATime('focus-sash'), true);
  assert.equal(buy(session, 'focus-sash', 3), 'bought');
  assert.equal(session.countOf('focus-sash'), 1);
  assert.equal(buy(session, 'focus-sash'), 'owned');
  session.addItem('focus-sash', 4);
  assert.equal(session.countOf('focus-sash'), 1, 'however it arrives');
  assert.equal(oneAtATime('potion'), false);
  assert.equal(oneAtATime('oran-berry'), false);
  assert.equal(oneAtATime('poke-ball'), false);
  session.money = 100;
  assert.equal(buy(session, 'super-potion'), 'poor');

  // Forty a level of the last Pokémon; losing costs by level and badges.
  assert.equal(prizeFor([fixed(1, 8), fixed(1, 12)], 'trainer'), 480);
  session.money = 10000;
  assert.equal(lossFor(session), 8 * 20);
});

test('the best berry halves a 4× weakness, then heals, then halves a 2× one, then raises a stat', options, async () => {
  const { bestBerry, restockBerry } = await import('../../app/renderer/engine/items.mjs');
  const charmander = fixed(4, 50); // Fire: weak to Water, Ground and Rock
  const charizard = fixed(6, 50); // Fire/Flying: four times weak to Rock
  const bag = (held) => /** @type {any} */ ({
    countOf: (slug) => (held.includes(slug) ? 1 : 0),
    pocket: (pocket) => held
      .filter((slug) => itemOf(slug)?.pocket === pocket)
      .map((slug) => ({ slug, count: 1, item: itemOf(slug) })),
    removeItem: () => {},
    itemPolicy: { autoBerry: true },
  });

  assert.equal(bestBerry(bag([]), charmander), null, 'nothing in the bag, nothing held');
  // A 4× weakness beats even a Sitrus.
  assert.equal(bestBerry(bag(['sitrus-berry', 'charti-berry']), charizard), 'charti-berry');
  // A Sitrus beats a 2× resist.
  assert.equal(bestBerry(bag(['sitrus-berry', 'passho-berry']), charmander), 'sitrus-berry');
  // A 2× resist beats an Oran at level 50, and a pinch berry.
  assert.equal(bestBerry(bag(['oran-berry', 'passho-berry', 'salac-berry']), charmander), 'passho-berry');
  assert.equal(bestBerry(bag(['oran-berry', 'salac-berry']), charmander), 'oran-berry');
  // A resist berry for a type it is not weak to is never held.
  assert.equal(bestBerry(bag(['occa-berry']), charmander), null);

  // Handed over only when the hand is empty and the setting is on.
  charmander.heldItem = null;
  assert.equal(restockBerry(bag(['sitrus-berry']), charmander), 'sitrus-berry');
  assert.equal(charmander.heldItem, 'sitrus-berry');
  assert.equal(restockBerry(bag(['oran-berry']), charmander), null, 'already holding one');
  charmander.heldItem = null;
  const off = bag(['sitrus-berry']);
  off.itemPolicy.autoBerry = false;
  assert.equal(restockBerry(off, charmander), null);

  // The player's own order comes first, and the automatic pick only fills in
  // when none of its berries is in the bag.
  const ranked = bag(['sitrus-berry', 'salac-berry']);
  ranked.itemPolicy.berries = ['oran-berry', 'salac-berry', null];
  assert.equal(restockBerry(ranked, charmander), 'salac-berry');
  charmander.heldItem = null;
  const fallback = bag(['sitrus-berry']);
  fallback.itemPolicy.berries = ['oran-berry', null, null];
  assert.equal(restockBerry(fallback, charmander), 'sitrus-berry');
  // And the order still works with the switch off.
  charmander.heldItem = null;
  const manual = bag(['salac-berry']);
  manual.itemPolicy = { autoBerry: false, berries: ['salac-berry', null, null] };
  assert.equal(restockBerry(manual, charmander), 'salac-berry');
});

test('the recommended restock order heals, then halves a weakness, then raises a stat', options, async () => {
  const { recommendedBerries } = await import('../../app/renderer/engine/items.mjs');
  const charmander = fixed(4, 50); // Fire: weak to Water, Ground and Rock
  const bag = (held) => /** @type {any} */ ({ countOf: (slug) => (held.includes(slug) ? 1 : 0) });
  const kindOf = (slug) => itemOf(slug)?.held ?? {};

  const [heal, resist, pinch] = recommendedBerries(bag([]), charmander);
  assert.ok(kindOf(heal).heal, `${heal} heals`);
  assert.ok(['water', 'ground', 'rock'].includes(kindOf(resist).moveType), `${resist} halves a weakness`);
  assert.ok(kindOf(pinch).stat, `${pinch} raises a stat`);

  // What the bag holds wins over what it does not, within each kind.
  assert.deepEqual(recommendedBerries(bag(['shuca-berry', 'oran-berry', 'salac-berry']), charmander),
    ['oran-berry', 'shuca-berry', 'salac-berry']);
  // A resist berry for a type it is not weak to is never offered.
  assert.notEqual(recommendedBerries(bag(['occa-berry']), charmander)[1], 'occa-berry');
});

test('an early road trainer sends out one Pokémon, no higher than the companion and no further evolved', options, async () => {
  const { readFile } = await import('node:fs/promises');
  const raw = JSON.parse(await readFile(new URL('../../data/authored/trainer-classes.json', import.meta.url), 'utf8'));
  const classes = Array.isArray(raw) ? raw : raw.classes;
  const areas = Object.values(gameData().areas);
  const rng = new Rng(21);
  for (let roll = 0; roll < 600; roll++) {
    const level = [5, 7, 10, 13][roll % 4];
    const companion = fixed(PIKACHU, level);
    const { party } = rollTrainer(rng, areas[roll % areas.length], companion, classes);
    // A Bug Catcher's two at level 5 was a two-on-one the starter lost as often as not.
    if (level <= 7) assert.equal(party.length, 1, `${party.length} at level ${level}`);
    else assert.ok(party.length <= 2);
    for (const pokemon of party) {
      const own = levelOf(pokemon);
      assert.ok(own <= level, `a level ${own} against a level ${level}`);
      // The type pool holds final stages; a level-6 Emboar should be a Tepig.
      assert.equal(devolveToLevel(pokemon.speciesId, own), pokemon.speciesId, `${speciesOf(pokemon.speciesId)?.slug} at ${own}`);
    }
  }
});

test('Paradoxes and Ultra Beasts are as rare as the legendaries, and none of them a stray', options, () => {
  // PokeAPI flags none of them, so they walked the road as often as a Dratini.
  for (const slug of ['great-tusk', 'iron-valiant', 'nihilego', 'poipole', 'articuno', 'mewtwo', 'mew']) {
    assert.ok(isRare(speciesOf(/** @type {number} */ (speciesIdBySlug(slug)))), `${slug} is rare`);
  }
  assert.ok(!isRare(speciesOf(PIKACHU)));

  const rng = new Rng(3);
  const area = { id: 'test', tags: ['grass'] };
  const rolls = 20000;
  let rare = 0;
  for (let roll = 0; roll < rolls; roll++) {
    const species = speciesOf(pickStray(rng, area, 60));
    if (isRare(species)) rare++;
  }
  // They come on a clock of their own (rare.mjs), never as a stray.
  assert.equal(rare, 0, `${rare} rare strays in ${rolls}`);

  // And they are not what an ordinary trainer of their type sends out.
  for (const id of typePool({ tags: ['grass'] }, ['fairy', 'fighting', 'bug', 'steel'])) {
    assert.ok(!isRare(speciesOf(id)), `${speciesOf(id)?.slug} in a trainer's pool`);
  }
});
