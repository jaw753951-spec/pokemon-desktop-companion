/**
 * Field events.
 *
 * Every event spawns whatever it involves beyond the right edge of the view
 * and lets the companion walk into it, so an encounter looks like something
 * met along the way rather than something that appeared on top of the player.
 * The runner owns the props and their timing; the field scene owns the walk.
 */
import { FIELD_HEIGHT, FIELD_WIDTH, FIRST_RUN_LEADER_STATS, leaderLevels, leaderOdds } from '../../shared/constants.mjs';
import { loadImage, loadSprite, Sprite } from '../core/assets.mjs';
import { artOf, gameData, itemOf, speciesOf } from '../core/data.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { BALL_TIERS } from '../../shared/ball-tiers.mjs';
import { TAG_TYPES } from '../../shared/area-tags.mjs';
import { alreadyOwned, priceOf } from '../engine/shop.mjs';
import { capRoster, evolveToLevel, giveTrainerItems, LEADER_PARTY_CAP, rollTrainer, rollWildPokemon } from '../engine/encounter.mjs';
import { createPokemon, levelOf } from '../engine/pokemon.mjs';
import { pickFind, signatureFind } from '../engine/items.mjs';
import { callingFind, rollRare } from '../engine/rare.mjs';
import {
  TRAINER_SCALE,
  actorScale,
  behindRoof,
  COMPANION_X,
  drawWalker,
  groundY,
  nearOverpass,
  POKEMON_SCALE,
  ROOF_COVER,
  waterDrop,
} from '../render/field.mjs';

/** How far either side of a Swimmer's spot must be water, in field pixels: about its own half-width. */
const SWIMMER_HALF_WIDTH = 10;

/** How long each gathering phase takes, as the brief specifies. */
const HARVEST_MS = 10000;
const PICKUP_MS = 5000;
const SHOW_ITEM_MS = 3000;

/** A prop spawns this far beyond the right edge of the field. */
const SPAWN_MARGIN = 24;

/**
 * The bob a gathering companion makes, in field pixels and milliseconds.
 *
 * Ten seconds of a Pokémon standing perfectly still in front of a berry tree
 * reads as the game having frozen. A small rise and fall on the spot — up
 * only, since it cannot sink into the road — is the whole of what says it is
 * busy with something.
 */
const GATHER_BOB_PX = 2;
const GATHER_BOB_MS = 460;

/** The phases the companion is working through something rather than waiting. */
const GATHERING = new Set(['gather']);

/**
 * How far off the ground the companion is at this point in a gather.
 *
 * On the motions' own clock ({@link lookClock}), so holding to hurry the
 * picking along makes it end sooner without the bob turning into a shake.
 *
 * @param {any} active
 * @returns {number} field pixels
 */
export function gatherBob(active) {
  if (!active || !GATHERING.has(active.phase)) return 0;
  const elapsed = lookClock(active);
  return Math.round(Math.abs(Math.sin((elapsed / GATHER_BOB_MS) * Math.PI)) * GATHER_BOB_PX);
}

/**
 * The clock an event's looping motions run on — a bob, a tree swaying, a
 * trainer's idle frames.
 *
 * `elapsed` is the event's progress, and holding hurries it six times over;
 * the motions that only show something going on go at most twice as fast
 * (`HOLD_BOOST_LOOK`), which reads as a hurry rather than a shake.
 *
 * @param {any} state
 */
export function lookClock(state) {
  return state?.shown ?? state?.elapsed ?? 0;
}

/**
 * How much road an event occupies either side of where it plays out, in field
 * pixels: the companion's own half-width behind the meeting spot, and the
 * widest prop — the Pokémon Center — in front of it.
 */
const EVENT_BEHIND = 24;
const EVENT_AHEAD = 80;

/**
 * The stretch of road the next event would play out on, if it started now.
 *
 * In the strip's own coordinates before wrapping: a point `x` of it is drawn
 * at the strip's column `x mod width`, the same way the background is.
 *
 * @param {number} offset the field's current world scroll
 * @returns {[number, number]}
 */
export function eventGround(offset) {
  const spawnAt = offset + (FIELD_WIDTH - COMPANION_X) + SPAWN_MARGIN;
  return [COMPANION_X + spawnAt - MEET_GAP - EVENT_BEHIND, COMPANION_X + spawnAt + EVENT_AHEAD];
}

/**
 * Move a prop on past a roof's edge if the edge would hide it whole.
 *
 * A roof the lane runs behind covers the lane's own block, so it holds no
 * event back: a trainer or a Pokémon Center standing there has its feet
 * behind the edge, as the companion does. A ball on the ground, or a Pokémon
 * no taller than that block, would not be there at all — so its spot is
 * walked on to the first open road past the roof, never onto a bridge.
 *
 * @param {{width: number, covered?: Array<[number, number, string?]>}|null|undefined} area
 * @param {any} state
 */
export function keepInSight(area, state) {
  const size = propSize(state);
  if (!size || size.height > ROOF_COVER || !area?.width) return;
  const half = size.width / 2;
  const clear = (worldX) => {
    const spot = COMPANION_X + worldX;
    return !behindRoof(area, [spot - half, spot + half])
      && !nearOverpass(area, [spot - MEET_GAP - EVENT_BEHIND, spot + EVENT_AHEAD]);
  };
  for (let step = 0; step * ROOF_STEP < area.width; step++) {
    const worldX = state.worldX + step * ROOF_STEP;
    if (clear(worldX)) {
      state.worldX = worldX;
      return;
    }
  }
}

/** How far at a time a prop is moved along to get out from behind a roof. */
const ROOF_STEP = 4;

/**
 * How big a prop is drawn, in field pixels, where it is small enough for that
 * to matter: a ball, or a wild Pokémon. Null for the rest, all of them taller
 * than anything a roof hides.
 *
 * @param {any} state
 * @returns {{width: number, height: number}|null}
 */
function propSize(state) {
  const prop = state?.prop;
  if (prop?.kind === 'ball') return { width: BALL_SIZE, height: BALL_SIZE };
  if (prop?.kind === 'pokemon') {
    const meta = artOf(prop.pokemon)?.meta;
    if (!meta) return null;
    return { width: meta.width * POKEMON_SCALE, height: meta.height * POKEMON_SCALE };
  }
  return null;
}

/**
 * How far to the companion's right the prop ends up. Without a gap the two
 * sprites land on the same spot and the companion hides whatever it met.
 * Field pixels, so about a tile and a bit at the size they are drawn.
 */
const MEET_GAP = 20;

