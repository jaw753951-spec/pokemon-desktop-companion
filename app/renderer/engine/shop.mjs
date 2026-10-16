/**
 * Money, and the shop it is spent in.
 *
 * The companion earns its money the way a trainer does in the games: beating
 * a trainer pays a prize of so much per level of their last Pokémon, and
 * losing to one pays the winner. Wild Pokémon neither pay nor charge.
 *
 * PokeAPI's item records carry no prices any more, so the prices here are the
 * main series' own where the games sell the thing — Scarlet and Violet's,
 * mostly — and set by the same scale where they never did: a held item at
 * the price of the battle items it stands beside. Evolution items and TMs
 * cost well above the games' prices, a TM more the harder its move hits:
 * each is something kept for good, and cheap ones emptied the road of
 * anything worth finding. The legendaries' own items are not for sale; a find is the only way
 * to them. The Master Ball is, at 100,000 — the price of an Ability Patch, and
 * of a hundred trainers' worth of prize money early on, so a sure catch is
 * something saved up for rather than stocked by the dozen.
 */
import { gameData, itemOf, moveOf } from '../core/data.mjs';
import { evolvesSomething } from './bagorder.mjs';
import { signatureItems } from './forms.mjs';
import { levelOf, TRADE_ITEM } from './pokemon.mjs';

/** What a new journey starts with, as the games start it. */
export const STARTING_MONEY = 3000;

/** The most the purse holds, as the games cap it. */
export const MONEY_CAP = 9_999_999;

/**
 * Prize money per level of a trainer's last Pokémon: an ordinary trainer's,
 * a gym leader's, and the League's. The games give each class its own base —
 * a Youngster 16, a Gentleman 200 — which averages out about here for the
 * classes the road sends.
 */
export const PRIZE_PER_LEVEL = { trainer: 40, leader: 100, league: 200 };

/**
 * What losing to a trainer costs, per level of the companion, by how many
 * badges it holds — Diamond and Pearl's table, which every game since keeps.
 */
const LOSS_PER_LEVEL = [8, 16, 24, 36, 48, 64, 80, 100, 120];

/** Prices the games set, by item. */
const PRICES = {
  potion: 200, 'super-potion': 700, 'hyper-potion': 1500, 'max-potion': 2500, 'full-restore': 3000,
  antidote: 200, 'burn-heal': 300, 'ice-heal': 300, awakening: 300, 'paralyze-heal': 300, 'full-heal': 400,
  ether: 1200, 'max-ether': 2000, elixir: 3000, 'max-elixir': 4500,
  'hp-up': 10000, protein: 10000, iron: 10000, calcium: 10000, zinc: 10000, carbos: 10000,
  // A mochi does what a vitamin does; a feather is a tenth of one, priced at
  // the same per point. The games sell neither for money.
  ...Object.fromEntries(['health', 'muscle', 'resist', 'genius', 'clever', 'swift'].flatMap((stat) => [
    [`${stat}-mochi`, 10000],
    [`${stat}-wing`, 1000],
  ])),
  'fresh-start-mochi': 10000,
  'rare-candy': 20000, 'pp-up': 10000, 'pp-max': 30000, 'ability-capsule': 50000, 'ability-patch': 100000,
  'poke-ball': 200, 'great-ball': 600, 'ultra-ball': 800, 'premier-ball': 200,
  'net-ball': 1000, 'dive-ball': 1000, 'nest-ball': 1000, 'repeat-ball': 1000, 'timer-ball': 1000,
  'luxury-ball': 3000, 'dusk-ball': 1000, 'heal-ball': 300, 'quick-ball': 1000,
  'beast-ball': 3000, 'master-ball': 100000,
  'lure-ball': 3000, 'level-ball': 3000, 'moon-ball': 3000, 'heavy-ball': 3000, 'fast-ball': 3000,
  'friend-ball': 3000, 'love-ball': 3000,
  'choice-band': 20000, 'choice-specs': 20000, 'choice-scarf': 20000, 'life-orb': 20000,
  leftovers: 20000, 'focus-sash': 10000, 'assault-vest': 20000, eviolite: 20000, 'rocky-helmet': 20000,
  'lucky-egg': 30000, 'exp-share': 30000, 'soothe-bell': 10000, everstone: 3000,
};

