import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { gameData, itemOf } from '../../app/renderer/core/data.mjs';
import { berryToHold, healAfterBattle, healingItemFor, healingItems } from '../../app/renderer/engine/items.mjs';
import { defaultItemPolicy, normalizeItemPolicy } from '../../app/renderer/engine/session.mjs';
import { createPokemon, maxHp, maxPp, TRADE_ITEM } from '../../app/renderer/engine/pokemon.mjs';

const ready = await useRealGameData();
const withData = { skip: ready ? false : NEEDS_ASSETS };
import { assignRarityTiers } from '../tools/build/items.mjs';
import { BALL_TIERS } from '../tools/sources.mjs';
import { RETIRED_MOVES } from '../tools/build/dex.mjs';

/** @param {Partial<any>} overrides */
function item(overrides = {}) {
  return {
    name: { ko: '테스트', en: 'Test' },
    pocket: 'medicine',
    category: 'healing',
    cost: 100,
    attributes: [],
    sprite: true,
    ...overrides,
  };
}

/** Build `count` items in one pocket with increasing cost. */
function pocketOf(prefix, pocket, count) {
  /** @type {Record<string, any>} */
  const items = {};
  for (let index = 0; index < count; index++) {
    items[`${prefix}${index}`] = item({ pocket, cost: (index + 1) * 100 });
  }
  return items;
}

test('every tier but the Master Ball\'s gets items, cheapest first', () => {
  const tiers = assignRarityTiers(pocketOf('m', 'medicine', 100));
  // 60 / 25 / 15 split of a hundred items.
  assert.equal(tiers['poke-ball'].length, 60);
  assert.equal(tiers['great-ball'].length, 25);
  assert.equal(tiers['ultra-ball'].length, 15);
  assert.equal(tiers['master-ball'].length, 0);

  assert.ok(tiers['poke-ball'].includes('m0'), 'the cheapest item is common');
  assert.ok(tiers['ultra-ball'].includes('m99'), 'the priciest item is as rare as the cut goes');
});

test('the Master Ball\'s pool is the Master Ball alone', () => {
  const tiers = assignRarityTiers({
    ...pocketOf('m', 'medicine', 100),
    'master-ball': item({ pocket: 'pokeballs', cost: 100000 }),
    'poke-ball': item({ pocket: 'pokeballs', cost: 200 }),
  });
  assert.deepEqual(tiers['master-ball'], ['master-ball']);
});

test('each pocket is split independently so no tier is monopolised', () => {
  const tiers = assignRarityTiers({
    ...pocketOf('m', 'medicine', 100),
    ...pocketOf('b', 'held-items', 20),
  });
  const rarest = tiers['ultra-ball'];
  assert.ok(rarest.some((name) => name.startsWith('m')), 'medicine reaches the rarest tier the cut makes');
  assert.ok(rarest.some((name) => name.startsWith('b')), 'a second pocket reaches it too');
});

test('a berry never comes out of a ball on the road', () => {
  const tiers = assignRarityTiers({ ...pocketOf('m', 'medicine', 10), ...pocketOf('b', 'berries', 10) });
  assert.ok(!Object.values(tiers).flat().some((name) => name.startsWith('b')));
});

test('the shop\'s price ranks an item, not the record\'s', () => {
  // PokeAPI's records carry no cost: every item at nothing used to be cut by name.
  const items = pocketOf('m', 'medicine', 100);
  for (const entry of Object.values(items)) entry.cost = 0;
  const prices = new Map(Object.keys(items).map((name, index) => [name, (100 - index) * 100]));
  const tiers = assignRarityTiers(items, {}, prices);
  assert.ok(tiers['ultra-ball'].includes('m0'), 'the dearest in the shop is the rarest');
  assert.ok(tiers['poke-ball'].includes('m99'), 'the cheapest is common');
});

test('items at one price are found in one tier', () => {
  // Fifty-two at 100, then twenty at 500 across the 60% cut — eight short of
  // it, twelve past — then the rest dearer.
  const items = pocketOf('m', 'medicine', 100);
  Object.keys(items).forEach((name, index) => {
    items[name].cost = index < 52 ? 100 : index < 72 ? 500 : 1000 + index;
  });
  const tiers = assignRarityTiers(items);
  const tierOf = (/** @type {string} */ name) => BALL_TIERS.findIndex((tier) => tiers[tier.ball].includes(name));
  const tied = Object.keys(items).slice(52, 72).map(tierOf);
  assert.equal(new Set(tied).size, 1, 'the twenty at 500 share a tier');
  assert.equal(tied[0], 1, 'the one most of them fell in');
});

