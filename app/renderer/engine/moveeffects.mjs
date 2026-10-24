/**
 * What a move does beyond its numbers.
 *
 * Most moves are their data: a power, a type, a chance of a condition or a
 * stat change, a share of the damage drained or paid back — the battle reads
 * those generically. What is left are the moves whose effect is a rule of its
 * own: a Seismic Toss that hits for the user's level, a Rest that heals and
 * puts its user to sleep, a Knock Off that takes the item away, a Substitute
 * that stands in for its user. Those are written here, one entry per move, in
 * the shape of the moment each one acts in, so the battle asks one question
 * at each moment rather than carrying a hundred special cases inline.
 *
 * Every hook is handed the same context:
 *
 * - `battle`, `user` and `target` (the two combatants, `user` being the one
 *   using the move), `move` (the move as it leaves, type and power already
 *   settled) and `log`;
 *
 * and the battle's own helpers do the saying: `battle.say(combatant, key,
 * data)` writes one of the `move.*` lines, `battle.loseHp` and
 * `battle.gainHp` move a bar and say so.
 *
 * The lines are the Korean games' own (Scarlet and Violet's `btl_set` and
 * `btl_std` messages); see the `move.*` keys in the language sheets.
 */
import { itemOf, moveOf, speciesOf, typeEffectiveness } from '../core/data.mjs';
import { TERRAIN, WEATHER } from './field.mjs';
import { friendshipOf, levelOf, setMove } from './pokemon.mjs';

/** @param {any} combatant */
const hpShare = (combatant) => combatant.pokemon.hp / Math.max(1, combatant.maxHp);

/**
 * Where a two-turn move keeps its user on the turn in between, and what can
 * still reach it there — with the power it hits with, doubled for the moves
 * that go looking.
 *
 * @type {Record<string, string>}
 */
export const SEMI_INVULNERABLE = {
  fly: 'sky',
  bounce: 'sky',
  dig: 'ground',
  dive: 'water',
  'phantom-force': 'vanished',
  'shadow-force': 'vanished',
};

/** @type {Record<string, Record<string, number>>} */
const REACHES = {
  sky: { gust: 2, twister: 2, thunder: 1, hurricane: 1, 'sky-uppercut': 1, 'smack-down': 1, 'thousand-arrows': 1 },
  ground: { earthquake: 2, magnitude: 2, fissure: 1 },
  water: { surf: 2, whirlpool: 2 },
  vanished: {},
};

/**
 * Whether a move can reach a target that is off the field for the turn, and
 * how hard it hits one there: null when it cannot, the multiplier when it can.
 *
 * @param {string} hidden where the target is
 * @param {string} slug the move
 */
export function reachesHidden(hidden, slug) {
  return REACHES[hidden]?.[slug] ?? null;
}

/**
 * What a two-turn move says on the turn it charges, and what it does to its
 * user while it waits: a Skull Bash tucks in its head behind a raised
 * Defense, a Meteor Beam fills with power before it fires.
 *
 * @type {Record<string, {key: string, stat?: string}>}
 */
export const CHARGE_TURNS = {
  fly: { key: 'move.charge.fly' },
  bounce: { key: 'move.charge.bounce' },
  dig: { key: 'move.charge.dig' },
  dive: { key: 'move.charge.dive' },
  'phantom-force': { key: 'move.charge.vanish' },
  'shadow-force': { key: 'move.charge.vanish' },
  'skull-bash': { key: 'move.charge.skullBash', stat: 'def' },
  'sky-attack': { key: 'move.charge.skyAttack' },
  'razor-wind': { key: 'move.charge.razorWind' },
  'solar-beam': { key: 'move.charge.solar' },
  'solar-blade': { key: 'move.charge.solar' },
  'freeze-shock': { key: 'move.charge.freezeShock' },
  'ice-burn': { key: 'move.charge.iceBurn' },
  'meteor-beam': { key: 'move.charge.meteorBeam', stat: 'spa' },
  'electro-shot': { key: 'move.charge.electroShot', stat: 'spa' },
};

/**
 * The charge-turn boosts are the move's whole stat effect; the data's own
 * listing of them would otherwise be applied a second time, and to the
 * wrong side.
 *
 * @param {string} slug
 */
export const chargeOwnsStats = (slug) => Boolean(CHARGE_TURNS[slug]?.stat);

/**
 * The moves that only a battle with a partner in it has any use for. In a
 * battle of one against one they fail, as they do in the games.
 */
export const PARTNER_ONLY = new Set([
  'helping-hand', 'follow-me', 'rage-powder', 'ally-switch', 'after-you', 'quash', 'instruct', 'aromatic-mist',
  'coaching', 'dragon-cheer', 'spotlight', 'hold-hands', 'baton-pass', 'shed-tail', 'healing-wish',
  'lunar-dance', 'revival-blessing', 'assist', 'magnetic-flux', 'gear-up',
]);

/** What a Mimic or a Sketch cannot copy. */
const UNCOPYABLE_MOVES = new Set(['mimic', 'sketch', 'transform', 'struggle', 'metronome', 'chatter', 'sleep-talk']);

/**
 * The moves that end a wild battle or pull a trainer's Pokémon out, which the
 * automatic battler never reaches for on its own — a Roar that sends away the
 * Pokémon the companion was about to beat is not something to do unasked.
 */
export const LEAVES_BATTLE = new Set(['roar', 'whirlwind', 'teleport']);

/**
 * The moves whose base power is worked out when they are used.
 *
 * @param {any} battle
 * @param {any} user
 * @param {any} target
 * @param {any} move
 * @param {boolean} [peek] weighed up before the turn, when nothing has
 *   happened in it yet: what the turn will bring is guessed from Speed
 * @returns {number|null} the power to use, or null to keep the listed one
 */
export function variablePower(battle, user, target, move, peek = false) {
  const slug = battle.slugOf(move);
  const rule = POWER[slug];
  return rule ? Math.max(1, Math.floor(rule(battle, user, target, move, peek))) : null;
}

/**
 * Whether the target has moved this turn — or, weighed up before the turn,
 * whether it will have by the time this move goes: when it is the faster.
 *
 * @param {any} battle @param {any} user @param {any} target @param {boolean} peek
 */
const movedBefore = (battle, user, target, peek) => (peek ? battle.outpaces(target, user) : target.turn.moved);

/**
 * Whether the target hit the user this turn — or, weighed up before it, is
 * the faster and so will have, as a foe that attacks at all usually does.
 *
 * @param {any} battle @param {any} user @param {any} target @param {boolean} peek
 */
const hitFirst = (battle, user, target, peek) => (peek ? battle.outpaces(target, user) : user.turn.hitBy.includes(target));

