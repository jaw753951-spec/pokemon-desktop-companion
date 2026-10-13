/**
 * A run in progress: the save's contents plus the bookkeeping that only
 * matters while the game is open.
 *
 * Everything the player accumulates lives here, and `toSave` is the single
 * point where it turns back into the JSON written to a slot.
 */
import { AUTOSAVE_INTERVAL_MS, BADGES_FOR_LEAGUE, EVENT_INTERVAL_MS, EVENTS_PER_AREA, TRAY_LIMIT } from '../../shared/constants.mjs';
import { saves } from '../core/bridge.mjs';
import { ALCREMIE_LOOKS, randomLook } from '../../shared/alcremie.mjs';
import { gameData, itemOf, speciesOf } from '../core/data.mjs';
import { Rng } from '../core/rng.mjs';
import { pocketOrder } from './bagorder.mjs';
import { EventScheduler } from './events.mjs';
import { ensureAttack, fullyHeal, shinyOddsFor } from './pokemon.mjs';
import { HELD_FORMES, settleForme } from './forms.mjs';
import { oneAtATime, STARTING_MONEY } from './shop.mjs';

/** Items that have been folded into another since saves were written. */
const LEGACY_ITEMS = Object.fromEntries(
  ['strawberry-sweet', 'love-sweet', 'berry-sweet', 'clover-sweet', 'flower-sweet', 'star-sweet', 'ribbon-sweet'].map((slug) => [slug, 'sweet']),
);

/** How often moving on to a new area crosses to the other region. */
export const REGION_CROSSING_CHANCE = 0.2;

