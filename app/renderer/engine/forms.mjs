/**
 * The formes a battle can change, and the moment each one changes in.
 *
 * A species' `forms` array in the dex names every alternate forme whose
 * trigger the battle itself can supply — weather a Forecast reads, health a
 * Zen Mode waits on, a hit that breaks a Disguise, a move that catches
 * something. This is the table that says which ability keys each species off
 * and which way round the two shapes go.
 *
 * The forme itself lives on the combatant (`marks.forme`), the way a Protean's
 * type does: the save never carries one, because a battle is where forme
 * changes happen and where they end.
 *
 * @typedef {Object} SpeciesForm
 * @property {string} slug the variety slug the dex files it under
 * @property {string} trigger the moment it changes in
 * @property {string[]} types its types
 * @property {Record<string, number>} stats its base stats
 * @property {boolean} sprite whether the pipeline carried a picture for it
 */

import { speciesOf } from '../core/data.mjs';
// A cycle — `pokemon.mjs` reads the tables here — but only ever called into,
// never read while the two modules are still loading.
import { levelOf, statsOf } from './pokemon.mjs';

/** The ability each forme-changing species keys off. */
export const FORM_ABILITY = new Map([
  ['castform', 'forecast'],
  ['darmanitan', 'zen-mode'],
  ['darmanitan-galar-standard', 'zen-mode'],
  ['wishiwashi', 'schooling'],
  ['minior', 'shields-down'],
  ['mimikyu', 'disguise'],
  ['eiscue', 'ice-face'],
  ['cramorant', 'gulp-missile'],
  ['aegislash', 'stance-change'],
  ['morpeko', 'hunger-switch'],
]);

const TYPES_WITH_PLATES = [
  ['flame-plate', 'fire'], ['splash-plate', 'water'], ['zap-plate', 'electric'], ['meadow-plate', 'grass'],
  ['icicle-plate', 'ice'], ['fist-plate', 'fighting'], ['toxic-plate', 'poison'], ['earth-plate', 'ground'],
  ['sky-plate', 'flying'], ['mind-plate', 'psychic'], ['insect-plate', 'bug'], ['stone-plate', 'rock'],
  ['spooky-plate', 'ghost'], ['draco-plate', 'dragon'], ['dread-plate', 'dark'], ['iron-plate', 'steel'],
  ['pixie-plate', 'fairy'],
];

/**
 * The formes a held item decides, by species and then by item: the forme it
 * takes, and the type its signature move becomes.
 *
 * These are the Pokémon's shape wherever it is — on the road, in the menus,
 * in a battle — for as long as it holds the item. Ogerpon wears its mask;
 * Dialga, Palkia and Giratina take their Origin Forme from their crystal,
 * globe and orb; Arceus and Silvally become the type of their plate and
 * memory, and Genesect loads its drive. Without one, each is the species'
 * own shape.
 *
 * @type {Map<string, Map<string, {forme: string, type?: string}>>}
 */
export const HELD_FORMES = new Map([
  [
    'ogerpon',
    new Map([
      ['wellspring-mask', { forme: 'ogerpon-wellspring-mask', type: 'water' }],
      ['hearthflame-mask', { forme: 'ogerpon-hearthflame-mask', type: 'fire' }],
      ['cornerstone-mask', { forme: 'ogerpon-cornerstone-mask', type: 'rock' }],
    ]),
  ],
  ['dialga', new Map([['adamant-crystal', { forme: 'dialga-origin' }]])],
  ['palkia', new Map([['lustrous-globe', { forme: 'palkia-origin' }]])],
  ['giratina', new Map([['griseous-orb', { forme: 'giratina-origin' }]])],
  ['arceus', new Map(TYPES_WITH_PLATES.map(([plate, type]) => [plate, { forme: `arceus-${type}`, type }]))],
  [
    'silvally',
    new Map(TYPES_WITH_PLATES.map(([, type]) => [`${type}-memory`, { forme: `silvally-${type}`, type }])),
  ],
  [
    'genesect',
    new Map([
      ['burn-drive', { forme: 'genesect-burn', type: 'fire' }],
      ['chill-drive', { forme: 'genesect-chill', type: 'ice' }],
      ['douse-drive', { forme: 'genesect-douse', type: 'water' }],
      ['shock-drive', { forme: 'genesect-shock', type: 'electric' }],
    ]),
  ],
]);

