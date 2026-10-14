/**
 * The battle engine.
 *
 * Turn resolution follows the main series: priority then Speed decides who
 * moves, damage uses the modern formula with STAB, type effectiveness, a
 * critical roll and the 85–100% spread, and status conditions tick at the end
 * of the turn. Battles are fought automatically, so the engine produces a list
 * of log entries per turn which the battle scene plays back as animation.
 */
import { COMPANION_DAMAGE_TAKEN, COMPANION_WEAKNESS, FIRST_RUN_EXPERIENCE_BONUS, FIRST_RUN_EXPERIENCE_UNTIL } from '../../shared/constants.mjs';
import { gameData, itemOf, moveOf, speciesOf, typeEffectiveness } from '../core/data.mjs';
import { ABILITIES, abilityEffect, abilityName, afterBattle, auraMultiplier, hasSecondary } from './abilities.mjs';
import { chooseFoeMove } from './foeai.mjs';
import { formeFor, heldForme, SIGNATURE_MOVES, signatureType, standingForme, START_FORMES } from './forms.mjs';
import {
  AFTER_HIT,
  CHARGE_TURNS,
  chargeOwnsStats,
  calledMove,
  failsBeforeUse,
  boundToFail,
  fixedDamage,
  neverAutomatic,
  PARTNER_ONLY,
  reachesHidden,
  RETALIATES,
  SEMI_INVULNERABLE,
  STATUS_MOVES,
  variablePower,
  variableType,
} from './moveeffects.mjs';
import {
  Field,
  FIELD_MOVES,
  FIELD_TURNS,
  HAZARD_LAYERS,
  hazardToll,
  TERRAIN,
  terrainBlocksPriority,
  terrainBlocksStatus,
  terrainDamage,
  WEATHER,
  weatherAccuracy,
  weatherBites,
  weatherDamage,
  weatherHealing,
  weatherStat,
} from './field.mjs';
import { applyHeldEffect, heldPassive, heldTrigger, heldShield, itemsSuppressed, itemSuits } from './items.mjs';
import {
  addVolatile,
  clearVolatile,
  CONFUSION_POWER,
  CONFUSION_SELF_HIT,
  CONFUSION_TURNS,
  freshVolatile,
  hasVolatile,
  INFATUATION_BLOCK,
  LOCK_MOVES,
  oppositeGenders,
  PROTECT_BYPASS,
  PROTECT_MOVES,
  protectChance,
  tickVolatile,
  VOLATILE,
} from './volatile.mjs';
import { gainFromDefeat, levelOf, maxHp, statsOf } from './pokemon.mjs';
import { stageMultiplier } from './stats.mjs';

/**
 * @typedef {Object} Combatant
 * @property {import('./pokemon.mjs').Pokemon} pokemon
 * @property {Record<string, number>} stages
 * @property {boolean} flinched
 * @property {string|null} lockedMove the move a Choice item has it committed to
 * @property {number} turnsTaken
 * @property {Record<string, number>} [usedOn] the turn, counted in its own
 *   turns from one, that it last used each move on
 * @property {Record<string, number>} [missedOn] the turn each move missed on,
 *   for as long as its last use was that miss
 * @property {number} [lastMissTurn] the last of its turns any move missed on
 * @property {{target: Combatant, moves: Set<string>}} [landed] the moves that
 *   have landed on the foe in front of it
 * @property {{target: Combatant, moves: Set<string>}} [usedAgainst] the moves
 *   used on the foe in front of it, hit or miss
 * @property {number} [enteredTurn] the battle turn it came out on
 * @property {'player'|'foe'} side
 * @property {Record<string, any>} marks what an ability or item has left on it
 * @property {Record<string, any>} volatile the states that end with the battle
 * @property {string|null} charging a two-turn move part way through
 * @property {boolean} mustRecharge whether last turn's move has to be paid for
 * @property {string|null} lastMove for the items that reward repeating one
 * @property {number} repeats how many turns running that has been the move
 * @property {boolean} movedLast whether it acted second on the previous turn
 * @property {number} maxHp
 * @property {{hitBy: any[], damage: number, lastHit: any, moved: boolean, lowered: boolean, flung: string|null}} turn what it did
 *   and had done to it this turn
 * @property {{speciesId: number, forme: string|null, stats: Record<string, number>, moves: Array<{move: string, pp: number}>}} [transform]
 *   what a Transform or an Imposter made it, for the rest of the battle
 * @property {number|null} [downAt] when, on the battle's faint clock, it went
 *   down — which decides a knock-out on both sides (see `checkFaint`)
 */

/**
 * @typedef {Object} LogEntry
 * @property {string} kind `move`, `damage`, `effectiveness`, `critical`, `miss`,
 *   `status`, `statusDamage`, `stat`, `statFailed`, `heal`, `faint`, `flinch`,
 *   `noEffect`, `failed`, `end`
 * @property {'player'|'foe'} [side]
 * @property {Record<string, any>} [data]
 * @property {{player: number, foe: number}} [hp] what both sides stood at when
 *   this line was written, so a bar can follow the turn rather than its end
 * @property {{player: string|null, foe: string|null}} [statuses] the status
 *   condition each side was under when this line was written
 * @property {{player: boolean, foe: boolean}} [confused] whether each side was
 *   confused when this line was written
 */

/** The stats a Starf Berry can land on. */
const STAT_KEYS = ['atk', 'def', 'spa', 'spd', 'spe'];

/**
 * The two battle-only stages, as the move data spells them.
 *
 * Every other stat arrives already shortened — `special-attack` is `spa` by
 * the time it reaches here — but accuracy and evasion have no short form in
 * the source, so they came through written out. The hit roll reads `acc` and
 * `eva`, so a Sand Attack was filing its drop under a name nothing looked at
 * and quietly doing nothing at all.
 */
const STAGE_ALIASES = { accuracy: 'acc', evasion: 'eva' };

/** Status conditions the engine models. */
export const STATUS = { BURN: 'brn', POISON: 'psn', PARALYSIS: 'par', SLEEP: 'slp', FREEZE: 'frz' };

/**
 * What is left when nothing has PP.
 *
 * The move list has a `struggle` in it, filed as a Normal move like any other,
 * and using that one was wrong in both directions: a Ghost was immune to it,
 * so two Pokémon out of PP could stand there announcing Struggle at each other
 * for ever, and it cost its user nothing. The games make it typeless — nothing
 * resists it and nothing is immune — never miss, and take a quarter of the
 * user's health for using it, which is what ends a fight nothing else can.
 *
 * The type is a name the chart does not carry, and `typeEffectiveness` answers
 * 1 for a type it does not know, which is exactly the rule wanted here.
 */
export const STRUGGLE = {
  id: 165,
  name: { ko: '발버둥', en: 'Struggle' },
  type: 'typeless',
  damageClass: 'physical',
  power: 50,
  accuracy: null,
  pp: 1,
  priority: 0,
  target: 'selected-pokemon',
  text: { ko: '', en: '' },
  flags: ['contact'],
  meta: null,
  statChanges: [],
};

/** What Struggle costs the Pokémon that had to use it. */
const STRUGGLE_RECOIL = 1 / 4;

/** Move slugs by number, for the copies of a move that have lost their slug. */
/** @type {Map<number, string>|null} */
let moveSlugs = null;

/**
 * Whether a move is aimed at the other side rather than at its user or the
 * field, which is what a substitute, a Magic Coat and a semi-invulnerable
 * turn all ask.
 *
 * @param {any} move
 */
const aimsAtTarget = (move) =>
  ['selected-pokemon', 'all-opponents', 'random-opponent', 'all-other-pokemon', 'selected-pokemon-me-first', 'all-pokemon'].includes(move?.target);

/** What a Crowned Zacian's and a Crowned Zamazenta's Iron Head become. */
/** @type {Record<string, Record<string, string>>} */
const CROWNED_MOVES = {
  'zacian-crowned': { 'iron-head': 'behemoth-blade' },
  'zamazenta-crowned': { 'iron-head': 'behemoth-bash' },
};

/** The moves whose strikes grow stronger one after another. */
const ESCALATING = new Set(['triple-kick', 'triple-axel']);

/** The moves that go back to their trainer whether they hit the Pokémon or its substitute. */
const PIVOTS = new Set(['u-turn', 'volt-switch', 'flip-turn']);

/** The moves Gravity keeps a Pokémon from using. */
const GRAVITY_BANNED = new Set(['fly', 'bounce', 'sky-drop', 'high-jump-kick', 'jump-kick', 'magnet-rise', 'telekinesis', 'flying-press', 'splash', 'floaty-fall']);

/** The delayed attacks: one is already on its way, and a second fails. */
const DELAYED_ATTACKS = new Set(['future-sight', 'doom-desire']);

/** The moves that cannot be used twice running. */
const NO_REPEAT = new Set(['blood-moon', 'gigaton-hammer']);

/** Status moves a substitute does not stop, as the games list them. */
const SUBSTITUTE_BYPASS = new Set(['perish-song', 'roar', 'whirlwind', 'transform', 'psych-up', 'role-play', 'spite', 'haze', 'court-change', 'doodle']);

/** The field clocks whose running out is one of the move lines. */
const FIELD_MESSAGES = new Set(['gravity', 'wonderRoom', 'magicRoom', 'waterSport', 'mudSport', 'mist', 'safeguard', 'luckyChant']);

/** What a combatant did and had done to it this turn, which a few moves ask about. */
const freshTurn = () => ({
  hitBy: /** @type {any[]} */ ([]),
  damage: 0,
  lastHit: /** @type {any} */ (null),
  moved: false,
  lowered: false,
  flung: /** @type {string|null} */ (null),
});

/** How many turn ends a Perish Song's count lasts. */
const PERISH_TURNS = 3;

/**
 * The abilities that are their Pokémon's shape or its whole identity, which
 * no Skill Swap, Worry Seed or Gastro Acid can take away.
 */
const FIXED_ABILITIES = new Set([
  'multitype', 'stance-change', 'schooling', 'comatose', 'shields-down', 'disguise', 'rks-system', 'battle-bond',
  'power-construct', 'ice-face', 'gulp-missile', 'zero-to-hero', 'commander', 'tera-shift', 'as-one-glastrier',
  'as-one-spectrier', 'zen-mode',
]);

/** Moves are capped at this many turns so a stalemate cannot run forever. */
const TURN_LIMIT = 200;

/**
 * The engine's condition names back to the ailment names the move data uses,
 * so an ability can ask for a paralysis in the same words the save writes it.
 */
const STATUS_TO_AILMENT = { brn: 'burn', psn: 'poison', par: 'paralysis', slp: 'sleep', frz: 'freeze' };

/**
 * The moves that only work on the first turn after the user comes out: a Fake
 * Out is a surprise, and a surprise works once.
 */
export const FIRST_TURN_ONLY = new Set(['fake-out', 'first-impression', 'mat-block']);

/**
 * The moves whose side effect only lands on a target whose stats went up this
 * turn: a Burning Jealousy burns the one that just powered up, and nobody else.
 */
export const RAISED_THIS_TURN_ONLY = new Set(['burning-jealousy', 'alluring-voice']);

/**
 * The moves whose user goes down for using them. An Explosion costs its user
 * everything whether it hit, missed or went into a Ghost — only a Damp in
 * front of it stops it going off at all, and then it costs nothing.
 */
export const SELF_KNOCKOUT = new Set(['self-destruct', 'explosion', 'misty-explosion', 'memento']);

/** The status moves the type chart still applies to. */
const TYPE_CHECKED_STATUS = new Set(['thunder-wave']);

/** The type each terrain gives a Mimicry. @type {Record<string, string>} */
const MIMICRY_TYPES = { electric: 'electric', grassy: 'grass', misty: 'fairy', psychic: 'psychic' };

/**
 * The moves whose power the weights decide: a Low Kick and a Grass Knot by
 * how heavy the target is, a Heavy Slam and a Heat Crash by how many times
 * over the user outweighs it.
 */
const WEIGHT_MOVES = { 'low-kick': 'target', 'grass-knot': 'target', 'heavy-slam': 'ratio', 'heat-crash': 'ratio' };

/**
 * A weight move's power, or null for any other move.
 *
 * @param {any} move
 * @param {number} userWeight hectograms
 * @param {number} targetWeight hectograms
 * @returns {number|null}
 */
export function weightPower(move, userWeight, targetWeight) {
  const kind = Object.entries(WEIGHT_MOVES).find(([slug]) => moveOf(slug)?.id === move?.id)?.[1];
  if (!kind) return null;
  if (kind === 'target') {
    const kg = targetWeight / 10;
    return kg < 10 ? 20 : kg < 25 ? 40 : kg < 50 ? 60 : kg < 100 ? 80 : kg < 200 ? 100 : 120;
  }
  const ratio = userWeight / targetWeight;
  return ratio >= 5 ? 120 : ratio >= 4 ? 100 : ratio >= 3 ? 80 : ratio >= 2 ? 60 : 40;
}

/** The two-turn moves that need no charging when the sun is out. */
const SUN_CHARGED = new Set(['solar-beam', 'solar-blade']);

/** @param {any} move @param {string} flag */
const hasFlag = (move, flag) => Boolean(move?.flags?.includes(flag));

export class Battle {
  /**
   * @param {{
   *   rng: import('../core/rng.mjs').Rng,
   *   player: import('./pokemon.mjs').Pokemon,
   *   foes: import('./pokemon.mjs').Pokemon[],
   *   policy: any,
   *   items?: {
   *     choose: (pokemon: import('./pokemon.mjs').Pokemon) => string|null,
   *     throw: (slug: string, pokemon: import('./pokemon.mjs').Pokemon, choice?: {move?: number}) => boolean,
   *   }|null,
   *   trainerBattle?: boolean,
   *   weather?: string|null,
   *   environment?: string|null,
   *   firstRun?: boolean,
   *   bossBattle?: boolean,
   * }} options
   */
  constructor({ rng, player, foes, policy, items = null, trainerBattle = false, weather = null, environment = null, firstRun = false, bossBattle = false }) {
    this.rng = rng;
    this.policy = policy;
    /**
     * The bag, as far as a battle needs one: what to throw unasked, how to
     * throw it, and whether a held berry is worth eating.
     */
    this.items = items;
    /** An item the player has chosen to throw, used instead of next turn's move. */
    /** @type {string|null} */
    this.pendingItem = null;
    /** Which move an Ether is for, when it is one. @type {{move?: number}} */
    this.pendingChoice = {};
    /** Whether the player asked to run, which is tried before next turn's moves. */
    this.pendingEscape = false;
    /** How many times the player has tried, each one likelier than the last. */
    this.escapeAttempts = 0;
    /** Whether the companion's turn went on a run that failed. */
    this.playerSpent = false;
    this.trainerBattle = trainerBattle;
    /** Whether the save is on its first run, which pays more experience early on. */
    this.firstRun = firstRun;
    /** A gym leader or a League round, which the auto-battle can save a move for. */
    this.bossBattle = bossBattle;
    /**
     * The companion's moves the other side has watched it use. A trainer
     * keeps them in mind for the rest of the battle, whichever of their
     * Pokémon is out; a wild Pokémon pays them no attention (see `foeai.mjs`).
     * @type {Set<string>}
     */
    this.seenMoves = new Set();

    this.player = makeCombatant(player, 'player');
    this.foeQueue = foes.map((foe) => makeCombatant(foe, 'foe'));
    this.foe = this.foeQueue.shift() ?? null;

    this.turn = 0;
    /** Whether a Dancer is dancing along, so it does not answer itself. */
    this.dancing = false;
    /**
     * `fled` is a wild Pokémon gone before it was beaten; `escaped` the
     * companion gone before it was.
     * @type {'ongoing'|'won'|'lost'|'fled'|'escaped'}
     */
    this.outcome = 'ongoing';
    /**
     * A count that goes up each time a Pokémon goes down, so the order two of
     * them went down in can be read back afterwards.
     */
    this.faintClock = 0;
    /** The move each side committed to this turn, decided when order is set. */
    /** @type {Map<Combatant, string|null>|null} */
    this.pendingMoves = null;
    /** @type {Array<{experience: number, levelsGained: number, newLevel: number, learnable: string[]}>} */
    this.rewards = [];

    /** The weather, the terrain and the screens. */
    this.field = new Field();
    /**
     * The area's own sky, which the battle opens under.
     *
     * The maps carry it — Route 119 rains in the cartridge and the pipeline
     * has always exported that — so a battle fought there starts in the rain
     * without anyone having called for it, and it does not run out, because
     * the weather there is not a move somebody used.
     */
    this.areaWeather = weather && Object.values(WEATHER).includes(weather) ? weather : null;
    if (this.areaWeather) this.field.setWeather(this.areaWeather, Infinity);

    /** The type a Camouflage takes here, when the ground under it has none. */
    this.environment = environment;
    /** The last move anybody used, for a Copycat. */
    /** @type {string|null} */
    this.lastMoveUsed = null;

    /** Log entries produced before the first turn, by whatever walked in. */
    /** @type {LogEntry[]} */
    this.opening = [];
    /** The log the helpers write into: the opening now, each turn's later. */
    /** @type {LogEntry[]} */
    this.activeLog = this.opening;
    this.enter(this.player, this.opening);
    if (this.foe) this.enter(this.foe, this.opening);
  }

  /**
   * Whatever a Pokémon does simply by being sent out: an Intimidate, a
   * Drizzle, a Download reading the wall in front of it.
   *
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  enter(combatant, log) {
    const other = combatant === this.player ? this.foe : this.player;
    // The turn it came out on, which is what a Fake Out asks: the turn after
    // it is the only one the move works on.
    combatant.enteredTurn = this.turn;
    // An Unburden is waiting for the item to be gone, so it has to know there
    // was one to begin with.
    combatant.marks.hadItem = Boolean(combatant.pokemon.heldItem);

    // Whatever the weather on the field already says about the shape it
    // arrives in — a Forecast walks in as rain or snow made it.
    this.applyForme(combatant, {
      ...this.formeState(combatant),
      // A Disguise is whole the moment it walks in: the marks a battle
      // carries do not follow a Pokémon between battles, and the save never
      // held one.
      broken: false,
      usedMove: null,
    }, log);

    // An Air Balloon says so as its holder comes out, as the games show it —
    // which is what puts it on the screen rather than up its holder's sleeve.
    if (this.onBalloon(combatant)) log.push({ kind: 'message', side: combatant.side, data: { key: 'item.balloon.float' } });

    const ability = this.abilityOf(combatant);
    if (!ability?.start || !other) return;

    // Read before the hook, which may change it: a Trace names itself, then
    // what it copied.
    const slug = this.abilitySlugOf(combatant);
    const before = log.length;
    ability.start(this.abilityContext(combatant, other, log));
    // A line naming the ability goes in front of whatever it did, so the
    // battle reads "Intimidate!" and then the Attack falling.
    if (log.length > before) {
      log.splice(before, 0, { kind: 'ability', side: combatant.side, data: { ability: slug } });
    }
  }

  /**
   * Whether a Pokémon is up on an Air Balloon that has not yet been popped.
   *
   * @param {Combatant} combatant
   */
  onBalloon(combatant) {
    return heldPassive(combatant.pokemon, 'immune')?.moveType === 'ground' && !combatant.marks.popped;
  }

  /** @returns {boolean} whether the battle is still running */
  get running() {
    return this.outcome === 'ongoing';
  }

  /**
   * Throw an item on the companion's next action, which is what opening the
   * bag mid-battle does in the games: the turn is spent on the item rather
   * than on a move.
   *
   * @param {string} slug
   */
  queueItem(slug, choice = {}) {
    this.pendingItem = slug;
    this.pendingChoice = choice;
    this.pendingEscape = false;
  }

  /**
   * Try to run on the next turn, which the games do before anybody moves: a
   * Pokémon as fast as its opponent always gets away, a slower one less often,
   * and each failed try makes the next one likelier. Nobody runs from a
   * trainer.
   */
  queueEscape() {
    if (this.trainerBattle) return false;
    this.pendingEscape = true;
    this.pendingItem = null;
    return true;
  }

  /**
   * The run itself, at the top of a turn. Whether it worked; a failed one
   * spends the companion's turn.
   *
   * @param {LogEntry[]} log
   */
  tryToRun(log) {
    this.pendingEscape = false;
    const player = this.player;
    if (!this.foe || this.trainerBattle) return false;
    if (!this.canEscape(player)) {
      this.say(player, 'battle.cantEscape');
      return false;
    }
    this.escapeAttempts++;
    // Generation III onward: always away when at least as fast; otherwise
    // the speed ratio out of 128, and thirty more for every try so far.
    const mine = this.speedOf(player);
    const theirs = Math.max(1, this.speedOf(this.foe));
    const odds = Math.floor((mine * 128) / theirs) + 30 * this.escapeAttempts;
    if (mine >= theirs || odds > 255 || this.rng.int(0, 255) < odds) {
      this.say(player, 'battle.gotAway');
      this.finish('escaped', log);
      return true;
    }
    this.say(player, 'battle.cantEscape');
    return false;
  }

  /**
   * The weather as the battle actually behaves under it.
   *
   * A Cloud Nine or an Air Lock on either side takes the sky out of the fight
   * without clearing it, so everything that asks about the weather asks here
   * rather than reading the field directly — and a Pokémon under a Utility
   * Umbrella asks with itself named, because the umbrella only covers its
   * holder.
   *
   * @param {Combatant} [forCombatant]
   * @returns {string|null}
   */
  weatherFor(forCombatant) {
    for (const combatant of [this.player, this.foe]) {
      if (combatant && this.ownAbility(combatant)?.suppressWeather) return null;
    }
    if (forCombatant && heldShield(forCombatant.pokemon, 'weatherEffects')) return null;
    return this.field.weather;
  }

  /**
   * The ability a combatant is acting on, as far as the other side is
   * concerned.
   *
   * A Mold Breaker attacking means the defender's ability is not there for the
   * duration of the move, which is the one place an ability is read through
   * somebody else's eyes.
   *
   * @param {Combatant} combatant
   * @param {Combatant} [against] who is acting on it
   */
  abilityOf(combatant, against) {
    // A Mold Breaker, or a move with one built in, sees past the ability.
    if (against && (this.ownAbility(against)?.ignoresAbilities || against.marks?.moldBreaking)) return null;
    // A Neutralizing Gas on the field quiets every ability but its own.
    const other = combatant === this.player ? this.foe : this.player;
    const own = this.ownAbility(combatant);
    if (other && !own?.neutralizes && this.ownAbility(other)?.neutralizes) return null;
    return own;
  }

  /**
   * The ability a combatant has now: one a battle gave it (a Mummy's touch,
   * a Transform's copy) over its forme's, over its own.
   *
   * @param {Combatant} combatant
   */
  abilitySlugOf(combatant) {
    return combatant.marks.ability ?? abilityName(combatant.pokemon);
  }

  /** @param {Combatant} combatant */
  ownAbility(combatant) {
    const slug = this.abilitySlugOf(combatant);
    return slug ? ABILITIES[slug] ?? null : null;
  }

  /** @param {Combatant} combatant */
  other(combatant) {
    return combatant === this.player ? this.foe : this.player;
  }

  /**
   * A move's slug, from the move record or a copy of it with its type or
   * power changed on the way out.
   *
   * @param {any} move
   * @returns {string}
   */
  slugOf(move) {
    if (move?.slug) return move.slug;
    if (move?.id === STRUGGLE.id && move?.type === STRUGGLE.type) return 'struggle';
    if (!moveSlugs) moveSlugs = new Map(Object.entries(gameData().moves).map(([slug, entry]) => [entry.id, slug]));
    return moveSlugs.get(move?.id) ?? '';
  }

  /**
   * Write one of the move lines about a combatant, into the log being built.
   *
   * @param {Combatant|null|undefined} combatant who the line is about
   * @param {string} key a `move.*` string
   * @param {Record<string, any>} [data] what the line names: a `move`, an
   *   `item`, an `ability`, a `type`, a `count`
   */
  say(combatant, key, data = {}) {
    if (!combatant) return;
    this.activeLog.push({ kind: 'message', side: combatant.side, data: { key, ...data } });
  }

  /**
   * Take hit points off a combatant for something other than a hit.
   *
   * @param {Combatant} combatant
   * @param {number} amount
   * @param {LogEntry[]} log
   * @param {Record<string, any>} [data]
   * @returns {number} what was taken
   */
  loseHp(combatant, amount, log, data = {}) {
    const taken = Math.min(combatant.pokemon.hp, Math.max(0, Math.floor(amount)));
    if (taken <= 0) return 0;
    combatant.pokemon.hp -= taken;
    log.push({ kind: 'damage', side: combatant.side, data: { amount: taken, ...data } });
    return taken;
  }

  /**
   * Give hit points back, unless a Heal Block is in the way.
   *
   * @param {Combatant} combatant
   * @param {number} amount
   * @param {LogEntry[]} log
   * @param {{quiet?: boolean}} [options]
   * @returns {number} what was restored
   */
  gainHp(combatant, amount, log, options = {}) {
    const max = combatant.maxHp;
    if (combatant.pokemon.hp <= 0 || combatant.pokemon.hp >= max) return 0;
    if (combatant.volatile.healBlock > 0) {
      this.say(combatant, 'move.healBlock.blocked');
      return 0;
    }
    const restored = Math.min(max - combatant.pokemon.hp, Math.max(1, Math.floor(amount)));
    combatant.pokemon.hp += restored;
    log.push({ kind: 'heal', side: combatant.side, data: { amount: restored, ...(options.quiet ? { quiet: true } : {}) } });
    return restored;
  }

  /**
   * Lift a combatant's condition, the way a Refresh or a Purify does.
   *
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   * @returns {boolean}
   */
  cureStatus(combatant, log) {
    if (!combatant.pokemon.status) return false;
    combatant.pokemon.status = null;
    combatant.pokemon.statusTurns = 0;
    combatant.pokemon.toxic = false;
    combatant.marks.toxicTurns = 0;
    log.push({ kind: 'status', side: combatant.side, data: { status: null } });
    return true;
  }

  /**
   * Whether a combatant could be put to sleep right now: nothing in its
   * ability, the terrain or an uproar keeping it awake.
   *
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   * @param {{quiet?: boolean}} [options]
   */
  canFallAsleep(combatant, log, options = {}) {
    if (this.uproar()) return false;
    if (terrainBlocksStatus(this.field.terrain, STATUS.SLEEP) && this.grounded(combatant)) return false;
    const other = this.other(combatant);
    const ability = this.abilityOf(combatant, other ?? undefined);
    if (ability?.blockStatus?.(this.abilityContext(combatant, other ?? combatant, options.quiet ? [] : log), STATUS.SLEEP)) {
      if (!options.quiet) log.push({ kind: 'ability', side: combatant.side, data: { ability: this.abilitySlugOf(combatant) } });
      return false;
    }
    return true;
  }

  /** Whether anybody on the field is in the middle of an Uproar. */
  uproar() {
    return [this.player, this.foe].some((combatant) => combatant && combatant.volatile.uproar > 0);
  }

  /**
   * Put a lasting state on a combatant and say so, or refuse if it is
   * already there.
   *
   * @param {Combatant} combatant
   * @param {string} key
   * @param {any} value
   * @param {string} line
   */
  setVolatile(combatant, key, value, line) {
    if (combatant.volatile[key]) return false;
    combatant.volatile[key] = value;
    this.say(combatant, line);
    return true;
  }

  /**
   * Spend a Stockpile, and the Defense and Sp. Def it bought with it.
   *
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  dropStockpile(combatant, log) {
    const bought = combatant.volatile.stockpiled ?? { def: 0, spd: 0 };
    for (const [stat, stages] of Object.entries(bought)) {
      if (stages > 0) this.applyStage(combatant, stat, -stages, log, { source: 'self', quiet: true });
    }
    combatant.volatile.stockpile = 0;
    combatant.volatile.stockpiled = { def: 0, spd: 0 };
    this.say(combatant, 'move.stockpile.end');
  }

  /**
   * A combatant's stat before stages and everything else — what a Power
   * Split shares and a Speed Swap trades.
   *
   * @param {Combatant} combatant
   * @param {string} stat
   */
  rawStat(combatant, stat) {
    const read = swappedStat(combatant, stat);
    return combatant.transform?.stats?.[read] ?? statsOf(combatant.pokemon, combatant.marks.forme ?? null)[read];
  }

  /**
   * Start a Perish Song's count on a combatant.
   *
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  startPerish(combatant, log) {
    if (!addVolatile(combatant, VOLATILE.PERISH, PERISH_TURNS)) return false;
    log.push({ kind: 'volatile', side: combatant.side, data: { state: VOLATILE.PERISH } });
    return true;
  }

  /**
   * Whether nothing can change or take away a combatant's ability: the ones
   * that are their Pokémon's shape, and an Ability Shield.
   *
   * @param {Combatant} combatant
   */
  lockedAbility(combatant) {
    return FIXED_ABILITIES.has(this.abilitySlugOf(combatant) ?? '') || Boolean(heldShield(combatant.pokemon, 'ability'));
  }

  /** The eighteen types a move can be, for a Conversion 2 to choose among. */
  chartTypes() {
    return Object.fromEntries(Object.entries(gameData().types).filter(([, type]) => !type.special));
  }

  /** The type a Camouflage takes: the terrain's, or the place's. */
  camouflageType() {
    return { electric: 'electric', grassy: 'grass', misty: 'fairy', psychic: 'psychic' }[this.field.terrain ?? '']
      ?? this.environment ?? 'normal';
  }

  /**
   * Whether an item is part of its holder's shape — a mask, a plate, an orb —
   * and so cannot be knocked off, stolen or swapped.
   *
   * @param {Combatant} combatant
   * @param {string|null} slug
   */
  bindsItem(combatant, slug) {
    if (!slug) return false;
    const holder = { ...combatant.pokemon, heldItem: slug };
    if (heldForme(holder)) return true;
    const species = speciesOf(combatant.pokemon.speciesId)?.slug ?? '';
    return Boolean(START_FORMES.get(species)?.has(slug));
  }

