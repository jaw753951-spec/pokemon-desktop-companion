/**
 * The round of changes that moved badges onto the Pokémon that won them, kept
 * a league challenge across a step out to prepare, put every catch at level 5,
 * folded the Sweets into one, gave an Alcremie a random look, took effort out,
 * and handed a battle's used-up items back afterwards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { ALCREMIE_LOOKS } from '../../app/shared/alcremie.mjs';
import { artOf, gameData, speciesIdBySlug } from '../../app/renderer/core/data.mjs';
import { Battle } from '../../app/renderer/engine/battle.mjs';
import { restoreHeldItem } from '../../app/renderer/engine/items.mjs';
import {
  CAUGHT_LEVEL,
  createPokemon,
  evolveInto,
  levelOf,
  maxHp,
  resetToLevel,
  setMove,
  statsOf,
} from '../../app/renderer/engine/pokemon.mjs';
import { defaultAutoBattle, leagueOpen, Session } from '../../app/renderer/engine/session.mjs';
import { rollWildPokemon } from '../../app/renderer/engine/encounter.mjs';
import { buildParty, resolveLeague } from '../../app/renderer/scenes/league.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

const id = (slug) => /** @type {number} */ (speciesIdBySlug(slug));

function fixed(speciesId, level, moves = []) {
  const pokemon = createPokemon(new Rng(1), speciesId, level, { ivFloor: 31, shiny: false });
  pokemon.nature = 'hardy';
  pokemon.ability = 'no-ability';
  pokemon.heldItem = null;
  if (moves.length) {
    pokemon.moves = [];
    moves.forEach((move, index) => setMove(pokemon, index, move));
  }
  pokemon.hp = maxHp(pokemon);
  return pokemon;
}

const sessionOf = (active, box = []) => new Session({ slot: 0, save: { seed: 1, party: { active, box } } });

test('badges and the champion title belong to the Pokémon that won them', options, () => {
  const session = sessionOf(fixed(4, 30), [fixed(7, 30)]);
  session.badges = ['rock', 'water', 'electric', 'fire', 'psychic', 'ice', 'dragon', 'dark'];
  assert.equal(leagueOpen(session), true);

  session.champion = true;
  assert.equal(session.active.champion, true);
  assert.equal(leagueOpen(session), false);

  // Another Pokémon walks out with nothing: no badge, no crown, no League.
  session.switchActive(0);
  assert.deepEqual(session.badges, []);
  assert.equal(session.champion, false);
  assert.equal(leagueOpen(session), false);

  // And the first one still has all of it in the box.
  assert.equal(session.box[0]?.badges?.length, 8);
  assert.equal(session.box[0]?.champion, true);
});

test('a save from before hands its badges to the Pokémon it was travelling with', options, () => {
  const session = new Session({
    slot: 0,
    save: { seed: 1, party: { active: fixed(4, 30), box: [] }, progress: { badges: ['rock', 'water'], champion: true } },
  });
  assert.deepEqual(session.badges, ['rock', 'water']);
  assert.equal(session.champion, true);
  // Written back, nothing is lost.
  const saved = session.toSave();
  assert.deepEqual(saved.party.active.badges, ['rock', 'water']);
  assert.equal(saved.party.active.champion, true);
});

test('stepping out to prepare keeps the league and the round reached', options, () => {
  const person = (name, extra = {}) => ({ id: name, name: { ko: name, en: name }, type: 'normal', party: [], ...extra });
  const leagues = ['a', 'b', 'c', 'd'].map((region) => ({
    region,
    name: { ko: region, en: region },
    eliteFour: [person(`${region}1`), person(`${region}2`), person(`${region}3`)],
    alternates: [person(`${region}-x`), person(`${region}-y`)],
    champion: person(`${region}-champion`),
  }));
  const real = gameData().leagues;
  gameData().leagues = leagues;
  try {
    const first = sessionOf(fixed(4, 30));
    const league = resolveLeague(first);
    assert.equal(league.eliteFour.length, 4);
    assert.equal(first.leagueRun?.round, 0);
    // Rolling a league does not eat the alternates out of the shared data.
    assert.ok(leagues.every((entry) => entry.alternates.length === 2));

    first.leagueRun.round = 2;
    const saved = first.toSave();

    // A reload, or simply walking back in: the same league, the same four.
    for (let seed = 1; seed <= 8; seed++) {
      const again = new Session({ slot: 0, save: { ...saved, seed, party: { active: fixed(4, 30), box: [] } } });
      const resumed = resolveLeague(again);
      assert.equal(resumed.region, league.region);
      assert.deepEqual(resumed.eliteFour.map((member) => member.id), league.eliteFour.map((member) => member.id));
      assert.equal(again.leagueRun?.round, 2);
    }
  } finally {
    gameData().leagues = real;
  }
});

