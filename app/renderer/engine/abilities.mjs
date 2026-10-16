/**
 * What a Pokémon's ability does.
 *
 * Every Pokémon in this game has had an ability since the day it was rolled —
 * it is in the save, the screens have shown it, and evolution has carried it
 * across — and until now not one of them did anything. This is the table that
 * makes them act.
 *
 * The names and the sentences come from the data, as everything else does;
 * what cannot come from there is the behaviour, because an ability's effect
 * text is prose written for a person ("Has a 30% chance of paralyzing
 * attacking Pokémon on contact") and there is no grammar to parse it by. So
 * each one is written here, in the shape of the moment it acts in, and an
 * ability not in the table is one the engine has not learned yet — which the
 * Pokémon screen says out loud rather than leaving a player to wonder.
 *
 * Every hook is optional and every one is handed the same `ctx`:
 *
 * - `self` and `foe`, the two combatants, `self` being the one whose ability
 *   this is — so a hook never has to work out which side it is on;
 * - `weather` and `terrain`, already resolved, so an ability suppressed by a
 *   Cloud Nine on the other side simply sees no weather;
 * - `note`, `damage`, `heal`, `raise` and `inflict`, which do the thing and
 *   write the line about it, because an ability that acts silently reads as a
 *   bug from the other side of the screen.
 */
import { moveHasFlag as hasFlag, speciesOf } from '../core/data.mjs';
import { formeAbility } from './forms.mjs';
import { WEATHER, TERRAIN } from './field.mjs';

/** A quarter of maximum HP, which is what most absorbing abilities pay. */
const ABSORB_HEAL = 1 / 4;

/** The twenty percent the -ate abilities add to what they have retyped. */
const platePower = (ctx, move) => (ctx.retyped ? 1.2 : 1);

/**
 * The abilities the engine has been taught, keyed by the slug the dex files
 * them under.
 *
 * @type {Record<string, any>}
 */