/** @type {Record<string, (battle: any, user: any, target: any, move: any, peek: boolean) => number>} */
const POWER = {
  flail: (battle, user) => reversalPower(user),
  reversal: (battle, user) => reversalPower(user),
  return: (battle, user) => Math.max(1, Math.floor(friendshipOf(user.pokemon) / 2.5)),
  frustration: (battle, user) => Math.max(1, Math.floor((255 - friendshipOf(user.pokemon)) / 2.5)),
  'gyro-ball': (battle, user, target) =>
    Math.min(150, Math.floor((25 * battle.speedOf(target)) / Math.max(1, battle.speedOf(user))) + 1),
  'electro-ball': (battle, user, target) => {
    const ratio = battle.speedOf(user) / Math.max(1, battle.speedOf(target));
    return ratio >= 4 ? 150 : ratio >= 3 ? 120 : ratio >= 2 ? 80 : ratio >= 1 ? 60 : 40;
  },
  'crush-grip': (battle, user, target) => Math.max(1, Math.floor(120 * hpShare(target))),
  'wring-out': (battle, user, target) => Math.max(1, Math.floor(120 * hpShare(target))),
  'hard-press': (battle, user, target) => Math.max(1, Math.floor(100 * hpShare(target))),
  eruption: (battle, user) => Math.max(1, Math.floor(150 * hpShare(user))),
  'water-spout': (battle, user) => Math.max(1, Math.floor(150 * hpShare(user))),
  'dragon-energy': (battle, user) => Math.max(1, Math.floor(150 * hpShare(user))),
  facade: (battle, user, target, move) => move.power * (user.pokemon.status ? 2 : 1),
  hex: (battle, user, target, move) => move.power * (target.pokemon.status || battle.abilityOf(target)?.comatose ? 2 : 1),
  'infernal-parade': (battle, user, target, move) => move.power * (target.pokemon.status ? 2 : 1),
  'bitter-malice': (battle, user, target, move) => move.power * (target.pokemon.status ? 2 : 1),
  venoshock: (battle, user, target, move) => move.power * (target.pokemon.status === 'psn' ? 2 : 1),
  'barb-barrage': (battle, user, target, move) => move.power * (target.pokemon.status === 'psn' ? 2 : 1),
  brine: (battle, user, target, move) => move.power * (target.pokemon.hp * 2 <= target.maxHp ? 2 : 1),
  acrobatics: (battle, user, target, move) => move.power * (user.pokemon.heldItem ? 1 : 2),
  'stored-power': (battle, user) => 20 + 20 * positiveStages(user),
  'power-trip': (battle, user) => 20 + 20 * positiveStages(user),
  avalanche: (battle, user, target, move, peek) => move.power * (hitFirst(battle, user, target, peek) ? 2 : 1),
  revenge: (battle, user, target, move, peek) => move.power * (hitFirst(battle, user, target, peek) ? 2 : 1),
  payback: (battle, user, target, move, peek) => move.power * (movedBefore(battle, user, target, peek) ? 2 : 1),
  // Hurt by anything this turn — hit, or its own recoil, Life Orb or
  // confusion; weighed up beforehand, as likely as that looks.
  assurance: (battle, user, target, move, peek) =>
    move.power *
    (peek
      ? 1 + battle.hurtFirstChance(target, user)
      : target.turn.damage > 0 || target.pokemon.hp < target.turn.startHp ? 2 : 1),
  'bolt-beak': (battle, user, target, move, peek) => move.power * (movedBefore(battle, user, target, peek) ? 1 : 2),
  'fishious-rend': (battle, user, target, move, peek) => move.power * (movedBefore(battle, user, target, peek) ? 1 : 2),
  'lash-out': (battle, user, target, move, peek) =>
    move.power * (peek ? 1 + battle.loweredFirstChance(user, target) : user.turn.lowered ? 2 : 1),
  'stomping-tantrum': (battle, user, target, move) => move.power * (user.marks.lastFailed ? 2 : 1),
  'temper-flare': (battle, user, target, move) => move.power * (user.marks.lastFailed ? 2 : 1),
  'rage-fist': (battle, user) => Math.min(350, 50 + 50 * (user.marks.timesHit ?? 0)),
  'wake-up-slap': (battle, user, target, move) => move.power * (target.pokemon.status === 'slp' ? 2 : 1),
  'smelling-salts': (battle, user, target, move) => move.power * (target.pokemon.status === 'par' ? 2 : 1),
  'knock-off': (battle, user, target, move) => move.power * (removableItem(battle, target) ? 1.5 : 1),
  'weather-ball': (battle, user, target, move) => move.power * (battle.weatherFor(user) ? 2 : 1),
  'terrain-pulse': (battle, user, target, move) => move.power * (battle.field.terrain && battle.grounded(user) ? 2 : 1),
  'rising-voltage': (battle, user, target, move) =>
    move.power * (battle.field.terrain === TERRAIN.ELECTRIC && battle.grounded(target) ? 2 : 1),
  'expanding-force': (battle, user, target, move) =>
    move.power * (battle.field.terrain === TERRAIN.PSYCHIC && battle.grounded(user) ? 1.5 : 1),
  'misty-explosion': (battle, user, target, move) =>
    move.power * (battle.field.terrain === TERRAIN.MISTY && battle.grounded(user) ? 1.5 : 1),
  psyblade: (battle, user, target, move) => move.power * (battle.field.terrain === TERRAIN.ELECTRIC ? 1.5 : 1),
  'grav-apple': (battle, user, target, move) => move.power * (battle.field.gravity > 0 ? 1.5 : 1),
  'solar-beam': (battle, user, target, move) => move.power * (weakensSolar(battle.weatherFor(user)) ? 0.5 : 1),
  'solar-blade': (battle, user, target, move) => move.power * (weakensSolar(battle.weatherFor(user)) ? 0.5 : 1),
  'echoed-voice': (battle, user) => Math.min(200, 40 * (1 + (battle.field.echoes ?? 0))),
  'fury-cutter': (battle, user) => Math.min(160, 40 * 2 ** Math.max(0, user.repeats)),
  rollout: (battle, user) => rolloutPower(user),
  'ice-ball': (battle, user) => rolloutPower(user),
  'spit-up': (battle, user) => 100 * (user.volatile.stockpile ?? 0),
  'beat-up': (battle, user) => Math.floor((speciesOf(user.pokemon.speciesId)?.stats.atk ?? 50) / 10) + 5,
  'last-respects': (battle, user, target, move) => move.power,
  fling: (battle, user) => itemOf(user.pokemon.heldItem ?? '')?.flingPower ?? 0,
  'natural-gift': (battle, user) => itemOf(user.pokemon.heldItem ?? '')?.naturalGift?.power ?? 0,
  present: (battle, user) => user.marks.present ?? 40,
};

/** @param {any} user */
function reversalPower(user) {
  const share = Math.floor((48 * user.pokemon.hp) / Math.max(1, user.maxHp));
  return share <= 1 ? 200 : share <= 4 ? 150 : share <= 9 ? 100 : share <= 16 ? 80 : share <= 32 ? 40 : 20;
}

/** @param {any} user */
function rolloutPower(user) {
  const turn = user.volatile.rollout?.count ?? 0;
  return 30 * 2 ** turn * (user.volatile.defenseCurl ? 2 : 1);
}

/** @param {any} combatant */
const positiveStages = (combatant) =>
  Object.values(combatant.stages).reduce((sum, stage) => sum + Math.max(0, stage), 0);

/** @param {string|null} weather */
const weakensSolar = (weather) =>
  weather === WEATHER.RAIN || weather === WEATHER.SANDSTORM || weather === WEATHER.HAIL || weather === WEATHER.SNOW;

/**
 * The item a Knock Off can take: anything but what a Pokémon's shape depends
 * on — a mask, a plate, an orb — and nothing from a Sticky Hold.
 *
 * @param {any} battle
 * @param {any} target
 */
export function removableItem(battle, target) {
  const slug = target.pokemon.heldItem;
  if (!slug) return null;
  if (battle.bindsItem(target, slug)) return null;
  return slug;
}

/**
 * What a move's type is once the field has had its say: a Weather Ball in the
 * rain is Water, a Terrain Pulse on Grassy Terrain is Grass, a Natural Gift
 * is whatever its berry is, a Revelation Dance its user's own type.
 *
 * @param {any} battle
 * @param {any} user
 * @param {any} move
 * @returns {string|null}
 */
export function variableType(battle, user, move) {
  const slug = battle.slugOf(move);
  if (slug === 'weather-ball') {
    const weather = battle.weatherFor(user);
    return { sun: 'fire', rain: 'water', sandstorm: 'rock', hail: 'ice', snow: 'ice' }[weather ?? ''] ?? null;
  }
  if (slug === 'terrain-pulse' && battle.grounded(user)) {
    return { electric: 'electric', grassy: 'grass', misty: 'fairy', psychic: 'psychic' }[battle.field.terrain ?? ''] ?? null;
  }
  if (slug === 'natural-gift') return itemOf(user.pokemon.heldItem ?? '')?.naturalGift?.type ?? null;
  if (slug === 'revelation-dance') return battle.typesOf(user)[0] ?? null;
  if (slug === 'raging-bull') {
    const species = speciesOf(user.pokemon.speciesId)?.slug ?? '';
    if (species.includes('combat')) return 'fighting';
    if (species.includes('blaze')) return 'fire';
    if (species.includes('aqua')) return 'water';
  }
  return null;
}