export class Session {
  /**
   * @param {{slot: number, save: any}} options
   */
  constructor({ slot, save }) {
    this.slot = slot;
    this.rng = new Rng(save.seed);

    this.active = save.party.active;
    /** @type {Array<import('./pokemon.mjs').Pokemon|null>} */
    this.box = save.party.box ?? [];

    // A Pokémon with nothing but status moves cannot win a fight it is left to
    // run on its own, and saves written before that was guaranteed are full of
    // them. Every Pokémon the save carries is given something that hits, on
    // the way in, rather than finding out mid-battle.
    for (const pokemon of [this.active, ...this.box]) {
      if (pokemon) ensureAttack(pokemon);
      // And in the shape it stands in: a battle forme a save caught mid-way
      // (a Zen Mode, a Primal Kyogre) is let go of, and a held or chosen one
      // put back on.
      if (pokemon) settleForme(pokemon);
      // And holding nothing the game no longer carries, the way the bag below
      // keeps nothing of it: a Tera Orb, from before the Terastal formes went.
      if (pokemon?.heldItem && LEGACY_ITEMS[pokemon.heldItem]) pokemon.heldItem = LEGACY_ITEMS[pokemon.heldItem];
      if (pokemon?.heldItem && !gameData().items[pokemon.heldItem]) pokemon.heldItem = null;
      // Effort is gone; a save that still carries it drops it.
      if (pokemon) delete pokemon.evs;
      // An Alcremie saved before its look was rolled, or with one of the
      // sixty-three the game no longer draws, gets one of the seven.
      if (pokemon && speciesOf(pokemon.speciesId)?.slug === 'alcremie' && !ALCREMIE_LOOKS.includes(pokemon.look)) {
        pokemon.look = randomLook(this.rng);
      }
    }
    /**
     * The bag, less anything the game no longer carries: a save written before
     * an item was found to have no effect here would otherwise keep it for
     * good, listed in a pocket that can do nothing with it.
     */
    this.bag = {};
    for (const [slug, count] of Object.entries(save.bag ?? {})) {
      // The seven Sweets are one item now.
      const kept = LEGACY_ITEMS[slug] ?? slug;
      if (Number(count) > 0 && gameData().items[kept]) this.addItem(kept, Number(count));
    }

    // Badges belong to the Pokémon that won them. A save from before that was
    // so hands what the run had earned to the Pokémon it was travelling with.
    if (!Array.isArray(this.active.badges)) {
      this.active.badges = [...(save.progress?.badges ?? [])];
      if (save.progress?.champion) this.active.champion = true;
    }
    for (const pokemon of this.box) {
      if (pokemon && !Array.isArray(pokemon.badges)) pokemon.badges = [];
    }
    this.trainerWins = save.progress?.trainerWins ?? 0;
    /** Trainer encounters still to pass before a leader lost to can return. */
    this.leaderRest = Number.isInteger(save.progress?.leaderRest) ? Math.max(0, save.progress.leaderRest) : 0;
    /** The purse: what trainers pay out and the shop takes. */
    this.money = Number.isFinite(save.progress?.money) ? save.progress.money : STARTING_MONEY;
    this.playtime = save.progress?.playtime ?? 0;
    /**
     * The playtime the last rare Pokémon was met at, which the clock for the
     * next one runs from (see `rare.mjs`). A save from before the clock
     * starts it now, rather than owing the whole run's walking at once.
     */
    this.rareSince = Number.isFinite(save.progress?.rareSince) ? save.progress.rareSince : this.playtime;
    /** @type {string[]} move slugs unlocked by using TMs */
    this.machines = [...(save.progress?.machines ?? [])];

    this.seen = new Set(save.dex?.seen ?? []);
    this.caught = new Set(save.dex?.caught ?? []);
    this.champions = new Set(save.dex?.champions ?? []);
    // A save that caught an Ogerpon before its masks came with it gets them
    // now.
    this.handOverOgerponMasks();

    /**
     * How the box was last sorted, for its tab to show and turn round.
     * @type {{key: 'dex'|'clear'|'shiny', reverse: boolean}}
     */
    this.boxSort = {
      key: ['dex', 'clear', 'shiny'].includes(save.boxSort?.key) ? save.boxSort.key : 'dex',
      reverse: Boolean(save.boxSort?.reverse),
    };

    /** @type {any} */
    this.autoBattle = normalizeAutoBattle(save.autoBattle);
    /** @type {any} */
    this.itemPolicy = normalizeItemPolicy(save.items);
    /** @type {string|null} */
    this.leagueRegion = save.progress?.leagueRegion ?? null;
    /**
     * The league challenge in progress, or null: the line-up it faces and how many rounds are won. It outlives stepping out
     * to prepare, so going back in carries on from the round reached rather
     * than rolling a new league.
     * @type {{region: string, alternate: string|null, round: number}|null}
     */
    this.leagueRun = save.progress?.leagueRun ?? null;
    /** The species the last wild Pokémon was, so the next is not the same again. */
    this.lastWildSpecies = /** @type {number|null} */ (null);

    this.area = this.findArea(save.progress?.areaId) ?? gameData().areas[0];
    /** How many events are left before the road moves on to somewhere else. */
    this.eventsHere = save.progress?.eventsHere ?? EVENTS_PER_AREA;
    this.autosaveTimer = AUTOSAVE_INTERVAL_MS;
    this.eventTimer = EVENT_INTERVAL_MS;
    this.events = new EventScheduler(save.progress?.events ?? {});

    /**
     * Pokémon defeated but not yet caught or let go. Deliberately not saved:
     * the tray is a moment's offer, not something to come back to days later.
     * @type {import('./pokemon.mjs').Pokemon[]}
     */
    this.tray = [];
  }

  /** The badges the travelling Pokémon holds. */
  get badges() {
    return (this.active.badges ??= []);
  }

  set badges(list) {
    this.active.badges = [...list];
  }

  /** Whether the travelling Pokémon has been crowned Champion. */
  get champion() {
    return Boolean(this.active.champion);
  }

  set champion(value) {
    if (value) this.active.champion = true;
    else delete this.active.champion;
  }

  /** @param {string|null|undefined} id */
  findArea(id) {
    return gameData().areas.find((area) => area.id === id) ?? null;
  }

