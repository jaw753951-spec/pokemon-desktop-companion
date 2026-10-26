/**
 * The weather, the terrain and the screens — everything a battle is fought
 * inside rather than between two Pokémon.
 *
 * The auto-battle screen has always had a "field move" category and a "when
 * there is no field effect" condition, and until now there was nothing for
 * either to point at: a Sunny Day was a status move that did nothing and the
 * condition was always true. This is what they were waiting for.
 *
 * Three things live here, and they are independent of one another:
 *
 * - **Weather** covers the whole field and changes what types hit for. It runs
 *   five turns, or eight when whoever called it was holding the rock for it.
 * - **Terrain** covers the ground, so it only reaches Pokémon standing on it —
 *   a Flying type, a Levitate or a Pokémon holding an Air Balloon is above it
 *   and untouched.
 * - **Screens** belong to one side rather than to the field, and halve the
 *   damage of one damage class coming at that side.
 * - **Hazards** belong to a side too, and bite whatever is sent out onto them.
 *   The companion never switches, so the ones laid at its feet never go off —
 *   but a trainer sends out one Pokémon after another, and every one of them
 *   walks onto what was laid down for the last.
 */

/** The weather the games can put over a battle. */
export const WEATHER = {
  SUN: 'sun',
  RAIN: 'rain',
  SANDSTORM: 'sandstorm',
  HAIL: 'hail',
  SNOW: 'snow',
};

/** And the terrain they can lay under it. */
export const TERRAIN = {
  ELECTRIC: 'electric',
  GRASSY: 'grassy',
  MISTY: 'misty',
  PSYCHIC: 'psychic',
};

/** How long a field effect lasts when nothing extends it. */
export const FIELD_TURNS = 5;

/**
 * The moves that set one, by what they set.
 *
 * PokeAPI files every one of these under the same "whole field effect"
 * category without saying which effect, so they are named here. Seventeen
 * lines is the whole table — the alternative is parsing English prose for the
 * word "sunlight".
 *
 * @type {Record<string, {weather?: string, terrain?: string, screen?: string, hazard?: string, room?: string, tailwind?: boolean}>}
 */
export const FIELD_MOVES = {
  'trick-room': { room: 'trick' },
  tailwind: { tailwind: true },
  'sunny-day': { weather: WEATHER.SUN },
  'rain-dance': { weather: WEATHER.RAIN },
  sandstorm: { weather: WEATHER.SANDSTORM },
  hail: { weather: WEATHER.HAIL },
  snowscape: { weather: WEATHER.SNOW },
  'chilly-reception': { weather: WEATHER.SNOW },
  'electric-terrain': { terrain: TERRAIN.ELECTRIC },
  'grassy-terrain': { terrain: TERRAIN.GRASSY },
  'misty-terrain': { terrain: TERRAIN.MISTY },
  'psychic-terrain': { terrain: TERRAIN.PSYCHIC },
  reflect: { screen: 'physical' },
  'light-screen': { screen: 'special' },
  'aurora-veil': { screen: 'both' },
  spikes: { hazard: 'spikes' },
  'toxic-spikes': { hazard: 'toxicSpikes' },
  'stealth-rock': { hazard: 'stealthRock' },
  'sticky-web': { hazard: 'stickyWeb' },
};

/**
 * How long a Trick Room stands, and a Tailwind blows, counting the turn it
 * was made in — the counters run down at the end of every turn, that one
 * included, which is how the cartridges count them too.
 */
export const TRICK_ROOM_TURNS = 5;
export const TAILWIND_TURNS = 4;

/** How many layers of each hazard a side can take. */
export const HAZARD_LAYERS = { spikes: 3, toxicSpikes: 2, stealthRock: 1, stickyWeb: 1 };

/** What each layer of Spikes costs whoever walks onto it. */
const SPIKE_DAMAGE = [0, 1 / 8, 1 / 6, 1 / 4];

/** And what Stealth Rock costs, before the type chart has its say. */
const ROCK_DAMAGE = 1 / 8;

/**
 * The three healing moves whose worth the weather decides.
 *
 * Their listed healing is half a bar; in sunshine they give two thirds and in
 * anything else a quarter, which is the one place a move's own numbers are not
 * the whole story.
 */
export const SUN_HEALS = new Set(['synthesis', 'moonlight', 'morning-sun']);

/** Moves that never miss in rain, and fall to half accuracy in sunshine. */
const STORM_MOVES = new Set(['thunder', 'hurricane']);

/** And the one that never misses in hail or snow. */
const SNOW_MOVES = new Set(['blizzard']);

