/**
 * The auto-battle screen's one-press setup: a first and a second condition
 * for each of the companion's moves, and an order for them.
 *
 * Everything here is read from the moves and the Pokémon that knows them —
 * its stats, its other moves, its ability — never from a foe or a battle, and
 * nothing is tried out. The rules are written move by move, the way a player
 * who knows the games would set each one, and each is a plain if-this-then-
 * that a player could check by hand. In outline:
 *
 * - Attacks are left to the hardest-hit rule ("Default"). The ones that cost
 *   something to use — a turn recharging, two turns charging, a sharp fall
 *   in its own stat — are kept to finish a foe when there is another attack
 *   to do the ordinary work. A weak priority attack is kept for a finish, or
 *   for a last swing at low health. An attack that is stronger under some
 *   condition — a Hex on a foe with a status, a Facade with its own, a Brine
 *   on a foe at half — is used the moment that condition holds, and is an
 *   ordinary attack otherwise.
 * - A heal waits for half health; a fast, frail Pokémon, which gets its heal
 *   in before the next hit, holds out to a third.
 * - Sleep goes on a foe still healthy; an unreliable one is tried once per
 *   foe, on the first turn nothing else needs. Paralysis is for a foe that is faster, a burn for a foe that hits
 *   physically, and the slow conditions — poison, Leech Seed — are for a
 *   Pokémon bulky enough to wait for them to work.
 * - A boost that feeds its own attacks is used once a battle, and again after
 *   its stats have been lowered. One that only toughens it is used only when
 *   something in its moves pays off on that — a Body Press, a Stored Power.
 *   Speed is raised when the foe is faster.
 * - Weather and terrain are set when the field is clear, and only when they
 *   power its attacks or its ability. A screen goes up against the kind of
 *   attacker it stops, a trap only against a trainer, who has Pokémon left to
 *   send into it.
 * - What wastes a turn one against one — a Growl, a Double Team, a Taunt, a
 *   Protect with nothing ticking on the foe — is switched off, and so is a
 *   Memento, which loses the battle outright, and a Steel Beam, which costs
 *   half its health, while there is another attack.
 *
 * The order puts what has to be answered first at the top: a heal, a cure,
 * the conditions to put on the foe, the boosts, the field, then the attacks
 * with a moment of their own, then the rest by power, and what is switched
 * off at the bottom.
 */
import { moveOf } from '../core/data.mjs';
import { categoryOf, FIRST_TURN_ONLY } from './battle.mjs';
import { FIELD_MOVES } from './field.mjs';
import { signatureType } from './forms.mjs';
import { neverAutomatic, RETALIATES } from './moveeffects.mjs';
import { statsOf } from './pokemon.mjs';
import { PROTECT_MOVES } from './volatile.mjs';

/** Where each kind of move goes in the order, earliest first. */
const RANK = { heal: 0, cure: 1, disable: 2, wear: 3, boost: 4, field: 5, moment: 6, finisher: 7, attack: 8, off: 9 };

/** The two-turn attacks that stand still for a turn, as against those that vanish for it. */
const CHARGING = new Set([
  'solar-beam', 'solar-blade', 'razor-wind', 'skull-bash', 'sky-attack', 'freeze-shock', 'ice-burn', 'meteor-beam', 'electro-shot',
]);

/** Attacks with a moment of their own: when they are at their best, and what they are otherwise. */
const MOMENT_ATTACKS = {
  hex: ['foeStatus', 'always'],
  venoshock: ['foeStatus', 'always'],
  'infernal-parade': ['foeStatus', 'always'],
  'barb-barrage': ['foeStatus', 'always'],
  'bitter-malice': ['foeStatus', 'always'],
  facade: ['selfStatus', 'always'],
  brine: ['foeHpHalf', 'always'],
  'stored-power': ['rankUp', 'always'],
  'power-trip': ['rankUp', 'always'],
  // Fail outright unless the foe is asleep — the battle passes them over
  // otherwise — and are worth nothing else.
  'dream-eater': ['foeAsleep', 'never'],
  // Only works while its user sleeps.
  snore: ['selfStatus', 'never'],
  // Twice the power with nothing held.
  acrobatics: ['noItem', 'always'],
  // Twice the power on a sleeping foe.
  'wake-up-slap': ['foeAsleep', 'always'],
};