  /**
   * Advance the timers that run while the companion is travelling.
   *
   * `eventRate` is how fast the event clock runs compared with everything
   * else: the field passes the hurry-up the player is holding down, and
   * passes 1 again the moment they let go. Only the event clock answers it —
   * the autosave and the playtime are the run's own pace and are not
   * something a held pointer should be able to wind on. The area rotation is
   * not here at all any more: it is counted in events rather than minutes.
   *
   * @param {number} deltaMs
   * @param {{eventRate?: number}} [options]
   * @returns {{autosave: boolean, event: boolean}}
   */
  tick(deltaMs, { eventRate = 1 } = {}) {
    this.playtime += deltaMs;
    this.autosaveTimer -= deltaMs;
    this.eventTimer -= deltaMs * Math.max(1, eventRate);

    const autosave = this.autosaveTimer <= 0;
    if (autosave) this.autosaveTimer = AUTOSAVE_INTERVAL_MS;

    const event = this.eventTimer <= 0;
    if (event) this.eventTimer = EVENT_INTERVAL_MS;

    return { autosave, event };
  }

  /**
   * Count off an event that actually happened, and say whether that was the
   * last one this area gets.
   *
   * The road used to move on after ten minutes on a clock, which took no
   * notice of the player: a run being clicked along went through a dozen
   * events in one place. Counting the events themselves means the scenery
   * changes at the pace the run is being played at.
   *
   * @returns {boolean} whether it is time to move on
   */
  countEvent() {
    this.eventsHere = Math.max(0, (this.eventsHere ?? EVENTS_PER_AREA) - 1);
    return this.eventsHere <= 0;
  }

  /**
   * Hold a defeated Pokémon for the player to catch or release. The tray keeps
   * the five most recent; anything older is let go on its own.
   * @param {import('./pokemon.mjs').Pokemon} pokemon
   */
  addToTray(pokemon) {
    this.tray.push(pokemon);
    while (this.tray.length > TRAY_LIMIT) this.tray.shift();
  }

  /** Move to a different area, never repeating the current one. */
  rotateArea() {
    const options = gameData().areas.filter((area) => area.id !== this.area.id);
    // The road mostly stays in the region it is in — a walk from Route 101 to
    // Route 1 and back to Route 102 reads as teleporting, not travelling — and
    // now and then crosses to the other one.
    const region = this.area.region ?? 'hoenn';
    const here = options.filter((area) => (area.region ?? 'hoenn') === region);
    const away = options.filter((area) => (area.region ?? 'hoenn') !== region);
    const pool = here.length && (!away.length || !this.rng.chance(REGION_CROSSING_CHANCE)) ? here : away;
    if (pool.length) this.area = this.rng.pick(pool);
    this.eventsHere = EVENTS_PER_AREA;
    return this.area;
  }

  /** @param {number} speciesId */
  markSeen(speciesId) {
    this.seen.add(speciesId);
  }

  /** @param {number} speciesId */
  markCaught(speciesId) {
    this.seen.add(speciesId);
    this.caught.add(speciesId);
  }

  /**
   * The odds a wild Pokémon is shiny: the usual one in 4096, or as many rolls
   * of it as a Shiny Charm in the bag gives (see the charm in `dex.mjs`).
   */
  get shinyOdds() {
    const rolls = Object.keys(this.bag ?? {})
      .filter((slug) => this.countOf(slug) > 0)
      .reduce((best, slug) => Math.max(best, itemOf(slug)?.charm?.shinyRolls ?? 1), 1);
    return shinyOddsFor(rolls);
  }

  /**
   * @param {string} item
   * @param {number} [count]
   */
  addItem(item, count = 1) {
    // One of anything the bag holds only one of, however it arrives — a
    // find, a reward, a held item handed back, or a save from before the rule.
    const most = oneAtATime(item) ? 1 : Infinity;
    this.bag[item] = Math.min(most, (this.bag[item] ?? 0) + count);
  }

  /**
   * @param {string} item
   * @param {number} [count]
   * @returns {boolean} whether the bag had enough
   */
  removeItem(item, count = 1) {
    const held = this.bag[item] ?? 0;
    if (held < count) return false;
    if (held === count) delete this.bag[item];
    else this.bag[item] = held - count;
    return true;
  }

