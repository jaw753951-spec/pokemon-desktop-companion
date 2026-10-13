/**
 * The formes a battle can change between, and the moments they change in.
 *
 * Every test here runs against the real generated dex, so a forme the pipeline
 * stopped carrying (a slug renamed at the source, a species dropped) is a
 * failing assertion rather than a battle that silently wears no shape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { gameData, spriteKey } from '../../app/renderer/core/data.mjs';
import { Battle } from '../../app/renderer/engine/battle.mjs';
import { formeFor, FORM_ABILITY, heldForme, settleHeldForme } from '../../app/renderer/engine/forms.mjs';
import { abilityName } from '../../app/renderer/engine/abilities.mjs';
import { moveOf } from '../../app/renderer/core/data.mjs';
import { createPokemon, maxHp, setMove } from '../../app/renderer/engine/pokemon.mjs';
import { defaultAutoBattle } from '../../app/renderer/engine/session.mjs';
import { WEATHER } from '../../app/renderer/engine/field.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

const CASTFORM = 351;
const DARMANITAN = 555;
const WISHIWASHI = 746;
const MINIOR = 774;
const MIMIKYU = 778;
const EISCUE = 875;
const CRAMORANT = 845;
const GEODUDE = 74;
const OGERPON = 1017;

/** A Pokémon with settled genes, the ability the test asks for, and fixed IVs. */
function fixed(speciesId, level, moves = [], ability = null) {
  const pokemon = createPokemon(new Rng(1), speciesId, level, { ivFloor: 31, shiny: false, hiddenAbility: true });
  pokemon.nature = 'hardy';
  if (moves.length) {
    pokemon.moves = [];
    moves.forEach((move, index) => setMove(pokemon, index, move));
  }
  // A hidden-ability draw is the only way a Zen Mode or a Forecast comes out
  // of the roll; a named ability keeps the test honest even where the pool
  // differs.
  if (ability) pokemon.ability = ability;
  pokemon.hp = maxHp(pokemon);
  return pokemon;
}

/** A battle whose player is the given Pokémon and whose foe never fights back. */
function fight(player, extra = {}) {
  return new Battle({
    rng: new Rng(11),
    player,
    foes: [fixed(GEODUDE, 20, ['defense-curl'])],
    policy: defaultAutoBattle(),
    ...extra,
  });
}

/** The state formeFor reads, for a combatant in no particular condition. */
const state = (battle, combatant, over = {}) => ({
  current: combatant.marks.forme ?? null,
  weather: battle.weatherFor(combatant),
  weatherTurns: battle.field.weatherTurns,
  overhp: combatant.pokemon.hp,
  maxhp: combatant.maxHp,
  broken: Boolean(combatant.marks.formeBroken),
  usedMove: combatant.lastMove,
  ...over,
});

test('every forme-changing species the engine knows is one the pipeline carried', options, () => {
  const species = gameData().species;
  for (const [slug, ability] of FORM_ABILITY) {
    const entry = Object.values(species).find((candidate) => candidate.slug === slug);
    assert.ok(entry, `${slug} is not in the dex`);
    assert.ok(
      entry.abilities.some((slot) => slot.name === ability),
      `${slug} cannot have ${ability} in this dex`,
    );
    assert.ok(entry.forms.length, `${slug} ships no alternate forme`);
    for (const form of entry.forms) {
      assert.ok(gameData().sprites[entry.id]?.[`art-form-${form.slug}`], `${slug} has no picture for ${form.slug}`);
    }
  }
});

test('Forecast wears one shape per weather and none without', options, () => {
  const castform = fixed(CASTFORM, 50, [], 'forecast');
  const battle = fight(castform);

  const form = (weather) => {
    battle.field.setWeather(weather, 5);
    battle.evaluateFormes([]);
    return battle.player.marks.forme;
  };

  assert.equal(form(WEATHER.SUN), 'castform-sunny');
  assert.equal(form(WEATHER.RAIN), 'castform-rainy');
  assert.equal(form(WEATHER.SNOW), 'castform-snowy');
  // No weather at all, and the species' own shape comes back — marked as no
  // forme, which is also why walking in under a clear sky announces nothing.
  assert.equal(form(null), null);
  // And the types moved with the shape: a sunny Castform is a Fire type.
  battle.field.setWeather(WEATHER.SUN, 5);
  battle.evaluateFormes([]);
  assert.deepEqual(battle.typesOf(battle.player), ['fire']);
});