test('a league roster on file is sent out as written, not evolved to the round', options, () => {
  // Glacia's last four: Glalie, Sealeo, Glalie, Walrein. Levelling them to the
  // round made her Sealeo a second Walrein.
  const glacia = { id: 'hoenn-glacia', type: 'ice', party: [id('sealeo'), id('glalie'), id('sealeo'), id('glalie'), id('walrein')] };
  const party = buildParty(sessionOf(fixed(4, 70)), glacia, 74);
  assert.deepEqual(party.map((pokemon) => pokemon.speciesId), [id('glalie'), id('sealeo'), id('glalie'), id('walrein')]);
  assert.ok(party.every((pokemon) => levelOf(pokemon) === 74));
});

test('a Pokémon that is caught goes into the box at level 5, with the moves of that level', options, () => {
  const catch_ = fixed(id('charizard'), 60);
  assert.ok(levelOf(catch_) >= 60);
  resetToLevel(catch_, CAUGHT_LEVEL);
  assert.equal(levelOf(catch_), 5);
  assert.equal(catch_.hp, maxHp(catch_));
  assert.ok(catch_.moves.length > 0 && catch_.moves.length <= 4);
  // Nothing at level 5 could have been learnt by level 60.
  assert.ok(!catch_.moves.some((slot) => slot.move === 'blast-burn'));
  // And a wild one met below the line comes up to it.
  const small = fixed(id('pidgey'), 2);
  resetToLevel(small, CAUGHT_LEVEL);
  assert.equal(levelOf(small), 5);
});

test('there is no effort: stats are base, genes, level and nature', options, () => {
  const pokemon = fixed(id('pikachu'), 50);
  assert.equal('evs' in pokemon, false);
  const stats = statsOf(pokemon);
  assert.ok(Object.values(stats).every((value) => value > 0));
  for (const slug of ['hp-up', 'protein', 'macho-brace', 'power-anklet', 'pomeg-berry', 'fresh-start-mochi']) {
    assert.equal(gameData().items[slug], undefined, `${slug} should be gone`);
  }
});

test('the seven Sweets are one, and an Alcremie is one of seven at random', options, () => {
  const items = gameData().items;
  for (const slug of ['strawberry-sweet', 'love-sweet', 'berry-sweet', 'clover-sweet', 'flower-sweet', 'star-sweet', 'ribbon-sweet']) {
    assert.equal(items[slug], undefined);
  }
  assert.ok(items.sweet);

  const milcery = fixed(id('milcery'), 30);
  milcery.heldItem = 'sweet';
  const edges = gameData().species[id('milcery')].evolutions;
  assert.ok(edges.length > 0 && edges.every((edge) => edge.heldItem === 'sweet'));

  const looks = new Set();
  const rng = new Rng(5);
  for (let index = 0; index < 60; index++) {
    const pokemon = fixed(id('milcery'), 30);
    evolveInto(pokemon, id('alcremie'), rng);
    assert.ok(ALCREMIE_LOOKS.includes(pokemon.look), pokemon.look);
    // Every look has a picture of its own.
    assert.ok(artOf(pokemon)?.path.includes(`form-${pokemon.look}`), `${pokemon.look} has art`);
    looks.add(pokemon.look);
  }
  assert.equal(looks.size, ALCREMIE_LOOKS.length, 'all seven turn up');
  // No cream and no sweet is used twice.
  const parts = ALCREMIE_LOOKS.map((look) => look.split(/-(?=[a-z]+-sweet$)/));
  assert.equal(new Set(parts.map(([cream]) => cream)).size, 7);
  assert.equal(new Set(parts.map(([, sweet]) => sweet)).size, 7);

  // A look from the old sixty-three is re-rolled on loading.
  const stale = fixed(id('alcremie'), 30);
  stale.look = 'ruby-swirl-berry-sweet';
  assert.ok(ALCREMIE_LOOKS.includes(sessionOf(stale).active.look));

  // A save that still holds the old Sweets gets the one — one, as the bag
  // holds one of anything an evolution is made by.
  const session = sessionOf(fixed(4, 5));
  const old = new Session({ slot: 0, save: { seed: 1, party: { active: fixed(4, 5), box: [] }, bag: { 'love-sweet': 2, 'star-sweet': 1 } } });
  assert.equal(old.bag.sweet, 1);
  assert.equal(session.bag.sweet, undefined);
});

test('a Future Sight is not picked while one is on its way, nor straight after one', options, () => {
  const player = fixed(id('alakazam'), 50, ['future-sight', 'psychic']);
  const foe = fixed(id('blissey'), 100, ['defense-curl']);
  const battle = new Battle({ rng: new Rng(3), player, foes: [foe], policy: defaultAutoBattle() });

  const chosen = [];
  for (let turn = 0; turn < 12 && battle.running; turn++) {
    battle.takeTurn();
    chosen.push(battle.player.lastMove);
  }
  for (let index = 1; index < chosen.length; index++) {
    assert.ok(!(chosen[index] === 'future-sight' && chosen[index - 1] === 'future-sight'), `twice in a row at turn ${index}: ${chosen}`);
  }
  assert.ok(chosen.includes('future-sight'), 'it is still used');
});