/**
 * The move whose type follows the held item, by species: Ivy Cudgel the mask,
 * Judgment the plate, Multi-Attack the memory, Techno Blast the drive.
 */
export const SIGNATURE_MOVES = new Map([
  ['ogerpon', 'ivy-cudgel'],
  ['arceus', 'judgment'],
  ['silvally', 'multi-attack'],
  ['genesect', 'techno-blast'],
]);

/**
 * The formes that take hold as a battle opens, by species and then by held
 * item, and gone again when it is over.
 *
 * Kyogre and Groudon undergo Primal Reversion with their orbs; Zacian and
 * Zamazenta are crowned by their rusted sword and shield; a Necrozma that has
 * fused with Solgaleo or Lunala bursts into Ultra Necrozma on its Z crystal.
 * Terapagos has none: its Terastal and Stellar Forms belong to the Terastal
 * phenomenon, which this game does not have, and are not built.
 *
 * `from` names the standing formes a battle forme can only be reached from.
 *
 * @type {Map<string, Map<string, {forme: string, from?: string[]}>>}
 */
export const START_FORMES = new Map([
  ['kyogre', new Map([['blue-orb', { forme: 'kyogre-primal' }]])],
  ['groudon', new Map([['red-orb', { forme: 'groudon-primal' }]])],
  ['zacian', new Map([['rusted-sword', { forme: 'zacian-crowned' }]])],
  ['zamazenta', new Map([['rusted-shield', { forme: 'zamazenta-crowned' }]])],
  [
    'necrozma',
    new Map([['ultranecrozium-z--held', { forme: 'necrozma-ultra', from: ['necrozma-dusk', 'necrozma-dawn'] }]]),
  ],
]);

/**
 * The key items that change a Pokémon's shape when used on it from the bag,
 * by item and then by species: the formes it steps through, one per use,
 * and back to the species' own after the last.
 *
 * The item is kept — it is the tool, not the fuel — and the shape it leaves
 * the Pokémon in is the Pokémon's until the item is used again.
 *
 * @type {Map<string, Map<string, string[]>>}
 */
export const USE_FORMES = new Map([
  ['n-solarizer--merge', new Map([['necrozma', ['necrozma-dusk']]])],
  ['n-lunarizer--merge', new Map([['necrozma', ['necrozma-dawn']]])],
  ['dna-splicers', new Map([['kyurem', ['kyurem-black', 'kyurem-white']]])],
  ['prison-bottle', new Map([['hoopa', ['hoopa-unbound']]])],
  ['gracidea', new Map([['shaymin', ['shaymin-sky']]])],
  [
    'reveal-glass',
    new Map(['tornadus', 'thundurus', 'landorus', 'enamorus'].map((slug) => [slug, [`${slug}-therian`]])),
  ],
  ['reins-of-unity', new Map([['calyrex', ['calyrex-ice', 'calyrex-shadow']]])],
  ['meteorite', new Map([['deoxys', ['deoxys-attack', 'deoxys-defense', 'deoxys-speed']]])],
  ['zygarde-cube', new Map([['zygarde', ['zygarde-10']]])],
  // A Rotom Catalog steps through the five appliances and back out of them.
  ['rotom-catalog', new Map([['rotom', ['rotom-heat', 'rotom-wash', 'rotom-frost', 'rotom-fan', 'rotom-mow']]])],
]);

