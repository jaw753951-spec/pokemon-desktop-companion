/**
 * Pokémon Showdown's move table, read as the object it is.
 *
 * The table is a TypeScript module, one object literal per move, and a move's
 * effect is spread across a dozen optional fields — `self.boosts` for what it
 * does to its user, `secondary` for its chance of doing something to the
 * target, `multihit`, `drain`, `recoil`, `willCrit` and the rest. Reading all
 * of that with regular expressions would be a parser for a language written
 * by hand; the TypeScript compiler this repository already depends on turns
 * the module into plain JavaScript, and running that gives the table itself.
 * The move functions (`onHit`, `basePowerCallback`) come along as functions
 * and are never called — only the plain fields are read.
 */
import vm from 'node:vm';
import ts from 'typescript';

/**
 * @param {string} source the text of `data/moves.ts`
 * @returns {Record<string, any>} keyed by Showdown's move id
 */
export function evaluateShowdownMoves(source) {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: /** @type {Record<string, any>} */ ({}) };
  vm.runInNewContext(js, { exports: module.exports, module, require: () => ({}) });
  return module.exports.Moves ?? {};
}

/** Showdown's condition codes, in the names the move data spells ailments with. */
const STATUS_AILMENTS = {
  brn: 'burn',
  par: 'paralysis',
  slp: 'sleep',
  frz: 'freeze',
  psn: 'poison',
  tox: 'poison',
};

/** Showdown's stat keys, in the keys the move data files stat changes under. */
const BOOST_KEYS = {
  atk: 'atk',
  def: 'def',
  spa: 'spa',
  spd: 'spd',
  spe: 'spe',
  accuracy: 'accuracy',
  evasion: 'evasion',
};

/** Targets that mean the move acts on its own user. */
const SELF_TARGETS = new Set(['self', 'adjacentAllyOrSelf', 'allies', 'allySide', 'allyTeam']);

/** Targets that can only ever mean a partner, which a single battle does not have. */
const ALLY_TARGETS = new Set(['adjacentAlly']);

/**
 * Everything the battle needs to know about one move that PokeAPI does not
 * say, or says for a generation long gone: who each stat change lands on, and
 * the side effects of the newest moves, which PokeAPI publishes with no effect
 * data at all.
 *
 * @param {any} sd the Showdown record
 */