/**
 * The hit points a fixed-damage move takes, or null for any move whose damage
 * is the ordinary formula's.
 *
 * @param {any} battle
 * @param {any} user
 * @param {any} target
 * @param {any} move
 * @returns {number|null}
 */
export function fixedDamage(battle, user, target, move) {
  const slug = battle.slugOf(move);
  const rule = move.rules?.damage;
  if (rule === 'level') return levelOf(user.pokemon);
  if (typeof rule === 'number') return rule;
  switch (slug) {
    case 'super-fang':
    case 'natures-madness':
    case 'ruination':
      return Math.max(1, Math.floor(target.pokemon.hp / 2));
    case 'endeavor':
      return Math.max(0, target.pokemon.hp - user.pokemon.hp);
    case 'final-gambit':
      return user.pokemon.hp;
    case 'counter':
      return user.turn.lastHit?.damageClass === 'physical' ? user.turn.lastHit.amount * 2 : 0;
    case 'mirror-coat':
      return user.turn.lastHit?.damageClass === 'special' ? user.turn.lastHit.amount * 2 : 0;
    case 'metal-burst':
    case 'comeuppance':
      return user.turn.lastHit ? Math.floor(user.turn.lastHit.amount * 1.5) : 0;
    case 'bide':
      return (user.volatile.bide?.damage ?? 0) * 2;
    default:
      return null;
  }
}

/** The moves whose damage answers a hit taken this turn, and fail without one. */
export const RETALIATES = new Set(['counter', 'mirror-coat', 'metal-burst', 'comeuppance']);

/**
 * Whether a move fails before it is even aimed, and the line it fails with.
 * A Sucker Punch needs the target to be about to attack, a Dream Eater needs
 * it asleep, a Steel Roller needs a terrain to roll over.
 *
 * @param {any} battle
 * @param {any} user
 * @param {any} target
 * @param {any} move
 * @param {string} slug
 * @returns {boolean}
 */
export function failsBeforeUse(battle, user, target, move, slug) {
  const pending = moveOf(battle.pendingMoves?.get(target) ?? '');
  switch (slug) {
    case 'sucker-punch':
    case 'thunderclap':
      return target.turn.moved || !pending || pending.damageClass === 'status';
    case 'upper-hand':
      return target.turn.moved || !pending || (pending.priority ?? 0) <= 0 || pending.damageClass === 'status';
    case 'dream-eater':
      return target.pokemon.status !== 'slp' && !battle.abilityOf(target)?.comatose;
    case 'snore':
    case 'sleep-talk':
      return user.pokemon.status !== 'slp' && !battle.abilityOf(user)?.comatose;
    case 'steel-roller':
      return !battle.field.terrain;
    case 'aurora-veil':
      return battle.weatherFor(user) !== WEATHER.SNOW && battle.weatherFor(user) !== WEATHER.HAIL;
    case 'poltergeist':
    case 'natural-gift':
    case 'fling':
      return slug === 'poltergeist' ? !target.pokemon.heldItem : !canFling(battle, user, slug);
    case 'burn-up':
      return !battle.typesOf(user).includes('fire');
    case 'double-shock':
      return !battle.typesOf(user).includes('electric');
    case 'spit-up':
    case 'swallow':
      return !(user.volatile.stockpile > 0);
    case 'belch':
      return !user.marks.ateBerry;
    case 'stuff-cheeks':
      return !itemOf(user.pokemon.heldItem ?? '')?.pocket?.includes('berries');
    case 'focus-punch':
      return user.turn.damage > 0;
    case 'counter':
    case 'mirror-coat':
    case 'metal-burst':
    case 'comeuppance':
      return !fixedDamage(battle, user, target, move);
    case 'last-resort':
      return true;
    default:
      return false;
  }
}

/**
 * The moves `failsBeforeUse` can only judge once the turn is under way: what
 * the target chose, and whether the user was hit first. Whether they work is
 * a read of the other side, not a fact to check beforehand.
 */
const DECIDED_IN_THE_TURN = new Set(['sucker-punch', 'thunderclap', 'upper-hand', 'focus-punch', 'counter', 'mirror-coat', 'metal-burst', 'comeuppance']);

/**
 * Whether a move is already certain to fail if it is chosen now: a
 * Poltergeist at a target holding nothing, a Dream Eater at one awake, a
 * Steel Roller with no terrain, a Belch before any Berry. Choosing one of
 * those only spends the turn and the PP, and nothing changes by the next
 * turn, so a Pokémon left to it used it over and over.
 *
 * @param {any} battle
 * @param {any} user
 * @param {any} target
 * @param {string} slug
 */
export function boundToFail(battle, user, target, slug) {
  if (!target || DECIDED_IN_THE_TURN.has(slug)) return false;
  const move = moveOf(slug);
  return Boolean(move) && failsBeforeUse(battle, user, target, move, slug);
}

/** @param {any} battle @param {any} user @param {string} slug */
function canFling(battle, user, slug) {
  const item = itemOf(user.pokemon.heldItem ?? '');
  if (!item || battle.bindsItem(user, user.pokemon.heldItem)) return false;
  if (battle.abilityOf(user)?.klutz || battle.field.magicRoom > 0) return false;
  return slug === 'fling' ? (item.flingPower ?? 0) > 0 : Boolean(item.naturalGift);
}

/** The items that hand over a condition of their own when a Fling throws them. */
const FLUNG_AILMENTS = {
  'flame-orb': 'burn',
  'toxic-orb': 'poison',
  'light-ball': 'paralysis',
  'poison-barb': 'poison',
};

/**
 * Status moves whose effect is a rule of its own. Each returns whether it did
 * anything; a false return is a "하지만 실패했다!".
 *
 * @type {Record<string, (ctx: {battle: any, user: any, target: any, move: any, log: any[]}) => boolean>}
 */
