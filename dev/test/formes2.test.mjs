/**
 * The holes a second look at the formes found: shapes that changed without
 * anyone seeing it, a weather a Forecast did not read, a young Wishiwashi
 * that schooled, items the bag would not offer, and moves a fusion forgot to
 * trade.
 */
import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { artOf, gameData, speciesIdBySlug, spriteKey } from '../../app/renderer/core/data.mjs';
import { Battle } from '../../app/renderer/engine/battle.mjs';
import { WEATHER } from '../../app/renderer/engine/field.mjs';
import { HELD_FORMES, SCHOOLING_LEVEL, settleForme, standingTypes } from '../../app/renderer/engine/forms.mjs';
import { formeMoveNeed, itemActions, useItem } from '../../app/renderer/engine/items.mjs';
import { availableMoves, createPokemon, evolveInto, maxHp, setMove } from '../../app/renderer/engine/pokemon.mjs';
import { defaultAutoBattle } from '../../app/renderer/engine/session.mjs';
import { battlerArt } from '../../app/renderer/render/battler.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

/** @param {string} slug @param {number} [level] @param {string[]} [moves] */
function make(slug, level = 60, moves = []) {
  const pokemon = createPokemon(new Rng(1), /** @type {number} */ (speciesIdBySlug(slug)), level, { ivFloor: 31 });
  pokemon.heldItem = null;
  settleForme(pokemon);
  if (moves.length) {
    pokemon.moves = [];
    moves.forEach((move, index) => setMove(pokemon, index, move));
  }
  pokemon.hp = maxHp(pokemon);
  return pokemon;
}

/** @param {any} player @param {any} [foe] */
function fight(player, foe = make('geodude', 20, ['defense-curl'])) {
  return new Battle({ rng: new Rng(3), player, foes: [foe], policy: defaultAutoBattle() });
}

/** @param {Record<string, number>} contents @param {any} pokemon */
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
  });
}

test('every forme looks like itself, in a picture of its own', options, () => {
  const sprites = gameData().sprites;
  for (const species of Object.values(gameData().species)) {
    for (const form of species.forms ?? []) {
      const pokemon = { speciesId: species.id, forme: form.slug };
      const art = artOf(pokemon);
      assert.match(art?.path ?? '', new RegExp(`/art-form-${form.slug}\\.png$`), `${form.slug} is drawn in its species' art`);
      // The battle, the road and the box all draw the same one.
      assert.equal(battlerArt(pokemon)?.path, art?.path);
      assert.ok(sprites[species.id][`art-form-${form.slug}`]);
    }
  }
  // A Rotom in the washer is in the washer, and a shiny one in the shiny washer.
  const wash = { speciesId: /** @type {number} */ (speciesIdBySlug('rotom')), forme: 'rotom-wash' };
  assert.match(artOf(wash)?.path ?? '', /\/art-form-rotom-wash\.png$/);
  assert.match(artOf({ ...wash, shiny: true })?.path ?? '', /\/art-form-rotom-wash-shiny\.png$/);
  // A forme only a battle puts it in has a sprite of its own too.
  const cramorant = /** @type {number} */ (speciesIdBySlug('cramorant'));
  const stood = artOf({ speciesId: cramorant, forme: 'cramorant-gulping' });
  assert.equal(stood?.meta.facing, 'left');
  const own = artOf({ speciesId: cramorant });
  assert.ok(stood && own && stood.meta.height <= own.meta.height * 2, 'no bigger than twice its own shape');
});

test('every Pokémon is one still picture, facing left as Black and White drew them', options, () => {
  const sprites = gameData().sprites;
  for (const species of Object.values(gameData().species)) {
    const entry = sprites[species.id];
    assert.ok(entry?.art, `${species.slug} has no picture`);
    // Nothing of the old sets goes out with the game — the road's halved
    // copies among them.
    for (const key of Object.keys(entry)) assert.match(key, /^(art(-female|-form-.+)?|shiny)$/, `${species.slug} ships ${key}`);
    const art = artOf({ speciesId: species.id });
    assert.equal(art?.meta.frames, 1);
    assert.equal(art?.meta.facing, 'left');
  }
});

test('a Castform in hail is snowy, as it is in snow', options, () => {
  const castform = make('castform', 50);
  castform.ability = 'forecast';
  const battle = fight(castform);
  battle.field.setWeather(WEATHER.HAIL, 5);
  battle.evaluateFormes([]);
  assert.equal(battle.player.marks.forme, 'castform-snowy');
  assert.deepEqual(battle.typesOf(battle.player), ['ice']);
});

