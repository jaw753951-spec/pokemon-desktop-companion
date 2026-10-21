/**
 * The generated game data, loaded once at start-up.
 *
 * Everything here is read-only reference data — species, moves, items, areas,
 * the type chart — as opposed to the save, which holds the player's state.
 */
import { loadJson } from './bridge.mjs';
import { resolveParticles } from './korean.mjs';

/**
 * @typedef {Object} GameData
 * @property {Record<string, any>} species keyed by Pokédex number
 * @property {Record<string, any>} moves keyed by move slug
 * @property {Record<string, any>} items keyed by item slug
 * @property {Record<string, string>} machines TM slug to move slug
 * @property {Record<string, any>} natures keyed by nature slug
 * @property {Record<string, any>} abilities keyed by ability slug
 * @property {Record<string, any>} types keyed by type slug
 * @property {Array<any>} areas
 * @property {Record<string, any>} sprites keyed by Pokédex number
 * @property {Record<string, any>} actors
 * @property {{cues: Record<string, string>, tracks: Record<string, any>}} bgm
 * @property {Record<string, string[]>} itemTiers
 * @property {{backdrops: Record<string, any>, rooms: Record<string, any>, tags: Record<string, string>, badges: string[]}} battle
 * @property {Array<any>} trainerClasses
 * @property {Array<any>} leaders
 * @property {Array<any>} leagues
 * @property {{sprites?: {source: string, url: string, license: string, artists: string[]}, custom?: {source: string, url: string, license: string, artists: string[]}, trainers?: Array<{key: string, source: string, artist?: string, url: string, license: string}>}} credits who
 *   drew what the game borrows, for the credits the licence asks for
 */

/** @type {GameData|null} */
let data = null;

/** @returns {Promise<GameData>} */
export async function loadGameData() {
  if (data) return data;

  const [species, moves, items, machines, natures, abilities, types, areas, sprites, actors, bgm, itemTiers, battle] = await Promise.all([
    loadJson('data', 'species.json'),
    loadJson('data', 'moves.json'),
    loadJson('data', 'items.json'),
    loadJson('data', 'machines.json'),
    loadJson('data', 'natures.json'),
    loadJson('data', 'abilities.json'),
    loadJson('data', 'types.json'),
    loadJson('data', 'areas.json'),
    loadJson('data', 'sprites.json'),
    loadJson('data', 'actors.json'),
    loadJson('data', 'bgm.json'),
    loadJson('data', 'item-tiers.json'),
    loadJson('data', 'battle.json'),
  ]);

  // Authored data is optional: a checkout without it still runs, just without
  // trainers or the league.
  const [trainerClasses, leaders, leagues, credits, itemTexts, moveTexts, speciesTexts, abilityTexts] = await Promise.all([
    loadJson('authored', 'trainer-classes.json').then((file) => file.classes ?? []).catch(() => []),
    loadJson('authored', 'leaders.json').then((file) => file.leaders ?? []).catch(() => []),
    loadJson('authored', 'leagues.json').then((file) => file.leagues ?? []).catch(() => []),
    // Written by the art step; a build from before it has nothing to credit.
    loadJson('data', 'credits.json').catch(() => ({})),
    loadJson('authored', 'item-texts.json').then((file) => file.items ?? {}).catch(() => ({})),
    loadJson('authored', 'move-texts.json').then((file) => file.moves ?? {}).catch(() => ({})),
    loadJson('authored', 'species-texts.json').then((file) => file.species ?? {}).catch(() => ({})),
    loadJson('authored', 'ability-texts.json').then((file) => file.abilities ?? {}).catch(() => ({})),
  ]);
  mendItems(items, itemTexts);
  // Imported here rather than at the top: the engine reads this module, and
  // the formes table is only wanted once everything has loaded.
  const { signatureItems } = await import('../engine/forms.mjs');
  nameItemUsers(items, species, signatureItems());
  // Moves take the same patch: the newest ones come through with only the
  // English description, and the Korean screen showed it as it was.
  mendItems(moves, moveTexts);
  // And the Pokédex entries and abilities no official source has in Korean.
  mendItems(abilities, abilityTexts);
  mendSpecies(species, speciesTexts);

  data = {
    species, moves, items, machines, natures, abilities, types, areas, sprites, actors, bgm, itemTiers, battle,
    trainerClasses, leaders, leagues, credits,
  };
  return data;
}

/**
 * Put the authored descriptions — and the odd name — on the items PokeAPI
 * publishes without them.
 *
 * A handful of items come through with no description in any language, and
 * a few with the English one standing in for the Korean; the bag showed the
 * first as a blank panel. The authored sheet fills both in, one field at a
 * time, and names nothing that is not in the bag's data.
 *
 * @param {Record<string, any>} items
 * @param {Record<string, {name?: Record<string, string>, text?: Record<string, string>}>} authored
 */
export function mendItems(items, authored) {
  for (const [slug, patch] of Object.entries(authored ?? {})) {
    const item = items?.[slug];
    if (!item) continue;
    if (patch.text) item.text = { ...(item.text ?? {}), ...patch.text };
    if (patch.name) item.name = { ...(item.name ?? {}), ...patch.name };
  }
}