/** How wide a ball lying on the path is drawn, in field pixels — under a tile. */
export const BALL_SIZE = 12;

/**
 * How long a collected ball takes to go, in milliseconds.
 *
 * The games have no picture of an opened item ball: the ball is one frame, and
 * the moment its contents are yours the object is simply gone from the map.
 * The lid this used to tip forward — half the icon squashed and slid sideways
 * over the other half — was an invention, and it looked like one. So the ball
 * opens by leaving: a short lift and fade while the companion holds up what
 * was inside it.
 */
export const BALL_FADE_MS = 520;

/**
 * @param {{
 *   session: import('../engine/session.mjs').Session,
 *   onBattle: (setup: {foes: any[], trainer: any|null, leader: any|null}) => void,
 * }} options
 */
export function createEventRunner({ session, onBattle }) {
  /** @type {any} */
  let active = null;

  return {
    /** Whether an event is currently holding the walk. */
    get busy() {
      return active !== null;
    },

    /** Whether the companion should keep moving this frame. */
    get walking() {
      // 'passing' is the walk-out of a finished rest stop: the companion is
      // back on the road, so the world scrolls on behind it as before.
      return active === null || active.phase === 'approach' || active.phase === 'passing';
    },

    /** Whether the companion is out of sight — inside a Pokémon Center or a gym. */
    get hidesActor() {
      return Boolean(active?.hidesActor);
    },

    /** How far the companion is off the ground — bobbing as it gathers, or
     * stepping through a door — in field pixels; null while nothing here
     * has it busy, when it bobs on the spot of its own accord.
     *
     * A busy companion's lift is its lift even at nought. It used to be
     * handed over as a plain number, so the bottom of each gathering bob —
     * a few frames of nought — read as "not busy" and dropped the companion
     * onto its idle bob, on a clock of its own, for those frames: a
     * pixel-high stutter on every beat of picking something up. */
    get actorLift() {
      const gathering = Boolean(active && GATHERING.has(active.phase));
      const stepping = Boolean(active?.phase === 'visit' && active.beat?.step);
      if (!gathering && !stepping) return null;
      return gatherBob(active) + doorStepOf(active).lift;
    },

    /** How much of the companion is showing: less of it as it steps indoors. */
    get actorAlpha() {
      return doorStepOf(active).alpha;
    },

    /**
     * The furthest the walk may carry the world before the event is met, or
     * null when nothing is being walked up to. The field holds the scroll
     * here, so a long frame cannot carry the companion past a door it was
     * meant to stop in front of.
     */
    get stopAt() {
      if (active?.phase !== 'approach') return null;
      return active.worldX - (active.meetGap ?? MEET_GAP);
    },

    /**
     * @param {import('../engine/events.mjs').EventKind} kind
     * @param {number} offset the field's current world scroll
     * @param {import('../core/app.mjs').App} app
     */
    start(kind, offset, app) {
      if (active) return;
      const spawnAt = offset + (FIELD_WIDTH - COMPANION_X) + SPAWN_MARGIN;

      switch (kind) {
        case 'berry':
          active = startBerry(session, spawnAt);
          break;
        case 'ball':
          active = startBall(session, spawnAt);
          break;
        case 'heal':
          active = startHeal(session, spawnAt);
          break;
        case 'wild':
          active = startWild(session, spawnAt);
          break;
        case 'trainer':
          active = startTrainer(session, spawnAt);
          break;
        default:
          active = null;
      }
      if (active) keepInSight(session.area, active);
    },

    /**
     * @param {number} deltaMs how far the event moves on, hurried if held
     * @param {number} offset
     * @param {import('../core/app.mjs').App} app
     * @param {number} [realMs] how far the looping motions move on — the time
     *   that passed, at most twice over when held ({@link lookClock})
     */
    update(deltaMs, offset, app, realMs = deltaMs) {
      if (!active) return;

      if (active.phase === 'approach') {
        if (offset >= active.worldX - (active.meetGap ?? MEET_GAP)) {
          active.phase = active.onArrive ? active.onArrive(app) : 'done';
          active.timer = active.phaseDuration ?? 0;
        }
        return;
      }

      active.timer -= deltaMs;
      active.elapsed = (active.elapsed ?? 0) + deltaMs;
      active.shown = (active.shown ?? 0) + realMs;
      if (active.timer > 0) return;


      // An event with a script of its own drives it one beat at a time; the
      // rest of them have only the three phases below.
      if (active.onTimer) {
        const next = active.onTimer(app);
        if (!next) {
          active = null;
          return;
        }
        active.phase = next.phase ?? active.phase;
        active.timer = next.duration;
        // A battle fought in the middle of a script — the leader inside the
        // gym — leaves the event where it is: the field holds still while the
        // fight is on, and the script picks up again after it.
        if (next.battle) onBattle(active.setup);
        return;
      }

      if (active.phase === 'gather') {
        active.phase = 'show';
        active.timer = SHOW_ITEM_MS;
        if (active.onGathered) active.onGathered(app);
        return;
      }

      if (active.phase === 'battle') {
        const setup = active.setup;
        active = null;
        onBattle(setup);
        return;
      }

      active = null;
    },

    /**
     * @param {CanvasRenderingContext2D} context
     * @param {number} offset
     */
    render(context, offset, actorHeight = 24) {
      if (!active) return;
      const screenX = COMPANION_X + (active.worldX - offset);

      if (active.prop && screenX < FIELD_WIDTH + 64) {
        drawProp(context, active, screenX);
      }
      if (active.phase === 'show' && active.carried) {
        drawCarried(context, active.carried, actorHeight);
      }
      if (active.flash > 0) {
        context.fillStyle = `rgba(255, 255, 255, ${Math.min(0.55, active.flash)})`;
        context.fillRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT);
        active.flash -= 0.02;
      }
    },

    /** Abandon whatever is running, e.g. when the area changes underneath it. */
    cancel() {
      active = null;
    },
  };
}

/**
 * How many berries one tree gives: a handful, as a tree in the games bears
 * several. One at a time, the restock order and the after-battle berries ate
 * through a find before the next tree turned up.
 */
export const BERRY_HARVEST = { min: 2, max: 4 };

/**
 * A berry tree grows at the roadside; the companion picks from it for ten
 * seconds, and the tree is left bare.
 */