test('a Wishiwashi schools only from level 20', options, () => {
  const young = make('wishiwashi', SCHOOLING_LEVEL - 1);
  young.ability = 'schooling';
  assert.equal(fight(young).player.marks.forme ?? null, null, 'too young to call a school');

  const grown = make('wishiwashi', SCHOOLING_LEVEL);
  grown.ability = 'schooling';
  assert.equal(fight(grown).player.marks.forme, 'wishiwashi-school');
});

test('only an Ogerpon is met holding the item that shapes it', options, () => {
  for (const slug of HELD_FORMES.keys()) {
    const id = /** @type {number} */ (speciesIdBySlug(slug));
    const held = new Set();
    for (let seed = 1; seed <= 40; seed++) held.add(createPokemon(new Rng(seed), id, 60).heldItem ?? null);
    if (slug === 'ogerpon') assert.ok(held.size > 1, 'an Ogerpon comes in its masks');
    else assert.deepEqual([...held], [null], `a ${slug} came holding ${[...held].join(', ')}`);
  }
});

test('the bag offers a nectar to an Oricorio, and to nothing else', options, () => {
  const oricorio = make('oricorio', 30);
  assert.equal(itemActions(bag({ 'pink-nectar': 1 }, oricorio), 'pink-nectar').use, true);
  assert.equal(itemActions(bag({ 'pink-nectar': 1 }, make('pikachu', 30)), 'pink-nectar').use, false);
});

test('a Ditto that copied a Disguise has no disguise to break', options, () => {
  const mimikyu = make('mimikyu', 50, ['shadow-sneak']);
  mimikyu.ability = 'disguise';
  const ditto = make('ditto', 50, ['transform']);
  ditto.ability = 'imposter';
  const battle = fight(mimikyu, ditto);
  assert.ok(battle.foe.transform, 'the Imposter took the Mimikyu’s shape');
  assert.equal(battle.abilitySlugOf(battle.foe), 'disguise');
  const tackle = { damageClass: 'physical' };
  assert.equal(battle.bustForme(battle.player, battle.foe, tackle), false);
  assert.equal(battle.bustForme(battle.foe, battle.player, tackle), true);
});

test('a Type: Null holding a memory evolves straight into that type', options, () => {
  const typeNull = make('type-null', 60);
  typeNull.heldItem = 'fire-memory';
  evolveInto(typeNull, /** @type {number} */ (speciesIdBySlug('silvally')));
  assert.equal(typeNull.forme, 'silvally-fire');
  assert.deepEqual(standingTypes(typeNull), ['fire']);
});

test('a fusion trades its moves, and parting forgets what the fusion brought', options, () => {
  const kyurem = make('kyurem', 70, ['scary-face', 'glaciate', 'dragon-pulse']);
  const splicers = bag({ 'dna-splicers': 1 }, kyurem);
  useItem(splicers, 'dna-splicers');
  assert.equal(kyurem.forme, 'kyurem-black');
  assert.deepEqual(kyurem.moves.map((slot) => slot.move), ['fusion-bolt', 'freeze-shock', 'dragon-pulse']);
  useItem(splicers, 'dna-splicers');
  assert.deepEqual(kyurem.moves.map((slot) => slot.move), ['fusion-flare', 'ice-burn', 'dragon-pulse']);
  useItem(splicers, 'dna-splicers');
  assert.equal(kyurem.forme ?? null, null);
  assert.deepEqual(kyurem.moves.map((slot) => slot.move), ['scary-face', 'glaciate', 'dragon-pulse']);

  // A Kyurem only trades: one that knows neither move gains nothing.
  const plain = make('kyurem', 70, ['dragon-pulse']);
  useItem(bag({ 'dna-splicers': 1 }, plain), 'dna-splicers');
  assert.deepEqual(plain.moves.map((slot) => slot.move), ['dragon-pulse']);

  // A Calyrex learns its steed's move, and off the steed forgets it along
  // with whatever only the rider could learn.
  const calyrex = make('calyrex', 70, ['psychic', 'giga-drain']);
  const reins = bag({ 'reins-of-unity': 1 }, calyrex);
  useItem(reins, 'reins-of-unity');
  assert.deepEqual(calyrex.moves.map((slot) => slot.move), ['psychic', 'giga-drain', 'glacial-lance']);
  setMove(calyrex, 3, 'icicle-crash');
  useItem(reins, 'reins-of-unity');
  assert.deepEqual(calyrex.moves.map((slot) => slot.move), ['psychic', 'giga-drain', 'astral-barrage', 'icicle-crash']);
  useItem(reins, 'reins-of-unity');
  assert.deepEqual(calyrex.moves.map((slot) => slot.move), ['psychic', 'giga-drain']);

  // One that knew nothing but the fusion's move remembers a Confusion.
  const lone = make('calyrex', 70, ['psychic']);
  const lonely = bag({ 'reins-of-unity': 1 }, lone);
  useItem(lonely, 'reins-of-unity');
  lone.moves = [{ move: 'glacial-lance', pp: 5, ppUp: 0 }];
  useItem(lonely, 'reins-of-unity');
  useItem(lonely, 'reins-of-unity');
  assert.deepEqual(lone.moves.map((slot) => slot.move), ['confusion']);

  // A Necrozma's Sunsteel Strike is in no learnset; the fusion is where it
  // comes from, and the move list offers it while the fusion lasts.
  const necrozma = make('necrozma', 70, ['psychic', 'x-scissor', 'rock-slide']);
  useItem(bag({ 'n-solarizer--merge': 1 }, necrozma), 'n-solarizer--merge');
  assert.equal(necrozma.forme, 'necrozma-dusk');
  assert.equal(necrozma.moves[3].move, 'sunsteel-strike');
  assert.ok(availableMoves(necrozma).includes('sunsteel-strike'));
});