/**
 * The items that put a Pokémon in one particular shape rather than stepping
 * it through several: an Oricorio drinks a nectar and dances in that
 * nectar's style. `null` is the species' own shape.
 *
 * @type {Map<string, Map<string, string|null>>}
 */
export const SET_FORMES = new Map([
  ['red-nectar', new Map([['oricorio', null]])],
  ['yellow-nectar', new Map([['oricorio', 'oricorio-pom-pom']])],
  ['pink-nectar', new Map([['oricorio', 'oricorio-pau']])],
  ['purple-nectar', new Map([['oricorio', 'oricorio-sensu']])],
]);

/**
 * What changing shape with a key item does to a Pokémon's moves, by species,
 * the way the games do it.
 *
 * `moves` names the moves each shape brings, place for place: the first of
 * one shape's becomes the first of the next's wherever it is known. Past
 * that, the species decides.
 *
 * - `learns`: a shape whose move was not known is learned into a free slot,
 *   or over one the player picks; without `learns` (Kyurem, Hoopa) a move is
 *   only ever traded for the one standing in its place, and nothing is added.
 * - `required`: the shape cannot be taken without its move — a Rotom that
 *   will not make room for Overheat stays out of the oven. Otherwise the
 *   player may give the move up and change anyway.
 * - `fallback`: what a Pokémon left with no moves remembers — Thunder Shock
 *   for a Rotom out of its appliance, Confusion for a Calyrex or a Necrozma
 *   that has parted from its partner.
 * - `unlearnable`: going back to its own shape, it also forgets every move its
 *   own shape cannot learn, as a Calyrex off its steed does.
 *
 * @type {Map<string, {moves: Record<string, string[]>, learns?: boolean, required?: boolean, fallback?: string, unlearnable?: boolean}>}
 */
export const FORME_MOVE_RULES = new Map([
  [
    'rotom',
    {
      learns: true,
      required: true,
      fallback: 'thunder-shock',
      moves: {
        'rotom-heat': ['overheat'],
        'rotom-wash': ['hydro-pump'],
        'rotom-frost': ['blizzard'],
        'rotom-fan': ['air-slash'],
        'rotom-mow': ['leaf-storm'],
      },
    },
  ],
  [
    'kyurem',
    {
      moves: {
        kyurem: ['scary-face', 'glaciate'],
        'kyurem-black': ['fusion-bolt', 'freeze-shock'],
        'kyurem-white': ['fusion-flare', 'ice-burn'],
      },
    },
  ],
  ['hoopa', { moves: { hoopa: ['hyperspace-hole'], 'hoopa-unbound': ['hyperspace-fury'] } }],
  [
    'calyrex',
    {
      learns: true,
      fallback: 'confusion',
      unlearnable: true,
      moves: { 'calyrex-ice': ['glacial-lance'], 'calyrex-shadow': ['astral-barrage'] },
    },
  ],
  [
    'necrozma',
    {
      learns: true,
      fallback: 'confusion',
      moves: { 'necrozma-dusk': ['sunsteel-strike'], 'necrozma-dawn': ['moongeist-beam'] },
    },
  ],
]);

/** Every shape's own moves, by the shape. @type {Map<string, string[]>} */
export const FORME_MOVES = new Map([...FORME_MOVE_RULES.values()].flatMap((rule) => Object.entries(rule.moves)));

/**
 * Every item that exists for one species' sake, with the species it is for —
 * which is what the finds hand out only while one of them is the Pokémon
 * travelling. The plates are among them: the finds never handed them out,
 * and Arceus is who they are for.
 *
 * @returns {Map<string, string[]>} item slug to the species slugs it is for
 */
export function signatureItems() {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  const add = (item, species) => out.set(item, [...(out.get(item) ?? []), species]);
  for (const [species, byItem] of [...HELD_FORMES, ...START_FORMES]) {
    for (const item of byItem.keys()) add(item, species);
  }
  for (const [item, bySpecies] of [...USE_FORMES, ...SET_FORMES]) {
    for (const species of bySpecies.keys()) add(item, species);
  }
  return out;
}