  /** @param {string} item */
  countOf(item) {
    return this.bag[item] ?? 0;
  }

  /** Items in a pocket that the player actually holds. */
  pocket(pocket) {
    const items = gameData().items;
    return Object.entries(this.bag)
      .filter(([slug, count]) => count > 0 && items[slug]?.pocket === pocket)
      .map(([slug, count]) => ({ slug, count, item: items[slug] }));
  }

  /**
   * Every ball the player holds, for the capture screen, in the bag's own
   * fixed order: Poké, Great, Ultra, Master, then the special ones. Sorting by
   * price put the free-priced special balls ahead of a Poké Ball found late.
   */
  balls() {
    return this.pocket('pokeballs').sort(pocketOrder('pokeballs'));
  }

  /**
   * Put a Pokémon in the first free box space.
   * @param {import('./pokemon.mjs').Pokemon} pokemon
   * @returns {boolean} whether the box had room
   */
  storeInBox(pokemon) {
    // The first free space after the favourites, which keep the top rows.
    const favourites = this.box.findIndex((entry) => !entry?.favorite);
    const index = this.box.findIndex((entry, at) => !entry && at >= Math.max(0, favourites));
    if (index >= 0) this.box[index] = pokemon;
    else this.box.push(pokemon);
    this.markCaught(pokemon.speciesId);
    return true;
  }

  /**
   * Put Ogerpon's three masks in the bag, once an Ogerpon has been caught: in
   * the games they are had after catching it, and it is met wearing its Teal
   * Mask, bare. Only the ones not had already, in the bag or in any
   * Pokémon's hand — the games give one set, and a second Ogerpon brings no
   * second set; a mask lost with a released Pokémon comes back.
   *
   * @returns {string[]} the masks put in the bag
   */
  handOverOgerponMasks() {
    if (![...this.caught].some((id) => speciesOf(id)?.slug === 'ogerpon')) return [];
    const held = new Set([this.active, ...this.box].map((pokemon) => pokemon?.heldItem).filter(Boolean));
    const given = [...(HELD_FORMES.get('ogerpon')?.keys() ?? [])].filter(
      (mask) => gameData().items[mask] && this.countOf(mask) === 0 && !held.has(mask),
    );
    for (const mask of given) this.addItem(mask);
    return given;
  }

  /** Whether the box has no room: never, since it holds as many as are caught. */
  get boxFull() {
    return false;
  }