test('Zen Mode takes hold below half and lets go above it', options, () => {
  const darmanitan = fixed(DARMANITAN, 50, [], 'zen-mode');
  const battle = fight(darmanitan);

  assert.equal(battle.player.marks.forme ?? null, null);
  assert.equal(spriteKey(battle.player.pokemon), `${DARMANITAN}`);

  const max = maxHp(darmanitan);
  darmanitan.hp = Math.floor(max / 2);
  battle.evaluateFormes([]);
  assert.equal(battle.player.marks.forme, 'darmanitan-zen');
  assert.equal(spriteKey(battle.player.pokemon), `${DARMANITAN}:darmanitan-zen`);
  // The forme carries its own stats, and they are traded, not stacked: the
  // zen bird is the special one, the plain one the physical hitter.
  const zenAttack = battle.stat(battle.player, 'atk');

  darmanitan.hp = max - 1;
  battle.evaluateFormes([]);
  assert.equal(battle.player.marks.forme ?? null, null, 'back to the ordinary shape above half');
  assert.ok(zenAttack < battle.stat(battle.player, 'atk'), 'zen is the special forme, plain hits harder');
});

test('Schooling scatters below a quarter, Shields Down opens below half', options, () => {
  const wishiwashi = fixed(WISHIWASHI, 50, [], 'schooling');
  const battle = fight(wishiwashi);

  // Walked in above a quarter: together. Beaten below it: scattered.
  assert.equal(battle.player.marks.forme, 'wishiwashi-school');
  wishiwashi.hp = Math.floor(maxHp(wishiwashi) / 4);
  battle.evaluateFormes([]);
  assert.equal(battle.player.marks.forme ?? null, null, 'scattered below a quarter');

  wishiwashi.hp = maxHp(wishiwashi) - 1;
  battle.evaluateFormes([]);
  assert.equal(battle.player.marks.forme, 'wishiwashi-school');

  const minior = fixed(MINIOR, 50, [], 'shields-down');
  const meteor = fight(minior);
  assert.equal(meteor.player.marks.forme ?? null, null, 'the meteor is the start');
  minior.hp = Math.floor(maxHp(minior) / 2);
  meteor.evaluateFormes([]);
  assert.equal(meteor.player.marks.forme, 'minior-red');
});

test('a Disguise shatters on the first hit and takes no damage with it', options, () => {
  const mimikyu = fixed(MIMIKYU, 50, ['tackle'], 'disguise');
  const geodude = fixed(GEODUDE, 20, ['rock-throw']);
  const battle = new Battle({ rng: new Rng(11), player: mimikyu, foes: [geodude], policy: null });

  // The foe's first move at the Mimikyu: the disguise takes it.
  const log = [];
  battle.foe.pokemon.moves = [];
  setMove(battle.foe.pokemon, 0, 'rock-throw');
  battle.player.stages.eva = 0;
  for (let turn = 0; turn < 1 && battle.running; turn++) log.push(...battle.takeTurn());

  assert.equal(battle.player.marks.formeBroken, true, 'the bust was marked');
  assert.ok(
    log.some((entry) => entry.kind === 'formBroken' && entry.side === 'player'),
    'the shattering was announced',
  );
  assert.equal(battle.player.marks.forme, 'mimikyu-busted');

  // And it never un-busts, however healthy it sits afterwards.
  mimikyu.hp = maxHp(mimikyu);
  battle.evaluateFormes([]);
  assert.equal(battle.player.marks.forme, 'mimikyu-busted');
});

test('an Ice Face comes off the same way', options, () => {
  const eiscue = fixed(EISCUE, 50, ['tackle'], 'ice-face');
  const battle = new Battle({
    rng: new Rng(11),
    player: eiscue,
    foes: [fixed(GEODUDE, 20, ['rock-throw'])],
    policy: null,
  });

  const log = [];
  for (let turn = 0; turn < 1 && battle.running; turn++) log.push(...battle.takeTurn());

  assert.equal(battle.player.marks.formeBroken, true);
  assert.equal(battle.player.marks.forme, 'eiscue-noice');
  assert.ok(log.some((entry) => entry.kind === 'formBroken'));
});