export const ABILITIES = {
  // ---- Raw stat multipliers.

  'huge-power': { stat: (ctx, stat) => (stat === 'atk' ? 2 : 1) },
  'pure-power': { stat: (ctx, stat) => (stat === 'atk' ? 2 : 1) },
  // Half again on the Attack, for the price a Choice Band charges: one move.
  'gorilla-tactics': { stat: (ctx, stat) => (stat === 'atk' ? 1.5 : 1), choiceLock: true },
  'fur-coat': { stat: (ctx, stat) => (stat === 'def' ? 2 : 1) },
  hustle: {
    stat: (ctx, stat) => (stat === 'atk' ? 1.5 : 1),
    // The Attack it buys is paid for out of the accuracy of the moves that
    // use it.
    accuracy: (ctx, move) => (move.damageClass === 'physical' ? 0.8 : 1),
  },
  defeatist: {
    stat: (ctx, stat) => (halfHealth(ctx.self) && (stat === 'atk' || stat === 'spa') ? 0.5 : 1),
  },

  // Conditions the holder turns to its advantage rather than suffering.
  guts: { stat: (ctx, stat) => (ctx.self.pokemon.status && stat === 'atk' ? 1.5 : 1), ignoresBurn: true },
  'quick-feet': { stat: (ctx, stat) => (ctx.self.pokemon.status && stat === 'spe' ? 1.5 : 1), ignoresParalysis: true },
  'marvel-scale': { stat: (ctx, stat) => (ctx.self.pokemon.status && stat === 'def' ? 1.5 : 1) },

  // Weather, read as a stat.
  chlorophyll: { stat: (ctx, stat) => (ctx.weather === WEATHER.SUN && stat === 'spe' ? 2 : 1) },
  'swift-swim': { stat: (ctx, stat) => (ctx.weather === WEATHER.RAIN && stat === 'spe' ? 2 : 1) },
  'sand-rush': { stat: (ctx, stat) => (ctx.weather === WEATHER.SANDSTORM && stat === 'spe' ? 2 : 1), weatherImmune: true },
  'slush-rush': { stat: (ctx, stat) => (snowing(ctx.weather) && stat === 'spe' ? 2 : 1) },
  'flower-gift': {
    stat: (ctx, stat) => (ctx.weather === WEATHER.SUN && (stat === 'atk' || stat === 'spd') ? 1.5 : 1),
  },
  'solar-power': {
    stat: (ctx, stat) => (ctx.weather === WEATHER.SUN && stat === 'spa' ? 1.5 : 1),
    // The sun it draws on burns it too.
    turn: (ctx) => {
      if (ctx.weather === WEATHER.SUN) ctx.damage(ctx.self, 1 / 8);
    },
  },
  'grass-pelt': { stat: (ctx, stat) => (ctx.terrain === TERRAIN.GRASSY && stat === 'def' ? 1.5 : 1) },

  // ---- What a move is worth in the holder's hands.

  'iron-fist': { power: (ctx, move) => (hasFlag(move, 'punch') ? 1.2 : 1) },
  'strong-jaw': { power: (ctx, move) => (hasFlag(move, 'bite') ? 1.5 : 1) },
  'mega-launcher': { power: (ctx, move) => (hasFlag(move, 'pulse') ? 1.5 : 1) },
  sharpness: { power: (ctx, move) => (hasFlag(move, 'slicing') ? 1.5 : 1) },
  'tough-claws': { power: (ctx, move) => (hasFlag(move, 'contact') ? 1.3 : 1) },
  'punk-rock': {
    power: (ctx, move) => (hasFlag(move, 'sound') ? 1.3 : 1),
    taken: (ctx, move) => (hasFlag(move, 'sound') ? 0.5 : 1),
  },
  technician: { power: (ctx, move) => ((move.power ?? 0) > 0 && move.power <= 60 ? 1.5 : 1) },
  reckless: { power: (ctx, move) => ((move.meta?.drain ?? 0) < 0 ? 1.2 : 1) },
  // Half again on top of the half again a matching type already gives, which
  // comes to four thirds of the ordinary bonus.
  adaptability: { power: (ctx, move) => (stab(ctx.self, move) ? 4 / 3 : 1) },
  analytic: { power: (ctx) => (ctx.movingLast ? 1.3 : 1) },
  neuroforce: { power: (ctx, move, effectiveness) => (effectiveness > 1 ? 1.25 : 1) },
  'tinted-lens': { power: (ctx, move, effectiveness) => (effectiveness > 0 && effectiveness < 1 ? 2 : 1) },
  'sheer-force': { power: (ctx, move) => (hasSecondary(move) ? 1.3 : 1), noSecondary: true },
  'sand-force': {
    power: (ctx, move) =>
      ctx.weather === WEATHER.SANDSTORM && ['rock', 'ground', 'steel'].includes(move.type) ? 1.3 : 1,
    weatherImmune: true,
  },
  transistor: { power: (ctx, move) => (move.type === 'electric' ? 1.3 : 1) },
  'dragons-maw': { power: (ctx, move) => (move.type === 'dragon' ? 1.5 : 1) },
  'rocky-payload': { power: (ctx, move) => (move.type === 'rock' ? 1.5 : 1) },
  steelworker: { power: (ctx, move) => (move.type === 'steel' ? 1.5 : 1) },
  'water-bubble': {
    power: (ctx, move) => (move.type === 'water' ? 2 : 1),
    taken: (ctx, move) => (move.type === 'fire' ? 0.5 : 1),
    blockStatus: (ctx, status) => status === 'brn',
  },

  // The four pinch abilities, which are the same ability four times over.
  overgrow: { power: (ctx, move) => pinch(ctx, move, 'grass') },
  blaze: { power: (ctx, move) => pinch(ctx, move, 'fire') },
  torrent: { power: (ctx, move) => pinch(ctx, move, 'water') },
  swarm: { power: (ctx, move) => pinch(ctx, move, 'bug') },

  // The ones that change what type a move is on the way out.
  aerilate: { moveType: (ctx, move) => (move.type === 'normal' ? 'flying' : null), power: platePower },
  pixilate: { moveType: (ctx, move) => (move.type === 'normal' ? 'fairy' : null), power: platePower },
  refrigerate: { moveType: (ctx, move) => (move.type === 'normal' ? 'ice' : null), power: platePower },
  galvanize: { moveType: (ctx, move) => (move.type === 'normal' ? 'electric' : null), power: platePower },
  // Everything turns Normal, and everything — Normal to begin with or not —
  // is a fifth stronger for it.
  normalize: { moveType: (ctx, move) => (move.type === 'normal' ? null : 'normal'), power: () => 1.2 },
  'liquid-voice': { moveType: (ctx, move) => (hasFlag(move, 'sound') ? 'water' : null) },

  // ---- What the holder takes.

  'thick-fat': { taken: (ctx, move) => (move.type === 'fire' || move.type === 'ice' ? 0.5 : 1) },
  heatproof: { taken: (ctx, move) => (move.type === 'fire' ? 0.5 : 1), burnHalved: true },
  'ice-scales': { taken: (ctx, move) => (move.damageClass === 'special' ? 0.5 : 1) },
  fluffy: {
    taken: (ctx, move) => (move.type === 'fire' ? 2 : hasFlag(move, 'contact') ? 0.5 : 1),
  },
  multiscale: { taken: (ctx) => (fullHealth(ctx.self) ? 0.5 : 1) },
  'shadow-shield': { taken: (ctx) => (fullHealth(ctx.self) ? 0.5 : 1) },
  'solid-rock': { taken: (ctx, move, effectiveness) => (effectiveness > 1 ? 0.75 : 1) },
  filter: { taken: (ctx, move, effectiveness) => (effectiveness > 1 ? 0.75 : 1) },
  'prism-armor': { taken: (ctx, move, effectiveness) => (effectiveness > 1 ? 0.75 : 1) },
  'purifying-salt': {
    taken: (ctx, move) => (move.type === 'ghost' ? 0.5 : 1),
    blockStatus: () => true,
  },

  // ---- Types the holder is simply not hit by, and the ones it drinks.

  levitate: { absorb: (ctx, move) => (move.type === 'ground' ? {} : null), floats: true },
  'volt-absorb': { absorb: (ctx, move) => (move.type === 'electric' ? { heal: ABSORB_HEAL } : null) },
  'water-absorb': { absorb: (ctx, move) => (move.type === 'water' ? { heal: ABSORB_HEAL } : null) },
  'earth-eater': { absorb: (ctx, move) => (move.type === 'ground' ? { heal: ABSORB_HEAL } : null) },
  'lightning-rod': { absorb: (ctx, move) => (move.type === 'electric' ? { stat: 'spa', stages: 1 } : null) },
  'storm-drain': { absorb: (ctx, move) => (move.type === 'water' ? { stat: 'spa', stages: 1 } : null) },
  'motor-drive': { absorb: (ctx, move) => (move.type === 'electric' ? { stat: 'spe', stages: 1 } : null) },
  'sap-sipper': { absorb: (ctx, move) => (move.type === 'grass' ? { stat: 'atk', stages: 1 } : null) },
  'well-baked-body': { absorb: (ctx, move) => (move.type === 'fire' ? { stat: 'def', stages: 2 } : null) },
  'wind-rider': { absorb: (ctx, move) => (hasFlag(move, 'wind') ? { stat: 'atk', stages: 1 } : null) },
  'flash-fire': {
    absorb: (ctx, move) => (move.type === 'fire' ? { mark: 'flashFire' } : null),
    power: (ctx, move) => (ctx.self.marks.flashFire && move.type === 'fire' ? 1.5 : 1),
  },
  'dry-skin': {
    absorb: (ctx, move) => (move.type === 'water' ? { heal: ABSORB_HEAL } : null),
    taken: (ctx, move) => (move.type === 'fire' ? 1.25 : 1),
    // It drinks the rain and dries out in the sun.
    turn: (ctx) => {
      if (ctx.weather === WEATHER.RAIN) ctx.heal(ctx.self, 1 / 8);
      if (ctx.weather === WEATHER.SUN) ctx.damage(ctx.self, 1 / 8);
    },
  },

  // Whole classes of move the holder is deaf, sealed or armoured against.
  soundproof: { blockMove: (ctx, move) => hasFlag(move, 'sound') },
  bulletproof: { blockMove: (ctx, move) => hasFlag(move, 'bullet') },
  overcoat: { blockMove: (ctx, move) => hasFlag(move, 'powder'), weatherImmune: true },
  'good-as-gold': { blockMove: (ctx, move) => move.damageClass === 'status' },
  'magic-guard': { weatherImmune: true, indirectImmune: true },
  'rock-head': { recoilImmune: true },

  // ---- What answering a hit costs the attacker.

  static: { contact: (ctx) => ctx.inflict(ctx.foe, 'par', 0.3) },
  'flame-body': { contact: (ctx) => ctx.inflict(ctx.foe, 'brn', 0.3) },
  'poison-point': { contact: (ctx) => ctx.inflict(ctx.foe, 'psn', 0.3) },
  'effect-spore': {
    contact: (ctx) => {
      if (!ctx.rng.chance(0.3)) return;
      ctx.inflict(ctx.foe, ctx.rng.pick(['par', 'psn', 'slp']), 1);
    },
  },
  'rough-skin': { contact: (ctx) => ctx.damage(ctx.foe, 1 / 8) },
  'iron-barbs': { contact: (ctx) => ctx.damage(ctx.foe, 1 / 8) },
  gooey: { contact: (ctx) => ctx.raise(ctx.foe, 'spe', -1) },
  'tangling-hair': { contact: (ctx) => ctx.raise(ctx.foe, 'spe', -1) },
  aftermath: { faint: (ctx) => { if (ctx.byContact) ctx.damage(ctx.foe, 1 / 4); } },

  // And what taking one is turned into.
  justified: { hit: (ctx, move) => { if (move.type === 'dark') ctx.raise(ctx.self, 'atk', 1); } },
  rattled: {
    hit: (ctx, move) => {
      if (['bug', 'ghost', 'dark'].includes(move.type)) ctx.raise(ctx.self, 'spe', 1);
    },
    // And an Intimidate frightens it into running faster.
    onIntimidated: (ctx) => ctx.raise(ctx.self, 'spe', 1),
  },
  'water-compaction': { hit: (ctx, move) => { if (move.type === 'water') ctx.raise(ctx.self, 'def', 2); } },
  'steam-engine': {
    hit: (ctx, move) => {
      if (move.type === 'fire' || move.type === 'water') ctx.raise(ctx.self, 'spe', 6);
    },
  },
  'thermal-exchange': {
    hit: (ctx, move) => { if (move.type === 'fire') ctx.raise(ctx.self, 'atk', 1); },
    blockStatus: (ctx, status) => status === 'brn',
  },
  stamina: { hit: (ctx) => ctx.raise(ctx.self, 'def', 1) },
  'weak-armor': {
    hit: (ctx, move) => {
      if (move.damageClass !== 'physical') return;
      ctx.raise(ctx.self, 'def', -1);
      ctx.raise(ctx.self, 'spe', 2);
    },
  },
  'cotton-down': { hit: (ctx) => ctx.raise(ctx.foe, 'spe', -1) },
  berserk: {
    hit: (ctx, move, damage) => {
      if (crossedHalf(ctx.self, damage)) ctx.raise(ctx.self, 'spa', 1);
    },
  },
  'anger-shell': {
    hit: (ctx, move, damage) => {
      if (!crossedHalf(ctx.self, damage)) return;
      for (const stat of ['atk', 'spa', 'spe']) ctx.raise(ctx.self, stat, 1);
      for (const stat of ['def', 'spd']) ctx.raise(ctx.self, stat, -1);
    },
  },
  'sand-spit': { hit: (ctx) => ctx.setWeather(WEATHER.SANDSTORM), weatherImmune: true },
  'seed-sower': { hit: (ctx) => ctx.setTerrain(TERRAIN.GRASSY) },

  // ---- Conditions the holder does not take.

  immunity: { blockStatus: (ctx, status) => status === 'psn' },
  'pastel-veil': { blockStatus: (ctx, status) => status === 'psn' },
  limber: { blockStatus: (ctx, status) => status === 'par' },
  insomnia: { blockStatus: (ctx, status) => status === 'slp' },
  'vital-spirit': { blockStatus: (ctx, status) => status === 'slp' },
  'sweet-veil': { blockStatus: (ctx, status) => status === 'slp' },
  'water-veil': { blockStatus: (ctx, status) => status === 'brn' },
  'magma-armor': { blockStatus: (ctx, status) => status === 'frz' },
  comatose: { blockStatus: () => true },
  'leaf-guard': { blockStatus: (ctx) => ctx.weather === WEATHER.SUN },

  // ---- Weather and terrain the holder brings with it.

  drought: { start: (ctx) => ctx.setWeather(WEATHER.SUN) },
  'orichalcum-pulse': { start: (ctx) => ctx.setWeather(WEATHER.SUN) },
  drizzle: { start: (ctx) => ctx.setWeather(WEATHER.RAIN) },
  'sand-stream': { start: (ctx) => ctx.setWeather(WEATHER.SANDSTORM), weatherImmune: true },
  'snow-warning': { start: (ctx) => ctx.setWeather(WEATHER.SNOW) },
  forecast: {},
  // The primal weathers, as the ordinary ones: this game's weather set a
  // Pokémon calls up already lasts the battle.
  'primordial-sea': { start: (ctx) => ctx.setWeather(WEATHER.RAIN) },
  'desolate-land': { start: (ctx) => ctx.setWeather(WEATHER.SUN) },
  // These are the forme change itself, which `forms.mjs` and the battle
  // make; the ability has nothing else to do. Tera Shift's forme is the
  // Terastal one, which this game does not have, so it does nothing at all.
  'tera-shift': {},
  multitype: {},
  'rks-system': {},
  'zen-mode': {},
  schooling: {},
  // Its meteor shell — the species' own shape, above half — keeps every
  // condition off.
  'shields-down': { blockStatus: (ctx) => !ctx.self.marks.forme },
  // Blade to strike, Shield to guard: the battle turns it before each move.
  'stance-change': { stanceChange: true },
  // Full, then hungry, a turn at a time; its Aura Wheel follows (see
  // `effectiveMove`).
  'hunger-switch': {
    turn: (ctx) => {
      ctx.self.marks.hangry = !ctx.self.marks.hangry;
    },
  },

  // ---- The Paradox Pokémon's boost: the highest stat, half again for Speed
  // and three-tenths for the rest, in harsh sun or on Electric Terrain — or
  // on a Booster Energy, spent the moment there is neither.
  protosynthesis: paradoxBoost((ctx) => ctx.weather === WEATHER.SUN),
  'quark-drive': paradoxBoost((ctx) => ctx.terrain === TERRAIN.ELECTRIC),

  // ---- Copying.
  // A Ditto walks in as whatever it faces.
  imposter: { start: (ctx) => ctx.transform(ctx.foe) },

  // ---- Touching it changes what you are.
  mummy: { contact: (ctx) => ctx.replaceAbility(ctx.foe, 'mummy') },
  'lingering-aroma': { contact: (ctx) => ctx.replaceAbility(ctx.foe, 'lingering-aroma') },
  'wandering-spirit': { contact: (ctx) => ctx.swapAbilities() },

  // ---- On the field for everyone: a Fairy or Dark move a third stronger,
  // and an Aura Break turning both round (see `auraMultiplier`).
  'fairy-aura': { aura: 'fairy' },
  'dark-aura': { aura: 'dark' },
  'aura-break': { auraBreak: true },

  // Every other ability goes quiet while this one is out.
  'neutralizing-gas': { neutralizes: true },

  'steely-spirit': { power: (ctx, move) => (move.type === 'steel' ? 1.5 : 1) },
  // What the weight moves weigh it at (see `weightOf`).
  'heavy-metal': { weight: 2 },
  'light-metal': { weight: 0.5 },
  // It reads what the other side is holding as it comes in.
  frisk: {
    start: (ctx) => {
      if (ctx.foe.pokemon.heldItem) ctx.note('frisked', { item: ctx.foe.pokemon.heldItem });
    },
  },
  // Its held item does nothing (see `heldPassive`).
  klutz: {},

  // ---- After the battle (see `afterBattle`).
  'natural-cure': {},
  regenerator: {},
  pickup: {},
  // Honey now and then after a battle; the first ball that misses, fetched
  // back (see the battle and capture screens).
  'honey-gather': {},
  'ball-fetch': {},

  // The Cramorant that dived after something: it catches on a Surf or a
  // Dive and spits the catch at the next thing that hits it (see `answerHit`).
  'gulp-missile': { gulpMissile: true },

  // A Mimikyu's head is not its face: the hit that lands on it breaks the
  // disguise and does nothing else, and the busted shape hangs about for
  // the rest of the battle.
  disguise: { busted: true },
  'electric-surge': { start: (ctx) => ctx.setTerrain(TERRAIN.ELECTRIC) },
  'hadron-engine': { start: (ctx) => ctx.setTerrain(TERRAIN.ELECTRIC) },
  'grassy-surge': { start: (ctx) => ctx.setTerrain(TERRAIN.GRASSY) },
  'misty-surge': { start: (ctx) => ctx.setTerrain(TERRAIN.MISTY) },
  'psychic-surge': { start: (ctx) => ctx.setTerrain(TERRAIN.PSYCHIC) },
  'cloud-nine': { suppressWeather: true },
  'air-lock': { suppressWeather: true },

  // ---- What the holder does on the way in.

  intimidate: { start: (ctx) => ctx.intimidate() },
  'intrepid-sword': { start: (ctx) => ctx.raise(ctx.self, 'atk', 1) },
  'dauntless-shield': { start: (ctx) => ctx.raise(ctx.self, 'def', 1) },
  download: {
    // It reads which wall is lower and raises the offence that goes through it.
    start: (ctx) => {
      const stats = ctx.statsOf(ctx.foe);
      ctx.raise(ctx.self, stats.def <= stats.spd ? 'atk' : 'spa', 1);
    },
  },
  // It copies the ability in front of it for the rest of the battle — never
  // for good — and the copy acts on the way in, as it would have.
  trace: {
    start: (ctx) => {
      const copied = ctx.abilitySlug(ctx.foe);
      if (!copied || UNTRACEABLE.has(copied)) return;
      ctx.self.marks.ability = copied;
      ctx.note('abilityTraced', { ability: copied });
      ABILITIES[copied]?.start?.(ctx);
    },
  },

  // ---- Landing a hit, and being hard to land one on.

  'compound-eyes': { accuracy: () => 1.3 },
  'victory-star': { accuracy: () => 1.1 },
  'no-guard': { neverMisses: true },
  'keen-eye': { ignoresEvasion: true, statDrop: (ctx, stat) => stat === 'acc' },
  illuminate: { ignoresEvasion: true, statDrop: (ctx, stat) => stat === 'acc' },
  'sand-veil': { evasion: (ctx) => (ctx.weather === WEATHER.SANDSTORM ? 0.8 : 1), weatherImmune: true },
  'snow-cloak': { evasion: (ctx) => (snowing(ctx.weather) ? 0.8 : 1), weatherImmune: true },
  'wonder-skin': { evasion: (ctx, move) => (move.damageClass === 'status' ? 0.5 : 1) },

  'super-luck': { crit: () => ({ stages: 1 }) },
  'battle-armor': { crit: () => ({ immune: true }) },
  'shell-armor': { crit: () => ({ immune: true }) },
  merciless: { crit: (ctx) => ({ always: ctx.foe.pokemon.status === 'psn' }) },
  sniper: { critBonus: 1.5 },

  'serene-grace': { secondary: 2 },
  'skill-link': { maxHits: true },
  sturdy: { sturdy: true },
  'inner-focus': { flinchImmune: true, intimidateImmune: true },
  steadfast: { onFlinch: (ctx) => ctx.raise(ctx.self, 'spe', 1) },
  stench: { flinch: 0.1 },
  'mold-breaker': { ignoresAbilities: true },
  turboblaze: { ignoresAbilities: true },
  teravolt: { ignoresAbilities: true },

  // ---- Who moves first.

  // A status move a Prankster hurried does nothing to a Dark type (see
  // `resolveMove`).
  prankster: { priority: (ctx, move) => (move.damageClass === 'status' ? 1 : 0), prankster: true },
  'gale-wings': { priority: (ctx, move) => (move.type === 'flying' && fullHealth(ctx.self) ? 1 : 0) },
  triage: { priority: (ctx, move) => (hasFlag(move, 'heal') ? 3 : 0) },
  'quick-draw': { movesFirst: 0.3 },
  stall: { movesLast: true },

  // ---- Upkeep.

  'speed-boost': { turn: (ctx) => ctx.raise(ctx.self, 'spe', 1) },
  'rain-dish': { turn: (ctx) => { if (ctx.weather === WEATHER.RAIN) ctx.heal(ctx.self, 1 / 16); } },
  'ice-body': {
    turn: (ctx) => { if (snowing(ctx.weather)) ctx.heal(ctx.self, 1 / 16); },
    weatherImmune: true,
  },
  'poison-heal': {
    // The poison feeds it instead of biting, which is the whole of it.
    turn: (ctx) => { if (ctx.self.pokemon.status === 'psn') ctx.heal(ctx.self, 1 / 8); },
    feedsOnPoison: true,
  },
  'shed-skin': {
    turn: (ctx) => {
      if (ctx.self.pokemon.status && ctx.rng.chance(1 / 3)) ctx.cure(ctx.self);
    },
  },
  hydration: {
    turn: (ctx) => {
      if (ctx.weather === WEATHER.RAIN && ctx.self.pokemon.status) ctx.cure(ctx.self);
    },
  },
  'bad-dreams': {
    turn: (ctx) => { if (ctx.foe.pokemon.status === 'slp') ctx.damage(ctx.foe, 1 / 8); },
  },
  // An Ice Face takes one physical blow and melts; snow freezes it back
  // (see `formeFor`).
  'ice-face': { busted: 'physical', refreezes: true },

  // ---- Stats the other side is not allowed to touch.

  'clear-body': { statDrop: () => true },
  'white-smoke': { statDrop: () => true },
  'full-metal-body': { statDrop: () => true },
  'hyper-cutter': { statDrop: (ctx, stat) => stat === 'atk' },
  'big-pecks': { statDrop: (ctx, stat) => stat === 'def' },
  'mirror-armor': { reflectsDrops: true },

  // And the ones that answer a drop rather than refuse it.
  defiant: { onStatDropped: (ctx) => ctx.raise(ctx.self, 'atk', 2) },
  competitive: { onStatDropped: (ctx) => ctx.raise(ctx.self, 'spa', 2) },
  'anger-point': { onCrit: (ctx) => ctx.raise(ctx.self, 'atk', 12) },
  // An Intimidate raises its Attack instead, and nothing drags it out.
  'guard-dog': { intimidateBoost: true, suctionCups: true },
  // Nothing drags it out either: a Roar, a Whirlwind, a Dragon Tail.
  'suction-cups': { suctionCups: true },

  // The three that read the whole table differently.
  contrary: { invertStages: true },
  simple: { doubleStages: true },
  unaware: { ignoresStages: true },

  // ---- What taking something down is worth.

  moxie: { onKnockOut: (ctx) => ctx.raise(ctx.self, 'atk', 1) },
  'chilling-neigh': { onKnockOut: (ctx) => ctx.raise(ctx.self, 'atk', 1) },
  'grim-neigh': { onKnockOut: (ctx) => ctx.raise(ctx.self, 'spa', 1) },
  'soul-heart': { onKnockOut: (ctx) => ctx.raise(ctx.self, 'spa', 1) },
  'as-one-glastrier': { onKnockOut: (ctx) => ctx.raise(ctx.self, 'atk', 1), blocksBerries: true },
  'as-one-spectrier': { onKnockOut: (ctx) => ctx.raise(ctx.self, 'spa', 1), blocksBerries: true },
  'beast-boost': {
    // Whichever of its own stats is highest, which is what makes it read as a
    // different ability on every Pokémon that has it.
    onKnockOut: (ctx) => {
      const stats = ctx.statsOf(ctx.self);
      const best = ['atk', 'def', 'spa', 'spd', 'spe'].reduce((a, b) => (stats[b] > stats[a] ? b : a));
      ctx.raise(ctx.self, best, 1);
    },
  },
  'supreme-overlord': { onKnockOut: (ctx) => { ctx.raise(ctx.self, 'atk', 1); ctx.raise(ctx.self, 'spa', 1); } },

  // ---- Being a different type from the one on the card.

  protean: { retypes: 'move' },
  libero: { retypes: 'move' },
  'color-change': { retypes: 'hit' },
  // It takes the type of the terrain it stands on (see `typesOf`).
  mimicry: { mimicry: true },
  scrappy: { hitsGhosts: true, intimidateImmune: true },
  'minds-eye': { hitsGhosts: true, ignoresEvasion: true, statDrop: (ctx, stat) => stat === 'acc' },
  corrosion: { corrodes: true },
  'wonder-guard': { taken: (ctx, move, effectiveness) => (effectiveness > 1 ? 1 : 0) },

  // ---- Conditions turned to advantage, and conditions refused.

  'toxic-boost': { stat: (ctx, stat) => (ctx.self.pokemon.status === 'psn' && stat === 'atk' ? 1.5 : 1) },
  'flare-boost': { stat: (ctx, stat) => (ctx.self.pokemon.status === 'brn' && stat === 'spa' ? 1.5 : 1) },
  'early-bird': { wakesTwiceAsFast: true },
  synchronize: { reflectsStatus: true },
  'shield-dust': { noSecondaryTaken: true },
  oblivious: { blockVolatile: (ctx, state) => state === 'infatuation' || state === 'taunt', intimidateImmune: true },
  'own-tempo': { blockVolatile: (ctx, state) => state === 'confusion', intimidateImmune: true },
  'aroma-veil': { blockVolatile: (ctx, state) => LOCKED_STATES.has(state) },
  'tangled-feet': { evasion: (ctx) => (ctx.self.volatile.confusion > 0 ? 0.5 : 1) },
  'cute-charm': { contact: (ctx) => ctx.infatuate(ctx.foe, 0.3) },
  rivalry: {
    // Harder against its own kind and softer against the other, which needs
    // both of them to have one at all.
    power: (ctx) => {
      const mine = ctx.self.pokemon.gender;
      const theirs = ctx.foe.pokemon.gender;
      if (!mine || !theirs) return 1;
      return mine === theirs ? 1.25 : 0.75;
    },
  },

  // ---- Answering a hit with something that was not there before.

  'poison-touch': { contact: (ctx) => ctx.inflict(ctx.foe, 'psn', 0.3) },
  'cursed-body': { hit: (ctx) => ctx.disable(ctx.foe, 0.3) },
  'perish-body': { contact: (ctx) => ctx.perish() },
  'toxic-debris': {
    hit: (ctx, move) => { if (move.damageClass === 'physical') ctx.layHazard('toxicSpikes'); },
  },
  'toxic-chain': { onHitDealt: (ctx) => ctx.inflict(ctx.foe, 'psn', 0.3) },
  'liquid-ooze': { drainHurts: true },
  'innards-out': { faint: (ctx) => ctx.damageFlat(ctx.foe, ctx.lastDamage) },
  damp: { dampens: true },

  // ---- Charging up off something that was aimed at it.

  'wind-power': { absorbCharge: (ctx, move) => hasFlag(move, 'wind') },
  electromorphosis: { absorbCharge: () => true },

  // ---- Turns given up, and turns taken.

  truant: { skipsEveryOther: true },
  'slow-start': {
    stat: (ctx, stat) =>
      ctx.self.turnsTaken < 5 && (stat === 'atk' || stat === 'spe') ? 0.5 : 1,
  },
  moody: {
    turn: (ctx) => {
      const stats = ['atk', 'def', 'spa', 'spd', 'spe'];
      const up = ctx.rng.pick(stats);
      const down = ctx.rng.pick(stats.filter((stat) => stat !== up));
      ctx.raise(ctx.self, up, 2);
      ctx.raise(ctx.self, down, -1);
    },
  },
  'surge-surfer': { stat: (ctx, stat) => (ctx.terrain === TERRAIN.ELECTRIC && stat === 'spe' ? 2 : 1) },
  'queenly-majesty': { blocksPriority: true },
  dazzling: { blocksPriority: true },
  'armor-tail': { blocksPriority: true },
  'long-reach': { noContact: true },
  'unseen-fist': { unseenFist: true },
  'mycelium-might': { movesLastWithStatus: true, ignoresAbilities: true },
  infiltrator: { infiltrates: true },
  pressure: { pressures: true },
  'parental-bond': { hitsTwice: true },
  'screen-cleaner': { start: (ctx) => ctx.clearScreens() },
  'supersweet-syrup': { start: (ctx) => ctx.raise(ctx.foe, 'eva', -1) },
  'magic-bounce': { bouncesStatus: true },

  // ---- What is held, and what becomes of it.

  'sticky-hold': { keepsItem: true },
  unburden: { unburden: true },
  pickpocket: { contact: (ctx) => ctx.steal() },
  magician: { onHitDealt: (ctx) => ctx.steal() },
  unnerve: { blocksBerries: true },
  gluttony: { berryEarly: true },
  ripen: { berryDouble: true },
  'cheek-pouch': { onBerry: (ctx) => ctx.heal(ctx.self, 1 / 3) },
  // Half the time, and every time under the sun.
  harvest: { regrowsBerry: 0.5, regrowsInSun: true },
  'cud-chew': { regrowsBerry: 1 },

  // ---- The four that weigh on everything but their holder.

  // The four Ruin abilities say so as their holder comes out — "Ting-Lu's
  // Vessel of Ruin weakened the Sp. Atk of all surrounding Pokémon!" — and
  // from then on weigh on that stat of everything but a holder of the same.
  'vessel-of-ruin': { ruin: { stat: 'spa', multiplier: 0.75 }, start: (ctx) => ctx.say('ability.ruin', { stat: 'spa' }) },
  'sword-of-ruin': { ruin: { stat: 'def', multiplier: 0.75 }, start: (ctx) => ctx.say('ability.ruin', { stat: 'def' }) },
  'tablets-of-ruin': { ruin: { stat: 'atk', multiplier: 0.75 }, start: (ctx) => ctx.say('ability.ruin', { stat: 'atk' }) },
  'beads-of-ruin': { ruin: { stat: 'spd', multiplier: 0.75 }, start: (ctx) => ctx.say('ability.ruin', { stat: 'spd' }) },

  // And the one that helps itself to whatever the other side worked for.
  opportunist: { copiesRaises: true },

  // Confusion on top of the poison, which needed confusion to exist first.
  'poison-puppeteer': {
    onHitDealt: (ctx) => {
      if (ctx.foe.pokemon.status === 'psn') ctx.confuse(ctx.foe);
    },
  },

  // ---- Keeping the other side from leaving (see `canEscape`), and leaving
  // regardless.
  'shadow-tag': { trapsAll: true },
  'arena-trap': { trapsGrounded: true },
  'magnet-pull': { trapsSteel: true },
  'run-away': { runAway: true },

  // ---- Reading the other side on the way in.
  anticipation: { start: (ctx) => ctx.anticipate() },
  // It dances along to any dance the other side finishes (see `afterMove`).
  dancer: { dancer: true },
  forewarn: { start: (ctx) => ctx.forewarn() },

  // Twice as hard on something that only just came out.
  stakeout: {
    power: (ctx) => (ctx.foe.enteredTurn === ctx.battle.turn && ctx.battle.turn > 0 ? 2 : 1),
  },
  // Out of the battle the moment a hit takes it under half (see
  // `applyDamagingMove`).
  'wimp-out': { emergencyExit: true },
  'emergency-exit': { emergencyExit: true },

  // ---- The ones that only ever act on a partner, redirect a move between
  // several targets, or wait on a Terastallization — none of which a one-on-
  // one battle without Tera has. They are here so the Pokémon screen can say
  // why they never do anything, rather than that the engine has not learned
  // them.
  plus: { inert: true },
  minus: { inert: true },
  healer: { inert: true },
  'friend-guard': { inert: true },
  telepathy: { inert: true },
  'flower-veil': { inert: true },
  symbiosis: { inert: true },
  battery: { inert: true },
  receiver: { inert: true },
  'power-of-alchemy': { inert: true },
  'propeller-tail': { inert: true },
  stalwart: { inert: true },
  'power-spot': { inert: true },
  'curious-medicine': { inert: true },
  commander: { inert: true },
  costar: { inert: true },
  hospitality: { inert: true },
};