  /** @param {LogEntry[]} log */
  settleHeldFormes(log) {
    this.evaluateFormes(log);
  }

  /**
   * Clear the hazards off one side, and its screens when asked.
   *
   * @param {'player'|'foe'} side
   * @param {LogEntry[]} log
   * @param {{screens?: boolean, spun?: boolean}} [options]
   * @returns {boolean}
   */
  clearSide(side, log, options = {}) {
    let cleared = false;
    const hazards = this.field.hazards[side];
    for (const [hazard, layers] of Object.entries(hazards)) {
      if (!layers) continue;
      hazards[hazard] = 0;
      cleared = true;
      const holder = side === 'player' ? this.player : this.foe;
      log.push({ kind: 'message', side, data: { key: `move.hazardGone.${hazard}${side === 'foe' ? 'Foe' : ''}`, holder: Boolean(holder) } });
    }
    if (options.screens) cleared = this.breakScreens(side, log) || cleared;
    return cleared;
  }

  /**
   * Break the screens on one side, which is what a Brick Break does on the
   * way through.
   *
   * @param {'player'|'foe'} side
   * @param {LogEntry[]} log
   */
  breakScreens(side, log) {
    const screens = this.field.screens[side];
    if (screens.physical <= 0 && screens.special <= 0) return false;
    screens.physical = 0;
    screens.special = 0;
    log.push({ kind: 'message', side, data: { key: 'move.screensBroken' } });
    return true;
  }

  /** @param {LogEntry[]} log */
  endTerrain(log) {
    if (!this.field.terrain) return false;
    log.push({ kind: 'terrainEnded', data: { value: this.field.terrain } });
    this.field.terrain = null;
    this.field.terrainTurns = 0;
    return true;
  }

  /**
   * Take the target's item for the user, as a Thief does.
   *
   * @param {Combatant} user
   * @param {Combatant} target
   * @param {LogEntry[]} log
   */
  stealItem(user, target, log) {
    const slug = target.pokemon.heldItem;
    if (user.pokemon.heldItem || !slug || user.pokemon.hp <= 0) return false;
    if (this.abilityOf(target, user)?.keepsItem || this.bindsItem(target, slug) || this.bindsItem(user, slug)) return false;
    target.pokemon.heldItem = null;
    user.pokemon.heldItem = slug;
    log.push({ kind: 'stole', side: user.side, data: { item: slug } });
    this.evaluateFormes(log);
    return true;
  }

  /**
   * Eat the target's berry, as a Pluck does: the effect is the user's.
   *
   * @param {Combatant} user
   * @param {Combatant} target
   * @param {LogEntry[]} log
   */
  stealBerry(user, target, log) {
    const slug = target.pokemon.heldItem;
    if (!slug || itemOf(slug)?.pocket !== 'berries' || user.pokemon.hp <= 0) return false;
    if (this.abilityOf(target, user)?.keepsItem) return false;
    target.pokemon.heldItem = null;
    this.say(user, 'move.pluck', { item: slug });
    this.eatBerryNow(user, log, slug);
    return true;
  }

  /**
   * Eat a berry at once, whatever its own moment is — a Teatime, a Pluck,
   * a Bug Bite.
   *
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   * @param {string} [given] a berry that is not the one it holds
   * @returns {boolean}
   */
  eatBerryNow(combatant, log, given) {
    const slug = given ?? combatant.pokemon.heldItem;
    const held = slug ? itemOf(slug)?.held : null;
    if (!slug || !held || itemOf(slug)?.pocket !== 'berries' || combatant.pokemon.hp <= 0) return false;
    // Eaten first and then felt: the berry's line goes ahead of whatever it did.
    const mark = log.length;
    if (held.on === 'hp' && held.stat) {
      const stat = held.stat === 'random' ? this.rng.pick(STAT_KEYS) : held.stat;
      this.applyStage(combatant, stat, held.stages ?? 1, log, { source: 'self' });
    } else if (held.on === 'hp' && held.crit) {
      combatant.marks.critStages = (combatant.marks.critStages ?? 0) + held.crit;
    } else if (held.on === 'hp' && held.heal) {
      const amount = held.heal.amount ?? Math.floor(combatant.maxHp * held.heal.fraction);
      this.gainHp(combatant, amount, log);
    } else if (held.on === 'status') {
      if (combatant.pokemon.status && (held.status === 'any' || held.status === combatant.pokemon.status)) {
        this.cureStatus(combatant, log);
      }
      if (held.status === 'cnf' || held.status === 'any') this.cureVolatile(combatant, log);
    } else if (held.on === 'pp') {
      applyHeldEffect(combatant.pokemon, held);
    }
    if (!given) {
      combatant.pokemon.heldItem = null;
      combatant.marks.ateBerry = slug;
      combatant.marks.consumed = slug;
      log.splice(mark, 0, { kind: 'berry', side: combatant.side, data: { item: slug } });
    }
    return true;
  }

  /**
   * A Burn Up or a Double Shock spending the type it drew on.
   *
   * @param {Combatant} combatant
   * @param {string} type
   * @param {LogEntry[]} log
   */
  loseType(combatant, type, log) {
    const left = this.typesOf(combatant).filter((entry) => entry !== type);
    combatant.marks.types = left.length ? left : ['typeless'];
    this.say(combatant, 'move.loseType', { type });
  }

  /**
   * Whether a move's side effect on its target can happen at all: not traded
   * away by a Sheer Force, not refused by a Shield Dust or a Covert Cloak, not
   * soaked up by a substitute.
   *
   * @param {Combatant} user
   * @param {Combatant} target
   * @param {any} move
   */
  secondaryAllowed(user, target, move) {
    if (target.pokemon.hp <= 0) return false;
    if (this.abilityOf(user)?.noSecondary) return false;
    if (heldShield(target.pokemon, 'secondary') || this.abilityOf(target, user)?.noSecondaryTaken) return false;
    return !target.marks.hitSubstitute;
  }

  /** @param {Combatant} user */
  secondaryOdds(user) {
    return this.abilityOf(user)?.secondary ?? 1;
  }

  /**
   * Wrap a target in a binding move: four or five turns of an eighth of its
   * health, a sixth with a Binding Band, seven turns with a Grip Claw.
   *
   * @param {Combatant} user
   * @param {Combatant} target
   * @param {any} move
   */
  bindTarget(user, target, move) {
    if (target.pokemon.hp <= 0 || target.volatile.bound) return;
    const band = heldPassive(user.pokemon, 'bind');
    const claw = heldPassive(user.pokemon, 'bindTurns');
    target.volatile.bound = {
      move: this.slugOf(move),
      turns: claw ? claw.turns : this.rng.int(4, 5),
      fraction: band?.fraction ?? 1 / 8,
      by: user,
    };
    this.say(target, 'move.bind.start', { move: this.slugOf(move) });
  }

  /**
   * Drive the target out, the way a Roar or a Dragon Tail does: a trainer's
   * Pokémon is swapped for another at random, a wild one is sent away and
   * the battle is over. The companion, with nobody to swap in, stays.
   *
   * @param {Combatant} user
   * @param {Combatant} target
   * @param {LogEntry[]} log
   * @returns {boolean}
   */
  forceOut(user, target, log) {
    if (target.pokemon.hp <= 0 || user.pokemon.hp <= 0 || target.side !== 'foe') return false;
    if (target.volatile.ingrain || this.abilityOf(target, user)?.suctionCups) return false;
    if (this.trainerBattle) return this.switchFoe(log, { random: true, dragged: true });
    this.say(target, 'move.blownAway');
    this.finish('fled', log);
    return true;
  }

  /**
   * A trainer's Pokémon going back after a U-turn, and the next one coming
   * out in its place.
   *
   * @param {Combatant} user
   * @param {LogEntry[]} log
   */
  pivot(user, log) {
    if (user.side !== 'foe' || !this.trainerBattle || user.pokemon.hp <= 0 || !this.running) return false;
    return this.switchFoe(log);
  }

  /**
   * Leave a wild battle, as a Teleport does.
   *
   * @param {Combatant} user
   * @param {LogEntry[]} log
   */
  flee(user, log) {
    if (this.trainerBattle || !this.canEscape(user)) return false;
    this.say(user, 'move.fled');
    this.finish(user.side === 'player' ? 'escaped' : 'fled', log);
    return true;
  }

  /**
   * Whether a Pokémon is free to leave: nothing holding it — a Mean Look, a
   * bind, its own roots — and nothing on the other side that keeps it there:
   * a Shadow Tag, an Arena Trap under a grounded foot, a Magnet Pull on
   * steel. A Ghost type slips every one of them, and so does a Run Away.
   *
   * @param {Combatant} combatant
   */
  canEscape(combatant) {
    const own = this.abilityOf(combatant);
    if (this.typesOf(combatant).includes('ghost') || own?.runAway) return true;
    if (combatant.volatile.trapped || combatant.volatile.bound || combatant.volatile.ingrain) return false;
    const other = this.other(combatant);
    if (!other || other.pokemon.hp <= 0) return true;
    const trap = this.abilityOf(other, combatant);
    if (trap?.trapsAll && !own?.trapsAll) return false;
    if (trap?.trapsGrounded && this.grounded(combatant)) return false;
    if (trap?.trapsSteel && this.typesOf(combatant).includes('steel')) return false;
    return true;
  }

  /**
   * End the battle with nobody beaten: the wild Pokémon gone (`fled`), or
   * the companion gone (`escaped`).
   *
   * @param {'fled'|'escaped'} outcome
   * @param {LogEntry[]} log
   */
  finish(outcome, log) {
    if (!this.running) return;
    this.outcome = outcome;
    log.push({ kind: 'end', data: { outcome } });
  }

  /**
   * Swap the trainer's Pokémon out for another: the next one in line, or one
   * at random when it was dragged out.
   *
   * @param {LogEntry[]} log
   * @param {{random?: boolean, dragged?: boolean}} [options]
   * @returns {boolean}
   */
  switchFoe(log, options = {}) {
    const waiting = this.foeQueue.filter((combatant) => combatant.pokemon.hp > 0);
    if (!waiting.length || !this.foe) return false;
    const next = options.random ? this.rng.pick(waiting) : waiting[0];
    const leaving = this.foe;
    this.foeQueue.splice(this.foeQueue.indexOf(next), 1);
    this.leaveField(leaving);
    this.foeQueue.push(leaving);
    this.foe = next;
    log.push({ kind: 'sendOut', side: 'foe', data: { speciesId: next.pokemon.speciesId, pokemon: next.pokemon } });
    if (options.dragged) this.say(next, 'move.draggedOut');
    this.walkOntoHazards(next, log);
    this.enter(next, log);
    this.imposeAgain(this.player, log);
    return true;
  }