  /**
   * Put the box in order, favourites first however it is sorted, and the
   * empty spaces packed away at the end. The order is remembered, so the box
   * tab can show it and turn it round.
   *
   * - `dex`: by Pokédex number; turned round, from the highest down.
   * - `clear`: the ones that have beaten the League first, then the rest;
   *   turned round, the rest first. Each group in Pokédex order either way.
   * - `shiny`: the shiny ones first, then the rest; turned round, the rest
   *   first. Each group in Pokédex order either way.
   *
   * Two of the same species keep the order they were caught in.
   *
   * @param {'dex'|'clear'|'shiny'} key
   * @param {boolean} [reverse]
   */
  sortBox(key, reverse = false) {
    this.boxSort = { key, reverse };
    const dexOf = (pokemon) => {
      const species = speciesOf(pokemon.speciesId);
      return species?.dex ?? pokemon.speciesId;
    };
    const descending = key === 'dex' && reverse ? -1 : 1;
    const first = (pokemon) => (key === 'clear' ? Boolean(pokemon.champion) : key === 'shiny' ? Boolean(pokemon.shiny) : false);
    const group = (pokemon) => (key === 'dex' ? 0 : first(pokemon) !== reverse ? 0 : 1);
    const compare = (a, b) =>
      Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) ||
      group(a) - group(b) ||
      descending * (dexOf(a) - dexOf(b)) ||
      descending * (a.speciesId - b.speciesId) ||
      (a.caughtAt ?? 0) - (b.caughtAt ?? 0);
    this.box = this.box.filter(Boolean).sort(compare);
  }

  /**
   * Mark a Pokémon in the box as a favourite, or take the mark off. A
   * favourite goes to the top of the box, after the favourites already there
   * in the order they were marked; one no longer a favourite goes back to the
   * first space after them.
   *
   * @param {number} index
   * @returns {boolean} whether it is a favourite now
   */
  toggleFavorite(index) {
    const pokemon = this.box[index];
    if (!pokemon) return false;
    this.box.splice(index, 1);
    if (pokemon.favorite) delete pokemon.favorite;
    else pokemon.favorite = true;
    // Either way it lands right after the favourites: the last of them when
    // just marked, the first of the rest when just unmarked. The favourites
    // are kept together at the front, and anything else in their run — an
    // empty space left by a release — moves along behind them.
    const front = this.box.filter((entry) => entry?.favorite);
    const rest = this.box.filter((entry) => !entry?.favorite);
    this.box = [...front, pokemon, ...rest];
    return Boolean(pokemon.favorite);
  }

  /**
   * Swap the travelling Pokémon with one from the box.
   * @param {number} index
   */
  switchActive(index) {
    const chosen = this.box[index];
    if (!chosen) return null;
    // Whoever walks off takes its league challenge with it.
    this.leagueRun = null;
    this.box[index] = this.active;
    this.active = chosen;
    return chosen;
  }

  /** Heal the travelling Pokémon completely. */
  heal() {
    fullyHeal(this.active);
  }

  /**
   * What losing a battle leaves behind: one hit point, and a rest stop next.
   *
   * Nothing is healed. A companion that has just been knocked out walks on
   * with a single point and whatever it was suffering from, which is what
   * makes the forced rest stop worth reaching — and what makes the potions it
   * hands out worth carrying.
   */
  blackOut() {
    this.active.hp = 1;
    this.events.force('heal');
  }

  /** @returns {any} the JSON written to the save slot */
  toSave() {
    return {
      seed: this.rng.seed,
      party: { active: this.active, box: this.box },
      bag: this.bag,
      progress: {
        // Kept for the save list, which reads them without the Pokémon's data.
        badges: this.badges,
        champion: this.champion,
        trainerWins: this.trainerWins,
        leaderRest: this.leaderRest,
        money: this.money,
        playtime: Math.round(this.playtime),
        rareSince: Math.round(this.rareSince),
        areaId: this.area?.id ?? null,
        eventsHere: this.eventsHere,
        machines: this.machines,
        leagueRegion: this.leagueRegion,
        leagueRun: this.leagueRun,
        events: this.events.toJSON(),
      },
      dex: {
        seen: [...this.seen],
        caught: [...this.caught],
        champions: [...this.champions],
      },
      autoBattle: this.autoBattle,
      items: this.itemPolicy,
      boxSort: this.boxSort,
    };
  }

  /** Write the run to its slot. */
  async save() {
    await saves.write(this.slot, this.toSave());
  }
}

/**
 * The default auto-battle policy: lead with a stat boost, hinder a foe still
 * unhurt, heal at half health, and otherwise hit as hard as possible.
 */
export function defaultAutoBattle() {
  return {
    /**
     * The condition each kind of move starts with, until the player gives a
     * move one of its own: an attack always, a hindrance on a foe still
     * unhurt, a boost on the first turn, a field move on an empty field, a
     * heal at half health.
     */
    conditions: { damage: 'always', status: 'noStatus', stat: 'firstTurn', field: 'noField', heal: 'hpHalf' },
    /**
     * When each move may be used first, by the move, `never` included. A
     * condition that names a moment is answered before anything else;
     * `always` leaves the move to be used when nothing else is due.
     * @type {Record<string, string>}
     */
    moves: {},
    /**
     * When each move may be used second, by the move: looked at only once no
     * move's first condition has come round. A move without one has none.
     * @type {Record<string, string>}
     */
    second: {},
  };
}

