/**
 * How the other side picks its move.
 *
 * The companion's own moves follow the policy the player set; everything it
 * meets decides for itself, and this is how. Every move still open is given a
 * score for this turn and the best is used — or, when an attack and something
 * else come out close, either, so the same Pokémon does not play the same line
 * every time.
 *
 * The scoring reads the board the way the games' better trainers do: take a
 * knock-out when one is there, reach for a priority move when about to go
 * down first, put a sleep or a paralysis on something healthy before trading
 * blows with it, set up while there is time and health to, and heal when the
 * health has run low rather than at the last sliver. It knows the companion's
 * moves only as far as they have been shown: a wild Pokémon goes by what
 * the companion plainly is — its types, its build — and a trainer adds to
 * that every move it has watched the companion use this battle (see
 * `expectedThreat`). It does not see dice.
 *
 * What the move filter already rules out — a status at something already
 * suffering one, a Rain Dance in the rain, an attack the type chart says
 * cannot land — never reaches here (see `Battle.stillAllowed`).
 */
import { moveOf, typeEffectiveness } from '../core/data.mjs';
import { categoryOf, cannotTouch, companionArmour, expectedDamage } from './battle.mjs';
import { FIELD_MOVES } from './field.mjs';
import { neverAutomatic } from './moveeffects.mjs';
import { PROTECT_MOVES } from './volatile.mjs';
import { levelOf, maxHp } from './pokemon.mjs';

/**
 * How close to the best score a move has to come to be in the running. Ten
 * percent either way is a matter of taste, not of judgement.
 */
const CLOSE_ENOUGH = 0.9;

/** What putting each condition on the other side is worth, before anything else is weighed. */
const AILMENT_WORTH = {
  sleep: 80,
  yawn: 50,
  paralysis: 55,
  burn: 45,
  poison: 40,
  'leech-seed': 45,
  confusion: 35,
  infatuation: 30,
  trap: 20,
};

/** The four Pokémon conditions, which do not stack. */
const MAJOR = new Set(['sleep', 'paralysis', 'burn', 'poison', 'freeze']);

/** The weather each type is glad of. */
const WEATHER_TYPES = { sun: ['fire'], rain: ['water'], sandstorm: ['rock'], hail: ['ice'], snow: ['ice'] };
const TERRAIN_TYPES = { electric: ['electric'], grassy: ['grass'], psychic: ['psychic'] };

/**
 * Choose the move a Pokémon on the other side uses this turn.
 *
 * @param {import('./battle.mjs').Battle} battle
 * @param {import('./battle.mjs').Combatant} attacker
 * @param {import('./battle.mjs').Combatant} defender
 * @param {Array<{move: string, pp: number}>} usable
 * @returns {string|null} null when nothing scores at all, for the caller's
 *   own fallback
 */
export function chooseFoeMove(battle, attacker, defender, usable) {
  const read = sizeUp(battle, attacker, defender, usable);
  const scored = usable.map((slot) => ({ move: slot.move, score: scoreMove(battle, read, slot.move) }));
  const top = Math.max(0, ...scored.map((entry) => entry.score));
  if (top <= 0) return null;
  const close = scored.filter((entry) => entry.score >= top * CLOSE_ENOUGH);
  // Between two attacks there is nothing to be undecided about: the harder
  // hit. The choice left open is whether to attack at all.
  const attacks = close.filter((entry) => moveOf(entry.move)?.damageClass !== 'status');
  const best = attacks.reduce((a, b) => (b.score > a.score ? b : a), attacks[0]);
  const running = close.filter((entry) => !attacks.includes(entry) || entry === best);
  return running.length === 1 ? running[0].move : battle.rng.pick(running).move;
}

/**
 * Everything about the turn the scores depend on, worked out once.
 *
 * @param {import('./battle.mjs').Battle} battle
 * @param {import('./battle.mjs').Combatant} attacker
 * @param {import('./battle.mjs').Combatant} defender
 * @param {Array<{move: string, pp: number}>} usable
 */