/** @param {any} species @param {string|null|undefined} slug */
const hasForme = (species, slug) => Boolean(slug) && (species?.forms ?? []).some((form) => form.slug === slug);

/**
 * The forme a Pokémon's held item puts it in, if its species has one and the
 * dex carries it.
 *
 * @param {{speciesId: number, heldItem?: string|null}|null|undefined} pokemon
 * @returns {{forme: string, type?: string}|null}
 */
export function heldForme(pokemon) {
  const species = speciesOf(pokemon?.speciesId);
  const entry = HELD_FORMES.get(species?.slug ?? '')?.get(pokemon?.heldItem ?? '');
  return entry && hasForme(species, entry.forme) ? entry : null;
}

/**
 * The shape a Pokémon is in outside a battle: the one its held item gives it,
 * or the one a key item left it in.
 *
 * @param {{speciesId: number, heldItem?: string|null, standing?: string|null, moves?: Array<{move: string}>}|null|undefined} pokemon
 * @returns {string|null}
 */
export function standingForme(pokemon) {
  const held = heldForme(pokemon);
  if (held) return held.forme;
  const species = speciesOf(pokemon?.speciesId);
  // A Keldeo that knows Secret Sword stands in its Resolute Form.
  if (species?.slug === 'keldeo' && hasForme(species, 'keldeo-resolute')) {
    return pokemon?.moves?.some((slot) => slot.move === 'secret-sword') ? 'keldeo-resolute' : null;
  }
  return hasForme(species, pokemon?.standing) ? /** @type {string} */ (pokemon?.standing) : null;
}

/**
 * The forme a battle opens in for a Pokémon that has one, on top of whatever
 * it was standing in.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @returns {string|null}
 */
export function startForme(pokemon) {
  const species = speciesOf(pokemon?.speciesId);
  const slug = species?.slug ?? '';
  const entry = START_FORMES.get(slug)?.get(pokemon?.heldItem ?? '');
  if (entry && hasForme(species, entry.forme)) {
    if (!entry.from || entry.from.includes(standingForme(pokemon) ?? '')) return entry.forme;
  }
  return null;
}

/**
 * Put a Pokémon into the shape it stands in outside a battle — after a battle
 * has let go of it, or after its held item changed.
 *
 * Its health keeps its distance from the top, the way evolving keeps it, so a
 * Zygarde shrinking to its 10% Forme does not come out over its maximum and
 * one growing back does not look as if it had been hurt.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 */
export function settleForme(pokemon) {
  const species = speciesOf(pokemon?.speciesId);
  // A species with no formes left — a Terapagos, whose Terastal ones are no
  // longer built — takes off whatever an older save has it wearing.
  if (!species?.forms?.length) {
    if (pokemon && 'forme' in pokemon) delete pokemon.forme;
    return;
  }
  const wanted = standingForme(pokemon);
  if ((pokemon.forme ?? null) === wanted) return;
  const hp = (forme) => statsOf(pokemon, forme ?? null).hp;
  const before = hp(pokemon.forme);
  if (wanted) pokemon.forme = wanted;
  else delete pokemon.forme;
  const after = hp(wanted);
  if (typeof pokemon.hp === 'number' && before && after) {
    pokemon.hp = Math.max(pokemon.hp > 0 ? 1 : 0, Math.min(after, pokemon.hp + (after - before)));
  }
}

/**
 * Step a Pokémon to the next shape a key item gives it, if the item is for
 * its species.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {string} item
 * @returns {string|null|false} the forme it is now in (null for its own), or
 *   false when the item does nothing for it
 */
export function useFormeItem(pokemon, item) {
  const next = nextForme(pokemon, item);
  if (next === false) return false;
  if (next) pokemon.standing = next;
  else delete pokemon.standing;
  settleForme(pokemon);
  return next;
}