test('a full moveset asks what the new move goes over, and a Rotom cannot skip it', options, () => {
  // A Calyrex with four moves may give Glacial Lance up and ride anyway…
  const calyrex = make('calyrex', 70, ['psychic', 'giga-drain', 'energy-ball', 'solar-beam']);
  const reins = bag({ 'reins-of-unity': 1 }, calyrex);
  assert.deepEqual(formeMoveNeed(reins, 'reins-of-unity'), {
    move: 'glacial-lance',
    required: false,
    moves: ['psychic', 'giga-drain', 'energy-ball', 'solar-beam'],
  });
  const gaveUp = useItem(reins, 'reins-of-unity');
  assert.equal(gaveUp.ok, true);
  assert.equal(calyrex.forme, 'calyrex-ice');
  assert.ok(!calyrex.moves.some((slot) => slot.move === 'glacial-lance'));

  // …or learn it over the move the player picked.
  const picked = make('calyrex', 70, ['psychic', 'giga-drain', 'energy-ball', 'solar-beam']);
  useItem(bag({ 'reins-of-unity': 1 }, picked), 'reins-of-unity', { forget: 1 });
  assert.deepEqual(picked.moves.map((slot) => slot.move), ['psychic', 'glacial-lance', 'energy-ball', 'solar-beam']);

  // A Rotom that will not make room stays out of the appliance.
  const rotom = make('rotom', 40, ['thunder-shock', 'thunderbolt', 'shadow-ball', 'discharge']);
  const catalog = bag({ 'rotom-catalog': 1 }, rotom);
  assert.equal(formeMoveNeed(catalog, 'rotom-catalog')?.required, true);
  assert.equal(useItem(catalog, 'rotom-catalog').ok, false);
  assert.equal(rotom.forme ?? null, null);
  assert.equal(useItem(catalog, 'rotom-catalog', { forget: 3 }).ok, true);
  assert.equal(rotom.forme, 'rotom-heat');
  assert.deepEqual(rotom.moves.map((slot) => slot.move), ['thunder-shock', 'thunderbolt', 'shadow-ball', 'overheat']);
  // The next appliance's move takes the last one's place, with no question.
  assert.equal(formeMoveNeed(catalog, 'rotom-catalog'), null);
  useItem(catalog, 'rotom-catalog');
  assert.equal(rotom.moves[3].move, 'hydro-pump');

  // Back in its own shape it forgets the appliance's move, and one that knew
  // nothing else remembers a Thunder Shock.
  rotom.standing = 'rotom-mow';
  settleForme(rotom);
  rotom.moves = [{ move: 'leaf-storm', pp: 5, ppUp: 0 }];
  useItem(catalog, 'rotom-catalog');
  assert.equal(rotom.forme ?? null, null);
  assert.deepEqual(rotom.moves.map((slot) => slot.move), ['thunder-shock']);
});