export function showdownEffect(sd) {
  /**
   * `self` says who a stage lands on; `secondary` whether it is a side
   * effect — something a Sheer Force trades away and a Serene Grace makes
   * likelier — rather than the price of the move itself, as a Close Combat's
   * drops are.
   *
   * @type {Array<{stat: string, change: number, self: boolean, secondary: boolean}>}
   */
  const stats = [];
  let statChance = 0;
  const addBoosts = (boosts, self, chance, secondary = false) => {
    for (const [key, change] of Object.entries(boosts ?? {})) {
      const stat = BOOST_KEYS[key];
      if (!stat || !change) continue;
      stats.push({ stat, change: Number(change), self, secondary });
      statChance = Math.max(statChance, chance);
    }
  };

  const selfTargeted = SELF_TARGETS.has(sd.target);
  // A status move's own boosts land wherever the move is aimed.
  addBoosts(sd.boosts, selfTargeted, 100);
  addBoosts(sd.self?.boosts, true, 100);
  addBoosts(sd.selfBoost?.boosts, true, 100);

  /** @type {{ailment: string|null, ailmentChance: number, flinchChance: number, toxic: boolean}} */
  const secondary = { ailment: null, ailmentChance: 0, flinchChance: 0, toxic: false };
  const secondaries = [...(sd.secondaries ?? []), ...(sd.secondary ? [sd.secondary] : [])];
  for (const effect of secondaries) {
    const chance = effect.chance ?? 100;
    if (effect.status && STATUS_AILMENTS[effect.status]) {
      secondary.ailment = STATUS_AILMENTS[effect.status];
      secondary.ailmentChance = chance;
      if (effect.status === 'tox') secondary.toxic = true;
    }
    if (effect.volatileStatus === 'confusion') {
      secondary.ailment = 'confusion';
      secondary.ailmentChance = chance;
    }
    if (effect.volatileStatus === 'flinch') secondary.flinchChance = chance;
    addBoosts(effect.boosts, false, chance, true);
    addBoosts(effect.self?.boosts, true, chance, true);
  }
  // A status move's own condition.
  if (sd.status && STATUS_AILMENTS[sd.status]) {
    secondary.ailment = STATUS_AILMENTS[sd.status];
    if (sd.status === 'tox') secondary.toxic = true;
  }
  if (sd.volatileStatus === 'confusion' && !secondary.ailment) secondary.ailment = 'confusion';

  const fraction = (pair) => (Array.isArray(pair) ? Math.round((pair[0] / pair[1]) * 100) : 0);
  const hits = Array.isArray(sd.multihit) ? sd.multihit : sd.multihit ? [sd.multihit, sd.multihit] : null;

  return {
    accuracy: sd.accuracy === true ? null : sd.accuracy,
    pp: Number.isInteger(sd.pp) && sd.pp > 0 ? sd.pp : null,
    stats,
    statChance,
    secondary,
    minHits: hits?.[0] ?? null,
    maxHits: hits?.[1] ?? null,
    multiAccuracy: Boolean(sd.multiaccuracy),
    // Whether the games count the move as having a secondary effect — what a
    // Sheer Force trades away and is paid for. A Stone Axe says so with an
    // empty record, its hazard being laid by a rule of its own.
    hasSecondary: sd.category !== 'Status' && Boolean(sd.secondary || sd.secondaries?.length),
    drain: fraction(sd.drain) || -fraction(sd.recoil),
    healing: fraction(sd.heal),
    critRate: sd.willCrit ? 6 : sd.critRatio ? sd.critRatio - 1 : 0,
    ally: ALLY_TARGETS.has(sd.target),
    // The plain fields the battle reads by name; everything else about a
    // move is in its slug.
    rules: pickRules(sd),
  };
}

/**
 * The simple Showdown fields the battle can act on generically.
 *
 * @param {any} sd
 */
function pickRules(sd) {
  /** @type {Record<string, any>} */
  const out = {};
  const copy = (key, value = sd[key]) => {
    if (value !== undefined && value !== null && value !== false) out[key] = value;
  };
  copy('damage'); // "level", or a fixed number
  copy('ohko');
  copy('overrideOffensiveStat');
  copy('overrideOffensivePokemon');
  copy('overrideDefensiveStat');
  copy('ignoreDefensive');
  copy('ignoreEvasion');
  copy('ignoreImmunity');
  copy('breaksProtect');
  copy('forceSwitch');
  copy('selfSwitch');
  copy('thawsTarget');
  copy('hasCrashDamage');
  copy('mindBlownRecoil');
  copy('struggleRecoil');
  copy('stallingMove');
  copy('sleepUsable');
  copy('volatileStatus');
  copy('sideCondition');
  copy('slotCondition');
  copy('pseudoWeather');
  copy('selfdestruct');
  copy('callsMove');
  copy('smartTarget');
  copy('tracksTarget');
  copy('stealsBoosts');
  copy('isFutureMove');
  copy('noSketch');
  // An attack Showdown does not mark as stoppable by a Protect goes through
  // one: a Hyper Drill, a Mighty Cleave.
  copy('unprotectable', sd.category !== 'Status' && !sd.flags?.protect);
  // Mold Breaker built into the move: a Sunsteel Strike, a Photon Geyser.
  copy('ignoreAbility');
  // What a Snatch can take off the Pokémon about to use it.
  copy('snatchable', Boolean(sd.flags?.snatch));
  copy('selfVolatile', sd.self?.volatileStatus);
  copy('secondaryVolatile', sd.secondary?.volatileStatus && sd.secondary.volatileStatus !== 'flinch' && sd.secondary.volatileStatus !== 'confusion' ? sd.secondary.volatileStatus : undefined);
  copy('sideVolatile', sd.self?.sideCondition);
  return out;
}