/**
 * Name the Pokémon in an evolution item's description when only one ever
 * uses it. The games' "loved by a certain Pokémon" is coy about an
 * Electirizer nothing but an Electabuzz wants, and the bag has no other way
 * of saying whose it is; an item several Pokémon use — a Fire Stone, a
 * Linking Cord — keeps its wording.
 *
 * The items that exist for one species' sake get the same: a memory "changes
 * the type of the holder if held by a certain species of Pokémon", and that
 * species is Silvally. One whose description already names its species —
 * the DNA Splicers' "certain Pokémon" is the one Kyurem fuses with — keeps
 * its wording.
 *
 * @param {Record<string, any>} items
 * @param {Record<string, any>} species
 * @param {Map<string, string[]>} [signature] item slug to the species slugs
 *   it is for, from the formes table
 */
export function nameItemUsers(items, species, signature = new Map()) {
  /** Who uses each item, by name — a regional form shares its species' name. @type {Map<string, Map<string, any>>} */
  const users = new Map();
  /** @param {string} item @param {any} entry */
  const add = (item, entry) => {
    if (!users.has(item)) users.set(item, new Map());
    users.get(item)?.set(entry.name.en ?? entry.slug, entry.name);
  };
  for (const entry of Object.values(species ?? {})) {
    for (const evolution of entry.evolutions ?? []) {
      for (const item of [evolution.item, evolution.heldItem]) {
        if (item && entry.name) add(item, entry);
      }
    }
  }
  const bySlug = new Map(Object.values(species ?? {}).map((entry) => [entry.slug, entry]));
  /** The items named for the formes table rather than for an evolution. */
  const signed = new Set();
  for (const [item, slugs] of signature) {
    for (const slug of slugs) {
      const entry = bySlug.get(slug);
      if (entry?.name) add(item, entry);
    }
    signed.add(item);
  }
  for (const [slug, named] of users) {
    const item = items?.[slug];
    if (named.size !== 1 || !item?.text) continue;
    if (item.category !== 'evolution' && !signed.has(slug)) continue;
    const [name] = named.values();
    const names = (/** @type {string} */ lang) => Boolean(name[lang] && item.text[lang]?.includes(name[lang]));
    // Not asked of an evolution item: a Magmarizer's 마그마의 에너지 is magma, not Magmar.
    if (signed.has(slug) && (names('ko') || names('en'))) continue;
    if (item.text.ko && name.ko) {
      item.text.ko = item.text.ko.replace(/(?:어느 특정|어떤|특정) 포켓몬(이|을|은|과)?(?!들)/, (_, particle) => {
        if (!particle) return name.ko;
        // A Porygon2 is read with its number: 폴리곤2(이) takes 가.
        const read = name.ko.replace(/\d$/,(digit) => DIGIT_READINGS[Number(digit)]);
        return name.ko + resolveParticles(read + KO_PARTICLES[particle]).slice(read.length);
      });
    }
    if (item.text.en && name.en) {
      item.text.en = item.text.en.replace(/(?:a )?certain (?:species of )?Pokémon/, name.en);
    }
  }
}

/** The neutral form each particle is written in, for `resolveParticles` to settle. */
const KO_PARTICLES = { 이: '이(가)', 을: '을(를)', 은: '은(는)', 과: '과(와)' };

/** How each digit is read aloud, which is what the particle after it agrees with. */
const DIGIT_READINGS = ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];

/**
 * The same patch for the Pokédex, whose records are filed by number: the
 * sheet names a species by its slug, and every record with that slug — a
 * regional variety shares its species' entry — takes it.
 *
 * @param {Record<string, any>} species
 * @param {Record<string, {name?: Record<string, string>, text?: Record<string, string>}>} authored
 */
export function mendSpecies(species, authored) {
  const bySlug = Object.fromEntries(Object.values(species ?? {}).map((entry) => [entry.slug, entry]));
  mendItems(bySlug, authored);
}

/**
 * Install a data set directly, bypassing the loader.
 *
 * The engine modules are pure functions over this data, and the unit tests
 * exercise them against the real generated JSON read from disk — which they can
 * only do if the data can be supplied without going through the preload bridge.
 *
 * @param {GameData|null} next
 */
export function setGameData(next) {
  data = next;
  slugIndex = null;
}

/** @returns {GameData} */
export function gameData() {
  if (!data) throw new Error('Game data has not been loaded yet');
  return data;
}

/** @param {number|string} id */
export const speciesOf = (id) => gameData().species[String(id)] ?? null;

/** @param {string} slug */
export const moveOf = (slug) => gameData().moves[slug] ?? null;

/** @param {string} slug */
export const itemOf = (slug) => gameData().items[slug] ?? null;

/** @param {string|null|undefined} slug */
export const abilityOf = (slug) => (slug ? gameData().abilities?.[slug] ?? null : null);