/**
 * The abilities a Trace cannot copy: its own, the forme changers, and the
 * ones that only mean something to the Pokémon born with them.
 */
const UNTRACEABLE = new Set([
  'trace', 'forecast', 'flower-gift', 'illusion', 'imposter', 'multitype', 'stance-change', 'schooling', 'comatose',
  'shields-down', 'disguise', 'rks-system', 'battle-bond', 'power-construct', 'ice-face', 'gulp-missile', 'zen-mode',
  'receiver', 'power-of-alchemy', 'neutralizing-gas', 'hunger-switch', 'as-one-glastrier', 'as-one-spectrier',
  'zero-to-hero', 'commander', 'protosynthesis', 'quark-drive', 'tera-shift', 'poison-puppeteer',
  'embody-aspect-teal', 'embody-aspect-hearthflame', 'embody-aspect-wellspring', 'embody-aspect-cornerstone',
]);

/** The states a move can take away, which an Aroma Veil refuses on its own. */
const LOCKED_STATES = new Set(['taunt', 'encore', 'disable', 'torment']);

/**
 * The ability a Pokémon has right now: the one its forme brings, when a
 * held-item forme brings one — a masked Ogerpon's — and its own otherwise.
 *
 * @param {{speciesId?: number, ability?: string, forme?: string|null}|null|undefined} pokemon
 * @returns {string|null}
 */