/**
 * How the bag is used without being opened.
 *
 * `berries` are the player's restock choices in order of preference, any of
 * which may be left unset; `autoBerry` hands over the berry in the bag that
 * suits the companion best when none of them is in the bag. Both act on an
 * empty hand after a fight. `healing` names an item to throw,
 * or null for whatever fits the damage taken, and the health it is thrown
 * at — `never` for a player who
 * would rather do it by hand. `afterBattle` is how far a win tops the
 * companion back up from the bag: a key of `AFTER_BATTLE_TARGETS`, a full bar
 * unless the player says otherwise; `afterBattleStatus` cures its condition
 * as well, and `afterBattlePp` puts PP back into a move running low.
 */
export function defaultItemPolicy() {
  return {
    /** @type {Array<string|null>} */
    berries: [null, null, null],
    autoBerry: true,
    healing: { item: /** @type {string|null} */ (null), condition: 'hpThird' },
    afterBattle: 'full',
    afterBattleStatus: true,
    afterBattlePp: false,
  };
}

/** @param {any} policy */
export function normalizeItemPolicy(policy) {
  const fresh = defaultItemPolicy();
  if (!policy) return fresh;

  const berries = Array.isArray(policy.berries) ? policy.berries.slice(0, 3) : [];
  while (berries.length < 3) berries.push(null);

  return {
    berries: berries.map((slug) => slug || null),
    // A save from before the automatic berry existed takes the default: it
    // only ever steps in where the player's own order finds nothing.
    autoBerry: typeof policy.autoBerry === 'boolean' ? policy.autoBerry : fresh.autoBerry,
    healing: {
      item: policy.healing?.item ?? null,
      condition: policy.healing?.condition ?? fresh.healing.condition,
    },
    // A save from before the setting existed takes the default, like a new one.
    afterBattle: typeof policy.afterBattle === 'string' ? policy.afterBattle : fresh.afterBattle,
    // A save from before these switches cured a condition only on the way to
    // a full bar, and put no PP back.
    afterBattleStatus: typeof policy.afterBattleStatus === 'boolean'
      ? policy.afterBattleStatus
      : (typeof policy.afterBattle === 'string' ? policy.afterBattle === 'full' : fresh.afterBattleStatus),
    afterBattlePp: typeof policy.afterBattlePp === 'boolean' ? policy.afterBattlePp : fresh.afterBattlePp,
  };
}

/**
 * Bring a stored policy up to the shape the engine reads.
 *
 * Three older shapes are read for what they plainly meant. A policy carrying a
 * weight per category — numbers the player could not see the effect of — used
 * zero to mean "never", and one carrying a tick per category said the same
 * thing with a box. Either way the answer is a condition, so both fold into
 * the one field the engine now reads. And the mode a policy once carried —
 * damage first, or going round the slots — is dropped: what a moment does not
 * decide is now always the hardest hit.
 *
 * @param {any} policy
 */
export function normalizeAutoBattle(policy) {
  const fresh = defaultAutoBattle();
  if (!policy) return fresh;

  const conditions = { ...fresh.conditions, ...(policy.conditions ?? {}) };
  for (const category of Object.keys(fresh.conditions)) {
    const off = policy.use ? policy.use[category] === false : (policy.weights?.[category] ?? 1) <= 0;
    if (off) conditions[category] = 'never';
  }

  // Each move's own two conditions, as set on the auto-battle screen.
  /** @param {any} stored */
  const byMove = (stored) => {
    /** @type {Record<string, string>} */
    const out = {};
    for (const [slug, condition] of Object.entries(stored ?? {})) {
      if (typeof condition === 'string') out[slug] = condition;
    }
    return out;
  };

  return { conditions, moves: byMove(policy.moves), second: byMove(policy.second) };
}

/**
 * Whether the League's door is open to the travelling Pokémon: eight badges
 * of its own, and not yet crowned.
 *
 * @param {Session} session
 */
export function leagueOpen(session) {
  return session.badges.length >= BADGES_FOR_LEAGUE && !session.champion;
}