/**
 * What is over and under a battle, and for how much longer.
 */
export class Field {
  constructor() {
    /** @type {string|null} */
    this.weather = null;
    this.weatherTurns = 0;
    /**
     * Whether the weather is a primal one — a Primordial Sea's heavy rain, a
     * Desolate Land's extremely harsh sun. It lasts for as long as the
     * Pokémon that called it stays out, and no ordinary weather can take its
     * place.
     */
    this.primal = false;
    /** @type {string|null} */
    this.terrain = null;
    this.terrainTurns = 0;
    /**
     * Screens belong to a side rather than to the field, so each side keeps
     * its own pair of counters.
     * @type {Record<'player'|'foe', {physical: number, special: number}>}
     */
    this.screens = { player: { physical: 0, special: 0 }, foe: { physical: 0, special: 0 } };
    /**
     * What is on the ground on each side, in layers.
     * @type {Record<'player'|'foe', Record<string, number>>}
     */
    this.hazards = { player: freshHazards(), foe: freshHazards() };
    /** Turns of Trick Room left: the slower side moves first while it stands. */
    this.trickRoom = 0;
    /**
     * Turns of Tailwind left behind each side, which doubles its Speed.
     * @type {Record<'player'|'foe', number>}
     */
    this.tailwind = { player: 0, foe: 0 };
    /** The pseudo-weathers: turns left on each. */
    this.gravity = 0;
    /** The turn an Ion Deluge charged, or -1. */
    this.ionDeluge = -1;
    this.wonderRoom = 0;
    this.magicRoom = 0;
    this.waterSport = 0;
    this.mudSport = 0;
    /** How many turns running an Echoed Voice has gone off. */
    this.echoes = 0;
    /** Whether one went off this turn, which keeps the count going. */
    this.echoedThisTurn = false;
    /** What each side has put up over itself: a Mist, a Safeguard, the guards of one turn. */
    this.sides = { player: freshSide(), foe: freshSide() };
    /**
     * A Wish waiting to come true, and a Future Sight waiting to land, on each
     * side.
     * @type {{player: any, foe: any}}
     */
    this.wish = { player: null, foe: null };
    /** @type {{player: any, foe: any}} */
    this.futureSight = { player: null, foe: null };
  }

  /**
   * Swap everything each side has put up with the other's, which is what a
   * Court Change does: screens, hazards, tailwinds and veils change sides.
   */
  swapSides() {
    /** @param {any} record */
    const swap = (record) => {
      const player = record.player;
      record.player = record.foe;
      record.foe = player;
    };
    swap(this.screens);
    swap(this.hazards);
    swap(this.tailwind);
    swap(this.sides);
  }

  /**
   * Put up a Trick Room, or take one down: the move twists the dimensions
   * back when it is used inside one.
   *
   * @param {number} [turns]
   * @returns {'started'|'ended'}
   */
  toggleTrickRoom(turns = TRICK_ROOM_TURNS) {
    if (this.trickRoom > 0) {
      this.trickRoom = 0;
      return 'ended';
    }
    this.trickRoom = turns;
    return 'started';
  }

  /**
   * @param {'player'|'foe'} side
   * @param {number} [turns]
   * @returns {boolean} whether it started — one already blowing does not restart
   */
  setTailwind(side, turns = TAILWIND_TURNS) {
    if (this.tailwind[side] > 0) return false;
    this.tailwind[side] = turns;
    return true;
  }

  /**
   * Lay another layer of a hazard at one side's feet.
   *
   * @param {'player'|'foe'} side the side it is laid on, not the side that laid it
   * @param {string} hazard
   * @returns {boolean} whether there was room for another layer
   */
  addHazard(side, hazard) {
    const limit = HAZARD_LAYERS[hazard] ?? 1;
    if ((this.hazards[side][hazard] ?? 0) >= limit) return false;
    this.hazards[side][hazard] = (this.hazards[side][hazard] ?? 0) + 1;
    return true;
  }

  /** @param {'player'|'foe'} side */
  clearHazards(side) {
    this.hazards[side] = freshHazards();
  }

  /**
   * Whether anything at all is going on, which is what `noField` asks. A
   * Trick Room counts: reaching for it again while it stands takes it down.
   */
  get quiet() {
    return !this.weather && !this.terrain && this.trickRoom <= 0;
  }

  /**
   * @param {string} weather
   * @param {number} [turns]
   * @param {boolean} [primal] a primal weather, which only another primal one
   *   can replace
   * @returns {boolean} whether it changed anything
   */
  setWeather(weather, turns = FIELD_TURNS, primal = false) {
    if (this.primal && !primal) return false;
    if (this.weather === weather && this.primal === primal) return false;
    this.weather = weather;
    this.weatherTurns = primal ? Infinity : turns;
    this.primal = primal;
    return true;
  }

