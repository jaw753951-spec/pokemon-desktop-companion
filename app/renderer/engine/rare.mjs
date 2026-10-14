/**
 * The rare Pokémon on the road: the legendaries, the mythicals, the Ultra
 * Beasts and the Paradoxes (see `isRare`).
 *
 * They used to be strays at a twentieth of the weight — one wild Pokémon in
 * about five hundred, a day and a half of walking on average and, on a bad
 * run, any amount longer. Turning the weight up only makes them common. So
 * they come on a clock of their own instead, the way Legends: Arceus's
 * space-time distortions do: the longer since the last one, the likelier the
 * next wild Pokémon is one, until past a ceiling it certainly is. Not on the
 * save's first run, though: there they stay at the low odds throughout.
 *
 * And a key item can decide who it is (see `CALLING_ITEMS` in the dex build):
 * the Member Card leads to Darkrai, the Silver Wing to Lugia — once the save
 * has a champion, as none is found on the first run. The Pokémon an
 * item leads to are met no other way, and while one of them is waiting the
 * clock runs to a much shorter ceiling — a ticket found is a meeting soon,
 * not one more name in a draw. The Enigmatic Card is the exception: it puts
 * the Ultra Beasts in the draw with everyone else, which is how they are met
 * once it is in the bag.
 */
import { TAG_TYPES } from '../../shared/area-tags.mjs';
import { gameData, speciesIdBySlug } from '../core/data.mjs';
import { isRare, STRAY_TERRAIN_WEIGHT } from './encounter.mjs';

const HOUR = 60 * 60 * 1000;

/** The odds a wild Pokémon is a rare one, until the wait starts to tell. */
export const RARE_CHANCE = 0.005;

/**
 * How long the wait is, in walking time, before the odds start to climb, and
 * how long before a rare Pokémon is certain.
 *
 * About fifteen wild Pokémon are met an hour, so a fifth of the waits end
 * early on the low odds and most of the rest in the hour after the climb
 * starts: about three hours apart on average, and in practice never past
 * five, as the climb all but makes it certain before the ceiling does.
 */
export const RARE_CEILING = { soft: 3 * HOUR, hard: 6 * HOUR };

/** The same, while a key item has a Pokémon waiting to be met. */
export const CALLED_CEILING = { soft: 0.5 * HOUR, hard: 1.5 * HOUR };

/**
 * How often an item find on the road is a key item that leads somewhere,
 * while there is one still to find: at about fifteen finds an hour, one every
 * two hours or so.
 */
export const CALLING_FIND_CHANCE = 0.03;

/**
 * The odds that the next wild Pokémon is a rare one.
 *
 * @param {number} sinceMs walking time since the last rare one
 * @param {boolean} [called] whether a key item has one waiting
 */
export function rareChance(sinceMs, called = false) {
  const { soft, hard } = called ? CALLED_CEILING : RARE_CEILING;
  if (sinceMs >= hard) return 1;
  if (sinceMs <= soft) return RARE_CHANCE;
  return RARE_CHANCE + ((1 - RARE_CHANCE) * (sinceMs - soft)) / (hard - soft);
}

/**
 * Every key item that leads to a Pokémon, with the Pokémon it leads to.
 *
 * @returns {Array<{slug: string, item: any, calls: number[]}>}
 */
export function callingItems() {
  return Object.entries(gameData().items ?? {})
    .filter(([, item]) => Array.isArray(item.calls))
    .map(([slug, item]) => ({
      slug,
      item,
      calls: item.calls.map((name) => speciesIdBySlug(name)).filter((id) => typeof id === 'number'),
    }));
}

/**
 * The Pokémon the key items in the bag have waiting: for each, the first of
 * the ones it leads to not yet caught. A ticket leads to its Pokémon one at a
 * time, in order, and stops leading anywhere once they are all caught. An
 * item that opens the draw instead (`pool`) has nobody waiting.
 *
 * @param {import('./session.mjs').Session} session
 * @returns {number[]}
 */