/** And by kind, for what the games price only through its kind or not at all. */
const CATEGORY_PRICES = {
  healing: 500, 'status-cures': 300, 'pp-recovery': 2000, vitamins: 10000, 'nature-mints': 20000,
  'standard-balls': 1000, 'special-balls': 1000, 'apricorn-balls': 3000,
  medicine: 500, 'in-a-pinch': 3000, 'type-protection': 1000, 'effort-drop': 1500,
  'catching-bonus': 1500, other: 3000,
  'held-items': 8000, choice: 20000,
  'type-enhancement': 5000, 'bad-held-items': 5000, 'effort-training': 6000, training: 10000,
  'species-specific': 5000,
};

/**
 * The kinds of item nobody sells: a legendary's key to its shape, a story's
 * key item, a thing kept for show.
 */
const NOT_SOLD_CATEGORIES = new Set([
  // A charm is a title's prize, and only that.
  'charms',
  // A key item that leads to a rare Pokémon is found on the road, and only there.
  'calls',
  'plot-advancement', 'gameplay', 'unused', 'event-items', 'dex-completion', 'species-candies',
  'tm-materials', 'picnic', 'loot', 'collectibles', 'memories', 'plates',
]);

/** Built once: the items a legendary's shape is keyed to. */
let unique = /** @type {Set<string>|null} */ (null);

/**
 * What an item costs in the shop, or null when it is not for sale.
 *
 * @param {string} slug
 * @returns {number|null}
 */
export function priceOf(slug) {
  const item = itemOf(slug);
  if (!item || item.works === false || NOT_SOLD_CATEGORIES.has(item.category)) return null;
  unique ??= new Set(signatureItems().keys());
  if (unique.has(slug)) return null;
  if (item.pocket === 'machines') return machinePrice(item.move);
  const price = PRICES[/** @type {keyof typeof PRICES} */ (slug)] ?? CATEGORY_PRICES[/** @type {keyof typeof CATEGORY_PRICES} */ (item.category)] ?? null;
  // Evolving a Pokémon is worth as much as a vitamin, whatever else the item
  // is for: a Metal Coat costs no less than a stone.
  if (item.category === 'evolution' || evolvesSomething(slug)) return Math.max(price ?? 0, EVOLUTION_PRICE);
  return price;
}

/** What an evolution item costs at least. */
export const EVOLUTION_PRICE = 10000;

/**
 * What a TM costs, by how hard its move hits: a move for keeps is the most a
 * shop sells, and the strongest ones cost as much as an Ability Capsule.
 *
 * | move                        | price  |
 * |-----------------------------|--------|
 * | status, or power under 70   | 20,000 |
 * | power 70–89                 | 30,000 |
 * | power 90–109                | 40,000 |
 * | power 110 and up            | 50,000 |
 *
 * A move whose power the game works out as it goes — a Low Kick, a Gyro
 * Ball — is priced as a status move.
 *
 * @param {string|null|undefined} slug the move taught
 */
export function machinePrice(slug) {
  const power = moveOf(slug ?? '')?.power ?? 0;
  if (power >= 110) return 50000;
  if (power >= 90) return 40000;
  if (power >= 70) return 30000;
  return 20000;
}

/**
 * Whether an item is used up — a potion drunk, a berry eaten, a Focus Sash
 * torn — or kept for good once had: a Leftovers, a Choice Band, a TM's move,
 * and anything a Pokémon evolves by, held or used. A Metal Coat stays in the
 * Steelix's hand, and a Fire Stone or the Linking Cord that stands in for a
 * trade goes back in the bag after the evolution it made.
 *
 * @param {string} slug
 */