function startBerry(session, spawnAt) {
  const berries = Object.entries(gameData().items)
    .filter(([, item]) => item.pocket === 'berries' && item.sprite)
    .map(([slug]) => slug);
  const berry = session.rng.pick(berries.length ? berries : ['oran-berry']);
  const count = firstRunSupply(session, session.rng.int(BERRY_HARVEST.min, BERRY_HARVEST.max));

  const trees = gameData().actors?.props?.berryTrees ?? {};
  const tree = treeFor(berry, trees);

  const state = {
    kind: 'berry',
    worldX: spawnAt,
    phase: 'approach',
    timer: 0,
    flash: 0,
    phaseDuration: HARVEST_MS,
    prop: { kind: 'berry-tree', sprite: null, frame: 'ripe' },
    carried: null,
    onArrive: () => 'gather',
    onGathered: (app) => {
      session.addItem(berry, count);
      state.prop.frame = 'bare';
      state.carried = { icon: `items/${berry}.png`, sprite: null, scale: CARRIED_BERRY_SCALE };
      loadImage(`items/${berry}.png`).then((image) => {
        state.carried.sprite = stillSprite(image);
      });
      app.audio.playJingle(gameData().bgm.cues.obtainBerry ?? null);
      app.toast(t('event.itemsFound', { name: localized(itemOf(berry)?.name, berry), count }));
    },
  };

  if (tree) {
    loadImage(`props/berry-trees/${tree}.png`).then((image) => {
      state.prop.sprite = { image, meta: trees[tree] };
    });
  }
  return state;
}

/**
 * Which tree sheet a berry grows on.
 *
 * Emerald drew thirty berry trees; this game carries every berry the series
 * has ever printed, so more than half of them — everything from Gen 4 on, and
 * a handful of Hoenn's own — have no tree of their own to grow on. They used
 * to fall back on `Object.keys(trees)[0]`, which is whichever sheet the asset
 * pipeline happened to finish downloading first: every one of those berries
 * grew on the same tree, and which tree that was changed between builds.
 *
 * A Hoenn berry without a sheet of its own grows on the one Emerald itself
 * puts it on ({@link EMERALD_TREES}) — an Apicot on a Grepa tree. Those used to
 * be hashed like the rest, and the Apicot's hash landed on the Kelpsy sheet,
 * whose fruit is one blue dot in the middle of a big pink plant: the companion
 * walked up to what looked like a tree with nothing on it.
 *
 * Every other berry without a sheet is given one by **its own name**, so the
 * roadside has the variety it looks like it should and a Roseli Berry is on
 * the same tree every time you meet one — out of the sheets whose fruit reads
 * as fruit. {@link FAINT_FRUIT} are left out of that draw, and so is any sheet
 * the build found no fruit on at all (`fruit: null`: its fruiting stage is the
 * same picture as its flowering one). A manifest from before the build checked
 * (no `fruit` at all) is trusted.
 *
 * @param {string} berry the item slug, e.g. `oran-berry`
 * @param {Record<string, any>} trees the sheets the build produced
 * @returns {string|null}
 */
export function treeFor(berry, trees) {
  const bears = (/** @type {string} */ name) => {
    const meta = trees[name];
    return Boolean(meta) && (!('fruit' in meta) || (Array.isArray(meta.fruit) && meta.fruit.length > 0));
  };
  // `oran-berry` is drawn by a tree sheet named `oran`.
  const own = berry.replace(/-berry$/, '');
  if (bears(own)) return own;
  const emerald = EMERALD_TREES[own];
  if (emerald && bears(emerald)) return emerald;

  const fruiting = Object.keys(trees).filter(bears).sort();
  const clear = fruiting.filter((name) => !FAINT_FRUIT.has(name));
  // A build where no sheet has fruit still grows the berry on something.
  const names = clear.length ? clear : fruiting.length ? fruiting : Object.keys(trees).sort();
  if (names.length === 0) return null;

  let hash = 0;
  for (let index = 0; index < own.length; index++) hash = (hash * 31 + own.charCodeAt(index)) >>> 0;
  return names[hash % names.length];
}

/**
 * The Hoenn berries Emerald draws on another berry's tree, as its
 * `gBerryTreePicTablePointers` assigns them.
 *
 * @type {Record<string, string>}
 */
export const EMERALD_TREES = {
  bluk: 'razz',
  nanab: 'mago',
  pinap: 'iapapa',
  qualot: 'wepear',
  magost: 'pomeg',
  watmel: 'rabuta',
  belue: 'hondew',
  ganlon: 'hondew',
  salac: 'aguav',
  petaya: 'pomeg',
  apicot: 'grepa',
  starf: 'cornn',
  enigma: 'durin',
};

/**
 * Sheets whose fruit is a dot or two against a large plant: right for their
 * own berry, which is what Emerald shows, but read as a bare tree when handed
 * to a berry that merely hashed onto them.
 */
export const FAINT_FRUIT = new Set(['kelpsy', 'leppa', 'durin', 'spelon']);

/**
 * A ball sits on the path. Which ball it is decides how good the item inside
 * is; the companion spends five seconds retrieving it.
 */
function startBall(session, spawnAt) {
  const tier = session.rng.weighted(BALL_TIERS.map((entry) => ({ value: entry, weight: entry.chance })))
    ?? BALL_TIERS[0];
  // A kept item — a Leftovers, a TM — is only ever found once: a second
  // would be a thing with nothing to do.
  const pool = (gameData().itemTiers[tier.ball] ?? []).filter(
    (slug) => !alreadyOwned(session, slug) && itemOf(slug)?.pocket !== 'berries',
  );
  // Now and then, the item the travelling legendary is waiting on, or a key
  // item that leads to a rare Pokémon.
  const item = signatureFind(session) ?? callingFind(session) ?? pickFind(session, pool) ?? 'poke-ball';
  const count = foundCount(session.rng, item, session.firstRun);

  const state = {
    kind: 'ball',
    worldX: spawnAt,
    phase: 'approach',
    timer: 0,
    flash: 0,
    phaseDuration: PICKUP_MS,
    prop: { kind: 'ball', sprite: null, frame: 'closed', ball: tier.ball },
    carried: null,
    onArrive: () => 'gather',
    onGathered: (app) => {
      session.addItem(item, count);
      state.prop.frame = 'open';
      // When it was opened, so the fade knows how far along it is.
      state.prop.openedAt = state.elapsed ?? 0;
      state.carried = { icon: `items/${item}.png`, sprite: null };
      loadImage(`items/${item}.png`).then((image) => {
        state.carried.sprite = stillSprite(image);
      });
      const cue = itemOf(item)?.pocket === 'machines' ? 'obtainTm' : 'obtainItem';
      app.audio.playJingle(gameData().bgm.cues[cue] ?? null);
      const name = localized(itemOf(item)?.name, item);
      app.toast(count > 1 ? t('event.itemsFound', { name, count }) : t('event.itemFound', { name }));
    },
  };

  loadImage(`items/${tier.ball}.png`).then((image) => {
    state.prop.sprite = { image, meta: { width: image.naturalWidth, height: image.naturalHeight, frames: 1 } };
  });
  return state;
}