/**
 * The shape a key item would put a Pokémon in, without putting it there — so
 * what the change costs can be asked about first.
 *
 * @param {{speciesId: number, standing?: string|null}|null|undefined} pokemon
 * @param {string} item
 * @returns {string|null|false} the forme (null for its own), or false when the
 *   item does nothing for it
 */
export function nextForme(pokemon, item) {
  const species = speciesOf(pokemon?.speciesId);
  const set = SET_FORMES.get(item);
  if (set?.has(species?.slug ?? '')) {
    const wanted = set.get(species?.slug ?? '') ?? null;
    if (wanted && !hasForme(species, wanted)) return false;
    if ((pokemon?.standing ?? null) === wanted) return false;
    return wanted;
  }
  const cycle = USE_FORMES.get(item)?.get(species?.slug ?? '')?.filter((slug) => hasForme(species, slug));
  if (!cycle?.length) return false;
  const at = cycle.indexOf(pokemon?.standing ?? '');
  return at < 0 ? cycle[0] : cycle[at + 1] ?? null;
}

/**
 * The type a species' signature move takes from the item it holds.
 *
 * @param {{speciesId: number, heldItem?: string|null}|null|undefined} pokemon
 * @param {string} move
 * @returns {string|null}
 */
export function signatureType(pokemon, move) {
  const slug = speciesOf(pokemon?.speciesId)?.slug ?? '';
  if (SIGNATURE_MOVES.get(slug) !== move) return null;
  return heldForme(pokemon)?.type ?? null;
}

/**
 * The ability a forme puts in place of the species' own, if it has one: the
 * forme's ability in the same slot, so a Tornadus with its hidden Defiant
 * keeps Defiant as a Therian.
 *
 * @param {{speciesId?: number, forme?: string|null, ability?: string}|null|undefined} pokemon
 * @returns {string|null}
 */
export function formeAbility(pokemon) {
  if (!pokemon?.forme) return null;
  const species = speciesOf(pokemon.speciesId);
  const form = (species?.forms ?? []).find((entry) => entry.slug === pokemon.forme);
  const abilities = form?.abilities;
  if (!abilities?.length) return null;
  const slot = (species?.abilities ?? []).findIndex((entry) => entry.name === pokemon.ability);
  return (abilities[slot] ?? abilities[0]).name;
}

/**
 * The types a Pokémon has outside a battle: its forme's, when it is wearing
 * one that has its own, and its species' otherwise.
 *
 * @param {{speciesId: number, forme?: string|null}|null|undefined} pokemon
 * @returns {string[]}
 */
export function standingTypes(pokemon) {
  const species = speciesOf(pokemon?.speciesId);
  const form = pokemon?.forme ? (species?.forms ?? []).find((entry) => entry.slug === pokemon.forme) : null;
  return form?.types ?? species?.types ?? [];
}

/** The species a key item changes. */
const USE_SPECIES = new Set([...USE_FORMES.values(), ...SET_FORMES.values()].flatMap((bySpecies) => [...bySpecies.keys()]));

/** Weather a Forecast turns into, and the forme that weather means. */
const FORECAST_FORMS = new Map([
  ['sun', 'castform-sunny'],
  ['rain', 'castform-rainy'],
  // Hail is the older snow, and a Castform wears the same cloud under both.
  ['hail', 'castform-snowy'],
  ['snow', 'castform-snowy'],
]);

/** The level below which a Wishiwashi is too young to call a school. */
export const SCHOOLING_LEVEL = 20;