export const STATUS_MOVES = {
  // ---- Health.
  rest: ({ battle, user, log }) => {
    if (user.pokemon.hp >= user.maxHp || user.pokemon.status === 'slp') return false;
    if (!battle.canFallAsleep(user, log)) return false;
    user.pokemon.status = 'slp';
    // Exactly two turns asleep, waking to move on the third, as the games
    // have it; at two it woke on the second.
    user.pokemon.statusTurns = 3;
    user.pokemon.toxic = false;
    battle.say(user, 'move.rest');
    battle.gainHp(user, user.maxHp, log, { quiet: true });
    return true;
  },
  'pain-split': ({ battle, user, target, log }) => {
    const shared = Math.floor((user.pokemon.hp + target.pokemon.hp) / 2);
    battle.say(user, 'move.painSplit');
    for (const combatant of [user, target]) {
      const change = Math.min(combatant.maxHp, shared) - combatant.pokemon.hp;
      if (change > 0) battle.gainHp(combatant, change, log, { quiet: true });
      else if (change < 0) battle.loseHp(combatant, -change, log);
    }
    return true;
  },
  'belly-drum': ({ battle, user, log }) => {
    const cost = Math.floor(user.maxHp / 2);
    if (user.pokemon.hp <= cost || user.stages.atk >= 6) return false;
    battle.loseHp(user, cost, log);
    user.stages.atk = 6;
    battle.say(user, 'move.bellyDrum');
    return true;
  },
  'clangorous-soul': ({ battle, user, move, log }) => paidBoost(battle, user, move, log, 1 / 3),
  'fillet-away': ({ battle, user, move, log }) => paidBoost(battle, user, move, log, 1 / 2),
  wish: ({ battle, user }) => {
    const side = battle.field.wish[user.side];
    if (side) return false;
    battle.field.wish[user.side] = { turns: 2, amount: Math.floor(user.maxHp / 2), from: user.pokemon };
    return true;
  },
  'aqua-ring': ({ battle, user }) => battle.setVolatile(user, 'aquaRing', true, 'move.aquaRing'),
  ingrain: ({ battle, user }) => battle.setVolatile(user, 'ingrain', true, 'move.ingrain'),
  'strength-sap': ({ battle, user, target, log }) => {
    if (target.stages.atk <= -6) return false;
    const attack = battle.stat(target, 'atk');
    battle.applyStage(target, 'atk', -1, log);
    battle.gainHp(user, attack, log);
    return true;
  },
  purify: ({ battle, user, target, log }) => {
    if (!target.pokemon.status) return false;
    battle.cureStatus(target, log);
    battle.gainHp(user, Math.floor(user.maxHp / 2), log);
    return true;
  },
  'lunar-blessing': ({ battle, user, log }) => healAndCure(battle, user, log, 1 / 4),
  'jungle-healing': ({ battle, user, log }) => healAndCure(battle, user, log, 1 / 4),
  'take-heart': ({ battle, user, log }) => {
    const cured = battle.cureStatus(user, log);
    const raised = [battle.applyStage(user, 'spa', 1, log, { source: 'self' }), battle.applyStage(user, 'spd', 1, log, { source: 'self' })];
    return cured || raised.some(Boolean);
  },
  'heal-bell': ({ battle, user, log }) => {
    battle.say(user, 'move.healBell');
    battle.cureStatus(user, log);
    return true;
  },
  aromatherapy: ({ battle, user, log }) => {
    battle.say(user, 'move.aromatherapy');
    battle.cureStatus(user, log);
    return true;
  },
  refresh: ({ battle, user, log }) => battle.cureStatus(user, log),
  'psycho-shift': ({ battle, user, target, log }) => {
    const status = user.pokemon.status;
    if (!status || target.pokemon.status) return false;
    const ailment = { brn: 'burn', psn: 'poison', par: 'paralysis', slp: 'sleep', frz: 'freeze' }[status];
    if (!battle.inflictAilment(user, target, ailment, log, { toxic: user.pokemon.toxic })) return false;
    battle.cureStatus(user, log);
    return true;
  },
  swallow: ({ battle, user, log }) => {
    const stock = user.volatile.stockpile ?? 0;
    battle.gainHp(user, Math.floor(user.maxHp * [0, 1 / 4, 1 / 2, 1][stock]), log);
    battle.dropStockpile(user, log);
    return true;
  },
  stockpile: ({ battle, user, log }) => {
    const stock = user.volatile.stockpile ?? 0;
    if (stock >= 3) return false;
    user.volatile.stockpile = stock + 1;
    user.volatile.stockpiled ??= { def: 0, spd: 0 };
    battle.say(user, 'move.stockpile', { count: stock + 1 });
    for (const stat of ['def', 'spd']) {
      if (battle.applyStage(user, stat, 1, log, { source: 'self' })) user.volatile.stockpiled[stat] += 1;
    }
    return true;
  },
  'teatime': ({ battle, user, target, log }) => {
    battle.say(user, 'move.teatime');
    let ate = false;
    for (const combatant of [user, target]) if (battle.eatBerryNow(combatant, log)) ate = true;
    return ate;
  },

  // ---- Stages.
  haze: ({ battle, user, target }) => {
    for (const combatant of [user, target]) resetStages(combatant);
    battle.say(user, 'move.haze');
    return true;
  },
  'topsy-turvy': ({ battle, target }) => {
    if (Object.values(target.stages).every((stage) => stage === 0)) return false;
    for (const stat of Object.keys(target.stages)) target.stages[stat] = -target.stages[stat];
    battle.say(target, 'move.topsyTurvy');
    return true;
  },
  'psych-up': ({ battle, user, target }) => {
    user.stages = { ...target.stages };
    battle.say(user, 'move.psychUp');
    return true;
  },
  'heart-swap': ({ battle, user, target }) => swapStages(battle, user, target, Object.keys(user.stages), 'move.heartSwap'),
  'power-swap': ({ battle, user, target }) => swapStages(battle, user, target, ['atk', 'spa'], 'move.powerSwap'),
  'guard-swap': ({ battle, user, target }) => swapStages(battle, user, target, ['def', 'spd'], 'move.guardSwap'),
  'speed-swap': ({ battle, user, target }) => {
    user.marks.speedSwap = { mine: battle.rawStat(target, 'spe'), theirs: battle.rawStat(user, 'spe') };
    target.marks.speedSwap = { mine: user.marks.speedSwap.theirs, theirs: user.marks.speedSwap.mine };
    battle.say(user, 'move.speedSwap');
    return true;
  },
  'power-split': ({ battle, user, target }) => splitStats(battle, user, target, ['atk', 'spa'], 'move.powerSplit'),
  'guard-split': ({ battle, user, target }) => splitStats(battle, user, target, ['def', 'spd'], 'move.guardSplit'),
  'power-trick': ({ battle, user }) => {
    user.marks.powerTrick = !user.marks.powerTrick;
    battle.say(user, 'move.powerTrick');
    return true;
  },
  acupressure: ({ battle, user, log }) => {
    const open = ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'].filter((stat) => (user.stages[stat] ?? 0) < 6);
    if (!open.length) return false;
    return battle.applyStage(user, battle.rng.pick(open), 2, log, { source: 'self' });
  },
  charge: ({ battle, user, log }) => {
    user.volatile.charge = true;
    battle.say(user, 'move.charge');
    battle.applyStage(user, 'spd', 1, log, { source: 'self' });
    return true;
  },
  'defense-curl': ({ battle, user, log }) => {
    user.volatile.defenseCurl = true;
    return battle.applyStage(user, 'def', 1, log, { source: 'self' }) || true;
  },
  'focus-energy': ({ battle, user }) => {
    if (user.volatile.focusEnergy) return false;
    user.volatile.focusEnergy = true;
    battle.say(user, 'move.focusEnergy');
    return true;
  },
  'laser-focus': ({ battle, user }) => {
    user.volatile.laserFocus = 2;
    battle.say(user, 'move.laserFocus');
    return true;
  },

  // ---- Sticking to the target.
  // The other side's last move, in place of the Mimic, for the battle.
  mimic: ({ battle, user, target }) => {
    const copied = target.lastMove;
    if (!copied || UNCOPYABLE_MOVES.has(copied) || !moveOf(copied)) return false;
    const moves = battle.movesOf(user);
    if (moves.some((slot) => slot.move === copied)) return false;
    const index = moves.findIndex((slot) => slot.move === 'mimic');
    if (index < 0) return false;
    user.marks.mimicked = { index, slot: { move: copied, pp: 5, ppUp: 0 } };
    battle.say(user, 'move.mimic', { move: copied });
    return true;
  },
  // The same, for good: a Smeargle keeps what it sketched.
  sketch: ({ battle, user, target }) => {
    const copied = target.lastMove;
    if (!copied || UNCOPYABLE_MOVES.has(copied) || !moveOf(copied) || user.transform) return false;
    const moves = user.pokemon.moves;
    if (moves.some((slot) => slot.move === copied)) return false;
    const index = moves.findIndex((slot) => slot.move === 'sketch');
    if (index < 0) return false;
    setMove(user.pokemon, index, copied);
    battle.say(user, 'move.sketch', { move: copied });
    return true;
  },
  // A dew that heals the user and its partners; here, the user.
  'life-dew': ({ battle, user, log }) => battle.gainHp(user, Math.floor(user.maxHp / 4), log) > 0,
  substitute: ({ battle, user, log }) => {
    if (user.volatile.substitute > 0) {
      battle.say(user, 'move.substitute.already');
      return true;
    }
    const cost = Math.floor(user.maxHp / 4);
    if (user.pokemon.hp <= cost || cost < 1) {
      battle.say(user, 'move.substitute.weak');
      return true;
    }
    battle.loseHp(user, cost, log);
    user.volatile.substitute = cost;
    battle.say(user, 'move.substitute.start');
    return true;
  },
  'leech-seed': ({ battle, target }) => {
    if (target.volatile.leechSeed || battle.typesOf(target).includes('grass')) return false;
    target.volatile.leechSeed = true;
    battle.say(target, 'move.leechSeed.start');
    return true;
  },
  yawn: ({ battle, target, log }) => {
    if (target.volatile.yawn || target.pokemon.status) return false;
    if (!battle.canFallAsleep(target, log, { quiet: true })) return false;
    target.volatile.yawn = 2;
    battle.say(target, 'move.yawn');
    return true;
  },
  'perish-song': ({ battle, user, target, log }) => {
    let any = false;
    for (const combatant of [user, target]) {
      if (combatant !== user && battle.abilityOf(combatant, user)?.blockMove?.({}, { flags: ['sound'] })) continue;
      if (battle.startPerish(combatant, log)) any = true;
    }
    return any;
  },
  curse: ({ battle, user, target, log }) => {
    if (!battle.typesOf(user).includes('ghost')) {
      const raised = [battle.applyStage(user, 'atk', 1, log, { source: 'self' }), battle.applyStage(user, 'def', 1, log, { source: 'self' })];
      const slowed = battle.applyStage(user, 'spe', -1, log, { source: 'self' });
      return raised.some(Boolean) || slowed;
    }
    if (target.volatile.cursed) return false;
    battle.loseHp(user, Math.floor(user.maxHp / 2), log);
    target.volatile.cursed = true;
    battle.say(user, 'move.curse');
    return true;
  },
  'destiny-bond': ({ battle, user }) => {
    if (user.marks.lastDestinyBond === battle.turn - 1) return false;
    user.volatile.destinyBond = battle.turn;
    user.marks.lastDestinyBond = battle.turn;
    battle.say(user, 'move.destinyBond');
    return true;
  },
  grudge: ({ battle, user }) => {
    user.volatile.grudge = battle.turn;
    battle.say(user, 'move.grudge');
    return true;
  },
  spite: ({ battle, target }) => {
    const slot = battle.movesOf(target).find((entry) => entry.move === target.lastMove && entry.pp > 0);
    if (!slot) return false;
    const taken = Math.min(4, slot.pp);
    slot.pp -= taken;
    battle.say(target, 'move.spite', { move: slot.move, count: taken });
    return true;
  },
  imprison: ({ battle, user }) => {
    if (user.volatile.imprison) return false;
    user.volatile.imprison = true;
    battle.say(user, 'move.imprison');
    return true;
  },
  'lock-on': ({ battle, user, target }) => aim(battle, user, target),
  'mind-reader': ({ battle, user, target }) => aim(battle, user, target),
  foresight: ({ battle, target }) => identify(battle, target),
  'odor-sleuth': ({ battle, target }) => identify(battle, target),
  'miracle-eye': ({ battle, target }) => identify(battle, target),
  'magnet-rise': ({ battle, user }) => {
    if (user.volatile.magnetRise > 0 || battle.field.gravity > 0) return false;
    user.volatile.magnetRise = 5;
    battle.say(user, 'move.magnetRise');
    return true;
  },
  octolock: ({ battle, target }) => {
    if (target.volatile.octolock) return false;
    target.volatile.octolock = true;
    battle.say(target, 'move.octolock');
    return true;
  },
  'mean-look': ({ battle, target }) => trapped(battle, target),
  block: ({ battle, target }) => trapped(battle, target),
  'spider-web': ({ battle, target }) => trapped(battle, target),
  'fairy-lock': ({ battle, user }) => {
    battle.say(user, 'move.fairyLock');
    return true;
  },
  'no-retreat': ({ battle, user, move, log }) => {
    if (user.volatile.noRetreat) return false;
    user.volatile.noRetreat = true;
    return boostSelf(battle, user, move, log);
  },
  electrify: ({ battle, target }) => {
    target.volatile.electrified = battle.turn;
    battle.say(target, 'move.electrify');
    return true;
  },
  'magic-coat': ({ battle, user }) => {
    user.volatile.magicCoat = battle.turn;
    battle.say(user, 'move.magicCoat');
    return true;
  },
  endure: ({ battle, user }) => {
    user.volatile.endure = battle.turn;
    battle.say(user, 'move.endure');
    return true;
  },
  'tar-shot': ({ battle, target, log }) => {
    const slowed = battle.applyStage(target, 'spe', -1, log);
    if (!target.volatile.tarShot) {
      target.volatile.tarShot = true;
      battle.say(target, 'move.tarShot');
      return true;
    }
    return slowed;
  },
  'venom-drench': ({ battle, target, move, log }) => {
    if (target.pokemon.status !== 'psn') return false;
    let did = false;
    for (const change of move.statChanges ?? []) if (battle.applyStage(target, change.stat, change.change, log)) did = true;
    return did;
  },

  // ---- Types and abilities.
  conversion: ({ battle, user, log }) => {
    const type = moveOf(battle.movesOf(user)[0]?.move ?? '')?.type;
    return Boolean(type) && battle.becomeType(user, [type], log);
  },
  'conversion-2': ({ battle, user, target, log }) => {
    const last = moveOf(target.lastMove ?? '')?.type;
    if (!last) return false;
    const resisting = Object.keys(battle.chartTypes()).filter((type) => typeEffectiveness(last, [type]) < 1);
    const options = resisting.filter((type) => !battle.typesOf(user).includes(type));
    return options.length > 0 && battle.becomeType(user, [battle.rng.pick(options)], log);
  },
  camouflage: ({ battle, user, log }) => battle.becomeType(user, [battle.camouflageType()], log),
  soak: ({ battle, target, log }) => battle.becomeType(target, ['water'], log),
  'magic-powder': ({ battle, target, log }) => battle.becomeType(target, ['psychic'], log),
  'reflect-type': ({ battle, user, target, log }) => battle.becomeType(user, [...battle.typesOf(target)], log),
  'trick-or-treat': ({ battle, target }) => addType(battle, target, 'ghost'),
  'forests-curse': ({ battle, target }) => addType(battle, target, 'grass'),
  'skill-swap': ({ battle, user, target, log }) => {
    if (battle.lockedAbility(user) || battle.lockedAbility(target)) return false;
    const mine = battle.abilitySlugOf(user);
    const theirs = battle.abilitySlugOf(target);
    if (!mine || !theirs || mine === theirs) return false;
    user.marks.ability = theirs;
    target.marks.ability = mine;
    battle.say(user, 'move.skillSwap');
    return true;
  },
  'role-play': ({ battle, user, target, log }) => copyAbility(battle, user, target, log),
  doodle: ({ battle, user, target, log }) => copyAbility(battle, user, target, log),
  entrainment: ({ battle, user, target, log }) => giveAbility(battle, target, battle.abilitySlugOf(user), log),
  'simple-beam': ({ battle, target, log }) => giveAbility(battle, target, 'simple', log),
  'worry-seed': ({ battle, target, log }) => {
    if (!giveAbility(battle, target, 'insomnia', log)) return false;
    if (target.pokemon.status === 'slp') battle.cureStatus(target, log);
    return true;
  },
  'gastro-acid': ({ battle, target }) => {
    if (target.volatile.gastroAcid || battle.lockedAbility(target)) return false;
    target.volatile.gastroAcid = true;
    battle.say(target, 'move.gastroAcid');
    return true;
  },

  // ---- Items.
  trick: ({ battle, user, target, log }) => swapItems(battle, user, target, log),
  switcheroo: ({ battle, user, target, log }) => swapItems(battle, user, target, log),
  recycle: ({ battle, user }) => {
    const slug = user.marks.consumed;
    if (!slug || user.pokemon.heldItem) return false;
    user.pokemon.heldItem = slug;
    user.marks.consumed = null;
    battle.say(user, 'move.recycle', { item: slug });
    return true;
  },

  // ---- Calling another move is handled before the move is aimed (see
  // `battle.calledMove`); these are only the ones whose effect is the field.
  gravity: ({ battle, user }) => fieldTimer(battle, user, 'gravity', 5, 'move.gravity'),
  'wonder-room': ({ battle, user }) => fieldTimer(battle, user, 'wonderRoom', 5, 'move.wonderRoom'),
  'magic-room': ({ battle, user }) => fieldTimer(battle, user, 'magicRoom', 5, 'move.magicRoom'),
  'water-sport': ({ battle, user }) => fieldTimer(battle, user, 'waterSport', 5, 'move.waterSport'),
  'mud-sport': ({ battle, user }) => fieldTimer(battle, user, 'mudSport', 5, 'move.mudSport'),
  mist: ({ battle, user }) => sideTimer(battle, user, 'mist', 5, 'move.mist'),
  // Every Grass type on the field, and nothing else: a Flower Shield's
  // Defense, a Rototiller's Attack and Sp. Atk for the ones on the ground.
  'flower-shield': ({ battle, user, target, log }) => {
    let did = false;
    for (const combatant of [user, target]) {
      if (combatant.pokemon.hp <= 0 || !battle.typesOf(combatant).includes('grass')) continue;
      if (battle.applyStage(combatant, 'def', 1, log, { source: combatant === user ? 'self' : undefined })) did = true;
    }
    return did;
  },
  rototiller: ({ battle, user, target, log }) => {
    let did = false;
    for (const combatant of [user, target]) {
      if (combatant.pokemon.hp <= 0 || !battle.typesOf(combatant).includes('grass') || !battle.grounded(combatant)) continue;
      const source = combatant === user ? 'self' : undefined;
      if (battle.applyStage(combatant, 'atk', 1, log, { source })) did = true;
      if (battle.applyStage(combatant, 'spa', 1, log, { source })) did = true;
    }
    return did;
  },
  // Lie in wait for the other side's next move that helps its user.
  snatch: ({ battle, user }) => {
    user.volatile.snatch = battle.turn;
    battle.say(user, 'move.snatch');
    return true;
  },
  'lucky-chant': ({ battle, user }) => sideTimer(battle, user, 'luckyChant', 5, 'move.luckyChant'),
  // A mat kicked up in front of the side, on the first turn out only, that
  // stops attacks for the turn.
  'mat-block': ({ battle, user }) => {
    if (!battle.firstTurnOut(user)) return false;
    user.volatile.protectTurn = battle.turn;
    user.volatile.protectMove = 'mat-block';
    battle.say(user, 'move.matBlock');
    return true;
  },
  'ion-deluge': ({ battle, user }) => {
    battle.field.ionDeluge = battle.turn;
    battle.say(user, 'move.ionDeluge');
    return true;
  },
  powder: ({ battle, target }) => {
    target.volatile.powder = battle.turn;
    battle.say(target, 'move.powder');
    return true;
  },
  // Every held item on the field, eaten away — here, the one across.
  'corrosive-gas': ({ battle, user, target }) => {
    const slug = removableItem(battle, target);
    if (!slug) return false;
    target.pokemon.heldItem = null;
    battle.say(user, 'move.corrosiveGas', { item: slug });
    battle.settleHeldFormes([]);
    return true;
  },
  // The user's item, handed across to a target with empty hands.
  bestow: ({ battle, user, target }) => {
    const slug = user.pokemon.heldItem;
    if (!slug || target.pokemon.heldItem || battle.bindsItem(user, slug)) return false;
    user.pokemon.heldItem = null;
    target.pokemon.heldItem = slug;
    battle.say(target, 'move.bestow', { item: slug });
    battle.settleHeldFormes([]);
    return true;
  },
  'power-shift': ({ battle, user }) => {
    user.marks.powerShift = !user.marks.powerShift;
    battle.say(user, 'move.powerTrick');
    return true;
  },
  // Double prize money, and a battle that pays none; the mood is real.
  'happy-hour': ({ battle, user }) => {
    battle.say(user, 'move.happyHour');
    return true;
  },
  safeguard: ({ battle, user }) => sideTimer(battle, user, 'safeguard', 5, 'move.safeguard'),
  'wide-guard': ({ battle, user }) => guard(battle, user, 'wideGuard', 'move.wideGuard'),
  'quick-guard': ({ battle, user }) => guard(battle, user, 'quickGuard', 'move.quickGuard'),
  'crafty-shield': ({ battle, user }) => guard(battle, user, 'craftyShield', 'move.craftyShield'),
  'court-change': ({ battle, user }) => {
    battle.field.swapSides();
    battle.say(user, 'move.courtChange');
    return true;
  },
  defog: ({ battle, user, target, log }) => {
    const lowered = battle.applyStage(target, 'eva', -1, log);
    const cleared = battle.clearSide(target.side, log, { screens: true }) | battle.clearSide(user.side, log);
    if (battle.field.terrain) battle.endTerrain(log);
    return lowered || Boolean(cleared);
  },
  'tidy-up': ({ battle, user, move, log }) => {
    battle.clearSide(user.side, log);
    battle.clearSide(battle.other(user).side, log);
    for (const combatant of [user, battle.other(user)]) {
      if (combatant?.volatile.substitute > 0) {
        combatant.volatile.substitute = 0;
        battle.say(combatant, 'move.substitute.end');
      }
    }
    return boostSelf(battle, user, move, log);
  },

  // ---- Leaving.
  roar: ({ battle, user, target, log }) => battle.forceOut(user, target, log),
  whirlwind: ({ battle, user, target, log }) => battle.forceOut(user, target, log),
  teleport: ({ battle, user, log }) => battle.flee(user, log),

  // ---- Nothing at all, on purpose.
  splash: ({ battle, user }) => {
    battle.say(user, 'move.splash');
    return true;
  },
  celebrate: ({ battle, user }) => {
    battle.say(user, 'move.splash');
    return true;
  },
};

