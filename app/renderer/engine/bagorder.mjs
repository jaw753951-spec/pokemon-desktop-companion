/**
 * The order a pocket is listed in, in the bag and in the shop alike.
 *
 * Every pocket goes by what its items are for, kind by kind, and within a
 * kind from the weakest up — then by the games' own item number, which is
 * the order the cartridges' bags list them in.
 *
 * - **Medicine**: HP (Potion up to Full Restore), status cures (one
 *   condition each, then Full Heal), PP, then the stat items — the six
 *   vitamins, the six feathers and the six mochi, each in stat order, and the
 *   Fresh-Start Mochi; PP Up and PP Max, Exp. Candies small to large then the
 *   Rare Candy, the Ability Capsule and Patch — and last the Mints, by the
 *   stat their nature raises.
 * - **Berries**: healing, curing, PP, the type-resisting eighteen in the
 *   games' order, the pinch berries, the ones that answer a hit, the six that
 *   lower effort, and the catching berries.
 * - **Balls**: Poké, Great, Ultra and Master Ball, then the special balls,
 *   then the Apricorn balls.
 * - **Machines** go by kind and number — TMs, then HMs, then TRs, each from
 *   01 up. Sorting their names as text put TM100–199 between TM10 and TM11,
 *   which pushed TM23–99 to the bottom of the list.
 * - **The misc pocket** puts what any Pokémon can use first; then what one
 *   Pokémon uses — a Dialga's orb and crystal, an Arceus's plates, an
 *   Oricorio's nectars — kept together and in the order of the Pokédex; then
 *   the items that only evolve something, the stones any number of families
 *   use first and then each family's own; and at the very bottom the sets
 *   collected a type at a time — Arceus's plates, Genesect's drives,
 *   Silvally's memories — each set together and in the games' type order.
 */
import { gameData, speciesIdBySlug } from '../core/data.mjs';
import { name as localized } from '../core/i18n.mjs';
import { signatureItems, TYPE_SET_ITEMS } from './forms.mjs';
import { STATS } from './stats.mjs';

/** @typedef {{slug: string, item: any}} Entry */

/**
 * @param {string} pocket
 * @returns {(a: Entry, b: Entry) => number}
 */
export function pocketOrder(pocket) {
  if (pocket === 'machines') return byMachine;
  if (pocket === 'misc') return byUse;
  if (pocket === 'medicine') return byRank(medicineRank);
  if (pocket === 'berries') return byRank(berryRank);
  if (pocket === 'pokeballs') return byRank(ballRank);
  return byName;
}

const collator = new Intl.Collator(undefined, { numeric: true });

/** @param {Entry} a @param {Entry} b */
function byName(a, b) {
  return collator.compare(localized(a.item?.name, a.slug), localized(b.item?.name, b.slug)) || a.slug.localeCompare(b.slug);
}

/**
 * Compare by a rank — a list of numbers, most significant first — then by the
 * games' item number, then by name.
 *
 * @param {(entry: Entry) => number[]} rank
 * @returns {(a: Entry, b: Entry) => number}
 */
function byRank(rank) {
  return (a, b) => {
    const left = rank(a);
    const right = rank(b);
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      const difference = (left[index] ?? 0) - (right[index] ?? 0);
      if (difference) return difference;
    }
    return (a.item?.id ?? Infinity) - (b.item?.id ?? Infinity) || byName(a, b);
  };
}

/** Where a stat falls in the games' order: HP, Attack, Defense, Sp. Atk, Sp. Def, Speed. */
const statIndex = (/** @type {string|null|undefined} */ stat) => {
  const index = STATS.indexOf(/** @type {any} */ (stat));
  return index < 0 ? STATS.length : index;
};

/** The one-condition cures in the order the games shelve them, then Full Heal. */
const CURE_ORDER = ['psn', 'par', 'brn', 'frz', 'slp', 'cnf', 'any'];
const cureIndex = (/** @type {string} */ status) => {
  const index = CURE_ORDER.indexOf(status);
  return index < 0 ? CURE_ORDER.length : index;
};

/** @param {Entry} entry */
function medicineRank({ item }) {
  const use = item?.use ?? {};
  switch (item?.category) {
    case 'healing':
      // A Full Restore is a Max Potion and a Full Heal: after the Max Potion.
      return [0, use.hp === 'full' ? 100000 : Number(use.hp ?? 0), use.status ? 1 : 0];
    case 'status-cures':
      return [1, cureIndex(use.status)];
    case 'pp-recovery':
      return [3, use.pp?.scope === 'all' ? 1 : 0, use.pp?.amount === 'full' ? 1 : 0];
    case 'vitamins':
      // A vitamin, then a feather (a point at a time), then a mochi (which
      // brings no friendship), each kind in stat order.
      if (use.effort) return [4, 0, use.effort.amount === 1 ? 1 : use.effort.friendship ? 0 : 2, statIndex(use.effort.stat)];
      if (use.resetEffort) return [4, 0, 3];
      if (use.ppUp) return [4, 1, Number(use.ppUp.fraction ?? 0)];
      if (use.experience) return [4, 2, Number(use.experience)];
      if (use.level) return [4, 2, Number.MAX_SAFE_INTEGER];
      if (use.ability) return [4, 3, use.ability === 'swap' ? 0 : 1];
      return [4, 5];
    case 'nature-mints': {
      const raised = gameData().natures?.[use.nature]?.increased;
      return [5, statIndex(raised)];
    }
    default:
      return [6];
  }
}

