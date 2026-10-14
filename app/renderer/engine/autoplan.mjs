/**
 * A suggested auto-battle setting for one Pokémon's moves.
 *
 * The auto-battle screen's one-press setup works in two steps. This module is
 * the first: every move is given a first and a second condition from what it
 * is, and the moves are put in an order that lets the urgent ones go first.
 * It reads only the moves and the Pokémon that knows them. The second step
 * (`autotune.mjs`) tries the alternatives each move is offered here against
 * the Pokémon the companion is actually meeting, and keeps what wins more.
 *
 * In brief: attacks are left to the hardest-hit rule; a priority attack is
 * kept for striking before going down, or for a sure finish; a heal waits for
 * half health; a sleep or a paralysis goes on a foe still healthy; a boost
 * that feeds its own attacks is used once a battle; a Reflect waits for a
 * physical attacker and a Light Screen for a special one; and the field
 * moves that pay off over several turns are kept for trainers, whose battles
 * last long enough for them. What would waste a turn in a battle of one
 * against one — a Growl, a Protect, a boost that feeds nothing — is
 * switched off, unless the trial run finds it earns its turn after all.
 */
import { moveOf } from '../core/data.mjs';
import { categoryOf, FIRST_TURN_ONLY } from './battle.mjs';
import { FIELD_MOVES } from './field.mjs';
import { neverAutomatic, RETALIATES } from './moveeffects.mjs';
import { statsOf } from './pokemon.mjs';
import { PROTECT_MOVES } from './volatile.mjs';

/** The conditions that are worth putting on a foe before trading blows. */
const DISABLING = new Set(['sleep', 'paralysis', 'yawn']);
const WEARING = new Set(['poison', 'burn', 'leech-seed', 'confusion', 'infatuation']);

/** The weather and terrain each type is glad of. */
const HELPS = {
  sun: ['fire'], rain: ['water'], sandstorm: ['rock', 'ground', 'steel'], hail: ['ice'], snow: ['ice'],
  electric: ['electric'], grassy: ['grass'], psychic: ['psychic'], misty: [],
};

/**
 * Where each kind of move goes in the order, earliest first: a heal before
 * anything, since health is what the rest depend on, then what disables the
 * foe, then boosts and field moves, then the attacks, strongest first, and
 * what is switched off at the bottom.
 */
const RANK = { heal: 0, disable: 1, wear: 2, boost: 3, field: 4, finisher: 5, attack: 6, off: 9 };

/**
 * The first-and-second pairs each kind of move is tried with, the suggestion
 * first. A pair is `[first, second]`.
 *
 * @type {Record<string, Array<[string, string]>>}
 */
const ALTERNATIVES = {
  attack: [['always', 'never'], ['never', 'never']],
  priority: [['inDanger', 'canFinish'], ['canFinish', 'always'], ['inDanger', 'always'], ['always', 'never']],
  selfdestruct: [['inDanger', 'never'], ['hpQuarter', 'never'], ['never', 'never']],
  firstTurnOnly: [['foeEntered', 'never'], ['never', 'never']],
  heal: [['hpHalf', 'never'], ['hpThird', 'never'], ['hpTwoThirds', 'never'], ['never', 'never']],
  rest: [['hpThird', 'never'], ['hpHalf', 'never'], ['never', 'never']],
  disable: [['foeHpAboveHalf', 'never'], ['noStatus', 'never'], ['foeEntered', 'never'], ['never', 'never']],
  wear: [['foeHpAboveHalf', 'never'], ['foeHpFull', 'never'], ['noStatus', 'never'], ['never', 'never']],
  boost: [['oncePerBattle', 'never'], ['foeEntered', 'never'], ['hpFull', 'never'], ['never', 'never']],
  screenPhysical: [['foePhysical', 'never'], ['trainerBattle', 'never'], ['never', 'never']],
  screenSpecial: [['foeSpecial', 'never'], ['trainerBattle', 'never'], ['never', 'never']],
  field: [['trainerBattle', 'never'], ['foeEntered', 'never'], ['oncePerBattle', 'never'], ['never', 'never']],
  off: [['never', 'never'], ['oncePerBattle', 'never'], ['foeEntered', 'never']],
  fixedOff: [['never', 'never']],
};

/**
 * @typedef {Object} MovePlan
 * @property {string} slug
 * @property {number} rank where it goes in the order
 * @property {number} power
 * @property {string} first
 * @property {string} second
 * @property {Array<[string, string]>} alternatives the pairs worth trying, its own first
 */

/**
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @returns {{order: string[], moves: Record<string, string>, second: Record<string, string>, plans: MovePlan[]}}
 *   the moves in their suggested order, each one's first and second
 *   condition, and the plan behind each
 */