/**
 * How many of a ball an item ball on the road holds, by what the ball is
 * worth: a handful of the everyday ones, a couple of the dear ones, and a
 * Master Ball alone. One ball at a time was spent on the next catch before
 * the next one turned up. Anything else is found one at a time.
 *
 * @type {Array<{upTo: number, min: number, max: number}>} cheapest first
 */
export const FOUND_BALLS = [
  { upTo: 1000, min: 3, max: 5 },
  { upTo: 10000, min: 2, max: 3 },
  { upTo: Infinity, min: 1, max: 1 },
];

/**
 * How many of an item one find on the road is: on the save's first run, more
 * of the everyday supplies (see `FIRST_RUN_SUPPLY_BONUS`) — but a Master Ball
 * is still found alone.
 *
 * @param {import('../core/rng.mjs').Rng} rng
 * @param {string} slug
 * @param {boolean} [firstRun]
 */
export function foundCount(rng, slug, firstRun = false) {
  const more = (/** @type {number} */ count) => (firstRun && isSupply(slug) ? withSupplyBonus(count) : count);
  if (itemOf(slug)?.pocket !== 'pokeballs') return more(1);
  const price = priceOf(slug) ?? Infinity;
  const band = FOUND_BALLS.find((entry) => price <= entry.upTo) ?? FOUND_BALLS[FOUND_BALLS.length - 1];
  const count = rng.int(band.min, band.max);
  return band.upTo === Infinity ? count : more(count);
}

/**
 * How much more of the everyday supplies — the healing items, the balls and
 * the berries — the save's first run comes by, from the road and the
 * Pokémon Center alike: half as much again, rounded up, so a find of one is
 * two. The first trip is the one with no money put by and no idea yet what
 * the road costs; after a champion it is the usual amounts.
 */
export const FIRST_RUN_SUPPLY_BONUS = 1.5;

/** The medicine that counts as a supply: what restores HP, cures, revives or restores PP. */
const SUPPLY_MEDICINE = new Set(['healing', 'status-cures', 'revival', 'pp-recovery']);

/**
 * Whether an item is one of the everyday supplies the first run finds more
 * of. A mint, a Rare Candy or an Ability Capsule is medicine but not one.
 *
 * @param {string} slug
 */
export function isSupply(slug) {
  const item = itemOf(slug);
  if (!item) return false;
  if (item.pocket === 'pokeballs' || item.pocket === 'berries') return true;
  return item.pocket === 'medicine' && SUPPLY_MEDICINE.has(item.category);
}

/** @param {number} count */
const withSupplyBonus = (count) => Math.ceil(count * FIRST_RUN_SUPPLY_BONUS);

/**
 * A count of supplies, with the first run's bonus if this is it.
 *
 * @param {import('../engine/session.mjs').Session} session
 * @param {number} count
 */
function firstRunSupply(session, count) {
  return session.firstRun ? withSupplyBonus(count) : count;
}

/**
 * How many potions a rest stop hands over, and which one.
 *
 * A stop that only heals is worth nothing to a companion already at full
 * health, and the healing items the bag can throw have to come from somewhere.
 * Which potion is the one the level has any use for: five Potions are a
 * kindness at level ten and a rounding error at fifty.
 */
const SUPPLY_COUNT = 8;

/** @type {Array<{level: number, item: string}>} highest level last */
const SUPPLIES = [
  { level: 20, item: 'potion' },
  { level: 40, item: 'super-potion' },
  { level: 60, item: 'hyper-potion' },
  { level: Infinity, item: 'max-potion' },
];

/**
 * How many balls a rest stop hands over, and which ones.
 *
 * Balls used to come only off the road, out of the item balls the pickup event
 * spawns, which left a player who had spent theirs on a good catch with no way
 * to get more except waiting for the right roll. A Pokémon Center is where you
 * buy balls in every game in the series, so this is where they come from here.
 *
 * Which ball follows the companion's level for the same reason the potion
 * does: a Poké Ball is what you throw at what you meet at level ten and a
 * waste of a turn against what you meet at fifty. The better balls come in
 * early, because the stop hands over only one or two — a handful of Poké
 * Balls a visit made the pickups on the road worthless, and a couple of good
 * ones is worth more than a pocketful of the ones that bounce off.
 *
 * @type {Array<{level: number, item: string}>} highest level last
 */
export const BALL_SUPPLIES = [
  { level: 15, item: 'poke-ball' },
  { level: 30, item: 'great-ball' },
  { level: Infinity, item: 'ultra-ball' },
];

/** How many of that ball the stop hands over: one or two, even odds. */
export const BALL_SUPPLY_COUNT = { min: 1, max: 2 };

/**
 * The balls one visit hands over, for a companion at this level.
 *
 * @param {import('../core/rng.mjs').Rng} rng
 * @param {number} level
 * @returns {{item: string, count: number}}
 */
export function ballSupply(rng, level) {
  const entry = BALL_SUPPLIES.find((row) => level < row.level) ?? BALL_SUPPLIES[BALL_SUPPLIES.length - 1];
  return { item: entry.item, count: rng.int(BALL_SUPPLY_COUNT.min, BALL_SUPPLY_COUNT.max) };
}

/** How long the companion stays inside, out of sight, being seen to. */
const CENTER_STAY_MS = 5000;

/**
 * How long stepping through the doorway takes, and how far up the screen —
 * into the building, since its door faces the viewer — the step goes.
 */
const DOOR_STEP_MS = 300;
const DOOR_STEP_PX = 5;

/**
 * How long the door holds open behind a companion walking away from it, and
 * then each frame of it closing.
 */
const DOOR_HOLD_MS = 150;
const DOOR_CLOSE_FRAME_MS = 90;

/**
 * How long the Center stays on screen after the visit, while the walk carries
 * the companion past it. Long enough for the building to slide off the left
 * edge of the view at the walk's own pace, so the rest stop reads as a place
 * passed rather than a place that stopped existing.
 */
const CENTER_PASS_MS = 6500;