export function sizeUp(battle, attacker, defender, usable) {
  /** @type {Map<string, number>} what each attack takes off, as a share of what the target has left */
  const dealt = new Map();
  /** @type {Set<string>} the damage classes of its own attacks */
  const classes = new Set();
  const left = Math.max(1, defender.pokemon.hp);
  for (const slot of usable) {
    const move = moveOf(slot.move);
    if (!move || move.damageClass === 'status') continue;
    classes.add(move.damageClass);
    if (cannotTouch(defender, move)) continue;
    const armour = companionArmour(defender, typeEffectiveness(move.type, battle.typesOf(defender)));
    dealt.set(slot.move, (expectedDamage(attacker, defender, move) * armour) / left);
  }

  // The worst the other side can do back, and with what — as far as can be
  // told from here.
  const { threat, threatClass } = expectedThreat(battle, attacker, defender);

  const trickRoom = battle.field.trickRoom > 0;
  const mine = battle.speedOf(attacker);
  const theirs = battle.speedOf(defender);
  const outsped = trickRoom ? theirs < mine : theirs > mine;
  const bestHit = Math.max(0, ...dealt.values());

  return {
    attacker,
    defender,
    dealt,
    classes,
    threat,
    threatClass,
    outsped,
    /** It can take the other side down this turn. */
    canFinish: bestHit >= 1,
    /** The other side can take it down this turn. */
    inDanger: threat >= 1,
    /** And will, before it gets to move. */
    goingDown: threat >= 1 && outsped,
    /** A trainer has someone still to send out after this one. */
    othersLeft: attacker.side === 'foe' && battle.foeQueue.some((combatant) => combatant.pokemon.hp > 0),
    myHealth: attacker.pokemon.hp / maxHp(attacker.pokemon),
    theirHealth: defender.pokemon.hp / maxHp(defender.pokemon),
    early: attacker.turnsTaken < 2,
  };
}

/**
 * How hard the other side can be expected to hit back, as a share of the
 * health the one asking has left, and with which kind of attack.
 *
 * Nobody is told the other side's moves. What anyone can see is its types
 * and its build, so the guess is an attack of its own type from whichever of
 * its attacking stats is the stronger, as strong as a Pokémon of its level
 * tends to have. Moves seen used are weighed as well: a trainer remembers
 * what it has watched the companion use, for the rest of the battle — so a
 * Water type's Thunderbolt, once shown, is not forgotten. A wild Pokémon
 * pays no such attention.
 *
 * @param {import('./battle.mjs').Battle} battle
 * @param {import('./battle.mjs').Combatant} attacker the one weighing it up
 * @param {import('./battle.mjs').Combatant} defender the one that would hit back
 * @returns {{threat: number, threatClass: string|null}}
 */
export function expectedThreat(battle, attacker, defender) {
  const physical = battle.stat(defender, 'atk') >= battle.stat(defender, 'spa');
  const power = Math.min(90, Math.round(40 + levelOf(defender.pokemon) * 0.6));
  /** @type {any[]} */
  const moves = battle.typesOf(defender).map((type) => ({
    id: -1,
    type,
    power,
    accuracy: 100,
    damageClass: physical ? 'physical' : 'special',
  }));
  // Only a trainer remembers; the companion's own setting remembers nothing.
  const remembered = defender.side === 'player' && battle.trainerBattle ? battle.seenMoves : [];
  for (const slug of remembered) {
    const move = moveOf(slug);
    if (move && move.damageClass !== 'status') moves.push(move);
  }

  let threat = 0;
  /** @type {string|null} */
  let threatClass = null;
  const own = Math.max(1, attacker.pokemon.hp);
  for (const move of moves) {
    if (cannotTouch(attacker, move)) continue;
    const armour = companionArmour(attacker, typeEffectiveness(move.type, battle.typesOf(attacker)));
    const share = (expectedDamage(defender, attacker, move) * armour) / own;
    if (share > threat) {
      threat = share;
      threatClass = move.damageClass;
    }
  }
  return { threat, threatClass };
}

/**
 * What one move is worth this turn. Nothing is negative; nought is "never".
 *
 * @param {import('./battle.mjs').Battle} battle
 * @param {ReturnType<typeof sizeUp>} read
 * @param {string} slug
 */