  /**
   * An Imposter taking the shape of the next Pokémon a trainer sends out.
   *
   * On the cartridge it works only as its holder comes out, and a Ditto facing
   * a trainer's second Pokémon is switched out and back in to copy it. The
   * companion is never switched out, so without this a Ditto went on through
   * a whole party in the shape of the first Pokémon it met.
   *
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  imposeAgain(combatant, log) {
    if (combatant.pokemon.hp <= 0 || abilityName(combatant.pokemon) !== 'imposter') return;
    const other = combatant === this.player ? this.foe : this.player;
    // A Neutralizing Gas quiets it now as it would on the way in.
    if (!other || other.transform || this.ownAbility(other)?.neutralizes) return;
    // Its own shape back for a moment: a Transform will not take over another.
    const was = { transform: combatant.transform, types: combatant.marks.types, ability: combatant.marks.ability };
    combatant.transform = undefined;
    delete combatant.marks.types;
    delete combatant.marks.ability;
    const before = log.length;
    if (this.transformInto(combatant, other, log)) {
      log.splice(before, 0, { kind: 'ability', side: combatant.side, data: { ability: 'imposter' } });
      return;
    }
    combatant.transform = was.transform;
    if (was.types) combatant.marks.types = was.types;
    if (was.ability) combatant.marks.ability = was.ability;
  }

  /**
   * What leaving the field undoes: every stage and every state a battle put
   * on it, its forme, and — a Natural Cure's, a Regenerator's — what
   * switching out is worth.
   *
   * @param {Combatant} combatant
   */
  leaveField(combatant) {
    afterBattle(combatant.pokemon, combatant.maxHp);
    combatant.stages = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 };
    combatant.volatile = freshVolatile();
    combatant.marks = {};
    combatant.transform = undefined;
    combatant.charging = null;
    combatant.mustRecharge = false;
    combatant.lockedMove = null;
    combatant.lastMove = null;
    combatant.repeats = 0;
    combatant.pokemon.toxic = combatant.pokemon.status === STATUS.POISON && combatant.pokemon.toxic;
    const forme = standingForme(combatant.pokemon);
    if (forme) combatant.pokemon.forme = forme;
    else delete combatant.pokemon.forme;
  }

  /** Every move the dex has, for a Metronome to pick from. */
  moveTable() {
    return gameData().moves;
  }

  /**
   * Whether a Metronome can land on a move: a real move of the main games,
   * not a Z-Move, a Max Move or a signature a single Pokémon's shape owns.
   *
   * @param {string} slug
   */
  callable(slug) {
    const move = moveOf(slug);
    return Boolean(move && move.id < 10000 && !slug.includes('--') && !/^max-|^g-max-/.test(slug) && move.pp > 1);
  }

  /**
   * How heavy a combatant is, in hectograms as the dex keeps it: its
   * species', or what it transformed into, doubled by a Heavy Metal, halved
   * by a Light Metal or a Float Stone.
   *
   * @param {Combatant} combatant
   */
  weightOf(combatant) {
    const species = speciesOf(combatant.transform?.speciesId ?? combatant.pokemon.speciesId);
    let weight = species?.weight ?? 100;
    const ability = this.abilityOf(combatant);
    if (ability?.weight) weight *= ability.weight;
    const float = heldPassive(combatant.pokemon, 'weight');
    if (float) weight *= float.multiplier;
    return Math.max(1, weight);
  }

  /**
   * The moves a combatant fights with: a Transform's copies while it is one.
   *
   * @param {Combatant} combatant
   */
  movesOf(combatant) {
    const moves = combatant.transform?.moves ?? combatant.pokemon.moves;
    // A Mimic stands in for the move it copied until the battle ends.
    const mimicked = combatant.marks.mimicked;
    if (!mimicked) return moves;
    return moves.map((slot, index) => (index === mimicked.index ? mimicked.slot : slot));
  }

  /**
   * Become the target, the way a Transform or an Imposter does: its species'
   * look, its types, its stats but Hit Points, its stat stages, its ability,
   * and its moves at five PP each — for the rest of the battle.
   *
   * @param {Combatant} self
   * @param {Combatant} target
   * @param {LogEntry[]} log
   * @returns {boolean}
   */
  transformInto(self, target, log) {
    if (!target || target.transform || self.transform) return false;
    const stats = statsOf(target.pokemon, target.marks.forme ?? null);
    self.transform = {
      speciesId: target.pokemon.speciesId,
      forme: target.marks.forme ?? null,
      stats,
      moves: target.pokemon.moves.map((slot) => ({ move: slot.move, pp: Math.min(5, moveOf(slot.move)?.pp ?? 5) })),
    };
    self.marks.types = [...this.typesOf(target)];
    self.marks.ability = this.abilitySlugOf(target);
    self.stages = { ...target.stages };
    log.push({
      kind: 'transformed',
      side: self.side,
      data: { speciesId: target.pokemon.speciesId, forme: target.marks.forme ?? null },
    });
    return true;
  }

  /**
   * Everything an ability hook is handed, with the doing-and-saying already
   * paired up.
   *
   * @param {Combatant} self whose ability it is
   * @param {Combatant} foe
   * @param {LogEntry[]} log
   * @param {Record<string, any>} [extra]
   */
  abilityContext(self, foe, log, extra = {}) {
    const battle = this;
    return {
      battle,
      self,
      foe,
      rng: this.rng,
      log,
      field: this.field,
      weather: this.weatherFor(self),
      terrain: this.field.terrain,
      movingLast: self.movedLast,
      ...extra,

      /** @param {Combatant} combatant */
      /** The ability a combatant has right now. @param {Combatant} combatant */
      abilitySlug: (combatant) => battle.abilitySlugOf(combatant),

      /**
       * A line of the ability's own, naming its holder and the ability.
       * @param {string} key
       * @param {Record<string, any>} [data]
       */
      say(key, data = {}) {
        log.push({ kind: 'message', side: self.side, data: { key, ability: battle.abilitySlugOf(self), ...data } });
      },

      /** An Anticipation: a shudder if the other side knows something to fear. */
      anticipate() {
        const types = battle.typesOf(self);
        const feared = battle.movesOf(foe).some((slot) => {
          const move = moveOf(slot.move);
          if (!move || move.damageClass === 'status') return false;
          return Boolean(move.rules?.ohko) || typeEffectiveness(move.type, types) > 1;
        });
        if (feared) log.push({ kind: 'message', side: self.side, data: { key: 'ability.anticipation' } });
      },

      /** A Forewarn: the other side's strongest move, named. */
      forewarn() {
        /** @param {string} slug */
        const weight = (slug) => {
          const move = moveOf(slug);
          return move.rules?.ohko ? 150 : move.damageClass === 'status' ? 0 : move.power ?? 80;
        };
        const known = battle.movesOf(foe).map((slot) => slot.move).filter((slug) => moveOf(slug));
        if (!known.length) return;
        const top = Math.max(...known.map(weight));
        const picked = battle.rng.pick(known.filter((slug) => weight(slug) === top));
        log.push({ kind: 'message', side: self.side, data: { key: 'ability.forewarn', move: picked } });
      },

      /**
       * An Intimidate: the other side's Attack, one stage down — unless it
       * hides behind a substitute or has an ability too steady to be scared.
       * A Rattled runs faster for it, a Guard Dog bristles, and an Adrenaline
       * Orb goes off.
       */
      intimidate() {
        if (foe.pokemon.hp <= 0 || foe.volatile.substitute > 0) return;
        const theirs = battle.abilityOf(foe, self);
        if (theirs?.intimidateImmune) {
          log.push({ kind: 'ability', side: foe.side, data: { ability: battle.abilitySlugOf(foe) } });
          log.push({ kind: 'message', side: foe.side, data: { key: 'stat.notLowered', stat: 'atk' } });
        } else if (theirs?.intimidateBoost) {
          log.push({ kind: 'ability', side: foe.side, data: { ability: battle.abilitySlugOf(foe) } });
          battle.applyStage(foe, 'atk', 1, log, { source: 'self' });
        } else {
          battle.applyStage(foe, 'atk', -1, log, { ability: battle.abilitySlugOf(self) });
          if (theirs?.onIntimidated) {
            log.push({ kind: 'ability', side: foe.side, data: { ability: battle.abilitySlugOf(foe) } });
            theirs.onIntimidated(battle.abilityContext(foe, self, log));
          }
        }
        if (heldPassive(foe.pokemon, 'intimidated')) {
          const mark = log.length;
          if (battle.applyStage(foe, 'spe', 1, log, { source: 'self', quiet: true })) {
            log.splice(mark, 0, { kind: 'heldFired', side: foe.side, data: { item: foe.pokemon.heldItem } });
            battle.consumeItem(foe);
          }
        }
      },

      /**
       * The stats a combatant fights on: its forme's, or the ones a
       * Transform copied.
       *
       * @param {Combatant} combatant
       */
      statsOf: (combatant) => ({ ...statsOf(combatant.pokemon, combatant.marks?.forme), ...(combatant.transform?.stats ?? {}) }),

      /**
       * @param {string} kind
       * @param {Record<string, any>} [data]
       */
      note(kind, data = {}) {
        log.push({ kind, side: self.side, data: { ability: battle.abilitySlugOf(self), ...data } });
      },

      /** @param {Combatant} target @param {number} fraction of maximum HP */
      damage(target, fraction) {
        if (target.pokemon.hp <= 0) return;
        if (battle.abilityOf(target)?.indirectImmune) return;
        const amount = Math.max(1, Math.floor(target.maxHp * fraction));
        target.pokemon.hp = Math.max(0, target.pokemon.hp - amount);
        log.push({
          kind: 'abilityDamage',
          side: target.side,
          data: { amount, ability: battle.abilitySlugOf(self) },
        });
      },

      /** @param {Combatant} target @param {number} fraction */
      heal(target, fraction) {
        const max = target.maxHp;
        if (target.pokemon.hp <= 0 || target.pokemon.hp >= max) return;
        const amount = Math.max(1, Math.floor(max * fraction));
        target.pokemon.hp = Math.min(max, target.pokemon.hp + amount);
        log.push({ kind: 'heal', side: target.side, data: { amount, ability: battle.abilitySlugOf(self) } });
      },

      /** @param {Combatant} target @param {string} stat @param {number} change */
      raise(target, stat, change) {
        if (target.pokemon.hp <= 0) return false;
        // A Clear Amulet, and every ability that answers a drop, only care
        // about a drop the other side caused.
        if (change < 0 && target !== self && heldShield(target.pokemon, 'statDrops')) return false;
        return battle.applyStage(target, stat, change, log, {
          ability: battle.abilitySlugOf(self),
          ...(target === self ? { source: 'self' } : {}),
        });
      },

      /** @param {Combatant} target @param {string} status @param {number} chance */
      inflict(target, status, chance) {
        if (!battle.rng.chance(chance)) return false;
        const other = target === self ? foe : self;
        return battle.inflictAilment(other, target, STATUS_TO_AILMENT[status] ?? status, log);
      },

      /** @param {Combatant} target */
      cure(target) {
        if (!target.pokemon.status) return;
        target.pokemon.status = null;
        target.pokemon.statusTurns = 0;
        log.push({
          kind: 'status',
          side: target.side,
          data: { status: null, ability: battle.abilitySlugOf(self) },
        });
      },

      /** @param {string} weather */
      setWeather: (weather) => this.startWeather(weather, self, log),
      /** @param {string} terrain */
      setTerrain: (terrain) => this.startTerrain(terrain, self, log),

      /** @param {Combatant} target */
      transform: (target) => this.transformInto(self, target, log),

      /**
       * The other Pokémon's ability becomes this one, for the rest of the
       * battle — a Mummy's touch.
       *
       * @param {Combatant} target
       * @param {string} ability
       */
      replaceAbility: (target, ability) => {
        if (this.abilitySlugOf(target) === ability) return false;
        target.marks.ability = ability;
        log.push({ kind: 'abilityChanged', side: target.side, data: { ability } });
        return true;
      },

      /** The two swap abilities — a Wandering Spirit's touch. */
      swapAbilities: () => {
        const mine = this.abilitySlugOf(self);
        const theirs = this.abilitySlugOf(foe);
        if (!mine || !theirs || mine === theirs) return false;
        self.marks.ability = theirs;
        foe.marks.ability = mine;
        log.push({ kind: 'abilityChanged', side: foe.side, data: { ability: mine } });
        log.push({ kind: 'abilityChanged', side: self.side, data: { ability: theirs } });
        return true;
      },

      /**
       * Use up the held item, the way a berry is eaten — a Booster Energy.
       *
       * @param {Combatant} target
       */
      spendItem: (target) => {
        const item = target.pokemon.heldItem;
        if (!item) return;
        log.push({ kind: 'berry', side: target.side, data: { item } });
        target.pokemon.heldItem = null;
      },

      /** @param {Combatant} target @param {number} chance */
      infatuate: (target, chance) => battle.rng.chance(chance) && battle.infatuate(self, target, log),

      /** @param {Combatant} target */
      confuse: (target) => battle.confuse(target, log),

      /** @param {Combatant} target @param {number} chance */
      disable(target, chance) {
        if (!battle.rng.chance(chance)) return false;
        if (!target.lastMove || !battle.movesOf(target).some((slot) => slot.move === target.lastMove)) return false;
        if (battle.blocksVolatile(target, VOLATILE.DISABLE, log)) return false;
        if (!addVolatile(target, VOLATILE.DISABLE, 4, { disabledMove: target.lastMove })) return false;
        log.push({ kind: 'volatile', side: target.side, data: { state: VOLATILE.DISABLE, move: target.lastMove } });
        battle.eatMentalHerb(target, log);
        return true;
      },

      /** Start the count on both sides, which is what a Perish Body does. */
      perish() {
        for (const combatant of [self, foe]) {
          if (!addVolatile(combatant, VOLATILE.PERISH, 4)) continue;
          log.push({ kind: 'volatile', side: combatant.side, data: { state: VOLATILE.PERISH } });
        }
      },

      /** @param {string} hazard laid at the other side's feet */
      layHazard(hazard) {
        if (!battle.field.addHazard(foe.side, hazard)) return false;
        log.push({ kind: 'hazard', side: foe.side, data: { hazard } });
        return true;
      },

      /** @param {Combatant} target @param {number} amount in hit points */
      damageFlat(target, amount) {
        if (target.pokemon.hp <= 0 || amount <= 0) return;
        if (battle.abilityOf(target)?.indirectImmune) return;
        const dealt = Math.min(target.pokemon.hp, Math.round(amount));
        target.pokemon.hp -= dealt;
        log.push({ kind: 'abilityDamage', side: target.side, data: { amount: dealt, ability: battle.abilitySlugOf(self) } });
      },

      /** Take down whatever the other side put up. */
      clearScreens() {
        let cleared = false;
        for (const side of /** @type {const} */ (['player', 'foe'])) {
          for (const kind of /** @type {const} */ (['physical', 'special'])) {
            if (battle.field.screens[side][kind] <= 0) continue;
            battle.field.screens[side][kind] = 0;
            cleared = true;
          }
        }
        if (cleared) log.push({ kind: 'screenEnded', side: self.side, data: {} });
        return cleared;
      },

      /** Take the other side's held item, if it has one and is not holding on. */
      steal() {
        if (self.pokemon.heldItem || !foe.pokemon.heldItem) return false;
        if (battle.abilityOf(foe, self)?.keepsItem) return false;
        const slug = foe.pokemon.heldItem;
        foe.pokemon.heldItem = null;
        self.pokemon.heldItem = slug;
        log.push({ kind: 'stole', side: self.side, data: { item: slug } });
        return true;
      },
    };
  }

  /**
   * Move a stat stage and say so, which is the one thing three different
   * systems all needed to do the same way.
   *
   * @param {Combatant} target
   * @param {string} stat
   * @param {number} change
   * @param {LogEntry[]} log
   * @param {Record<string, any>} [data] carried onto the entry, less `quiet`:
   *   set that where the answer decides whether an item is spent at all, so a
   *   berry that stays in the hand does not announce a stage it never moved
   * @returns {boolean} whether anything moved
   */
  applyStage(target, stat, change, log, data = {}) {
    stat = STAGE_ALIASES[stat] ?? stat;
    const { quiet = false, ...detail } = data;
    const other = target === this.player ? this.foe : this.player;
    const ability = this.abilityOf(target);

    // A Contrary reads every change the other way round, and a Simple reads
    // every one twice as far.
    let shift = change;
    if (ability?.invertStages) shift = -shift;
    if (ability?.doubleStages) shift *= 2;

    // Something the other side is doing to it, and it says no.
    const fromOther = shift < 0 && data.source !== 'self';
    if (fromOther && ability?.statDrop?.(this.abilityContext(target, other ?? target, log), stat)) {
      if (!quiet) {
        log.push({ kind: 'ability', side: target.side, data: { ability: this.abilitySlugOf(target) } });
        log.push({ kind: 'message', side: target.side, data: { key: 'stat.notLowered', stat } });
      }
      return false;
    }
    // A Mist over its side keeps the other side's drops off.
    if (fromOther && this.field.sides[target.side].mist > 0 && !(other && this.abilityOf(other)?.infiltrates)) {
      if (!quiet) this.say(target, 'move.mist.protected');
      return false;
    }
    // Or says no and hands it back, which is what a Mirror Armor does.
    if (fromOther && ability?.reflectsDrops && other) {
      log.push({ kind: 'ability', side: target.side, data: { ability: this.abilitySlugOf(target) } });
      return this.applyStage(other, stat, shift, log, { source: 'self' });
    }

    const before = target.stages[stat] ?? 0;
    const after = Math.max(-6, Math.min(6, before + shift));
    // What a Burning Jealousy looks for.
    if (after > before) target.marks.raisedTurn = this.turn;
    // Already as high or as low as it goes. The games say so rather than
    // letting the move look like it did nothing at all.
    if (after === before) {
      if (!quiet) log.push({ kind: 'statFailed', side: target.side, data: { stat, change: shift } });
      return false;
    }
    target.stages[stat] = after;
    // A White Herb remembers that something was lowered so it can undo it,
    // and a Lash Out that it happened this turn.
    if (shift < 0) {
      target.marks.lowered = true;
      if (target.turn) target.turn.lowered = true;
    }
    log.push({ kind: 'stat', side: target.side, data: { stat, change: shift, stage: after, ...detail } });

    // An Opportunist helps itself to whatever the other side just worked for,
    // and a Mirror Herb does it once.
    if (shift > 0 && data.source !== 'copied' && other && other.pokemon.hp > 0) {
      if (this.abilityOf(other)?.copiesRaises) {
        log.push({ kind: 'ability', side: other.side, data: { ability: this.abilitySlugOf(other) } });
        this.applyStage(other, stat, shift, log, { source: 'copied' });
      } else if (heldPassive(other.pokemon, 'mirror')) {
        log.push({ kind: 'heldFired', side: other.side, data: { item: other.pokemon.heldItem } });
        this.consumeItem(other);
        this.applyStage(other, stat, shift, log, { source: 'copied' });
      }
    }

    // And what answering a drop is worth: a Defiant's two stages of Attack.
    if (fromOther && ability?.onStatDropped && other) {
      const mark = log.length;
      ability.onStatDropped(this.abilityContext(target, other, log), stat);
      if (log.length > mark) {
        log.splice(mark, 0, { kind: 'ability', side: target.side, data: { ability: this.abilitySlugOf(target) } });
      }
    }
    return true;
  }

  /**
   * Put weather over the field, for as long as whoever called it can hold it.
   *
   * @param {string} weather
   * @param {Combatant} source
   * @param {LogEntry[]} log
   */
  startWeather(weather, source, log) {
    const extend = heldPassive(source.pokemon, 'extend');
    const turns = extend?.what === 'weather' ? extend.turns : FIELD_TURNS;
    if (!this.field.setWeather(weather, turns)) return false;
    log.push({ kind: 'weather', side: source.side, data: { weather, turns } });
    this.checkSeeds(log);
    this.evaluateFormes(log);
    return true;
  }

  /**
   * @param {string} terrain
   * @param {Combatant} source
   * @param {LogEntry[]} log
   */
  startTerrain(terrain, source, log) {
    const extend = heldPassive(source.pokemon, 'extend');
    const turns = extend?.what === 'terrain' ? extend.turns : FIELD_TURNS;
    if (!this.field.setTerrain(terrain, turns)) return false;
    log.push({ kind: 'terrain', side: source.side, data: { terrain, turns } });
    this.checkSeeds(log);
    return true;
  }

  /**
   * The four seeds, which are waiting for a terrain to be laid under them.
   * @param {LogEntry[]} log
   */
  checkSeeds(log) {
    for (const combatant of [this.player, this.foe]) {
      if (!combatant || combatant.pokemon.hp <= 0) continue;
      const seed = heldPassive(combatant.pokemon, 'terrain');
      if (!seed || seed.terrain !== this.field.terrain) continue;

      // The seed's line goes ahead of the stage it raised, as every held
      // item's does: what was used, and then what it did.
      const mark = log.length;
      let used = false;
      for (const stat of seed.stats) {
        if (this.applyStage(combatant, stat, seed.stages ?? 1, log, { quiet: true })) used = true;
      }
      if (!used) continue;
      log.splice(mark, 0, { kind: 'berry', side: combatant.side, data: { item: combatant.pokemon.heldItem } });
      combatant.pokemon.heldItem = null;
    }
  }

  /**
   * Whether a Pokémon is standing on the ground, which is the whole of what
   * decides if the terrain reaches it.
   *
   * @param {Combatant} combatant
   */
  grounded(combatant) {
    // An Iron Ball drags anything down, and it wins over everything else —
    // as do Gravity, a Smack Down and roots put down.
    if (heldPassive(combatant.pokemon, 'stat')?.grounds) return true;
    if (this.field.gravity > 0 || combatant.volatile.smackedDown || combatant.volatile.ingrain) return true;
    if (combatant.volatile.magnetRise > 0) return false;

    if (this.onBalloon(combatant)) return false;
    if (this.abilityOf(combatant)?.floats) return false;
    return !this.typesOf(combatant).includes('flying');
  }

  /**
   * A turn's log: an ordinary array that stamps each entry with the hit points
   * on both sides at the moment it was written.
   *
   * The screen plays a turn back after the engine has finished working it out,
   * so a bar that reads the Pokémon's own `hp` while playing reads the value
   * at the *end* of the turn. Both bars therefore fell together on the first
   * blow of the turn, whoever it landed on — the opponent's attack appearing
   * to take effect only when the companion next swung. The stamp is what the
   * bar stood at on that line.
   *
   * @returns {LogEntry[]}
   */
  makeLog() {
    /** @type {LogEntry[]} */
    const log = [];
    const push = Array.prototype.push.bind(log);
    Object.defineProperty(log, 'push', {
      configurable: true,
      value: (...entries) => {
        this.noteFaints();
        for (const entry of entries) {
          if (entry && !entry.hp) entry.hp = this.hitPoints();
          if (entry && !entry.statuses) entry.statuses = this.statuses();
          if (entry && !entry.confused) entry.confused = this.confusion();
        }
        return push(...entries);
      },
    });
    return log;
  }

  /**
   * Stamp the moment each Pokémon on the field went down, the first line
   * written after its hit points reached nothing. Every blow writes a line,
   * so the stamps come in the order the Pokémon fell.
   */
  noteFaints() {
    for (const combatant of [this.player, this.foe]) {
      if (!combatant) continue;
      if (combatant.pokemon.hp > 0) combatant.downAt = null;
      else if (combatant.downAt == null) combatant.downAt = ++this.faintClock;
    }
  }

  /**
   * What status condition each side is under right now, stamped on every
   * line for the same reason the hit points are: the nameplate follows the
   * turn as it plays back, rather than jumping to how it ended.
   *
   * @returns {{player: string|null, foe: string|null}}
   */
  statuses() {
    return {
      player: this.player.pokemon.status ?? null,
      foe: this.foe ? this.foe.pokemon.status ?? null : null,
    };
  }

  /**
   * Whether each side is confused right now, stamped beside the conditions.
   * @returns {{player: boolean, foe: boolean}}
   */
  confusion() {
    return {
      player: hasVolatile(this.player, VOLATILE.CONFUSION),
      foe: this.foe ? hasVolatile(this.foe, VOLATILE.CONFUSION) : false,
    };
  }

  /** What both sides are on right now. */
  hitPoints() {
    return {
      player: this.player.pokemon.hp,
      foe: this.foe ? this.foe.pokemon.hp : 0,
    };
  }

  /**
   * Play one turn and return everything that happened in it.
   * @returns {LogEntry[]}
   */
  takeTurn() {
    const log = this.makeLog();
    if (!this.running || !this.foe) return log;
    this.activeLog = log;

    this.turn++;
    for (const combatant of [this.player, this.foe]) if (combatant) combatant.turn = freshTurn();
    this.field.echoedThisTurn = false;
    this.syncSuppression();
    if (this.turn > TURN_LIMIT) {
      // A pair that cannot hurt each other would otherwise loop forever; the
      // wild Pokémon leaving is the least disruptive way out.
      this.outcome = 'won';
      log.push({ kind: 'end', data: { reason: 'stalemate' } });
      return log;
    }

    // Anything a Pokémon sent out this turn does on the way in — and, on the
    // first turn, what the two of them did before a blow was struck.
    if (this.opening.length) {
      log.push(...this.opening);
      this.opening = [];
    }

    // A run is tried before anybody moves, and a failed one is the
    // companion's turn gone.
    this.playerSpent = false;
    if (this.pendingEscape) {
      if (this.tryToRun(log)) return log;
      this.playerSpent = true;
    }

    const first = this.orderOfPlay();
    // A Focus Punch is tightened before anybody moves, so a hit in between
    // can break it.
    for (const combatant of first) {
      if (this.pendingMoves?.get(combatant) === 'focus-punch') this.say(combatant, 'move.focusPunch.start');
    }
    for (const [index, attacker] of first.entries()) {
      attacker.movedLast = index > 0;
      if (!this.running || !this.foe) break;
      // One that was dragged out or went back this turn has no turn left.
      if (attacker !== this.player && attacker !== this.foe) continue;
      if (attacker === this.player && this.playerSpent) continue;
      const defender = attacker === this.player ? this.foe : this.player;
      if (attacker.pokemon.hp <= 0 || defender.pokemon.hp <= 0) continue;
      this.resolveMove(attacker, defender, log);
      this.collectSelfKnockout(attacker, log);
      this.checkFaint(log);
      // Checked between the two sides' moves as well as at the end of the
      // turn: a berry that waits until the turn is over is a berry that lets
      // its holder faint first.
      this.eatHeldBerry(log);
    }

    // A flinch is for the turn it happened in: it stops a Pokémon that has not
    // moved yet, and is gone once the turn is over. One landed by the slower
    // side — on a Pokémon that had already moved — used to wait for its
    // target's next turn and take that instead, so every slow Pokémon with a
    // Bite flinched its opponent far more often than the move says.
    this.player.flinched = false;
    if (this.foe) this.foe.flinched = false;

    if (this.running) {
      for (const combatant of [this.player, this.foe]) {
        if (!combatant || combatant.pokemon.hp <= 0) continue;
        this.endOfTurnHeld(combatant, log);
        this.endOfTurnVolatile(combatant, log);
        this.endOfTurnStatus(combatant, log);
        this.endOfTurnBinding(combatant, log);
        this.endOfTurnField(combatant, log);
        this.endOfTurnAbility(combatant, log);
        this.regrowBerry(combatant, log);
        this.tickStates(combatant, log);
      }
      this.endOfTurnSlots(log);
      if (!this.field.echoedThisTurn) this.field.echoes = 0;
      this.evaluateFormes(log);
      this.tickField(log);
      this.checkFaint(log);
      this.eatHeldBerry(log);
    }

    return log;
  }

  /**
   * Keep the set of Pokémon whose items are switched off in step with the
   * field: everybody under a Magic Room, a combatant whose Klutz a battle
   * handed it.
   */
  syncSuppression() {
    for (const combatant of [this.player, this.foe]) {
      if (!combatant) continue;
      const off = this.field.magicRoom > 0 || this.abilitySlugOf(combatant) === 'klutz' || combatant.volatile.embargo > 0;
      if (off) itemsSuppressed.add(combatant.pokemon);
      else itemsSuppressed.delete(combatant.pokemon);
    }
  }

  /** Let go of everything the battle switched off, once it is over. */
  release() {
    for (const combatant of [this.player, this.foe, ...this.foeQueue]) {
      if (combatant) itemsSuppressed.delete(combatant.pokemon);
    }
  }

  /**
   * The states that act at the end of every turn they last: roots and rings
   * that feed, seeds that drain, a curse and a salt that bite, a yawn coming
   * due, and the clocks on the rest.
   *
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  endOfTurnVolatile(combatant, log) {
    const volatile = combatant.volatile;
    const other = this.other(combatant);
    const indirect = Boolean(this.abilityOf(combatant)?.indirectImmune);

    if (volatile.aquaRing && combatant.pokemon.hp > 0 && combatant.pokemon.hp < combatant.maxHp) {
      this.say(combatant, 'move.aquaRing.heal');
      this.gainHp(combatant, this.rootHeal(combatant, 1 / 16), log, { quiet: true });
    }
    if (volatile.ingrain && combatant.pokemon.hp > 0 && combatant.pokemon.hp < combatant.maxHp) {
      this.say(combatant, 'move.ingrain.heal');
      this.gainHp(combatant, this.rootHeal(combatant, 1 / 16), log, { quiet: true });
    }
    if (volatile.leechSeed && other && other.pokemon.hp > 0 && combatant.pokemon.hp > 0 && !indirect) {
      const sapped = this.loseHp(combatant, Math.max(1, Math.floor(combatant.maxHp / 8)), log);
      this.say(combatant, 'move.leechSeed.sap');
      if (this.abilityOf(combatant)?.drainHurts) this.loseHp(other, sapped, log);
      else this.gainHp(other, this.rootHeal(other, sapped / other.maxHp), log, { quiet: true });
    }
    if (volatile.cursed && combatant.pokemon.hp > 0 && !indirect) {
      this.say(combatant, 'move.curse.hurt');
      this.loseHp(combatant, Math.max(1, Math.floor(combatant.maxHp / 4)), log);
    }
    if (volatile.saltCure && combatant.pokemon.hp > 0 && !indirect) {
      const heavy = this.typesOf(combatant).some((type) => type === 'water' || type === 'steel');
      this.say(combatant, 'move.saltCure.hurt');
      this.loseHp(combatant, Math.max(1, Math.floor(combatant.maxHp / (heavy ? 4 : 8))), log);
    }
    if (volatile.octolock && combatant.pokemon.hp > 0) {
      this.applyStage(combatant, 'def', -1, log);
      this.applyStage(combatant, 'spd', -1, log);
    }
    if (volatile.yawn > 0 && --volatile.yawn === 0 && combatant.pokemon.hp > 0 && !combatant.pokemon.status) {
      this.inflictStatus(combatant, 'sleep', log);
    }
    for (const key of ['magnetRise', 'healBlock', 'silenced', 'laserFocus', 'embargo']) {
      if (volatile[key] > 0 && --volatile[key] === 0) {
        if (key === 'magnetRise') this.say(combatant, 'move.magnetRise.end');
        if (key === 'healBlock') this.say(combatant, 'move.healBlock.end');
      }
    }
    if (volatile.uproar > 0 && --volatile.uproar === 0) {
      this.say(combatant, 'move.uproar.end');
      volatile.locked = null;
    }
  }

  /**
   * What a binding move takes at the end of the turn, and the turn it lets go.
   *
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  endOfTurnBinding(combatant, log) {
    const bound = combatant.volatile.bound;
    if (!bound || combatant.pokemon.hp <= 0) return;
    if (bound.by.pokemon.hp <= 0 || (bound.by !== this.player && bound.by !== this.foe)) {
      combatant.volatile.bound = null;
      return;
    }
    bound.turns -= 1;
    if (bound.turns <= 0) {
      combatant.volatile.bound = null;
      this.say(combatant, 'move.bind.freed', { move: bound.move });
      return;
    }
    if (this.abilityOf(combatant)?.indirectImmune) return;
    this.say(combatant, 'move.bind.hurt', { move: bound.move });
    this.loseHp(combatant, Math.max(1, Math.floor(combatant.maxHp * bound.fraction)), log);
  }

  /**
   * The things waiting on a side rather than on a Pokémon: a Wish coming
   * true, a Future Sight landing.
   *
   * @param {LogEntry[]} log
   */
  endOfTurnSlots(log) {
    for (const side of /** @type {const} */ (['player', 'foe'])) {
      const here = side === 'player' ? this.player : this.foe;
      const wish = this.field.wish[side];
      if (wish && --wish.turns <= 0) {
        this.field.wish[side] = null;
        if (here && here.pokemon.hp > 0) {
          this.say(here, 'move.wish.came');
          this.gainHp(here, wish.amount, log, { quiet: true });
        }
      }
      const future = this.field.futureSight[side];
      if (future && --future.turns <= 0) {
        this.field.futureSight[side] = null;
        if (here && here.pokemon.hp > 0) {
          this.say(here, 'move.futureSight.hit', { move: future.move });
          const move = { ...moveOf(future.move), slug: future.move, type: moveOf(future.move)?.type ?? 'psychic' };
          const result = this.computeDamage(future.from, here, move);
          if (result.effectiveness > 0) {
            here.pokemon.hp = Math.max(0, here.pokemon.hp - result.damage);
            log.push({ kind: 'damage', side: here.side, data: { amount: result.damage } });
            if (result.effectiveness !== 1) log.push({ kind: 'effectiveness', side: here.side, data: { effectiveness: result.effectiveness } });
          }
        }
      }
    }
  }

  /**
   * What a healing root or ring gives back, a Big Root adding its share.
   *
   * @param {Combatant} combatant
   * @param {number} fraction of maximum HP
   */
  rootHeal(combatant, fraction) {
    const root = heldPassive(combatant.pokemon, 'drainBoost');
    return Math.max(1, Math.floor(combatant.maxHp * fraction * (root?.multiplier ?? 1)));
  }

  /**
   * An Explosion's user going down with it, once the move has played out.
   *
   * @param {Combatant} attacker
   * @param {LogEntry[]} log
   */
  collectSelfKnockout(attacker, log) {
    if (!attacker.marks.spent) return;
    attacker.marks.spent = false;
    const at = attacker.marks.spentAt;
    attacker.marks.spentAt = undefined;
    if (attacker.pokemon.hp <= 0) return;
    const amount = attacker.pokemon.hp;
    attacker.pokemon.hp = 0;
    if (at != null) attacker.downAt = at;
    log.push({ kind: 'damage', side: attacker.side, data: { amount, recoil: true } });
  }

  /**
   * The forme each side should be wearing, if either has changed shape.
   *
   * Called at the moments a forme can flip: on the way in, when the weather
   * moves, at the end of a turn (health checks), after a move that catches
   * something, and after a hit that breaks something. A species with no forme
   * to wear costs this a map lookup and returns, which is the common case.
   *
   * @param {LogEntry[]} log
   */
  evaluateFormes(log) {
    for (const combatant of [this.player, this.foe]) {
      if (!combatant || combatant.pokemon.hp <= 0) continue;
      // Snow freezes a broken Ice Face back over.
      const weather = this.weatherFor(combatant);
      if (combatant.marks.formeBroken && this.abilityOf(combatant)?.refreezes && (weather === WEATHER.SNOW || weather === WEATHER.HAIL)) {
        combatant.marks.formeBroken = false;
      }
      this.applyForme(combatant, this.formeState(combatant), log);
    }
  }

  /**
   * What the shape a combatant wears hangs off, in the one shape every
   * caller passes it: the sky above, the health it is at, whether something
   * about it has been broken, and what it last did.
   *
   * @param {Combatant} combatant
   * @returns {{current: string|null, weather: string|null, weatherTurns: number, overhp: number, maxhp: number, broken: boolean, usedMove: string|null, relicSongs: number, stance: string|null, hangry: boolean, gulp: 'gulping'|'gorging'|null}}
   */
  formeState(combatant) {
    return {
      current: combatant.marks.forme ?? null,
      weather: this.weatherFor(combatant),
      weatherTurns: this.field.weatherTurns,
      overhp: combatant.pokemon.hp,
      maxhp: combatant.maxHp,
      broken: Boolean(combatant.marks.formeBroken),
      usedMove: combatant.lastMove,
      relicSongs: combatant.marks.relicSongs ?? 0,
      stance: combatant.marks.stance ?? null,
      hangry: Boolean(combatant.marks.hangry),
      gulp: combatant.marks.gulp ?? null,
    };
  }

  /**
   * Move a combatant into the forme its condition now calls for.
   *
   * The max hit points a forme brings with it are added on the way in and
   * taken back off on the way out, the way evolution tops a level-up up — a
   * Zen Mode's larger bar should not read as having healed into it. A wanted
   * forme of `null` means back to the species' ordinary shape: the forme's
   * health comes off, and the marks are cleared rather than pointed at a slug
   * the data would then be asked to look up.
   *
   * @param {Combatant} combatant
   * @param {{current?: string|null, weather: string|null, weatherTurns: number, overhp: number, maxhp: number, broken: boolean, usedMove: string|null}} state
   * @param {LogEntry[]} log
   * @returns {boolean} whether the forme moved
   */
  applyForme(combatant, state, log) {
    const current = combatant.marks.forme ?? null;
    // A busted Disguise is a state, not a shape the weather can undo: while
    // the mark is set, the busted forme is the only one on offer, whatever
    // the periodic checks keep asking for.
    if (combatant.marks.formeBroken) {
      const busted = this.bustedFormeOf(combatant.pokemon);
      if (busted) {
        if (current === busted) return false;
        combatant.marks.forme = busted;
        combatant.pokemon.forme = busted;
        return true;
      }
    }
    const found = formeFor(combatant.pokemon, { ...state, current });
    // The species' own slug is its ordinary shape, which the marks write as
    // no forme at all — a Castform walking in under a clear sky has not
    // changed into anything.
    const wanted = found === speciesOf(combatant.pokemon.speciesId)?.slug ? null : found;
    if (wanted === current) return false;

    const before = current ? statsOf(combatant.pokemon, current).hp : maxHp(combatant.pokemon);
    // A mask, an Origin Forme, a Sky Forme is worn on the road as well;
    // walking into a battle already in it is not a change anybody sees.
    const alreadyWorn = Boolean(wanted) && combatant.pokemon.forme === wanted && standingForme(combatant.pokemon) === wanted;
    combatant.marks.forme = wanted;
    // The Pokémon wears the slug too, so every screen that holds one — the
    // health bars, the nameplates, the sprite cache keys — reads the shape it
    // is in straight off it, without knowing what a combatant is.
    combatant.pokemon.forme = wanted;
    const after = wanted ? statsOf(combatant.pokemon, wanted).hp : maxHp(combatant.pokemon);
    combatant.pokemon.hp = Math.max(1, Math.min(after, combatant.pokemon.hp + (after - before)));
    // The forme replaces the species' types, which is where its resistances
    // live; an explicit rewrite would fight the next forme change.
    combatant.marks.types = null;
    if (alreadyWorn) return true;
    log.push({
      kind: 'formChanged',
      side: combatant.side,
      data: { forme: wanted, ability: this.abilitySlugOf(combatant) },
    });
    return true;
  }

  /**
   * What the sky and the ground do to whoever is standing in them.
   *
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  endOfTurnField(combatant, log) {
    const ability = this.abilityOf(combatant);
    const types = this.typesOf(combatant);
    const weather = this.weatherFor(combatant);

    const sheltered =
      ability?.weatherImmune || ability?.indirectImmune || heldShield(combatant.pokemon, 'weather');
    if (!sheltered && weatherBites(weather, types)) {
      const amount = Math.max(1, Math.floor(combatant.maxHp / 16));
      combatant.pokemon.hp = Math.max(0, combatant.pokemon.hp - amount);
      log.push({ kind: 'weatherDamage', side: combatant.side, data: { weather, amount } });
    }

    // Grassy Terrain feeds whatever is standing on it.
    if (this.field.terrain === TERRAIN.GRASSY && this.grounded(combatant)) {
      const max = combatant.maxHp;
      if (combatant.pokemon.hp > 0 && combatant.pokemon.hp < max) {
        const amount = Math.max(1, Math.floor(max / 16));
        combatant.pokemon.hp = Math.min(max, combatant.pokemon.hp + amount);
        log.push({ kind: 'heal', side: combatant.side, data: { amount, terrain: TERRAIN.GRASSY } });
      }
    }
  }

  /**
   * The abilities that act between turns rather than during one.
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  endOfTurnAbility(combatant, log) {
    const other = combatant === this.player ? this.foe : this.player;
    const ability = this.abilityOf(combatant);
    if (!ability?.turn || !other) return;
    ability.turn(this.abilityContext(combatant, other, log));
  }

  /**
   * Count a combatant's battle-long states down and announce what wore off.
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  tickStates(combatant, log) {
    const perishing = hasVolatile(combatant, VOLATILE.PERISH);
    for (const state of tickVolatile(combatant)) {
      // A perish count running out is the one that is not a relief.
      if (state === VOLATILE.PERISH) {
        combatant.pokemon.hp = 0;
        log.push({ kind: 'perished', side: combatant.side });
        continue;
      }
      log.push({ kind: 'volatileEnded', side: combatant.side, data: { state } });
    }
    if (perishing && hasVolatile(combatant, VOLATILE.PERISH)) {
      this.say(combatant, 'move.perishCount', { count: combatant.volatile[VOLATILE.PERISH] });
    }
  }

  /**
   * Count the field's clocks down and announce whatever ran out.
   * @param {LogEntry[]} log
   */
  tickField(log) {
    for (const gone of this.field.tick()) {
      if (FIELD_MESSAGES.has(gone.kind)) {
        log.push({ kind: 'message', side: /** @type {any} */ (gone.side ?? 'player'), data: { key: `move.${gone.kind}.end` } });
        continue;
      }
      log.push({ kind: `${gone.kind}Ended`, side: /** @type {any} */ (gone.side), data: { value: gone.value } });
    }
    this.syncSuppression();
  }

  /** An item first, then priority, then Speed, with a coin flip to break an exact tie. */
  orderOfPlay() {
    if (!this.foe) return [this.player];

    // Nothing was thrown by hand, so the policy gets its say before the turn
    // is planned.
    if (!this.pendingItem && !this.playerSpent) {
      this.pendingItem = this.items?.choose(this.player.pokemon) ?? null;
      this.pendingChoice = {};
    }

    // Both sides commit before either acts, so priority can be compared and
    // the choice cannot change once the turn is under way.
    const playerChoice = this.pendingItem ? null : this.chooseMove(this.player, this.foe);
    const foeChoice = this.chooseMove(this.foe, this.player);
    this.pendingMoves = new Map([
      [this.player, playerChoice],
      [this.foe, foeChoice],
    ]);

    // An item from the bag takes the companion's action, and goes before
    // anybody moves, as it does in the games: a Potion is drunk before the
    // foe's attack lands however fast the foe is, and before any priority
    // move. Still on the next turn rather than the moment the bag closes.
    if (this.pendingItem) return [this.player, this.foe];

    const playerPriority = this.priorityOf(this.player, this.foe, playerChoice);
    const foePriority = this.priorityOf(this.foe, this.player, foeChoice);
    if (playerPriority !== foePriority) {
      return playerPriority > foePriority ? [this.player, this.foe] : [this.foe, this.player];
    }

    // Inside a priority bracket, something can still jump the queue: a Quick
    // Claw, a Quick Draw, or a Custap Berry on its last legs.
    const jumps = (combatant) => {
      const claw = heldPassive(combatant.pokemon, 'first');
      if (claw && this.rng.chance(claw.chance)) return true;
      const custap = heldTrigger(combatant.pokemon);
      if (custap?.held.first) {
        combatant.pokemon.heldItem = null;
        return true;
      }
      const draw = this.abilityOf(combatant)?.movesFirst;
      return Boolean(draw && this.rng.chance(draw));
    };
    // And something can give it up: a Lagging Tail, or a Stall.
    const dawdles = (combatant) =>
      Boolean(heldPassive(combatant.pokemon, 'last')) || Boolean(this.abilityOf(combatant)?.movesLast);

    const playerJumps = jumps(this.player);
    const foeJumps = jumps(this.foe);
    if (playerJumps !== foeJumps) return playerJumps ? [this.player, this.foe] : [this.foe, this.player];

    const playerDawdles = dawdles(this.player);
    const foeDawdles = dawdles(this.foe);
    if (playerDawdles !== foeDawdles) return playerDawdles ? [this.foe, this.player] : [this.player, this.foe];

    const playerSpeed = this.speedOf(this.player);
    const foeSpeed = this.speedOf(this.foe);
    if (playerSpeed === foeSpeed) {
      return this.rng.chance(0.5) ? [this.player, this.foe] : [this.foe, this.player];
    }
    // Inside a Trick Room the slower one goes first. Priority still comes
    // before it: a Quick Attack is quick in any room.
    const playerFirst = this.field.trickRoom > 0 ? playerSpeed < foeSpeed : playerSpeed > foeSpeed;
    return playerFirst ? [this.player, this.foe] : [this.foe, this.player];
  }

  /**
   * A stat as this battle sees it — with the abilities and the weather in,
   * which is the whole reason it is not simply `effectiveStat`.
   *
   * @param {Combatant} combatant
   * @param {string} stat
   * @param {{ignorePositive?: boolean, ignoreNegative?: boolean}} [options]
   */
  stat(combatant, stat, options = {}) {
    return effectiveStat(combatant, stat, { ...options, battle: this });
  }

  /**
   * The Speed the turn order is decided on: doubled by a Tailwind at the
   * combatant's back.
   * @param {Combatant} combatant
   */
  speedOf(combatant) {
    const tailwind = this.field.tailwind?.[combatant.side] > 0 ? 2 : 1;
    return this.stat(combatant, 'spe') * tailwind;
  }

  /**
   * How much the other side's mere presence takes off a stat.
   *
   * The four Ruin abilities each weigh on one stat of everything on the field
   * but their own holder, which is why this is asked of the other side rather
   * than of the Pokémon whose stat it is — and not on another holder of the
   * same one, as the games have it.
   *
   * @param {Combatant} combatant whose stat is being read
   * @param {string} stat
   */
  ruinFactor(combatant, stat) {
    const other = combatant === this.player ? this.foe : this.player;
    const ruin = other ? this.abilityOf(other)?.ruin : null;
    if (ruin?.stat !== stat) return 1;
    return this.abilityOf(combatant)?.ruin?.stat === stat ? 1 : ruin.multiplier;
  }

  /**
   * What a Pokémon counts as right now.
   *
   * Usually its species' types, and the games do not let that change outside
   * a battle — but a Protean rewrites it every time its holder attacks and a
   * Color Change rewrites it every time its holder is hit, so the answer
   * lives on the combatant and the species is only the starting point. An
   * alternate forme carries its own types the same way.
   *
   * @param {Combatant} combatant
   * @returns {string[]}
   */
  typesOf(combatant) {
    const species = speciesOf(combatant.pokemon.speciesId);
    const forme = combatant.marks.forme
      ? (species.forms ?? []).find((form) => form.slug === combatant.marks.forme)
      : null;
    // A Mimicry wears the terrain's type for as long as the terrain lasts.
    const terrainType = MIMICRY_TYPES[this.field.terrain ?? ''];
    if (terrainType && this.abilityOf(combatant)?.mimicry) return [terrainType];
    const types = combatant.marks.types ?? forme?.types ?? species.types;
    // A Trick-or-Treat or a Forest's Curse adds a third type on top.
    const added = combatant.marks.addedType;
    return added && !types.includes(added) ? [...types, added] : types;
  }

  /**
   * Make a Pokémon a different type for the rest of the battle.
   *
   * @param {Combatant} combatant
   * @param {string[]} types
   * @param {LogEntry[]} log
   * @returns {boolean} whether it was anything other than what it already was
   */
  becomeType(combatant, types, log) {
    const before = this.typesOf(combatant);
    if (before.length === types.length && types.every((type, index) => before[index] === type)) return false;
    combatant.marks.types = types;
    log.push({ kind: 'typeChanged', side: combatant.side, data: { types } });
    return true;
  }

  /**
   * A move's priority once the attacker's ability and the ground have had
   * their say.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {string} choice
   */
  priorityOf(attacker, defender, choice) {
    const move = moveOf(choice);
    if (!move) return 0;

    const ability = this.abilityOf(attacker);
    const priority = (move.priority ?? 0) + (ability?.priority?.(this.abilityContext(attacker, defender, []), move) ?? 0);

    // Psychic Terrain refuses to let anything cut in front of a Pokémon
    // standing on it, and so do the abilities that do nothing else.
    if (terrainBlocksPriority(this.field.terrain, priority, this.grounded(defender))) return 0;
    if (priority > 0 && this.abilityOf(defender, attacker)?.blocksPriority) return 0;

    // A Mycelium Might gives up the queue for its status moves in exchange
    // for the other side's ability not counting against them.
    if (move.damageClass === 'status' && ability?.movesLastWithStatus) return -7;
    return priority;
  }

  /**
   * Pick the move a combatant will use this turn.
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @returns {string} a move slug, or `struggle` when nothing has PP
   */
  chooseMove(attacker, defender) {
    // A rampage, a roll or an uproar carries on whatever else is going on.
    const locked = attacker.volatile.locked?.move;
    if (locked && this.movesOf(attacker).some((slot) => slot.move === locked)) return locked;

    let usable = this.movesOf(attacker).filter((slot) => slot.pp > 0 && moveOf(slot.move));
    if (usable.length === 0) return 'struggle';

    const held = heldPassive(attacker.pokemon, 'stat');
    // A Gorilla Tactics locks its holder in as a Choice item would.
    const restriction = this.abilityOf(attacker)?.choiceLock ? { ...held, lock: true } : held;

    // An Encore takes the choice away entirely: the last move, again.
    if (hasVolatile(attacker, VOLATILE.ENCORE)) {
      const encored = usable.find((slot) => slot.move === attacker.volatile.encoreMove);
      if (encored) return encored.move;
    }

    // A Choice item locks its holder into the first move it picks, for as long
    // as that move has PP — which is the price it charges for the power.
    if (restriction?.lock) {
      const locked = usable.find((slot) => slot.move === attacker.lockedMove);
      if (locked) return locked.move;
    }

    // And what has been taken away: the move a Disable named, every status
    // move under a Taunt, and the one it used last under a Torment.
    usable = this.stillAllowed(attacker, usable);
    if (usable.length === 0) return 'struggle';

    // An Assault Vest buys Special Defence with the holder's status moves.
    if (restriction?.noStatus) {
      const attacks = usable.filter((slot) => moveOf(slot.move)?.damageClass !== 'status');
      if (attacks.length > 0) usable = attacks;
    }

    // The player's side follows the policy the user configured; the other
    // side reads the board for itself (see `foeai.mjs`).
    const chosen =
      attacker.side === 'player' && this.policy
        ? choosePolicyMove(this, attacker, defender, usable)
        : (attacker.side === 'foe' ? chooseFoeMove(this, attacker, defender, usable) : null)
          ?? bestDamageMove(this, attacker, defender, usable)
          ?? this.rng.pick(movesWorthUsing(attacker, defender, usable)).move;

    if (restriction?.lock) attacker.lockedMove = chosen;
    return chosen;
  }

  /**
   * The moves still open to a Pokémon that has had some taken away.
   *
   * Everything here narrows the list; nothing widens it, so a Pokémon left
   * with nothing struggles, which is what the games do when a Taunt lands on
   * something that only knows status moves.
   *
   * @param {Combatant} attacker
   * @param {Array<{move: string, pp: number}>} usable
   */
  stillAllowed(attacker, usable) {
    let left = usable;
    const target = this.other(attacker);
    // A Fake Out after the first turn out is a move that fails, so it is not
    // offered once that turn has gone — unless there is nothing else. Nor is
    // anything else whose condition is plainly not met: a Poltergeist at a
    // target holding nothing, a Dream Eater at one awake. Nor a move this
    // target has already been seen to shrug off for a reason it had kept to
    // itself (see `shrugsOff`): a sound at a Soundproof, an Electric move into
    // a Volt Absorb. And nothing the screen already rules out, untried (see
    // `visiblyUseless`): a Toxic at a Steel type, a Spore at a Pokémon already
    // asleep, a Thunder Wave behind a substitute. Nor anything whose whole
    // effect is already in place (see `alreadyInPlace`): a Rain Dance in the
    // rain, a Reflect already up, a third layer of Spikes's fourth.
    const firstTurn = this.firstTurnOut(attacker);
    // And nothing already seen to do nothing to this very target.
    const wasted = attacker.marks.wasted?.target === target ? attacker.marks.wasted.moves : null;
    const working = left.filter((slot) =>
      !(FIRST_TURN_ONLY.has(slot.move) && !firstTurn) && !boundToFail(this, attacker, target, slot.move) &&
      !wasted?.has(slot.move) && !this.visiblyUseless(attacker, target, slot.move) &&
      !this.alreadyInPlace(attacker, target, slot.move));
    if (working.length > 0) left = working;
    if (hasVolatile(attacker, VOLATILE.DISABLE)) {
      left = left.filter((slot) => slot.move !== attacker.volatile.disabledMove);
    }
    if (hasVolatile(attacker, VOLATILE.TAUNT)) {
      const attacks = left.filter((slot) => moveOf(slot.move)?.damageClass !== 'status');
      if (attacks.length > 0) left = attacks;
    }
    // Throat Chop's silence, a Heal Block, the moves an Imprison sealed, the
    // ones Gravity keeps on the ground, and a move that cannot go twice in a
    // row.
    const imprisoner = this.other(attacker);
    const sealed = imprisoner?.volatile.imprison ? new Set(this.movesOf(imprisoner).map((slot) => slot.move)) : null;
    const narrowed = left.filter((slot) => {
      const move = moveOf(slot.move);
      if (attacker.volatile.silenced > 0 && hasFlag(move, 'sound')) return false;
      if (attacker.volatile.healBlock > 0 && hasFlag(move, 'heal')) return false;
      if (sealed?.has(slot.move)) return false;
      if (this.field.gravity > 0 && GRAVITY_BANNED.has(slot.move)) return false;
      if (NO_REPEAT.has(slot.move) && attacker.lastMove === slot.move) return false;
      return true;
    });
    if (narrowed.length > 0) left = narrowed;
    // A Future Sight is not chosen again while one is on its way to the same
    // target, nor straight after the one just used: the second fails.
    if ((target && this.field.futureSight[target.side]) || DELAYED_ATTACKS.has(attacker.lastMove)) {
      const fresh = left.filter((slot) => !DELAYED_ATTACKS.has(slot.move));
      if (fresh.length > 0) left = fresh;
    }
    if (hasVolatile(attacker, VOLATILE.TORMENT)) {
      const others = left.filter((slot) => slot.move !== attacker.lastMove);
      if (others.length > 0) left = others;
    }
    return left;
  }

  /**
   * Whether this is the first turn since the combatant came out.
   * @param {Combatant} combatant
   */
  firstTurnOut(combatant) {
    return this.turn === (combatant.enteredTurn ?? 0) + 1;
  }

  /**
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {LogEntry[]} log
   */
  resolveMove(attacker, defender, log) {
    attacker.turn.moved = true;
    attacker.marks.moldBreaking = false;
    // A Destiny Bond lasts until its user moves again.
    attacker.volatile.destinyBond = 0;

    // The item is thrown by the trainer, so nothing about the Pokémon's own
    // state — asleep, flinching, paralysed — can stop it.
    if (attacker.side === 'player' && this.pendingItem) {
      const slug = this.pendingItem;
      const choice = this.pendingChoice;
      this.pendingItem = null;
      this.pendingChoice = {};
      const used = this.items?.throw(slug, attacker.pokemon, choice) ?? false;
      // A medicine that clears conditions clears the two that never reach the
      // save as well, which is what a player throwing a Full Heal expects.
      if (used && itemOf(slug)?.use?.status === 'any') this.cureVolatile(attacker, log);
      attacker.turnsTaken++;
      log.push({ kind: 'item', side: attacker.side, data: { item: slug, used } });
      return;
    }

    // A Truant works every other turn and loafs the rest, which is the price
    // of whatever it was given in exchange.
    if (this.abilityOf(attacker)?.skipsEveryOther) {
      attacker.marks.loafing = !attacker.marks.loafing;
      if (attacker.marks.loafing) {
        attacker.turnsTaken++;
        log.push({ kind: 'ability', side: attacker.side, data: { ability: this.abilitySlugOf(attacker) } });
        log.push({ kind: 'loafing', side: attacker.side });
        return;
      }
    }

    // A move that has to be paid for costs the turn after it, which is what
    // the recharge classification means.
    if (attacker.mustRecharge) {
      attacker.mustRecharge = false;
      attacker.turnsTaken++;
      log.push({ kind: 'recharge', side: attacker.side });
      return;
    }

    if (attacker.flinched) {
      attacker.flinched = false;
      log.push({ kind: 'flinch', side: attacker.side });
      const steadfast = this.abilityOf(attacker);
      steadfast?.onFlinch?.(this.abilityContext(attacker, defender, log));
      this.breakLock(attacker);
      return;
    }

    const intended = attacker.charging ?? this.pendingMoves?.get(attacker) ?? null;
    // A Pokémon part way through a two-turn move is committed to finishing it,
    // asleep or not — which is why this comes before the condition check.
    if (!attacker.charging && !this.canAct(attacker, log, intended)) {
      this.breakLock(attacker);
      attacker.marks.lastFailed = true;
      return;
    }

    let moveName = attacker.charging ?? this.pendingMoves?.get(attacker) ?? this.chooseMove(attacker, defender);
    let base = moveName === 'struggle' ? STRUGGLE : moveOf(moveName);
    attacker.turnsTaken++;
    // What the auto-battle's "every so many turns" counts from, and its "once
    // for each foe".
    (attacker.usedOn ??= {})[moveName] = attacker.turnsTaken;
    if (attacker.usedAgainst?.target !== defender) attacker.usedAgainst = { target: defender, moves: new Set() };
    attacker.usedAgainst.moves.add(moveName);

    if (!base) {
      log.push({ kind: 'move', side: attacker.side, data: { move: moveName } });
      return;
    }

    // A Focus Punch that was hit while it tightened loses its nerve.
    if (moveName === 'focus-punch' && attacker.turn.damage > 0) {
      this.say(attacker, 'move.focusPunch.lost');
      attacker.marks.lastFailed = true;
      return;
    }

    // A move that keeps going — an Outrage, a Rollout, a Bide — only costs
    // PP on the turn it starts.
    const continuing = Boolean(attacker.volatile.locked?.started && attacker.volatile.locked.move === moveName && attacker.volatile.locked.paid);
    if (attacker.volatile.locked?.move === moveName) attacker.volatile.locked.paid = true;

    // The charge turn: everything but the move itself, and then the wait.
    if (hasFlag(base, 'charge') && !attacker.charging && !this.skipsCharge(attacker, moveName, log)) {
      const slot = this.movesOf(attacker).find((entry) => entry.move === moveName);
      if (slot) slot.pp = Math.max(0, slot.pp - 1);
      attacker.charging = moveName;
      const charge = CHARGE_TURNS[moveName];
      // Off into the sky, under the ground or the water, or out of sight: the
      // line that says so carries where, so the screen can take the sprite
      // away with it.
      const hides = SEMI_INVULNERABLE[moveName] ?? null;
      if (charge) this.say(attacker, charge.key, hides ? { hide: hides } : {});
      else log.push({ kind: 'charging', side: attacker.side, data: { move: moveName } });
      if (charge?.stat) this.applyStage(attacker, charge.stat, 1, log, { source: 'self' });
      if (hides) attacker.marks.hidden = hides;
      // A Power Herb that was not needed yet is spent on the far side of it.
      if (!charge?.stat || !this.skipsChargeAfterBoost(attacker, moveName, log)) return;
    }
    // Back from wherever the charge turn took it, as the move comes down.
    const reappears = Boolean(attacker.marks.hidden);
    attacker.marks.hidden = null;

    // PP was already spent on the charge turn.
    if (!attacker.charging && !continuing) {
      const slot = this.movesOf(attacker).find((entry) => entry.move === moveName);
      if (slot) slot.pp = Math.max(0, slot.pp - 1);
    }
    attacker.charging = null;

    // A move some evolution counts is counted on the Pokémon, for good.
    const counted = speciesOf(attacker.pokemon.speciesId)?.evolutions?.some((evolution) => evolution.usedMove === moveName);
    if (counted) {
      attacker.pokemon.moveUses ??= {};
      attacker.pokemon.moveUses[moveName] = (attacker.pokemon.moveUses[moveName] ?? 0) + 1;
    }

    // A Metronome pays for repeating the same move, so the count is kept even
    // when nothing is holding one.
    attacker.repeats = attacker.lastMove === moveName ? attacker.repeats + 1 : 0;
    attacker.lastMove = moveName;
    // A guard only gets harder to put up while it keeps going up.
    if (!PROTECT_MOVES[moveName] && moveName !== 'endure') attacker.volatile.protectStreak = 0;

    let move = this.effectiveMove(attacker, defender, base, moveName);

    // A Protean becomes whatever it is about to use.
    if (this.abilityOf(attacker)?.retypes === 'move') {
      if (this.becomeType(attacker, [move.type], log)) {
        log.splice(log.length - 1, 0, { kind: 'ability', side: attacker.side, data: { ability: this.abilitySlugOf(attacker) } });
      }
    }

    // A Pressure on the other side charges a second point for being aimed at.
    if (this.abilityOf(defender)?.pressures && !continuing) {
      const slot = this.movesOf(attacker).find((entry) => entry.move === moveName);
      if (slot) slot.pp = Math.max(0, slot.pp - 1);
    }

    // An Aegislash draws its blade to strike and raises its shield to guard,
    // before the move is announced — "Changed to Blade Forme!", then the
    // move — as the games show it. A move another calls takes its stance in
    // turn, before it is announced in its own right.
    const takeStance = (/** @type {any} */ used, /** @type {string} */ usedName) => {
      if (!this.abilityOf(attacker)?.stanceChange) return;
      const stance = used.damageClass !== 'status' ? 'blade' : usedName === 'kings-shield' ? 'shield' : null;
      if (!stance || (attacker.marks.stance ?? 'shield') === stance) return;
      attacker.marks.stance = stance;
      const before = log.length;
      if (this.applyForme(attacker, this.formeState(attacker), log)) {
        log.splice(before, 0, { kind: 'ability', side: attacker.side, data: { ability: this.abilitySlugOf(attacker) } });
      }
    };
    takeStance(move, moveName);

    log.push({ kind: 'move', side: attacker.side, data: reappears ? { move: moveName, reveal: true } : { move: moveName } });
    if (attacker.side === 'player') this.seenMoves.add(moveName);
    const moveLogStart = log.length;

    // A move that calls another uses that one in its place: a Metronome, a
    // Sleep Talk, a Nature Power.
    const called = calledMove(this, attacker, defender, moveName);
    if (called === null) {
      log.push({ kind: 'failed', side: attacker.side });
      this.afterMove(attacker, defender, moveName, moveLogStart, log);
      return;
    }
    if (called) {
      if (moveName === 'nature-power') this.say(attacker, 'move.naturePower', { move: called });
      const caller = moveName;
      moveName = called;
      base = moveOf(called);
      if (!base) return;
      move = this.effectiveMove(attacker, defender, base, called);
      // A Me First hits half again as hard as the move it took.
      if (caller === 'me-first' && move.power) move = { ...move, power: Math.floor(move.power * 1.5) };
      takeStance(move, called);
      log.push({ kind: 'move', side: attacker.side, data: { move: called } });
    }
    this.lastMoveUsed = moveName;
    // A Sunsteel Strike or a Photon Geyser ignores the ability in its way.
    attacker.marks.moldBreaking = Boolean(move.rules?.ignoreAbility);

    // A Snatch lying in wait takes a move that would have helped its user,
    // and uses it for itself.
    const snatcher = this.other(attacker);
    if (move.rules?.snatchable && snatcher && snatcher.pokemon.hp > 0 && snatcher.volatile.snatch === this.turn) {
      snatcher.volatile.snatch = -1;
      this.say(snatcher, 'move.snatch.stole');
      this.applyStatusMove(snatcher, attacker, move, log);
      this.afterMove(attacker, defender, moveName, log.length, log);
      return;
    }

    // A Fire move under Powder blows up in its user's face.
    if (attacker.volatile.powder === this.turn && move.type === 'fire') {
      log.push({ kind: 'message', side: attacker.side, data: { key: 'move.powder.exploded', move: moveName } });
      if (!this.abilityOf(attacker)?.indirectImmune) this.loseHp(attacker, Math.floor(attacker.maxHp / 4), log);
      attacker.marks.lastFailed = true;
      this.afterMove(attacker, defender, moveName, log.length, log);
      return;
    }

    // A Cramorant comes up from a Surf or a Dive with something in its
    // mouth: an Arrokuda while it is above half, a Pikachu below.
    if (this.abilityOf(attacker)?.gulpMissile && (moveName === 'surf' || moveName === 'dive') && !attacker.marks.gulp) {
      attacker.marks.gulp = attacker.pokemon.hp * 2 > attacker.maxHp ? 'gulping' : 'gorging';
    }

    // Used after the first turn out, a Fake Out is only a lunge: the PP is
    // gone and nothing happens. And a move that needs a partner, or a
    // condition that is not there, fails the same way.
    if (
      (FIRST_TURN_ONLY.has(moveName) && !this.firstTurnOut(attacker)) ||
      PARTNER_ONLY.has(moveName) ||
      base.allyOnly ||
      failsBeforeUse(this, attacker, defender, move, moveName)
    ) {
      log.push({ kind: 'failed', side: attacker.side });
      this.breakLock(attacker);
      this.afterMove(attacker, defender, moveName, moveLogStart, log);
      return;
    }

    if (SELF_KNOCKOUT.has(moveName) || move.rules?.selfdestruct === 'always') {
      // A Damp keeps the thing from going off at all.
      if (moveName !== 'memento' && this.abilityOf(defender, attacker)?.dampens) {
        log.push({ kind: 'ability', side: defender.side, data: { ability: this.abilitySlugOf(defender) } });
        log.push({ kind: 'failed', side: attacker.side });
        return;
      }
      // Paid however the rest of the move goes: `takeTurn` collects it once
      // the move is over, whichever way out of here it took.
      attacker.marks.spent = true;
      // But an Explosion's user is down before the blast lands, as the games
      // from Black and White on have it, and a knock-out on both sides goes
      // against it. A Memento's goes down after, having done what it does.
      if (moveName !== 'memento') attacker.marks.spentAt = ++this.faintClock;
    }

    // A Future Sight is not a hit now; it is one two turns from now.
    if (moveName === 'future-sight' || moveName === 'doom-desire') {
      if (this.field.futureSight[defender.side]) {
        log.push({ kind: 'failed', side: attacker.side });
      } else {
        this.field.futureSight[defender.side] = { turns: 3, from: attacker, move: moveName };
        this.say(attacker, moveName === 'future-sight' ? 'move.futureSight' : 'move.doomDesire');
      }
      this.afterMove(attacker, defender, moveName, moveLogStart, log);
      return;
    }

    // A Bide takes two turns of hits and gives them back doubled.
    if (moveName === 'bide') {
      if (!this.resolveBide(attacker, defender, move, log)) {
        this.afterMove(attacker, defender, moveName, moveLogStart, log);
        return;
      }
    }

    // A move the defender is simply sealed against — a sound at a Soundproof,
    // a bullet at a Bulletproof, a powder at a Grass type or a pair of Safety
    // Goggles, a Thunder Wave at a Ground type — never gets as far as an
    // accuracy roll.
    const prevented = this.preventedBy(attacker, defender, move);
    if (prevented) {
      log.push({ kind: 'noEffect', side: defender.side, data: { cause: prevented } });
      this.crash(attacker, move, log);
      this.breakLock(attacker);
      this.afterMove(attacker, defender, moveName, moveLogStart, log);
      return;
    }

    // Something between the two of them.
    if (this.blockedByGuard(attacker, defender, move, moveName, log)) {
      this.crash(attacker, move, log);
      this.breakLock(attacker);
      this.afterMove(attacker, defender, moveName, moveLogStart, log);
      return;
    }

    // A Magic Bounce or a Magic Coat sends a status move back where it came
    // from.
    if (move.damageClass === 'status' && aimsAtTarget(move) && !move.bounced) {
      const bouncer = this.abilityOf(defender, attacker)?.bouncesStatus;
      if (bouncer || defender.volatile.magicCoat === this.turn) {
        if (bouncer) log.push({ kind: 'ability', side: defender.side, data: { ability: this.abilitySlugOf(defender) } });
        log.push({ kind: 'bounced', side: defender.side });
        this.applyStatusMove(defender, attacker, { ...move, bounced: true }, log);
        this.afterMove(attacker, defender, moveName, moveLogStart, log);
        return;
      }
    }

    // A substitute takes whatever status move was aimed at the Pokémon behind
    // it — unless it is a sound, which goes through a doll.
    if (
      move.damageClass === 'status' &&
      aimsAtTarget(move) &&
      defender.volatile.substitute > 0 &&
      !hasFlag(move, 'sound') &&
      !this.abilityOf(attacker)?.infiltrates &&
      !SUBSTITUTE_BYPASS.has(moveName)
    ) {
      log.push({ kind: 'failed', side: attacker.side });
      this.afterMove(attacker, defender, moveName, moveLogStart, log);
      return;
    }

    // A Fling and a Natural Gift spend the item as they are used, whether or
    // not they then land; the power and type were read off it already.
    if ((moveName === 'fling' || moveName === 'natural-gift') && attacker.pokemon.heldItem) {
      attacker.turn.flung = attacker.pokemon.heldItem;
      if (moveName === 'fling') this.say(attacker, 'move.fling', { item: attacker.pokemon.heldItem });
      this.consumeItem(attacker);
      this.settleHeldFormes(log);
    }

    // Off the field for the turn: in the sky, underground, underwater or
    // simply gone. Only the moves that go looking reach it.
    const hidden = defender.marks.hidden;
    const neverMisses = this.abilityOf(attacker)?.neverMisses || this.abilityOf(defender, attacker)?.neverMisses;
    if (hidden && aimsAtTarget(move) && reachesHidden(hidden, moveName) === null && !neverMisses) {
      log.push({ kind: 'miss', side: attacker.side });
      this.crash(attacker, move, log);
      this.breakLock(attacker);
      this.afterMiss(attacker, log);
      this.afterMove(attacker, defender, moveName, moveLogStart, log);
      return;
    }

    if (!this.rollAccuracy(attacker, defender, move)) {
      log.push({ kind: 'miss', side: attacker.side });
      this.crash(attacker, move, log);
      this.breakLock(attacker);
      this.afterMiss(attacker, log);
      this.afterMove(attacker, defender, moveName, moveLogStart, log);
      return;
    }

    // A move that thaws its user does so whether or not it was meant to.
    if (attacker.pokemon.status === STATUS.FREEZE && hasFlag(move, 'defrost')) {
      attacker.pokemon.status = null;
      log.push({ kind: 'status', side: attacker.side, data: { status: null, thawed: true } });
    }

    // A Fickle Beam's other heads join in three times in ten.
    if (moveName === 'fickle-beam' && this.rng.chance(0.3)) {
      move = { ...move, power: (move.power ?? 0) * 2 };
      this.say(attacker, 'move.fickleBeam');
    }

    // A Transform becomes the target outright.
    if (moveOf('transform')?.id === move.id) {
      if (!this.transformInto(attacker, defender, log)) log.push({ kind: 'failed', side: attacker.side });
    } else if (move.damageClass === 'status') {
      this.applyStatusMove(attacker, defender, move, log);
    } else {
      this.applyDamagingMove(attacker, defender, move, log);
    }

    // A quarter of the user's health, whatever the move did — which is the
    // only thing that brings a fight between two empty Pokémon to an end.
    if (moveName === 'struggle' && attacker.pokemon.hp > 0) {
      const recoil = Math.max(1, Math.floor(attacker.maxHp * STRUGGLE_RECOIL));
      attacker.pokemon.hp = Math.max(0, attacker.pokemon.hp - recoil);
      log.push({ kind: 'damage', side: attacker.side, data: { amount: recoil, recoil: true } });
    }

    this.afterUse(attacker, defender, move, log);

    // A Relic Song that went off turns a Meloetta, and the next one turns it
    // back.
    const landed = log.slice(moveLogStart).some((entry) => entry.kind === 'damage' && entry.side === defender.side);
    if (moveName === 'relic-song' && landed) {
      attacker.marks.relicSongs = (attacker.marks.relicSongs ?? 0) + 1;
    }

    // Whatever a move caught in its mouth, or a shape its health had just
    // crossed into, is a shape change worth showing as it happens rather than
    // waiting for the turn to end. The turn-end check still runs, so this is
    // an early word on things that have already changed and no word at all on
    // things that have not.
    this.evaluateFormes(log);

    // A move that has to be recharged says so now, so the next turn can be
    // spent paying for it.
    if (hasFlag(move, 'recharge') && attacker.pokemon.hp > 0) attacker.mustRecharge = true;
    this.afterMove(attacker, defender, moveName, moveLogStart, log);
  }

  /**
   * What the auto-battle's miss conditions read off a move just used: whether
   * it missed — an accuracy roll lost, or a foe out of reach in the sky or
   * underground — and so is still owed a hit, and whether it landed on the
   * foe in front of it. A move that was blocked or did nothing has not
   * landed, but has not missed either.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {string} moveName
   * @param {LogEntry[]} lines this move's lines of the log
   */
  noteLanding(attacker, defender, moveName, lines) {
    const missed = lines.some((entry) => entry.kind === 'miss' && entry.side === attacker.side);
    const missedOn = (attacker.missedOn ??= {});
    if (missed) {
      missedOn[moveName] = attacker.turnsTaken;
      attacker.lastMissTurn = attacker.turnsTaken;
    } else {
      delete missedOn[moveName];
    }
    if (attacker.marks.lastFailed) return;
    if (attacker.landed?.target !== defender) attacker.landed = { target: defender, moves: new Set() };
    attacker.landed.moves.add(moveName);
  }

  /**
   * What is left once a move has gone, however it went: the half of its
   * health a Mind Blown costs, the lock an Outrage keeps, whether it failed
   * (which a Stomping Tantrum remembers), and the count an Echoed Voice
   * keeps.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {string} moveName
   * @param {number} from where this move's lines start in the log
   * @param {LogEntry[]} log
   */
  afterMove(attacker, defender, moveName, from, log) {
    attacker.marks.moldBreaking = false;
    const lines = log.slice(from);
    attacker.marks.lastFailed = lines.some(
      (entry) =>
        entry.kind === 'failed' || entry.kind === 'miss' || entry.kind === 'noEffect' || entry.kind === 'protected' ||
        (entry.kind === 'effectiveness' && entry.data?.effectiveness === 0),
    );
    this.noteLanding(attacker, defender, moveName, lines);
    const move = moveOf(moveName);
    if (move && this.shrugsOff(attacker, defender, move, lines)) {
      // Seen to do nothing to this one, for a reason that will not change
      // while it stands there: not chosen against it again.
      if (attacker.marks.wasted?.target !== defender) attacker.marks.wasted = { target: defender, moves: new Set() };
      attacker.marks.wasted.moves.add(moveName);
    }

    // Half the user's health, hit or miss.
    if ((move?.rules?.mindBlownRecoil || moveName === 'chloroblast') && attacker.pokemon.hp > 0 && !attacker.marks.spent) {
      if (!this.abilityOf(attacker)?.indirectImmune) this.loseHp(attacker, Math.ceil(attacker.maxHp / 2), log, { recoil: true });
    }

    if (moveName === 'echoed-voice' && !attacker.marks.lastFailed) {
      this.field.echoes = Math.min(4, this.field.echoes + 1);
      this.field.echoedThisTurn = true;
    }

    // Rolling on for five turns, and a stampede for two or three.
    if ((moveName === 'rollout' || moveName === 'ice-ball') && !attacker.marks.lastFailed) {
      const rolling = attacker.volatile.rollout ?? { count: 0 };
      rolling.count += 1;
      if (rolling.count >= 5) {
        this.breakLock(attacker);
      } else {
        this.lockInto(attacker, moveName);
        attacker.volatile.rollout = rolling;
      }
    }
    if (move?.rules?.selfVolatile === 'lockedmove' && !attacker.marks.lastFailed) {
      const locked = attacker.volatile.locked;
      if (!locked || locked.move !== moveName) {
        attacker.volatile.locked = { move: moveName, turns: this.rng.int(2, 3) - 1, started: true, paid: true };
      } else if (--locked.turns <= 0) {
        this.breakLock(attacker);
        if (attacker.pokemon.hp > 0) {
          // One line for it, not two: "exhausted and confused" stands in for
          // the ordinary "became confused" rather than playing before it.
          this.confuse(attacker, log, { fatigue: true });
        }
      }
    }
    // A Dancer dances along to any dance the other side finishes.
    const dancer = this.other(attacker);
    if (
      hasFlag(move, 'dance') && !attacker.marks.lastFailed && !this.dancing && dancer && dancer.pokemon.hp > 0 &&
      this.running && this.abilityOf(dancer)?.dancer
    ) {
      this.dancing = true;
      log.push({ kind: 'ability', side: dancer.side, data: { ability: this.abilitySlugOf(dancer) } });
      this.danceAlong(dancer, attacker, moveName, log);
      this.dancing = false;
    }
    if (move?.rules?.selfVolatile === 'uproar' && !attacker.volatile.uproar && !attacker.marks.lastFailed) {
      attacker.volatile.uproar = 3;
      attacker.volatile.locked = { move: moveName, started: true, paid: true };
      this.say(attacker, 'move.uproar.start');
      for (const combatant of [this.player, this.foe]) {
        if (combatant?.pokemon.status === STATUS.SLEEP) {
          combatant.pokemon.status = null;
          this.say(combatant, 'move.uproar.woke');
        }
      }
    }
  }

  /**
   * A Dancer's copy of a dance: the move itself, at once, with no PP spent
   * and no lock into it.
   *
   * @param {Combatant} dancer
   * @param {Combatant} target
   * @param {string} moveName
   * @param {LogEntry[]} log
   */
  danceAlong(dancer, target, moveName, log) {
    const base = moveOf(moveName);
    if (!base) return;
    const move = this.effectiveMove(dancer, target, base, moveName);
    log.push({ kind: 'move', side: dancer.side, data: { move: moveName } });
    if (move.damageClass === 'status') {
      this.applyStatusMove(dancer, target, move, log);
    } else if (this.rollAccuracy(dancer, target, move)) {
      this.applyDamagingMove(dancer, target, move, log);
    } else {
      log.push({ kind: 'miss', side: dancer.side });
    }
  }

  /**
   * Keep a combatant on one move for the turns to come: a Rollout's roll,
   * an Outrage's rampage.
   *
   * @param {Combatant} combatant
   * @param {string} move
   */
  lockInto(combatant, move) {
    combatant.volatile.locked = { ...(combatant.volatile.locked ?? {}), move, started: true, paid: true };
  }

  /**
   * Let go of whatever a combatant was locked into — which a miss, a
   * flinch, or a turn it could not move does to a Rollout or an Outrage.
   *
   * @param {Combatant} combatant
   */
  breakLock(combatant) {
    if (!combatant.volatile.locked && !combatant.volatile.rollout) return;
    if (combatant.volatile.uproar > 0) return;
    combatant.volatile.locked = null;
    combatant.volatile.rollout = null;
  }

  /**
   * A Bide's turns: storing on the first two, and paying back double the
   * damage taken on the third.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   * @param {LogEntry[]} log
   * @returns {boolean} whether this is the turn it hits
   */
  resolveBide(attacker, defender, move, log) {
    const bide = attacker.volatile.bide;
    if (!bide) {
      attacker.volatile.bide = { turns: 2, damage: 0 };
      this.lockInto(attacker, 'bide');
      this.say(attacker, 'move.bide.store');
      return false;
    }
    if (--bide.turns > 0) {
      this.say(attacker, 'move.bide.store');
      return false;
    }
    this.say(attacker, 'move.bide.unleash');
    this.breakLock(attacker);
    const damage = bide.damage * 2;
    attacker.volatile.bide = null;
    if (!damage) {
      log.push({ kind: 'failed', side: attacker.side });
      return false;
    }
    defender.pokemon.hp = Math.max(0, defender.pokemon.hp - damage);
    log.push({ kind: 'damage', side: defender.side, data: { amount: damage } });
    return false;
  }

  /**
   * A High Jump Kick that did not land lands its user on the floor.
   *
   * @param {Combatant} attacker
   * @param {any} move
   * @param {LogEntry[]} log
   */
  crash(attacker, move, log) {
    if (!move?.rules?.hasCrashDamage || attacker.pokemon.hp <= 0 || this.abilityOf(attacker)?.indirectImmune) return;
    this.say(attacker, 'move.crash');
    this.loseHp(attacker, Math.floor(attacker.maxHp / 2), log, { recoil: true });
  }

  /**
   * Whether a two-turn move whose charge turn raises a stat goes off at once
   * after the boost, with a Power Herb in hand or rain for an Electro Shot.
   *
   * @param {Combatant} attacker
   * @param {string} moveName
   * @param {LogEntry[]} log
   */
  skipsChargeAfterBoost(attacker, moveName, log) {
    if (moveName === 'electro-shot' && this.weatherFor(attacker) === WEATHER.RAIN) return true;
    const herb = heldPassive(attacker.pokemon, 'charge');
    if (!herb) return false;
    log.push({ kind: 'berry', side: attacker.side, data: { item: attacker.pokemon.heldItem } });
    attacker.marks.consumed = attacker.pokemon.heldItem;
    attacker.pokemon.heldItem = null;
    return true;
  }

  /**
   * Whether a two-turn move goes off at once.
   *
   * A Power Herb buys the charge turn outright, and a Solar Beam does not need
   * one in sunshine.
   *
   * @param {Combatant} attacker
   * @param {string} moveName
   * @param {LogEntry[]} log
   */
  skipsCharge(attacker, moveName, log) {
    if (SUN_CHARGED.has(moveName) && this.weatherFor(attacker) === WEATHER.SUN) return true;
    // A Meteor Beam takes its boost before it decides whether to wait.
    if (chargeOwnsStats(moveName)) return false;

    const herb = heldPassive(attacker.pokemon, 'charge');
    if (!herb) return false;
    log.push({ kind: 'berry', side: attacker.side, data: { item: attacker.pokemon.heldItem } });
    attacker.pokemon.heldItem = null;
    return true;
  }

  /**
   * The move as it actually leaves, once the attacker's ability has had a say
   * in what type it is.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   * @param {string} [slug]
   * @param {{peek?: boolean}} [options] `peek` looks without deciding
   *   anything the use would: a Present is not opened
   */
  effectiveMove(attacker, defender, move, slug = this.slugOf(move), { peek = false } = {}) {
    move = { ...move, slug };
    // A Crowned Zacian's Iron Head is a Behemoth Blade, a Crowned
    // Zamazenta's a Behemoth Bash.
    const crowned = CROWNED_MOVES[attacker.marks.forme ?? '']?.[slug];
    if (crowned && moveOf(crowned)) move = { ...moveOf(crowned), slug: crowned };
    // A signature move is whatever type the item behind it says: an Ivy
    // Cudgel the mask, a Judgment the plate, a Multi-Attack the memory, a
    // Techno Blast the drive.
    const signature = SIGNATURE_MOVES.get(speciesOf(attacker.pokemon.speciesId)?.slug ?? '');
    if (signature && moveOf(signature)?.id === move.id) {
      const type = signatureType(attacker.pokemon, signature);
      if (type && type !== move.type) move = { ...move, type };
    }
    // A move whose power is a matter of weight.
    const weighed = weightPower(move, this.weightOf(attacker), this.weightOf(defender));
    if (weighed !== null) move = { ...move, power: weighed };
    // A hungry Morpeko's Aura Wheel is Dark.
    if (attacker.marks.forme === 'morpeko-hangry' && moveOf('aura-wheel')?.id === move.id) {
      move = { ...move, type: 'dark' };
    }
    // A Photon Geyser strikes from whichever attacking stat is higher.
    if (moveOf('photon-geyser')?.id === move.id) {
      move = { ...move, damageClass: this.stat(attacker, 'atk') > this.stat(attacker, 'spa') ? 'physical' : 'special' };
    }
    // A Weather Ball, a Terrain Pulse, a Natural Gift: the type the field or
    // the berry gives it.
    const fieldType = variableType(this, attacker, move);
    if (fieldType) move = { ...move, type: fieldType };
    // An Ion Deluge charges every Normal move for the rest of the turn.
    if (this.field.ionDeluge === this.turn && move.type === 'normal') move = { ...move, type: 'electric' };
    // A Present decides what it is when it is opened.
    if (move.slug === 'present' && !peek) {
      const roll = this.rng.next();
      attacker.marks.present = roll < 0.4 ? 40 : roll < 0.7 ? 80 : roll < 0.8 ? 120 : 0;
    }
    // Everything whose power is worked out on the spot.
    const power = variablePower(this, attacker, defender, move);
    if (power !== null) move = { ...move, power };

    const ability = this.abilityOf(attacker);
    let retyped = ability?.moveType?.(this.abilityContext(attacker, defender, []), move);
    // An Electrify turns whatever its target uses into electricity.
    if (attacker.volatile.electrified === this.turn) retyped = 'electric';
    if (!retyped || retyped === move.type) return move;
    return { ...move, type: retyped, retyped: true };
  }

  /**
   * Whether the move never reaches the defender at all.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   */
  movePrevented(attacker, defender, move) {
    return this.preventedBy(attacker, defender, move) !== null;
  }

  /**
   * What, if anything, seals the defender against a move — and whether it is
   * something on the screen (`seen`: a type, the terrain, a Magnet Rise, an
   * Air Balloon its holder came out announcing, the attacker's own Prankster) or something the defender is keeping to itself
   * (`item`, `ability`). The automatic battler never reaches for a move the
   * screen already rules out, and only learns the hidden ones by trying.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   * @returns {'seen'|'item'|'ability'|null}
   */
  preventedBy(attacker, defender, move) {
    // A Dark type sees through a status move a Prankster hurried.
    if (
      move.damageClass === 'status' &&
      aimsAtTarget(move) &&
      attacker.side !== defender.side &&
      this.abilityOf(attacker)?.prankster &&
      this.typesOf(defender).includes('dark')
    ) {
      return 'seen';
    }
    // Psychic Terrain refuses a move that would cut the queue.
    if (terrainBlocksPriority(this.field.terrain, move.priority ?? 0, this.grounded(defender))) return 'seen';

    // Powder does nothing to a Grass type, which is the one classification the
    // games gate on a type rather than on an ability.
    if (hasFlag(move, 'powder') && this.typesOf(defender).includes('grass')) return 'seen';

    // Status moves ignore the type chart, all but Thunder Wave: electricity
    // still has to reach its target, and a Ground type is out of its way.
    if (TYPE_CHECKED_STATUS.has(this.slugOf(move)) && typeEffectiveness(move.type, this.typesOf(defender)) === 0) {
      return 'seen';
    }

    // A Ground move does not reach something off the ground — an Air
    // Balloon, a Magnet Rise — however its types read. A Levitate says so in
    // its own name, further on.
    if (
      move.type === 'ground' &&
      move.damageClass !== 'status' &&
      this.slugOf(move) !== 'thousand-arrows' &&
      !this.grounded(defender) &&
      !this.typesOf(defender).includes('flying') &&
      !this.abilityOf(defender, attacker)?.floats
    ) {
      // An Air Balloon announced itself on the way in, so it is in plain
      // view like a Magnet Rise.
      return 'seen';
    }

    const shield = heldShield(defender.pokemon, 'flags');
    if (shield && move.flags?.some((flag) => shield.includes(flag))) return 'item';

    return this.abilityOf(defender, attacker)?.blockMove?.(this.abilityContext(defender, attacker, []), move) ? 'ability' : null;
  }

  /**
   * Whether the screen alone says a move would do nothing to this target —
   * no need to try it to know. Its types, the condition it already has, a
   * substitute, a Safeguard, the terrain: all of it in plain view, as it is
   * to a player choosing a move. What only a try reveals — an ability, a held
   * item — is `shrugsOff`'s.
   *
   * @param {Combatant} attacker
   * @param {Combatant|null} defender
   * @param {string} slug
   */
  visiblyUseless(attacker, defender, slug) {
    const move = moveOf(slug);
    if (!move || !defender || defender === attacker || !aimsAtTarget(move)) return false;
    const types = this.typesOf(defender);
    if (this.preventedBy(attacker, defender, move) === 'seen') return true;

    // An attack its type cannot touch, as the attacker's own ability types
    // it — a Pixilate Hyper Voice is Fairy — unless the attacker's own Scrappy
    // reaches a Ghost with it.
    if (move.damageClass !== 'status') {
      const type = this.effectiveMove(attacker, defender, move, slug).type;
      if (!type || typeEffectiveness(type, types) !== 0) return false;
      const ghostOnly = types.includes('ghost') && typeEffectiveness(type, types.filter((entry) => entry !== 'ghost')) !== 0;
      return !(ghostOnly && this.abilityOf(attacker)?.hitsGhosts && (type === 'normal' || type === 'fighting'));
    }

    // A move that is only a condition, at a target that cannot take it.
    const ailment = move.meta?.ailment ?? 'none';
    const status = AILMENT_TO_STATUS[ailment];
    if ((status || ailment === 'confusion') && categoryOf(move) === 'status') {
      const sealed = this.field.sides[defender.side].safeguard > 0 && !this.abilityOf(attacker)?.infiltrates;
      const doll = defender.volatile.substitute > 0 && !hasFlag(move, 'sound') && !this.abilityOf(attacker)?.infiltrates;
      if (sealed || doll) return true;
      if (ailment === 'confusion') return hasVolatile(defender, VOLATILE.CONFUSION) || (this.field.terrain === TERRAIN.MISTY && this.grounded(defender));
      if (defender.pokemon.status) return true;
      if (terrainBlocksStatus(this.field.terrain, status) && this.grounded(defender)) return true;
      const corrodes = status === STATUS.POISON && this.abilityOf(attacker)?.corrodes;
      return !corrodes && Boolean(IMMUNE_TYPES[status]?.some((type) => types.includes(type)));
    }
    if (slug === 'leech-seed') return Boolean(defender.volatile.leechSeed) || types.includes('grass');
    return false;
  }

  /**
   * Whether a status move would do nothing because what it puts in place is
   * already there: the weather, the terrain, a screen or a Tailwind already
   * up, a hazard laid as deep as it goes, a Substitute standing, a Taunt
   * already on the target. Each is the very check the move's own effect makes
   * before it fails, read ahead of choosing it, so a policy that calls for it
   * on a condition passes it over for the next move rather than spending the
   * turn on "But it failed!".
   *
   * A Trick Room and the other rooms count as in place too: called again
   * while one stands, they take it down, which is undoing the move's own
   * work rather than doing any.
   *
   * @param {Combatant} attacker
   * @param {Combatant|null} defender
   * @param {string} slug
   */
  alreadyInPlace(attacker, defender, slug) {
    const move = moveOf(slug);
    if (!move || move.damageClass !== 'status') return false;
    const field = this.field;
    const mine = attacker.volatile;

    const set = FIELD_MOVES[slug];
    if (set) {
      if (set.weather) return field.weather === set.weather;
      if (set.terrain) return field.terrain === set.terrain;
      if (set.screen) {
        const kinds = set.screen === 'both' ? ['physical', 'special'] : [set.screen];
        return kinds.every((kind) => field.screens[attacker.side][kind] > 0);
      }
      if (set.room) return field.trickRoom > 0;
      if (set.tailwind) return field.tailwind[attacker.side] > 0;
      if (set.hazard) {
        return Boolean(defender) && (field.hazards[defender.side][set.hazard] ?? 0) >= (HAZARD_LAYERS[set.hazard] ?? 1);
      }
    }

    switch (slug) {
      // The side's own clocks, and the field's.
      case 'mist':
        return field.sides[attacker.side].mist > 0;
      case 'safeguard':
        return field.sides[attacker.side].safeguard > 0;
      case 'lucky-chant':
        return field.sides[attacker.side].luckyChant > 0;
      case 'gravity':
        return field.gravity > 0;
      case 'wonder-room':
        return field.wonderRoom > 0;
      case 'magic-room':
        return field.magicRoom > 0;
      case 'water-sport':
        return field.waterSport > 0;
      case 'mud-sport':
        return field.mudSport > 0;
      case 'wish':
        return Boolean(field.wish[attacker.side]);
      // What the user does to itself.
      case 'substitute':
        return mine.substitute > 0 || attacker.pokemon.hp <= Math.floor(attacker.maxHp / 4);
      case 'aqua-ring':
        return Boolean(mine.aquaRing);
      case 'ingrain':
        return Boolean(mine.ingrain);
      case 'focus-energy':
        return Boolean(mine.focusEnergy);
      case 'magnet-rise':
        return mine.magnetRise > 0 || field.gravity > 0;
      case 'stockpile':
        return (mine.stockpile ?? 0) >= 3;
      case 'no-retreat':
        return Boolean(mine.noRetreat);
      case 'belly-drum':
        return attacker.pokemon.hp <= Math.floor(attacker.maxHp / 2) || attacker.stages.atk >= 6;
      case 'rest':
        return attacker.pokemon.hp >= attacker.maxHp || attacker.pokemon.status === 'slp';
      case 'refresh':
      case 'heal-bell':
      case 'aromatherapy':
        return !attacker.pokemon.status;
      case 'haze':
        return Boolean(defender) &&
          [attacker, defender].every((combatant) => Object.values(combatant.stages).every((stage) => stage === 0));
      default:
        break;
    }

    if (!defender || defender === attacker) return false;
    const theirs = defender.volatile;
    // A move that takes a move away, on a target already without it — or, for
    // a Disable or an Encore, one with no last move to take.
    const lock = LOCK_MOVES[slug];
    if (lock) {
      if (hasVolatile(defender, lock.state)) return true;
      return (slug === 'disable' || slug === 'encore') && !defender.lastMove;
    }
    switch (slug) {
      case 'attract':
        return hasVolatile(defender, VOLATILE.INFATUATION) || !oppositeGenders(attacker.pokemon, defender.pokemon);
      case 'yawn':
        return Boolean(theirs.yawn) || Boolean(defender.pokemon.status);
      case 'nightmare':
        return Boolean(theirs.nightmare) || defender.pokemon.status !== 'slp';
      case 'heal-block':
        return theirs.healBlock > 0;
      case 'embargo':
        return theirs.embargo > 0;
      case 'gastro-acid':
        return Boolean(theirs.gastroAcid);
      case 'octolock':
        return Boolean(theirs.octolock);
      case 'curse':
        return this.typesOf(attacker).includes('ghost') && Boolean(theirs.cursed);
      case 'topsy-turvy':
        return Object.values(defender.stages).every((stage) => stage === 0);
      default:
        return false;
    }
  }

  /**
   * Whether a move just used did nothing to its target for a reason the
   * target had kept hidden, and that will not change while it stands there:
   * an ability that refuses it — a Soundproof, a Levitate, a Volt Absorb that
   * drinks it, an Insomnia, a Magic Bounce — or a held item that does, a pair
   * of Safety Goggles. A miss, a Protect or a Magic Coat says nothing about
   * the next turn; a type, a substitute, a Safeguard or an Air Balloon (which
   * says so as its holder comes out) is on the screen, and is never tried in
   * the first place (`visiblyUseless`).
   *
   * @param {Combatant} attacker
   * @param {Combatant|null} defender
   * @param {any} move
   * @param {LogEntry[]} lines what the move did, and nothing before it
   */
  shrugsOff(attacker, defender, move, lines) {
    if (!defender || defender === attacker || !aimsAtTarget(move)) return false;
    const theirs = (/** @type {LogEntry} */ entry) => entry.side === defender.side;
    // Only what the defender kept to itself is learned: its ability showing
    // itself, or a sealing that came from its ability or its held item.
    // Anything on the screen is `visiblyUseless`'s, and never needs a try.
    const answered = lines.some((entry) => theirs(entry) && entry.kind === 'ability');
    if (lines.some((entry) => theirs(entry) && entry.kind === 'noEffect' && (entry.data?.cause === 'ability' || entry.data?.cause === 'item'))) {
      return true;
    }
    if (!answered) return false;
    if (lines.some((entry) => theirs(entry) && entry.kind === 'damage')) return false;
    return attacker.marks.lastFailed || move.damageClass !== 'status' ||
      lines.some((entry) => entry.kind === 'bounced' ||
        (theirs(entry) && (entry.kind === 'statusBlocked' || entry.kind === 'volatileBlocked' ||
          (entry.kind === 'effectiveness' && entry.data?.effectiveness === 0))));
  }


  /**
   * Whether the Pokémon in front got behind something this turn, and what
   * running into it costs.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   * @param {string} moveName
   * @param {LogEntry[]} log
   */
  blockedByGuard(attacker, defender, move, moveName, log) {
    if (defender.volatile.protectTurn !== this.turn) return false;
    // A Mat Block stops attacks and nothing else.
    if (defender.volatile.protectMove === 'mat-block' && move.damageClass === 'status') return false;
    // A guard is something to hide behind, not something to stand behind while
    // the other side helps itself — a move aimed at its user goes through.
    if (move.damageClass === 'status' && !(move.statChanges ?? []).some((change) => change.change < 0)) {
      if ((move.meta?.ailment ?? 'none') === 'none') return false;
    }
    if (PROTECT_BYPASS.has(moveName) || move.rules?.unprotectable) return false;

    // An Unseen Fist reaches through one as long as it is touching.
    const ability = this.abilityOf(attacker);
    if (ability?.unseenFist && hasFlag(move, 'contact')) return false;

    log.push({ kind: 'protected', side: defender.side });

    // What the guard charges for touching it.
    const price = PROTECT_MOVES[defender.volatile.protectMove ?? ''] ?? {};
    if (!hasFlag(move, 'contact') || this.abilityOf(attacker)?.indirectImmune) return true;
    if (heldShield(attacker.pokemon, 'contactEffects')) return true;

    if (price.damage) {
      const amount = Math.max(1, Math.floor(attacker.maxHp * price.damage));
      attacker.pokemon.hp = Math.max(0, attacker.pokemon.hp - amount);
      log.push({ kind: 'damage', side: attacker.side, data: { amount } });
    }
    if (price.stat) this.applyStage(attacker, price.stat, price.stages ?? -1, log);
    if (price.status) this.inflictStatus(attacker, STATUS_TO_AILMENT[price.status] ?? price.status, log);
    return true;
  }

  /**
   * What answering a missed move is worth: a Blunder Policy's two stages of
   * Speed, and nothing else.
   *
   * @param {Combatant} attacker
   * @param {LogEntry[]} log
   */
  afterMiss(attacker, log) {
    const policy = heldPassive(attacker.pokemon, 'miss');
    if (!policy) return;

    const mark = log.length;
    let used = false;
    for (const stat of policy.stats) {
      if (this.applyStage(attacker, stat, policy.stages ?? 1, log, { quiet: true })) used = true;
    }
    if (!used) return;
    log.splice(mark, 0, { kind: 'berry', side: attacker.side, data: { item: attacker.pokemon.heldItem } });
    attacker.pokemon.heldItem = null;
  }

  /**
   * What using a move of a particular class is worth to its user — which today
   * is a Throat Spray answering a sound move.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   * @param {LogEntry[]} log
   */
  afterUse(attacker, defender, move, log) {
    // A Gulp Missile has already been wearing what it caught since the move
    // that caught it, so this is where it catches it — the catch is
    // registered through the shared evaluateFormes, which re-reads the move
    // the combatant just used.
    this.evaluateFormes(log);

    const spray = heldPassive(attacker.pokemon, 'used');
    if (!spray || !spray.flags?.some((flag) => hasFlag(move, flag))) return;

    const mark = log.length;
    let used = false;
    for (const stat of spray.stats) {
      if (this.applyStage(attacker, stat, spray.stages ?? 1, log, { quiet: true })) used = true;
    }
    if (!used) return;
    log.splice(mark, 0, { kind: 'berry', side: attacker.side, data: { item: attacker.pokemon.heldItem } });
    attacker.pokemon.heldItem = null;
  }

  /**
   * The upkeep a held item pays, or charges, at the end of a turn: the
   * Leftovers that give a sixteenth back, the Black Sludge that does the same
   * for a Poison type and poisons anything else that carries it.
   *
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  endOfTurnHeld(combatant, log) {
    // An orb hands its holder the condition it carries, which is the price of
    // whatever the holder wanted a burn or a poison for.
    const orb = heldPassive(combatant.pokemon, 'selfStatus');
    if (orb && !combatant.pokemon.status) {
      // An orb is not spent: it hands over the same condition every battle,
      // which is why anything holding one wanted it.
      const before = log.length;
      if (this.inflictStatus(combatant, STATUS_TO_AILMENT[orb.status] ?? orb.status, log)) {
        log.splice(before, 0, { kind: 'heldFired', side: combatant.side, data: { item: combatant.pokemon.heldItem } });
      }
    }

    // A White Herb puts back whatever was taken off it.
    const herb = heldPassive(combatant.pokemon, 'restore');
    if (herb && combatant.marks.lowered) {
      let restored = false;
      for (const [stat, stage] of Object.entries(combatant.stages)) {
        if (stage >= 0) continue;
        combatant.stages[stat] = 0;
        restored = true;
      }
      combatant.marks.lowered = false;
      if (restored) {
        log.push({ kind: 'restored', side: combatant.side, data: { item: combatant.pokemon.heldItem } });
        if (herb.consumed) combatant.pokemon.heldItem = null;
      }
    }

    const held = heldPassive(combatant.pokemon, 'turn');
    if (!held) return;

    const max = maxHp(combatant.pokemon);
    const suits = !held.type || speciesOf(combatant.pokemon.speciesId).types.includes(held.type);

    if (suits && held.heal) {
      if (combatant.pokemon.hp >= max) return;
      const healed = Math.max(1, Math.floor(max * held.heal.fraction));
      combatant.pokemon.hp = Math.min(max, combatant.pokemon.hp + healed);
      log.push({ kind: 'heal', side: combatant.side, data: { amount: healed, item: combatant.pokemon.heldItem } });
      return;
    }

    // A Black Sludge only bites what it does not suit; a Sticky Barb names no
    // type at all and bites whoever is carrying it.
    if (held.harm && (held.type ? !suits : true) && !this.abilityOf(combatant)?.indirectImmune) {
      const damage = Math.max(1, Math.floor(max * held.harm.fraction));
      combatant.pokemon.hp = Math.max(0, combatant.pokemon.hp - damage);
      log.push({ kind: 'damage', side: combatant.side, data: { amount: damage, item: combatant.pokemon.heldItem } });
    }
  }

  /**
   * Whether a Rock Head or a Magic Guard spares its holder the recoil.
   * @param {Combatant} attacker
   */
  recoilFree(attacker) {
    const ability = this.abilityOf(attacker);
    return Boolean(ability?.recoilImmune || ability?.indirectImmune);
  }

  /**
   * Whether something keeps a Pokémon standing through a hit that would
   * otherwise knock it out — a Sturdy from full health, a Focus Sash from the
   * same, a Focus Band on a roll.
   *
   * @param {Combatant} defender
   * @param {number} damage
   * @returns {{consumed: boolean, ability?: boolean, move?: boolean}|null}
   */
  survivesHit(defender, damage) {
    if (damage < defender.pokemon.hp) return null;

    // An Endure holds on through anything, for the turn it was used.
    if (defender.volatile.endure === this.turn) return { consumed: false, move: true };

    // A Sturdy is a Focus Sash that never runs out.
    if (this.abilityOf(defender)?.sturdy && defender.pokemon.hp >= defender.maxHp) {
      return { consumed: false, ability: true };
    }

    const held = heldPassive(defender.pokemon, 'survive');
    if (!held) return null;

    if (held.fromFull && defender.pokemon.hp < defender.maxHp) return null;
    if (held.chance !== undefined && !this.rng.chance(held.chance)) return null;
    return { consumed: Boolean(held.consumed) };
  }

  /**
   * Eat a held berry whose moment has come, on either side.
   *
   * Both sides are checked now that they both carry things: a wild Pokémon
   * rolls its species' held item the way the cartridge rolls it, and a gym
   * leader's ace is handed a berry the way a gym leader's ace always is. The
   * bag's restock setting then replaces the companion's.
   *
   * @param {LogEntry[]} log
   */
  eatHeldBerry(log) {
    for (const combatant of [this.player, this.foe]) {
      if (combatant) this.eatOneBerry(combatant, log);
    }
  }

  /**
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  eatOneBerry(combatant, log) {
    // An Unnerve on the other side is what keeps a berry in its wrapper.
    const other = combatant === this.player ? this.foe : this.player;
    if (other && this.abilityOf(other)?.blocksBerries) return;

    // A Persim cures the confusion that never reaches the save, and a Lum
    // cures it along with everything else, so both are asked here rather than
    // through the trigger, which only sees what the Pokémon is carrying.
    const cure = heldPassive(combatant.pokemon, 'status');
    if (cure && (cure.status === 'cnf' || cure.status === 'any') && this.cureVolatile(combatant, log)) {
      log.push({ kind: 'berry', side: combatant.side, data: { item: combatant.pokemon.heldItem } });
      combatant.pokemon.heldItem = null;
      return;
    }

    // A Gluttony reaches for a pinch berry at half rather than a quarter.
    const ability = this.abilityOf(combatant);
    const trigger = heldTrigger(combatant.pokemon, { early: Boolean(ability?.berryEarly) });
    if (!trigger) return;

    const { slug, held } = trigger;
    // A Ripen makes the berry worth twice what it says.
    const ripe = ability?.berryDouble ? { ...held, ...doubled(held) } : held;
    // Where the berry's line goes: ahead of the stage it raised.
    const mark = log.length;
    if (held.stat) {
      // A stat berry raises a stage, which lives on the combatant rather than
      // on the Pokémon, so the battle applies that one itself.
      const stat = held.stat === 'random' ? this.rng.pick(STAT_KEYS) : held.stat;
      if (!this.applyStage(combatant, stat, ripe.stages ?? 1, log, { source: 'self', quiet: true })) return;
    } else if (held.crit) {
      // A Lansat sharpens the next hit rather than raising a stat.
      combatant.marks.critStages = (combatant.marks.critStages ?? 0) + held.crit;
    } else if (held.accuracy) {
      combatant.marks.accuracy = held.accuracy;
    } else if (held.first) {
      // A Custap is spent when the turn order is decided, not here.
      return;
    } else if (!applyHeldEffect(combatant.pokemon, ripe)) {
      return;
    }

    combatant.pokemon.heldItem = null;
    combatant.marks.ateBerry = slug;
    log.splice(mark, 0, { kind: 'berry', side: combatant.side, data: { item: slug } });

    // A Figy and its kin taste of one stat; a nature that lowers that stat
    // cannot stand the flavour, and the Pokémon is left confused.
    if (held.dislikes) {
      const nature = gameData().natures?.[combatant.pokemon.nature];
      if (nature?.decreased === held.dislikes && nature.increased !== nature.decreased) this.confuse(combatant, log);
    }

    // A Cheek Pouch is paid for eating whatever it was.
    if (ability?.onBerry) {
      log.push({ kind: 'ability', side: combatant.side, data: { ability: this.abilitySlugOf(combatant) } });
      ability.onBerry(this.abilityContext(combatant, other ?? combatant, log));
    }
  }

  /**
   * A berry growing back in the holder's hand, which is what a Harvest does
   * half the time and a Cud Chew always does the turn after.
   *
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  regrowBerry(combatant, log) {
    const ability = this.abilityOf(combatant);
    const chance = ability?.regrowsInSun && this.weatherFor(combatant) === WEATHER.SUN ? 1 : ability?.regrowsBerry;
    if (!chance || combatant.pokemon.heldItem || !combatant.marks.ateBerry) return;
    if (!this.rng.chance(chance)) return;

    combatant.pokemon.heldItem = combatant.marks.ateBerry;
    combatant.marks.ateBerry = null;
    log.push({ kind: 'ability', side: combatant.side, data: { ability: this.abilitySlugOf(combatant) } });
    log.push({ kind: 'regrew', side: combatant.side, data: { item: combatant.pokemon.heldItem } });
  }

  /**
   * Sleep, freeze and paralysis can all keep a Pokémon from moving.
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  canAct(combatant, log, intended = null) {
    const pokemon = combatant.pokemon;
    const planned = intended ? moveOf(intended) : null;

    if (pokemon.status === STATUS.SLEEP) {
      pokemon.statusTurns -= this.abilityOf(combatant)?.wakesTwiceAsFast ? 2 : 1;
      if (pokemon.statusTurns <= 0) {
        pokemon.status = null;
        log.push({ kind: 'status', side: combatant.side, data: { status: null, woke: true } });
        return true;
      }
      log.push({ kind: 'statusBlocked', side: combatant.side, data: { status: STATUS.SLEEP } });
      // A Snore and a Sleep Talk are what a sleeping Pokémon can still do.
      return Boolean(planned?.rules?.sleepUsable);
    }

    if (pokemon.status === STATUS.FREEZE) {
      // 20% thaw chance per turn, as in the games — and a move that burns
      // hot enough thaws its user on the way out.
      if (this.rng.chance(0.2) || hasFlag(planned, 'defrost')) {
        pokemon.status = null;
        log.push({ kind: 'status', side: combatant.side, data: { status: null, thawed: true } });
        return true;
      }
      log.push({ kind: 'statusBlocked', side: combatant.side, data: { status: STATUS.FREEZE } });
      return false;
    }

    if (pokemon.status === STATUS.PARALYSIS && this.rng.chance(0.25)) {
      log.push({ kind: 'statusBlocked', side: combatant.side, data: { status: STATUS.PARALYSIS } });
      return false;
    }

    // Confusion is checked after the conditions in the save, as the games
    // order it, and lands its hit on the Pokémon itself rather than on
    // anything in front of it.
    if (hasVolatile(combatant, VOLATILE.CONFUSION)) {
      log.push({ kind: 'volatileActive', side: combatant.side, data: { state: VOLATILE.CONFUSION } });
      if (this.rng.chance(CONFUSION_SELF_HIT)) {
        this.hitSelf(combatant, log);
        return false;
      }
    }

    if (hasVolatile(combatant, VOLATILE.INFATUATION) && this.rng.chance(INFATUATION_BLOCK)) {
      log.push({ kind: 'volatileBlocked', side: combatant.side, data: { state: VOLATILE.INFATUATION } });
      return false;
    }

    return true;
  }

  /**
   * The hit a confused Pokémon lands on itself.
   *
   * A typeless physical 40 against its own Defence, with no type chart, no
   * critical roll and nothing held or able to change it — which is what makes
   * confusion worth inflicting on something that would otherwise out-tank you.
   *
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  hitSelf(combatant, log) {
    const level = levelOf(combatant.pokemon);
    const attack = this.stat(combatant, 'atk');
    const defence = this.stat(combatant, 'def');
    const base =
      Math.floor(Math.floor((Math.floor((2 * level) / 5 + 2) * CONFUSION_POWER * attack) / defence) / 50) + 2;
    const damage = Math.max(1, Math.floor(base * (this.rng.int(85, 100) / 100)));

    combatant.pokemon.hp = Math.max(0, combatant.pokemon.hp - damage);
    log.push({ kind: 'confusionDamage', side: combatant.side, data: { amount: damage } });
  }

  /**
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   */
  rollAccuracy(attacker, defender, move) {
    const slug = this.slugOf(move);
    // A one-hit KO is its own roll: thirty in a hundred, and the level gap
    // on top of it, and nothing else counts.
    if (move.rules?.ohko) {
      const gap = levelOf(attacker.pokemon) - levelOf(defender.pokemon);
      const base = move.rules.ohko === 'Ice' && !this.typesOf(attacker).includes('ice') ? 20 : 30;
      if (this.abilityOf(attacker)?.neverMisses || this.abilityOf(defender, attacker)?.neverMisses) return true;
      return this.rng.next() < (base + gap) / 100;
    }
    // A null accuracy means the move cannot miss, and so does a No Guard.
    if (move.accuracy === null || move.accuracy === undefined) return true;
    if (this.abilityOf(attacker)?.neverMisses || this.abilityOf(defender, attacker)?.neverMisses) return true;
    // A Lock-On's aim, and a Glaive Rush's wide-open guard, do not miss.
    if (attacker.volatile.lockOn && attacker.volatile.lockOn.turn >= this.turn - 1 && attacker.volatile.lockOn.target === defender) {
      attacker.volatile.lockOn = null;
      return true;
    }
    if (defender.volatile.glaiveRush === this.turn) return true;

    // The weather has the last word on a Thunder or a Blizzard.
    const fromWeather = weatherAccuracy(this.weatherFor(attacker), slug);
    if (fromWeather === 'always') return true;

    const attackerAbility = this.abilityOf(attacker);
    const defenderAbility = this.abilityOf(defender, attacker);

    // A Keen Eye reads straight through an evasion the defender has raised,
    // and so does a move that ignores it, or a target that has been seen
    // through.
    const ignores = attackerAbility?.ignoresEvasion || move.rules?.ignoreEvasion || defender.volatile.identified;
    const evasion = ignores ? Math.min(0, defender.stages.eva ?? 0) : defender.stages.eva ?? 0;
    const stages = (attacker.stages.acc ?? 0) - evasion;

    const lens = heldPassive(attacker.pokemon, 'accuracy');
    const fromLens = lens && (!lens.movingLast || attacker.movedLast) ? lens.multiplier : 1;
    const fromMark = attacker.marks.accuracy ?? 1;
    attacker.marks.accuracy = 1;

    const chance =
      (move.accuracy / 100) *
      stageMultiplier(stages, true) *
      fromWeather *
      fromLens *
      fromMark *
      (attackerAbility?.accuracy?.(this.abilityContext(attacker, defender, []), move) ?? 1) *
      (defenderAbility?.evasion?.(this.abilityContext(defender, attacker, []), move) ?? 1) *
      (heldPassive(defender.pokemon, 'evasion')?.multiplier ?? 1) *
      (this.field.gravity > 0 ? 5 / 3 : 1);
    return this.rng.next() < chance;
  }

  /**
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   * @param {LogEntry[]} log
   */
  applyDamagingMove(attacker, defender, move, log) {
    const slug = this.slugOf(move);
    defender.marks.hitSubstitute = false;

    // A Present that turned out to be medicine.
    if (slug === 'present' && attacker.marks.present === 0) {
      if (!this.gainHp(defender, Math.floor(defender.maxHp / 4), log)) log.push({ kind: 'failed', side: attacker.side });
      return;
    }

    // A type the defender drinks rather than takes: the move lands and
    // something good happens to the target instead of damage.
    if (this.absorbMove(attacker, defender, move, log)) return;

    // A one-hit KO does nothing to a Sturdy, or to anything above its user.
    if (move.rules?.ohko) {
      const higher = levelOf(defender.pokemon) > levelOf(attacker.pokemon);
      const iceProof = move.rules.ohko === 'Ice' && this.typesOf(defender).includes('ice');
      if (this.abilityOf(defender, attacker)?.sturdy && !higher && !iceProof) {
        log.push({ kind: 'ability', side: defender.side, data: { ability: this.abilitySlugOf(defender) } });
      }
      if (higher || iceProof || this.abilityOf(defender, attacker)?.sturdy) {
        log.push({ kind: iceProof ? 'noEffect' : 'failed', side: iceProof ? defender.side : attacker.side });
        return;
      }
    }

    const hits = this.hitCount(attacker, move);
    const startHp = defender.pokemon.hp;
    let total = 0;
    let soaked = 0;
    let landed = 0;
    let effectiveness = 1;
    let critical = false;
    const behindDoll = () =>
      defender.volatile.substitute > 0 && !hasFlag(move, 'sound') && !this.abilityOf(attacker)?.infiltrates;

    for (let hit = 0; hit < hits && defender.pokemon.hp > 0; hit++) {
      // Each strike of a Triple Axel or a Population Bomb aims again, and a
      // Triple Kick hits harder with every one that lands.
      if (hit > 0 && move.meta?.multiAccuracy && !heldPassive(attacker.pokemon, 'multiHit') && !this.rollAccuracy(attacker, defender, move)) {
        break;
      }
      const strike = ESCALATING.has(slug) ? { ...move, power: (move.power ?? 0) * (hit + 1) } : move;
      const result = this.computeDamage(attacker, defender, strike);
      effectiveness = result.effectiveness;
      critical = critical || result.critical;
      if (result.effectiveness === 0) break;
      landed++;

      // A substitute stands in for its Pokémon, and breaks when it has taken
      // what it was made of.
      if (behindDoll()) {
        const taken = Math.min(defender.volatile.substitute, result.damage);
        defender.volatile.substitute -= taken;
        soaked += taken;
        defender.marks.hitSubstitute = true;
        this.say(defender, 'move.substitute.hit');
        if (defender.volatile.substitute <= 0) {
          defender.volatile.substitute = 0;
          this.say(defender, 'move.substitute.end');
        }
        continue;
      }

      // A Disguise or an Ice Face takes the hit and shatters instead of
      // letting any of it through — whatever the hit would have done.
      if (this.bustForme(attacker, defender, move)) {
        defender.marks.formeBroken = true;
        this.applyForme(defender, { ...this.formeState(defender), broken: true }, log);
        log.push({ kind: 'formBroken', side: defender.side, data: { ability: this.abilitySlugOf(defender) } });
        // A broken Disguise costs an eighth of its health, as it has since Gen 8.
        if (this.abilitySlugOf(defender) === 'disguise') this.loseHp(defender, Math.floor(defender.maxHp / 8), log);
        break;
      }

      const survives = this.survivesHit(defender, result.damage);
      defender.pokemon.hp = Math.max(survives ? 1 : 0, defender.pokemon.hp - result.damage);
      total += result.damage;
      if (survives) {
        if (survives.move) {
          this.say(defender, 'move.endured');
        } else {
          log.push({
            kind: 'endure',
            side: defender.side,
            data: survives.ability
              ? { ability: this.abilitySlugOf(defender) }
              : { item: defender.pokemon.heldItem },
          });
        }
        if (survives.consumed) this.consumeItem(defender);
        break;
      }
    }

    // A Gem is spent on the move it powered up.
    if (attacker.marks.gemUsed) {
      log.push({ kind: 'heldFired', side: attacker.side, data: { item: attacker.marks.gemUsed } });
      if (attacker.pokemon.heldItem === attacker.marks.gemUsed) this.consumeItem(attacker);
      attacker.marks.gemUsed = null;
    }

    if (effectiveness === 0) {
      log.push({ kind: 'effectiveness', side: defender.side, data: { effectiveness: 0 } });
      this.crash(attacker, move, log);
      return;
    }

    // A shattering disguise took every hit of the move: there is nothing to
    // report as damage, and none of what hangs off damage — drain, recoil,
    // secondary effects — applies to a hit nobody took.
    if (total === 0 && soaked === 0) return;
    const dealt = total + soaked;

    // A berry eaten on the way in is announced before the damage it softened.
    if (defender.marks.ateResist) {
      log.push({ kind: 'berry', side: defender.side, data: { item: defender.marks.ateResist } });
      defender.marks.ateResist = null;
    }

    // The hit lands first and the reasons follow it, which is the order the
    // games read in: the bar drains, then "급소에 맞았다!", then "효과가
    // 굉장했다!".
    if (total > 0) log.push({ kind: 'damage', side: defender.side, data: { amount: total, hits: landed } });
    if (move.rules?.ohko && defender.pokemon.hp <= 0) this.say(defender, 'move.ohko');
    if (critical) {
      log.push({ kind: 'critical', side: defender.side });
      // Three in one battle is how a Galarian Farfetch'd evolves.
      attacker.marks.crits = (attacker.marks.crits ?? 0) + 1;
      // An Anger Point turns a weak spot into the highest Attack there is.
      const angered = this.abilityOf(defender, attacker);
      if (angered?.onCrit && defender.pokemon.hp > 0 && total > 0) {
        log.push({ kind: 'ability', side: defender.side, data: { ability: this.abilitySlugOf(defender) } });
        angered.onCrit(this.abilityContext(defender, attacker, log));
      }
    }
    if (effectiveness !== 1 && !move.rules?.damage && !RETALIATES.has(slug)) {
      log.push({ kind: 'effectiveness', side: defender.side, data: { effectiveness } });
    }
    if (hits > 1 || (move.meta?.minHits ?? 0) > 1) this.say(defender, 'move.hitCount', { count: landed });

    // Drain and recoil are expressed as a percentage of the damage dealt.
    const drain = move.meta?.drain ?? 0;
    if (drain > 0) {
      const root = heldPassive(attacker.pokemon, 'drainBoost')?.multiplier ?? 1;
      const healed = Math.max(1, Math.floor(((dealt * drain) / 100) * root));
      // A Liquid Ooze turns the drink into the same amount of damage.
      if (this.abilityOf(defender, attacker)?.drainHurts) {
        log.push({ kind: 'ability', side: defender.side, data: { ability: this.abilitySlugOf(defender) } });
        this.loseHp(attacker, healed, log);
      } else {
        this.gainHp(attacker, healed, log);
      }
    } else if (drain < 0 && !this.recoilFree(attacker)) {
      const recoil = this.loseHp(attacker, Math.max(1, Math.floor((dealt * -drain) / 100)), log, { recoil: true });
      // A white-striped Basculin counts the recoil it has lived through.
      if (speciesOf(attacker.pokemon.speciesId)?.evolutions?.some((evolution) => evolution.recoil)) {
        attacker.pokemon.recoilTaken = attacker.pokemon.hp > 0 ? (attacker.pokemon.recoilTaken ?? 0) + recoil : 0;
      }
    }

    // A Shell Bell pays its holder a share of what it just dealt, and a Life
    // Orb charges for the extra damage it added.
    const shell = heldPassive(attacker.pokemon, 'drain');
    if (shell && attacker.pokemon.hp > 0) this.gainHp(attacker, Math.max(1, Math.floor(dealt * shell.fraction)), log);

    const orb = heldPassive(attacker.pokemon, 'damage');
    // A Magic Guard pays nothing; a Sheer Force pays nothing for a move whose
    // side effect it gave up. A Rock Head is no help: this is not recoil.
    const sheer = this.abilityOf(attacker)?.noSecondary && hasSecondary(move);
    if (orb?.cost && !this.abilityOf(attacker)?.indirectImmune && !sheer) {
      this.loseHp(attacker, Math.max(1, Math.floor(attacker.maxHp * orb.cost)), log, { recoil: true });
    }

    // What this hit is remembered for, this turn and for the battle.
    if (total > 0) {
      defender.turn.hitBy.push(attacker);
      defender.turn.damage += total;
      defender.turn.lastHit = { amount: total, damageClass: move.damageClass };
      defender.marks.timesHit = (defender.marks.timesHit ?? 0) + 1;
      if (defender.volatile.bide) defender.volatile.bide.damage += total;
    }
    if (move.rules?.selfdestruct === 'ifHit' && landed > 0) attacker.marks.spent = true;

    // Fire thaws what it hits.
    if (total > 0 && defender.pokemon.status === STATUS.FREEZE && (move.type === 'fire' || move.rules?.thawsTarget)) {
      defender.pokemon.status = null;
      log.push({ kind: 'status', side: defender.side, data: { status: null, thawed: true } });
    }

    defender.marks.lastDamage = total;
    if (total > 0) this.answerHit(attacker, defender, move, total, effectiveness, log);
    this.applySecondaryEffects(attacker, defender, move, log);

    // Whatever the move does beyond its numbers: an item knocked away, a
    // hazard spun off, a Pokémon dragged out.
    const after = AFTER_HIT[slug];
    if (after && (total > 0 || PIVOTS.has(slug)) && this.running) {
      after({ battle: this, user: attacker, target: defender, move, log, damage: total });
    }

    // A Wimp Out or an Emergency Exit leaves the moment a hit takes it under
    // half: a trainer's Pokémon back to its trainer, a wild one off into the
    // grass. The companion has nobody to switch to and stays.
    const half = defender.maxHp / 2;
    if (
      total > 0 && defender.pokemon.hp > 0 && startHp > half && defender.pokemon.hp <= half &&
      defender.side === 'foe' && this.running && this.abilityOf(defender)?.emergencyExit
    ) {
      const mark = log.length;
      const left = this.trainerBattle ? this.switchFoe(log) : (this.say(defender, 'move.fled'), this.finish('fled', log), true);
      if (left) log.splice(mark, 0, { kind: 'ability', side: defender.side, data: { ability: this.abilitySlugOf(defender) } });
    }

    // Going down takes the attacker with it, under a Destiny Bond, and takes
    // the move's PP, under a Grudge.
    if (defender.pokemon.hp <= 0 && total > 0) {
      if (defender.volatile.destinyBond && attacker.pokemon.hp > 0) {
        this.say(defender, 'move.destinyBond.taken');
        this.loseHp(attacker, attacker.pokemon.hp, log);
      }
      if (defender.volatile.grudge) {
        const slot = this.movesOf(attacker).find((entry) => entry.move === attacker.lastMove);
        if (slot) {
          slot.pp = 0;
          this.say(attacker, 'move.grudge.lost', { move: slot.move });
        }
      }
    }

    // What the defender's item does about having been hit: a Red Card sends
    // the attacker away.
    if (total > 0 && defender.pokemon.hp > 0) this.answerWithSwitch(attacker, defender, log);
  }

  /**
   * A Red Card going off after a hit.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {LogEntry[]} log
   */
  answerWithSwitch(attacker, defender, log) {
    if (!this.running) return;
    const red = heldPassive(defender.pokemon, 'redCard');
    if (red && attacker.side === 'foe' && attacker.pokemon.hp > 0) {
      const slug = defender.pokemon.heldItem;
      log.push({ kind: 'heldFired', side: defender.side, data: { item: slug } });
      this.consumeItem(defender);
      this.forceOut(defender, attacker, log);
    }
  }

  /**
   * How many times a move lands.
   *
   * A Skill Link and a pair of Loaded Dice both push a multi-hit move towards
   * the top of its range, from opposite directions: the ability takes the
   * maximum every time, the item raises the floor.
   *
   * @param {Combatant} attacker
   * @param {any} move
   */
  hitCount(attacker, move) {
    const min = move.meta?.minHits;
    // A Parental Bond adds a second, weaker hit to a move that had one.
    if (!min) return this.abilityOf(attacker)?.hitsTwice && move.damageClass !== 'status' ? 2 : 1;
    const max = move.meta.maxHits ?? min;

    if (this.abilityOf(attacker)?.maxHits) return max;
    const dice = heldPassive(attacker.pokemon, 'multiHit');
    if (dice) return this.rng.int(Math.min(max, dice.min), max);
    // Two to five is not even odds: two and three a third of the time each,
    // four and five a sixth.
    if (min === 2 && max === 5) {
      const roll = this.rng.next();
      return roll < 0.35 ? 2 : roll < 0.7 ? 3 : roll < 0.85 ? 4 : 5;
    }
    return this.rng.int(min, max);
  }

  /**
   * The charge an ability stored off something aimed at it, spent on the next
   * Electric move that goes out.
   *
   * @param {Combatant} attacker
   * @param {any} move
   */
  chargeMultiplier(attacker, move) {
    if ((!attacker.marks.charged && !attacker.volatile.charge) || move.type !== 'electric') return 1;
    attacker.marks.charged = false;
    attacker.volatile.charge = false;
    return 2;
  }

  /**
   * A type the defender takes something other than damage from.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   * @param {LogEntry[]} log
   * @returns {boolean} whether the move was drunk rather than taken
   */
  absorbMove(attacker, defender, move, log) {
    const ability = this.abilityOf(defender, attacker);
    const absorbed = ability?.absorb?.(this.abilityContext(defender, attacker, log), move);
    if (!absorbed) return false;

    const context = this.abilityContext(defender, attacker, log);
    log.push({ kind: 'ability', side: defender.side, data: { ability: this.abilitySlugOf(defender) } });

    if (absorbed.heal) context.heal(defender, absorbed.heal);
    if (absorbed.stat) context.raise(defender, absorbed.stat, absorbed.stages ?? 1);
    if (absorbed.mark) defender.marks[absorbed.mark] = true;
    if (!absorbed.heal && !absorbed.stat && !absorbed.mark) {
      log.push({ kind: 'effectiveness', side: defender.side, data: { effectiveness: 0 } });
    }
    return true;
  }

  /**
   * Whether the hit that just reached the defender broke something about its
   * shape instead of hurting it — a Disguise shattering, an Ice Face coming
   * off. The first hit only, and not while a Mold Breaker is swinging.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} [move]
   * @returns {boolean}
   */
  bustForme(attacker, defender, move) {
    if (defender.marks.formeBroken) return false;
    // The disguise and the ice are the Pokémon's own body: a Ditto that
    // copied the ability has neither, and takes the hit as anything would.
    if (defender.transform || !this.bustedFormeOf(defender.pokemon)) return false;
    const busted = this.abilityOf(defender, attacker)?.busted;
    // An Ice Face only stops a physical blow; a Disguise stops anything.
    if (busted === 'physical') return move?.damageClass === 'physical';
    return Boolean(busted);
  }

  /**
   * The broken shape of a Disguise or an Ice Face, if the species wears one.
   *
   * @param {import('./pokemon.mjs').Pokemon} pokemon
   * @returns {string|null}
   */
  bustedFormeOf(pokemon) {
    const species = speciesOf(pokemon.speciesId);
    if (!species) return null;
    const slug = species.slug;
    return slug === 'mimikyu' ? 'mimikyu-busted' : slug === 'eiscue' ? 'eiscue-noice' : null;
  }

  /**
   * What taking a hit costs the Pokémon that landed it, and what it is worth
   * to the one that took it.
   *
   * Contact is the classification most of this hangs off — a Static only fires
   * when something touched it — and a Punching Glove or a pair of Protective
   * Pads is a way of not touching.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   * @param {number} damage
   * @param {number} effectiveness
   * @param {LogEntry[]} log
   */
  answerHit(attacker, defender, move, damage, effectiveness, log) {
    // A balloon pops on the first hit that reaches it, whatever the hit was.
    const balloon = heldPassive(defender.pokemon, 'immune');
    if (balloon?.popped && !defender.marks.popped) {
      defender.marks.popped = true;
      log.push({ kind: 'message', side: defender.side, data: { key: 'item.balloon.popped' } });
      defender.pokemon.heldItem = null;
    }

    // A Cramorant spits what it caught at whatever hit it: a quarter of the
    // attacker's health, and an Arrokuda lowers its Defense where a Pikachu
    // paralyses it.
    const caught = defender.marks.gulp;
    if (caught && this.ownAbility(defender)?.gulpMissile && attacker.pokemon.hp > 0) {
      defender.marks.gulp = null;
      log.push({ kind: 'ability', side: defender.side, data: { ability: this.abilitySlugOf(defender) } });
      if (!this.abilityOf(attacker)?.indirectImmune) this.loseHp(attacker, Math.floor(attacker.maxHp / 4), log);
      if (caught === 'gulping') this.applyStage(attacker, 'def', -1, log, { ability: this.abilitySlugOf(defender) });
      else this.inflictAilment(defender, attacker, 'paralysis', log);
      if (defender.pokemon.hp > 0) this.evaluateFormes(log);
    }

    // A Sticky Barb clings to whatever touched its holder, if that hand is
    // empty.
    const barb = heldPassive(defender.pokemon, 'turn');
    if (barb?.sticky && attacker.pokemon.hp > 0 && !attacker.pokemon.heldItem && this.touches(attacker, defender, move)) {
      attacker.pokemon.heldItem = defender.pokemon.heldItem;
      defender.pokemon.heldItem = null;
      this.say(attacker, 'move.obtained', { item: attacker.pokemon.heldItem });
    }

    if (defender.pokemon.hp > 0) {
      this.answerWithItem(attacker, defender, move, effectiveness, log);
      const ability = this.abilityOf(defender, attacker);

      // A Color Change becomes whatever just hit it.
      if (ability?.retypes === 'hit') this.becomeType(defender, [move.type], log);
      // And the two that store a charge off it.
      if (ability?.absorbCharge?.(this.abilityContext(defender, attacker, log), move)) {
        defender.marks.charged = true;
        log.push({ kind: 'ability', side: defender.side, data: { ability: this.abilitySlugOf(defender) } });
      }

      const before = log.length;
      ability?.hit?.(this.abilityContext(defender, attacker, log), move, damage);
      if (log.length > before) {
        log.splice(before, 0, { kind: 'ability', side: defender.side, data: { ability: this.abilitySlugOf(defender) } });
      }
    }

    // And what landing one is worth to the Pokémon that did.
    const dealt = this.abilityOf(attacker);
    if (dealt?.onHitDealt && attacker.pokemon.hp > 0) {
      const before = log.length;
      dealt.onHitDealt(this.abilityContext(attacker, defender, log), move, damage);
      if (log.length > before) {
        log.splice(before, 0, { kind: 'ability', side: attacker.side, data: { ability: this.abilitySlugOf(attacker) } });
      }
    }

    if (!this.touches(attacker, defender, move)) return;

    // What the attacker walks into by touching: an ability, and a helmet.
    if (defender.pokemon.hp > 0) {
      const ability = this.abilityOf(defender, attacker);
      const before = log.length;
      ability?.contact?.(this.abilityContext(defender, attacker, log));
      if (log.length > before) {
        log.splice(before, 0, { kind: 'ability', side: defender.side, data: { ability: this.abilitySlugOf(defender) } });
      }
    }

    const helmet = heldPassive(defender.pokemon, 'contact');
    if (helmet?.recoil && attacker.pokemon.hp > 0 && !this.abilityOf(attacker)?.indirectImmune) {
      const amount = Math.max(1, Math.floor(maxHp(attacker.pokemon) * helmet.recoil.fraction));
      attacker.pokemon.hp = Math.max(0, attacker.pokemon.hp - amount);
      log.push({ kind: 'damage', side: attacker.side, data: { amount, item: defender.pokemon.heldItem } });
    }
  }

  /**
   * Whether a move counts as touching for everything that keys off contact.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   */
  touches(attacker, defender, move) {
    if (!hasFlag(move, 'contact')) return false;
    // A Long Reach never touches anything.
    if (this.abilityOf(attacker)?.noContact) return false;
    // A Punching Glove takes the contact out of a punch, and Protective Pads
    // keep whatever is on the other side from mattering.
    const glove = heldPassive(attacker.pokemon, 'damage');
    if (glove?.dropsContact && glove.flags?.some((flag) => hasFlag(move, flag))) return false;
    return !heldShield(attacker.pokemon, 'contactEffects');
  }

  /**
   * The held items that answer being hit: the policies, the bulbs and the
   * berries with thorns on.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   * @param {number} effectiveness
   * @param {LogEntry[]} log
   */
  answerWithItem(attacker, defender, move, effectiveness, log) {
    const held = heldPassive(defender.pokemon, 'hurt');
    if (!held) return;
    if (held.superEffective && effectiveness <= 1) return;
    if (held.moveType && move.type !== held.moveType) return;
    if (held.damageClass && move.damageClass !== held.damageClass) return;

    const slug = defender.pokemon.heldItem;
    const mark = log.length;
    let used = false;

    for (const stat of held.stats ?? []) {
      if (this.applyStage(defender, stat, held.stages ?? 1, log, { quiet: true })) used = true;
    }
    if (held.heal) {
      const max = maxHp(defender.pokemon);
      const amount = Math.max(1, Math.floor(max * held.heal.fraction));
      if (defender.pokemon.hp < max) {
        defender.pokemon.hp = Math.min(max, defender.pokemon.hp + amount);
        log.push({ kind: 'heal', side: defender.side, data: { amount } });
        used = true;
      }
    }
    if (held.recoil && attacker.pokemon.hp > 0) {
      const amount = Math.max(1, Math.floor(maxHp(attacker.pokemon) * held.recoil.fraction));
      attacker.pokemon.hp = Math.max(0, attacker.pokemon.hp - amount);
      log.push({ kind: 'damage', side: attacker.side, data: { amount, item: slug } });
      used = true;
    }

    if (!used) return;
    log.splice(mark, 0, { kind: 'berry', side: defender.side, data: { item: slug } });
    if (held.consumed) defender.pokemon.heldItem = null;
  }

  /**
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   * @returns {{damage: number, effectiveness: number, critical: boolean}}
   */
  computeDamage(attacker, defender, move) {
    const level = levelOf(attacker.pokemon);
    const slug = this.slugOf(move);
    const physical = move.damageClass === 'physical';
    // A Body Press swings its Defense, a Psyshock aims at the Defense of what
    // it hits, and a Wonder Room swaps the two walls over.
    let attackStat = move.rules?.overrideOffensiveStat ?? (physical ? 'atk' : 'spa');
    let defenceStat = move.rules?.overrideDefensiveStat ?? (physical ? 'def' : 'spd');
    if (this.field.wonderRoom > 0) defenceStat = defenceStat === 'def' ? 'spd' : 'def';

    const attackerAbility = this.abilityOf(attacker);
    const defenderAbility = this.abilityOf(defender, attacker);
    const effectiveness = this.effectivenessOf(attacker, move, defender);
    if (effectiveness === 0) return { damage: 0, effectiveness: 0, critical: false };

    // The moves that hit for a number rather than by the formula: a Seismic
    // Toss for its user's level, a Super Fang for half of what is left, a
    // Counter for twice what it took, a one-hit KO for everything.
    if (move.rules?.ohko) return { damage: defender.pokemon.hp, effectiveness: 1, critical: false };
    const fixed = fixedDamage(this, attacker, defender, move);
    if (fixed !== null) {
      const damage = Math.max(fixed > 0 ? 1 : 0, Math.floor(fixed * companionArmour(defender, 1)));
      return { damage, effectiveness, critical: false };
    }

    const critical = this.rollCritical(attacker, defender, move);
    // An Unaware on either side reads the other's stages as zero: the
    // attacker's boosts do not help it, the defender's walls do not hold.
    // A Sacred Sword reads the defender's walls the same way.
    const blindAttacker = Boolean(defenderAbility?.ignoresStages);
    const blindDefender = Boolean(attackerAbility?.ignoresStages || move.rules?.ignoreDefensive);
    // A Foul Play swings the target's own Attack, stages and all.
    const swinger = move.rules?.overrideOffensivePokemon === 'target' ? defender : attacker;
    const attack = this.stat(swinger, attackStat, {
      ...(critical ? { ignoreNegative: true } : {}),
      ...(blindAttacker ? { ignoreStages: true } : {}),
    });
    const defence = this.stat(defender, defenceStat, {
      ...(critical ? { ignorePositive: true } : {}),
      ...(blindDefender ? { ignoreStages: true } : {}),
    });

    const base = Math.floor(
      Math.floor((Math.floor((2 * level) / 5 + 2) * (move.power ?? 0) * attack) / defence) / 50,
    ) + 2;

    // Typeless moves have no type to match.
    const stab = move.type !== 'typeless' && this.typesOf(attacker).includes(move.type) ? 1.5 : 1;

    // Burn halves physical damage, unless the ability holding it is the sort
    // that thrives on a condition, or the move is a Facade.
    const burn =
      physical && attacker.pokemon.status === STATUS.BURN && !attackerAbility?.ignoresBurn && slug !== 'facade' ? 0.5 : 1;
    const spread = this.rng.int(85, 100) / 100;
    const criticalBonus = critical ? 1.5 * (attackerAbility?.critBonus ?? 1) : 1;

    const attackContext = this.abilityContext(attacker, defender, [], { retyped: Boolean(move.retyped) });
    const defendContext = this.abilityContext(defender, attacker, []);
    const abilityPower = attackerAbility?.power?.(attackContext, move, effectiveness) ?? 1;
    const abilityTaken = defenderAbility?.taken?.(defendContext, move, effectiveness) ?? 1;
    const aura = auraMultiplier([this.abilityOf(attacker), this.abilityOf(defender)], move);

    const held = this.heldDamage(attacker, move, effectiveness);
    const charged = this.chargeMultiplier(attacker, move);
    const resisted = this.heldResist(defender, move, effectiveness);
    // A Hydro Steam is the one water move the sun makes stronger.
    let weather = weatherDamage(this.weatherFor(attacker), move.type);
    if (slug === 'hydro-steam' && this.weatherFor(attacker) === WEATHER.SUN) weather = 1.5;
    const terrain = terrainDamage(
      this.field.terrain,
      move.type,
      this.grounded(attacker),
      this.grounded(defender),
    );
    // The two sports that damp an element out, a Collision Course that hits a
    // weakness harder, and a Glaive Rush that left its user wide open.
    const sport =
      (move.type === 'fire' && this.field.waterSport > 0) || (move.type === 'electric' && this.field.mudSport > 0) ? 1 / 3 : 1;
    const drive = (slug === 'collision-course' || slug === 'electro-drift') && effectiveness > 1 ? 5461 / 4096 : 1;
    const exposed = defender.volatile.glaiveRush === this.turn ? 2 : 1;
    // An Infiltrator is not stopped by anything the other side put up.
    const screen = attackerAbility?.infiltrates ? 1 : this.screenMultiplier(defender, move, critical);
    const formula = Math.floor(
      base *
        stab *
        effectiveness *
        burn *
        spread *
        criticalBonus *
        held *
        resisted *
        abilityPower *
        abilityTaken *
        aura *
        weather *
        terrain *
        screen *
        charged *
        sport *
        drive *
        exposed,
    );
    // Something that takes nothing — a Wonder Guard, a berry's worth of
    // resistance ripened to nothing — takes nothing, not the one point every
    // other hit is rounded up to.
    if (abilityTaken === 0) return { damage: 0, effectiveness, critical };
    // The companion's armour comes off the finished hit, weakness and all.
    const damage = Math.max(1, Math.floor(formula * companionArmour(defender, effectiveness)));
    return { damage, effectiveness, critical };
  }

  /**
   * How well a move goes against what is in front of it.
   *
   * A Scrappy or a Mind's Eye reads a Ghost's immunity to Normal and Fighting
   * as no immunity at all, which is the one thing that can turn a zero into
   * something.
   *
   * @param {Combatant} attacker
   * @param {any} move
   * @param {Combatant} defender
   */
  effectivenessOf(attacker, move, defender) {
    if (move.type === 'typeless') return 1;
    const slug = this.slugOf(move);
    let types = this.typesOf(defender);

    // A Flying type that has been brought down takes Ground moves like
    // anything else, and a Thousand Arrows brings it down on the way.
    if (move.type === 'ground' && types.includes('flying') && (this.grounded(defender) || slug === 'thousand-arrows')) {
      types = types.filter((type) => type !== 'flying');
    }
    // A Scrappy, a Mind's Eye or a Foresight reads a Ghost's immunity to
    // Normal and Fighting as no immunity at all; only the Ghost part goes, so
    // a Ghost/Flying takes the Flying half as usual.
    const seesGhosts = this.abilityOf(attacker)?.hitsGhosts || defender.volatile.identified;
    if (seesGhosts && ['normal', 'fighting'].includes(move.type)) types = types.filter((type) => type !== 'ghost');

    // A Freeze-Dry is strong against Water whatever the chart says.
    let value = 1;
    for (const type of types) {
      let one = typeEffectiveness(move.type, [type]);
      if (slug === 'freeze-dry' && type === 'water') one = 2;
      value *= one;
    }
    // A Flying Press is Fighting and Flying at once.
    if (slug === 'flying-press') value *= typeEffectiveness('flying', types);
    // Tar makes fire twice as bad.
    if (defender.volatile.tarShot && move.type === 'fire') value *= 2;
    return value;
  }

  /**
   * Whether this hit lands on a weak spot.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   */
  rollCritical(attacker, defender, move) {
    // A Lucky Chant hides its side's weak spots.
    if (this.field.sides[defender.side].luckyChant > 0) return false;
    const armour = this.abilityOf(defender, attacker)?.crit?.(this.abilityContext(defender, attacker, []));
    if (armour?.immune) return false;

    const sharp = this.abilityOf(attacker)?.crit?.(this.abilityContext(attacker, defender, []));
    if (sharp?.always) return true;

    // A Laser Focus makes the next hit a sure one.
    if (attacker.volatile.laserFocus > 0) {
      attacker.volatile.laserFocus = 0;
      return true;
    }

    const lens = heldPassive(attacker.pokemon, 'crit');
    const fromItem = lens && itemSuits(lens, attacker.pokemon) ? lens.stages ?? 0 : 0;
    const stage =
      (move.meta?.critRate ?? 0) + fromItem + (sharp?.stages ?? 0) + (attacker.marks.critStages ?? 0) +
      (attacker.volatile.focusEnergy ? 2 : 0);
    return this.rng.next() < criticalChance(stage);
  }

  /**
   * How much a screen on the defender's side softens this hit.
   *
   * A critical hit goes straight through one, as it always has.
   *
   * @param {Combatant} defender
   * @param {any} move
   * @param {boolean} critical
   */
  screenMultiplier(defender, move, critical) {
    if (critical || move.damageClass === 'status') return 1;
    return this.field.screens[defender.side][move.damageClass] > 0 ? 0.5 : 1;
  }

  /**
   * How much the attacker's held item multiplies this move.
   *
   * @param {Combatant} attacker
   * @param {any} move
   * @param {number} effectiveness
   */
  heldDamage(attacker, move, effectiveness) {
    // A Gem goes off once, for the one move of its type it powers.
    const gem = heldPassive(attacker.pokemon, 'gem');
    if (gem && gem.moveType === move.type && !move.rules?.damage && !move.rules?.ohko) {
      attacker.marks.gemUsed = attacker.pokemon.heldItem;
      return gem.multiplier;
    }
    if (attacker.marks.gemUsed) return itemOf(attacker.marks.gemUsed)?.held?.multiplier ?? 1;

    const held = heldPassive(attacker.pokemon, 'damage');
    if (!held || !itemSuits(held, attacker.pokemon)) return 1;

    // A Metronome pays for persistence rather than for the move itself.
    if (held.consecutive) {
      return Math.min(held.max ?? 2, 1 + held.consecutive * attacker.repeats);
    }
    if (held.moveTypes) return held.moveTypes.includes(move.type) ? held.multiplier : 1;
    if (held.moveType) return move.type === held.moveType ? held.multiplier : 1;
    if (held.flags) return held.flags.some((flag) => hasFlag(move, flag)) ? held.multiplier : 1;
    if (held.damageClass) return move.damageClass === held.damageClass ? held.multiplier : 1;
    if (held.superEffective) return effectiveness > 1 ? held.multiplier : 1;
    return held.multiplier ?? 1;
  }

  /**
   * The type-resisting berries: eaten on the way in, and the only held effect
   * that changes a hit the holder is in the middle of taking.
   *
   * @param {Combatant} defender
   * @param {any} move
   * @param {number} effectiveness
   */
  heldResist(defender, move, effectiveness) {
    const berry = heldPassive(defender.pokemon, 'resist');
    if (!berry || berry.moveType !== move.type) return 1;
    if (berry.superEffectiveOnly && effectiveness <= 1) return 1;

    defender.marks.ateResist = defender.pokemon.heldItem;
    this.consumeItem(defender);
    // A Ripen makes the berry take off three quarters rather than half.
    return this.abilityOf(defender)?.berryDouble ? berry.multiplier / 2 : berry.multiplier;
  }

  /**
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   * @param {LogEntry[]} log
   */
  applySecondaryEffects(attacker, defender, move, log) {
    const meta = move.meta;
    const slug = this.slugOf(move);
    const changes = chargeOwnsStats(slug) ? [] : move.statChanges ?? [];
    const isSelf = (change) => change.self ?? change.change > 0;

    // The price of the move itself — a Close Combat's drops, a Make It
    // Rain's — is paid whatever else happens, and no Sheer Force waives it.
    const price = changes.filter((change) => isSelf(change) && change.secondary === false);
    if (price.length && attacker.pokemon.hp > 0) this.applyStatChanges(attacker, defender, move, log, price);
    if (!meta) return;

    const ability = this.abilityOf(attacker);
    // Sheer Force trades every secondary effect away for the damage it adds;
    // a Covert Cloak and a Shield Dust refuse the ones aimed at their holder,
    // and a substitute takes them in its Pokémon's place.
    if (ability?.noSecondary) return;
    const reaches = this.secondaryAllowed(attacker, defender, move);

    // Serene Grace doubles the odds of whatever a move was already going to do.
    const odds = ability?.secondary ?? 1;

    const jealous = !RAISED_THIS_TURN_ONLY.has(slug) || defender.marks.raisedTurn === this.turn;
    const ailment = meta.ailment;
    if (reaches && ailment && ailment !== 'none' && meta.ailmentChance > 0 && jealous) {
      if (this.rng.next() < (meta.ailmentChance / 100) * odds) {
        this.inflictAilment(attacker, defender, ailment, log, { toxic: Boolean(meta.toxic) });
      }
    }

    const flinchChance = Math.max(
      meta.flinchChance / 100,
      // A King's Rock adds a flinch to a move that had none, and Stench does
      // the same for an ability.
      hasFlag(move, 'contact') || move.damageClass !== 'status'
        ? Math.max(heldPassive(attacker.pokemon, 'flinch')?.chance ?? 0, ability?.flinch ?? 0)
        : 0,
    );
    if (reaches && flinchChance > 0 && this.rng.next() < flinchChance * odds && !this.abilityOf(defender, attacker)?.flinchImmune) {
      defender.flinched = true;
    }

    // A chance at stages: its user's own (a Flame Charge's Speed), which
    // nothing on the other side can refuse, and the target's, which can be.
    const ownSide = changes.filter((change) => isSelf(change) && change.secondary !== false);
    const theirs = reaches ? changes.filter((change) => !isSelf(change)) : [];
    if ((ownSide.length || theirs.length) && meta.statChance > 0) {
      if (this.rng.next() < (meta.statChance / 100) * odds) {
        this.applyStatChanges(attacker, defender, move, log, [...(attacker.pokemon.hp > 0 ? ownSide : []), ...theirs]);
      }
    }
  }

  /**
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   * @param {LogEntry[]} log
   */
  applyStatusMove(attacker, defender, move, log) {
    const meta = move.meta;
    const slug = this.slugOf(move);
    const before = log.length;
    let did = false;

    // A move that calls the weather, lays the terrain or puts up a screen.
    const field = FIELD_MOVES[slug];
    if (field) {
      if (field.weather && this.startWeather(field.weather, attacker, log)) did = true;
      if (field.terrain && this.startTerrain(field.terrain, attacker, log)) did = true;
      if (field.screen) {
        const clay = heldPassive(attacker.pokemon, 'extend');
        const turns = clay?.what === 'screen' ? clay.turns : FIELD_TURNS;
        if (this.field.setScreen(attacker.side, /** @type {any} */ (field.screen), turns)) {
          log.push({ kind: 'screen', side: attacker.side, data: { screen: field.screen, turns } });
          did = true;
        }
      }
      // A Trick Room twists the order of the turn for everyone, and a
      // Tailwind blows behind the side that called it.
      if (field.room) {
        const state = this.field.toggleTrickRoom();
        log.push({ kind: 'trickRoom', side: attacker.side, data: { state } });
        if (state === 'started') this.roomService(log);
        did = true;
      }
      if (field.tailwind && this.field.setTailwind(attacker.side)) {
        log.push({ kind: 'tailwind', side: attacker.side });
        did = true;
      }
      // A hazard is laid at the other side's feet, not at the user's.
      if (field.hazard && this.field.addHazard(defender.side, field.hazard)) {
        log.push({ kind: 'hazard', side: defender.side, data: { hazard: field.hazard } });
        did = true;
      }
    }

    // Getting behind something for the turn — or bracing for it.
    const guard = PROTECT_MOVES[slug];
    if (guard || slug === 'endure') {
      const streak = attacker.volatile.protectStreak ?? 0;
      if (this.rng.chance(protectChance(streak))) {
        attacker.volatile.protectStreak = streak + 1;
        if (guard) {
          attacker.volatile.protectTurn = this.turn;
          attacker.volatile.protectMove = slug;
          log.push({ kind: 'protect', side: attacker.side, data: { move: slug } });
        } else {
          STATUS_MOVES.endure({ battle: this, user: attacker, target: defender, move, log });
        }
        did = true;
      } else {
        attacker.volatile.protectStreak = 0;
      }
      if (!did) log.push({ kind: 'failed', side: attacker.side });
      return;
    }

    // A move with a rule of its own does exactly that and nothing more.
    const own = STATUS_MOVES[slug];
    if (own) {
      did = own({ battle: this, user: attacker, target: defender, move, log });
      if (!did && log.length === before) log.push({ kind: 'failed', side: attacker.side });
      return;
    }

    // Taking a move away.
    const lock = LOCK_MOVES[slug];
    if (lock && this.applyLock(attacker, defender, lock, log)) did = true;

    if (meta?.healing > 0) {
      // Sunshine makes a Synthesis worth two thirds of a bar and any other
      // weather a quarter; every other healing move takes its own number.
      const healing = weatherHealing(this.weatherFor(attacker), slug, meta.healing);
      if (this.gainHp(attacker, Math.floor((attacker.maxHp * healing) / 100), log) > 0) did = true;
    }

    if (meta?.ailment && meta.ailment !== 'none') {
      // A status move's listed chance is 0 when it always applies.
      const chance = meta.ailmentChance > 0 ? meta.ailmentChance / 100 : 1;
      if (this.rng.next() < chance && this.inflictAilment(attacker, defender, meta.ailment, log, { toxic: Boolean(meta.toxic) })) {
        did = true;
      }
    }

    if (move.statChanges?.length && !chargeOwnsStats(slug)) {
      if (this.applyStatChanges(attacker, defender, move, log)) did = true;
    }

    // "하지만 실패했다!" — which is a different thing from a type the move
    // cannot touch, and is only worth saying when nothing else was. A Swords
    // Dance at the ceiling has already said that its Attack will go no
    // higher, and a Clear Body has already refused the drop in its own name.
    if (!did && log.length === before) log.push({ kind: 'failed', side: attacker.side });
  }

  /**
   * A Room Service slowing its holder the moment a Trick Room goes up.
   *
   * @param {LogEntry[]} log
   */
  roomService(log) {
    for (const combatant of [this.player, this.foe]) {
      const held = combatant ? heldPassive(combatant.pokemon, 'room') : null;
      if (!held) continue;
      const mark = log.length;
      if (!this.applyStage(combatant, 'spe', held.stages ?? -1, log, { source: 'self', quiet: true })) continue;
      log.splice(mark, 0, { kind: 'heldFired', side: combatant.side, data: { item: combatant.pokemon.heldItem } });
      this.consumeItem(combatant);
    }
  }

  /**
   * Use up a held item, remembering it for a Recycle.
   *
   * @param {Combatant} combatant
   */
  consumeItem(combatant) {
    combatant.marks.consumed = combatant.pokemon.heldItem;
    combatant.pokemon.heldItem = null;
  }

  /**
   * Take a move, or every status move, away from the Pokémon in front.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {{state: string, turns: number}} lock
   * @param {LogEntry[]} log
   */
  applyLock(attacker, defender, lock, log) {
    // A Disable and an Encore both need something to have been used first.
    if (lock.state === VOLATILE.DISABLE || lock.state === VOLATILE.ENCORE) {
      if (!defender.lastMove || !this.movesOf(defender).some((slot) => slot.move === defender.lastMove)) {
        return false;
      }
    }
    if (this.blocksVolatile(defender, lock.state, log)) return false;

    const extra =
      lock.state === VOLATILE.DISABLE
        ? { disabledMove: defender.lastMove }
        : lock.state === VOLATILE.ENCORE
          ? { encoreMove: defender.lastMove }
          : {};
    if (!addVolatile(defender, lock.state, lock.turns, extra)) return false;

    log.push({ kind: 'volatile', side: defender.side, data: { state: lock.state, move: defender.lastMove } });
    // A Mental Herb is spent the moment something is taken away.
    this.eatMentalHerb(defender, log);
    return true;
  }

  /**
   * A Mental Herb, which undoes whatever has just been taken away.
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  eatMentalHerb(combatant, log) {
    if (!heldPassive(combatant.pokemon, 'free')) return;
    if (!this.freeMind(combatant, log)) return;
    log.push({ kind: 'heldFired', side: combatant.side, data: { item: combatant.pokemon.heldItem } });
    combatant.pokemon.heldItem = null;
  }

  /**
   * Lift what a Mental Herb lifts: the infatuation and the moves the other
   * side has locked or taken away.
   *
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  freeMind(combatant, log) {
    let freed = false;
    for (const state of [VOLATILE.INFATUATION, VOLATILE.TAUNT, VOLATILE.ENCORE, VOLATILE.DISABLE, VOLATILE.TORMENT]) {
      if (!clearVolatile(combatant, state)) continue;
      log.push({ kind: 'volatileEnded', side: combatant.side, data: { state } });
      freed = true;
    }
    return freed;
  }

  /**
   * What a Pokémon just sent out walks onto.
   *
   * Only the opponent's side ever has anything on it in practice — the
   * companion never leaves the field — but the toll is read the same way for
   * both, because the rule is the rule.
   *
   * @param {Combatant} arriving
   * @param {LogEntry[]} log
   */
  walkOntoHazards(arriving, log) {
    const hazards = this.field.hazards[arriving.side];
    if (Object.values(hazards).every((layers) => layers === 0)) return;

    // A pair of Heavy-Duty Boots steps over the lot.
    if (heldShield(arriving.pokemon, 'hazards')) return;

    const types = this.typesOf(arriving);
    const toll = hazardToll(hazards, { types, grounded: this.grounded(arriving) }, typeEffectiveness);

    if (toll.absorbs) {
      hazards.toxicSpikes = 0;
      log.push({ kind: 'hazardCleared', side: arriving.side, data: { hazard: 'toxicSpikes' } });
    }
    if (toll.damage > 0 && !this.abilityOf(arriving)?.indirectImmune) {
      const amount = Math.max(1, Math.floor(arriving.maxHp * toll.damage));
      arriving.pokemon.hp = Math.max(0, arriving.pokemon.hp - amount);
      log.push({ kind: 'hazardDamage', side: arriving.side, data: { amount } });
    }
    if (toll.stat) this.applyStage(arriving, toll.stat, -1, log);
    if (toll.status && arriving.pokemon.hp > 0) {
      this.inflictStatus(arriving, STATUS_TO_AILMENT[toll.status] ?? toll.status, log);
    }
  }

  /**
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   * @param {LogEntry[]} log
   * @returns {boolean} whether any stage actually moved
   */
  applyStatChanges(attacker, defender, move, log, changes = move.statChanges) {
    let changed = false;
    for (const change of changes) {
      // The data says who each stage lands on — a Close Combat's drops are
      // its user's price, a Growl's the target's loss. A record from before
      // it said so falls back on the old reading: rises to the user, drops to
      // the target.
      const self = change.self ?? change.change > 0;
      const target = self ? attacker : defender;
      if (target.pokemon.hp <= 0) continue;
      // A Clear Amulet refuses a drop the other side is trying to apply.
      if (!self && change.change < 0 && heldShield(target.pokemon, 'statDrops')) continue;
      if (this.applyStage(target, change.stat, change.change, log, self ? { source: 'self' } : {})) changed = true;
    }
    return changed;
  }

  /**
   * Hand a Pokémon whatever condition a move or an ability is trying to give
   * it, major or not.
   *
   * The five that go into the save go one way and the two that end with the
   * battle go the other, but a move does not distinguish between them — a
   * Confuse Ray and a Thunder Wave are both a move with an ailment on it — so
   * neither does the caller.
   *
   * @param {Combatant} source who is doing it
   * @param {Combatant} target
   * @param {string} ailment as the move data names it
   * @param {LogEntry[]} log
   * @returns {boolean} whether it took hold
   */
  inflictAilment(source, target, ailment, log, options = {}) {
    // A Safeguard keeps the other side's conditions off its whole side.
    if (source !== target && this.field.sides[target.side].safeguard > 0 && !this.abilityOf(source)?.infiltrates) {
      if (AILMENT_TO_STATUS[ailment] || ailment === 'confusion') {
        this.say(target, 'move.safeguard.protected');
        return false;
      }
    }
    if (ailment === 'confusion') return this.confuse(target, log);
    if (ailment === 'infatuation') return this.infatuate(source, target, log);
    return this.inflictStatus(target, ailment, log, options);
  }

  /**
   * Confuse a Pokémon for the two to five turns the games roll.
   *
   * @param {Combatant} target
   * @param {LogEntry[]} log
   * @param {{fatigue?: boolean}} [options] confused by the end of a rampage,
   *   which words the one line it gets its own way
   */
  confuse(target, log, { fatigue = false } = {}) {
    if (target.pokemon.hp <= 0) return false;
    if (this.blocksVolatile(target, VOLATILE.CONFUSION, log)) return false;
    if (!addVolatile(target, VOLATILE.CONFUSION, this.rng.int(...CONFUSION_TURNS))) return false;

    log.push({ kind: 'volatile', side: target.side, data: { state: VOLATILE.CONFUSION, ...(fatigue ? { fatigue: true } : {}) } });
    // A Persim Berry is eaten the moment the confusion lands, as it is in the
    // games; the ordinary berry check would not come round until the turn ends.
    this.eatOneBerry(target, log);
    return true;
  }

  /**
   * Infatuate a Pokémon with the one in front of it, which needs one of each.
   *
   * @param {Combatant} source
   * @param {Combatant} target
   * @param {LogEntry[]} log
   */
  infatuate(source, target, log) {
    if (target.pokemon.hp <= 0) return false;
    if (!oppositeGenders(source.pokemon, target.pokemon)) return false;
    if (this.blocksVolatile(target, VOLATILE.INFATUATION, log)) return false;
    // No clock: it lasts as long as the pair are facing each other.
    if (!addVolatile(target, VOLATILE.INFATUATION, Infinity)) return false;

    log.push({ kind: 'volatile', side: target.side, data: { state: VOLATILE.INFATUATION } });
    // A Destiny Knot ties the one who did it in the same knot.
    if (heldPassive(target.pokemon, 'destiny') && source !== target && !hasVolatile(source, VOLATILE.INFATUATION)) {
      const mark = log.length;
      if (this.infatuate(target, source, log)) {
        log.splice(mark, 0, { kind: 'heldFired', side: target.side, data: { item: target.pokemon.heldItem } });
      }
    }
    this.eatOneBerry(target, log);
    return true;
  }

  /**
   * Clear the states a medicine can reach: the confusion and the infatuation
   * that a Full Heal or a Lum Berry says it cures.
   *
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   * @returns {boolean} whether there was anything to clear
   */
  cureVolatile(combatant, log) {
    let cured = false;
    for (const state of [VOLATILE.CONFUSION, VOLATILE.INFATUATION]) {
      if (!clearVolatile(combatant, state)) continue;
      log.push({ kind: 'volatileEnded', side: combatant.side, data: { state } });
      cured = true;
    }
    return cured;
  }

  /**
   * Whether something keeps a battle-long state off a Pokémon: an ability, a
   * herb, or Misty Terrain under its feet.
   *
   * @param {Combatant} target
   * @param {string} state
   * @param {LogEntry[]} log
   */
  blocksVolatile(target, state, log) {
    if (this.field.terrain === TERRAIN.MISTY && this.grounded(target)) return true;

    const other = target === this.player ? this.foe : this.player;
    const ability = this.abilityOf(target, other ?? undefined);
    if (ability?.blockVolatile?.(this.abilityContext(target, other ?? target, log), state)) {
      log.push({ kind: 'ability', side: target.side, data: { ability: this.abilitySlugOf(target) } });
      return true;
    }
    return false;
  }

  /**
   * @param {Combatant} target
   * @param {string} ailment
   * @param {LogEntry[]} log
   * @returns {boolean} whether it took hold
   */
  inflictStatus(target, ailment, log, options = {}) {
    const status = AILMENT_TO_STATUS[ailment];
    if (!status) return false;
    if (target.pokemon.status) return false;
    // Nobody falls asleep through an Uproar.
    if (status === STATUS.SLEEP && this.uproar()) return false;

    const types = this.typesOf(target);
    const source = target === this.player ? this.foe : this.player;
    // A Corrosion poisons the two types that are supposed to be past it.
    const corrodes = status === STATUS.POISON && this.abilityOf(source ?? target)?.corrodes;
    if (!corrodes && IMMUNE_TYPES[status]?.some((type) => types.includes(type))) return false;

    // Nothing freezes in sunshine, which is the one condition the weather has
    // an opinion about.
    if (status === STATUS.FREEZE && this.weatherFor(target) === WEATHER.SUN) return false;

    // Misty Terrain keeps everything off whatever is standing on it; Electric
    // Terrain only keeps it awake.
    if (terrainBlocksStatus(this.field.terrain, status) && this.grounded(target)) return false;

    const other = source;
    const ability = this.abilityOf(target, other ?? undefined);
    if (ability?.blockStatus?.(this.abilityContext(target, other ?? target, log), status)) {
      log.push({ kind: 'ability', side: target.side, data: { ability: this.abilitySlugOf(target) } });
      return false;
    }

    target.pokemon.status = status;
    target.pokemon.statusTurns = status === STATUS.SLEEP ? this.rng.int(1, 3) : 0;
    // A Toxic's poison is the bad kind, which bites harder every turn.
    const toxic = status === STATUS.POISON && Boolean(options.toxic);
    target.pokemon.toxic = toxic;
    target.marks.toxicTurns = 0;
    log.push({ kind: 'status', side: target.side, data: { status, ...(toxic ? { toxic: true } : {}) } });

    // A Synchronize passes a burn, a poison or a paralysis straight back.
    const passes = status === STATUS.BURN || status === STATUS.POISON || status === STATUS.PARALYSIS;
    if (ability?.reflectsStatus && passes && other && other.pokemon.hp > 0 && !other.pokemon.status) {
      log.push({ kind: 'ability', side: target.side, data: { ability: this.abilitySlugOf(target) } });
      this.inflictStatus(other, ailment, log, { toxic });
    }
    return true;
  }

  /**
   * Burn and poison bite at the end of the turn.
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  endOfTurnStatus(combatant, log) {
    const status = combatant.pokemon.status;
    if (status !== STATUS.BURN && status !== STATUS.POISON) return;

    const ability = this.abilityOf(combatant);
    // A Magic Guard takes nothing it was not hit by, and a Poison Heal is fed
    // by the poison rather than worn down by it.
    if (ability?.indirectImmune) return;
    if (status === STATUS.POISON && ability?.feedsOnPoison) return;

    // A burn takes a sixteenth a turn and a poison an eighth, as they have
    // since Gold and Silver; a bad poison a sixteenth more every turn it
    // lasts, and a burn on a Heatproof bites half as hard.
    let share = status === STATUS.POISON ? 1 / 8 : 1 / 16;
    if (status === STATUS.POISON && combatant.pokemon.toxic) {
      combatant.marks.toxicTurns = Math.min(15, (combatant.marks.toxicTurns ?? 0) + 1);
      share = combatant.marks.toxicTurns / 16;
    }
    if (status === STATUS.BURN && ability?.burnHalved) share /= 2;
    const damage = Math.max(1, Math.floor(combatant.maxHp * share));
    combatant.pokemon.hp = Math.max(0, combatant.pokemon.hp - damage);
    log.push({ kind: 'statusDamage', side: combatant.side, data: { status, amount: damage } });
  }

  /** @param {LogEntry[]} log */
  checkFaint(log) {
    if (!this.running || !this.foe) return;
    this.noteFaints();
    /** The foe's last Pokémon, when this is what took it down. */
    let lastFoe = /** @type {Combatant|null} */ (null);

    if (this.foe.pokemon.hp <= 0) {
      // The Pokémon itself rides along with the entry. A whole turn is played
      // back after the engine has finished it, and by then `this.foe` is the
      // next one out — or nothing at all, the fight being over — so a screen
      // reading the entry later has no other way to name what just fell.
      const fallen = this.foe.pokemon;
      log.push({ kind: 'faint', side: 'foe', data: { speciesId: fallen.speciesId, pokemon: fallen } });
      this.onFaint(this.foe, log);
      this.onKnockOut(this.player, this.foe, log);
      this.awardExperience(this.foe, log);

      const next = this.foeQueue.shift();
      if (next) {
        this.foe = next;
        log.push({
          kind: 'sendOut',
          side: 'foe',
          data: { speciesId: next.pokemon.speciesId, pokemon: next.pokemon },
        });
        // It walks onto whatever was laid down for the one before it, and
        // then does whatever its own ability does on the way in.
        this.walkOntoHazards(next, log);
        this.enter(next, log);
        this.imposeAgain(this.player, log);
      } else {
        lastFoe = this.foe;
        this.foe = null;
      }
    }

    // The companion can go down in the same moment as what it was fighting —
    // to a Struggle's recoil, to a Life Orb, to an Aftermath. Checked after
    // the foe rather than instead of it, so the knock-out it earned still
    // counts.
    if (this.player.pokemon.hp <= 0) {
      // Fainting starts a Basculin's count of recoil over.
      if (this.player.pokemon.recoilTaken) this.player.pokemon.recoilTaken = 0;
      log.push({
        kind: 'faint',
        side: 'player',
        data: { speciesId: this.player.pokemon.speciesId, pokemon: this.player.pokemon },
      });
      this.onFaint(this.player, log);
      if (this.foe) this.onKnockOut(this.foe, this.player, log);
      // With the foe's last Pokémon down too, whichever went down last wins,
      // as the games have it from Black and White on: the companion that
      // takes the last one with it on its own recoil has won, and the one
      // whose Explosion took the last one with it has not. A foe with another
      // Pokémon still to send out has simply won.
      const outlasted = Boolean(lastFoe) && (this.player.downAt ?? 0) > (lastFoe?.downAt ?? Infinity);
      this.outcome = outlasted ? 'won' : 'lost';
      log.push({ kind: 'end', data: { outcome: this.outcome } });
      return;
    }

    if (!this.foe) {
      this.outcome = 'won';
      log.push({ kind: 'end', data: { outcome: 'won' } });
    }
  }

  /**
   * What taking something down is worth to whoever did it.
   *
   * @param {Combatant} winner
   * @param {Combatant} fallen
   * @param {LogEntry[]} log
   */
  onKnockOut(winner, fallen, log) {
    if (winner.pokemon.hp <= 0) return;
    const ability = this.abilityOf(winner);
    if (!ability?.onKnockOut) return;

    const before = log.length;
    ability.onKnockOut(this.abilityContext(winner, fallen, log));
    if (log.length > before) {
      log.splice(before, 0, { kind: 'ability', side: winner.side, data: { ability: this.abilitySlugOf(winner) } });
    }
  }

  /**
   * What a Pokémon leaves behind — an Aftermath taking the Pokémon that
   * touched it down with it.
   *
   * @param {Combatant} fallen
   * @param {LogEntry[]} log
   */
  onFaint(fallen, log) {
    const other = fallen === this.player ? this.foe : this.player;
    const ability = this.ownAbility(fallen);
    if (!ability?.faint || !other) return;

    // A Damp on the other side is what an Aftermath runs into.
    if (this.abilityOf(other)?.dampens) return;
    const byContact = this.touches(other, fallen, moveOf(other.lastMove ?? '') ?? {});
    const before = log.length;
    ability.faint(this.abilityContext(fallen, other, log, { byContact, lastDamage: fallen.marks.lastDamage ?? 0 }));
    if (log.length > before) {
      log.splice(before, 0, { kind: 'ability', side: fallen.side, data: { ability: this.abilitySlugOf(fallen) } });
    }
  }

  /**
   * @param {Combatant} defeated
   * @param {LogEntry[]} log
   */
  awardExperience(defeated, log) {
    if (this.player.pokemon.hp <= 0) return;
    const species = speciesOf(defeated.pokemon.speciesId);
    // The first run's early levels pay more (see `FIRST_RUN_EXPERIENCE_BONUS`).
    const early = this.firstRun && levelOf(this.player.pokemon) < FIRST_RUN_EXPERIENCE_UNTIL ? FIRST_RUN_EXPERIENCE_BONUS : 1;
    const reward = gainFromDefeat(
      this.player.pokemon,
      { baseStats: species.stats, baseExp: species.baseExp, level: levelOf(defeated.pokemon) },
      {
        trainerBattle: this.trainerBattle,
        experienceMultiplier: (heldPassive(this.player.pokemon, 'experience')?.multiplier ?? 1) * early,
      },
    );
    this.rewards.push(reward);

    log.push({ kind: 'experience', side: 'player', data: { amount: reward.experience } });
    if (reward.levelsGained > 0) {
      log.push({ kind: 'levelUp', side: 'player', data: { level: reward.newLevel } });
    }
    for (const move of reward.learnable) {
      log.push({ kind: 'canLearn', side: 'player', data: { move } });
    }
  }
}

