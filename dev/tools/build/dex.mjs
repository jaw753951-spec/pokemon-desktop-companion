/**
 * Build the rule data the game runs on: species, moves, items and the type
 * chart, all with official Korean names and text.
 *
 * Rules follow the newest generation a thing exists in — Gen 9 for almost
 * everything, falling back through `VERSION_GROUP_PRIORITY` for species and
 * moves that Scarlet/Violet dropped.
 */
import { join } from 'node:path';

import { fetchBuffer, fetchJson, writeOut } from '../lib/http.mjs';
import { evaluateShowdownMoves, showdownEffect } from '../lib/showdown.mjs';
import { layOfficialKorean } from '../lib/official-text.mjs';
import {
  flavorBundle,
  genusBundle,
  idFromUrl,
  nameBundle,
  newestVersionGroupFor,
  STAT_KEYS,
} from '../lib/poke.mjs';
import { MAX_SPECIES, MOVE_FLAG_SET, POKEAPI, SHOWDOWN, VERSION_GROUP_PRIORITY } from '../sources.mjs';

/**
 * @param {{dataDir: string, sample: boolean, log: (message: string) => void, pool: <T>(task: () => Promise<T>) => Promise<T>}} context
 */
export async function buildDex({ dataDir, sample, log, pool }) {
  const limit = sample ? 40 : MAX_SPECIES;

  const types = await buildTypes(pool, log);
  const moves = await buildMoves(pool, log);
  const natures = await buildNatures(pool, log);
  const everyItem = await buildItems(pool, log, natures);
  const machines = await buildMachines(pool, log);
  const abilities = await buildAbilities(pool, log);
  const species = await buildSpecies(pool, log, limit);

  await attachShowdown(moves, log);
  await layOfficialKorean({ species, moves, abilities, items: everyItem }, log);

  // Which items the game ships is decided here rather than in the screens.
  const items = shippedItems(everyItem, { machines, moves, species, log });
  pruneHeldItems(species, items, log);

  await writeOut(join(dataDir, 'machines.json'), JSON.stringify(machines));
  await writeOut(join(dataDir, 'natures.json'), JSON.stringify(natures));
  await writeOut(join(dataDir, 'abilities.json'), JSON.stringify(abilities));
  await writeOut(join(dataDir, 'types.json'), JSON.stringify(types));
  await writeOut(join(dataDir, 'moves.json'), JSON.stringify(moves));
  await writeOut(join(dataDir, 'items.json'), JSON.stringify(items));
  await writeOut(join(dataDir, 'species.json'), JSON.stringify(species));

  return { types, moves, items, machines, natures, abilities, species };
}

/**
 * The items the game ships, which is everything but the ones it can never have
 * a use for.
 *
 * The line is not "does this work yet". A Mint changes a nature, an Ability
 * Capsule swaps an ability, a PP Up raises a move's PP, a vitamin raises
 * effort, a type-protection Berry softens a hit of one type — the save already
 * carries a nature, an ability, PP, effort and types, so each of those acts on
 * something this game has, whether or not the engine reads it today. Keeping
 * them means the bag is the bag of a Pokémon game, and implementing one later
 * is a change to the engine rather than to the data.
 *
 * What goes is what belongs to a system this game will not have: Mega Stones,
 * Z-Crystals, Dynamax Crystals and Tera Shards change forms; apricorns and TM
 * materials are crafting; curry, sandwiches and Pokéblock berries are cooking;
 * a bicycle and a Rod belong to a world with towns in it. And a handful named
 * one by one, of which the Exp. Share is the clearest: it splits experience
 * between party members, and this game walks a single Pokémon.
 *
 * Each kept item is marked with whether the engine reads it yet, so a screen
 * can say "no effect in this game yet" rather than leaving a player to find
 * out by using one.
 *
 * @param {Record<string, any>} items
 * @param {{machines: Record<string, string>, moves: Record<string, any>, species: Record<string, any>, log: (message: string) => void}} context
 */