export function scoreMove(battle, read, slug) {
  const move = moveOf(slug);
  if (!move || neverAutomatic(slug)) return 0;
  if (move.damageClass !== 'status') return scoreAttack(battle, read, slug, move);

  let score;
  if (PROTECT_MOVES[slug]) score = scoreProtect(read);
  else if (slug === 'rest') score = scoreHeal(read, 1) * (read.attacker.pokemon.status ? 1.2 : 0.8);
  else if (slug === 'substitute') score = read.myHealth > 0.6 && !read.inDanger ? 30 : 3;
  else {
    switch (categoryOf(move)) {
      case 'heal':
        score = scoreHeal(read, (move.meta?.healing || 50) / 100);
        break;
      case 'status':
        score = scoreAilment(read, slug, move);
        break;
      case 'stat':
        score = scoreStats(read, move);
        break;
      default:
        score = scoreField(battle, read, slug);
    }
  }
  // A Memento is a parting gift for whoever comes out next: with nobody
  // behind it, it throws the last Pokémon away for stat drops that end with
  // the battle. With somebody, it is a last resort as an Explosion is.
  if (move.rules?.selfdestruct) {
    if (!read.othersLeft) return 0;
    if (read.myHealth > 0.3 && !read.goingDown) return 3;
  }
  // With a knock-out on the table, anything that is not one waits.
  if (read.canFinish && categoryOf(move) !== 'heal') score *= 0.2;
  // What has already come to nothing against this target is a poor bet.
  const fizzled = read.attacker.marks?.fizzled;
  if (fizzled?.target === read.defender && fizzled.moves.has(slug)) score *= 0.1;
  return score;
}

/**
 * @param {import('./battle.mjs').Battle} battle
 * @param {ReturnType<typeof sizeUp>} read
 * @param {string} slug
 * @param {any} move
 */
function scoreAttack(battle, read, slug, move) {
  const share = read.dealt.get(slug);
  if (share === undefined) return 0;
  // A Counter, a Bide: nothing to count on ahead of the hit they answer.
  if (share === 0) return 5;
  const finishes = share >= 1;
  const priority = battle.priorityOf(read.attacker, read.defender, slug) > 0;
  let score = 20 + Math.min(1, share) * 80;

  if (finishes) score += priority ? 60 : 50;
  // About to go down first: something that moves before the hit that ends it
  // is the only thing that gets to happen at all.
  if (read.goingDown && priority) score += finishes ? 60 : 30;
  // An Explosion is a last resort, not an opening — and never the way to
  // finish what something else would have. The last Pokémon of all only goes
  // up to take the other side with it.
  if (move.rules?.selfdestruct) {
    if (!read.othersLeft && !finishes) return 0;
    if (read.myHealth > 0.3 && !read.goingDown) return 3;
    score *= 0.5;
  }
  // A turn spent recharging is only worth it for the knock-out.
  if (move.flags?.includes('recharge') && !finishes) score *= 0.7;
  // A draining hit is worth a little more to something that needs the health.
  if ((move.meta?.drain ?? 0) > 0 && read.myHealth < 0.5) score += 10;
  return score;
}

/** @param {ReturnType<typeof sizeUp>} read */
function scoreProtect(read) {
  // Twice running is a coin toss at best.
  if (PROTECT_MOVES[read.attacker.lastMove ?? '']) return 0;
  const ticking = ['brn', 'psn', 'tox'].includes(read.defender.pokemon.status ?? '');
  return ticking ? 35 : 10;
}

/**
 * @param {ReturnType<typeof sizeUp>} read
 * @param {number} restores the share of its health the move puts back
 */
function scoreHeal(read, restores) {
  if (read.myHealth >= 0.75) return 3;
  let score = (1 - read.myHealth) * 110;
  // Healing is a race: one the other side wins anyway is not worth the turn.
  if (read.threat * read.myHealth >= restores) score *= 0.4;
  if (read.goingDown) score *= 0.3;
  return score;
}

/**
 * @param {ReturnType<typeof sizeUp>} read
 * @param {string} slug
 * @param {any} move
 */