/**
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {'player'|'foe'} side
 * @returns {Combatant}
 */
function makeCombatant(pokemon, side) {
  return {
    pokemon,
    stages: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 },
    flinched: false,
    lockedMove: null,
    turnsTaken: 0,
    usedOn: {},
    missedOn: {},
    side,
    marks: {},
    volatile: freshVolatile(),
    charging: null,
    mustRecharge: false,
    lastMove: null,
    repeats: 0,
    movedLast: false,
    turn: freshTurn(),
    // Read rather than stored: a level-up mid-battle raises it, and every
    // ability that asks about full or half health has to see that.
    get maxHp() {
      return maxHp(this.pokemon);
    },
  };
}

/**
 * The stat a combatant's number for `stat` is really read from: its Defense
 * for its Attack and the other way round, after a Power Trick or a Power
 * Shift — twice undone.
 *
 * @param {{marks?: Record<string, any>}} combatant
 * @param {string} stat
 */
function swappedStat(combatant, stat) {
  const swapped = Boolean(combatant.marks?.powerTrick) !== Boolean(combatant.marks?.powerShift);
  if (!swapped) return stat;
  return stat === 'atk' ? 'def' : stat === 'def' ? 'atk' : stat;
}

/**
 * A stat after its stage multiplier, and paralysis' Speed penalty.
 * @param {Combatant} combatant
 * @param {string} stat
 * @param {{ignorePositive?: boolean, ignoreNegative?: boolean, ignoreStages?: boolean, battle?: any}} [options]
 */