/**
 * The visit, beat by beat: which door frame to show, how long to hold it, and
 * whether the companion is inside for it.
 *
 * Frame 0 is the door the building itself draws — shut. The three frames after
 * it are the games' own door animation, played forwards to open and backwards
 * to close, which is exactly how the cartridge does it.
 *
 * The companion goes in and comes out by stepping through the doorway (`step`)
 * rather than vanishing from in front of it and reappearing there. It used to
 * stand at the door while it opened, blink out, and on the way back blink in
 * and stand there again while the door shut — a second and more of a Pokémon
 * at the side of a door, which read as it doing something *with* the door
 * rather than going through it. Now the door shuts behind it as it walks on.
 */
export const CENTER_STEPS = [
  { frame: 1, ms: 90 },
  { frame: 2, ms: 90 },
  { frame: 3, ms: 120 },
  { frame: 3, ms: DOOR_STEP_MS, step: 'in' },
  { frame: 3, ms: 140, inside: true },
  { frame: 2, ms: 90, inside: true },
  { frame: 1, ms: 90, inside: true },
  { frame: 0, ms: CENTER_STAY_MS, inside: true, heal: true },
  { frame: 1, ms: 90, inside: true },
  { frame: 2, ms: 90, inside: true },
  { frame: 3, ms: 120, inside: true },
  { frame: 3, ms: DOOR_STEP_MS, step: 'out' },
];

/**
 * Where the companion is in a step through the doorway.
 *
 * Going in, it rises into the doorway and fades into the dark behind it;
 * coming out is the same played backwards. Any other beat leaves it on the
 * ground and whole.
 *
 * @param {{step?: string, ms: number, frame?: number}|null|undefined} beat a
 *   beat of `CENTER_STEPS`; `step` is `'in'` or `'out'` on the two that have one
 * @param {number} remainingMs how much of the beat is left
 * @returns {{lift: number, alpha: number}}
 */
export function doorStep(beat, remainingMs) {
  if (!beat?.step) return { lift: 0, alpha: 1 };
  const done = Math.min(1, Math.max(0, 1 - remainingMs / beat.ms));
  const indoors = beat.step === 'in' ? done : 1 - done;
  return { lift: Math.round(indoors * DOOR_STEP_PX), alpha: 1 - indoors };
}

/** @param {any} active */
const doorStepOf = (active) => doorStep(active?.phase === 'visit' ? active.beat : null, active?.timer ?? 0);

/**
 * Which door frame shows behind a companion walking away from the Center.
 * @param {number} sinceMs how long ago it stepped out
 */
export function closingDoorFrame(sinceMs) {
  if (sinceMs < DOOR_HOLD_MS) return 3;
  return Math.max(0, 2 - Math.floor((sinceMs - DOOR_HOLD_MS) / DOOR_CLOSE_FRAME_MS));
}

/**
 * A gym visit, beat by beat, on the same door as {@link CENTER_STEPS}.
 *
 * The leader does not wait in the road: the companion walks up to their gym,
 * the door opens, and the battle begins the moment it is through it. Whatever
 * the outcome, it comes back out of the same door afterwards and walks on,
 * the door shutting behind it.
 *
 * The beat the battle opens on shows the door already shut: the battle screen
 * is over the road by then, and coming back from it finds the building as it
 * would be after a while indoors — closed, and opening to let it out.
 */
export const GYM_STEPS = [
  { frame: 1, ms: 90 },
  { frame: 2, ms: 90 },
  { frame: 3, ms: 120 },
  { frame: 3, ms: DOOR_STEP_MS, step: 'in' },
  { frame: 0, ms: 400, inside: true, battle: true },
  { frame: 1, ms: 90, inside: true },
  { frame: 2, ms: 90, inside: true },
  { frame: 3, ms: 120, inside: true },
  { frame: 3, ms: DOOR_STEP_MS, step: 'out' },
];

/**
 * The next beat of a visit to a building: a door frame, the walk past
 * afterwards, or nothing left to do.
 *
 * Pulled out of the event so the end of the visit can be checked without a
 * window: the walk-past used to be returned for every beat after the door
 * script ran out, which meant the event never finished, the runner stayed
 * busy for the rest of the session, and no event — or area change — could
 * ever happen again after a rest stop.
 *
 * @param {ReadonlyArray<any>} steps the building's script: {@link CENTER_STEPS} or {@link GYM_STEPS}
 * @param {number} step how many beats have been asked for, from zero
 * @param {boolean} passing whether the walk past the building has already begun
 * @returns {{phase: string, duration: number, beat?: any}|null}
 */
export function visitBeat(steps, step, passing) {
  const beat = steps[step];
  if (beat) return { phase: 'visit', duration: beat.ms, beat };
  // One walk past the building, and then the event is over.
  if (!passing) return { phase: 'passing', duration: CENTER_PASS_MS };
  return null;
}

/**
 * The next beat of a Center visit.
 * @param {number} step
 * @param {boolean} passing
 */
export const centerBeat = (step, passing) => visitBeat(CENTER_STEPS, step, passing);

/**
 * A Pokémon Center on the road ahead.
 *
 * The companion walks up to the door, waits for it to slide open, goes in, and
 * comes back out five seconds later patched up and carrying something for the
 * road — which is the whole of a visit to one, and reads better than a flash
 * of white where it stood.
 */
function startHeal(session, spawnAt) {
  let step = -1;

  const state = {
    kind: 'heal',
    worldX: spawnAt,
    phase: 'approach',
    timer: 0,
    flash: 0,
    // Square in front of the door, rather than the tile short of it that a
    // berry tree or a trainer is met at: it is about to walk through it.
    meetGap: 0,
    hidesActor: false,
    /** The beat of the visit playing now, for the step through the door. */
    beat: null,
    prop: { kind: 'center', sprite: null, door: null, frame: 0, closingFrom: null },
    carried: null,

    onArrive: () => 'visit',

    /** One beat of the visit; null once there are none left. */
    onTimer: (app) => {
      step += 1;
      const next = centerBeat(step, state.phase === 'passing');
      if (!next) return null;

      state.beat = next.beat ?? null;
      if (next.beat) {
        state.prop.frame = next.beat.frame;
        state.hidesActor = Boolean(next.beat.inside);
        if (next.beat.heal) restAndResupply(session, app);
      } else {
        // The visit is over, but the building is not: the companion walks on
        // past the Center and the map carries it off the left edge like any
        // other roadside scenery, instead of the place vanishing on the spot.
        // The door it came out of shuts behind it as it goes.
        state.hidesActor = false;
        state.prop.closingFrom = state.elapsed ?? 0;
      }
      state.phase = next.phase;
      return { phase: next.phase, duration: next.duration };
    },
  };

  loadImage('props/poke-center.png').then((image) => {
    state.prop.sprite = { image, meta: gameData().actors?.props?.center };
  });
  loadImage('props/poke-center-door.png').then((image) => {
    state.prop.door = image;
  });

  return state;
}

