/**
 * Both sides going down at once, judged as the games are from Black and
 * White on: whichever went down last has won.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { Battle } from '../../app/renderer/engine/battle.mjs';
import { createPokemon, maxHp, setMove } from '../../app/renderer/engine/pokemon.mjs';
import { defaultAutoBattle } from '../../app/renderer/engine/session.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

const CHARIZARD = 6;
const BLASTOISE = 9;

/**
 * A Pokémon with nothing on it that could tip the result — no ability, no
 * item — on so many hit points.
 */
function fixed(speciesId, level, moves, hp = null) {
  const pokemon = createPokemon(new Rng(1), speciesId, level, { ivFloor: 31, shiny: false });
  pokemon.nature = 'hardy';
  pokemon.ability = 'no-ability';
  pokemon.heldItem = null;
  pokemon.moves = [];
  moves.forEach((move, index) => setMove(pokemon, index, move));
  pokemon.hp = hp ?? maxHp(pokemon);
  return pokemon;
}

/** Play turns until the battle is over. */
function fight(battle) {
  const log = [];
  for (let turn = 0; turn < 10 && battle.running; turn++) log.push(...battle.takeTurn());
  return log;
}

test("the companion that takes the foe's last one down on its own recoil has won", options, () => {
  const battle = new Battle({
    rng: new Rng(3),
    player: fixed(CHARIZARD, 50, ['double-edge'], 1),
    foes: [fixed(BLASTOISE, 50, ['splash'], 1)],
    policy: defaultAutoBattle(),
  });
  const log = fight(battle);
  assert.equal(battle.player.pokemon.hp, 0, 'the recoil took it down too');
  assert.ok(log.some((entry) => entry.kind === 'faint' && entry.side === 'foe'));
  assert.ok(log.some((entry) => entry.kind === 'faint' && entry.side === 'player'));
  assert.equal(battle.outcome, 'won');
});

test('a foe with another Pokémon still to send out has won all the same', options, () => {
  const battle = new Battle({
    rng: new Rng(3),
    player: fixed(CHARIZARD, 50, ['double-edge'], 1),
    foes: [fixed(BLASTOISE, 50, ['splash'], 1), fixed(BLASTOISE, 50, ['splash'])],
    policy: defaultAutoBattle(),
  });
  fight(battle);
  assert.equal(battle.outcome, 'lost');
});

test('an Explosion that takes the last one with it is lost: its user went down first', options, () => {
  const battle = new Battle({
    rng: new Rng(3),
    player: fixed(CHARIZARD, 50, ['explosion']),
    foes: [fixed(BLASTOISE, 50, ['splash'], 1)],
    policy: defaultAutoBattle(),
  });
  fight(battle);
  assert.equal(battle.foe, null, 'the blast took the foe down');
  assert.equal(battle.player.pokemon.hp, 0);
  assert.equal(battle.outcome, 'lost');
});

test("and a foe's Explosion that takes the companion with it is won", options, () => {
  const battle = new Battle({
    rng: new Rng(3),
    player: fixed(CHARIZARD, 50, ['splash'], 1),
    foes: [fixed(BLASTOISE, 50, ['explosion'])],
    policy: defaultAutoBattle(),
  });
  fight(battle);
  assert.equal(battle.player.pokemon.hp, 0);
  assert.equal(battle.outcome, 'won');
});

test("a foe's Destiny Bond takes the companion down after it, which wins", options, () => {
  // The foe is the faster by far, so its bond is up before the blow lands.
  const battle = new Battle({
    rng: new Rng(3),
    player: fixed(CHARIZARD, 5, ['tackle']),
    foes: [fixed(BLASTOISE, 100, ['destiny-bond'], 1)],
    policy: defaultAutoBattle(),
  });
  const log = fight(battle);
  assert.ok(log.some((entry) => entry.kind === 'move' && entry.data?.move === 'destiny-bond'));
  assert.equal(battle.player.pokemon.hp, 0, 'the bond took the companion with it');
  assert.equal(battle.outcome, 'won');
});

test('recoil is a share of the health the hit took, not of everything it rolled', options, () => {
  // A level 100 Double-Edge into a foe on 10 hit points rolls far past them;
  // a third of the roll once knocked out the user that had just won.
  const battle = new Battle({
    rng: new Rng(3),
    player: fixed(CHARIZARD, 100, ['double-edge']),
    foes: [fixed(BLASTOISE, 50, ['splash'], 10)],
    policy: defaultAutoBattle(),
  });
  const log = fight(battle);
  const recoil = log.find((entry) => entry.kind === 'damage' && entry.side === 'player' && entry.data?.recoil);
  assert.equal(recoil?.data.amount, 3, 'a third of the 10 it took');
  assert.equal(battle.player.pokemon.hp, maxHp(battle.player.pokemon) - 3);
  assert.equal(battle.outcome, 'won');
});

test('with nothing its plan allows this turn, it does not fall back on an Explosion', options, () => {
  // At full health a Rest is not wanted and the Explosion is kept for a
  // quarter; the fallback once took the hardest hit left, which was the
  // Explosion, and lost the battle with the foe's team still to come.
  const battle = new Battle({
    rng: new Rng(3),
    player: fixed(CHARIZARD, 100, ['rest', 'explosion']),
    foes: [fixed(BLASTOISE, 70, ['splash']), fixed(BLASTOISE, 70, ['splash'])],
    policy: { ...defaultAutoBattle(), moves: { rest: 'hpThird', explosion: 'hpQuarter' }, second: {} },
    trainerBattle: true,
  });
  assert.equal(battle.chooseMove(battle.player, battle.foe), 'rest');
});