export function effectiveStat(combatant, stat, options = {}) {
  // The forme the combatant wears carries its own base stats — a Zen Mode's
  // Attack comes out of the forme, not out of the species.
  // A Transform fights on the stats it copied, all but its own Hit Points.
  // A Power Trick or a Power Shift reads each of Attack and Defense off the
  // other.
  const read = swappedStat(combatant, stat);
  const copied = read !== 'hp' ? combatant.transform?.stats?.[read] : undefined;
  const base = copied ?? statsOf(combatant.pokemon, combatant.marks?.forme)[read] ?? 1;
  let stage = options.ignoreStages ? 0 : combatant.stages[stat] ?? 0;
  if (options.ignorePositive && stage > 0) stage = 0;
  if (options.ignoreNegative && stage < 0) stage = 0;

  const battle = options.battle ?? null;
  const ability = battle ? battle.abilityOf(combatant) : null;
  const types = battle ? battle.typesOf(combatant) : speciesOf(combatant.pokemon.speciesId).types;

  // An ability and the weather both scale the finished stat rather than the
  // base one, which is where the games apply them too.
  const fromAbility = ability?.stat?.(battle.abilityContext(combatant, combatant, []), stat) ?? 1;
  const fromWeather = battle ? weatherStat(battle.weatherFor(combatant), stat, types) : 1;
  const fromRuin = battle ? battle.ruinFactor(combatant, stat) : 1;

  // An Unburden doubles the Speed of a Pokémon that has spent what it had.
  const unburdened =
    ability?.unburden && combatant.marks.hadItem && !combatant.pokemon.heldItem && stat === 'spe' ? 2 : 1;

  let value = Math.floor(
    base *
      stageMultiplier(stage) *
      heldStatMultiplier(combatant.pokemon, stat) *
      fromAbility *
      fromWeather *
      fromRuin *
      unburdened,
  );
  // Paralysis costs half the Speed it leaves, unless the ability carrying it
  // is one that turns a condition into an advantage.
  if (stat === 'spe' && combatant.pokemon.status === STATUS.PARALYSIS && !ability?.ignoresParalysis) {
    value = Math.floor(value * 0.5);
  }
  return Math.max(1, value);
}