/** What the visit is for: everything restored, and the bag stocked. */
function restAndResupply(session, app) {
  session.heal();

  const level = levelOf(session.active);
  const supply = SUPPLIES.find((entry) => level < entry.level) ?? SUPPLIES[SUPPLIES.length - 1];
  const potions = firstRunSupply(session, SUPPLY_COUNT);
  session.addItem(supply.item, potions);

  const balls = ballSupply(session.rng, level);
  balls.count = firstRunSupply(session, balls.count);
  session.addItem(balls.item, balls.count);

  app.audio.playJingle(gameData().bgm.cues.heal ?? null);
  app.toast(
    [
      t('event.healed'),
      t('event.supplied', {
        name: localized(itemOf(supply.item)?.name, supply.item),
        count: potions,
      }),
      t('event.supplied', {
        name: localized(itemOf(balls.item)?.name, balls.item),
        count: balls.count,
      }),
    ].join('\n'),
    3600,
  );
}

/** The species waiting in the box, which the road is slightly less likely to hand out again. */
const boxed = (/** @type {import('../engine/session.mjs').Session} */ session) =>
  new Set(session.box.filter(Boolean).map((pokemon) => pokemon?.speciesId));

/** A wild Pokémon steps out ahead. */
function startWild(session, spawnAt) {
  const wild = rollWildPokemon(
    session.rng,
    session.area,
    session.active,
    session.lastWildSpecies,
    boxed(session),
    session.shinyOdds,
    rollRare(session),
  );
  session.lastWildSpecies = wild.speciesId;
  session.markSeen(wild.speciesId);

  const state = {
    kind: 'wild',
    worldX: spawnAt,
    phase: 'approach',
    timer: 0,
    flash: 0,
    phaseDuration: 700,
    prop: { kind: 'pokemon', sprite: null, frame: 'ripe', pokemon: wild },
    carried: null,
    setup: { foes: [wild], trainer: null, leader: null },
    onArrive: (app) => {
      app.audio.playCry(wild.speciesId);
      // No toast: the battle opens on the same line a beat later, and the two
      // of them on screen at once read as the encounter happening twice.
      return 'battle';
    },
  };

  // Standing its ground in the road, in the same art the companion walks in.
  const art = artOf(wild);
  if (art) {
    loadSprite(art.path, art.meta).then((sprite) => {
      state.prop.sprite = sprite;
    });
  }
  return state;
}

/**
 * A trainer blocks the path. Once eight badges are in hand leaders stop
 * appearing; before that a leader can turn up by chance, or be summoned by a
 * long enough winning streak — and is met in their gym rather than on the
 * path ({@link startGym}).
 */
function startTrainer(session, spawnAt) {
  const classes = gameData().trainerClasses ?? [];
  const leader = shouldSummonLeader(session) ? pickLeader(session) : null;
  if (leader) return startGym(session, spawnAt, leader);
  // A Swimmer is only met where there is water beside the lane, and swims
  // in it rather than standing on the road.
  const drop = waterDrop(session.area, COMPANION_X + spawnAt, SWIMMER_HALF_WIDTH);
  const { trainerClass, party } = rollTrainer(session.rng, session.area, session.active, classes, { onWater: drop !== null });
  const swimming = Boolean(trainerClass?.water) && drop !== null;

  for (const member of party) session.markSeen(member.speciesId);

  const state = {
    kind: 'trainer',
    worldX: spawnAt,
    phase: 'approach',
    timer: 0,
    flash: 0,
    phaseDuration: 800,
    prop: { kind: 'trainer', sprite: null, frame: 'ripe', drop: swimming ? drop : 0 },
    carried: null,
    setup: { foes: party, trainer: trainerClass, leader: null },
    onArrive: () => 'battle',
  };

  const fieldSprite = trainerClass?.field;
  const meta = fieldSprite ? gameData().actors?.overworld?.[fieldSprite] : null;
  if (meta) {
    loadSprite(`trainers/field/${fieldSprite}.png`, { ...meta, delay: 240 }).then((sprite) => {
      state.prop.sprite = sprite;
    });
  }
  return state;
}

/**
 * A gym on the road ahead, its leader waiting inside.
 *
 * The companion walks up to the door, which opens for it, and the battle
 * starts as soon as it is through. Afterwards it comes back out and walks on
 * past the building, as it does past a Pokémon Center.
 *
 * @param {import('../engine/session.mjs').Session} session
 * @param {number} spawnAt
 * @param {any} leader
 */
function startGym(session, spawnAt, leader) {
  const roster = leaderParty(session, leader);
  for (const member of roster) session.markSeen(member.speciesId);
  let step = -1;

  const state = {
    kind: 'gym',
    worldX: spawnAt,
    phase: 'approach',
    timer: 0,
    flash: 0,
    // Square in front of the door, as at a Pokémon Center.
    meetGap: 0,
    hidesActor: false,
    /** The beat of the visit playing now, for the step through the door. */
    beat: null,
    prop: { kind: 'gym', sprite: null, door: null, frame: 0, closingFrom: null },
    carried: null,
    setup: { foes: roster, trainer: leader, leader },

    onArrive: () => 'visit',

    /** One beat of the visit; null once there are none left. */
    onTimer: () => {
      step += 1;
      const next = visitBeat(GYM_STEPS, step, state.phase === 'passing');
      if (!next) return null;

      state.beat = next.beat ?? null;
      if (next.beat) {
        state.prop.frame = next.beat.frame;
        state.hidesActor = Boolean(next.beat.inside);
      } else {
        state.hidesActor = false;
        state.prop.closingFrom = state.elapsed ?? 0;
      }
      state.phase = next.phase;
      return { phase: next.phase, duration: next.duration, battle: Boolean(next.beat?.battle) };
    },
  };

  loadImage('props/gym.png').then((image) => {
    state.prop.sprite = { image, meta: gameData().actors?.props?.gym };
  });
  loadImage('props/gym-door.png').then((image) => {
    state.prop.door = image;
  });

  return state;
}

/**
 * Whether this trainer encounter is a gym leader instead.
 *
 * A leader just lost to stays away for a few trainers first (see
 * `LEADER_REST_AFTER_LOSS`); each encounter spends one of them.
 *
 * @param {import('../engine/session.mjs').Session} session
 */