export function suggestPolicy(pokemon) {
  const slugs = pokemon.moves.map((slot) => slot.move).filter((slug) => moveOf(slug));
  const attacks = slugs.map((slug) => moveOf(slug)).filter((move) => move.damageClass !== 'status' && move.power);
  const classes = new Set(attacks.map((move) => move.damageClass));
  const attackTypes = new Set(attacks.map((move) => move.type));
  const stats = statsOf(pokemon);
  const leaning = stats.atk >= stats.spa ? 'physical' : 'special';
  // With both kinds of attack, the one its build favours is what a boost should feed.
  const fed = classes.size > 1 ? new Set([leaning]) : classes;

  /** @type {MovePlan[]} */
  const plans = slugs.map((slug) => {
    const move = moveOf(slug);
    const { rank, kind } = judge(slug, move, fed, attackTypes);
    // An attack is only worth switching off with another attack to fall back on.
    const tries = kind === 'attack' && attacks.length < 2 ? ALTERNATIVES.attack.slice(0, 1) : ALTERNATIVES[kind];
    const [first, second] = tries[0];
    return { slug, rank, power: move.power ?? 0, first, second, alternatives: tries };
  });
  plans.sort((a, b) => a.rank - b.rank || b.power - a.power);
  return { ...settingsOf(plans), plans };
}

/**
 * The order and the two condition tables a list of plans comes to.
 *
 * @param {MovePlan[]} plans
 */
export function settingsOf(plans) {
  /** @type {Record<string, string>} */
  const moves = {};
  /** @type {Record<string, string>} */
  const second = {};
  for (const plan of plans) {
    moves[plan.slug] = plan.first;
    second[plan.slug] = plan.second;
  }
  return { order: plans.map((plan) => plan.slug), moves, second };
}

/**
 * What kind of move this is, for its place in the order and the conditions
 * it is tried with.
 *
 * @param {string} slug
 * @param {any} move
 * @param {Set<string>} fed the attack classes a boost would feed
 * @param {Set<string>} attackTypes
 * @returns {{rank: number, kind: keyof typeof ALTERNATIVES}}
 */
function judge(slug, move, fed, attackTypes) {
  if (neverAutomatic(slug) || RETALIATES.has(slug) || slug === 'bide') return { rank: RANK.off, kind: 'fixedOff' };
  if (PROTECT_MOVES[slug]) return { rank: RANK.off, kind: 'off' };

  if (move.damageClass !== 'status') {
    if (FIRST_TURN_ONLY.has(slug)) return { rank: RANK.finisher, kind: 'firstTurnOnly' };
    if (move.rules?.selfdestruct) return { rank: RANK.finisher, kind: 'selfdestruct' };
    // A priority attack is weaker by design: kept to strike before going
    // down, or to finish a foe before it can answer.
    if ((move.priority ?? 0) > 0) return { rank: RANK.finisher, kind: 'priority' };
    return { rank: RANK.attack, kind: 'attack' };
  }

  switch (categoryOf(move)) {
    case 'heal':
      return { rank: RANK.heal, kind: slug === 'rest' ? 'rest' : 'heal' };
    case 'status': {
      const ailment = move.meta?.ailment ?? 'none';
      // Only on a foe with the health left to make it worth a turn; one
      // already suffering is passed over by the battle itself.
      if (DISABLING.has(ailment)) return { rank: RANK.disable, kind: 'disable' };
      if (WEARING.has(ailment)) return { rank: RANK.wear, kind: 'wear' };
      return { rank: RANK.off, kind: 'off' };
    }
    case 'stat': {
      const own = (move.statChanges ?? []).filter((change) => change.self ?? change.change > 0);
      const feeds = own.some((change) =>
        change.change > 0 && ((change.stat === 'atk' && fed.has('physical')) || (change.stat === 'spa' && fed.has('special'))));
      // A boost that makes its own attacks hit harder. One that only toughens
      // it, or only weakens the foe, costs a turn a short fight does not have.
      return feeds ? { rank: RANK.boost, kind: 'boost' } : { rank: RANK.off, kind: 'off' };
    }
    default:
      return judgeField(slug, attackTypes);
  }
}

/**
 * @param {string} slug
 * @param {Set<string>} attackTypes
 * @returns {{rank: number, kind: keyof typeof ALTERNATIVES}}
 */
function judgeField(slug, attackTypes) {
  const set = FIELD_MOVES[slug];
  const off = { rank: RANK.off, kind: /** @type {const} */ ('off') };
  if (!set) return off;
  if (set.screen === 'physical') return { rank: RANK.field, kind: 'screenPhysical' };
  if (set.screen === 'special') return { rank: RANK.field, kind: 'screenSpecial' };
  // A trap is laid for the foe's next Pokémon, which only a trainer has.
  if (set.hazard || set.screen || set.tailwind) return { rank: RANK.field, kind: 'field' };
  // A Trick Room helps or hurts by a Speed comparison no move list can make;
  // the trial run is left to find out.
  if (set.room) return off;
  const helped = HELPS[set.weather ?? set.terrain ?? ''] ?? [];
  return helped.some((type) => attackTypes.has(type)) ? { rank: RANK.field, kind: 'field' } : off;
}