  /** Lift a primal weather, gone with the Pokémon that called it. */
  endPrimal() {
    this.weather = null;
    this.weatherTurns = 0;
    this.primal = false;
  }

  /**
   * @param {string} terrain
   * @param {number} [turns]
   * @returns {boolean}
   */
  setTerrain(terrain, turns = FIELD_TURNS) {
    if (this.terrain === terrain) return false;
    this.terrain = terrain;
    this.terrainTurns = turns;
    return true;
  }

  /**
   * @param {'player'|'foe'} side
   * @param {'physical'|'special'|'both'} kind
   * @param {number} [turns]
   * @returns {boolean}
   */
  setScreen(side, kind, turns = FIELD_TURNS) {
    const kinds = kind === 'both' ? ['physical', 'special'] : [kind];
    let changed = false;
    for (const one of kinds) {
      if (this.screens[side][one] > 0) continue;
      this.screens[side][one] = turns;
      changed = true;
    }
    return changed;
  }

  /**
   * Count every clock down one turn and report what ran out.
   *
   * @returns {Array<{kind: string, value: string, side?: string}>}
   */
  tick() {
    /** @type {Array<{kind: string, value: string, side?: string}>} */
    const expired = [];
    for (const key of /** @type {const} */ (['gravity', 'wonderRoom', 'magicRoom', 'waterSport', 'mudSport'])) {
      if (this[key] > 0 && --this[key] <= 0) expired.push({ kind: key, value: key });
    }
    for (const side of /** @type {const} */ (['player', 'foe'])) {
      for (const key of /** @type {const} */ (['mist', 'safeguard', 'luckyChant'])) {
        if (this.sides[side][key] > 0 && --this.sides[side][key] <= 0) expired.push({ kind: key, value: key, side });
      }
    }
    if (this.trickRoom > 0 && --this.trickRoom <= 0) expired.push({ kind: 'trickRoom', value: 'trick' });
    for (const side of /** @type {const} */ (['player', 'foe'])) {
      if (this.tailwind[side] > 0 && --this.tailwind[side] <= 0) expired.push({ kind: 'tailwind', value: 'tailwind', side });
    }

    if (this.weather && --this.weatherTurns <= 0) {
      expired.push({ kind: 'weather', value: this.weather });
      this.weather = null;
    }
    if (this.terrain && --this.terrainTurns <= 0) {
      expired.push({ kind: 'terrain', value: this.terrain });
      this.terrain = null;
    }
    for (const side of /** @type {const} */ (['player', 'foe'])) {
      for (const kind of /** @type {const} */ (['physical', 'special'])) {
        if (this.screens[side][kind] > 0 && --this.screens[side][kind] <= 0) {
          expired.push({ kind: 'screen', value: kind, side });
        }
      }
    }
    return expired;
  }
}

/**
 * How much the weather multiplies a move of this type.
 *
 * Sunshine is the classic pairing — half again for fire, half for water — and
 * rain is the same trade the other way round.
 *
 * @param {string|null} weather
 * @param {string} moveType
 */
export function weatherDamage(weather, moveType) {
  if (weather === WEATHER.SUN) {
    if (moveType === 'fire') return 1.5;
    if (moveType === 'water') return 0.5;
  }
  if (weather === WEATHER.RAIN) {
    if (moveType === 'water') return 1.5;
    if (moveType === 'fire') return 0.5;
  }
  return 1;
}

/**
 * How much the terrain multiplies a move of this type.
 *
 * The three that strengthen a type only do so for an attacker standing on the
 * ground, and Misty Terrain's softening of dragon moves only protects a
 * defender standing on it. A Pokémon in the air is out of all four.
 *
 * @param {string|null} terrain
 * @param {string} moveType
 * @param {boolean} attackerGrounded
 * @param {boolean} defenderGrounded
 */
export function terrainDamage(terrain, moveType, attackerGrounded, defenderGrounded) {
  if (!terrain) return 1;
  if (terrain === TERRAIN.MISTY) return moveType === 'dragon' && defenderGrounded ? 0.5 : 1;
  if (!attackerGrounded) return 1;
  if (terrain === TERRAIN.ELECTRIC && moveType === 'electric') return 1.3;
  if (terrain === TERRAIN.GRASSY && moveType === 'grass') return 1.3;
  if (terrain === TERRAIN.PSYCHIC && moveType === 'psychic') return 1.3;
  return 1;
}