export function shouldSummonLeader(session) {
  if (session.badges.length >= 8) return false;
  if (session.leaderRest > 0) {
    session.leaderRest--;
    return false;
  }
  // Due once the companion reaches the next badge's level; see BADGE_LEVELS.
  const odds = leaderOdds(session.badges.length, levelOf(session.active));
  if (session.trainerWins >= odds.wins) return true;
  return session.rng.chance(odds.chance);
}

/**
 * A leader whose badge the player does not already hold, preferring one whose
 * type suits the area's terrain — a Rock leader on a mountain path rather than
 * at the seaside.
 *
 * @param {import('../engine/session.mjs').Session} session
 */
function pickLeader(session) {
  const held = new Set(session.badges);
  const available = (gameData().leaders ?? []).filter((leader) => !held.has(leader.type));
  if (available.length === 0) return null;

  const suited = new Set((session.area?.tags ?? []).flatMap((tag) => TAG_TYPES[tag] ?? []));
  const local = available.filter((leader) => suited.has(leader.type));
  return session.rng.pick(local.length ? local : available);
}

/**
 * A leader's party: the species they are known for, at the levels of the
 * badge they hold (see `leaderLevels`) — whoever challenges them, as the
 * League is. On the save's first run the first three leaders keep under their
 * gym's ceiling (see `FIRST_RUN_LEADER_STATS`).
 *
 * @param {import('../engine/session.mjs').Session} session
 * @param {any} leader
 */
export function leaderParty(session, leader) {
  const ceiling = leaderCeiling(session);
  const roster = (leader.party ?? []).filter((id) => speciesOf(id) && totalStats(speciesOf(id)) <= ceiling);

  const species = roster.length
    ? capRoster(roster, LEADER_PARTY_CAP)
    : // No roster on file: fall back to strong members of the leader's type.
      pickTypeRoster(session, leader.type, LEADER_PARTY_CAP, ceiling);

  const levels = leaderLevels(session.badges.length, species.length);
  const party = species.map((id, index) => {
    // Grown to its level, unless that takes it over the ceiling: a Magikarp
    // drawn for an early gym stays a Magikarp.
    const grown = evolveToLevel(id, levels[index]);
    const kept = totalStats(speciesOf(grown)) <= ceiling ? grown : id;
    return createPokemon(session.rng, kept, levels[index], { ivFloor: 10 });
  });
  return giveTrainerItems(session.rng, party, 'leader');
}

/**
 * The most base stats the next leader's Pokémon may have: the gym's ceiling
 * on the save's first run, and no limit otherwise.
 *
 * @param {import('../engine/session.mjs').Session} session
 */
function leaderCeiling(session) {
  return session.firstRun ? FIRST_RUN_LEADER_STATS[session.badges.length] ?? Infinity : Infinity;
}

/**
 * The highest-statted non-legendary species of a type, within the ceiling,
 * which is what a gym leader would plausibly have trained. A type with
 * nothing under the ceiling goes without it.
 *
 * @param {import('../engine/session.mjs').Session} session
 * @param {string} type
 * @param {number} count
 * @param {number} [ceiling]
 * @returns {number[]}
 */
function pickTypeRoster(session, type, count, ceiling = Infinity) {
  const ofType = Object.values(gameData().species).filter(
    (entry) => !entry.isLegendary && !entry.isMythical && entry.types.includes(type),
  );
  const within = ofType.filter((entry) => totalStats(entry) <= ceiling);
  const candidates = (within.length ? within : ofType)
    .sort((a, b) => totalStats(b) - totalStats(a))
    .slice(0, 24)
    .map((entry) => entry.id);

  return session.rng.shuffle(candidates).slice(0, count);
}

const totalStats = (species) => Object.values(species.stats).reduce((sum, value) => sum + Number(value), 0);

/**
 * @param {CanvasRenderingContext2D} context
 * @param {any} state
 * @param {number} screenX
 */
function drawProp(context, state, screenX) {
  const prop = state.prop;
  if (!prop?.sprite) return;

  if (prop.kind === 'berry-tree') {
    drawBerryTree(context, prop, screenX, lookClock(state));
    return;
  }
  if (prop.kind === 'ball') {
    drawBall(context, prop, screenX, (state.elapsed ?? 0) - (prop.openedAt ?? 0));
    return;
  }
  if (prop.kind === 'center' || prop.kind === 'gym') {
    const frame = prop.closingFrom === null ? prop.frame : closingDoorFrame((state.elapsed ?? 0) - prop.closingFrom);
    drawBuilding(context, { ...prop, frame }, screenX);
    return;
  }

  const sprite = /** @type {Sprite} */ (prop.sprite);

  // A wild Pokémon is drawn exactly as the companion is — the same art, the
  // same scale, the same shadow — turned to face it, so the Sableye in the
  // road is the same Sableye that would be walking it. It stands by the clock
  // rather than the event's, which only starts once the two have met.
  if (prop.kind === 'pokemon') {
    drawWalker(context, sprite, {
      x: screenX,
      y: groundY(),
      distance: 0,
      moving: false,
      facing: 'left',
      scale: actorScale(sprite, prop.pokemon),
      time: performance.now(),
    });
    return;
  }

  // A trainer waiting on the path, half again as big as its sheet — or a
  // Swimmer in the water beside it.
  sprite.draw(context, screenX, groundY() + (prop.drop ?? 0), {
    frame: sprite.frameAt(lookClock(state)),
    scale: TRAINER_SCALE,
  });
}

/**
 * Which pair of frames a berry sheet's growth stages live on.
 *
 * Emerald's sheets are six 16x32 frames: two per stage, the pair being the
 * sway the tree animates with. The stages, in order, are the grown tree, the
 * tree in flower, and the tree in fruit — the two stages before those, the
 * bare earth and the sprout, are shared sheets rather than the berry's own.
 *
 * Picking "the last frame" for a ripe tree and "the first" for a picked one
 * happened to land on the right fruit frame, but it took the tree all the way
 * back to a bare stalk the moment it was picked: the tree the companion had
 * just walked up to vanished and left a twig. Naming the stages instead means
 * a picked tree keeps its shape and loses only what was picked off it.
 *
 * `bare` is only the fallback, though: the flowers on that stage are a few
 * loose pixels that read as the sprite breaking up once the fruit is gone, so
 * the build names the grown tree instead (`picked`) wherever that stage is a
 * tree rather than a stalk.
 */
const BERRY_STAGES = { ripe: [4, 5], bare: [2, 3] };

/** How long a berry tree holds each of its two sway frames. */
const BERRY_SWAY_MS = 380;