/** Moves that only matter with something to cure. */
const CURES = new Set(['heal-bell', 'aromatherapy', 'refresh', 'jungle-healing', 'take-heart', 'lunar-blessing']);

/** Abilities that make a weather or a terrain worth calling, and the one each wants. */
const WEATHER_ABILITIES = {
  chlorophyll: 'sun', 'solar-power': 'sun', 'flower-gift': 'sun', 'leaf-guard': 'sun', 'harvest': 'sun', protosynthesis: 'sun',
  'swift-swim': 'rain', 'rain-dish': 'rain', 'dry-skin': 'rain', hydration: 'rain',
  'sand-rush': 'sandstorm', 'sand-force': 'sandstorm', 'sand-veil': 'sandstorm',
  'slush-rush': 'snow', 'ice-body': 'snow', 'snow-cloak': 'snow',
  'surge-surfer': 'electric', 'quark-drive': 'electric',
};

/** Abilities that set a weather or a terrain themselves, so the move is not needed. */
const SETS_ITS_OWN = {
  drought: 'sun', 'orichalcum-pulse': 'sun', drizzle: 'rain', 'sand-stream': 'sandstorm', 'snow-warning': 'snow',
  'electric-surge': 'electric', 'hadron-engine': 'electric', 'grassy-surge': 'grassy', 'psychic-surge': 'psychic', 'misty-surge': 'misty',
};

/** The types a weather or a terrain powers, and the ones a weather spoils. */
const POWERS = {
  sun: ['fire'], rain: ['water'], sandstorm: ['rock'], hail: ['ice'], snow: ['ice'],
  electric: ['electric'], grassy: ['grass'], psychic: ['psychic'], misty: [],
};
const SPOILS = { sun: ['water'], rain: ['fire'] };

/** The conditions it can put on a foe that keep doing harm, which a Protect lets tick. */
const RESIDUAL = new Set(['toxic', 'leech-seed', 'will-o-wisp', 'poison-powder', 'poison-gas', 'toxic-spikes']);

/**
 * @typedef {Object} Profile what the rules read about the Pokémon
 * @property {Record<string, number>} stats
 * @property {'physical'|'special'} leaning the side its build favours
 * @property {Set<string>} fed the attack classes a boost should feed
 * @property {boolean} bulky whether its defences outweigh its offence
 * @property {boolean} fast whether its Speed is high for its build
 * @property {boolean} slow whether its Speed is low for its build
 * @property {Array<{slug: string, move: any}>} attacks
 * @property {Set<string>} slugs every move it knows
 * @property {string} ability
 */

/**
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @returns {Profile}
 */
export function profileOf(pokemon) {
  const stats = statsOf(pokemon);
  const slugs = new Set(pokemon.moves.map((slot) => slot.move).filter((slug) => moveOf(slug)));
  const attacks = [...slugs]
    .map((slug) => {
      // A Judgment is the type of the plate behind it, which is what a Sunny Day is weighed against.
      const type = signatureType(pokemon, slug);
      return { slug, move: type ? { ...moveOf(slug), type } : moveOf(slug) };
    })
    .filter(({ move }) => move.damageClass !== 'status');
  const classes = new Set(attacks.filter(({ move }) => move.power).map(({ move }) => move.damageClass));
  const leaning = stats.atk >= stats.spa ? 'physical' : 'special';
  const offence = Math.max(stats.atk, stats.spa);
  const bulk = (stats.def + stats.spd) / 2;
  const build = (stats.atk + stats.spa + stats.def + stats.spd) / 4;
  return {
    stats,
    leaning,
    // With both kinds of attack, the one its build favours is what a boost should feed.
    fed: classes.size > 1 ? new Set([leaning]) : classes,
    bulky: bulk >= offence * 0.9,
    fast: stats.spe >= build * 1.1,
    slow: stats.spe <= build * 0.75,
    attacks,
    slugs,
    ability: pokemon.ability ?? '',
  };
}