/**
 * How much a held item changes a stat.
 *
 * A Choice Band's fifty percent, an Eviolite's half again for something that
 * still has an evolution ahead of it.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {string} stat
 */
function heldStatMultiplier(pokemon, stat) {
  const held = heldPassive(pokemon, 'stat');
  let multiplier = 1;

  if (held?.stats?.includes(stat) && itemSuits(held, pokemon)) {
    const unevolved = (speciesOf(pokemon.speciesId).evolutions ?? []).length > 0;
    if (!held.unevolvedOnly || unevolved) multiplier *= held.multiplier;
  }
  return multiplier;
}

/** Critical-hit chance by the move's crit-rate stage, as in Gen 7+. */
function criticalChance(critRate) {
  return [1 / 24, 1 / 8, 1 / 2, 1][Math.min(3, Math.max(0, critRate))];
}

/** PokeAPI ailment names mapped onto the conditions the engine models. */
const AILMENT_TO_STATUS = {
  burn: STATUS.BURN,
  poison: STATUS.POISON,
  paralysis: STATUS.PARALYSIS,
  sleep: STATUS.SLEEP,
  freeze: STATUS.FREEZE,
};

/** Types the games make immune to a condition. */
const IMMUNE_TYPES = {
  [STATUS.BURN]: ['fire'],
  [STATUS.POISON]: ['poison', 'steel'],
  [STATUS.PARALYSIS]: ['electric'],
  [STATUS.FREEZE]: ['ice'],
};