export function calledSpecies(session) {
  return callingItems()
    .filter(({ slug, item }) => !item.pool && session.countOf(slug) > 0)
    .map(({ calls }) => calls.find((id) => !session.caught.has(id)))
    .filter((id) => typeof id === 'number');
}

/**
 * Whether the next wild Pokémon is a rare one, and which: one a key item has
 * waiting if there is one, otherwise one from the rest. Meeting it starts the
 * clock again.
 *
 * Meeting is not catching. One that gets away is still uncaught, so a key
 * item goes on leading to it, and the draw goes on preferring it, until it is
 * caught — the way the games bring a legendary back after the Elite Four.
 *
 * The save's first run has no clock: a rare Pokémon is only ever the low
 * odds, however long the wait. The clock starts from where the save is when
 * it gets its champion, rather than owing the whole first run at once.
 *
 * @param {import('./session.mjs').Session} session
 * @returns {number|null} a Pokédex number, or null for an ordinary draw
 */
export function rollRare(session) {
  const called = calledSpecies(session);
  if (session.firstRun) session.rareSince = session.playtime;
  const since = Math.max(0, session.playtime - session.rareSince);
  if (!session.rng.chance(rareChance(since, called.length > 0))) return null;
  session.rareSince = session.playtime;
  if (called.length) return session.rng.pick(called);
  return pickRare(session.rng, session.area, session.caught, pooledSpecies(session));
}

/**
 * The Pokémon the items in the bag have put in the rare draw: the Ultra
 * Beasts, once the Enigmatic Card is had.
 *
 * @param {import('./session.mjs').Session} session
 * @returns {Set<number>}
 */
export function pooledSpecies(session) {
  return new Set(
    callingItems()
      .filter(({ slug, item }) => item.pool && session.countOf(slug) > 0)
      .flatMap(({ calls }) => calls),
  );
}

/**
 * A rare Pokémon for the road, from all of them but the ones a key item
 * leads to — less those an item in the bag has put in the draw — leaning
 * towards the types the area's terrain suits as a stray does.
 *
 * One not yet caught comes first, while there are any: each legendary is one
 * to a save in the games, and a second Mewtwo is no prize while there are a
 * hundred others still to meet.
 *
 * @param {import('../core/rng.mjs').Rng} rng
 * @param {any} area
 * @param {Set<number>} [caught]
 * @param {Set<number>} [pooled] the reserved Pokémon an item has put in the draw
 * @returns {number|null}
 */
export function pickRare(rng, area, caught = new Set(), pooled = new Set()) {
  const reserved = new Set(callingItems().flatMap(({ calls }) => calls).filter((id) => !pooled.has(id)));
  const pool = Object.values(gameData().species).filter((species) => isRare(species) && !reserved.has(species.id));
  const fresh = pool.filter((species) => !caught.has(species.id));
  const wanted = new Set((area?.tags ?? []).flatMap((tag) => TAG_TYPES[tag] ?? []));
  return rng.weighted(
    (fresh.length ? fresh : pool).map((species) => ({
      value: species.id,
      weight: species.types.some((type) => wanted.has(type)) ? STRAY_TERRAIN_WEIGHT : 1,
    })),
  );
}

/**
 * The key item an item find turns out to be, if it does: one not in the bag
 * that still leads to someone uncaught. None is found on the first run: they
 * all wait until the save has a champion, as the games kept the mythical
 * Pokémon's tickets and Looker's card for after the story.
 *
 * @param {import('./session.mjs').Session} session
 * @returns {string|null}
 */
export function callingFind(session) {
  if (session.firstRun) return null;
  const open = callingItems().filter(
    ({ slug, calls }) => session.countOf(slug) === 0 && calls.some((id) => !session.caught.has(id)),
  );
  if (!open.length || !session.rng.chance(CALLING_FIND_CHANCE)) return null;
  return session.rng.pick(open).slug;
}