test('every Mint is as easy to find as every other', withData, () => {
  /** @type {Record<string, string[]>} */
  const itemTiers = JSON.parse(readFileSync(new URL('../../data/generated/item-tiers.json', import.meta.url), 'utf8'));
  const mints = Object.keys(gameData().items).filter((slug) => slug.endsWith('-mint'));
  assert.equal(mints.length, 21);
  const tierOf = (/** @type {string} */ slug) => Object.keys(itemTiers).find((ball) => itemTiers[ball].includes(slug));
  assert.equal(new Set(mints.map(tierOf)).size, 1);
});

test('a one-item pocket still lands somewhere', () => {
  const tiers = assignRarityTiers({ only: item({ pocket: 'misc' }) });
  const placements = BALL_TIERS.filter((tier) => tiers[tier.ball].includes('only'));
  assert.equal(placements.length, 1, 'the item appears in exactly one tier');
});

test('undroppable items are excluded', () => {
  const tiers = assignRarityTiers({
    keyItem: item({ pocket: 'key' }),
    artless: item({ sprite: false }),
    englishOnly: item({ name: { ko: 'Test', en: 'Test' } }),
    plate: item({ category: 'plates' }),
    fine: item({ pocket: 'misc' }),
  });
  const all = Object.values(tiers).flat();
  assert.deepEqual(all, ['fine']);
});

test('TMs are ranked by the move they teach', () => {
  const moves = {
    tackle: { damageClass: 'physical', power: 40, accuracy: 100 },
    'hyper-beam': { damageClass: 'special', power: 150, accuracy: 90 },
    'swords-dance': { damageClass: 'status', power: null, accuracy: null },
  };
  /** @type {Record<string, any>} */
  const items = {};
  for (const move of Object.keys(moves)) {
    items[`tm-${move}`] = item({ pocket: 'machines', category: 'all-machines', cost: 0, move });
  }

  const tiers = assignRarityTiers(items, moves);
  const tierOf = (name) => BALL_TIERS.findIndex((tier) => tiers[tier.ball].includes(name));
  assert.ok(
    tierOf('tm-hyper-beam') > tierOf('tm-tackle'),
    'a stronger move makes for a rarer TM',
  );
  assert.ok(tierOf('tm-swords-dance') >= 0, 'status TMs are still droppable');
});

test('a TR is found on the road only when it teaches what no TM does', () => {
  const moves = {
    tackle: { damageClass: 'physical', power: 40, accuracy: 100 },
    megahorn: { damageClass: 'physical', power: 120, accuracy: 85 },
  };
  const tiers = assignRarityTiers({
    tm01: item({ pocket: 'machines', category: 'all-machines', cost: 0, move: 'tackle' }),
    tr01: item({ pocket: 'machines', category: 'all-machines', cost: 0, move: 'tackle' }),
    tr02: item({ pocket: 'machines', category: 'all-machines', cost: 0, move: 'megahorn' }),
  }, moves);
  const all = Object.values(tiers).flat();
  assert.ok(all.includes('tr02'), 'a Megahorn record has no TM to stand in for it');
  assert.ok(!all.includes('tr01'), 'a Tackle record does');
});

// --------------------------------------------------------- stated effects

test('an item the engine reads states what it does', withData, () => {
  const items = gameData().items;

  // An evolution can name an item to hold as well as one to use, and a King's
  // Rock is filed under held items rather than under evolution.
  // The Linking Cord is what a trade evolution is given in its place.
  const evolutionItems = new Set([TRADE_ITEM]);
  for (const entry of Object.values(gameData().species)) {
    for (const evolution of entry.evolutions ?? []) {
      if (evolution.item) evolutionItems.add(evolution.item);
      if (evolution.heldItem) evolutionItems.add(evolution.heldItem);
      for (const held of evolution.heldItems ?? []) evolutionItems.add(held);
    }
  }

  // Everything marked as working has a rule the engine can follow — a use
  // effect, a held one, a charm kept in the bag, a key item leading to a rare
  // Pokémon, an evolution, or a pocket that is its own effect.
  for (const [slug, item] of Object.entries(items)) {
    if (!item.works) continue;
    const explained =
      item.use || item.held || item.capture || item.charm || item.calls || item.pocket === 'pokeballs' || item.pocket === 'machines' || evolutionItems.has(slug);
    assert.ok(explained, `${slug} claims to work with nothing behind it`);
  }

  // The three the game leans on, read off their own effect text rather than
  // guessed at from a description.
  assert.deepEqual(items['potion'].use, { hp: 20 });
  assert.deepEqual(items['max-potion'].use, { hp: 'full' });
  assert.deepEqual(items['ether'].use, { pp: { amount: 10, scope: 'one' } });
});