test('rampage fatigue is one line, not two', options, () => {
  const player = fixed(id('dragonite'), 60, ['outrage']);
  const foe = fixed(id('snorlax'), 100, ['defense-curl']);
  const battle = new Battle({ rng: new Rng(11), player, foes: [foe], policy: defaultAutoBattle() });
  const log = [];
  for (let turn = 0; turn < 6; turn++) log.push(...battle.takeTurn());
  const confusions = log.filter((entry) => entry.kind === 'volatile' && entry.data?.state === 'confusion');
  assert.ok(confusions.length > 0, 'the rampage ended and confused it');
  assert.ok(confusions.every((entry) => entry.data.fatigue === true));
  assert.ok(!log.some((entry) => entry.kind === 'message' && entry.data?.key === 'move.fatigue'), 'no second line');
});

test('a used-up item comes back after the battle, but a berry eaten does not', options, () => {
  const pokemon = fixed(4, 30);
  assert.equal(restoreHeldItem(pokemon, 'focus-sash'), true);
  assert.equal(pokemon.heldItem, 'focus-sash');

  const berried = fixed(4, 30);
  assert.equal(restoreHeldItem(berried, 'sitrus-berry'), false);
  assert.equal(berried.heldItem, null);

  // Nothing is taken from a hand that is holding something.
  const holding = fixed(4, 30);
  holding.heldItem = 'leftovers';
  assert.equal(restoreHeldItem(holding, 'focus-sash'), false);
  assert.equal(holding.heldItem, 'leftovers');
});

test('the capture screen lists balls in a fixed order, Poké Ball first', options, () => {
  const session = sessionOf(fixed(4, 5));
  // The special balls are priced at nothing, which used to sort them ahead of
  // a Poké Ball picked up later.
  for (const slug of ['quick-ball', 'great-ball', 'net-ball', 'master-ball', 'ultra-ball']) session.addItem(slug);
  session.addItem('poke-ball');
  const order = session.balls().map((entry) => entry.slug);
  assert.deepEqual(order.slice(0, 4), ['poke-ball', 'great-ball', 'ultra-ball', 'master-ball']);
  assert.equal(order.length, 6);
});

test('a species already in the box is met a little less often', options, () => {
  const area = gameData().areas[0];
  const companion = fixed(4, 20);
  const count = (owned) => {
    const rng = new Rng(9);
    const seen = new Map();
    for (let index = 0; index < 4000; index++) {
      const id_ = rollWildPokemon(rng, area, companion, null, owned).speciesId;
      seen.set(id_, (seen.get(id_) ?? 0) + 1);
    }
    return seen;
  };
  const plain = count(new Set());
  const [commonest] = [...plain.entries()].sort((a, b) => b[1] - a[1])[0];
  const thinned = count(new Set([commonest]));
  const before = plain.get(commonest);
  const after = thinned.get(commonest) ?? 0;
  assert.ok(after < before, `${after} < ${before}`);
  assert.ok(after > before * 0.75, 'only slightly');
});

test('Victini is turned round to face left, as every other picture does', options, async () => {
  const { readFile } = await import('node:fs/promises');
  const { decodePng } = await import('../tools/lib/png.mjs');
  const { crop, mirrorX, opaqueBounds } = await import('../tools/lib/image.mjs');
  const { MIRRORED } = await import('../tools/build/art.mjs');
  assert.ok(MIRRORED.has(494));

  // The picture shipped is the cartridge's, cut to what is drawn and mirrored.
  const root = new URL('../../', import.meta.url);
  const drawn = decodePng(await readFile(new URL('data/vendor/pokeapi/sprites/pokemon/versions/generation-v/black-white/494.png', root)));
  const bounds = /** @type {any} */ (opaqueBounds(drawn));
  const expected = mirrorX(crop(drawn, bounds.x, bounds.y, bounds.width, bounds.height));
  const shipped = decodePng(await readFile(new URL('assets/pokemon/494/art.png', root)));
  assert.equal(shipped.width, expected.width);
  assert.deepEqual(Buffer.from(shipped.data), Buffer.from(expected.data));
});


test('catching an Ogerpon brings its three masks, once', options, () => {
  const MASKS = ['cornerstone-mask', 'hearthflame-mask', 'wellspring-mask'];
  const masksIn = (session) => MASKS.filter((mask) => session.countOf(mask) > 0);
  const ogerpon = id('ogerpon');

  const session = sessionOf(fixed(4, 30));
  assert.deepEqual(session.handOverOgerponMasks(), [], 'nothing before an Ogerpon is caught');
  session.storeInBox(fixed(ogerpon, 5));
  assert.deepEqual(session.handOverOgerponMasks().sort(), MASKS);
  assert.deepEqual(masksIn(session), MASKS);
  // A second Ogerpon brings no second set.
  session.storeInBox(fixed(ogerpon, 5));
  assert.deepEqual(session.handOverOgerponMasks(), []);

  // A mask in a Pokémon's hand counts as had, wherever it is.
  const masked = fixed(ogerpon, 5);
  masked.heldItem = 'wellspring-mask';
  const saved = new Session({ slot: 0, save: { seed: 1, party: { active: fixed(4, 30), box: [masked] }, dex: { caught: [ogerpon] } } });
  assert.deepEqual(masksIn(saved), ['cornerstone-mask', 'hearthflame-mask'], 'a save that caught one is given the rest on loading');
});