/**
 * The weather's say in whether a move lands.
 *
 * Thunder and Hurricane cannot miss in rain and are half as likely to land in
 * sunshine; Blizzard cannot miss in hail or snow.
 *
 * @param {string|null} weather
 * @param {string} moveName
 * @returns {number|'always'} an accuracy multiplier, or that it cannot miss
 */
export function weatherAccuracy(weather, moveName) {
  if (STORM_MOVES.has(moveName)) {
    if (weather === WEATHER.RAIN) return 'always';
    if (weather === WEATHER.SUN) return 0.5;
  }
  if (SNOW_MOVES.has(moveName) && (weather === WEATHER.HAIL || weather === WEATHER.SNOW)) return 'always';
  return 1;
}

/**
 * What a self-healing move is worth under this sky, as a share of maximum HP.
 *
 * @param {string|null} weather
 * @param {string} moveName
 * @param {number} listed the move's own healing, as a percentage
 * @returns {number} a percentage
 */
export function weatherHealing(weather, moveName, listed) {
  if (!SUN_HEALS.has(moveName)) return listed;
  if (weather === WEATHER.SUN) return 200 / 3;
  if (weather) return 25;
  return listed;
}

/**
 * Whether the sandstorm or the hail bites this Pokémon at the end of a turn.
 *
 * @param {string|null} weather
 * @param {string[]} types
 * @returns {boolean}
 */
export function weatherBites(weather, types) {
  if (weather === WEATHER.SANDSTORM) {
    return !types.some((type) => type === 'rock' || type === 'ground' || type === 'steel');
  }
  // Snow replaced hail's chip damage outright in Scarlet and Violet; both are
  // modelled because both can still be summoned.
  if (weather === WEATHER.HAIL) return !types.includes('ice');
  return false;
}

/** Sand raises a Rock type's Special Defence by half, as it always has. */
export function weatherStat(weather, stat, types) {
  if (weather === WEATHER.SANDSTORM && stat === 'spd' && types.includes('rock')) return 1.5;
  if (weather === WEATHER.SNOW && stat === 'def' && types.includes('ice')) return 1.5;
  return 1;
}

/**
 * Whether the terrain keeps a condition off a Pokémon standing on it.
 *
 * Electric Terrain only bars sleep; Misty Terrain bars the lot.
 *
 * @param {string|null} terrain
 * @param {string} status
 */
export function terrainBlocksStatus(terrain, status) {
  if (terrain === TERRAIN.MISTY) return true;
  return terrain === TERRAIN.ELECTRIC && status === 'slp';
}

/** Psychic Terrain takes the jump out of a priority move aimed at the ground. */
export function terrainBlocksPriority(terrain, priority, defenderGrounded) {
  return terrain === TERRAIN.PSYCHIC && priority > 0 && defenderGrounded;
}

/** A side with nothing on the ground. */
const freshSide = () => ({ mist: 0, safeguard: 0, luckyChant: 0, wideGuard: -1, quickGuard: -1, craftyShield: -1 });

const freshHazards = () => ({ spikes: 0, toxicSpikes: 0, stealthRock: 0, stickyWeb: 0 });

/**
 * What walking onto a side's hazards costs, for a Pokémon just sent out.
 *
 * Spikes and Sticky Web only reach something standing on the ground; Stealth
 * Rock is in the air and reaches everything, scaled by how well the newcomer
 * takes a Rock move. Toxic Spikes are absorbed by a grounded Poison type,
 * which is the one hazard a Pokémon can clear simply by arriving.
 *
 * @param {Record<string, number>} hazards
 * @param {{types: string[], grounded: boolean}} arriving
 * @param {(attacking: string, defending: string[]) => number} effectiveness
 * @returns {{damage: number, status: string|null, stat: string|null, absorbs: boolean}}
 */
export function hazardToll(hazards, arriving, effectiveness) {
  const toll = { damage: 0, status: /** @type {string|null} */ (null), stat: /** @type {string|null} */ (null), absorbs: false };

  if (hazards.stealthRock > 0) {
    toll.damage += ROCK_DAMAGE * effectiveness('rock', arriving.types);
  }
  if (!arriving.grounded) return toll;

  toll.damage += SPIKE_DAMAGE[Math.min(hazards.spikes, SPIKE_DAMAGE.length - 1)] ?? 0;
  if (hazards.stickyWeb > 0) toll.stat = 'spe';

  if (hazards.toxicSpikes > 0) {
    if (arriving.types.includes('poison')) toll.absorbs = true;
    else if (!arriving.types.includes('steel')) toll.status = 'psn';
  }
  return toll;
}