/**
 * Whether a move belongs to one of the classes the game acts on.
 *
 * Reading it through here rather than off `move.flags` keeps every caller
 * working against a save and a data file written before the classes existed,
 * where the field is simply absent.
 *
 * @param {any} move
 * @param {string} flag
 */
export const moveHasFlag = (move, flag) => Boolean(move?.flags?.includes(flag));

/**
 * The picture a Pokémon is shown in, and how big it is.
 *
 * It is the front sprite Pokémon Black and White drew — official up to
 * Genesect, drawn in the same style by the Smogon community past it — and
 * every screen draws the same one, so which of its shapes it is in picks the
 * file and nothing else does: the forme it is wearing, else the female of a
 * species whose sexes look different, else the species. A shiny Pokémon has
 * a picture of its own rather than a filter over the ordinary one; one whose
 * shiny never built falls back on the ordinary colours, silently — a missing
 * picture is worse than a missing sparkle.
 *
 * The picture is still and faces left, as the sprites do; the screens move it
 * rather than animating it, and mirror it to face right. The road draws it
 * too, at half the size a battle does, rather than a halved copy of it: a
 * 96-pixel sprite cut to half its pixels loses its outline and its face.
 *
 * @param {{speciesId: number, shiny?: boolean, forme?: string|null, look?: string, gender?: string|null}|null|undefined} pokemon
 * @returns {{path: string, meta: {width: number, height: number, frames: number, delay: number, facing: 'left'}}|null}
 */
export function artOf(pokemon) {
  if (!pokemon) return null;
  const entry = gameData().sprites[pokemon.speciesId];
  if (!entry) return null;
  const key = `art${shapeOf(pokemon, entry)}`;
  const shiny = pokemon.shiny ? entry.shiny?.[key] : null;
  const meta = shiny ?? entry[key];
  if (!meta) return null;
  return {
    path: `pokemon/${pokemon.speciesId}/${key}${shiny ? '-shiny' : ''}.png`,
    meta: { width: meta.width, height: meta.height, frames: 1, delay: 1000, facing: 'left' },
  };
}

/**
 * Which of a species' shapes a Pokémon is drawn in: `-form-<forme>`,
 * `-female`, or nothing for the species' own.
 *
 * @param {{forme?: string|null, look?: string, gender?: string|null}} pokemon
 * @param {Record<string, any>} entry
 */
function shapeOf(pokemon, entry) {
  if (pokemon.forme && entry[`art-form-${pokemon.forme}`]) return `-form-${pokemon.forme}`;
  // An Alcremie's cream and sweet.
  if (pokemon.look && entry[`art-form-${pokemon.look}`]) return `-form-${pokemon.look}`;
  if (pokemon.gender === 'female' && entry['art-female']) return '-female';
  return '';
}

/**
 * A key that changes whenever the picture would: the species, which of its
 * two palettes, and which of its shapes it is wearing.
 *
 * Screens that cache a decoded sprite keyed on the species alone would keep
 * showing the ordinary art after a swap to a shiny of the same species, which
 * is exactly the moment a player is looking for the difference — and the same
 * trap again the moment a Castform walks out of the rain.
 *
 * @param {{speciesId: number, shiny?: boolean, forme?: string|null, look?: string, gender?: string|null}|null|undefined} pokemon
 */
export const spriteKey = (pokemon) =>
  pokemon
    ? `${pokemon.speciesId}${pokemon.shiny ? ':shiny' : ''}${pokemon.forme ? `:${pokemon.forme}` : ''}${pokemon.look ? `:${pokemon.look}` : ''}${
        femaleArt(pokemon) ? ':female' : ''
      }`
    : '';

/**
 * Whether a Pokémon is drawn as a female apart from its species' art.
 *
 * @param {{speciesId: number, gender?: string|null}} pokemon
 */
const femaleArt = (pokemon) => pokemon.gender === 'female' && Boolean(gameData().sprites?.[pokemon.speciesId]?.['art-female']);

/**
 * The `pdc://` URL of a Pokémon's picture, for the screens that set an `img`
 * or a CSS background rather than drawing on a canvas.
 *
 * @param {{speciesId: number, shiny?: boolean, forme?: string|null, look?: string, gender?: string|null}|null|undefined} pokemon
 */
export const artPath = (pokemon) => artOf(pokemon)?.path ?? null;

/**
 * Damage multiplier of one attacking type against a defender's types.
 * @param {string} attacking
 * @param {string[]} defending
 * @returns {number}
 */
export function typeEffectiveness(attacking, defending) {
  const chart = gameData().types[attacking];
  if (!chart) return 1;
  return defending.reduce((total, type) => total * (chart.effectiveness[type] ?? 1), 1);
}

/** Species slug to Pokédex number, built on first use. */
let slugIndex = null;

/** @param {string} slug */
export function speciesIdBySlug(slug) {
  if (!slugIndex) {
    slugIndex = new Map(Object.values(gameData().species).map((entry) => [entry.slug, entry.id]));
  }
  return slugIndex.get(slug) ?? null;
}