/**
 * The move that would deal the most damage this turn, by expected value.
 * @param {Battle} battle
 * @param {Combatant} attacker
 * @param {Combatant} defender
 * @param {Array<{move: string, pp: number}>} usable
 * @returns {string|null}
 */
export function bestDamageMove(battle, attacker, defender, usable) {
  let best = null;
  let bestScore = -1;

  for (const slot of usable) {
    const move = moveOf(slot.move);
    if (!move || move.damageClass === 'status') continue;
    // A type the other side simply does not take is not a choice; the games'
    // own trainers will not throw one either.
    if (cannotTouch(defender, move)) continue;
    const score = expectedDamage(attacker, defender, move);
    if (score > bestScore) {
      bestScore = score;
      best = slot.move;
    }
  }
  return best;
}

/**
 * Whether the target's typing makes this attack unable to land at all.
 *
 * Only the type chart is read: an ability that drinks a type is the
 * opponent's secret until it happens, which is how the games play it too.
 *
 * @param {Combatant} defender
 * @param {any} move
 */
export function cannotTouch(defender, move) {
  if (!move || move.damageClass === 'status') return false;
  const against = defender.marks?.types ?? speciesOf(defender.pokemon.speciesId).types;
  return typeEffectiveness(move.type, against) === 0;
}

