/**
 * Stat, level and experience mathematics, following the main series.
 *
 * Formulas are the modern (Gen 3 onward) ones, which Gen 9 still uses:
 * stats from base + IV + effort + nature, experience by growth curve, and the
 * Gen 5+ experience yield that scales with the level gap.
 */

/** The six stat keys, in the order the games display them. */
export const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

/** Stat stages run -6..+6 and multiply by these. */
const STAGE_MULTIPLIERS = [
  2 / 8, 2 / 7, 2 / 6, 2 / 5, 2 / 4, 2 / 3,
  1,
  3 / 2, 4 / 2, 5 / 2, 6 / 2, 7 / 2, 8 / 2,
];

/**
 * Accuracy and evasion use a different stage table from the battle stats.
 */
const ACCURACY_MULTIPLIERS = [3 / 9, 3 / 8, 3 / 7, 3 / 6, 3 / 5, 3 / 4, 1, 4 / 3, 5 / 3, 2, 7 / 3, 8 / 3, 3];

/**
 * @param {number} stage -6..6
 * @param {boolean} [isAccuracy]
 */
export function stageMultiplier(stage, isAccuracy = false) {
  const clamped = Math.max(-6, Math.min(6, Math.round(stage)));
  const table = isAccuracy ? ACCURACY_MULTIPLIERS : STAGE_MULTIPLIERS;
  return table[clamped + 6];
}

/**
 * @param {number} base base stat
 * @param {number} iv 0..31
 * @param {number} ev 0..252, of which every four points is one point of stat
 * @param {number} level
 * @param {number} natureMultiplier 0.9, 1 or 1.1
 * @param {boolean} isHp
 */
export function computeStat(base, iv, ev, level, natureMultiplier, isHp) {
  const common = Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100);
  if (isHp) return common + level + 10;
  return Math.floor((common + 5) * natureMultiplier);
}

/** The most effort one stat can hold, and all six together, since Gen 6. */
export const EFFORT_STAT_MAX = 252;
export const EFFORT_TOTAL_MAX = 510;

/** A Pokémon's effort, every stat present and nothing past the limits. */
export function settledEffort(evs = {}) {
  /** @type {Record<string, number>} */
  const out = {};
  let left = EFFORT_TOTAL_MAX;
  for (const stat of STATS) {
    const value = Math.max(0, Math.min(EFFORT_STAT_MAX, left, Math.floor(Number(evs[stat]) || 0)));
    out[stat] = value;
    left -= value;
  }
  return out;
}

/** @param {Record<string, number>} evs */
export const effortTotal = (evs) => STATS.reduce((sum, stat) => sum + (evs?.[stat] ?? 0), 0);

/**
 * Effort added, stat by stat, as far as the limits allow: each stat stops at
 * 252, and whatever would carry the six past 510 is not earned. The stats are
 * filled in the games' order when the total runs out partway.
 *
 * @param {Record<string, number>} evs
 * @param {Record<string, number>} gained
 * @returns {Record<string, number>}
 */
export function addEffort(evs, gained) {
  const out = settledEffort(evs);
  let left = EFFORT_TOTAL_MAX - effortTotal(out);
  for (const stat of STATS) {
    const wanted = Math.max(0, Math.floor(gained[stat] ?? 0));
    const added = Math.min(wanted, EFFORT_STAT_MAX - out[stat], left);
    out[stat] += added;
    left -= added;
  }
  return out;
}

/**
 * All six stats for a Pokémon.
 *
 * @param {Record<string, number>} base
 * @param {Record<string, number>} ivs
 * @param {Record<string, number>|undefined} evs
 * @param {number} level
 * @param {{increased: string|null, decreased: string|null}} nature
 * @returns {Record<string, number>}
 */
export function computeStats(base, ivs, evs, level, nature) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const stat of STATS) {
    const multiplier = stat === 'hp' ? 1 : natureMultiplierFor(nature, stat);
    out[stat] = computeStat(base[stat] ?? 1, ivs[stat] ?? 0, evs?.[stat] ?? 0, level, multiplier, stat === 'hp');
  }
  return out;
}

/**
 * @param {{increased: string|null, decreased: string|null}} nature
 * @param {string} stat
 */
export function natureMultiplierFor(nature, stat) {
  if (!nature || nature.increased === nature.decreased) return 1;
  if (nature.increased === stat) return 1.1;
  if (nature.decreased === stat) return 0.9;
  return 1;
}

/**
 * Total experience needed to reach a level on a growth curve.
 *
 * @param {string} growthRate PokeAPI growth-rate slug
 * @param {number} level
 * @returns {number}
 */
export function experienceForLevel(growthRate, level) {
  const n = Math.max(1, Math.min(100, Math.floor(level)));
  switch (growthRate) {
    case 'fast':
      return Math.floor((4 * n ** 3) / 5);
    case 'slow':
      return Math.floor((5 * n ** 3) / 4);
    case 'medium-slow':
      return Math.max(0, Math.floor((6 / 5) * n ** 3 - 15 * n ** 2 + 100 * n - 140));
    case 'slow-then-very-fast':
      return erratic(n);
    case 'fast-then-very-slow':
      return fluctuating(n);
    case 'medium':
    default:
      return n ** 3;
  }
}

/** @param {number} n */
function erratic(n) {
  if (n <= 50) return Math.floor((n ** 3 * (100 - n)) / 50);
  if (n <= 68) return Math.floor((n ** 3 * (150 - n)) / 100);
  if (n <= 98) return Math.floor((n ** 3 * Math.floor((1911 - 10 * n) / 3)) / 500);
  return Math.floor((n ** 3 * (160 - n)) / 100);
}

/** @param {number} n */
function fluctuating(n) {
  if (n <= 15) return Math.floor((n ** 3 * (Math.floor((n + 1) / 3) + 24)) / 50);
  if (n <= 36) return Math.floor((n ** 3 * (n + 14)) / 50);
  return Math.floor((n ** 3 * (Math.floor(n / 2) + 32)) / 50);
}

/**
 * The level a given total experience corresponds to.
 * @param {string} growthRate
 * @param {number} experience
 */
export function levelForExperience(growthRate, experience) {
  let level = 1;
  while (level < 100 && experience >= experienceForLevel(growthRate, level + 1)) level++;
  return level;
}

/**
 * Experience awarded for defeating a Pokémon, using the Gen 5+ formula that
 * scales with the level difference — so a low-level companion catches up fast
 * and a high-level one stops farming weak encounters.
 *
 * @param {{baseExp: number, level: number}} defeated
 * @param {number} winnerLevel
 * @param {number} [multiplier] 1.5 for a trainer battle, as in the games
 */
export function experienceYield(defeated, winnerLevel, multiplier = 1) {
  const b = Math.max(1, defeated.baseExp);
  const L = Math.max(1, defeated.level);
  const Lp = Math.max(1, winnerLevel);
  const scaled = ((b * L) / 5) * ((2 * L + 10) / (L + Lp + 10)) ** 2.5;
  return Math.max(1, Math.floor(scaled * multiplier) + 1);
}
