/**
 * A suggested auto-battle setting for one Pokémon's moves.
 *
 * The auto-battle screen's one-press setup: every move is given a first and a
 * second condition from what it is, and the moves are put in an order that
 * lets the urgent ones go first. It is a starting point the player can then
 * adjust, not a solver — it reads only the moves themselves and the Pokémon
 * that knows them, never a particular foe.
 *
 * In brief: attacks are left to the hardest-hit rule, a priority attack is
 * kept for finishing, a heal waits for half health, a sleep or a paralysis
 * goes on a foe still healthy, a boost that helps its own attacks is used
 * once a battle, and the field moves that pay off over several turns are
 * kept for trainers, whose battles last long enough for them. What would
 * waste a turn in a battle of one against one — a Growl, a Protect, a trap
 * for a Pokémon that never switches in — is switched off.
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
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @returns {{order: string[], moves: Record<string, string>, second: Record<string, string>}}
 *   the moves in their suggested order, and each one's first and second
 *   condition
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

  /** @type {Array<{slug: string, rank: number, power: number, first: string, second: string}>} */
  const plan = slugs.map((slug) => ({ slug, power: moveOf(slug).power ?? 0, ...judge(slug, moveOf(slug), fed, attackTypes) }));
  plan.sort((a, b) => a.rank - b.rank || b.power - a.power);

  /** @type {Record<string, string>} */
  const moves = {};
  /** @type {Record<string, string>} */
  const second = {};
  for (const entry of plan) {
    moves[entry.slug] = entry.first;
    second[entry.slug] = entry.second;
  }
  return { order: plan.map((entry) => entry.slug), moves, second };
}

/**
 * The place and the two conditions for one move.
 *
 * @param {string} slug
 * @param {any} move
 * @param {Set<string>} fed the attack classes a boost would feed
 * @param {Set<string>} attackTypes
 * @returns {{rank: number, first: string, second: string}}
 */
function judge(slug, move, fed, attackTypes) {
  const off = { rank: RANK.off, first: 'never', second: 'never' };
  if (neverAutomatic(slug) || PROTECT_MOVES[slug] || RETALIATES.has(slug) || slug === 'bide') return off;

  if (move.damageClass !== 'status') {
    if (!move.power && !move.rules?.damage && !move.rules?.ohko) {
      // A fixed-damage move without a number on it (a Super Fang, an
      // Endeavor) is still an attack; the hardest-hit rule weighs it.
      return { rank: RANK.attack, first: 'always', second: 'never' };
    }
    if (FIRST_TURN_ONLY.has(slug)) return { rank: RANK.finisher, first: 'foeEntered', second: 'never' };
    if (move.rules?.selfdestruct) return { rank: RANK.finisher, first: 'hpQuarter', second: 'never' };
    // A priority attack is weaker by design: kept to finish a foe off before
    // it can answer, and otherwise one more attack among the rest.
    if ((move.priority ?? 0) > 0) return { rank: RANK.finisher, first: 'foeHpQuarter', second: 'always' };
    return { rank: RANK.attack, first: 'always', second: 'never' };
  }

  switch (categoryOf(move)) {
    case 'heal':
      return { rank: RANK.heal, first: slug === 'rest' ? 'hpThird' : 'hpHalf', second: 'never' };
    case 'status': {
      const ailment = move.meta?.ailment ?? 'none';
      // Only on a foe with the health left to make it worth a turn; one
      // already suffering is passed over by the battle itself.
      if (DISABLING.has(ailment)) return { rank: RANK.disable, first: 'foeHpAboveHalf', second: 'never' };
      if (WEARING.has(ailment)) return { rank: RANK.wear, first: 'foeHpAboveHalf', second: 'never' };
      return off;
    }
    case 'stat': {
      const changes = move.statChanges ?? [];
      const own = changes.filter((change) => change.self ?? change.change > 0);
      const feeds = own.some((change) =>
        change.change > 0 && ((change.stat === 'atk' && fed.has('physical')) || (change.stat === 'spa' && fed.has('special'))));
      // A boost that makes its own attacks hit harder, once a battle. One
      // that only toughens it, or only weakens the foe, costs a turn a
      // short fight does not have.
      if (feeds) return { rank: RANK.boost, first: 'oncePerBattle', second: 'never' };
      return off;
    }
    default:
      return judgeField(slug, attackTypes);
  }
}

/**
 * @param {string} slug
 * @param {Set<string>} attackTypes
 */
function judgeField(slug, attackTypes) {
  const off = { rank: RANK.off, first: 'never', second: 'never' };
  const set = FIELD_MOVES[slug];
  if (!set) return off;
  const forTrainers = { rank: RANK.field, first: 'trainerBattle', second: 'never' };
  // A trap is laid for the foe's next Pokémon, which only a trainer has.
  if (set.hazard || set.screen) return forTrainers;
  // A Trick Room helps or hurts by a Speed comparison no move list can make.
  if (set.room) return off;
  if (set.tailwind) return forTrainers;
  const helped = HELPS[set.weather ?? set.terrain ?? ''] ?? [];
  return helped.some((type) => attackTypes.has(type)) ? forTrainers : off;
}