export function abilityName(pokemon) {
  return formeAbility(pokemon) ?? pokemon?.ability ?? null;
}

/** Whether the engine has been taught this ability. @param {string} slug */
export const abilityWorks = (slug) => Boolean(ABILITIES[slug]);

/** Whether the ability is one a one-on-one battle never gives a chance to act. @param {string} slug */
export const abilityInert = (slug) => Boolean(ABILITIES[slug]?.inert);

// ---- The small questions the table above asks over and over.

/** @param {any} combatant */
const fullHealth = (combatant) => combatant.pokemon.hp >= combatant.maxHp;

/** The stats a Paradox boost can land on, in the order ties are settled. */
const BOOSTABLE = ['atk', 'def', 'spa', 'spd', 'spe'];

/**
 * Protosynthesis and Quark Drive: the same boost on a different trigger.
 *
 * @param {(ctx: any) => boolean} triggered
 */
function paradoxBoost(triggered) {
  const active = (ctx) => triggered(ctx) || Boolean(ctx.self.marks.boosterEnergy);
  /** @param {any} ctx */
  const spend = (ctx) => {
    if (triggered(ctx) || ctx.self.marks.boosterEnergy || ctx.self.pokemon.heldItem !== 'booster-energy') return;
    ctx.self.marks.boosterEnergy = true;
    ctx.spendItem(ctx.self);
  };
  return {
    start: spend,
    turn: spend,
    stat: (ctx, stat) => {
      if (!active(ctx)) return 1;
      const stats = ctx.statsOf(ctx.self);
      const best = BOOSTABLE.reduce((top, key) => (stats[key] > stats[top] ? key : top), BOOSTABLE[0]);
      if (stat !== best) return 1;
      return stat === 'spe' ? 1.5 : 1.3;
    },
  };
}