test('only what this game will never have is dropped', withData, () => {
  const items = gameData().items;

  // Form changes, crafting, cooking, a story, a town — and the Exp. Share,
  // which splits experience between party members this game does not have.
  for (const slug of ['exp-share', 'venusaurite', 'red-apricorn', 'escape-rope', 'amulet-coin']) {
    assert.equal(items[slug], undefined, `${slug} should have been dropped`);
  }

  // Everything that acts on something the save carries stays, whether or not
  // the engine reads it yet.
  for (const slug of ['poke-ball', 'tm01', 'fire-stone', 'metal-coat', 'oran-berry', 'rare-candy',
    'leftovers', 'choice-band', 'charcoal', 'focus-sash', 'lucky-egg']) {
    assert.ok(items[slug]?.works, `${slug} should be working`);
  }

  // The ones that were kept against the day the engine could read them, and
  // now can be: a Mint's nature, a Capsule's ability, a PP Up's ceiling, a
  // Bottle Cap's genes, a type-resisting Berry, a Light Ball's one species.
  for (const slug of ['ability-capsule', 'adamant-mint', 'pp-up', 'occa-berry', 'bottle-cap', 'light-ball',
    'rocky-helmet', 'safety-goggles', 'toxic-orb', 'weakness-policy', 'heat-rock', 'everstone', 'red-card',
    'golden-razz-berry', 'silver-razz-berry']) {
    assert.ok(items[slug]?.works, `${slug} should be working`);
  }

  // Every item carried is one the engine reads.
  assert.deepEqual(Object.keys(items).filter((slug) => !items[slug].works), []);

  // And a held item that does nothing for a companion fighting alone — one
  // for switching out, running away, or a system this game does not have —
  // is not carried at all.
  for (const slug of ['eject-button', 'eject-pack', 'shed-shell', 'smoke-ball', 'ring-target', 'pass-orb']) {
    assert.equal(items[slug], undefined, `${slug} should have been dropped`);
  }

  // One generation's copy of something the bag already has is not carried —
  // a Casteliacone is a Full Heal, a Health Mochi a vitamin — while the thing
  // it copies is.
  // Nothing stays fainted here, so nothing brings a Pokémon back.
  for (const slug of ['revive', 'max-revive', 'casteliacone', 'fresh-water', 'sacred-ash', 'mighty-candy-xl',
    'dynamax-candy', 'sea-incense', 'blank-plate', 'fire-gem', 'enigma-berry', 'figy-berry', 'aguav-berry']) {
    assert.equal(items[slug], undefined, `${slug} should have been dropped`);
  }
  for (const slug of ['full-heal', 'super-potion', 'mystic-water', 'silk-scarf', 'sitrus-berry',
    'silver-razz-berry', 'golden-razz-berry', 'exp-candy-s']) {
    assert.ok(items[slug], `${slug} should still be carried`);
  }

  // Effort is trained by the vitamins, the feathers and the mochi, earned
  // faster with a Macho Brace or a Power item, and undone by six berries and
  // the Fresh-Start Mochi; the Let's Go candies, which train it under another
  // name, stay out. The seven Sweets are the one Sweet.
  for (const slug of ['hp-up', 'protein', 'health-wing', 'health-mochi', 'macho-brace', 'power-bracer', 'pomeg-berry', 'fresh-start-mochi']) {
    assert.ok(items[slug], `${slug} should be carried`);
  }
  for (const slug of ['strawberry-sweet', 'love-sweet', 'ribbon-sweet']) {
    assert.equal(items[slug], undefined, `${slug} should have been dropped`);
  }
  assert.ok(items.sweet, 'the Sweet should be carried');
});