/**
 * Every stage the move lists, on its user. Whether any of them moved.
 *
 * @param {any} battle @param {any} user @param {any} move @param {any[]} log
 */
function boostSelf(battle, user, move, log) {
  let raised = false;
  for (const change of move.statChanges ?? []) {
    if (battle.applyStage(user, change.stat, change.change, log, { source: 'self' })) raised = true;
  }
  return raised;
}

/**
 * @param {any} battle @param {any} user @param {any} move @param {any[]} log
 * @param {number} share of maximum HP paid for the boost
 */
function paidBoost(battle, user, move, log, share) {
  const cost = Math.floor(user.maxHp * share);
  if (user.pokemon.hp <= cost) return false;
  const changes = (move.statChanges ?? []).filter((change) => change.self !== false);
  if (changes.every((change) => (user.stages[change.stat] ?? 0) >= 6)) return false;
  battle.loseHp(user, cost, log);
  for (const change of changes) battle.applyStage(user, change.stat, change.change, log, { source: 'self' });
  return true;
}

/** @param {any} battle @param {any} user @param {any[]} log @param {number} share */
function healAndCure(battle, user, log, share) {
  const healed = battle.gainHp(user, Math.floor(user.maxHp * share), log);
  const cured = battle.cureStatus(user, log);
  return healed > 0 || cured;
}