/**
 * What the auras on the field make of a move: a third more for a Fairy move
 * under a Fairy Aura or a Dark one under a Dark Aura, from anyone — and a
 * quarter less instead while an Aura Break is out too.
 *
 * @param {Array<any>} abilities every ability on the field, either side
 * @param {{type: string}} move
 */
export function auraMultiplier(abilities, move) {
  if (!abilities.some((ability) => ability?.aura === move.type)) return 1;
  return abilities.some((ability) => ability?.auraBreak) ? 0.75 : 4 / 3;
}

/**
 * What an ability does once a battle is over, to the Pokémon that has it: a
 * Natural Cure lifts its condition and a Regenerator gives back a third of
 * its health, as each would on being switched out.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {number} maxHp
 * @returns {'cured'|'regenerated'|null}
 */
export function afterBattle(pokemon, maxHp) {
  if (pokemon.hp <= 0) return null;
  const ability = abilityName(pokemon);
  if (ability === 'natural-cure' && pokemon.status) {
    pokemon.status = null;
    pokemon.statusTurns = 0;
    return 'cured';
  }
  if (ability === 'regenerator' && pokemon.hp < maxHp) {
    pokemon.hp = Math.min(maxHp, pokemon.hp + Math.floor(maxHp / 3));
    return 'regenerated';
  }
  return null;
}