function shippedItems(items, { machines, moves, species, log }) {
  /** Items some species evolves by, held or used — and the Linking Cord, which stands in for a trade. */
  const evolutionItems = new Set(['linking-cord']);
  for (const entry of Object.values(species)) {
    for (const evolution of entry.evolutions ?? []) {
      if (evolution.item) evolutionItems.add(evolution.item);
      if (evolution.heldItem) evolutionItems.add(evolution.heldItem);
      for (const held of evolution.heldItems ?? []) evolutionItems.add(held);
    }
  }

  /** @type {Record<string, any>} */
  const out = {};
  /** @type {Record<string, number>} */
  const dropped = {};

  // A TR teaches its move for good here, the way a TM does, so one whose
  // move a TM or HM already teaches is the same machine twice. Only the TRs
  // with a move of their own are carried.
  const taughtByTm = new Set(
    Object.keys(items)
      .filter((slug) => /^(tm|hm)\d+$/.test(slug) && machines[slug])
      .map((slug) => machines[slug]),
  );

  for (let [slug, item] of Object.entries(items)) {
    // A machine is only worth carrying if the move it teaches was shipped.
    if (item.pocket === 'machines' && !moves[machines[slug]]) {
      dropped['unknown move'] = (dropped['unknown move'] ?? 0) + 1;
      continue;
    }
    if (/^tr\d+$/.test(slug) && taughtByTm.has(machines[slug])) {
      dropped['the same as another item'] = (dropped['the same as another item'] ?? 0) + 1;
      continue;
    }

    // Effort is gone from the game — nothing earns it and nothing spends it —
    // so the vitamins, Power items, wings, mochi and the berries that undo it
    // have nothing left to act on.
    if (item.held?.on === 'effort' || item.use?.effort || item.use?.resetEffort) {
      dropped['effort is gone'] = (dropped['effort is gone'] ?? 0) + 1;
      continue;
    }

    const formItem = FORM_ITEMS[slug];
    if (formItem) item = { ...item, ...formItem, pocket: 'misc' };
    const charm = CHARM_ITEMS[slug];
    if (charm) item = { ...item, ...charm, pocket: 'key' };
    const calling = CALLING_ITEMS[slug];
    if (calling) item = { ...item, ...calling, pocket: 'key' };
    // Whatever some Pokémon evolves by stays, wherever PokeAPI filed it: a
    // Galarica Cuff is a story item there and a Slowpoke's way on here.
    const evolves = evolutionItems.has(slug);
    if (evolves && item.pocket === 'key') item = { ...item, pocket: 'misc' };

    const reason =
      KEPT_ITEMS[slug] || formItem || charm || calling || evolves ? null : RETIRED_ITEMS[slug] ?? RETIRED_CATEGORIES[item.category];
    if (reason) {
      dropped[reason] = (dropped[reason] ?? 0) + 1;
      continue;
    }

    out[slug] = {
      ...item,
      works:
        Boolean(item.use) ||
        Boolean(item.held) ||
        Boolean(item.capture) ||
        item.pocket === 'pokeballs' ||
        item.pocket === 'machines' ||
        Boolean(item.charm) ||
        Boolean(item.calls) ||
        evolutionItems.has(slug),
    };
  }

  const inert = Object.values(out).filter((item) => !item.works).length;
  log(`items ${Object.keys(out).length - inert} of them read by the engine, ${inert} waiting on one`);

  const summary = Object.entries(dropped)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason} ${count}`)
    .join(', ');
  log(`items ${Object.keys(out).length} kept, ${Object.values(dropped).reduce((a, b) => a + b, 0)} dropped (${summary})`);
  return out;
}

/**
 * Item categories that belong to systems this game does not have, and the
 * reason each one goes — which is also what would have to change for it to
 * come back.
 *
 * @type {Record<string, string>}
 */
const RETIRED_CATEGORIES = {
  'mega-stones': 'form changes',
  'dynamax-crystals': 'form changes',
  'z-crystals': 'form changes',
  'tera-shard': 'form changes',
  'species-candies': 'form changes',
  'tm-materials': 'crafting',
  'apricorn-box': 'crafting',
  'curry-ingredients': 'cooking',
  'sandwich-ingredients': 'cooking',
  picnic: 'cooking',
  'baking-only': 'cooking',
  mulch: 'berry growing',
  scarves: 'contests',
  spelunking: 'a world with towns in it',
  gameplay: 'a world with towns in it',
  'plot-advancement': 'a story',
  'event-items': 'a story',
  'data-cards': 'a story',
  'dex-completion': 'a story',
  collectibles: 'selling',
  loot: 'selling',
  unused: 'unused in the games too',
};

/**
 * The few that stay on their own account, because the category they were
 * filed under says nothing about what they are for. A Bottle Cap is listed as
 * loot and is really how a Pokémon's genes are maxed out.
 *
 * @type {Record<string, true>}
 */
const KEPT_ITEMS = {
  'bottle-cap': true,
  'gold-bottle-cap': true,
  // What a Honey Gather brings back, and what a Pokémon smells from off the
  // path: used from the bag, it calls the next wild Pokémon out.
  honey: true,
};

/**
 * The charms the games hand to a trainer who has done enough, and what each
 * does here: kept in the bag's key pocket, as the games keep them, never used
 * up, never found on the road or sold
 * (their category is their own, which the road's find pool and the shop both
 * leave out). PokeAPI files them as key items for a world with towns in it,
 * which would retire them.
 *
 * `charm.shinyRolls` is how many times a wild Pokémon is rolled for being
 * shiny while the charm is in the bag. The games roll three; here it is the
 * League's one prize, with no Masuda method or chain to stack on it, so it
 * rolls eight — about one in 512, where Sword and Shield's charm ends up
 * after five hundred of a species knocked out.
 *
 * @type {Record<string, {category: string, charm: {shinyRolls?: number}}>}
 */
const CHARM_ITEMS = {
  'shiny-charm': { category: 'charms', charm: { shinyRolls: 8 } },
};

/**
 * The key items that lead to a rare Pokémon: a ticket, a letter, a feather.
 * In the games each one opened the way to the Pokémon it names — the Member
 * Card to Darkrai's island, Oak's Letter to Shaymin's flowers, the Silver Wing
 * to Lugia's whirlpools — and here each one decides which rare Pokémon the
 * road turns up next (see `rare.mjs`). Kept in the key pocket and never used
 * up; found on the road, never sold. PokeAPI files them as story items, which
 * would retire them.
 *
 * `calls` is who the item leads to, met in that order, one at a time, until
 * every one of them is caught — the Eon Ticket's Latias and then Latios, the
 * Enigmatic Card's Ultra Beasts in the order Sun and Moon's task force hunts
 * them. Those Pokémon are met no other way. `pool` has them join the rare
 * draw instead, one picked at random among the legendaries like any other,
 * for as long as the item is in the bag: ten Ultra Beasts one after another
 * crowded out every other rare Pokémon for most of a day's walking.
 * `afterLeague` holds an item back until the save has a champion, as the
 * games kept the mythical Pokémon's tickets and Looker's card for after the
 * story. Only the items with an official Korean name are here, so the Old Sea
 * Map and the Aurora and Mystic Tickets, from a generation never released in
 * Korean, are not.
 *
 * @type {Record<string, {category: string, calls: string[], afterLeague?: boolean, pool?: boolean}>}
 */
const CALLING_ITEMS = {
  'eon-ticket': { category: 'calls', calls: ['latias', 'latios'] },
  'silver-wing': { category: 'calls', calls: ['lugia'] },
  'rainbow-wing': { category: 'calls', calls: ['ho-oh'] },
  'jade-orb': { category: 'calls', calls: ['rayquaza'] },
  'magma-stone': { category: 'calls', calls: ['heatran'] },
  'member-card': { category: 'calls', calls: ['darkrai'], afterLeague: true },
  'oaks-letter': { category: 'calls', calls: ['shaymin'], afterLeague: true },
  'azure-flute': { category: 'calls', calls: ['arceus'], afterLeague: true },
  'liberty-pass': { category: 'calls', calls: ['victini'], afterLeague: true },
  'enigmatic-card': {
    category: 'calls',
    calls: ['nihilego', 'buzzwole', 'pheromosa', 'xurkitree', 'kartana', 'celesteela', 'guzzlord', 'poipole', 'stakataka', 'blacephalon'],
    afterLeague: true,
    pool: true,
  },
};

/**
 * The legendaries' own items: what each does in this game, and the pocket it
 * goes in. PokeAPI files most of them as story or key items, which would
 * retire them; here they are how a legendary changes its shape (see
 * `forms.mjs`), so they are kept, put in the tools pocket where the bag can
 * hand them over or use them, and marked with the rule the engine reads.
 *
 * `held.on: 'forme'` is a held item whose whole effect is the forme it puts
 * its holder in; `use.forme` is a key item used from the bag, and kept.
 *
 * @type {Record<string, {held?: any, use?: any}>}
 */
const FORM_ITEMS = {
  'adamant-crystal': { held: { on: 'damage', species: ['dialga'], moveTypes: ['dragon', 'steel'], multiplier: 1.2 } },
  'lustrous-globe': { held: { on: 'damage', species: ['palkia'], moveTypes: ['dragon', 'water'], multiplier: 1.2 } },
  'griseous-orb': {},
  'blue-orb': { held: { on: 'forme' } },
  'red-orb': { held: { on: 'forme' } },
  'rusted-sword': { held: { on: 'forme' } },
  'rusted-shield': { held: { on: 'forme' } },
  'ultranecrozium-z--held': { held: { on: 'forme' } },
  'burn-drive': { held: { on: 'forme' } },
  'chill-drive': { held: { on: 'forme' } },
  'douse-drive': { held: { on: 'forme' } },
  'shock-drive': { held: { on: 'forme' } },
  ...Object.fromEntries(
    ['bug', 'dark', 'dragon', 'electric', 'fairy', 'fighting', 'fire', 'flying', 'ghost', 'grass', 'ground', 'ice',
      'poison', 'psychic', 'rock', 'steel', 'water'].map((type) => [`${type}-memory`, { held: { on: 'forme' } }]),
  ),
  'n-solarizer--merge': { use: { forme: true } },
  'n-lunarizer--merge': { use: { forme: true } },
  'dna-splicers': { use: { forme: true } },
  'prison-bottle': { use: { forme: true } },
  gracidea: { use: { forme: true } },
  'reveal-glass': { use: { forme: true } },
  'reins-of-unity': { use: { forme: true } },
  meteorite: { use: { forme: true } },
  'zygarde-cube': { use: { forme: true } },
  'rotom-catalog': { use: { forme: true } },
  // A Nectar is drunk: it changes an Oricorio's style and is gone.
  'red-nectar': { use: { forme: true, consumed: true } },
  'yellow-nectar': { use: { forme: true, consumed: true } },
  'pink-nectar': { use: { forme: true, consumed: true } },
  'purple-nectar': { use: { forme: true, consumed: true } },
};

/**
 * The few that go on their own account rather than by category.
 *
 * @type {Record<string, string>}
 */
const RETIRED_ITEMS = {
  // Let's Go's Nanab and Pinap Berries calm a Pokémon that moves about the
  // screen and bring extra candy; this game has neither.
  'silver-nanab-berry': 'catching',
  'golden-nanab-berry': 'catching',
  'silver-pinap-berry': 'catching',
  'golden-pinap-berry': 'catching',
  'exp-share': 'nothing to share with',
  'exp-share-gen6': 'nothing to share with',
  // Held items that do nothing for a companion fighting on its own: the
  // Eject Button and Eject Pack switch their holder out and the Shed Shell
  // lets it switch, but the companion has no one to switch to; the Smoke Ball
  // is for running away, which the companion never chooses; a Ring Target
  // only takes its own holder's immunities away; the Pass Orb is spent on
  // Pass Powers this game does not have.
  // Balls for one place the road never has: the Safari Zone's, the
  // Bug-Catching Contest's and the Dream World's.
  'safari-ball': 'a story',
  'sport-ball': 'a story',
  'dream-ball': 'a story',
  'eject-button': 'no use to a lone companion',
  'eject-pack': 'no use to a lone companion',
  'shed-shell': 'no use to a lone companion',
  'smoke-ball': 'no use to a lone companion',
  'ring-target': 'no use to a lone companion',
  'pass-orb': 'no use to a lone companion',
  'amulet-coin': 'selling',
  'luck-incense': 'selling',
  // Story and event items PokeAPI files among the ordinary ones: the Origin
  // Ball and the Legend Plate are handed over by the plot of Legends: Arceus,
  // a Park Ball only exists inside Pal Park's transfer, a Cherish Ball only
  // around an event Pokémon, and a Strange Ball only around one HOME moved.
  'laorigin-ball': 'a story',
  'legend-plate': 'a story',
  'park-ball': 'a story',
  'cherish-ball': 'a story',
  'lastrange-ball': 'a story',
  // Hisui's own balls and berry. Three of the balls share their names with
  // the ordinary Poké, Great and Ultra Balls — the bag listed each twice —
  // and the rest are about throwing distance and being unnoticed, neither of
  // which a companion's battle has. The Hopo Berry is fed from the satchel
  // and has never been held.
  'lapoke-ball': 'Hisui only',
  'lagreat-ball': 'Hisui only',
  'laultra-ball': 'Hisui only',
  'laheavy-ball': 'Hisui only',
  'laleaden-ball': 'Hisui only',
  'lagigaton-ball': 'Hisui only',
  'lafeather-ball': 'Hisui only',
  'lawing-ball': 'Hisui only',
  'lajet-ball': 'Hisui only',
  'hopo-berry': 'Hisui only',

  // One generation's or one region's version of something the bag already
  // has, doing the same thing under another name. The drinks and the
  // regional sweets are Potions and Full Heals; a companion is one Pokémon,
  // so a Sacred Ash is a Max Revive; the mochi, wings and Let's Go candies
  // are vitamins in other sizes; the incenses are breeding items whose held
  // effect another item already has; a Gem is a one-shot type booster; the
  // Blank Plate is a Silk Scarf that changes no Arceus. The five confusion
  // berries are one berry five times over, told apart only by which natures
  // they confuse.
  ...Object.fromEntries(
    [
      'fresh-water', 'soda-pop', 'lemonade', 'moomoo-milk', 'berry-juice', 'sweet-heart', 'energy-powder', 'energy-root',
      'heal-powder', 'lava-cookie', 'old-gateau', 'casteliacone', 'lumiose-galette', 'shalour-sable', 'big-malasada',
      'pewter-crunchies',
      'revival-herb', 'sacred-ash', 'max-honey',
      ...['health', 'muscle', 'resist', 'genius', 'clever', 'swift'].flatMap((stat) => [`${stat}-mochi`, `${stat}-wing`]),
      ...['health', 'mighty', 'tough', 'smart', 'courage', 'quick'].flatMap((stat) => [`${stat}-candy`, `${stat}-candy-l`, `${stat}-candy-xl`]),
      'dynamax-candy',
      'sea-incense', 'wave-incense', 'rock-incense', 'rose-incense', 'odd-incense', 'lax-incense', 'full-incense',
      'pure-incense',
      'blank-plate',
      ...['normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground', 'flying', 'psychic',
        'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy'].map((type) => `${type}-gem`),
      'enigma-berry', 'figy-berry', 'wiki-berry', 'mago-berry', 'aguav-berry', 'iapapa-berry',
    ].map((slug) => [slug, 'the same as another item']),
  ),
};

/** The 18 battle types with their Korean names and full damage relations. */
async function buildTypes(pool, log) {
  const index = await fetchJson(`${POKEAPI}/type/index.json`);
  /** @type {Record<string, any>} */
  const out = {};

  await Promise.all(
    index.results.map((entry) =>
      pool(async () => {
        const type = await fetchJson(`${POKEAPI}${entry.url.replace('/api/v2', '')}index.json`);
        if (type.name === 'unknown' || type.name === 'shadow') return;
        // Stellar is no type a Pokémon has — it is a Terastallization's, which
        // this game does not have. It is kept for its name and marked so the
        // lists of types leave it out.
        if (type.name === 'stellar') {
          const name = Object.fromEntries(
            Object.entries(nameBundle(type.names, type.name)).map(([code, text]) => [code, String(text).trim()]),
          );
          out[type.name] = { name, effectiveness: {}, special: true };
          return;
        }
        const relations = type.damage_relations;
        /** @type {Record<string, number>} */
        const effectiveness = {};
        for (const other of relations.double_damage_to) effectiveness[other.name] = 2;
        for (const other of relations.half_damage_to) effectiveness[other.name] = 0.5;
        for (const other of relations.no_damage_to) effectiveness[other.name] = 0;
        out[type.name] = { name: nameBundle(type.names, type.name), effectiveness };
      }),
    ),
  );

  log(`types ${Object.keys(out).length}`);
  return out;
}

/**
 * Moves nothing in this game can use.
 *
 * The five torques belong to Team Star's Starmobiles, the Paldea bosses this
 * game does not have; no Pokémon learns them, and the games give them no
 * description to show.
 */
export const RETIRED_MOVES = new Set([
  'blazing-torque',
  'wicked-torque',
  'noxious-torque',
  'combat-torque',
  'magical-torque',
]);

async function buildMoves(pool, log) {
  const index = await fetchJson(`${POKEAPI}/move/index.json`);
  /** @type {Record<string, any>} */
  const out = {};

  await Promise.all(
    index.results.map((entry) =>
      pool(async () => {
        const move = await fetchJson(`${POKEAPI}${entry.url.replace('/api/v2', '')}index.json`, {
          allowMissing: true,
        });
        if (!move || !move.type) return;
        // Colosseum's Shadow moves belong to Shadow Pokémon, which this game
        // does not have; nothing learns them and nothing ever named them in
        // Korean.
        if (move.type.name === 'shadow' || RETIRED_MOVES.has(move.name)) return;
        out[move.name] = {
          id: move.id,
          name: nameBundle(move.names, move.name),
          type: move.type.name,
          damageClass: move.damage_class?.name ?? 'status',
          power: move.power,
          accuracy: move.accuracy,
          pp: move.pp ?? 5,
          priority: move.priority ?? 0,
          target: move.target?.name ?? 'selected-pokemon',
          text: flavorBundle(move.flavor_text_entries),
          meta: move.meta
            ? {
                ailment: move.meta.ailment?.name ?? 'none',
                ailmentChance: move.meta.ailment_chance ?? 0,
                category: move.meta.category?.name ?? 'damage',
                critRate: move.meta.crit_rate ?? 0,
                drain: move.meta.drain ?? 0,
                healing: move.meta.healing ?? 0,
                flinchChance: move.meta.flinch_chance ?? 0,
                statChance: move.meta.stat_chance ?? 0,
                minHits: move.meta.min_hits,
                maxHits: move.meta.max_hits,
                minTurns: move.meta.min_turns,
                maxTurns: move.meta.max_turns,
              }
            : null,
          statChanges: (move.stat_changes ?? []).map((change) => ({
            stat: STAT_KEYS[change.stat.name] ?? change.stat.name,
            change: change.change,
          })),
        };
        const patch = MOVE_EFFECT_PATCHES[move.name];
        if (patch) out[move.name].meta = { ...(out[move.name].meta ?? EMPTY_META), ...patch };
      }),
    ),
  );

  // A Z-Move's special half is the same move as its physical half, and
  // PokeAPI describes it only as "Dummy Data".
  for (const [slug, move] of Object.entries(out)) {
    const twin = slug.endsWith('--special') ? out[slug.replace(/--special$/, '--physical')] : null;
    if (twin && !move.text?.en) move.text = { ...twin.text };
  }
  log(`moves ${Object.keys(out).length}`);
  return out;
}

/** A move PokeAPI files with no effect data at all. */
const EMPTY_META = {
  ailment: 'none',
  ailmentChance: 0,
  category: 'damage',
  critRate: 0,
  drain: 0,
  healing: 0,
  flinchChance: 0,
  statChance: 0,
  minHits: null,
  maxHits: null,
  minTurns: null,
  maxTurns: null,
};

/**
 * Side effects PokeAPI leaves off the newest moves, checked move by move
 * against Pokémon Showdown's table: every other move's chance of a condition
 * or a flinch agrees between the two. Without these a Wildbolt Storm never
 * paralyses and a Mountain Gale never flinches.
 *
 * @type {Record<string, Record<string, any>>}
 */
const MOVE_EFFECT_PATCHES = {
  'mountain-gale': { flinchChance: 30 },
  'triple-arrows': { flinchChance: 30 },
  'barb-barrage': { ailment: 'poison', ailmentChance: 50, category: 'damage-ailment' },
  'infernal-parade': { ailment: 'burn', ailmentChance: 30, category: 'damage-ailment' },
  'wildbolt-storm': { ailment: 'paralysis', ailmentChance: 20, category: 'damage-ailment' },
  'sandsear-storm': { ailment: 'burn', ailmentChance: 20, category: 'damage-ailment' },
  'axe-kick': { ailment: 'confusion', ailmentChance: 30, category: 'damage-ailment' },
  'mortal-spin': { ailment: 'poison', ailmentChance: 100, category: 'damage-ailment' },
  'matcha-gotcha': { ailment: 'burn', ailmentChance: 20, category: 'damage-ailment' },
  'malignant-chain': { ailment: 'poison', ailmentChance: 50, category: 'damage-ailment' },
  // These two only land on a target whose stats went up this turn; the
  // battle checks for that (\`RAISED_THIS_TURN_ONLY\`).
  'burning-jealousy': { ailment: 'burn', ailmentChance: 100, category: 'damage-ailment' },
  'alluring-voice': { ailment: 'confusion', ailmentChance: 100, category: 'damage-ailment' },
};

/**
 * Hang what Showdown knows about each move off it: its classification
 * (contact, punch, sound, powder and the rest of the flags the abilities and
 * held items are written against), who its stat changes land on, and the side
 * effects PokeAPI leaves out.
 *
 * PokeAPI files a Close Combat's Defense drop and a Growl's Attack drop the
 * same way, with nothing saying that one is the user's price and the other
 * the target's loss, and the Gen 8–9 moves arrive with no effect data at all —
 * a Population Bomb that hits once, a Bitter Blade that drains nothing. The
 * Showdown table states both, move by move, so it is read as the object it is
 * (see `lib/showdown.mjs`) and fills in whatever PokeAPI left empty; nothing
 * PokeAPI does state is overwritten. Anything whose number is missing or zero
 * is a Showdown invention (the CAP moves, the Z-move variants) and has no
 * move here to belong to.
 *
 * @param {Record<string, any>} moves
 * @param {(message: string) => void} log
 */
async function attachShowdown(moves, log) {
  const source = await fetchBuffer(`${SHOWDOWN}/moves.ts`, { allowMissing: true });
  if (!source) {
    for (const move of Object.values(moves)) move.flags = [];
    log('moves flags unavailable — the classification source could not be read');
    return;
  }

  /** @type {Map<number, any>} */
  const byNumber = new Map();
  for (const entry of Object.values(evaluateShowdownMoves(source.toString('utf8')))) {
    if (!entry?.num || entry.isZ || entry.isMax || entry.isNonstandard === 'CAP') continue;
    if (!byNumber.has(entry.num)) byNumber.set(entry.num, entry);
  }

  let flagged = 0;
  let filled = 0;
  for (const move of Object.values(moves)) {
    const sd = byNumber.get(move.id);
    move.flags = Object.keys(sd?.flags ?? {}).filter((flag) => sd.flags[flag] && MOVE_FLAG_SET.has(flag));
    if (move.flags.length) flagged++;
    if (!sd) continue;

    const effect = showdownEffect(sd);
    // A move that cannot miss is `true` there and 0 in PokeAPI's newest
    // entries; 0 read as a percentage is a move that never lands.
    if (effect.accuracy === null || move.accuracy === 0) move.accuracy = effect.accuracy ?? null;

    // Who each stage lands on is Showdown's to say; PokeAPI only lists them.
    if (effect.stats.length) {
      move.statChanges = effect.stats;
    } else {
      move.statChanges = (move.statChanges ?? []).map((change) => ({
        ...change,
        self: move.damageClass === 'status' && move.target === 'user',
        secondary: move.damageClass !== 'status',
      }));
    }

    const before = JSON.stringify(move.meta);
    const meta = { ...EMPTY_META, ...(move.meta ?? {}) };
    if (!meta.minHits && effect.minHits) {
      meta.minHits = effect.minHits;
      meta.maxHits = effect.maxHits;
    }
    if (!meta.drain && effect.drain) meta.drain = effect.drain;
    if (!meta.healing && effect.healing && move.damageClass === 'status') meta.healing = effect.healing;
    if (!meta.critRate && effect.critRate) meta.critRate = effect.critRate;
    if (!meta.statChance && effect.stats.length) meta.statChance = effect.statChance;
    if ((meta.ailment === 'none' || meta.ailment === 'unknown') && effect.secondary.ailment) {
      meta.ailment = effect.secondary.ailment;
      meta.ailmentChance = move.damageClass === 'status' ? 0 : effect.secondary.ailmentChance;
    }
    if (!meta.flinchChance && effect.secondary.flinchChance) meta.flinchChance = effect.secondary.flinchChance;
    if (effect.secondary.toxic) meta.toxic = true;
    if (effect.multiAccuracy) meta.multiAccuracy = true;
    move.meta = meta;
    if (JSON.stringify(meta) !== before) filled++;

    if (effect.ally) move.allyOnly = true;
    if (Object.keys(effect.rules).length) move.rules = effect.rules;
  }

  log(`moves ${flagged} classified (contact, punch, sound, powder and the rest), ${filled} given effect data`);
}

/**
 * The abilities, with their official names and the sentence that states what
 * each one does.
 *
 * Both texts are kept for the same reason the items keep theirs: the flavour
 * line is what a player is shown, and the effect line is the exact rule, which
 * is what lets the Pokémon screen say what an ability actually does rather
 * than repeating the cartridge's hint at it. Which of them the engine has
 * written is the engine's own business — `app/renderer/engine/abilities.mjs`
 * holds that list — so nothing here marks one as working or not.
 */
async function buildAbilities(pool, log) {
  const index = await fetchJson(`${POKEAPI}/ability/index.json`);
  /** @type {Record<string, any>} */
  const out = {};

  await Promise.all(
    index.results.map((entry) =>
      pool(async () => {
        const ability = await fetchJson(`${POKEAPI}${entry.url.replace('/api/v2', '')}index.json`, {
          allowMissing: true,
        });
        // The main series is the only one this game draws from; the side-game
        // abilities share the namespace and would never be rolled.
        if (!ability || ability.is_main_series === false) return;

        const effect = (ability.effect_entries ?? []).find((item) => item.language?.name === 'en');
        // A few abilities belong to mechanics this game will not have, so
        // keeping them would be keeping a rule that can never fire. Battle
        // Bond's and Power Construct's formes were removed from the games that
        // would carry them here; and the Mega-exclusive abilities hang off Mega
        // Stones, which the item filter below already retires.
        if (FORM_ONLY_ABILITIES.has(ability.name)) return;
        out[ability.name] = {
          id: ability.id,
          name: nameBundle(ability.names, ability.name),
          text: flavorBundle(ability.flavor_text_entries, 'flavor_text'),
          effect: effect?.short_effect ?? '',
        };
      }),
    ),
  );

  log(`abilities ${Object.keys(out).length}`);
  return out;
}

/**
 * The abilities that belong to a forme this game cannot reach, dropped at the
 * source so no species ever rolls one and no screen ever shows one.
 *
 * Each is a mechanic rather than a rule. The two Bond abilities ride
 * on Ash-Greninja and Complete Zygarde — formes the games themselves retired
 * from general play and this companion has no cutscene to earn. Zero to Hero
 * is the one that cannot follow the same road: it is Palafin's only ability,
 * so dropping it would leave the species pointing at nothing, and a Pokémon
 * carrying no ability at all is a worse lie than one carrying a rule the
 * battle never gets to use — a switch-out the game never calls for. It stays
 * as built data the screen shows as inert.
 *
 * @type {Set<string>}
 */
const FORM_ONLY_ABILITIES = new Set([
  'delta-stream',
  'battle-bond',
  'power-construct',
  // Legends: Z-A's new Mega Evolutions' abilities, which no Pokémon here can
  // have without the Mega Stone this game retires.
  'piercing-drill',
  'dragonize',
  'mega-sol',
  'spicy-spray',
  'eelevate',
  'fire-mane',
  'aura-guard',
  // Ogerpon's Embody Aspect acts only when it Terastallizes, which this game
  // does not have; the masks' own abilities stay.
  'embody-aspect',
]);
async function buildItems(pool, log, natures) {
  const categoryIndex = await fetchJson(`${POKEAPI}/item-category/index.json`);
  /** @type {Map<string, {url: string, pocket: string, category: string}>} */
  const wanted = new Map();

  await Promise.all(
    categoryIndex.results.map((entry) =>
      pool(async () => {
        const category = await fetchJson(`${POKEAPI}${entry.url.replace('/api/v2', '')}index.json`);
        const pocket = category.pocket?.name;
        if (!POCKETS.has(pocket)) return;
        for (const item of category.items) {
          wanted.set(item.name, { url: item.url, pocket, category: category.name });
        }
      }),
    ),
  );

  /** @type {Record<string, any>} */
  const out = {};
  await Promise.all(
    [...wanted.entries()].map(([name, meta]) =>
      pool(async () => {
        const item = await fetchJson(`${POKEAPI}${meta.url.replace('/api/v2', '')}index.json`, {
          allowMissing: true,
        });
        if (!item) return;
        out[name] = {
          id: item.id,
          name: nameBundle(item.names, item.name),
          pocket: meta.pocket,
          category: meta.category,
          cost: item.cost ?? 0,
          flingPower: item.fling_power,
          attributes: (item.attributes ?? []).map((attribute) => attribute.name),
          text: flavorBundle(item.flavor_text_entries, 'text'),
          held: heldEffect(item),
          use: useEffect(item),
          sprite: Boolean(item.sprites?.default),
        };
        unwritten(out[name], name, natures);
        corrected(out[name], name);
      }),
    ),
  );

  // What a berry turns into when a Natural Gift throws it. PokeAPI keeps the
  // powers Diamond and Pearl gave; X and Y raised every one of them by 20.
  const berries = await fetchJson(`${POKEAPI}/berry/index.json`);
  await Promise.all(
    berries.results.map((entry) =>
      pool(async () => {
        const berry = await fetchJson(`${POKEAPI}${entry.url.replace('/api/v2', '')}index.json`, { allowMissing: true });
        const item = berry && out[berry.item?.name];
        if (!item || !berry.natural_gift_power || !berry.natural_gift_type) return;
        item.naturalGift = { power: berry.natural_gift_power + NATURAL_GIFT_RAISE, type: berry.natural_gift_type.name };
      }),
    ),
  );

  // The seven Sweets are one item here: which cream and which sweet an
  // Alcremie comes out as is left to chance when it evolves, so a choice of
  // seven held items was seven names for nothing.
  const first = out[SWEET_SLUGS[0]];
  if (first) {
    out.sweet = {
      ...first,
      name: Object.fromEntries(Object.keys(first.name).map((code) => [code, SWEET_NAME[code] ?? SWEET_NAME.en])),
      text: Object.fromEntries(Object.keys(first.text).map((code) => [code, SWEET_TEXT[code] ?? SWEET_TEXT.en])),
    };
  }
  for (const slug of SWEET_SLUGS) delete out[slug];

  log(`items ${Object.keys(out).length} across ${[...POCKETS].join('/')}`);
  return out;
}

/**
 * Gender rates PokeAPI records wrongly. Oinkologne is filed as always male —
 * its species entry covers only the male variety since the female one was
 * split off — where Lechonk's even split carries on in the games.
 */
const GENDER_RATES = { oinkologne: 4 };

/** How much X and Y added to every berry's Natural Gift power. */
const NATURAL_GIFT_RAISE = 20;

/**
 * What an item does while a Pokémon is holding it, read from the one place
 * that states it exactly.
 *
 * The flavour text a player sees is deliberately vague — a Sitrus Berry
 * "restores a little HP" — but PokeAPI's short effect for the same item spells
 * the rule out: "Held: Consumed at 1/2 max HP to recover 1/4 max HP." Parsing
 * that leaves the berries behaving as they do in the games without a table of
 * numbers typed out here, which would be one more thing to keep in step with
 * the data.
 *
 * Anything whose effect is not one of these shapes — the type-resisting
 * berries, the ones that only matter when cooking — comes back null and is
 * simply carried.
 *
 * @param {any} item
 * @returns {any}
 */
function heldEffect(item) {
  const effect = (item.effect_entries ?? []).find((entry) => entry.language?.name === 'en');
  const text = (effect?.short_effect ?? '').replace(/[’']/g, "'");
  // Most held effects announce themselves; the ones that boost a named
  // species — a Thick Club, a Light Ball — simply say what they do, so the
  // opening words they use are allowed through too.
  if (!/^(?:Held:|Raises\b|Doubles\b|Increases\b|Boosts\b|When the holder\b)/i.test(text)) return null;

  const at = (match) => (match ? 1 / Number(match) : null);

  // ---- The berries, which are consumed when their moment comes.

  // "Consumed at 1/2 max HP to recover 1/4 max HP."
  const fraction = /Consumed at 1\/(\d) max HP to (?:recover|restore) 1\/(\d) (?:of its )?max HP/i.exec(text);
  if (fraction) return { on: 'hp', at: at(fraction[1]), heal: { fraction: 1 / Number(fraction[2]) } };

  // "Consumed at 1/2 max HP to recover 10 HP."
  const fixed = /Consumed at 1\/(\d) max HP to (?:recover|restore) (\d+) HP/i.exec(text);
  if (fixed) return { on: 'hp', at: at(fixed[1]), heal: { amount: Number(fixed[2]) } };

  // "Consumed at 1/4 max HP to boost Attack." — and one that rolls a stat.
  const boost = /Consumed at 1\/(\d) max HP to (?:sharply )?boost (?:its )?([A-Za-z ]+?)(?: by two stages)?\./i.exec(text);
  if (boost) {
    const stat = STAT_NAMES[boost[2].trim().toLowerCase()];
    const stages = /two stages/i.test(text) ? 2 : 1;
    if (stat) return { on: 'hp', at: at(boost[1]), stat, stages };
  }

  // The three pinch berries that buy something other than a stat: a Lansat's
  // critical hit ratio, a Micle's accuracy, a Custap's turn.
  const pinchCrit = /Consumed at 1\/(\d) max HP to boost critical hit ratio by (one|two) stages?/i.exec(text);
  if (pinchCrit) return { on: 'hp', at: at(pinchCrit[1]), crit: pinchCrit[2].toLowerCase() === 'two' ? 2 : 1 };

  const pinchAccuracy = /Consumed at 1\/(\d) max HP to boost accuracy of next move by (\d+)%/i.exec(text);
  if (pinchAccuracy) {
    return { on: 'hp', at: at(pinchAccuracy[1]), accuracy: 1 + Number(pinchAccuracy[2]) / 100 };
  }

  if (/Consumed at 1\/(\d) max HP when using a move to go first/i.test(text)) {
    const first = /Consumed at 1\/(\d) max HP/i.exec(text);
    return { on: 'hp', at: at(first?.[1]), first: true };
  }

  // "Consumed when paralyzed to cure paralysis." and its siblings.
  const cure = /Consumed when (paralyzed|asleep|poisoned|burned|frozen|confused) to cure/i.exec(text);
  if (cure) return { on: 'status', status: STATUS_NAMES[cure[1].toLowerCase()] };
  if (/Consumed to cure any status condition/i.test(text)) return { on: 'status', status: 'any' };

  // "Consumed when a move runs out of PP to restore its PP by 10."
  const pp = /Consumed when a move runs out of PP to restore its PP by (\d+)/i.exec(text);
  if (pp) return { on: 'pp', amount: Number(pp[1]) };

  // ---- The things that simply work while they are held.

  // "Poison-type holder recovers 1/16 max HP each turn. Non-Poison-Types take
  // 1/8 max HP damage." — the conditional one is read before the plain one.
  const sludge = /([A-Za-z]+)-type holder recovers 1\/(\d+).*?max HP each turn\..*?take 1\/(\d+).*?max HP damage/i.exec(text);
  if (sludge) {
    return {
      on: 'turn',
      type: sludge[1].toLowerCase(),
      heal: { fraction: 1 / Number(sludge[2]) },
      harm: { fraction: 1 / Number(sludge[3]) },
    };
  }
  const turn = /Restores 1\/(\d+).*?max HP at the end of each turn/i.exec(text);
  if (turn) return { on: 'turn', heal: { fraction: 1 / Number(turn[1]) } };

  // "Fire-Type moves from holder do 20% more damage."
  const typed = /([A-Za-z]+)-Type moves from holder do (\d+)% more damage/i.exec(text);
  if (typed) return { on: 'damage', moveType: typed[1].toLowerCase(), multiplier: 1 + Number(typed[2]) / 100 };

  // "Boosts the damage of physical moves used by the holder by 10%."
  const classed = /Boosts the damage of (physical|special) moves used by the holder by (?:1\/\d+ \()?(\d+)%/i.exec(text);
  if (classed) {
    return { on: 'damage', damageClass: classed[1].toLowerCase(), multiplier: 1 + Number(classed[2]) / 100 };
  }

  // "Holder's Super Effective moves do 20% extra damage."
  const superEffective = /Super Effective moves do (\d+)% extra damage/i.exec(text);
  if (superEffective) {
    return { on: 'damage', superEffective: true, multiplier: 1 + Number(superEffective[1]) / 100 };
  }

  // "Holder's moves inflict 30% extra damage, but cost 10% max HP."
  const orb = /moves inflict (\d+)% extra damage, but cost (\d+)% max HP/i.exec(text);
  if (orb) return { on: 'damage', multiplier: 1 + Number(orb[1]) / 100, cost: Number(orb[2]) / 100 };

  // "Increases Attack by 50%, but restricts the holder to only one move."
  const choice = /Increases ([A-Za-z ]+?) by (\d+)%, but restricts the holder to only one move/i.exec(text);
  if (choice) {
    const stat = STAT_NAMES[choice[1].trim().toLowerCase()];
    if (stat) return { on: 'stat', stats: [stat], multiplier: 1 + Number(choice[2]) / 100, lock: true };
  }

  // "Raises the holder's Special Defense to 1.5×. Prevents the holder from
  // selecting a status move."
  const vest = /Raises the holder's ([A-Za-z ]+?) to ([\d.]+)×/i.exec(text);
  if (vest) {
    const stat = STAT_NAMES[vest[1].trim().toLowerCase()];
    const noStatus = /Prevents the holder from selecting a status move/i.test(text);
    if (stat) return { on: 'stat', stats: [stat], multiplier: Number(vest[2]), noStatus };
  }

  // "Holder has 1.5× Defense and Special Defense, as long as it's not fully
  // evolved."
  const eviolite = /Holder has ([\d.]+)× Defense and Special Defense, as long as it's not fully evolved/i.exec(text);
  if (eviolite) return { on: 'stat', stats: ['def', 'spd'], multiplier: Number(eviolite[1]), unevolvedOnly: true };

  // "Raises the holder's critical hit ratio by one stage."
  if (/Raises the holder's critical hit ratio by one stage/i.test(text)) return { on: 'crit', stages: 1 };

  // "Holder survives any single-hit attack at 1 HP if at max HP."
  if (/survives any single-hit attack at 1 HP if at max HP/i.test(text)) {
    return { on: 'survive', fromFull: true, consumed: true };
  }
  const band = /Holder has (\d+)% chance to survive attacks.*?at 1 HP/i.exec(text);
  if (band) return { on: 'survive', chance: Number(band[1]) / 100 };

  // "Holder receives 1/8 of the damage it deals when attacking."
  const shell = /Holder receives 1\/(\d+) of the damage it deals when attacking/i.exec(text);
  if (shell) return { on: 'drain', fraction: 1 / Number(shell[1]) };

  // "Increases EXP earned in battle by 50%."
  const experience = /Increases EXP earned in battle by (\d+)%/i.exec(text);
  if (experience) return { on: 'experience', multiplier: 1 + Number(experience[1]) / 100 };

  // "Holder has a 3/16 (18.75%) chance to move first."
  const first = /chance to move first/i.test(text) ? /(\d+)\/(\d+)/.exec(text) : null;
  if (first) return { on: 'first', chance: Number(first[1]) / Number(first[2]) };

  // "Holder gains double effort values from battles, but has halved Speed."
  if (/gains double effort values from battles/i.test(text)) {
    return { on: 'effort', multiplier: 2, stats: ['spe'], speed: 0.5 };
  }

  // "Holder gains 4 Special Attack effort values, but has halved Speed in
  // battle." — the six weights, which pay in one stat rather than all of them.
  const weight = /Holder gains (\d+) ([A-Za-z ]+?) effort values, but has halved Speed/i.exec(text);
  if (weight) {
    const stat = STAT_NAMES[weight[2].trim().toLowerCase()];
    if (stat && stat !== 'random') {
      return { on: 'effort', bonus: { stat, amount: Number(weight[1]) }, stats: ['spe'], speed: 0.5 };
    }
  }

  // ---- What a held item says about being hit.

  // "Consumed when struck by a super-effective Fire-type attack to halve the
  // damage." — and the Chilan Berry, which does not wait for it to be super
  // effective because nothing is weak to Normal.
  const resist = /Consumed when struck by a (super-effective )?([A-Za-z]+)-type attack to halve the damage/i.exec(text);
  if (resist) {
    return {
      on: 'resist',
      moveType: resist[2].toLowerCase(),
      superEffectiveOnly: Boolean(resist[1]),
      multiplier: 0.5,
    };
  }

  // "Consumed when struck by a super-effective attack to restore 1/4 max HP."
  const enigma = /Consumed when struck by a super-effective attack to restore 1\/(\d+) max HP/i.exec(text);
  if (enigma) return { on: 'hurt', superEffective: true, heal: { fraction: 1 / Number(enigma[1]) }, consumed: true };

  // "When the holder is hit by a super effective move, its Attack and Special
  // Attack raise by two stages."
  const policy = /When the holder is hit by a super effective move, its ([A-Za-z ]+?) raise by (one|two) stages?/i.exec(text);
  if (policy) {
    const stats = statList(policy[1]);
    if (stats.length) {
      return { on: 'hurt', superEffective: true, stats, stages: policy[2].toLowerCase() === 'two' ? 2 : 1, consumed: true };
    }
  }

  // "Raises the holder's Special Attack by one stage when it takes Water-type
  // damage." and "If the holder is hit by a damaging Ice move, raises its
  // Attack by one stage." — the same rule, written two ways.
  const absorbed =
    /Raises the holder's ([A-Za-z ]+?) by (one|two) stages? when it takes ([A-Za-z]+)-type damage/i.exec(text) ??
    /If the holder is hit by a damaging ([A-Za-z]+) move, raises its ([A-Za-z ]+?) by (one|two) stages?/i.exec(text);
  if (absorbed) {
    // Which of the two sentences matched decides which group is which.
    const typed = /takes/i.test(absorbed[0]);
    const stats = statList(typed ? absorbed[1] : absorbed[2]);
    const stages = (typed ? absorbed[2] : absorbed[3]).toLowerCase() === 'two' ? 2 : 1;
    const moveType = (typed ? absorbed[3] : absorbed[1]).toLowerCase();
    if (stats.length) return { on: 'hurt', moveType, stats, stages, consumed: true };
  }

  // "When the holder is hit by a physical move, increases its Defense by one
  // stage." — the Kee and Maranga Berries.
  const guarded = /When the holder is hit by a (physical|special) move, increases its ([A-Za-z ]+?) by (one|two) stages?/i.exec(text);
  if (guarded) {
    const stats = statList(guarded[2]);
    const stages = guarded[3].toLowerCase() === 'two' ? 2 : 1;
    if (stats.length) return { on: 'hurt', damageClass: guarded[1].toLowerCase(), stats, stages, consumed: true };
  }

  // "Consumed to deal 1/8 attacker's max HP when holder is struck by a
  // physical attack." — the Jaboca and Rowap Berries.
  const thorn = /Consumed to deal 1\/(\d+) attacker's max HP when holder is struck by a (physical|special) attack/i.exec(text);
  if (thorn) {
    return { on: 'hurt', damageClass: thorn[2].toLowerCase(), recoil: { fraction: 1 / Number(thorn[1]) }, consumed: true };
  }

  // "When the holder is hit by a contact move, the attacking Pokémon takes 1/6
  // its max HP in damage."
  const helmet = /When the holder is hit by a contact move, the attacking Pok.mon takes 1\/(\d+) its max HP in damage/i.exec(text);
  if (helmet) return { on: 'contact', recoil: { fraction: 1 / Number(helmet[1]) } };

  // ---- What a held item keeps off its holder.

  // "Prevents damage from powder moves and the damage from Hail and Sandstorm."
  if (/Prevents damage from powder moves/i.test(text)) return { on: 'shield', flags: ['powder'], weather: true };

  // "Prevents side effects of contact moves used on the holder."
  if (/Prevents side effects of contact moves used on the holder/i.test(text)) {
    return { on: 'shield', contactEffects: true };
  }

  // "Grants immunity to Ground-type moves, Spikes, and Toxic Spikes. Consumed
  // when the holder takes damage from a move."
  const balloon = /Grants immunity to ([A-Za-z]+)-type moves/i.exec(text);
  if (balloon) return { on: 'immune', moveType: balloon[1].toLowerCase(), popped: true };

  // ---- What a held item does between turns, or to a turn.

  // "Resets all lowered stats to normal at end of turn. Consumed after use."
  if (/Resets all lowered stats to normal/i.test(text)) return { on: 'restore', consumed: true };

  // "Consumed to cure infatuation. Gen V: Also removes Taunt, Encore, Torment,
  // Disable, and Cursed Body." — everything a Mental Herb undoes is something
  // that took a move away, so it is read as one effect rather than five.
  if (/Consumed to cure infatuation/i.test(text)) return { on: 'free', consumed: true };

  // "Both turns of a two-turn charge move happen at once."
  if (/Both turns of a two-turn charge move happen at once/i.test(text)) return { on: 'charge', consumed: true };

  // "Inflicts Toxic on the holder at the end of the turn."
  const orbStatus = /Inflicts (Toxic|Burn|Poison|Paralysis|Sleep) on the holder at the end of the turn/i.exec(text);
  if (orbStatus) {
    const status = SELF_STATUS_NAMES[orbStatus[1].toLowerCase()];
    if (status) return { on: 'selfStatus', status };
  }

  // "Consumed on Electric Terrain and raises the holder's Defense by one stage."
  const seed = /Consumed on ([A-Za-z]+) Terrain and raises the holder's ([A-Za-z ]+?) by (one|two) stages?/i.exec(text);
  if (seed) {
    const stats = statList(seed[2]);
    if (stats.length) {
      return { on: 'terrain', terrain: seed[1].toLowerCase(), stats, stages: seed[3].toLowerCase() === 'two' ? 2 : 1, consumed: true };
    }
  }

  // "Damaging moves gain a 10% chance to make their target flinch."
  const flinch = /Damaging moves gain a (\d+)% chance to make their target flinch/i.exec(text);
  if (flinch) return { on: 'flinch', chance: Number(flinch[1]) / 100 };

  // "Holder moves last in its priority bracket."
  if (/Holder moves last in its priority bracket/i.test(text)) return { on: 'last' };

  // "Prevents level-based evolution from occuring." — the typo is upstream's.
  if (/Prevents level-based evolution/i.test(text)) return { on: 'noEvolve' };

  // ---- Accuracy, both directions.

  // "Provides a 1/5 (20%) boost in accuracy if the holder moves after the
  // target." — a Wide Lens says the same without the condition.
  const lens = /Provides a 1\/\d+ \((\d+)%\) boost in accuracy(?: if the holder moves after the target)?/i.exec(text);
  if (lens) {
    return { on: 'accuracy', multiplier: 1 + Number(lens[1]) / 100, movingLast: /moves after the target/i.test(text) };
  }

  // "Increases the holder's evasion by 1/9 (11 1/9%)." — evasion raised by a
  // ninth is what an attacker sees as nine tenths the accuracy.
  const evasion = /Increases the holder's evasion by 1\/(\d+)/i.exec(text);
  if (evasion) return { on: 'evasion', multiplier: 1 / (1 + 1 / Number(evasion[1])) };
  const evasionPercent = /Holder's evasion is increased by (\d+)%/i.exec(text);
  if (evasionPercent) return { on: 'evasion', multiplier: 1 / (1 + Number(evasionPercent[1]) / 100) };

  // ---- How long a field effect the holder set lasts.

  // "Sunny Day by the holder lasts 8 rounds instead of 5.", "Light Screen and
  // Reflect used by the holder last 8 rounds instead of 5.", and the Terrain
  // Extender, which says it a third way.
  const rock = /(Sunny Day|Rain Dance|Sandstorm|Hail|Snowscape|Light Screen and Reflect) (?:by|used by) the holder lasts? (\d+) rounds/i.exec(text);
  if (rock) {
    const what = /Screen/i.test(rock[1]) ? 'screen' : 'weather';
    return { on: 'extend', what, turns: Number(rock[2]) };
  }
  const extender = /Extends the holder's Terrain effects to (\d+) turns/i.exec(text);
  if (extender) return { on: 'extend', what: 'terrain', turns: Number(extender[1]) };

  // ---- The ones that only work for one Pokémon.

  // "Doubles Pikachu's Attack and Special Attack.", "Raises Ditto's Defense
  // and Special Defense by 50%."
  const speciesStat =
    /^(?:Held: )?(Doubles|Raises) ([A-Za-z'. ]+?)'s ((?:Attack|Defense|Speed|Special Attack|Special Defense|HP)(?: and (?:Attack|Defense|Speed|Special Attack|Special Defense|HP))?)(?: by (\d+)%)?(?: when held)?[.,]/i.exec(text);
  if (speciesStat) {
    const stats = statList(speciesStat[3]);
    const multiplier = speciesStat[4] ? 1 + Number(speciesStat[4]) / 100 : 2;
    const species = speciesList(speciesStat[2]);
    if (stats.length && species.length) return { on: 'stat', species, stats, multiplier };
  }

  // "Boosts the damage from Dialga's Dragon-type and Steel-type moves by 20%."
  const legendaryOrb = /Boosts the damage from ([A-Za-z'. ]+?)'s ([A-Za-z]+)-type and ([A-Za-z]+)-type moves by (\d+)%/i.exec(text);
  if (legendaryOrb) {
    return {
      on: 'damage',
      species: speciesList(legendaryOrb[1]),
      moveTypes: [legendaryOrb[2].toLowerCase(), legendaryOrb[3].toLowerCase()],
      multiplier: 1 + Number(legendaryOrb[4]) / 100,
    };
  }

  // "Raises Farfetch'd's critical hit ratio by two stages." — and the Scope
  // Lens, which says "the holder" where this says a name.
  const critRatio = /Raises ([A-Za-z'. ]+?)'s critical hit ratio by (one|two) stages?/i.exec(text);
  if (critRatio) {
    const stages = critRatio[2].toLowerCase() === 'two' ? 2 : 1;
    const holder = /^the holder$/i.test(critRatio[1].trim());
    return holder ? { on: 'crit', stages } : { on: 'crit', stages, species: speciesList(critRatio[1]) };
  }

  // "Holder's Speed is halved. Negates all Ground-type immunities" — an Iron
  // Ball costs Speed and drags its holder down to the ground.
  if (/Holder's Speed is halved\./i.test(text) && /Negates all Ground-type immunities/i.test(text)) {
    return { on: 'stat', stats: ['spe'], multiplier: 0.5, grounds: true };
  }

  // "Consectutive uses of the same attack have a cumulative damage boost of
  // 10%. Maximum 100% boost." — the typo is upstream's.
  const metronome = /uses of the same attack have a cumulative damage boost of (\d+)%\.\s*Maximum (\d+)% boost/i.exec(text);
  if (metronome) {
    return { on: 'damage', consecutive: Number(metronome[1]) / 100, max: 1 + Number(metronome[2]) / 100 };
  }

  return null;
}

/**
 * The stats an effect sentence names, in the engine's own keys.
 * @param {string} phrase for example "Attack and Special Attack"
 * @returns {string[]}
 */
function statList(phrase) {
  return phrase
    .split(/\s+and\s+/i)
    .map((part) => STAT_NAMES[part.trim().toLowerCase()])
    .filter((stat) => stat && stat !== 'random');
}

/**
 * The species an effect sentence names, as the slugs the dex files them under.
 *
 * "Cubone or Marowak" and "Latias and Latios" are both two Pokémon, and a
 * Farfetch'd is filed without its apostrophe, so the punctuation goes.
 *
 * @param {string} phrase
 * @returns {string[]}
 */
function speciesList(phrase) {
  return phrase
    .split(/\s+(?:or|and)\s+/i)
    .map((part) => part.trim().toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
}

/** The conditions an orb gives its own holder, as its effect text names them. */
const SELF_STATUS_NAMES = { toxic: 'psn', poison: 'psn', burn: 'brn', paralysis: 'par', sleep: 'slp' };

/**
 * What an item does when it is used on a Pokémon, from the same sentence the
 * held effects are read from.
 *
 * "Restores 20 HP." is a Potion; "Restores 10 PP for one move." is an Ether;
 * "Raises Attack effort and happiness." is a Protein. An item whose effect is
 * not one of these — a Mega Stone, a sandwich ingredient, an Exp. Share — comes
 * back null, and the build then leaves it out of the game altogether.
 *
 * @param {any} item
 * @returns {any}
 */
function useEffect(item) {
  const effect = (item.effect_entries ?? []).find((entry) => entry.language?.name === 'en');
  const text = (effect?.short_effect ?? '').replace(/[’']/g, "'");
  if (!text || text.startsWith('Held:')) return null;

  /** @type {any} */
  const use = {};

  // "Revives with half HP." — checked first, since a revival also restores HP
  // and would otherwise read as an ordinary potion.
  const revive = /Revives(?: [^.]+?)? with (half|full) HP/i.exec(text);
  if (revive) return { revive: revive[1].toLowerCase() === 'full' ? 1 : 0.5 };

  if (/Restores HP to full/i.test(text)) use.hp = 'full';
  const hp = /Restores (\d+) HP/i.exec(text);
  if (hp) use.hp = Number(hp[1]);

  // "Restores 10 PP for one move." and "Restores PP to full for each move."
  const pp = /Restores (?:(\d+) PP|PP to full) (?:for|of) (one|each|a single|all) move/i.exec(text);
  if (pp) use.pp = { amount: pp[1] ? Number(pp[1]) : 'full', scope: /each|all/i.test(pp[2]) ? 'all' : 'one' };

  // "Cures any status ailment.", "Cures all major status ailments and
  // confusion." — a Full Heal and a Big Malasada are the same medicine.
  if (/[Cc]ures (?:any|all)? ?(?:major )?status ailments?/.test(text)) use.status = 'any';
  const cure = /Cures (?:a |an )?(poison|paralysis|sleep|burn|freezing|frozen|infatuation|confusion)\b/i.exec(text);
  if (cure && !use.status) {
    const status = CURE_NAMES[cure[1].toLowerCase()];
    if (status) use.status = status;
  }

  // "Raises Attack effort and happiness." and the berries that undo it.
  const raise = /Raises ([A-Za-z ]+?)(?: effort)? and happiness/i.exec(text);
  if (raise) {
    const stat = STAT_NAMES[raise[1].trim().toLowerCase()];
    if (stat && stat !== 'random') use.effort = { stat, amount: EFFORT_STEP };
  }

  // "Increases HP effort by 1." — the six wings, which are a vitamin paid out
  // a point at a time.
  const wing = /Increases ([A-Za-z ]+?) effort by (\d+)/i.exec(text);
  if (wing && !use.effort) {
    const stat = STAT_NAMES[wing[1].trim().toLowerCase()];
    if (stat && stat !== 'random') use.effort = { stat, amount: Number(wing[2]) };
  }

  // "Raises a move's max PP by 20%." — a PP Up, and a PP Max, which says 60%
  // because it is the three of them at once.
  const ppUp = /Raises a move's max PP by (\d+)%/i.exec(text);
  if (ppUp) use.ppUp = { fraction: Number(ppUp[1]) / 100, max: PP_UP_LIMIT };

  // "Switches a Pokémon between its two possible (non-Hidden) Abilities."
  if (/Switches a Pok.mon between its two possible \(non-Hidden\) Abilities/i.test(text)) use.ability = 'swap';

  // "Trade to Mr. Hyper to maximize one of a Pokémon's genes." — there is no
  // Mr. Hyper here, so the Bottle Cap simply does what he would have.
  const caps = /maximize (one|all) of a Pok.mon's genes/i.exec(text);
  if (caps) use.genes = caps[1].toLowerCase() === 'all' ? 'all' : 'one';
  const drop = /Drops ([A-Za-z ]+?) Effort Values by (\d+)/i.exec(text);
  if (drop) {
    const stat = STAT_NAMES[drop[1].trim().toLowerCase()];
    if (stat && stat !== 'random') use.effort = { stat, amount: -Number(drop[2]) };
  }

  if (/Causes a level-up/i.test(text)) use.level = 1;

  return Object.keys(use).length > 0 ? use : null;
}

/**
 * The effects PokeAPI has no sentence for.
 *
 * Every other item in the bag states its own rule and is read from it, which
 * is the point of doing it that way — the numbers stay in the data. These are
 * the ones whose `short_effect` upstream is simply empty, so there is nothing
 * to read and the rule has to be written. Each is a family rather than a name:
 * a mint carries its nature in its slug, a candy its size, a mochi its stat,
 * so one rule covers the twenty-one mints rather than twenty-one lines.
 *
 * Anything not covered here keeps its empty effect and the bag says so.
 *
 * @param {any} item the record being built, modified in place
 * @param {string} slug
 * @param {Record<string, any>} natures
 */
function unwritten(item, slug, natures) {
  if (item.use || item.held) return;

  // A Mint is named for the nature it hands over.
  const mint = /^([a-z]+)-mint$/.exec(slug);
  if (mint && natures[mint[1]]) {
    item.use = { nature: mint[1] };
    return;
  }

  // An Exp. Candy is named for its size, and each size is worth what the
  // games pay for it.
  const candy = /^exp-candy-(xs|s|m|l|xl)$/.exec(slug);
  if (candy) {
    item.use = { experience: EXP_CANDY[candy[1]] };
    return;
  }

  // The Let's Go candies and the Scarlet/Violet mochi both raise one stat's
  // training; the candy says how much in its suffix, and a mochi is a vitamin
  // by another name.
  const training = /^(health|mighty|tough|smart|courage|quick)-candy(?:-(l|xl))?$/.exec(slug);
  if (training) {
    item.use = { effort: { stat: CANDY_STATS[training[1]], amount: CANDY_STEP[training[2] ?? 's'] } };
    return;
  }
  const mochi = /^(health|muscle|resist|genius|clever|swift)-mochi$/.exec(slug);
  if (mochi) {
    item.use = { effort: { stat: MOCHI_STATS[mochi[1]], amount: EFFORT_STEP } };
    return;
  }

  const written = UNWRITTEN[slug];
  if (written) Object.assign(item, written);
}

/**
 * Rules PokeAPI states for a generation long gone, or does not state at all,
 * written as the current games have them. Each replaces whatever the effect
 * sentence was parsed into.
 *
 * - The Sticky Barb hurts its holder each turn and jumps to whatever touches
 *   it; the sentence upstream reads like a Rocky Helmet.
 * - The Soul Dew has powered up Latias's and Latios's Psychic and Dragon moves
 *   since Gen 7; the Metal Powder and Quick Powder only work on a Ditto that
 *   has not transformed, and the Metal Powder doubles Defense alone.
 * - The Quick Claw uses its Gen 4+ numbers.
 * - The rest are the items whose effect is written nowhere upstream.
 *
 * @type {Record<string, {held?: any, use?: any, attributes?: string[], capture?: any, flingPower?: number}>}
 */
const CORRECTED = {
  'sticky-barb': { held: { on: 'turn', harm: { fraction: 1 / 8 }, sticky: true } },
  // Let's Go's catching berries, given from the capture screen: they make
  // the catch easier.
  'silver-razz-berry': { capture: { catchRate: 1.5 } },
  'golden-razz-berry': { capture: { catchRate: 2.5 } },
  // A fifth more for every repeat since Black and White, not a tenth.
  metronome: { held: { on: 'damage', consecutive: 0.2, max: 2 } },
  'soul-dew': { held: { on: 'damage', species: ['latias', 'latios'], moveTypes: ['psychic', 'dragon'], multiplier: 1.2 } },
  'metal-powder': { held: { on: 'stat', species: ['ditto'], stats: ['def'], multiplier: 2, untransformed: true } },
  'quick-powder': { held: { on: 'stat', species: ['ditto'], stats: ['spe'], multiplier: 2, untransformed: true } },
  'quick-claw': { held: { on: 'first', chance: 0.2 } },
  // Farfetch'd, its Galarian variety (by the species it belongs to) and the
  // Sirfetch'd that variety becomes.
  stick: { held: { on: 'crit', stages: 2, species: ['farfetchd', 'sirfetchd'] } },
  'toxic-orb': { held: { on: 'selfStatus', status: 'psn', toxic: true } },
  'booster-energy': { held: { on: 'booster' }, attributes: ['holdable', 'holdable-active'] },
  'room-service': { held: { on: 'room', stats: ['spe'], stages: -1, consumed: true } },
  'adrenaline-orb': { held: { on: 'intimidated', stats: ['spe'], stages: 1, consumed: true } },
  'big-root': { held: { on: 'drainBoost', multiplier: 1.3 } },
  'mirror-herb': { held: { on: 'mirror', consumed: true } },
  'ability-shield': { held: { on: 'shield', ability: true } },
  'binding-band': { held: { on: 'bind', fraction: 1 / 6 } },
  'grip-claw': { held: { on: 'bindTurns', turns: 7 } },
  'destiny-knot': { held: { on: 'destiny' } },
  'soothe-bell': { held: { on: 'friendship', multiplier: 1.5 } },
  'cleanse-tag': { held: { on: 'repel' } },
  'red-card': { held: { on: 'redCard', consumed: true } },
  'fresh-start-mochi': { use: { resetEffort: true } },
  honey: { use: { lure: true } },
  // Ogerpon's masks are thrown for 60, as the games throw them; PokeAPI has
  // no figure. An Ogerpon cannot throw the mask it wears (see `bindsItem`),
  // so it is anything else holding one that can.
  'wellspring-mask': { flingPower: 60 },
  'hearthflame-mask': { flingPower: 60 },
  'cornerstone-mask': { flingPower: 60 },
};

/**
 * Put the current games' rule on an item whose upstream sentence is old or
 * missing (see `CORRECTED`), and the two families that are rules by name: the
 * Gems, and the six Power items, which pay eight points of effort since Gen 7.
 *
 * @param {any} item the record being built, modified in place
 * @param {string} slug
 */
function corrected(item, slug) {
  const fix = CORRECTED[slug];
  if (fix?.held) item.held = fix.held;
  if (fix?.use) item.use = fix.use;
  if (fix?.capture) item.capture = fix.capture;
  if (fix?.flingPower) item.flingPower = fix.flingPower;
  if (fix?.attributes) item.attributes = [...new Set([...(item.attributes ?? []), ...fix.attributes])];

  const gem = /^([a-z]+)-gem$/.exec(slug);
  if (gem && gem[1] !== 'rare' && gem[1] !== 'star') {
    item.held = { on: 'gem', moveType: gem[1], multiplier: 1.3, consumed: true };
  }
  if (item.held?.on === 'effort' && item.held.bonus) {
    item.held = { ...item.held, bonus: { ...item.held.bonus, amount: POWER_ITEM_EFFORT } };
  }
}

/** What a Power item adds to the stat it names, per Pokémon defeated. */
const POWER_ITEM_EFFORT = 8;

/** What each size of Exp. Candy is worth, as the games pay it. */
const EXP_CANDY = { xs: 100, s: 800, m: 3000, l: 10000, xl: 30000 };

/** Which stat each Let's Go candy trains, from the name it is sold under. */
const CANDY_STATS = { health: 'hp', mighty: 'atk', tough: 'def', smart: 'spa', courage: 'spd', quick: 'spe' };

/** And how much of it, by the size on the wrapper. */
const CANDY_STEP = { s: 1, l: 3, xl: 10 };

/** Which stat each mochi trains. */
const MOCHI_STATS = { health: 'hp', muscle: 'atk', resist: 'def', genius: 'spa', clever: 'spd', swift: 'spe' };

/**
 * The handful that are neither a family nor documented — one line each, in the
 * same shape the parsers produce.
 *
 * @type {Record<string, {use?: any, held?: any}>}
 */
const UNWRITTEN = {
  // The Fairy type-protection berry, which the other seventeen describe and
  // this one does not.
  'roseli-berry': { held: { on: 'resist', moveType: 'fairy', superEffectiveOnly: true, multiplier: 0.5 } },
  // Hisui's Leppa Berry.
  'hopo-berry': { held: { on: 'pp', amount: 10 } },
  // "Raises Special Attack when the holder uses a sound move."
  'throat-spray': { held: { on: 'used', flags: ['sound'], stats: ['spa'], stages: 1, consumed: true } },
  // "Punching moves do 10% more damage and stop counting as contact."
  'punching-glove': { held: { on: 'damage', flags: ['punch'], multiplier: 1.1, dropsContact: true } },
  // "A multi-hit move always hits four or five times."
  'loaded-dice': { held: { on: 'multiHit', min: 4 } },
  'clear-amulet': { held: { on: 'shield', statDrops: true } },
  // "Steps over everything laid on the ground."
  'heavy-duty-boots': { held: { on: 'shield', hazards: true } },
  // The Fairy type booster, which the other seventeen document and this
  // newcomer does not.
  'fairy-feather': { held: { on: 'damage', moveType: 'fairy', multiplier: 1.2 } },
  // "Halves the holder's weight."
  'float-stone': { held: { on: 'weight', multiplier: 0.5 } },
  // Ogerpon's masks: a fifth more on every move it uses, and the forme and
  // the Ivy Cudgel type the mask stands for (see \`forms.mjs\`).
  'wellspring-mask': { held: { on: 'damage', species: ['ogerpon'], multiplier: 1.2 } },
  'hearthflame-mask': { held: { on: 'damage', species: ['ogerpon'], multiplier: 1.2 } },
  'cornerstone-mask': { held: { on: 'damage', species: ['ogerpon'], multiplier: 1.2 } },
  // The Ability Capsule's opposite number: it hands over the hidden ability
  // rather than swapping the two ordinary ones.
  'ability-patch': { use: { ability: 'hidden' } },
  'covert-cloak': { held: { on: 'shield', secondary: true } },
  'utility-umbrella': { held: { on: 'shield', weatherEffects: true } },
  // "Raises Speed by two stages when one of the holder's moves misses."
  'blunder-policy': { held: { on: 'miss', stats: ['spe'], stages: 2, consumed: true } },
};

/** How much effort a vitamin adds, as the games have always given. */
const EFFORT_STEP = 10;

/** The most a move's PP can be raised above its base, as the games cap it. */
const PP_UP_LIMIT = 0.6;

/** The conditions a medicine can cure, as its effect text names them. */
const CURE_NAMES = {
  poison: 'psn',
  paralysis: 'par',
  sleep: 'slp',
  burn: 'brn',
  freezing: 'frz',
  frozen: 'frz',
  confusion: 'cnf',
};

/** The stats a berry can raise, as the effect text names them. */
const STAT_NAMES = {
  hp: 'hp',
  attack: 'atk',
  defense: 'def',
  'special attack': 'spa',
  'special defense': 'spd',
  speed: 'spe',
  'a random stat': 'random',
};

/** The conditions a berry can cure, as the effect text names them. */
const STATUS_NAMES = {
  paralyzed: 'par',
  asleep: 'slp',
  poisoned: 'psn',
  burned: 'brn',
  frozen: 'frz',
  // Confusion ends with the battle rather than going into the save, so the
  // berry that cures it is read by the battle rather than by the bag.
  confused: 'cnf',
};

/**
 * Which move each TM/HM teaches. An item is reused across generations with
 * different moves, so the newest version group wins.
 * @returns {Promise<Record<string, string>>}
 */
async function buildMachines(pool, log) {
  const index = await fetchJson(`${POKEAPI}/machine/index.json`);
  /** @type {Map<string, {move: string, rank: number}>} */
  const best = new Map();

  await Promise.all(
    index.results.map((entry) =>
      pool(async () => {
        const machine = await fetchJson(`${POKEAPI}${entry.url.replace('/api/v2', '')}index.json`, {
          allowMissing: true,
        });
        if (!machine?.item || !machine.move) return;
        const rank = VERSION_GROUP_PRIORITY.indexOf(machine.version_group.name);
        const groupRank = rank < 0 ? Number.MAX_SAFE_INTEGER : rank;
        const previous = best.get(machine.item.name);
        if (!previous || groupRank < previous.rank) {
          best.set(machine.item.name, { move: machine.move.name, rank: groupRank });
        }
      }),
    ),
  );

  /** @type {Record<string, string>} */
  const out = {};
  for (const [item, value] of best) out[item] = value.move;
  log(`machines ${Object.keys(out).length}`);
  return out;
}

/**
 * The 25 natures, with the stat each one raises and lowers.
 * @returns {Promise<Record<string, any>>}
 */
async function buildNatures(pool, log) {
  const index = await fetchJson(`${POKEAPI}/nature/index.json`);
  /** @type {Record<string, any>} */
  const out = {};

  await Promise.all(
    index.results.map((entry) =>
      pool(async () => {
        const nature = await fetchJson(`${POKEAPI}${entry.url.replace('/api/v2', '')}index.json`);
        out[nature.name] = {
          name: nameBundle(nature.names, nature.name),
          increased: nature.increased_stat ? STAT_KEYS[nature.increased_stat.name] ?? null : null,
          decreased: nature.decreased_stat ? STAT_KEYS[nature.decreased_stat.name] ?? null : null,
        };
      }),
    ),
  );

  log(`natures ${Object.keys(out).length}`);
  return out;
}

/** Pockets the game surfaces in its inventory tabs. */
const POCKETS = new Set(['medicine', 'pokeballs', 'machines', 'berries', 'misc', 'key']);

async function buildSpecies(pool, log, limit) {
  const chains = new Map();
  /** @type {Record<string, any>} */
  const out = {};
  let done = 0;

  await Promise.all(
    Array.from({ length: limit }, (_, index) => index + 1).map((id) =>
      pool(async () => {
        const species = await fetchJson(`${POKEAPI}/pokemon-species/${id}/index.json`, { allowMissing: true });
        if (!species) return;

        const variety = species.varieties.find((entry) => entry.is_default) ?? species.varieties[0];
        const pokemon = await fetchJson(
          `${POKEAPI}${variety.pokemon.url.replace('/api/v2', '')}index.json`,
        );

        /** @type {Record<string, number>} */
        const stats = {};
        for (const stat of pokemon.stats) stats[STAT_KEYS[stat.stat.name] ?? stat.stat.name] = stat.base_stat;

        // The other varieties, with the rule each one changes its shape by —
        // weather, health, a held item, a turn spent below half. Only the
        // ones the battle can actually trigger are worth carrying; the rest
        // (regional forms, Mega, Gigantamax) would need a system this game
        // does not have, so they are not fetched at all.
        const forms = await buildForms(species);

        out[id] = {
          id,
          slug: species.name,
          name: nameBundle(species.names, species.name),
          genus: genusBundle(species.genera),
          types: pokemon.types.sort((a, b) => a.slot - b.slot).map((entry) => entry.type.name),
          stats,
          abilities: pokemon.abilities.map((entry) => ({
            name: entry.ability.name,
            hidden: entry.is_hidden,
          })),
          height: pokemon.height,
          weight: pokemon.weight,
          baseExp: pokemon.base_experience ?? 100,
          growthRate: species.growth_rate?.name ?? 'medium',
          captureRate: species.capture_rate ?? 45,
          baseHappiness: species.base_happiness ?? 50,
          genderRate: GENDER_RATES[species.name] ?? species.gender_rate,
          heldItems: wildHeldItems(pokemon.held_items),
          eggGroups: species.egg_groups.map((group) => group.name),
          habitat: species.habitat?.name ?? null,
          isLegendary: species.is_legendary,
          isMythical: species.is_mythical,
          isBaby: species.is_baby,
          evolvesFrom: species.evolves_from_species ? idFromUrl(species.evolves_from_species.url) : null,
          text: flavorBundle(species.flavor_text_entries),
          learnset: extractLearnset(pokemon.moves),
          evolutionChain: idFromUrl(species.evolution_chain.url),
          evolutions: [],
          forms,
          // The default variety's own name, which an evolution rule may use in
          // place of the species' (`urshifu-single-strike`); dropped once the
          // chains are walked.
          variety: pokemon.name,
          // Every variety's name, so an evolution into a form that is only a
          // look (a West Sea Gastrodon) can be told from one into a variety
          // this game does not carry; dropped with `variety`.
          varieties: species.varieties.map((entry) => entry.pokemon.name),
        };

        const chainId = out[id].evolutionChain;
        if (chainId && !chains.has(chainId)) chains.set(chainId, null);
        done++;
        if (done % 200 === 0) log(`species ${done}/${limit}`);
      }),
    ),
  );

  await addRegionalSpecies(out, pool);
  await attachEvolutions(out, chains, pool);
  log(`species ${Object.keys(out).length} (${Object.values(out).filter((entry) => entry.regional).length} regional)`);
  const formSpecies = Object.values(out).filter((entry) => entry.forms.length).length;
  const formCount = Object.values(out).reduce((total, entry) => total + entry.forms.length, 0);
  log(`species forms ${formCount} across ${formSpecies} species the battle can change`);
  return out;
}

/**
 * The regions a regional variety can be from, and what the Korean and English
 * games call a Pokémon from there.
 */
const REGIONS = {
  alola: { ko: '알로라', en: 'Alolan' },
  galar: { ko: '가라르', en: 'Galarian' },
  hisui: { ko: '히스이', en: 'Hisuian' },
  paldea: { ko: '팔데아', en: 'Paldean' },
};

/**
 * The form names PokeAPI does not have for a variety, in the Korean games' own
 * words (Scarlet/Violet's zkn_form) — the label the Pokédex puts under the
 * name, since the name itself is the species' own everywhere.
 *
 * @type {Record<string, {ko: string, en: string}|null>}
 */
const VARIETY_FORMS = {
  'tauros-paldea-combat-breed': { ko: '팔데아의 모습(컴뱃종)', en: 'Paldean Form (Combat Breed)' },
  'tauros-paldea-blaze-breed': { ko: '팔데아의 모습(블레이즈종)', en: 'Paldean Form (Blaze Breed)' },
  'tauros-paldea-aqua-breed': { ko: '팔데아의 모습(워터종)', en: 'Paldean Form (Aqua Breed)' },
  'basculin-white-striped': { ko: '백색근의 모습', en: 'White-Striped Form' },
  'urshifu-rapid-strike': { ko: '연격의 태세', en: 'Rapid Strike Style' },
  // The varieties below are not regional, but they are Pokémon of their own
  // in the same way: their own types, stats, abilities or moves, met in the
  // wild or evolved into by a rule of their own (see `VARIANT_EVOLUTIONS`).
  'lycanroc-midnight': { ko: '한밤중의 모습', en: 'Midnight Form' },
  'lycanroc-dusk': { ko: '황혼의 모습', en: 'Dusk Form' },
  'toxtricity-low-key': { ko: '로우한 모습', en: 'Low Key Form' },
  'indeedee-female': { ko: '암컷의 모습', en: 'Female' },
  'meowstic-female': { ko: '암컷의 모습', en: 'Female' },
  'oinkologne-female': { ko: '암컷의 모습', en: 'Female' },
  'basculegion-female': { ko: '암컷의 모습', en: 'Female' },
  'basculin-blue-striped': { ko: '청색근의 모습', en: 'Blue-Striped Form' },
  // The games label no form for it: it is Ursaluna, in the Pokédex as well.
  'ursaluna-bloodmoon': null,
  'wormadam-sandy': { ko: '모래땅도롱', en: 'Sandy Cloak' },
  'wormadam-trash': { ko: '슈레도롱', en: 'Trash Cloak' },
  'pumpkaboo-small': { ko: '작은 사이즈', en: 'Small Size' },
  'pumpkaboo-large': { ko: '큰 사이즈', en: 'Large Size' },
  'pumpkaboo-super': { ko: '특대 사이즈', en: 'Super Size' },
  'gourgeist-small': { ko: '작은 사이즈', en: 'Small Size' },
  'gourgeist-large': { ko: '큰 사이즈', en: 'Large Size' },
  'gourgeist-super': { ko: '특대 사이즈', en: 'Super Size' },
};

/**
 * Varieties kept as Pokémon of their own though their name names no region,
 * each with the tag that stands where a region would — which is also what an
 * evolution looks for to stay in the same variety (a small Pumpkaboo becomes
 * a small Gourgeist).
 *
 * @type {Map<string, string>}
 */
const VARIANTS = new Map([
  ['basculin-white-striped', 'other'],
  ['urshifu-rapid-strike', 'other'],
  ['lycanroc-midnight', 'midnight'],
  ['lycanroc-dusk', 'dusk'],
  ['toxtricity-low-key', 'low-key'],
  ['indeedee-female', 'female'],
  ['meowstic-female', 'female'],
  ['oinkologne-female', 'female'],
  ['basculegion-female', 'female'],
  ['basculin-blue-striped', 'blue-striped'],
  ['ursaluna-bloodmoon', 'bloodmoon'],
  ['wormadam-sandy', 'sandy'],
  ['wormadam-trash', 'trash'],
  ['pumpkaboo-small', 'small'],
  ['pumpkaboo-large', 'large'],
  ['pumpkaboo-super', 'super'],
  ['gourgeist-small', 'small'],
  ['gourgeist-large', 'large'],
  ['gourgeist-super', 'super'],
]);

/** The varieties that are the female of a species whose look differs by sex. */
const FEMALE_VARIANTS = new Set(['indeedee-female', 'meowstic-female', 'oinkologne-female', 'basculegion-female']);

/**
 * Whether a variety is a regional Pokémon: its own types, stats, moves and
 * evolutions, which the games treat as a different Pokémon under the same
 * number. A totem, a Zen Mode or a Pikachu in a cap is a forme, not one of
 * these.
 *
 * @param {string} name a variety's slug
 */
const isRegional = (name) =>
  VARIANTS.has(name) || (/-(alola|galar|hisui|paldea)(-|$)/.test(name) && !/totem|zen|cap/.test(name));

/**
 * Add every regional variety as a species of its own, under its variety id.
 *
 * An Alolan Vulpix is an Ice-type with its own moves and its own evolution,
 * and a Galarian Linoone is the only one that becomes an Obstagoon; filed
 * under the Kanto and Hoenn species they would be neither. Each keeps the
 * species' Pokédex number in `dex` and points back at it in `regional`, and
 * shares its genus, growth rate and the rest of what the species record
 * holds; types, stats, abilities, moves and held items are the variety's.
 *
 * @param {Record<string, any>} out
 * @param {<T>(task: () => Promise<T>) => Promise<T>} pool
 */
async function addRegionalSpecies(out, pool) {
  const bases = Object.values(out);
  await Promise.all(
    bases.map((base) =>
      pool(async () => {
        const species = await fetchJson(`${POKEAPI}/pokemon-species/${base.id}/index.json`);
        for (const variety of species.varieties) {
          if (variety.is_default || !isRegional(variety.pokemon.name)) continue;
          const pokemon = await fetchJson(`${POKEAPI}${variety.pokemon.url.replace('/api/v2', '')}index.json`);
          const formUrl = pokemon.forms?.[0]?.url;
          const form = formUrl
            ? await fetchJson(`${POKEAPI}${formUrl.replace('/api/v2', '')}index.json`, { allowMissing: true })
            : null;
          const id = idFromUrl(variety.pokemon.url);
          if (!id) continue;
          const region = Object.keys(REGIONS).find((key) => pokemon.name.includes(`-${key}`)) ?? null;
          const formName = nameBundle(form?.form_names ?? [], '');
          /** @type {Record<string, number>} */
          const stats = {};
          for (const stat of pokemon.stats) stats[STAT_KEYS[stat.stat.name] ?? stat.stat.name] = stat.base_stat;
          out[id] = {
            ...base,
            id,
            slug: pokemon.name,
            // The species' own name, as every screen of the games shows it —
            // an Alolan Raichu is a Raichu on its nameplate — with the form
            // beside it, for the Pokédex to put under the name.
            name: { ...base.name },
            ...(varietyForm(pokemon.name, region, formName) ? { form: varietyForm(pokemon.name, region, formName) } : {}),
            types: pokemon.types.sort((a, b) => a.slot - b.slot).map((entry) => entry.type.name),
            stats,
            abilities: pokemon.abilities.map((entry) => ({ name: entry.ability.name, hidden: entry.is_hidden })),
            height: pokemon.height,
            weight: pokemon.weight,
            baseExp: pokemon.base_experience ?? base.baseExp,
            heldItems: wildHeldItems(pokemon.held_items),
            learnset: extractLearnset(pokemon.moves),
            // Filled in with the rest of the chain's edges.
            evolvesFrom: null,
            evolutions: [],
            forms: [],
            dex: base.id,
            regional: region ?? VARIANTS.get(pokemon.name) ?? 'other',
            ...(FEMALE_VARIANTS.has(pokemon.name) ? { gender: 'female' } : {}),
          };
          // A female variety is where a female of the species goes.
          if (FEMALE_VARIANTS.has(pokemon.name)) base.femaleVariant = id;
          // A regional forme — a Galarian Darmanitan's Zen Mode — belongs to
          // the regional variety rather than to the species it shares a
          // record with.
          if (region) {
            out[id].forms = (base.forms ?? []).filter((form) => form.slug.includes(`-${region}`));
            base.forms = (base.forms ?? []).filter((form) => !form.slug.includes(`-${region}`));
          }
        }
      }),
    ),
  );
}

/**
 * The form label a variety carries, as the games' Pokédex labels it: "알로라의
 * 모습", "Alolan Form"; a Paldean Tauros's breed, a Pumpkaboo's size.
 *
 * @param {string} slug
 * @param {string|null} region
 * @param {Record<string, string>} formName PokeAPI's form name bundle
 * @returns {Record<string, string>|null} null for a variety the games label no form for
 */
function varietyForm(slug, region, formName) {
  if (VARIETY_FORMS[slug] === null) return null;
  /** @type {Record<string, string>} */
  const out = {};
  for (const [code, text] of Object.entries(formName)) if (text) out[code] = text;
  if (region && REGIONS[region]) {
    out.ko = `${REGIONS[region].ko}의 모습`;
    out.en = `${REGIONS[region].en} Form`;
  }
  return { ...out, ...(VARIETY_FORMS[slug] ?? {}) };
}

/**
 * Which varieties of a species the battle itself can change between, and what
 * each one looks like.
 *
 * Every non-default variety is fetched for its stats, types and sprite, but
 * only those whose forme hangs off a condition a battle provides are kept —
 * a weather Forecast, a Zen Mode below half, a Disguise broken by a hit, an
 * item a wild Pokémon can be rolled holding. The rest (regional forms, Mega,
 * Gigantamax, Origin, Crowned) would need a trainer to choose them or an item
 * this game retires, so they stay out of the data rather than in it dead.
 *
 * @param {any} species the `pokemon-species` record
 * @returns {Promise<Array<any>>}
 */
async function buildForms(species) {
  const trigger = FORM_TRIGGER.get(species.name);
  if (!trigger) return [];

  // A type-forme species (Arceus, Silvally, Genesect) has one variety and a
  // pokemon-form per plate, memory or drive; those are its formes.
  if (TYPE_FORMS.has(species.name)) return buildTypeForms(species, trigger);

  // Only the alternate formes the engine knows are kept, by the slugs
  // `forms.mjs` names for them — a species like Minior publishes a forme per
  // colour, all of which share the one behaviour, and keeping all of them
  // would be thirteen entries the battle can never tell apart.
  const formeSlugs = FORM_FORME.get(species.name);
  const wanted = species.varieties.filter(
    (variety) => !variety.is_default && idFromUrl(variety.pokemon.url) !== null,
  );
  const chosen = formeSlugs ? wanted.filter((variety) => formeSlugs.includes(variety.pokemon.name)) : wanted;
  if (!chosen.length) return [];

  // Fetched one after another rather than through the pool: this already
  // runs inside a pool task, and a species task waiting on tasks queued
  // behind the other species tasks is a deadlock once enough of them do.
  return Promise.all(
    chosen.map(async (variety) => {
      const pokemon = await fetchJson(
        `${POKEAPI}${variety.pokemon.url.replace('/api/v2', '')}index.json`,
      );
      // A variety has no names of its own; the forme it wears does — "우물의
      // 가면" for a masked Ogerpon — and the battle says it by that.
      const formUrl = pokemon.forms?.[0]?.url;
      const form = formUrl
        ? await fetchJson(`${POKEAPI}${formUrl.replace('/api/v2', '')}index.json`, { allowMissing: true })
        : null;
      const formeTrigger = FORME_TRIGGER.get(pokemon.name) ?? trigger;
      return {
        slug: pokemon.name,
        name: koreanForme(
          nameBundle(form?.form_names?.length ? form.form_names : pokemon.names, pokemon.name),
          pokemon.name,
          pokemon.types.map((entry) => entry.type.name),
        ),
        // The abilities a forme brings in place of the species' own, slot for
        // slot: a masked Ogerpon's Water Absorb, a Therian Landorus's
        // Intimidate. A forme an ability triggers keeps that ability, so it
        // carries none of its own.
        ...(OWN_ABILITY_TRIGGERS.has(formeTrigger) ? { abilities: abilityList(pokemon) } : {}),
        // The variety's numeric id, which is where the sprite step finds the
        // forme's picture — most alternate formes live under ids above
        // 10000 rather than beside the default one.
        id: idFromUrl(variety.pokemon.url),
        trigger: formeTrigger,
        types: pokemon.types.sort((a, b) => a.slot - b.slot).map((entry) => entry.type.name),
        stats: pokemon.stats.reduce((record, stat) => {
          record[STAT_KEYS[stat.stat.name] ?? stat.stat.name] = stat.base_stat;
          return record;
        }, {}),
        sprite: Boolean(pokemon.sprites?.other?.showdown?.front_default || pokemon.sprites?.front_default),
        // What a forme a player chooses can learn that the species cannot: a
        // Rider Calyrex's Glacial Lance, a Rotom's appliance move.
        ...(OWN_ABILITY_TRIGGERS.has(formeTrigger) ? { learnset: extractLearnset(pokemon.moves) } : {}),
      };
    }),
  );
}

/**
 * @param {any} pokemon a `pokemon` record
 * @returns {Array<{name: string, hidden: boolean}>}
 */
function abilityList(pokemon) {
  return (pokemon.abilities ?? [])
    .sort((a, b) => a.slot - b.slot)
    .map((entry) => ({ name: entry.ability.name, hidden: entry.is_hidden }));
}

/**
 * The formes of a species whose shapes are pokemon-forms of its one variety:
 * an Arceus per plate, a Silvally per memory, a Genesect per drive.
 *
 * They share the species' stats and ability. Arceus and Silvally take the
 * forme's type; a Genesect stays Bug and Steel whichever drive it carries.
 * Their pictures are filed by the form's own name (`493-fire`), which the
 * sprite step reads from `art`.
 *
 * @param {any} species
 * @param {string} trigger
 */
async function buildTypeForms(species, trigger) {
  const base = species.varieties.find((variety) => variety.is_default);
  const pokemon = await fetchJson(`${POKEAPI}${base.pokemon.url.replace('/api/v2', '')}index.json`);
  const stats = pokemon.stats.reduce((record, stat) => {
    record[STAT_KEYS[stat.stat.name] ?? stat.stat.name] = stat.base_stat;
    return record;
  }, {});
  const baseTypes = pokemon.types.sort((a, b) => a.slot - b.slot).map((entry) => entry.type.name);
  const forms = await Promise.all(
    (pokemon.forms ?? []).map((entry) =>
      fetchJson(`${POKEAPI}${entry.url.replace('/api/v2', '')}index.json`, { allowMissing: true }),
    ),
  );
  return forms
    .filter((form) => form && !form.is_default && form.form_name && form.form_name !== 'unknown')
    .map((form) => {
      const types = form.types?.length
        ? form.types.sort((a, b) => a.slot - b.slot).map((entry) => entry.type.name)
        : baseTypes;
      return {
        slug: form.name,
        name: koreanForme(nameBundle(form.form_names, form.name), form.name, types),
        id: idFromUrl(`/${form.id}/`),
        art: `${species.id}-${form.form_name}`,
        trigger,
        types,
        stats,
        sprite: Boolean(form.sprites?.front_default),
      };
    });
}

/**
 * The forme each battle-triggered species changes into, by the species that
 * owns it.
 *
 * PokeAPI publishes every published variety — Minior in seven colours and
 * Mimikyu as a totem twice over, and a Darmanitan whose Galar cousin shares
 * the species record — while the battle can only ever reach the one, which
 * this names. The forecast formes and the gulp-missile catches are the
 * exception: those wear a different shape per weather or per catch, and all
 * of them are reachable.
 *
 * @type {Map<string, string[]|null>}
 */
const FORM_FORME = new Map([
  ['castform', null],
  // The Galarian Zen Mode moves over to the Galarian variety once the
  // regional species are built.
  ['darmanitan', ['darmanitan-zen', 'darmanitan-galar-zen']],
  // A Rotom Catalog, a Nectar, and a Secret Sword.
  ['rotom', null],
  ['oricorio', null],
  ['keldeo', ['keldeo-resolute']],
  ['wishiwashi', ['wishiwashi-school']],
  ['minior', ['minior-red']],
  ['mimikyu', ['mimikyu-busted']],
  ['eiscue', ['eiscue-noice']],
  ['cramorant', null],
  // Stance Change and Hunger Switch.
  ['aegislash', ['aegislash-blade']],
  ['morpeko', ['morpeko-hangry']],
  // One forme per mask.
  ['ogerpon', null],
  // The legendaries' own: the ones a held item, a key item or a battle
  // brings on (see `forms.mjs` for which is which). Terapagos's Terastal and
  // Stellar Forms are left out with the Terastal phenomenon they belong to.
  ['necrozma', null],
  ['kyurem', null],
  ['hoopa', null],
  ['shaymin', null],
  ['tornadus', null],
  ['thundurus', null],
  ['landorus', null],
  ['enamorus', null],
  ['calyrex', null],
  ['deoxys', null],
  ['zygarde', ['zygarde-10']],
  ['meloetta', null],
  ['dialga', null],
  ['palkia', null],
  ['giratina', null],
  ['kyogre', null],
  ['groudon', null],
  ['zacian', null],
  ['zamazenta', null],
  ['arceus', null],
  ['silvally', null],
  ['genesect', null],
]);

/**
 * Korean names for the formes PokeAPI names only in English — the newest
 * ones — as the Korean games write them.
 *
 * @type {Record<string, string>}
 */
const FORME_NAMES_KO = {
  'dialga-origin': '오리진폼',
  'palkia-origin': '오리진폼',
  'enamorus-therian': '영물폼',
};

/** Arceus's formes are named by their type. @type {Record<string, string>} */
const TYPE_NAMES_KO = {
  normal: '노말', fire: '불꽃', water: '물', electric: '전기', grass: '풀', ice: '얼음', fighting: '격투',
  poison: '독', ground: '땅', flying: '비행', psychic: '에스퍼', bug: '벌레', rock: '바위', ghost: '고스트',
  dragon: '드래곤', dark: '악', steel: '강철', fairy: '페어리',
};

/**
 * @param {Record<string, string>} name a forme's name bundle
 * @param {string} slug
 * @param {string[]} types
 */
function koreanForme(name, slug, types) {
  if (name.ko && /[가-힣]/.test(name.ko)) return name;
  const ko = FORME_NAMES_KO[slug] ?? (slug.startsWith('arceus-') ? `${TYPE_NAMES_KO[types[0]]}타입` : null);
  return ko ? { ...name, ko } : name;
}

/** The species whose formes are pokemon-forms rather than varieties. */
const TYPE_FORMS = new Set(['arceus', 'silvally', 'genesect']);

/**
 * The triggers whose formes bring their own abilities: a held item, a key
 * item used from the bag, and the battle's opening.
 */
const OWN_ABILITY_TRIGGERS = new Set(['item', 'use', 'start']);

/**
 * A forme whose trigger is not its species': Necrozma fuses from the bag but
 * bursts in battle.
 *
 * @type {Map<string, string>}
 */
const FORME_TRIGGER = new Map([
  ['necrozma-ultra', 'start'],
]);

/**
 * The battle-triggered forme changes, by the species that owns them.
 *
 * Each trigger names the hook the engine runs it on: `enter` (weather on the
 * way in), `weather` (the sky moving over it), `turn` (end-of-turn health
 * checks), `hit` (a Disguise broken), `move` (a move the holder uses), and
 * `revert` (the condition that undid it has gone). `back` names the forme to
 * fall back to when the condition stops holding, when that differs from the
 * default one.
 *
 * @type {Map<string, string>}
 */
const FORM_TRIGGER = new Map([
  // Weather reads the sky the moment the Pokémon walks in.
  ['castform', 'weather'],
  // Health: Zen Mode below half, Schooling above a quarter, Shields Down the
  // other way round — the meteor up, the core down.
  ['darmanitan', 'turn'],
  ['wishiwashi', 'turn'],
  ['minior', 'turn'],
  // One hit to break, and the battle keeps it broken.
  ['mimikyu', 'hit'],
  ['eiscue', 'hit'],
  // A Surf or a Dive catches something, and it stays caught.
  ['cramorant', 'move'],
  // Blade to attack, Shield to guard; hungry every other turn.
  ['aegislash', 'move'],
  ['morpeko', 'turn'],
  // Whichever mask it is holding.
  ['ogerpon', 'item'],
  // Held items that are the Pokémon's shape wherever it is.
  ['dialga', 'item'],
  ['palkia', 'item'],
  ['giratina', 'item'],
  ['arceus', 'item'],
  ['silvally', 'item'],
  ['genesect', 'item'],
  // Held items that only take hold once a battle opens.
  ['kyogre', 'start'],
  ['groudon', 'start'],
  ['zacian', 'start'],
  ['zamazenta', 'start'],
  // Key items used from the bag.
  ['necrozma', 'use'],
  ['kyurem', 'use'],
  ['hoopa', 'use'],
  ['shaymin', 'use'],
  ['tornadus', 'use'],
  ['thundurus', 'use'],
  ['landorus', 'use'],
  ['enamorus', 'use'],
  ['calyrex', 'use'],
  ['deoxys', 'use'],
  ['zygarde', 'use'],
  // Relic Song turns it, and turns it back.
  ['meloetta', 'move'],
  // A Rotom in an appliance, an Oricorio that sipped a Nectar, a Keldeo that
  // knows Secret Sword: shapes it stands in outside a battle too.
  ['rotom', 'use'],
  ['oricorio', 'use'],
  ['keldeo', 'use'],
]);

/**
 * Forget any held-item slot naming something the game does not ship.
 *
 * A wild Nosepass carries a Star Piece in the cartridge, and a Star Piece is
 * one of the things dropped here because selling is not a system this game
 * has. A slot pointing at an item the bag could never hold would put a
 * Pokémon on the field holding nothing under a name, so it is emptied.
 *
 * @param {Record<string, any>} species
 * @param {Record<string, any>} items
 * @param {(message: string) => void} log
 */
function pruneHeldItems(species, items, log) {
  const dropped = new Set();
  for (const entry of Object.values(species)) {
    for (const slot of /** @type {const} */ (['common', 'rare'])) {
      const slug = entry.heldItems?.[slot];
      if (!slug || items[slug]) continue;
      dropped.add(slug);
      entry.heldItems[slot] = null;
    }
  }

  const carrying = Object.values(species).filter(
    (entry) => entry.heldItems?.common || entry.heldItems?.rare,
  ).length;
  log(`held items ${carrying} species carry one${dropped.size ? `, ${dropped.size} slots dropped with their item` : ''}`);
}

/**
 * The two held-item slots a wild Pokémon rolls from.
 *
 * The cartridges give a species two of them — a common one and a rare one —
 * and roll which, if either, the Pokémon out in the grass turns out to be
 * carrying. PokeAPI publishes the same table as a rarity per version, 50 for
 * the common slot and 5 for the rare one, so the two slots are read back out
 * of it. The newest version that lists anything wins, as everything else here
 * follows the newest generation.
 *
 * A rarity of 100 is a species that always carries the thing, which the
 * cartridges express by putting the same item in both slots — so that is what
 * it comes back as.
 *
 * @param {Array<any>} held
 * @returns {{common: string|null, rare: string|null}}
 */
function wildHeldItems(held) {
  /** @type {{common: string|null, rare: string|null}} */
  const slots = { common: null, rare: null };
  let bestRank = Number.MAX_SAFE_INTEGER;

  for (const entry of held ?? []) {
    for (const detail of entry.version_details ?? []) {
      const rank = VERSION_PRIORITY.indexOf(detail.version.name);
      if (rank < 0 || rank > bestRank) continue;
      // A newer version than anything seen so far replaces the lot: the two
      // slots belong to one generation's table, not to a mixture.
      if (rank < bestRank) {
        bestRank = rank;
        slots.common = null;
        slots.rare = null;
      }
      if (detail.rarity >= 100) {
        slots.common = entry.item.name;
        slots.rare = entry.item.name;
      } else if (detail.rarity >= 50) {
        slots.common = entry.item.name;
      } else if (detail.rarity > 0) {
        slots.rare = entry.item.name;
      }
    }
  }
  return slots;
}

/**
 * The versions a held-item table may be read from, newest first.
 *
 * `VERSION_GROUP_PRIORITY` names version groups; a held-item entry names a
 * version inside one, so the groups are spread back out into the versions
 * they contain.
 */
const VERSION_PRIORITY = [
  'scarlet', 'violet',
  'sword', 'shield',
  'brilliant-diamond', 'shining-pearl',
  'lets-go-pikachu', 'lets-go-eevee',
  'ultra-sun', 'ultra-moon',
  'sun', 'moon',
  'omega-ruby', 'alpha-sapphire',
  'x', 'y',
  'black-2', 'white-2',
  'black', 'white',
  'heartgold', 'soulsilver',
  'platinum',
  'diamond', 'pearl',
  'emerald',
  'firered', 'leafgreen',
  'ruby', 'sapphire',
  'crystal',
  'gold', 'silver',
  'yellow',
  'red', 'blue',
];

/**
 * Level-up and TM learnsets from the newest generation the Pokémon appears in.
 * @param {Array<any>} moves
 */
function extractLearnset(moves) {
  const levelGroup = newestVersionGroupFor(moves, 'level-up');
  const machineGroup = newestVersionGroupFor(moves, 'machine');

  /** @type {Array<[number, string]>} */
  const level = [];
  /** @type {Set<string>} */
  const machine = new Set();
  /** @type {Set<string>} */
  const tutor = new Set();

  for (const entry of moves) {
    for (const detail of entry.version_group_details) {
      const method = detail.move_learn_method.name;
      const group = detail.version_group.name;
      if (method === 'level-up' && group === levelGroup) level.push([detail.level_learned_at, entry.move.name]);
      else if (method === 'machine' && group === machineGroup) machine.add(entry.move.name);
      else if (method === 'tutor' && group === machineGroup) tutor.add(entry.move.name);
    }
  }

  level.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  return { level, machine: [...machine].sort(), tutor: [...tutor].sort() };
}

/**
 * Walk each evolution chain once and hang the outgoing edges off every species.
 * @param {Record<string, any>} species
 * @param {Map<number, unknown>} chains
 * @param {<T>(task: () => Promise<T>) => Promise<T>} pool
 */
async function attachEvolutions(species, chains, pool) {
  await Promise.all(
    [...chains.keys()].map((chainId) =>
      pool(async () => {
        const chain = await fetchJson(`${POKEAPI}/evolution-chain/${chainId}/index.json`, {
          allowMissing: true,
        });
        if (!chain) return;
        walkChain(chain.chain, species);
      }),
    ),
  );

  // Where one of several rules for the same evolution can be met here, the
  // others — an Eevee at Eterna Forest, a Magneton at Mt. Coronet — are
  // dropped; where none can, one is kept to say what it would have been.
  for (const entry of Object.values(species)) {
    const byTarget = new Map();
    for (const edge of entry.evolutions ?? []) byTarget.set(edge.to, [...(byTarget.get(edge.to) ?? []), edge]);
    entry.evolutions = [...byTarget.values()].flatMap((edges) => {
      let working = edges.filter(evolutionWorks);
      // Where a move has to be used so many times, merely knowing it (another
      // game's rule for the same evolution) does not count as well.
      const counted = working.find((edge) => edge.trigger === 'use-move');
      if (counted) working = working.filter((edge) => !(edge.trigger === 'level-up' && edge.knownMove === counted.usedMove));
      // One of each, whichever game it came from.
      const seen = new Set();
      working = working.filter((edge) => {
        const { fallback, ...rule } = edge;
        const key = JSON.stringify(rule);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return working.length ? working : edges.slice(0, 1);
    });
  }
  for (const entry of Object.values(species)) {
    delete entry.variety;
    delete entry.varieties;
  }
}

/**
 * Walk a chain and hang every way each species evolves off it.
 *
 * Every version's rule is kept, not only the first: a Magneton evolved at Mt.
 * Coronet in Diamond and by a Thunder Stone in Sword, and only the second is
 * something this game can do. A rule for a regional variety — a Galarian
 * Linoone to Obstagoon — hangs off that variety and leads to the variety it
 * names, rather than off the Hoenn Linoone.
 *
 * @param {any} node
 * @param {Record<string, any>} species
 */
function walkChain(node, species) {
  const fromId = idFromUrl(node.species.url);
  const bySlug = new Map(Object.values(species).map((entry) => [entry.slug, entry.id]));
  for (const child of node.evolves_to) {
    const childId = idFromUrl(child.species.url);
    for (const detail of child.evolution_details ?? []) {
      const source = bySlug.get(detail.required_pokemon_form?.name ?? '') ?? fromId;
      const from = source ? species[source] : null;
      if (!from || !species[childId]) continue;
      // A rule for a forme this game does not carry (Rapid Strike Urshifu)
      // leads nowhere it can go.
      const evolvedForm = detail.evolved_pokemon_form?.name;
      const plainForm = evolvedForm === species[childId].slug || evolvedForm === species[childId].variety;
      // A form that is only a look — a West Sea Gastrodon, a Meadow Vivillon,
      // an Antique Polteageist — is the species itself here; only a real
      // variety this game does not carry leads nowhere.
      const cosmetic = evolvedForm && !(species[childId].varieties ?? []).includes(evolvedForm);
      if (evolvedForm && !plainForm && !cosmetic && !bySlug.has(evolvedForm)) continue;
      let to = bySlug.get(evolvedForm ?? '') ?? childId;
      // A regional Pokémon evolves into the same region's variety of the next
      // one where there is one, even where the rule does not spell it out.
      if (from.regional && to === childId) {
        const sameRegion = bySlug.get(`${species[childId].slug}-${from.regional}`);
        if (sameRegion) to = sameRegion;
      }
      const edge = reachableEvolution(detail, species[to].slug, to);
      const key = JSON.stringify(edge);
      from.evolutions ??= [];
      if (!from.evolutions.some((known) => JSON.stringify(known) === key)) from.evolutions.push(edge);
      if (species[to].regional || species[to].evolvesFrom === null || from.regional) species[to].evolvesFrom = from.id;
    }
  }
  // An evolution only this game's other regions reach comes after the
  // ordinary one, so the ordinary one is what the same stone or level gives.
  for (const entry of [fromId].map((id) => species[id]).filter(Boolean)) {
    entry.evolutions?.sort((a, b) => Number(Boolean(a.region)) - Number(Boolean(b.region)));
  }
  for (const child of node.evolves_to) walkChain(child, species);
}

/**
 * One way to evolve, in the terms `pendingEvolution` reads.
 *
 * @param {any} detail an `evolution_details` entry
 * @param {string} toSlug
 * @param {number} to
 */
function reachableEvolution(detail, toSlug, to) {
  const heldName = detail.held_item?.name ?? null;
  const edge = {
    to,
    trigger: detail.trigger?.name ?? 'level-up',
    minLevel: detail.min_level ?? null,
    item: detail.item?.name ?? null,
    // Any of the seven Sweets is the one Sweet here.
    heldItem: SWEET_SLUGS.includes(heldName) ? 'sweet' : heldName,
    happiness: detail.min_happiness ?? detail.min_affection ?? null,
    timeOfDay: detail.time_of_day || null,
    knownMove: detail.known_move?.name ?? null,
    knownMoveType: detail.known_move_type?.name ?? null,
    location: detail.location?.name ?? null,
    gender: detail.gender ?? null,
    relativeStats: detail.relative_physical_stats ?? null,
    region: detail.region?.name ?? null,
    // A move used so many times (Rage Fist, for Annihilape).
    usedMove: detail.used_move?.name ?? null,
    moveCount: detail.min_move_count ?? null,
    // Someone in the party (the box, here): a Remoraid for a Mantyke, a
    // Dark type for a Pancham.
    partySpecies: detail.party_species ? idFromUrl(detail.party_species.url) : null,
    partyType: detail.party_type?.name ?? null,
    // Rain on the map, for a Sliggoo.
    rain: Boolean(detail.needs_overworld_rain),
  };
  // Affection is counted as friendship here, at the level friendship
  // evolutions ask for.
  if (detail.min_affection && !detail.min_happiness) edge.happiness = FRIENDSHIP_EVOLVES;
  Object.assign(edge, EVOLUTION_TWEAKS[toSlug] ?? {});
  if (evolutionWorks(edge)) return edge;
  const fallback = EVOLUTION_FALLBACKS[toSlug];
  if (!fallback) return edge;
  // What stands in keeps what it can of the original: an Alcremie still wants
  // its Sweet.
  return { ...edge, trigger: 'level-up', location: null, ...fallback, fallback: edge.trigger };
}

/**
 * Whether this game can ever meet a rule: a level, a friendship, a move it
 * knows, an item it holds or is given, a trade (a Linking Cord), or a Nincada
 * shedding.
 *
 * @param {any} edge
 */
function evolutionWorks(edge) {
  if (edge.region) return false;
  if (edge.trigger === 'use-item' || edge.trigger === 'trade' || edge.trigger === 'shed') return true;
  // Counted by the engine: uses of a move, and critical hits in one battle.
  if (edge.trigger === 'use-move' && edge.usedMove && edge.moveCount) return true;
  if (edge.trigger === 'three-critical-hits') return true;
  if (edge.trigger !== 'level-up') return false;
  if (edge.location) return false;
  return Boolean(
    edge.minLevel ||
      edge.happiness ||
      edge.knownMove ||
      edge.knownMoveType ||
      edge.heldItem ||
      edge.heldItems?.length ||
      edge.steps ||
      edge.recoil ||
      edge.partySpecies,
  );
}

/** The friendship an evolution by affection asks for, as friendship ones do. */
const FRIENDSHIP_EVOLVES = 160;

/**
 * Changes to a rule the games have that this game makes differently even
 * though it can meet it: a Cosmoem becomes Solgaleo by day and Lunala by
 * night rather than by which cartridge it is in.
 *
 * @type {Record<string, Record<string, any>>}
 */
const EVOLUTION_TWEAKS = {
  solgaleo: { timeOfDay: 'day' },
  lunala: { timeOfDay: 'night' },
  // A Rockruff with Own Tempo is the one that becomes the Dusk Form.
  'lycanroc-dusk': { ability: 'own-tempo' },
  // A Toxel's nature decides which Toxtricity it grows into.
  toxtricity: { natures: ['hardy', 'brave', 'adamant', 'naughty', 'docile', 'impish', 'lax', 'hasty', 'jolly', 'naive', 'rash', 'sassy', 'quirky'] },
  'toxtricity-low-key': { natures: ['lonely', 'bold', 'relaxed', 'timid', 'serious', 'modest', 'mild', 'quiet', 'bashful', 'calm', 'gentle', 'careful'] },
  // A Burmy's cloak is whatever it last stood on: sand and rock, or the
  // walls of a town, or anything growing.
  'wormadam-sandy': { areaTags: ['cave', 'desert', 'sand', 'mountain', 'rough', 'beach', 'volcano', 'ash'] },
  'wormadam-trash': { areaTags: ['urban', 'electric', 'ruins', 'graveyard'] },
};

/** The seven Sweets PokeAPI lists, which this game folds into one (`sweet`). */
const SWEET_SLUGS = ['strawberry-sweet', 'love-sweet', 'berry-sweet', 'clover-sweet', 'flower-sweet', 'star-sweet', 'ribbon-sweet'];
const SWEET_NAME = { ko: '사탕공예', en: 'Sweet' };
const SWEET_TEXT = {
  ko: '알록달록한 사탕공예. 마빌크에게 지니게 하면 빙빙 돌며 기뻐한다. 어떤 모습이 될지는 진화해 봐야 안다.',
  en: 'A colourful sweet. When a Milcery holds this, it spins around happily. What it turns into is left to chance.',
};

/** The Sweets a Milcery can be holding when it evolves. */
const SWEETS = ['sweet'];

/**
 * What stands in for a rule this game has no way to meet — a number of steps,
 * a move used twenty times, a tower climbed — by the Pokémon it leads to. The
 * levels are where the species' line would otherwise be at that point; the
 * items are ones only that line is ever given (see `signatureFind`).
 *
 * @type {Record<string, Record<string, any>>}
 */
const EVOLUTION_FALLBACKS = {
  // Twenty uses in a style this game has no styles for: twenty uses.
  overqwil: { trigger: 'use-move', usedMove: 'barb-barrage', moveCount: 20 },
  wyrdeer: { trigger: 'use-move', usedMove: 'psyshield-bash', moveCount: 20 },
  // Recoil taken without fainting, counted on the Pokémon.
  basculegion: { recoil: 294 },
  'basculegion-female': { recoil: 294 },
  // A thousand steps walked alongside, which a companion does all day.
  pawmot: { steps: 1000 },
  brambleghast: { steps: 1000 },
  rabsca: { steps: 1000 },
  // Levelling up in a battle, which is the only place this game levels up.
  maushold: { minLevel: 25 },
  // A rock arch this game has no map of: the level Yamask evolves at.
  runerigus: { minLevel: 34 },
  // Spun, with its Sweet held: levelled, with any Sweet held.
  alcremie: { heldItems: SWEETS },
  // Three Bisharp with their own crests beaten: levelled with the crest.
  kingambit: { heldItem: 'leaders-crest' },
  // The two towers, as their scrolls.
  urshifu: { trigger: 'use-item', item: 'scroll-of-darkness' },
  'urshifu-rapid-strike': { trigger: 'use-item', item: 'scroll-of-waters' },
  // Four hundred candies in another game: its level and one candy here.
  melmetal: { trigger: 'use-item', item: 'meltan-candy', minLevel: 48 },
  // A coin of its own, found now and then while a Gimmighoul travels.
  gholdengo: { trigger: 'use-item', item: 'gimmighoul-coin' },
};