/** @param {any} combatant */
function resetStages(combatant) {
  for (const stat of Object.keys(combatant.stages)) combatant.stages[stat] = 0;
}

/** @param {any} battle @param {any} user @param {any} target @param {string[]} stats @param {string} key */
function swapStages(battle, user, target, stats, key) {
  for (const stat of stats) {
    const mine = user.stages[stat] ?? 0;
    user.stages[stat] = target.stages[stat] ?? 0;
    target.stages[stat] = mine;
  }
  battle.say(user, key);
  return true;
}

/** @param {any} battle @param {any} user @param {any} target @param {string[]} stats @param {string} key */
function splitStats(battle, user, target, stats, key) {
  for (const stat of stats) {
    const shared = Math.floor((battle.rawStat(user, stat) + battle.rawStat(target, stat)) / 2);
    user.marks.split = { ...(user.marks.split ?? {}), [stat]: shared };
    target.marks.split = { ...(target.marks.split ?? {}), [stat]: shared };
  }
  battle.say(user, key);
  return true;
}

/** @param {any} battle @param {any} user @param {any} target */
function aim(battle, user, target) {
  user.volatile.lockOn = { turn: battle.turn, target };
  battle.say(user, 'move.lockOn');
  return true;
}

/** @param {any} battle @param {any} target */
function identify(battle, target) {
  target.volatile.identified = true;
  target.stages.eva = Math.min(0, target.stages.eva ?? 0);
  battle.say(target, 'move.identified');
  return true;
}