/** @param {any} combatant */
const halfHealth = (combatant) => combatant.pokemon.hp * 2 <= combatant.maxHp;

/** Whether the hit just taken is what brought the holder under half. */
const crossedHalf = (combatant, damage) =>
  combatant.pokemon.hp > 0 &&
  combatant.pokemon.hp * 2 <= combatant.maxHp &&
  (combatant.pokemon.hp + (damage ?? 0)) * 2 > combatant.maxHp;

const snowing = (weather) => weather === WEATHER.HAIL || weather === WEATHER.SNOW;

/** @param {any} combatant @param {any} move */
const stab = (combatant, move) => speciesOf(combatant.pokemon.speciesId)?.types.includes(move.type);

/** Whether a move carries a secondary effect for Sheer Force to trade away. */
export function hasSecondary(move) {
  const meta = move?.meta;
  if (!meta) return false;
  return (
    (meta.ailmentChance ?? 0) > 0 ||
    (meta.flinchChance ?? 0) > 0 ||
    ((meta.statChance ?? 0) > 0 && (move.statChanges?.length ?? 0) > 0)
  );
}

/** The four pinch abilities, which differ only in the type they lift. */
function pinch(ctx, move, type) {
  return move.type === type && ctx.self.pokemon.hp * 3 <= ctx.self.maxHp ? 1.5 : 1;
}