function scoreAilment(read, slug, move) {
  const ailment = move.meta?.ailment ?? 'none';
  if (MAJOR.has(ailment) && read.defender.pokemon.status) return 0;
  let score = AILMENT_WORTH[ailment] ?? 15;
  if (slug === 'toxic') score += 15;
  // Paralysis earns its keep by taking away the first move.
  if (ailment === 'paralysis' && read.outsped) score += 20;
  // A burn halves a physical attacker's hits, and does little else.
  if (ailment === 'burn') score += read.threatClass === 'physical' ? 25 : -15;
  score *= (move.accuracy ?? 100) / 100;
  // On something nearly beaten, finish it instead.
  if (read.theirHealth < 0.4) score *= 0.4;
  if (read.goingDown) score *= 0.2;
  else if (read.inDanger) score *= 0.6;
  return score;
}

/**
 * Raising its own stats, lowering the other side's, or both.
 *
 * @param {ReturnType<typeof sizeUp>} read
 * @param {any} move
 */
function scoreStats(read, move) {
  let score = 0;
  for (const change of move.statChanges ?? []) {
    const self = change.self ?? change.change > 0;
    const target = self ? read.attacker : read.defender;
    const stage = target.stages[change.stat] ?? 0;
    // A stage already as far as it goes moves no further, either way.
    if (change.change > 0 ? stage >= 6 : stage <= -6) continue;
    const worth = statWorth(read, change.stat, self);
    if (self && change.change > 0) {
      // Each stage already gained is a reason not to spend another turn.
      score += Math.max(0, worth * change.change - stage * 10);
    } else if (!self && change.change < 0) {
      score += Math.max(0, worth * -change.change + (stage + 2) * 4);
    } else {
      // A Curse's Speed, a Shell Smash's defences: what it pays.
      score -= (worth * Math.abs(change.change)) / 2;
    }
  }
  if (score <= 0) return 0;
  score = Math.min(score, 60);
  // Setting up is for a fight with time left in it.
  if (read.inDanger) score *= 0.2;
  else score *= read.myHealth;
  if (!read.early) score *= 0.75;
  if (read.theirHealth < 0.35) score *= 0.3;
  return score;
}

/**
 * How much one stage of a stat matters in this fight.
 *
 * @param {ReturnType<typeof sizeUp>} read
 * @param {string} stat
 * @param {boolean} own whether it is its own stat
 */
function statWorth(read, stat, own) {
  switch (stat) {
    case 'atk':
      return own ? (read.classes.has('physical') ? 18 : 0) : read.threatClass === 'physical' ? 14 : 2;
    case 'spa':
      return own ? (read.classes.has('special') ? 18 : 0) : read.threatClass === 'special' ? 14 : 2;
    case 'def':
      return own ? (read.threatClass === 'physical' ? 12 : 3) : read.classes.has('physical') ? 14 : 2;
    case 'spd':
      return own ? (read.threatClass === 'special' ? 12 : 3) : read.classes.has('special') ? 14 : 2;
    case 'spe':
      return read.outsped ? 16 : 3;
    default:
      return 6;
  }
}

/**
 * Weather, terrain, screens, rooms and the rest that change the ground
 * rather than either Pokémon.
 *
 * @param {import('./battle.mjs').Battle} battle
 * @param {ReturnType<typeof sizeUp>} read
 * @param {string} slug
 */
function scoreField(battle, read, slug) {
  const set = FIELD_MOVES[slug];
  const timing = read.early ? 1 : 0.6;
  if (!set) return 15 * timing;
  // The companion never switches, so a trap laid for what comes in next
  // catches nothing.
  if (set.hazard) return 2;
  if (set.room || set.tailwind) return read.outsped ? 45 * timing : 3;
  if (set.screen) {
    const covers = set.screen === 'both' || set.screen === read.threatClass;
    return (covers ? 40 : 8) * timing;
  }
  const helped = (set.weather ? WEATHER_TYPES[set.weather] : TERRAIN_TYPES[set.terrain ?? '']) ?? [];
  const own = battle.typesOf(read.attacker);
  const powers = [...read.dealt.keys()].some((slug) => helped.includes(moveOf(slug)?.type));
  return (powers || own.some((type) => helped.includes(type)) ? 35 : 6) * timing;
}