/** @param {any} battle @param {any} target */
function trapped(battle, target) {
  if (target.volatile.trapped) return false;
  target.volatile.trapped = true;
  battle.say(target, 'move.trapped');
  return true;
}

/** @param {any} battle @param {any} target @param {string} type */
function addType(battle, target, type) {
  if (battle.typesOf(target).includes(type)) return false;
  target.marks.addedType = type;
  battle.say(target, 'move.typeAdded', { type });
  return true;
}

/** @param {any} battle @param {any} user @param {any} target @param {any[]} log */
function copyAbility(battle, user, target, log) {
  const theirs = battle.abilitySlugOf(target);
  if (!theirs || theirs === battle.abilitySlugOf(user) || battle.lockedAbility(user) || UNCOPYABLE.has(theirs)) return false;
  user.marks.ability = theirs;
  battle.say(user, 'move.copiedAbility', { ability: theirs });
  return true;
}

/** @param {any} battle @param {any} target @param {string|null} ability @param {any[]} log */
function giveAbility(battle, target, ability, log) {
  if (!ability || battle.abilitySlugOf(target) === ability || battle.lockedAbility(target)) return false;
  target.marks.ability = ability;
  battle.say(target, 'move.abilityAcquired', { ability });
  return true;
}

/** Abilities no move can copy away, as the games list them. */
const UNCOPYABLE = new Set([
  'trace', 'forecast', 'flower-gift', 'multitype', 'illusion', 'wonder-guard', 'zen-mode', 'imposter',
  'stance-change', 'power-of-alchemy', 'receiver', 'schooling', 'comatose', 'shields-down', 'disguise',
  'rks-system', 'battle-bond', 'power-construct', 'ice-face', 'gulp-missile', 'hunger-switch', 'neutralizing-gas',
  'zero-to-hero', 'commander', 'tera-shift', 'protosynthesis', 'quark-drive', 'poison-puppeteer',
]);

/** @param {any} battle @param {any} user @param {any} target @param {any[]} log */
function swapItems(battle, user, target, log) {
  const mine = user.pokemon.heldItem;
  const theirs = target.pokemon.heldItem;
  if (!mine && !theirs) return false;
  if ((mine && battle.bindsItem(user, mine)) || (theirs && battle.bindsItem(target, theirs))) return false;
  if (battle.abilityOf(target, user)?.keepsItem && theirs) return false;
  user.pokemon.heldItem = theirs ?? null;
  target.pokemon.heldItem = mine ?? null;
  battle.say(user, 'move.trick');
  if (theirs) battle.say(user, 'move.obtained', { item: theirs });
  if (mine) battle.say(target, 'move.obtained', { item: mine });
  battle.settleHeldFormes(log);
  return true;
}

/** @param {any} battle @param {any} user @param {string} key @param {number} turns @param {string} line */
function fieldTimer(battle, user, key, turns, line) {
  if (battle.field[key] > 0) {
    // A second Trick-Room-like call ends the first, as the games do for the
    // rooms; the sports and gravity simply fail.
    if (key === 'wonderRoom' || key === 'magicRoom') {
      battle.field[key] = 0;
      battle.say(user, `${line}.end`);
      return true;
    }
    return false;
  }
  battle.field[key] = turns;
  battle.say(user, line);
  return true;
}

/** @param {any} battle @param {any} user @param {string} key @param {number} turns @param {string} line */
function sideTimer(battle, user, key, turns, line) {
  if (battle.field.sides[user.side][key] > 0) return false;
  battle.field.sides[user.side][key] = turns;
  battle.say(user, line);
  return true;
}

/** @param {any} battle @param {any} target @param {string} hazard @param {any[]} log */
function layHazard(battle, target, hazard, log) {
  if (!battle.field.addHazard(target.side, hazard)) return;
  log.push({ kind: 'hazard', side: target.side, data: { hazard } });
}

/** @param {any} battle @param {any} user @param {string} key @param {string} line */
function guard(battle, user, key, line) {
  battle.field.sides[user.side][key] = battle.turn;
  battle.say(user, line);
  return true;
}

/**
 * What a damaging move does once it has landed, beyond its data: the item it
 * knocks away, the hazards it spins off, the Pokémon it drags out.
 *
 * @type {Record<string, (ctx: {battle: any, user: any, target: any, move: any, log: any[], damage: number}) => void>}
 */