/**
 * Which forme a species should be in right now, given the battle around it.
 *
 * Returns `null` when the species does not change, or when it should be back
 * in its ordinary shape — which is the answer most of the time, and why every
 * caller checks this once a turn rather than the engine wiring a hook per
 * species.
 *
 * The forme the combatant is already wearing is passed in as well: whether the
 * next check lands on a forme or on the default depends on where it is now,
 * and a forme that can only be entered but never left would stick for the
 * rest of the battle.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {{
 *   current: string|null,
 *   weather: string|null,
 *   weatherTurns: number,
 *   overhp: number,
 *   maxhp: number,
 *   broken: boolean,
 *   usedMove: string|null,
 *   relicSongs?: number,
 *   stance?: string|null,
 *   hangry?: boolean,
 *   gulp?: 'gulping'|'gorging'|null,
 * }} state
 * @returns {string|null} the forme slug to take, or null to keep the current one
 */
export function formeFor(pokemon, state) {
  const species = speciesOf(pokemon?.speciesId);
  const speciesSlug = species?.slug;
  if (!speciesSlug) return null;
  const forms = species.forms ?? [];
  if (!forms.length) return null;
  const find = (slug) => (forms.some((form) => form.slug === slug) ? slug : null);
  const plain = speciesSlug;

  // The shapes a held item or a key item decides, and the ones a battle opens
  // in: nothing inside the battle moves them.
  if (HELD_FORMES.has(speciesSlug) || START_FORMES.has(speciesSlug) || USE_SPECIES.has(speciesSlug)) {
    const wanted = startForme(pokemon) ?? standingForme(pokemon);
    if (wanted) return wanted;
    return state.current ? speciesSlug : null;
  }

  // Every Relic Song turns Meloetta, and the next turns it back.
  if (speciesSlug === 'meloetta') {
    const turned = (state.relicSongs ?? 0) % 2 === 1;
    if (turned) return find('meloetta-pirouette');
    return state.current ? plain : null;
  }

  const ability = FORM_ABILITY.get(speciesSlug);
  if (pokemon.ability !== ability) return null;

  // The slug the species' ordinary shape answers to — what the dex filed the
  // species itself under. A forme steps back into it by name, which is why
  // the returned slugs name it explicitly rather than meaning "any".
  const half = state.overhp * 2 <= state.maxhp;
  const quarter = state.overhp * 4 <= state.maxhp;

  switch (ability) {
    // One forme per weather, and none when there is no weather to read.
    case 'forecast': {
      const forme = FORECAST_FORMS.get(state.weather ?? '');
      return forme ? find(forme) : plain;
    }

    // Below half the fire takes hold; above it, back to normal.
    // A Galarian Darmanitan has a Zen Mode of its own.
    case 'zen-mode':
      return half ? find('darmanitan-zen') ?? find('darmanitan-galar-zen') : plain;

    // Together above a quarter, scattered below it — and alone, whatever
    // its health, until it is old enough to call a school at all.
    case 'schooling':
      return quarter || levelOf(pokemon) < SCHOOLING_LEVEL ? plain : find('wishiwashi-school');

    // The core is out below half; above it, the rock it starts as. The
    // species' own slug is the meteor — the dex files Minior under its
    // default variety, and the seven coloured cores hang off Shields Down.
    case 'shields-down':
      return half ? find('minior-red') : plain;

    // A Disguise is broken by one hit, and stays broken.
    case 'disguise':
      return state.broken ? find('mimikyu-busted') : plain;

    // The ice face is knocked off by one hit, and stays off.
    case 'ice-face':
      return state.broken ? find('eiscue-noice') : plain;

    // Whatever Surf or Dive caught, it keeps until the throw is made: an
    // Arrokuda above half health, a Pikachu at half or below.
    case 'gulp-missile':
      return state.gulp === 'gulping' ? find('cramorant-gulping')
        : state.gulp === 'gorging' ? find('cramorant-gorging')
        : plain;

    // Blade to strike, Shield to guard; it walks in guarding.
    case 'stance-change':
      return state.stance === 'blade' ? find('aegislash-blade') : plain;

    // Full, then hungry, then full again, a turn at a time.
    case 'hunger-switch':
      return state.hangry ? find('morpeko-hangry') : plain;

    default:
      return null;
  }
}