test('a variety walks in its own art, and a female in hers where her species draws one', options, () => {
  const sprites = gameData().sprites;
  // Every variety has a picture that is not its species' — but the small and
  // large Gourgeist, which no set draws.
  const artFile = (id) => {
    try {
      return readFileSync(new URL(`../../assets/pokemon/${id}/art.png`, import.meta.url));
    } catch {
      return null;
    }
  };
  for (const species of Object.values(gameData().species)) {
    if (!species.regional || ['gourgeist-small', 'gourgeist-large'].includes(species.slug)) continue;
    assert.ok(sprites[species.id]?.art, `${species.slug} has no picture`);
    const mine = artFile(species.id);
    const theirs = artFile(species.dex);
    if (mine && theirs) assert.ok(!mine.equals(theirs), `${species.slug} is drawn in its species' art`);
  }
  const jellicent = /** @type {number} */ (speciesIdBySlug('jellicent'));
  const her = { speciesId: jellicent, gender: 'female' };
  const him = { speciesId: jellicent, gender: 'male' };
  assert.match(artOf(her)?.path ?? '', /\/art-female\.png$/);
  assert.match(artOf(him)?.path ?? '', /\/art\.png$/);
  assert.notEqual(spriteKey(her), spriteKey(him), 'a battle reloads the art between the two');
  // A species drawn the same for both keeps one key.
  const geodude = /** @type {number} */ (speciesIdBySlug('geodude'));
  assert.equal(spriteKey({ speciesId: geodude, gender: 'female' }), spriteKey({ speciesId: geodude, gender: 'male' }));
});

test('a hand-drawn sheet directory is named for what it draws', options, async () => {
  const { authoredTarget } = await import('../tools/build/art.mjs');
  const species = gameData().species;
  const id = (slug) => /** @type {number} */ (speciesIdBySlug(slug));
  assert.deepEqual(authoredTarget('urshifu-rapid-strike', species), { id: id('urshifu-rapid-strike'), key: '', shiny: false });
  assert.deepEqual(authoredTarget('diglett-shiny', species), { id: id('diglett'), key: '', shiny: true });
  assert.deepEqual(authoredTarget('cramorant-gulping', species), { id: id('cramorant'), key: '-form-cramorant-gulping', shiny: false });
  assert.deepEqual(authoredTarget('darmanitan-galar-zen', species), {
    id: id('darmanitan-galar-standard'),
    key: '-form-darmanitan-galar-zen',
    shiny: false,
  });
  assert.deepEqual(authoredTarget('jellicent-female-shiny', species), { id: id('jellicent'), key: '-female', shiny: true });
  // A variety that is a Pokémon of its own is itself, not its species' female.
  assert.equal(authoredTarget('oinkologne-female', species)?.key, '');
  assert.equal(authoredTarget('not-a-pokemon', species), null);
});

test('a shiny is the same drawing in other colours, for every species and forme', options, async () => {
  const { decodePng } = await import('../tools/lib/png.mjs');
  const sprites = gameData().sprites;
  const png = (id, file) => decodePng(readFileSync(new URL(`../../assets/pokemon/${id}/${file}.png`, import.meta.url)));
  const solid = (image) => Array.from({ length: image.width * image.height }, (_, i) => image.data[i * 4 + 3] > 127);
  const drawnApart = [];
  for (const species of Object.values(gameData().species)) {
    const entry = sprites[species.id];
    for (const key of ['art', ...(species.forms ?? []).map((form) => `art-form-${form.slug}`)]) {
      assert.ok(entry?.shiny?.[key], `${species.slug} ${key}: no shiny`);
      const [plain, shiny] = [png(species.id, key), png(species.id, `${key}-shiny`)];
      if (plain.width !== shiny.width || plain.height !== shiny.height) {
        drawnApart.push(`${species.slug} ${key}`);
        continue;
      }
      const [a, b] = [solid(plain), solid(shiny)];
      const same = a.filter((value, i) => value === b[i]).length / a.length;
      if (same < 0.97) drawnApart.push(`${species.slug} ${key}`);
    }
  }
  // A handful of the community's shinies are redrawn a pixel or two apart;
  // anything more is a shiny of another drawing.
  assert.ok(drawnApart.length <= 20, `shinies of another drawing: ${drawnApart.join(', ')}`);
});