export const AFTER_HIT = {
  // Its ability is gone, if it has already had its turn.
  'core-enforcer': ({ battle, target }) => {
    if (!target.turn.moved || target.volatile.gastroAcid || battle.lockedAbility(target)) return;
    target.volatile.gastroAcid = true;
    battle.say(target, 'move.gastroAcid');
  },
  'thousand-waves': ({ battle, target }) => trapped(battle, target),
  // The shards stay behind as a hazard at the target's feet.
  'stone-axe': ({ battle, target, log }) => layHazard(battle, target, 'stealthRock', log),
  'ceaseless-edge': ({ battle, target, log }) => layHazard(battle, target, 'spikes', log),
  // Three PP off the last move the target used.
  'eerie-spell': ({ battle, target }) => {
    const slot = battle.movesOf(target).find((entry) => entry.move === target.lastMove);
    if (!slot || slot.pp <= 0) return;
    slot.pp = Math.max(0, slot.pp - 3);
    battle.say(target, 'move.ppReduced', { move: slot.move });
  },
  // What was flung does to the target what it would have done to its holder.
  fling: ({ battle, user, target, log }) => {
    const slug = user.turn.flung;
    const item = slug ? itemOf(slug) : null;
    if (!item || target.pokemon.hp <= 0) return;
    if (item.pocket === 'berries') {
      battle.eatBerryNow(target, log, slug);
      return;
    }
    const orb = item.held?.on === 'selfStatus' ? item.held.status : null;
    const ailment = FLUNG_AILMENTS[slug] ?? (orb === 'tox' ? 'poison' : orb === 'brn' ? 'burn' : null);
    if (ailment) battle.inflictAilment(user, target, ailment, log, { toxic: slug === 'toxic-orb' });
    if ((slug === 'kings-rock' || slug === 'razor-fang') && !target.turn.moved) target.flinched = true;
    // The herbs work on whoever they land on.
    if (slug === 'white-herb') {
      for (const stat of Object.keys(target.stages)) if (target.stages[stat] < 0) target.stages[stat] = 0;
    }
    if (slug === 'mental-herb') battle.freeMind(target, log);
  },
  'knock-off': ({ battle, user, target }) => {
    const slug = removableItem(battle, target);
    if (!slug) return;
    target.pokemon.heldItem = null;
    target.marks.knockedOff = slug;
    battle.say(user, 'move.knockOff', { item: slug });
    battle.settleHeldFormes([]);
  },
  thief: ({ battle, user, target, log }) => battle.stealItem(user, target, log),
  covet: ({ battle, user, target, log }) => battle.stealItem(user, target, log),
  pluck: ({ battle, user, target, log }) => battle.stealBerry(user, target, log),
  'bug-bite': ({ battle, user, target, log }) => battle.stealBerry(user, target, log),
  incinerate: ({ battle, target }) => {
    const item = itemOf(target.pokemon.heldItem ?? '');
    if (!item || !(item.pocket === 'berries' || item.held?.on === 'gem')) return;
    if (battle.abilityOf(target)?.keepsItem) return;
    battle.say(target, 'move.incinerate', { item: target.pokemon.heldItem });
    target.pokemon.heldItem = null;
  },
  'rapid-spin': ({ battle, user, log }) => spinFree(battle, user, log),
  'mortal-spin': ({ battle, user, log }) => spinFree(battle, user, log),
  'clear-smog': ({ battle, target }) => {
    resetStages(target);
    battle.say(target, 'move.clearSmog');
  },
  'brick-break': ({ battle, user, target, log }) => battle.breakScreens(target.side, log),
  'psychic-fangs': ({ battle, user, target, log }) => battle.breakScreens(target.side, log),
  'raging-bull': ({ battle, user, target, log }) => battle.breakScreens(target.side, log),
  'smack-down': ({ battle, target }) => grounded(battle, target),
  'thousand-arrows': ({ battle, target }) => grounded(battle, target),
  'ice-spinner': ({ battle, log }) => battle.endTerrain(log),
  'steel-roller': ({ battle, log }) => battle.endTerrain(log),
  'salt-cure': ({ battle, target }) => {
    if (target.volatile.saltCure) return;
    target.volatile.saltCure = true;
    battle.say(target, 'move.saltCure');
  },
  'throat-chop': ({ battle, target }) => {
    target.volatile.silenced = 2;
  },
  'psychic-noise': ({ battle, target }) => {
    if (target.volatile.healBlock > 0) return;
    target.volatile.healBlock = 2;
    battle.say(target, 'move.healBlock');
  },
  'sparkling-aria': ({ battle, target, log }) => {
    if (target.pokemon.status === 'brn') battle.cureStatus(target, log);
  },
  'wake-up-slap': ({ battle, target, log }) => {
    if (target.pokemon.status === 'slp') battle.cureStatus(target, log);
  },
  'smelling-salts': ({ battle, target, log }) => {
    if (target.pokemon.status === 'par') battle.cureStatus(target, log);
  },
  'burn-up': ({ battle, user, log }) => battle.loseType(user, 'fire', log),
  'double-shock': ({ battle, user, log }) => battle.loseType(user, 'electric', log),
  'tri-attack': ({ battle, user, target, log, move }) => {
    if (!battle.secondaryAllowed(user, target, move) || !battle.rng.chance(0.2 * battle.secondaryOdds(user))) return;
    battle.inflictAilment(user, target, battle.rng.pick(['burn', 'paralysis', 'freeze']), log);
  },
  'dire-claw': ({ battle, user, target, log, move }) => {
    if (!battle.secondaryAllowed(user, target, move) || !battle.rng.chance(0.5 * battle.secondaryOdds(user))) return;
    battle.inflictAilment(user, target, battle.rng.pick(['poison', 'paralysis', 'sleep']), log);
  },
  bind: ({ battle, user, target, move }) => battle.bindTarget(user, target, move),
  wrap: ({ battle, user, target, move }) => battle.bindTarget(user, target, move),
  'fire-spin': ({ battle, user, target, move }) => battle.bindTarget(user, target, move),
  clamp: ({ battle, user, target, move }) => battle.bindTarget(user, target, move),
  whirlpool: ({ battle, user, target, move }) => battle.bindTarget(user, target, move),
  'sand-tomb': ({ battle, user, target, move }) => battle.bindTarget(user, target, move),
  'magma-storm': ({ battle, user, target, move }) => battle.bindTarget(user, target, move),
  infestation: ({ battle, user, target, move }) => battle.bindTarget(user, target, move),
  'snap-trap': ({ battle, user, target, move }) => battle.bindTarget(user, target, move),
  'thunder-cage': ({ battle, user, target, move }) => battle.bindTarget(user, target, move),
  'dragon-tail': ({ battle, user, target, log }) => battle.forceOut(user, target, log),
  'circle-throw': ({ battle, user, target, log }) => battle.forceOut(user, target, log),
  'u-turn': ({ battle, user, log }) => battle.pivot(user, log),
  'volt-switch': ({ battle, user, log }) => battle.pivot(user, log),
  'flip-turn': ({ battle, user, log }) => battle.pivot(user, log),
  'glaive-rush': ({ battle, user }) => {
    user.volatile.glaiveRush = battle.turn + 1;
  },
  'anchor-shot': ({ battle, target }) => {
    trapped(battle, target);
  },
  'spirit-shackle': ({ battle, target }) => {
    trapped(battle, target);
  },
  'jaw-lock': ({ battle, user, target }) => {
    target.volatile.trapped = true;
    user.volatile.trapped = true;
  },
};

/** @param {any} battle @param {any} target */
function grounded(battle, target) {
  if (target.volatile.smackedDown || battle.grounded(target)) return;
  target.volatile.smackedDown = true;
  target.volatile.magnetRise = 0;
  battle.say(target, 'move.smackDown');
}

/** @param {any} battle @param {any} user @param {any[]} log */
function spinFree(battle, user, log) {
  if (user.pokemon.hp <= 0) return;
  if (user.volatile.leechSeed) {
    user.volatile.leechSeed = false;
    battle.say(user, 'move.spinFree', { move: 'leech-seed' });
  }
  if (user.volatile.bound) {
    battle.say(user, 'move.bind.freed', { move: user.volatile.bound.move });
    user.volatile.bound = null;
  }
  battle.clearSide(user.side, log, { spun: true });
}

/**
 * The moves that call another move and use it in their place.
 *
 * @param {any} battle
 * @param {any} user
 * @param {any} target
 * @param {string} slug
 * @returns {string|null|undefined} the move to use instead, null for a call
 *   that fails, undefined for a move that calls nothing
 */
export function calledMove(battle, user, target, slug) {
  switch (slug) {
    case 'metronome': {
      const pool = Object.keys(battle.moveTable()).filter((move) => !NO_CALL.has(move) && battle.callable(move));
      return pool.length ? battle.rng.pick(pool) : null;
    }
    case 'mirror-move':
      return target.lastMove && !NO_CALL.has(target.lastMove) ? target.lastMove : null;
    case 'copycat':
      return battle.lastMoveUsed && !NO_CALL.has(battle.lastMoveUsed) ? battle.lastMoveUsed : null;
    case 'nature-power':
      return { electric: 'thunderbolt', grassy: 'energy-ball', misty: 'moonblast', psychic: 'psychic' }[battle.field.terrain ?? ''] ?? 'tri-attack';
    // The move the target is about to use, taken first and harder — if it
    // is an attack and has not gone off yet.
    case 'me-first': {
      const planned = battle.pendingMoves?.get(target) ?? null;
      const move = planned ? moveOf(planned) : null;
      if (target.turn.moved || !move || move.damageClass === 'status' || NO_CALL.has(planned)) return null;
      user.marks.meFirst = battle.turn;
      return planned;
    }
    case 'sleep-talk': {
      const own = battle.movesOf(user).map((entry) => entry.move).filter((move) => !NO_CALL.has(move) && !CHARGE_TURNS[move]);
      return own.length ? battle.rng.pick(own) : null;
    }
    default:
      return undefined;
  }
}

/** The moves a call never lands on, as the games exclude them. */
const NO_CALL = new Set([
  'metronome', 'mirror-move', 'copycat', 'nature-power', 'sleep-talk', 'assist', 'struggle', 'protect', 'detect',
  'endure', 'kings-shield', 'spiky-shield', 'baneful-bunker', 'obstruct', 'silk-trap', 'burning-bulwark',
  'max-guard', 'transform', 'mimic', 'sketch', 'focus-punch', 'counter', 'mirror-coat', 'metal-burst',
  'comeuppance', 'bide', 'helping-hand', 'follow-me', 'rage-powder', 'trick', 'switcheroo', 'thief', 'covet',
  'destiny-bond', 'snatch', 'chatter', 'belch', 'celebrate', 'hold-hands', 'shell-trap', 'beak-blast',
  'dynamax-cannon', 'behemoth-blade', 'behemoth-bash', 'shed-tail', 'revival-blessing', 'me-first',
]);

/**
 * What an automatic battler should never choose for itself: a move that
 * cannot do anything in a battle of one against one, and one that ends the
 * battle before the companion has won it.
 *
 * @param {string} slug
 */
export function neverAutomatic(slug) {
  return PARTNER_ONLY.has(slug) || LEAVES_BATTLE.has(slug) || Boolean(moveOf(slug)?.allyOnly);
}