export function isConsumable(slug) {
  const item = itemOf(slug);
  if (!item) return true;
  if (item.pocket === 'medicine' || item.pocket === 'berries' || item.pocket === 'pokeballs') return true;
  if (item.pocket === 'machines') return false;
  if (evolvesSomething(slug) || slug === TRADE_ITEM) return false;
  if (['evolution', 'jewels', 'species-candies', 'tm-materials', 'loot', 'dex-completion', 'picnic', 'collectibles'].includes(item.category)) return true;
  return Boolean(item.held?.consumed || item.use?.consumed);
}

/**
 * Whether the bag holds at most one of an item: anything kept, and everything
 * in the misc pocket, used up or not. A second Leftovers would be a thing with
 * nothing to do, and the misc pocket is the held items and the oddments, one
 * of each, rather than supplies stocked by the dozen as potions, balls and
 * berries are.
 *
 * @param {string} slug
 */
export function oneAtATime(slug) {
  return !isConsumable(slug) || itemOf(slug)?.pocket === 'misc';
}

/**
 * Whether the player already has the one they may have of an item, in the
 * bag or in the travelling Pokémon's hand. What a Pokémon in the box holds
 * stays with it there, so it does not stop the companion getting one of its
 * own.
 *
 * @param {import('./session.mjs').Session} session
 * @param {string} slug
 */
export function alreadyOwned(session, slug) {
  if (!oneAtATime(slug)) return false;
  if (session.countOf(slug) > 0) return true;
  if (itemOf(slug)?.pocket === 'machines' && session.machines.includes(itemOf(slug)?.move ?? '')) return true;
  return session.active?.heldItem === slug;
}

/**
 * Everything the shop has, pocket by pocket, cheapest first.
 *
 * @returns {Array<{slug: string, item: any, price: number}>}
 */
export function shopStock() {
  return Object.entries(gameData().items)
    .map(([slug, item]) => ({ slug, item, price: priceOf(slug) }))
    .filter((entry) => entry.price !== null)
    .map((entry) => /** @type {{slug: string, item: any, price: number}} */ (entry))
    .sort((a, b) => a.price - b.price || a.slug.localeCompare(b.slug));
}

/**
 * Buy some of an item, if the purse covers it and, for one the bag holds
 * only one of, the player has none yet.
 *
 * @param {import('./session.mjs').Session} session
 * @param {string} slug
 * @param {number} [count]
 * @returns {'bought'|'poor'|'owned'|'unsold'}
 */
export function buy(session, slug, count = 1) {
  const price = priceOf(slug);
  if (price === null) return 'unsold';
  if (alreadyOwned(session, slug)) return 'owned';
  const quantity = oneAtATime(slug) ? 1 : Math.max(1, Math.floor(count));
  if (session.money < price * quantity) return 'poor';
  session.money -= price * quantity;
  session.addItem(slug, quantity);
  return 'bought';
}

/**
 * A trainer's prize: so much per level of the last Pokémon they sent out.
 *
 * @param {import('./pokemon.mjs').Pokemon[]} foes
 * @param {'trainer'|'leader'|'league'} rank
 */
export function prizeFor(foes, rank) {
  const last = foes[foes.length - 1];
  if (!last) return 0;
  return PRIZE_PER_LEVEL[rank] * levelOf(last);
}

/**
 * What losing to a trainer costs: so much per level of the companion, more
 * with every badge, and never more than is in the purse.
 *
 * @param {import('./session.mjs').Session} session
 */
export function lossFor(session) {
  const rate = LOSS_PER_LEVEL[Math.min(LOSS_PER_LEVEL.length - 1, session.badges.length)];
  return Math.min(session.money, rate * levelOf(session.active));
}

/**
 * Money as the games print it: grouped by thousands.
 * @param {number} amount
 */
export function formatMoney(amount) {
  return Math.round(amount).toLocaleString('en-US');
}

/**
 * Add to the purse, or take from it, within its bounds.
 *
 * @param {import('./session.mjs').Session} session
 * @param {number} amount
 */
export function earn(session, amount) {
  session.money = Math.max(0, Math.min(MONEY_CAP, session.money + Math.round(amount)));
}