/**
 * Just enough of a session for the bag helpers: a pocket to read and a count
 * to check. The helpers touch nothing else.
 *
 * @param {Record<string, number>} bag
 */
function fakeSession(bag) {
  return /** @type {any} */ ({
    bag,
    countOf: (slug) => bag[slug] ?? 0,
    removeItem: (slug) => {
      bag[slug] -= 1;
      if (bag[slug] <= 0) delete bag[slug];
    },
    pocket: (pocket) =>
      Object.entries(bag)
        .filter(([slug]) => itemOf(slug)?.pocket === pocket)
        .map(([slug, count]) => ({ slug, count, item: itemOf(slug) })),
  });
}

test('healing items are offered weakest first, and only while they would help', withData, () => {
  const pokemon = createPokemon(new Rng(1), 6, 50, { ivFloor: 31 });
  const session = fakeSession({ potion: 3, 'super-potion': 2, 'max-potion': 1, antidote: 1 });

  pokemon.hp = maxHp(pokemon);
  assert.deepEqual(healingItems(session, pokemon), [], 'nothing to heal');

  pokemon.hp = 1;
  const offered = healingItems(session, pokemon).map((entry) => entry.slug);
  // A Potion restores 20 and a Super Potion 60, so they sort that way; the
  // Antidote cures a status and is not a healing item at all.
  assert.deepEqual(offered, ['potion', 'super-potion', 'max-potion']);
});

test('the automatic throw takes the smallest potion that covers the damage', withData, () => {
  const pokemon = createPokemon(new Rng(1), 6, 50, { ivFloor: 31 });
  const session = fakeSession({ potion: 3, 'super-potion': 2, 'max-potion': 1 });

  pokemon.hp = maxHp(pokemon) - 15;
  assert.equal(healingItemFor(session, pokemon, null), 'potion');

  pokemon.hp = maxHp(pokemon) - 50;
  assert.equal(healingItemFor(session, pokemon, null), 'super-potion');

  // Hurt worse than anything on hand covers: the biggest heal is the answer.
  pokemon.hp = 1;
  assert.equal(healingItemFor(session, pokemon, null), 'max-potion');

  // A named item is used whether or not it covers the damage, and only if the
  // bag still has one.
  assert.equal(healingItemFor(session, pokemon, 'potion'), 'potion');
  assert.equal(healingItemFor(session, pokemon, 'full-restore'), null);
});

test('a win tops the companion up to full, smallest potion first', withData, () => {
  const pokemon = createPokemon(new Rng(1), 6, 50, { ivFloor: 31 });
  const session = fakeSession({ potion: 5, 'super-potion': 2, 'max-potion': 1 });

  // Fifteen short: one Potion closes it, and nothing bigger is touched.
  pokemon.hp = maxHp(pokemon) - 15;
  assert.deepEqual(healAfterBattle(session, pokemon, 'full'), [{ slug: 'potion', count: 1 }]);
  assert.equal(pokemon.hp, maxHp(pokemon));
  assert.equal(session.bag['super-potion'], 2);

  // At full already, the bag is left alone.
  assert.deepEqual(healAfterBattle(session, pokemon, 'full'), []);
  assert.equal(session.bag.potion, 4);
});

test('a top-up to full cures the condition too, with the narrowest cure', withData, () => {
  const pokemon = createPokemon(new Rng(1), 6, 50, { ivFloor: 31 });
  const session = fakeSession({ antidote: 1, 'full-heal': 1, 'full-restore': 1 });
  pokemon.status = 'psn';
  assert.deepEqual(healAfterBattle(session, pokemon, 'full'), [{ slug: 'antidote', count: 1 }]);
  assert.equal(pokemon.status, null);

  // A burn has no Antidote; the Full Heal goes before the Full Restore.
  pokemon.status = 'brn';
  assert.deepEqual(healAfterBattle(session, pokemon, 'full'), [{ slug: 'full-heal', count: 1 }]);

  // Left to itself, only a full top-up does it; the switch decides
  // otherwise, whatever the health target.
  pokemon.status = 'par';
  pokemon.hp = maxHp(pokemon) - 1;
  healAfterBattle(session, pokemon, 'hpHalf');
  assert.equal(pokemon.status, 'par');
  pokemon.hp = maxHp(pokemon);
  healAfterBattle(session, pokemon, 'full', { status: false });
  assert.equal(pokemon.status, 'par');
  assert.deepEqual(healAfterBattle(session, pokemon, 'never', { status: true }), [{ slug: 'full-restore', count: 1 }]);
  assert.equal(pokemon.status, null);
});