/** @param {Entry} entry */
function berryRank({ item }) {
  const held = item?.held;
  if (item?.capture || item?.category === 'catching-bonus') return [7];
  if (item?.use?.effort) return [6, statIndex(item.use.effort.stat)];
  switch (held?.on) {
    case 'hp':
      if (held.heal) return [0, held.heal.amount ?? Math.round((held.heal.fraction ?? 0) * 1000)];
      return [4];
    case 'status':
      return [1, cureIndex(held.status)];
    case 'pp':
      return [2];
    // The item number puts these in the games' own order: Occa, Passho,
    // Wacan… Chilan, then the later Roseli.
    case 'resist':
      return [3];
    case 'hurt':
      return [5];
    default:
      return [8];
  }
}

/** The four every shop has, weakest first. */
const STANDARD_BALLS = ['poke-ball', 'great-ball', 'ultra-ball', 'master-ball'];

/** @param {Entry} entry */
function ballRank({ slug, item }) {
  const standard = STANDARD_BALLS.indexOf(slug);
  if (standard >= 0) return [0, standard];
  return [item?.category === 'apricorn-balls' ? 2 : 1];
}

/** TMs, then HMs, then TRs. */
const MACHINE_KINDS = ['tm', 'hm', 'tr'];

/** @param {Entry} a @param {Entry} b */
function byMachine(a, b) {
  const kind = (/** @type {string} */ slug) => {
    const index = MACHINE_KINDS.indexOf(slug.replace(/\d+$/, ''));
    return index < 0 ? MACHINE_KINDS.length : index;
  };
  const number = (/** @type {string} */ slug) => Number(/\d+$/.exec(slug)?.[0] ?? 0);
  return kind(a.slug) - kind(b.slug) || number(a.slug) - number(b.slug) || byName(a, b);
}

/** @param {Entry} a @param {Entry} b */
function byUse(a, b) {
  const left = placeOf(a);
  const right = placeOf(b);
  return left.group - right.group || left.family - right.family || left.order - right.order || byName(a, b);
}

/**
 * Where a misc item goes: its group — 0 for anyone, 1 for one Pokémon, 2 for
 * evolving only, 3 for a plate, a drive or a memory — and, within the group,
 * the family it belongs to by the Pokédex number of the family's first stage
 * (0 for no one family), then its type's place for one of those sets.
 *
 * @param {Entry} entry
 * @returns {{group: number, family: number, order: number}}
 */
function placeOf({ slug, item }) {
  const { owners, evolves } = index();
  const owner = owners.get(slug);
  const set = TYPE_SET_ITEMS.get(slug);
  if (set) return { group: 3, family: owner ?? 0, order: set.order };
  if (owner !== undefined) return { group: 1, family: owner, order: 0 };
  const families = evolves.get(slug);
  // An item with an effect of its own — a King's Rock, a Metal Coat — is held
  // for that, and belongs with the rest of what anyone can hold. The Linking
  // Cord stands in for a trade, which no evolution names an item for, so the
  // data's own word for an evolution item counts as well.
  if ((families || item?.category === 'evolution') && !item?.held && !item?.use) {
    return { group: 2, family: families?.size === 1 ? [...families][0] : 0, order: 0 };
  }
  return { group: 0, family: 0, order: 0 };
}

/**
 * Whether some Pokémon evolves by this item, held or used.
 *
 * @param {string} slug
 */
export function evolvesSomething(slug) {
  return index().evolves.has(slug);
}

/**
 * Built once from the data: which Pokémon each item belongs to, and which
 * families each item evolves.
 *
 * @type {{owners: Map<string, number>, evolves: Map<string, Set<number>>}|null}
 */
let cached = null;
let cachedFor = /** @type {any} */ (null);

function index() {
  const data = gameData();
  if (cached && cachedFor === data) return cached;

  const species = Object.values(data.species ?? {});
  /** The species each one evolves from, to walk a family back to its first stage. */
  const from = new Map();
  for (const entry of species) {
    for (const evolution of entry.evolutions ?? []) from.set(evolution.to, entry.id);
  }
  const root = (/** @type {number} */ id) => {
    let current = id;
    for (let step = 0; step < 4 && from.has(current); step++) current = from.get(current);
    // A regional form is filed after its species, by the national number.
    const record = data.species[current];
    return Number(record?.dex ?? record?.id ?? current);
  };
  const rootOf = (/** @type {string} */ slug) => {
    const id = speciesIdBySlug(slug);
    return id === null ? null : root(id);
  };

  /** @type {Map<string, number>} */
  const owners = new Map();
  for (const [item, holders] of signatureItems()) {
    const family = rootOf(holders[0]);
    if (family !== null) owners.set(item, family);
  }
  for (const [slug, item] of Object.entries(data.items ?? {})) {
    const holders = item?.held?.species;
    if (owners.has(slug) || !holders?.length) continue;
    const family = rootOf(holders[0]);
    if (family !== null) owners.set(slug, family);
  }

  /** @type {Map<string, Set<number>>} */
  const evolves = new Map();
  for (const entry of species) {
    for (const evolution of entry.evolutions ?? []) {
      for (const item of [evolution.item, evolution.heldItem, ...(evolution.heldItems ?? [])]) {
        if (!item) continue;
        if (!evolves.has(item)) evolves.set(item, new Set());
        evolves.get(item)?.add(root(entry.id));
      }
    }
  }

  cached = { owners, evolves };
  cachedFor = data;
  return cached;
}