/**
 * How big a berry tree stands on the road: its own tile size, the map's
 * pixels. It used to stand at the actors' half again, which made it as tall
 * as the Pokémon picking it and taller than the trees behind it.
 */
const BERRY_TREE_SCALE = 1;

/**
 * Berry sheets hold the tree's growth stages; see {@link BERRY_STAGES}.
 */
function drawBerryTree(context, prop, screenX, elapsed = 0) {
  const { image, meta } = prop.sprite;
  const frameWidth = 16;
  const frameHeight = 32;
  const columns = Math.max(1, Math.floor(image.naturalWidth / frameWidth));
  const total = Math.max(1, meta?.frames ?? columns);

  // The build says which frames it found the fruit on; the table above is the
  // answer for a manifest written before it did.
  const ripe = Array.isArray(meta?.fruit) && meta.fruit.length ? meta.fruit : BERRY_STAGES.ripe;
  const picked = Array.isArray(meta?.picked) && meta.picked.length ? meta.picked : BERRY_STAGES.bare;
  const stage = prop.frame === 'ripe' ? ripe : picked;

  const wanted = stage[Math.floor(elapsed / BERRY_SWAY_MS) % stage.length];
  // A sheet the build cut differently — fewer frames than Emerald's six —
  // falls back to its own last frame for a ripe tree and its first for a
  // picked one, rather than reading off the end of the strip.
  const index = wanted < total ? wanted : prop.frame === 'ripe' ? total - 1 : 0;

  const sx = (index % columns) * frameWidth;
  const sy = Math.floor(index / columns) * frameHeight;
  const scale = BERRY_TREE_SCALE;

  context.drawImage(
    image,
    sx,
    sy,
    frameWidth,
    frameHeight,
    Math.round(screenX - (frameWidth * scale) / 2),
    Math.round(groundY() - frameHeight * scale),
    frameWidth * scale,
    frameHeight * scale,
  );
}

/**
 * A Pokémon Center or a gym, standing on the road with its door on the ground
 * line.
 *
 * The building is drawn at the map's own scale — it is a piece of map — and
 * the door frames are laid over the doorway it already has, so opening it is
 * one blit rather than a second copy of the building.
 */
function drawBuilding(context, prop, screenX) {
  const { image, meta } = prop.sprite;
  const door = meta?.door;

  // Lined up so the doorway is where the companion stopped, not the middle of
  // the wall: neither building has its door in the middle.
  const left = Math.round(screenX - (door ? door.x + door.width / 2 : image.naturalWidth / 2));
  const top = Math.round(groundY() - image.naturalHeight);
  context.drawImage(image, left, top);

  if (!door || !prop.door || prop.frame <= 0) return;
  const frame = Math.min(prop.frame, door.frames) - 1;
  context.drawImage(
    prop.door,
    frame * door.width,
    0,
    door.width,
    door.height,
    left + door.x,
    top + door.y,
    door.width,
    door.height,
  );
}

/**
 * The ball on the ground. Once emptied it is drawn as the same ball with its
 * top half tipped back off the base — the games have no "opened ball" sprite
 * of their own for the overworld. (Exported so the check harness can render
 * the shape headlessly.)
 *
 * Tipping it by rotating the lid leaves the two square halves overhanging
 * empty air at their corners, which is the "broken image" look. Instead the
 * base stays put and the lid is **sheared off to the right and shortened** —
 * a row per blit, each row shifted a little further and squashed a little
 * thinner, so the lid reads as hinged at its back edge and curled over, and
 * every drawn pixel stays inside the sprite's own footprint.
 */
export function drawBall(context, prop, screenX, sinceOpened = 0) {
  const { image } = prop.sprite;
  // The icon's own width and height, separately. The pipeline trims each icon
  // to its opaque pixels, so they are not square, and one number read off the
  // height cannot stand for both.
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  if (!sourceWidth || !sourceHeight) return;

  // Item icons are drawn for a bag list, where they are the only thing on the
  // row; on the ground one at its own size is a boulder, so it is brought down
  // to something a Pokémon could pick up — keeping its own proportions.
  const drawnWidth = BALL_SIZE;
  const drawnHeight = Math.max(1, Math.round((BALL_SIZE * sourceHeight) / sourceWidth));
  const left = Math.round(screenX - drawnWidth / 2);
  const top = Math.round(groundY() - drawnHeight);

  if (prop.frame === 'closed') {
    context.drawImage(image, left, top, drawnWidth, drawnHeight);
    return;
  }

  // Opened: the same ball, rising and fading out of the picture. There is
  // nothing left on the ground once it has gone, which is what the map shows
  // after an item ball is collected.
  const step = Math.max(0, Math.min(1, sinceOpened / BALL_FADE_MS));
  if (step >= 1) return;

  context.save();
  context.globalAlpha = 1 - step;
  context.drawImage(image, left, Math.round(top - step * drawnHeight * 0.8), drawnWidth, drawnHeight);
  context.restore();
}

/**
 * The item held up over the companion's head after a gather, clear of whatever
 * height that species happens to be.
 */
function drawCarried(context, carried, actorHeight) {
  if (!carried.sprite) return;
  carried.sprite.draw(context, COMPANION_X, groundY() - actorHeight - 4, { scale: carried.scale ?? 1 });
}

/**
 * How big a picked berry is held up: half its icon, one screen pixel to each
 * of its own. At full size a bag icon held over a Pokémon's head came out
 * nearly the size of the Pokémon; half is as small as it goes while every
 * pixel stays one pixel.
 */
const CARRIED_BERRY_SCALE = 0.5;

/**
 * The size a bag icon is drawn at. The newer items' pictures (a Blunder
 * Policy, Heavy-Duty Boots, the masks) are not icons but art a hundred and
 * fifty pixels across, which held up over the companion came out several
 * times its size; anything past {@link ICON_LIMIT} is shrunk to fit this.
 */
const ICON_PX = 24;
/** The largest an ordinary bag icon is, which is left exactly as it is. */
const ICON_LIMIT = 32;

/** @param {HTMLImageElement} image */
function stillSprite(image) {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (Math.max(width, height) <= ICON_LIMIT) return new Sprite(image, { width, height, frames: 1, delay: 1000 });

  // Shrunk once, smoothly: at this size nearest-neighbour drops most of the
  // picture, and a pixel-art icon this is not.
  const fit = ICON_PX / Math.max(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * fit));
  canvas.height = Math.max(1, Math.round(height * fit));
  const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Sprite(/** @type {any} */ (canvas), { width: canvas.width, height: canvas.height, frames: 1, delay: 1000 });
}