test('a top-up puts PP back into a move run low, one Ether at a time, when asked', withData, () => {
  const pokemon = createPokemon(new Rng(1), 6, 50, { ivFloor: 31 });
  const session = fakeSession({ ether: 2, elixir: 1 });
  const full = maxPp(pokemon.moves[0]);

  // A little spent is left alone, and nothing happens with the switch off.
  pokemon.moves[0].pp = full - 1;
  assert.deepEqual(healAfterBattle(session, pokemon, 'never', { pp: true }), []);
  pokemon.moves[0].pp = 0;
  assert.deepEqual(healAfterBattle(session, pokemon, 'never', { pp: false }), []);
  assert.equal(pokemon.moves[0].pp, 0);

  // Run dry: an Ether, on that move alone.
  const used = healAfterBattle(session, pokemon, 'never', { pp: true });
  assert.equal(used[0].slug, 'ether');
  assert.ok(pokemon.moves[0].pp > full / 4);
  assert.equal(session.countOf('elixir'), 1, 'the Elixir is kept while there are Ethers');
});

test('a top-up stops at the target the player set, and never is never', withData, () => {
  const pokemon = createPokemon(new Rng(1), 6, 50, { ivFloor: 31 });
  const max = maxHp(pokemon);
  const session = fakeSession({ potion: 20 });

  pokemon.hp = 1;
  assert.deepEqual(healAfterBattle(session, pokemon, 'never'), []);
  assert.equal(pokemon.hp, 1);

  healAfterBattle(session, pokemon, 'hpHalf');
  assert.ok(pokemon.hp >= max / 2, `healed to ${pokemon.hp} of ${max}`);
  // A Potion at a time, so it lands within one Potion past the half.
  assert.ok(pokemon.hp < max / 2 + 20, `overshot to ${pokemon.hp} of ${max}`);
});

test('a top-up spends what the bag has when it cannot reach the target', withData, () => {
  const pokemon = createPokemon(new Rng(1), 6, 50, { ivFloor: 31 });
  const session = fakeSession({ potion: 2 });

  pokemon.hp = 1;
  assert.deepEqual(healAfterBattle(session, pokemon, 'full'), [{ slug: 'potion', count: 2 }]);
  assert.equal(pokemon.hp, 41);
  assert.equal(session.countOf('potion'), 0);
});

test('the after-battle top-up defaults to full, for new and old saves alike', () => {
  assert.equal(defaultItemPolicy().afterBattle, 'full');
  assert.equal(normalizeItemPolicy(null).afterBattle, 'full');
  // A save written before the setting existed.
  assert.equal(normalizeItemPolicy({ berries: [], healing: { item: null, condition: 'hpHalf' } }).afterBattle, 'full');
  assert.equal(normalizeItemPolicy({ afterBattle: 'hpHalf' }).afterBattle, 'hpHalf');
});

test('the three ranks and the automatic berry are kept side by side', () => {
  assert.equal(defaultItemPolicy().autoBerry, true);
  assert.deepEqual(defaultItemPolicy().berries, [null, null, null]);
  assert.equal(normalizeItemPolicy(null).autoBerry, true);
  // A save from before the switch keeps its order and takes the default.
  const old = normalizeItemPolicy({ berries: ['sitrus-berry'] });
  assert.deepEqual(old.berries, ['sitrus-berry', null, null]);
  assert.equal(old.autoBerry, true);
  assert.equal(normalizeItemPolicy({ autoBerry: false }).autoBerry, false);
});

test('an unset restock rank is skipped, and an empty order holds nothing', withData, () => {
  const session = fakeSession({ 'sitrus-berry': 1 });
  assert.equal(berryToHold(session, [null, 'oran-berry', 'sitrus-berry']), 'sitrus-berry');
  assert.equal(berryToHold(session, [null, null, null]), null);
  assert.equal(berryToHold(session, ['oran-berry']), null);
});

