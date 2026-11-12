/**
 * The states that last a battle rather than a lifetime.
 *
 * A burn or a paralysis is written into the save and walks out of the battle
 * with the Pokémon. Confusion, infatuation, a Disable, a Taunt, an Encore — a
 * Protect, even — all end when the battle does, so none of them belong in the
 * save: they live on the combatant, beside the stat stages, which is where the
 * games keep them too.
 *
 * Everything here is a counter or a flag with a name, and the battle ticks
 * them down together at the end of a turn. Keeping them in one place is what
 * makes the "did it wear off" line read the same for all of them.
 */

/** The states the engine models, and what each one's counter means. */
export const VOLATILE = {
  /** Turns left confused; a third of the time it hits itself instead. */
  CONFUSION: 'confusion',
  /** Infatuated with the other side; half the time it cannot bring itself to. */
  INFATUATION: 'infatuation',
  /** Turns left unable to use a status move. */
  TAUNT: 'taunt',
  /** Turns left locked into the move named in `encoreMove`. */
  ENCORE: 'encore',
  /** Turns left unable to use the move named in `disabledMove`. */
  DISABLE: 'disable',
  /** Turns left unable to use the same move twice running. */
  TORMENT: 'torment',
  /** Turns until the holder faints, which is what Perish Body starts. */
  PERISH: 'perish',
};

/** How long confusion lasts, as the games roll it. */
/**
 * The conditions that go into the save, by the code the save writes them
 * under, as the move data names them — so an ability can ask for a paralysis
 * in the same words a move does.
 * @type {Record<string, string>}
 */
export const STATUS_AILMENTS = { brn: 'burn', psn: 'poison', par: 'paralysis', slp: 'sleep', frz: 'freeze' };

/** And the other way round. @type {Record<string, string>} */
export const AILMENT_STATUSES = Object.fromEntries(Object.entries(STATUS_AILMENTS).map(([status, ailment]) => [ailment, status]));

export const CONFUSION_TURNS = /** @type {[number, number]} */ ([2, 5]);

/**
 * How often a confused Pokémon hits itself instead.
 *
 * Half the time through Generation 6, a third from Generation 7 — this game
 * follows the newest rules everywhere else, so it follows them here.
 */
export const CONFUSION_SELF_HIT = 1 / 3;

/** The power of the hit it lands on itself: a typeless physical 40. */
export const CONFUSION_POWER = 40;

/** How often infatuation stops a Pokémon moving. */
export const INFATUATION_BLOCK = 1 / 2;

/**
 * A fresh bag of states, for a combatant just being built.
 * @returns {Record<string, any>}
 */
export function freshVolatile() {
  return {};
}

/**
 * Put a state on a combatant, or refuse when it is already there.
 *
 * @param {any} combatant
 * @param {string} state one of `VOLATILE`
 * @param {number} turns
 * @param {Record<string, any>} [extra] anything the state needs to remember
 * @returns {boolean} whether it took hold
 */
export function addVolatile(combatant, state, turns, extra = {}) {
  if (combatant.volatile[state] > 0) return false;
  combatant.volatile[state] = turns;
  Object.assign(combatant.volatile, extra);
  return true;
}

/** @param {any} combatant @param {string} state */
export const hasVolatile = (combatant, state) => (combatant.volatile[state] ?? 0) > 0;

/**
 * Take a state off, and say whether there was one to take.
 * @param {any} combatant
 * @param {string} state
 */
export function clearVolatile(combatant, state) {
  if (!hasVolatile(combatant, state)) return false;
  combatant.volatile[state] = 0;
  if (state === VOLATILE.ENCORE) combatant.volatile.encoreMove = null;
  if (state === VOLATILE.DISABLE) combatant.volatile.disabledMove = null;
  return true;
}

/**
 * Count every state down a turn and report the ones that ran out.
 *
 * Infatuation is the exception: it has no clock in the games and lasts until
 * one of the two leaves, so it is stored as a flag that never counts down.
 *
 * @param {any} combatant
 * @returns {string[]} the states that ended
 */
export function tickVolatile(combatant) {
  /** @type {string[]} */
  const ended = [];
  for (const state of TIMED) {
    if (!hasVolatile(combatant, state)) continue;
    combatant.volatile[state] -= 1;
    if (combatant.volatile[state] <= 0) {
      clearVolatile(combatant, state);
      ended.push(state);
    }
  }
  return ended;
}

/** The states that run on a clock. */
const TIMED = [
  VOLATILE.CONFUSION,
  VOLATILE.TAUNT,
  VOLATILE.ENCORE,
  VOLATILE.DISABLE,
  VOLATILE.TORMENT,
  VOLATILE.PERISH,
];

/**
 * Whether two Pokémon are the pair infatuation needs.
 *
 * One of each, and neither of them genderless — which is why gender had to
 * exist before this could.
 *
 * @param {{gender?: string|null}} one
 * @param {{gender?: string|null}} other
 */
export function oppositeGenders(one, other) {
  return Boolean(one?.gender && other?.gender && one.gender !== other.gender);
}

/**
 * The moves that put a Pokémon behind something for a turn, and what the
 * Pokémon that ran into it pays.
 *
 * These cannot be read off the data: PokeAPI files all of them as "unique",
 * and nothing in the record says that a Spiky Shield costs the attacker an
 * eighth of its health while a King's Shield costs it a stage of Attack. So
 * the eight of them are named, with the price each one charges for touching
 * it — `damage` as a fraction of the attacker's maximum, `stat` as a stage it
 * takes off, `status` as a condition it hands over.
 *
 * @type {Record<string, {damage?: number, stat?: string, stages?: number, status?: string}>}
 */
export const PROTECT_MOVES = {
  protect: {},
  detect: {},
  'max-guard': {},
  'spiky-shield': { damage: 1 / 8 },
  'baneful-bunker': { status: 'psn' },
  'burning-bulwark': { status: 'brn' },
  'kings-shield': { stat: 'atk', stages: -1 },
  obstruct: { stat: 'def', stages: -2 },
  'silk-trap': { stat: 'spe', stages: -1 },
};

/**
 * How likely a Protect is to work, having worked this many turns running.
 *
 * One in three each time after the first, which is the modern rule and what
 * stops a Pokémon standing behind one forever.
 *
 * @param {number} streak
 */
export const protectChance = (streak) => 1 / 3 ** streak;

/** The move that walks straight through one. */
export const PROTECT_BYPASS = new Set(['feint', 'shadow-force', 'phantom-force', 'hyperspace-hole', 'hyperspace-fury']);

/**
 * The moves that take a move away rather than damage.
 *
 * Each names the state it applies and how long for. Torment has no clock in
 * the games — it lasts as long as the Pokémon stays out — so it is stored the
 * way infatuation is.
 *
 * @type {Record<string, {state: string, turns: number}>}
 */
export const LOCK_MOVES = {
  disable: { state: VOLATILE.DISABLE, turns: 4 },
  taunt: { state: VOLATILE.TAUNT, turns: 3 },
  encore: { state: VOLATILE.ENCORE, turns: 3 },
  torment: { state: VOLATILE.TORMENT, turns: Infinity },
};