/**
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @returns {{order: string[], moves: Record<string, string>, second: Record<string, string>}}
 *   the moves in their suggested order, and each one's first and second
 *   condition
 */
export function suggestPolicy(pokemon) {
  const profile = profileOf(pokemon);
  const plans = [...profile.slugs].map((slug) => {
    const move = moveOf(slug);
    return { slug, power: move.power ?? 0, ...planMove(slug, move, profile) };
  });
  plans.sort((a, b) => a.rank - b.rank || b.power - a.power);

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
 * Give a Pokémon's moves the conditions and the order a plan names, in the
 * policy given. Other Pokémon's moves keep what they had.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {{moves?: Record<string, string>, second?: Record<string, string>}} policy
 * @param {{order: string[], moves: Record<string, string>, second: Record<string, string>}} plan
 */
export function applyPlan(pokemon, policy, plan) {
  policy.moves = { ...(policy.moves ?? {}), ...plan.moves };
  policy.second = { ...(policy.second ?? {}), ...plan.second };
  const bySlug = new Map(pokemon.moves.map((slot) => [slot.move, slot]));
  const ordered = plan.order.map((slug) => bySlug.get(slug)).filter((slot) => slot !== undefined);
  // Anything the plan did not name (a move the data does not know) stays at the end.
  const rest = pokemon.moves.filter((slot) => !plan.order.includes(slot.move));
  // In place, as the swap on the auto-battle screen does, for anything holding the list.
  pokemon.moves.splice(0, pokemon.moves.length, ...ordered, ...rest);
}

/**
 * What the Optimize button does, without the asking: the Pokémon's moves set
 * up by the rules here. A new game's starter and a Pokémon setting out from
 * the box for the first time start this way.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {{moves?: Record<string, string>, second?: Record<string, string>}} policy
 */
export function optimizeMoves(pokemon, policy) {
  applyPlan(pokemon, policy, suggestPolicy(pokemon));
}

/**
 * @typedef {{rank: number, first: string, second: string}} Plan
 */

/** @param {number} rank @param {string} first @param {string} [second] @returns {Plan} */
const use = (rank, first, second = 'never') => ({ rank, first, second });
const OFF = use(RANK.off, 'never');

/**
 * The place and the two conditions for one move.
 *
 * @param {string} slug
 * @param {any} move
 * @param {Profile} profile
 * @returns {Plan}
 */
export function planMove(slug, move, profile) {
  if (neverAutomatic(slug)) return OFF;
  if (move.damageClass !== 'status') return planAttack(slug, move, profile);
  // A Memento knocks its user out, which one against one is the battle lost,
  // whatever it does to the foe.
  if (move.rules?.selfdestruct) return OFF;
  if (PROTECT_MOVES[slug]) return planProtect(profile);
  if (CURES.has(slug)) return use(RANK.cure, 'selfStatus');

  switch (categoryOf(move)) {
    case 'heal':
      return planHeal(slug, profile);
    case 'status':
      return planAilment(slug, move, profile);
    case 'stat':
      return planStats(slug, move, profile);
    default:
      return planOther(slug, profile);
  }
}

/**
 * The other attacks it has that could do the ordinary work in this one's
 * place: a real power, of a kind its build is any good at.
 *
 * @param {string} slug
 * @param {Profile} profile
 * @param {number} [atLeast]
 */
function otherAttacks(slug, profile, atLeast = 60) {
  return profile.attacks.filter(({ slug: other, move }) =>
    other !== slug && (move.power ?? 0) >= atLeast && !CHARGING.has(other) && !move.flags?.includes('recharge'));
}

/**
 * @param {string} slug
 * @param {any} move
 * @param {Profile} profile
 * @returns {Plan}
 */
function planAttack(slug, move, profile) {
  // A Counter answers a hit it cannot see coming; a Bide waits for two.
  if (RETALIATES.has(slug) || slug === 'bide') return OFF;
  // A Fake Out works on a foe's first turn out and fails after it: once
  // against each, which is its first turn unless something else came first.
  if (FIRST_TURN_ONLY.has(slug)) return use(RANK.finisher, 'oncePerFoe');
  // An Explosion is the last thing it does.
  if (move.rules?.selfdestruct) return use(RANK.finisher, 'hpQuarter');
  // A Flail or a Reversal is only strong at the bottom of its health.
  if (slug === 'flail' || slug === 'reversal') {
    return use(RANK.moment, 'hpQuarter', otherAttacks(slug, profile).length ? 'never' : 'always');
  }
  const moment = MOMENT_ATTACKS[/** @type {keyof typeof MOMENT_ATTACKS} */ (slug)];
  if (moment) return use(RANK.moment, moment[0], moment[1]);
  // A Last Resort fails until everything else has been used.
  if (slug === 'last-resort') return otherAttacks(slug, profile, 1).length ? OFF : use(RANK.attack, 'always');

  const others = otherAttacks(slug, profile).length > 0;
  // Two turns standing still, or one recharging, or a sharp fall in the stat
  // it attacks with: worth it to finish a foe, when something else can do
  // the rest of the work.
  if (CHARGING.has(slug)) return others ? OFF : use(RANK.attack, 'always');
  if (move.flags?.includes('recharge')) return others ? use(RANK.finisher, 'canFinish') : use(RANK.attack, 'always');
  const fall = (move.statChanges ?? []).some((change) => change.self && change.change <= -2 && !change.secondary);
  if (fall && others) return use(RANK.finisher, 'canFinish');
  // A Steel Beam costs half its user's health, hit or miss: two of them
  // knocked a level 100 Metagross out. Not even kept to finish with — a
  // level 100 can finish a level 70 with it every turn, and did, twice.
  if ((move.rules?.mindBlownRecoil || slug === 'chloroblast') && others) return OFF;

  // A weak priority attack is a finisher, or a last swing before going down;
  // a strong one is just a strong attack that goes first.
  if ((move.priority ?? 0) > 0 && (move.power ?? 0) < 70) return use(RANK.finisher, 'canFinish', 'hpQuarter');
  return use(RANK.attack, 'always');
}

/**
 * @param {string} slug
 * @param {Profile} profile
 * @returns {Plan}
 */
function planHeal(slug, profile) {
  // A Rest puts it to sleep for two turns: late, unless it can act asleep.
  if (slug === 'rest') {
    const wakes = profile.slugs.has('sleep-talk') || ['early-bird', 'shed-skin', 'hydration'].includes(profile.ability);
    return use(RANK.heal, wakes ? 'hpHalf' : 'hpThird');
  }
  // A Wish lands a turn later, so it is made a little earlier.
  if (slug === 'wish') return use(RANK.heal, 'hpTwoThirds');
  // A Strength Sap is also an Attack drop: better on a physical foe.
  if (slug === 'strength-sap') return use(RANK.heal, 'hpHalf');
  // A fast, frail Pokémon heals before the next hit lands, so it can wait;
  // anything else heals at half, where the games' players do.
  return use(RANK.heal, profile.fast && !profile.bulky ? 'hpThird' : 'hpHalf');
}

/**
 * Putting a condition on the foe.
 *
 * @param {string} slug
 * @param {any} move
 * @param {Profile} profile
 * @returns {Plan}
 */
function planAilment(slug, move, profile) {
  const ailment = move.meta?.ailment ?? 'none';
  const accuracy = move.accuracy ?? 100;
  switch (ailment) {
    case 'sleep':
      // A reliable sleep goes on any foe with the health left to be worth
      // it, again when it wakes; an unreliable one is tried once per foe.
      return accuracy >= 85 ? use(RANK.disable, 'foeHpAboveHalf') : use(RANK.disable, 'oncePerFoe');
    case 'yawn':
      return use(RANK.disable, 'oncePerFoe');
    case 'paralysis':
      // Taking the first move away is the point; a fast Pokémon has it.
      if (!profile.fast) return use(RANK.disable, 'slower');
      return profile.bulky ? use(RANK.disable, 'oncePerFoe') : OFF;
    case 'burn':
      // Halves a physical attacker's hits.
      return use(RANK.disable, 'foePhysical');
    case 'poison':
      // Slow damage: for something that will be there to see it work.
      if (!profile.bulky) return OFF;
      return slug === 'toxic' ? use(RANK.wear, 'foeHpAboveHalf') : use(RANK.wear, 'oncePerFoe');
    case 'leech-seed':
      return use(RANK.wear, profile.bulky ? 'foeHpAboveHalf' : 'oncePerFoe');
    case 'confusion':
      // Only a sure one, and only on something that can wait out the turns.
      return accuracy >= 90 && profile.bulky && slug !== 'swagger' && slug !== 'flatter' ? use(RANK.wear, 'oncePerFoe') : OFF;
    case 'nightmare':
      return use(RANK.wear, 'foeAsleep');
    case 'tar-shot':
      return profile.attacks.some(({ move: attack }) => attack.type === 'fire' && attack.power) ? use(RANK.wear, 'oncePerFoe') : OFF;
    default:
      // Attract, a trap, a Disable, a Torment, a Perish Song: nothing a
      // single battle reliably gains from.
      return OFF;
  }
}

/**
 * Raising its own stats, lowering the foe's.
 *
 * @param {string} slug
 * @param {any} move
 * @param {Profile} profile
 * @returns {Plan}
 */
function planStats(slug, move, profile) {
  const changes = (move.statChanges ?? []).filter((change) => !change.secondary);
  const own = changes.filter((change) => change.self ?? change.change > 0);
  const theirs = changes.filter((change) => !(change.self ?? change.change > 0));

  if (own.some((change) => change.change > 0)) {
    /** How much of the boost goes into what it attacks with. */
    const feeding = own.reduce((sum, change) =>
      sum + (change.change > 0 && ((change.stat === 'atk' && profile.fed.has('physical')) || (change.stat === 'spa' && profile.fed.has('special'))) ? change.change : 0), 0);
    const speed = own.find((change) => change.stat === 'spe' && change.change > 0)?.change ?? 0;
    const guards = own.filter((change) => (change.stat === 'def' || change.stat === 'spd') && change.change > 0);
    // A Shell Smash lowers its own guards as it goes: "again once lowered"
    // would call it every turn after the first, until its PP ran out.
    const again = own.some((change) => change.change < 0) ? 'never' : 'rankDown';

    // A boost into its attacks, and with it Speed or a guard, or two stages
    // at once: once a battle, and again once something has taken it away.
    if (feeding >= 2 || (feeding >= 1 && (speed > 0 || guards.length > 0))) return use(RANK.boost, 'oncePerBattle', again);
    // One stage of attack and nothing else is a turn a short fight rarely
    // repays, unless it is sturdy enough to make the time.
    if (feeding === 1) return profile.bulky ? use(RANK.boost, 'oncePerBattle') : OFF;
    // Speed alone, to overtake a faster foe.
    if (speed > 0 && profile.fed.size > 0) return use(RANK.boost, 'slower');
    // A guard alone pays only for a move that hits with it, or grows with it.
    const paysOff = (guards.some((change) => change.stat === 'def') && profile.slugs.has('body-press')) ||
      profile.slugs.has('stored-power') || profile.slugs.has('power-trip') ||
      (slug === 'defense-curl' && (profile.slugs.has('rollout') || profile.slugs.has('ice-ball')));
    if (guards.length && paysOff) return use(RANK.boost, 'oncePerBattle', 'rankDown');
    // Evasion, accuracy, a guard with nothing to show for it.
    return OFF;
  }

  if (theirs.length) {
    const sharp = theirs.find((change) => change.change <= -2);
    if (!sharp) return OFF;
    // Two stages off what its own attacks hit into, once per foe.
    const opens = (sharp.stat === 'def' && profile.fed.has('physical')) || (sharp.stat === 'spd' && profile.fed.has('special'));
    if (opens) return use(RANK.boost, 'oncePerFoe');
    // Two off the foe's attack, for something built to take the hits.
    if ((sharp.stat === 'atk' || sharp.stat === 'spa') && profile.bulky) return use(RANK.boost, 'oncePerFoe');
    // Two off its Speed, for something slower.
    if (sharp.stat === 'spe' && !profile.fast) return use(RANK.boost, 'slower');
  }
  return OFF;
}

/**
 * A Protect is worth it only to let something on the foe tick, and never
 * twice running.
 *
 * @param {Profile} profile
 * @returns {Plan}
 */
function planProtect(profile) {
  const ticking = [...profile.slugs].some((slug) => RESIDUAL.has(slug)) || profile.ability === 'poison-heal' || profile.ability === 'speed-boost';
  return ticking ? use(RANK.field, 'everyThreeTurns') : OFF;
}

/**
 * The field, and the moves that fit nowhere else.
 *
 * @param {string} slug
 * @param {Profile} profile
 * @returns {Plan}
 */
function planOther(slug, profile) {
  const set = FIELD_MOVES[slug];
  if (set) {
    const ground = set.weather ?? set.terrain;
    if (ground) {
      if (SETS_ITS_OWN[/** @type {keyof typeof SETS_ITS_OWN} */ (profile.ability)] === ground) return OFF;
      const types = profile.attacks.filter(({ move }) => move.power).map(({ move }) => move.type);
      const powered = types.filter((type) => POWERS[/** @type {keyof typeof POWERS} */ (ground)]?.includes(type)).length;
      const spoiled = types.filter((type) => SPOILS[/** @type {keyof typeof SPOILS} */ (ground)]?.includes(type)).length;
      const wanted = WEATHER_ABILITIES[/** @type {keyof typeof WEATHER_ABILITIES} */ (profile.ability)] === ground ||
        (ground === 'sun' && (profile.slugs.has('solar-beam') || profile.slugs.has('solar-blade') || profile.slugs.has('synthesis') || profile.slugs.has('morning-sun') || profile.slugs.has('moonlight'))) ||
        (ground === 'rain' && (profile.slugs.has('thunder') || profile.slugs.has('hurricane'))) ||
        ((ground === 'hail' || ground === 'snow') && (profile.slugs.has('blizzard') || profile.slugs.has('aurora-veil')));
      // Called on a clear field, so it is called again when it runs out.
      return (powered > spoiled || wanted) && spoiled <= powered ? use(RANK.field, 'noField') : OFF;
    }
    if (set.screen === 'physical') return use(RANK.field, 'foePhysical');
    if (set.screen === 'special') return use(RANK.field, 'foeSpecial');
    // An Aurora Veil only goes up in hail or snow.
    if (set.screen === 'both') return use(RANK.field, 'hasField');
    // A trap is laid for the foe's next Pokémon, which only a trainer has.
    if (set.hazard) return use(RANK.field, 'trainerBattle');
    if (set.tailwind) return use(RANK.field, 'slower');
    // A Trick Room turns the order round: worth it to something slow.
    if (set.room) return profile.slow ? use(RANK.field, 'slower') : OFF;
    return OFF;
  }

  switch (slug) {
    case 'belly-drum':
      return profile.fed.has('physical') ? use(RANK.boost, 'hpFull') : OFF;
    case 'curse':
      // The non-Ghost Curse: Attack and Defense for Speed. Once: the Speed it
      // gives up would have it called again every turn after.
      return profile.fed.has('physical') && profile.bulky ? use(RANK.boost, 'oncePerBattle') : OFF;
    case 'focus-energy':
      return profile.attacks.some(({ move }) => (move.meta?.critRate ?? 0) >= 1) ? use(RANK.boost, 'oncePerBattle') : OFF;
    case 'pain-split':
      return use(RANK.heal, 'hpHalf');
    case 'aqua-ring':
    case 'ingrain':
      return profile.bulky ? use(RANK.boost, 'oncePerBattle') : OFF;
    case 'haze':
    case 'psych-up':
      return use(RANK.field, 'foeRankUp');
    case 'destiny-bond':
      // Takes the foe down with it, if the foe moves after.
      return profile.slow ? OFF : use(RANK.finisher, 'hpQuarter');
    case 'sleep-talk':
      return use(RANK.cure, 'selfStatus');
    case 'metronome':
      return profile.attacks.some(({ move }) => move.power) ? OFF : use(RANK.attack, 'always');
    default:
      // A Substitute, a Taunt, an Encore, an Endure, a Spite: nothing a
      // battle of one against one reliably gains a turn from.
      return OFF;
  }
}