test('Gulp Missile catches something on Surf and spits it at the next hit', options, () => {
  const cramorant = fixed(CRAMORANT, 50, ['surf'], 'gulp-missile');
  // A foe that takes a Surf twice and never hits back.
  const battle = fight(cramorant, { foes: [fixed(9, 80, ['defense-curl'])] });

  // Walked in with nothing caught: the bird's own shape, marked plain.
  battle.evaluateFormes([]);
  assert.equal(battle.player.marks.forme ?? null, null);

  // Above half it comes up with an Arrokuda, and keeps it through a turn of
  // doing something else.
  battle.takeTurn();
  assert.equal(battle.player.marks.forme, 'cramorant-gulping');
  battle.player.lastMove = 'tackle';
  battle.evaluateFormes([]);
  assert.equal(battle.player.marks.forme, 'cramorant-gulping');

  // The next hit it takes gets the catch back: a quarter of the attacker's
  // health and a Defense drop, and the bird is itself again.
  const attacker = battle.foe;
  const before = attacker.pokemon.hp;
  const guard = attacker.stages.def;
  battle.answerHit(attacker, battle.player, moveOf('tackle'), 5, 1, []);
  assert.equal(before - attacker.pokemon.hp, Math.floor(attacker.maxHp / 4));
  assert.equal(attacker.stages.def, guard - 1);
  assert.equal(battle.player.marks.forme ?? null, null);
  assert.equal(spriteKey(cramorant), `${CRAMORANT}`);

  // At half health or below the catch is a Pikachu, and it paralyses.
  cramorant.hp = Math.floor(maxHp(cramorant) / 2);
  battle.player.marks.gulp = null;
  battle.takeTurn();
  assert.equal(battle.player.marks.forme, 'cramorant-gorging');
  battle.answerHit(battle.foe, battle.player, moveOf('tackle'), 5, 1, []);
  assert.equal(battle.foe.pokemon.status, 'par');
});

test('a forme that left never sticks: the revert is a change like any other', options, () => {
  const darmanitan = fixed(DARMANITAN, 50, [], 'zen-mode');
  const battle = fight(darmanitan);

  const log = [];
  darmanitan.hp = Math.floor(maxHp(darmanitan) / 2);
  battle.evaluateFormes(log);
  darmanitan.hp = maxHp(darmanitan);
  battle.evaluateFormes(log);

  assert.equal(battle.player.marks.forme ?? null, null);
  assert.equal(
    log.filter((entry) => entry.kind === 'formChanged' && entry.side === 'player').length,
    2,
    'in and back out again',
  );
});

test('a forme the dex does not carry answers null rather than crashing', options, () => {
  const castform = fixed(CASTFORM, 50, [], 'forecast');
  // Hail is a weather no Castform wears a shape for.
  const wanted = formeFor(castform, {
    current: null,
    weather: 'sandstorm',
    weatherTurns: 3,
    overhp: maxHp(castform),
    maxhp: maxHp(castform),
    broken: false,
    usedMove: null,
  });
  assert.equal(wanted, 'castform');
});

test('an Ogerpon wears the mask it holds: its type, its ability, its Ivy Cudgel', options, () => {
  const ogerpon = fixed(OGERPON, 50, ['ivy-cudgel']);
  ogerpon.heldItem = 'wellspring-mask';
  settleHeldForme(ogerpon);
  assert.equal(ogerpon.forme, 'ogerpon-wellspring-mask', 'worn outside a battle too');
  assert.equal(abilityName(ogerpon), 'water-absorb');

  const battle = fight(ogerpon);
  assert.deepEqual(battle.typesOf(battle.player), ['grass', 'water']);
  const cudgel = battle.effectiveMove(battle.player, battle.foe, moveOf('ivy-cudgel'));
  assert.equal(cudgel.type, 'water');
  assert.equal(battle.heldDamage(battle.player, moveOf('ivy-cudgel'), 1), 1.2, 'a fifth more on every move');

  // Taken off, it is the Teal Mask again, with its own ability and Grass alone.
  ogerpon.heldItem = null;
  settleHeldForme(ogerpon);
  assert.equal(ogerpon.forme, undefined);
  assert.equal(abilityName(ogerpon), ogerpon.ability);
  assert.equal(heldForme(ogerpon), null);
  const bare = fight(ogerpon);
  assert.deepEqual(bare.typesOf(bare.player), ['grass']);
  assert.equal(bare.effectiveMove(bare.player, bare.foe, moveOf('ivy-cudgel')).type, 'grass');
});

test('a mask does nothing for anyone but Ogerpon', options, () => {
  const geodude = fixed(GEODUDE, 50, ['tackle']);
  geodude.heldItem = 'hearthflame-mask';
  settleHeldForme(geodude);
  assert.equal(geodude.forme, undefined);
  const battle = fight(geodude);
  assert.equal(battle.heldDamage(battle.player, moveOf('tackle'), 1), 1);
});

test('an Ogerpon is met in any of its four masks', options, () => {
  const rng = new Rng(3);
  const seen = new Set();
  for (let roll = 0; roll < 80; roll++) {
    const ogerpon = createPokemon(rng, OGERPON, 50);
    seen.add(ogerpon.heldItem);
    assert.equal(ogerpon.forme, heldForme(ogerpon)?.forme, 'the forme matches the mask');
  }
  assert.deepEqual([...seen].sort(), [null, 'cornerstone-mask', 'hearthflame-mask', 'wellspring-mask'].sort());
});
