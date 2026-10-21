import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { gameData } from '../../app/renderer/core/data.mjs';
import { pocketOrder } from '../../app/renderer/engine/bagorder.mjs';
import { EVOLUTION_PRICE, machinePrice, priceOf } from '../../app/renderer/engine/shop.mjs';

const ready = await useRealGameData();
const withData = { skip: ready ? false : NEEDS_ASSETS };

/** Every item of a pocket, in the order the bag lists it. */
const listed = (pocket) => Object.entries(gameData().items)
  .filter(([, item]) => item.pocket === pocket)
  .map(([slug, item]) => ({ slug, item }))
  .sort(pocketOrder(pocket))
  .map((entry) => entry.slug);

test('machines are listed by kind and number, not as text', withData, () => {
  const order = listed('machines');
  const at = (slug) => order.indexOf(slug);
  assert.ok(at('tm09') < at('tm10') && at('tm22') < at('tm23') && at('tm99') < at('tm100'));
  assert.ok(at('tm100') > at('tm23'), 'TM100 comes after TM23, not between TM10 and TM11');
  const firstTr = order.find((slug) => slug.startsWith('tr'));
  assert.ok(at('tm229') < at('hm01') && at('hm08') < at(firstTr ?? ''), 'TMs, then HMs, then TRs');
});

test('the misc pocket puts anyone’s items first, one Pokémon’s together, evolution last', withData, () => {
  const order = listed('misc');
  const at = (slug) => order.indexOf(slug);
  // Anyone's, then one Pokémon's, then evolving only.
  assert.ok(at('leftovers') < at('light-ball'));
  assert.ok(at('light-ball') < at('thunder-stone'));
  assert.ok(at('linking-cord') > at('leftovers'), 'the Linking Cord goes with the evolution items');
  // A King's Rock is held for its flinch, and stays among the held items.
  assert.ok(at('kings-rock') < at('light-ball'));
  // Items for one Pokémon sit side by side.
  const together = (slugs) => {
    const places = slugs.map(at).sort((a, b) => a - b);
    assert.equal(places[places.length - 1] - places[0], slugs.length - 1, `${slugs.join(', ')} should be adjacent`);
  };
  together(['adamant-orb', 'adamant-crystal']);
  together(['red-nectar', 'yellow-nectar', 'pink-nectar', 'purple-nectar']);
  together(['cracked-pot', 'chipped-pot']);
});

test('plates, drives and memories close the misc pocket, each set together in type order', withData, () => {
  const order = listed('misc');
  const plates = ['flame-plate', 'splash-plate', 'zap-plate', 'meadow-plate', 'icicle-plate', 'fist-plate', 'toxic-plate', 'earth-plate',
    'sky-plate', 'mind-plate', 'insect-plate', 'stone-plate', 'spooky-plate', 'draco-plate', 'dread-plate', 'iron-plate', 'pixie-plate'];
  const drives = ['burn-drive', 'douse-drive', 'shock-drive', 'chill-drive'];
  const memories = ['fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground', 'flying', 'psychic', 'bug', 'rock',
    'ghost', 'dragon', 'dark', 'steel', 'fairy'].map((type) => `${type}-memory`);
  const sets = [...plates, ...drives, ...memories];
  // Arceus's, then Genesect's, then Silvally's, by the Pokédex — the last of the pocket.
  assert.deepEqual(order.slice(-sets.length), sets);
});

test('medicine, berries and balls go kind by kind, weakest first', withData, () => {
  const before = (order, ...slugs) => {
    for (let index = 1; index < slugs.length; index++) {
      assert.ok(order.indexOf(slugs[index - 1]) < order.indexOf(slugs[index]), `${slugs[index - 1]} before ${slugs[index]}`);
    }
  };
  before(listed('medicine'), 'potion', 'super-potion', 'hyper-potion', 'max-potion', 'full-restore', 'antidote', 'full-heal',
    'ether', 'max-elixir', 'pp-up', 'pp-max', 'exp-candy-xs', 'exp-candy-xl',
    'rare-candy', 'ability-capsule', 'ability-patch', 'adamant-mint', 'bold-mint', 'timid-mint',
    'serious-mint');
  before(listed('berries'), 'oran-berry', 'sitrus-berry', 'lum-berry', 'leppa-berry', 'occa-berry', 'roseli-berry',
    'liechi-berry', 'custap-berry', 'kee-berry', 'silver-razz-berry');
  before(listed('pokeballs'), 'poke-ball', 'great-ball', 'ultra-ball', 'master-ball', 'quick-ball', 'level-ball');
});

test('only the TRs with a move no TM teaches are carried', withData, () => {
  const items = gameData().items;
  const tmMoves = new Set(Object.keys(items).filter((slug) => /^(tm|hm)\d+$/.test(slug)).map((slug) => items[slug].move));
  const trs = Object.keys(items).filter((slug) => /^tr\d+$/.test(slug));
  assert.ok(trs.length > 0 && trs.length < 20, `${trs.length} TRs`);
  for (const slug of trs) assert.ok(!tmMoves.has(items[slug].move), `${slug} teaches ${items[slug].move}, which a TM does`);
});

test('TMs cost more the harder their move hits, and evolution items at least a vitamin', withData, () => {
  assert.equal(machinePrice('swords-dance'), 20000);
  assert.equal(machinePrice('thunderbolt'), 40000);
  assert.equal(machinePrice('hyper-beam'), 50000);
  assert.equal(priceOf('thunder-stone'), EVOLUTION_PRICE);
  assert.ok((priceOf('metal-coat') ?? 0) >= EVOLUTION_PRICE);
  assert.equal(priceOf('safari-ball'), null, 'the Safari Ball is not carried');
});