/**
 * The moves worth reaching for at all: everything but the attacks that cannot
 * land. An empty answer means every move is one of those, and the caller may
 * as well use any of them.
 *
 * @param {Combatant} defender
 * @param {Array<{move: string, pp: number}>} usable
 */
function movesThatCanLand(defender, usable) {
  const left = usable.filter((slot) => !cannotTouch(defender, moveOf(slot.move)));
  return left.length ? left : usable;
}

/**
 * The moves that would plainly do something this turn.
 *
 * This is the net the policy falls into when none of its own conditions hold:
 * without it the companion reaches for whatever is left, which can be a burn
 * aimed at something already burning or a boost at a stage that will not
 * move. The checks are only the obvious ones — an attack the target cannot
 * take, a stage at its limit, a condition already in place, a heal at full
 * health — so nothing subtle is ruled out by guesswork.
 *
 * @param {Combatant} attacker
 * @param {Combatant} defender
 * @param {Array<{move: string, pp: number}>} usable
 */
function movesWorthUsing(attacker, defender, usable) {
  const worth = usable.filter((slot) => {
    const move = moveOf(slot.move);
    if (!move) return false;
    if (cannotTouch(defender, move)) return false;
    // A move that needs a partner, or that sends the other Pokémon away
    // before it is beaten, is not something to reach for unasked.
    if (neverAutomatic(slot.move)) return false;
    switch (categoryOf(move)) {
      case 'stat':
        return hasRoomToChange(move, attacker, defender);
      case 'status':
        return !defender.pokemon.status;
      case 'heal':
        return attacker.pokemon.hp < maxHp(attacker.pokemon);
      default:
        return true;
    }
  });
  return worth.length ? worth : movesThatCanLand(defender, usable);
}

/**
 * Each move entry's slug, by the entry itself, for the table that is loaded
 * now. Looking one up by walking the whole table was most of the time a
 * battle took.
 *
 * @type {WeakMap<object, Map<any, string>>}
 */
const ENTRY_SLUGS = new WeakMap();

/** @param {any} move */
function slugOfEntry(move) {
  const table = gameData().moves;
  let slugs = ENTRY_SLUGS.get(table);
  if (!slugs) {
    slugs = new Map(Object.entries(table).map(([slug, entry]) => [entry, slug]));
    ENTRY_SLUGS.set(table, slugs);
  }
  return slugs.get(move) ?? '';
}

/**
 * Average damage a move would do, ignoring the random spread — enough to rank
 * moves without rolling dice.
 *
 * @param {Combatant} attacker
 * @param {Combatant} defender
 * @param {any} move
 */
export function expectedDamage(attacker, defender, move) {
  // The fixed-damage moves are worth what they take.
  const slug = slugOfEntry(move);
  const fixed = estimatedFixedDamage(attacker, defender, move, slug);
  if (fixed !== null) return fixed * ((move.accuracy ?? 100) / 100);
  const weighed = weightPower(
    move,
    speciesOf(attacker.pokemon.speciesId)?.weight ?? 100,
    speciesOf(defender.pokemon.speciesId)?.weight ?? 100,
  );
  if (weighed !== null) move = { ...move, power: weighed };
  if (!move.power) return 0;
  const level = levelOf(attacker.pokemon);
  const physical = move.damageClass === 'physical';
  const attack = effectiveStat(attacker, physical ? 'atk' : 'spa');
  const defence = effectiveStat(defender, physical ? 'def' : 'spd');

  const base = Math.floor(
    Math.floor((Math.floor((2 * level) / 5 + 2) * move.power * attack) / defence) / 50,
  ) + 2;

  const types = attacker.marks?.types ?? speciesOf(attacker.pokemon.speciesId).types;
  const stab = types.includes(move.type) ? 1.5 : 1;
  const against = defender.marks?.types ?? speciesOf(defender.pokemon.speciesId).types;
  const effectiveness = typeEffectiveness(move.type, against);
  const accuracy = (move.accuracy ?? 100) / 100;
  const hits = move.meta?.minHits ? ((move.meta.minHits + (move.meta.maxHits ?? move.meta.minHits)) / 2) : 1;

  return base * stab * effectiveness * accuracy * hits * 0.925;
}

/**
 * What a fixed-damage move is worth before it is used, for ranking it: a
 * Seismic Toss its user's level, a Super Fang half of what is left, a one-hit
 * KO its thirty-in-a-hundred of everything. The ones that answer a hit are
 * worth nothing ahead of time.
 *
 * @param {Combatant} attacker
 * @param {Combatant} defender
 * @param {any} move
 * @param {string} slug
 * @returns {number|null}
 */
function estimatedFixedDamage(attacker, defender, move, slug) {
  if (move.rules?.damage === 'level') return levelOf(attacker.pokemon);
  if (typeof move.rules?.damage === 'number') return move.rules.damage;
  if (move.rules?.ohko) return levelOf(defender.pokemon) > levelOf(attacker.pokemon) ? 0 : defender.pokemon.hp * 0.3;
  if (slug === 'super-fang' || slug === 'natures-madness' || slug === 'ruination') return Math.floor(defender.pokemon.hp / 2);
  if (slug === 'endeavor') return Math.max(0, defender.pokemon.hp - attacker.pokemon.hp);
  if (slug === 'final-gambit') return attacker.pokemon.hp;
  if (RETALIATES.has(slug) || slug === 'bide') return 0;
  return null;
}

/**
 * The condition a move is used under first: its own, where the player has set
 * one, or else the one its kind starts with — the policy's `conditions`, which
 * a save from before the moves had their own keeps as it was set.
 *
 * @param {{conditions?: Record<string, string>, moves?: Record<string, string>}} policy
 * @param {string} slug
 * @returns {string}
 */
export function moveCondition(policy, slug) {
  const own = policy.moves?.[slug];
  if (own) return own;
  const move = moveOf(slug);
  return (move && policy.conditions?.[categoryOf(move)]) || 'always';
}

/**
 * The condition a move is used under second, looked at only once no move's
 * first has come round. A move starts with none, which reads as `never`.
 *
 * @param {{second?: Record<string, string>}} policy
 * @param {string} slug
 * @returns {string}
 */
export function secondCondition(policy, slug) {
  return policy.second?.[slug] || 'never';
}

/**
 * Choose a move from the player's auto-battle policy.
 *
 * Each move has two conditions, a first and a second, and the moves are tried
 * in the order they sit in their slots. A condition that names a moment — a
 * third of health left, every other turn, a foe nearly beaten — is answered
 * the moment it holds, before anything else: every move's first condition is
 * looked at before any move's second, and within each, the first move in slot
 * order wins. A move with `always` in either is only allowed, and `never` in
 * both takes it out of the fight.
 *
 * When no moment has come, the moves allowed always are left, and of those
 * the hardest-hitting attack is used — or, with no attack among them, the
 * first in slot order. Anything none of this decides falls through to the
 * strongest attack that can land.
 *
 * @param {Battle} battle
 * @param {Combatant} attacker
 * @param {Combatant} defender
 * @param {Array<{move: string, pp: number}>} usable
 * @returns {string}
 */
export function choosePolicyMove(battle, attacker, defender, usable) {
  const policy = battle.policy;

  /** What the policy could use this turn, each with its two conditions, in slot order. */
  const candidates = [];
  for (const slot of usable) {
    const move = moveOf(slot.move);
    if (!move) continue;
    // What cannot do anything in a battle of one against one, or would end it
    // unwon, is never reached for by the policy.
    if (neverAutomatic(slot.move)) continue;
    if (!worthReachingFor(move, categoryOf(move), attacker, defender)) continue;
    candidates.push({ move: slot.move, first: moveCondition(policy, slot.move), second: secondCondition(policy, slot.move) });
  }

  // A condition that names a moment is answered as soon as it comes: the
  // firsts before the seconds, and each in slot order, which is the player's
  // to set.
  for (const rank of /** @type {const} */ (['first', 'second'])) {
    const triggered = candidates.find((entry) =>
      entry[rank] !== 'always' && conditionHolds(entry[rank], battle, attacker, defender, entry.move));
    if (triggered) return triggered.move;
  }

  const pool = candidates.filter((entry) => entry.first === 'always' || entry.second === 'always').map((entry) => entry.move);
  if (pool.length) {
    const attacks = usable.filter((slot) => pool.includes(slot.move) && categoryOf(moveOf(slot.move)) === 'damage');
    return bestDamageMove(battle, attacker, defender, attacks) ?? pool[0];
  }

  // Nothing the policy allows applies this turn. Rather than stand there
  // repeating an attack the other side cannot take — which never ends and
  // never even reads as a mistake — the fallback is anything that can land.
  const worth = movesWorthUsing(attacker, defender, usable);
  return bestDamageMove(battle, attacker, defender, worth) ?? battle.rng.pick(worth).move;
}

/**
 * Whether a move the policy allows would do anything this turn: an attack the
 * other side can take, a stat move with a stage left to move, a status for a
 * foe not already suffering one, a heal with health to put back.
 *
 * @param {any} move
 * @param {string} category
 * @param {Combatant} attacker
 * @param {Combatant} defender
 */
function worthReachingFor(move, category, attacker, defender) {
  switch (category) {
    case 'damage':
      return !cannotTouch(defender, move);
    case 'stat':
      return hasRoomToChange(move, attacker, defender);
    case 'status':
      return !defender.pokemon.status;
    case 'heal':
      return attacker.pokemon.hp < maxHp(attacker.pokemon);
    default:
      return true;
  }
}

/**
 * The auto-battle category a move belongs to.
 * @param {any} move
 * @returns {'damage'|'heal'|'status'|'stat'|'field'}
 */
export function categoryOf(move) {
  if (move.damageClass !== 'status') return 'damage';
  if ((move.meta?.healing ?? 0) > 0 || hasFlag(move, 'heal')) return 'heal';
  if (move.meta?.ailment && move.meta.ailment !== 'none') return 'status';
  if (move.statChanges?.length) return 'stat';
  return 'field';
}

/**
 * Whether a move may be used this turn.
 *
 * `never` takes a move out of the fight altogether, `always` lets it be used
 * whenever nothing else comes first, and the rest name the moment it is used
 * ahead of everything else — the turn, the companion's own health or stat
 * ranks, or the foe's.
 *
 * @param {string} condition
 * @param {Battle} battle
 * @param {Combatant} attacker
 * @param {Combatant} defender
 * @param {string} slug the move it is the condition of
 */
function conditionHolds(condition, battle, attacker, defender, slug) {
  const health = () => attacker.pokemon.hp / Math.max(1, maxHp(attacker.pokemon));
  const foeHealth = () => defender.pokemon.hp / Math.max(1, maxHp(defender.pokemon));

  switch (condition) {
    case 'never':
      return false;
    // The foe's first turn out: the start of a wild battle, and each of a
    // trainer's Pokémon as it comes out.
    case 'foeEntered':
      return battle.firstTurnOut(defender);
    case 'oncePerBattle':
      return !attacker.usedOn?.[slug];
    // Once against each Pokémon the foe sends out, on whatever turn first
    // lets it: unlike the foe's first turn out, a turn something else took
    // does not lose it.
    case 'oncePerFoe':
      return !(attacker.usedAgainst?.target === defender && attacker.usedAgainst.moves.has(slug));
    // Every so many turns, counted from the turn the move was last used,
    // however it came to be: one not yet used counts from before the first
    // turn, so every two is the second, fourth, sixth — and one used on the
    // first turn goes on the third, fifth, seventh. A turn something else
    // took leaves it due on the next.
    case 'everyTwoTurns':
      return turnsSinceUsed(attacker, slug) >= 2;
    case 'everyThreeTurns':
      return turnsSinceUsed(attacker, slug) >= 3;
    // A move whose last use missed is owed another try: on the next turn, or
    // so many of its user's turns on from the miss — two is the turn after
    // next — or the first turn after that nothing else takes. A use that does
    // not miss settles it.
    case 'missedRetry':
      return Object.hasOwn(attacker.missedOn ?? {}, slug);
    // `missedThreeTurns` was folded into this one.
    case 'missedTwoTurns':
    case 'missedThreeTurns':
      return Object.hasOwn(attacker.missedOn ?? {}, slug) && turnsSinceUsed(attacker, slug) >= 2;
    // Until it has landed on the foe in front of it: tried again after a miss
    // or a block, and again for each Pokémon a trainer sends out.
    case 'untilHit':
      return !(attacker.landed?.target === defender && attacker.landed.moves.has(slug));
    // Whatever the companion used on its last turn missed: when a move that
    // never misses is worth more than a strong one that might.
    case 'lastMissed':
      return attacker.lastMissTurn !== undefined && attacker.lastMissTurn === attacker.turnsTaken;
    // Super effective or better against the foe as it stands: its types now,
    // and the move's as it would leave — an ability retyping it, the field, a
    // mask or a plate behind it. A move that deals no damage never is.
    case 'superEffective': {
      const move = moveOf(slug);
      if (!move || move.damageClass === 'status') return false;
      const used = battle.effectiveMove(attacker, defender, move, slug, { peek: true });
      return battle.effectivenessOf(attacker, used, defender) > 1;
    }
    // Who moves first on Speed alone, a Trick Room turning it round; a
    // priority move is not counted.
    case 'faster':
    case 'slower': {
      const mine = battle.speedOf(attacker);
      const theirs = battle.speedOf(defender);
      const ahead = battle.field.trickRoom > 0 ? mine < theirs : mine > theirs;
      const behind = battle.field.trickRoom > 0 ? mine > theirs : mine < theirs;
      return condition === 'faster' ? ahead : behind;
    }
    // This move, as it would land now, looks enough to finish the foe.
    case 'canFinish': {
      const move = moveOf(slug);
      if (!move || move.damageClass === 'status' || cannotTouch(defender, move)) return false;
      return expectedDamage(attacker, defender, move) >= defender.pokemon.hp;
    }
    case 'foePhysical':
      return battle.stat(defender, 'atk') >= battle.stat(defender, 'spa');
    case 'foeSpecial':
      return battle.stat(defender, 'atk') < battle.stat(defender, 'spa');
    case 'trainerBattle':
      return battle.trainerBattle;
    case 'wildBattle':
      return !battle.trainerBattle;
    case 'bossBattle':
      return battle.bossBattle;
    // The last the foe has: a wild Pokémon always is.
    case 'lastFoe':
      return battle.foeQueue.length === 0;
    case 'foeLevelHigher':
      return levelOf(defender.pokemon) > levelOf(attacker.pokemon);
    case 'foeLevelLower':
      return levelOf(defender.pokemon) < levelOf(attacker.pokemon);
    case 'noStatus':
      return !defender.pokemon.status;
    case 'foeStatus':
      return Boolean(defender.pokemon.status);
    case 'selfStatus':
      return Boolean(attacker.pokemon.status);
    case 'foeAsleep':
      return defender.pokemon.status === STATUS.SLEEP;
    // The sky as it reaches the companion: a Cloud Nine or an Umbrella hides it.
    case 'sunny':
      return battle.weatherFor(attacker) === WEATHER.SUN;
    case 'rainy':
      return battle.weatherFor(attacker) === WEATHER.RAIN;
    // Holding nothing: an Acrobatics at double power, or a berry eaten.
    case 'noItem':
      return !attacker.pokemon.heldItem;
    case 'hasField':
      return battle.field ? !battle.field.quiet : false;
    case 'noField':
      // Now that there is weather and terrain, this asks what it always read
      // as: reach for a field move when there is no field effect already.
      return battle.field ? battle.field.quiet : true;
    // A rank is any stat stage, accuracy and evasion among them: up when one
    // sits above zero, down when one sits below. Both can hold at once.
    case 'rankUp':
      return Object.values(attacker.stages).some((stage) => stage > 0);
    case 'rankDown':
      return Object.values(attacker.stages).some((stage) => stage < 0);
    case 'foeRankUp':
      return Object.values(defender.stages).some((stage) => stage > 0);
    case 'foeRankDown':
      return Object.values(defender.stages).some((stage) => stage < 0);
    case 'hpFull':
      return health() >= 1;
    case 'hpAboveHalf':
      return health() > 1 / 2;
    case 'hpTwoThirds':
      return health() <= 2 / 3;
    // `lowHp` is what half health was called before the fractions were named.
    case 'lowHp':
    case 'hpHalf':
      return health() <= 1 / 2;
    case 'hpThird':
      return health() <= 1 / 3;
    case 'hpQuarter':
      return health() <= 1 / 4;
    case 'foeHpFull':
      return foeHealth() >= 1;
    case 'foeHpAboveHalf':
      return foeHealth() > 1 / 2;
    case 'foeHpTwoThirds':
      return foeHealth() <= 2 / 3;
    case 'foeHpHalf':
      return foeHealth() <= 1 / 2;
    case 'foeHpThird':
      return foeHealth() <= 1 / 3;
    case 'foeHpQuarter':
      return foeHealth() <= 1 / 4;
    case 'always':
    default:
      return true;
  }
}

/**
 * How many of its own turns this one is past the one a move was last used on,
 * this turn included.
 *
 * @param {Combatant} attacker
 * @param {string} slug
 */
function turnsSinceUsed(attacker, slug) {
  return attacker.turnsTaken + 1 - (attacker.usedOn?.[slug] ?? 0);
}

/**
 * Whether a stat move would move any stage that is not already at its limit.
 * @param {any} move
 * @param {Combatant} attacker
 * @param {Combatant} defender
 */
function hasRoomToChange(move, attacker, defender) {
  return move.statChanges.some((change) => {
    const target = change.change > 0 ? attacker : defender;
    const stage = target.stages[change.stat] ?? 0;
    return change.change > 0 ? stage < 6 : stage > -6;
  });
}

/**
 * What a berry is worth to something that ripened it.
 *
 * A Ripen doubles the effect rather than the item, so only the numbers the
 * effect carries are touched — the condition it waits for is not.
 *
 * @param {any} held
 */
function doubled(held) {
  /** @type {Record<string, any>} */
  const out = {};
  if (held.stages) out.stages = held.stages * 2;
  if (held.heal?.fraction) out.heal = { ...held.heal, fraction: held.heal.fraction * 2 };
  if (held.heal?.amount) out.heal = { ...held.heal, amount: held.heal.amount * 2 };
  if (held.amount) out.amount = held.amount * 2;
  if (held.multiplier !== undefined && held.on === 'resist') out.multiplier = 0;
  return out;
}

/**
 * The standing allowance the player's own Pokémon fights under.
 *
 * The companion travels alone: there is no party to switch to, no second
 * chance at a bad matchup, and nobody watching to pull it out of one. So it
 * takes half of everything aimed at it, and a weakness costs it half again
 * rather than double — a double weakness, half again twice. Both come off the
 * finished number, after type effectiveness, STAB and the rest, by undoing
 * each of the chart's doublings and putting {@link COMPANION_WEAKNESS} in
 * its place.
 *
 * Only what it *takes* is touched. What it deals goes through the formula
 * untouched, so nothing about the player's own damage changes.
 *
 * @param {Combatant|null|undefined} defender
 * @param {number} effectiveness the type chart's multiplier for the hit
 * @returns {number}
 */
export function companionArmour(defender, effectiveness) {
  if (defender?.side !== 'player') return 1;
  const weaknesses = effectiveness > 1 ? Math.log2(effectiveness) : 0;
  return COMPANION_DAMAGE_TAKEN * (COMPANION_WEAKNESS / 2) ** weaknesses;
}