test('every item the bag can hold says what it is, in Korean as well as English', withData, () => {
  const blank = [];
  const borrowed = [];
  for (const [slug, entry] of Object.entries(gameData().items)) {
    // A machine is described by the move it teaches.
    if (entry.pocket === 'machines') continue;
    if (!entry.text?.ko || !entry.text?.en) blank.push(slug);
    else if (entry.text.ko === entry.text.en) borrowed.push(slug);
  }
  assert.deepEqual(blank, [], 'items with no description');
  assert.deepEqual(borrowed, [], 'items whose Korean description is the English one');
});

test('every move says what it does in Korean, not in English', withData, () => {
  const blank = [];
  const borrowed = [];
  for (const [slug, move] of Object.entries(gameData().moves)) {
    // Colosseum's Shadow moves and the Starmobiles' torques, which the dex
    // build leaves out.
    if (move.type === 'shadow' || RETIRED_MOVES.has(slug)) continue;
    if (!move.text?.ko) blank.push(slug);
    else if (move.text.ko === move.text.en || !/[가-힣]/.test(move.text.ko)) borrowed.push(slug);
  }
  assert.deepEqual(blank, [], 'moves with no Korean description');
  assert.deepEqual(borrowed, [], 'moves whose Korean description is the English one');
});

test('a Shiny Charm raises the odds on the road, is not sold, and is the first title\'s prize', withData, async () => {
  const { Session } = await import('../../app/renderer/engine/session.mjs');
  const { SHINY_ODDS, shinyOddsFor } = await import('../../app/renderer/engine/pokemon.mjs');
  const { buy, isConsumable, priceOf } = await import('../../app/renderer/engine/shop.mjs');
  const { rollWildPokemon } = await import('../../app/renderer/engine/encounter.mjs');
  const { championPrize } = await import('../../app/renderer/scenes/league.mjs');

  const session = new Session({ slot: 0, save: { seed: 1, party: { active: createPokemon(new Rng(1), 6, 50), box: [] } } });
  assert.equal(session.shinyOdds, SHINY_ODDS);
  assert.equal(championPrize(session), 'shiny-charm');

  // Not for sale; kept for good once won.
  assert.equal(priceOf('shiny-charm'), null);
  session.money = 9_000_000;
  assert.equal(buy(session, 'shiny-charm'), 'unsold');
  assert.equal(isConsumable('shiny-charm'), false);
  // Kept in the key pocket, where it does its work by being there: nothing
  // to use it on, nobody to hand it to.
  const { itemActions } = await import('../../app/renderer/engine/items.mjs');
  assert.equal(itemOf('shiny-charm')?.pocket, 'key');
  assert.deepEqual(itemActions(session, 'shiny-charm'), { use: false, equip: false });

  // Won: fifteen rolls of the usual one in 4096 — about one in 274.
  session.addItem(championPrize(session));
  assert.equal(session.shinyOdds, shinyOddsFor(15));
  assert.ok(Math.abs(1 / session.shinyOdds - 274) < 2, `1 in ${Math.round(1 / session.shinyOdds)}`);
  // And the wild roll uses what it is handed.
  const area = session.area ?? { tags: ['grass'], encounters: [] };
  assert.equal(rollWildPokemon(new Rng(2), area, session.active, null, new Set(), 1).shiny, true);

  // Every title after the first pays a Master Ball.
  session.champion = true;
  assert.equal(championPrize(session), 'master-ball');
});

test('the key pocket shows the travelling Pokémon\'s own badges, the crown last', withData, async () => {
  const { Session } = await import('../../app/renderer/engine/session.mjs');
  const { badgeEntries } = await import('../../app/renderer/ui/itemstab.mjs');
  const session = new Session({ slot: 0, save: { seed: 1, party: { active: createPokemon(new Rng(1), 6, 50), box: [] } } });
  assert.deepEqual(badgeEntries(session), [], 'nothing won yet');

  // A Pokémon in the box keeps its badges to itself.
  const boxed = createPokemon(new Rng(3), 7, 30);
  boxed.badges = ['water', 'rock'];
  boxed.champion = true;
  session.storeInBox(boxed);
  assert.deepEqual(badgeEntries(session), []);

  session.badges = ['fire', 'grass'];
  session.active.champion = true;
  assert.deepEqual(badgeEntries(session).map((entry) => entry.type), ['fire', 'grass', null]);
  assert.equal(new Set(badgeEntries(session).map((entry) => entry.id)).size, 3, 'each row has its own id');
});
