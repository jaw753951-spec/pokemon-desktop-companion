/**
 * Creating and growing an individual Pokémon.
 *
 * A Pokémon is a plain object so it serializes straight into the save; every
 * derived value (stats, current level, which moves it could learn) is computed
 * from it on demand rather than stored twice.
 */
import { randomLook } from '../../shared/alcremie.mjs';
import { gameData, moveOf, speciesOf } from '../core/data.mjs';
import { FORME_MOVES, HELD_FORMES, settleForme } from './forms.mjs';
import {
  computeStats,
  experienceForLevel,
  experienceYield,
  levelForExperience,
  STATS,
} from './stats.mjs';

/**
 * @typedef {Object} Pokemon
 * @property {number} speciesId
 * @property {string|null} nickname
 * @property {number} experience
 * @property {string} nature
 * @property {Record<string, number>} ivs
 * @property {Array<{move: string, pp: number, ppUp?: number}>} moves
 * @property {number} hp remaining hit points
 * @property {string|null} status `brn`, `psn`, `par`, `slp`, `frz` or null
 * @property {boolean} [toxic] whether a poison is the bad kind a Toxic gives
 * @property {number} statusTurns
 * @property {string|null} heldItem
 * @property {string} ability
 * @property {'male'|'female'|null} gender null for the species that have none
 * @property {boolean} shiny
 * @property {number} caughtAt epoch milliseconds
 * @property {string|null} ball the ball it was caught in
 * @property {boolean} [fromWater] met surfing or fishing rather than on foot,
 *   which a Dive Ball counts; only ever set on a wild Pokémon
 * @property {boolean} [fished] met on a rod, which a Lure Ball counts
 * @property {number} [friendship] how fond of its trainer it is, 0 to 255;
 *   a save from before it was kept reads as the species' base
 * @property {number} [steps] steps walked alongside, for a Pawmo's thousand
 * @property {number} [recoilTaken] recoil damage taken without fainting, for
 *   a white-striped Basculin
 * @property {Record<string, number>} [moveUses] how many times it has used a
 *   move some evolution counts — Rage Fist, for a Primeape
 * @property {string} [standing] the shape a key item left it in — a Sky Forme
 *   Shaymin's, a fused Necrozma's — kept until the item is used again
 * @property {string[]} [learned] every move it has come to be able to use, in
 *   the order it came to — the newest last; see {@link noteLearnedMoves}
 * @property {boolean} [favorite] marked a favourite in the box, which keeps
 *   the box's top rows
 * @property {string[]} [newMoves] the ones among them not yet looked at in the
 *   move list, which the Pokémon tab marks
 * @property {string} [look] an Alcremie's cream and sweet, rolled when it evolves
 * @property {string[]} [badges] the gym badges it has won, by type
 * @property {boolean} [champion] whether it has beaten the League's champion
 * @property {string} [forme] the alternate forme it is wearing, if any — the
 *   one it stands in (a held mask, a chosen Sky Forme) outside a battle, and
 *   whatever the battle has changed it into inside one, let go of after
 */

/**
 * How often a Pokémon is shiny.
 *
 * The cartridges roll a sixteen-bit number and compare it against the
 * trainer's own; the odds that comes to have been 1/8192 from Gold and Silver
 * through Black and White, and 1/4096 from X and Y onward. This game follows
 * the newest generation's rules everywhere else — its stats, its learnsets,
 * its type chart — so it follows them here too.
 */
export const SHINY_ODDS = 1 / 4096;

/**
 * The odds of a shiny over so many rolls — a Shiny Charm's, which the games
 * roll as so many tries rather than one multiplied chance.
 *
 * @param {number} rolls
 */
export function shinyOddsFor(rolls) {
  return 1 - (1 - SHINY_ODDS) ** Math.max(1, rolls);
}

/**
 * How often a wild Pokémon turns out to be carrying something.
 *
 * Straight from the cartridge: a hundred-sided roll, under 45 and it carries
 * nothing, under 95 and it carries the common slot, otherwise the rare one.
 * A Compound Eyes in the lead — here, the companion — moves both lines, which
 * is the one thing in the game that changes them.
 *
 * A species whose two slots hold the same item always carries it; that is how
 * the games say "always" rather than with a third number.
 */
export const WILD_ITEM_ODDS = { nothing: 45, common: 95 };
export const WILD_ITEM_ODDS_COMPOUND_EYES = { nothing: 20, common: 80 };

/**
 * Roll a new Pokémon at a level.
 *
 * @param {import('../core/rng.mjs').Rng} rng
 * @param {number} speciesId
 * @param {number} level
 * @param {{
 *   ivFloor?: number,
 *   nickname?: string|null,
 *   ball?: string|null,
 *   hiddenAbility?: boolean,
 *   shiny?: boolean,
 *   shinyOdds?: number,
 *   gender?: 'male'|'female'|null,
 * }} [options] `shinyOdds` for something other than the usual one in 4096
 * @returns {Pokemon}
 */
export function createPokemon(rng, speciesId, level, options = {}) {
  const species = speciesOf(speciesId);
  if (!species) throw new Error(`Unknown species ${speciesId}`);

  const ivFloor = options.ivFloor ?? 0;
  /** @type {Record<string, number>} */
  const ivs = {};
  for (const stat of STATS) ivs[stat] = rng.int(ivFloor, 31);

  const natures = Object.keys(gameData().natures);
  const pokemon = /** @type {Pokemon} */ ({
    speciesId,
    nickname: options.nickname ?? null,
    experience: experienceForLevel(species.growthRate, Math.max(1, level)),
    nature: natures.length ? rng.pick(natures) : 'hardy',
    ivs,
    moves: [],
    hp: 0,
    status: null,
    statusTurns: 0,
    heldItem: null,
    ability: pickAbility(rng, species, options.hiddenAbility ?? false),
    gender: options.gender !== undefined ? options.gender : rollGender(rng, species),
    shiny: options.shiny ?? rng.chance(options.shinyOdds ?? SHINY_ODDS),
    caughtAt: Date.now(),
    friendship: options.ball === 'friend-ball' ? 150 : species.baseHappiness ?? 70,
    ball: options.ball ?? null,
  });

  // A female Meowstic, Indeedee, Basculegion or Oinkologne is a species of
  // its own in the dex, with its own stats, abilities and moves.
  const gendered = genderedSpecies(speciesId, pokemon.gender);
  if (gendered !== speciesId) {
    const slot = abilitySlot(pokemon);
    pokemon.speciesId = gendered;
    const variant = speciesOf(gendered);
    pokemon.ability = (variant.abilities[slot] ?? variant.abilities[0])?.name ?? pokemon.ability;
    pokemon.experience = experienceForLevel(variant.growthRate, Math.max(1, level));
  }

  // An Ogerpon is met in one of its four masks: the Teal it wears bare, or
  // holding one of the other three — and it keeps the mask it came in. The
  // other species a held item shapes are met holding nothing: a plate, a
  // memory, a drive or a crystal is found only while its Pokémon travels.
  const masks = species.slug === 'ogerpon' ? HELD_FORMES.get(species.slug) : null;
  if (masks) {
    pokemon.heldItem = rng.pick([null, ...masks.keys()]) ?? null;
    settleForme(pokemon);
  }

  if (species.slug === 'alcremie') pokemon.look = randomLook(rng);

  pokemon.moves = defaultMoves(pokemon).map((move) => ({ move, pp: moveOf(move)?.pp ?? 5 }));
  pokemon.hp = maxHp(pokemon);
  // What it knows on the day it is met is known, not new.
  noteLearnedMoves(pokemon);
  return pokemon;
}

/**
 * The dex entry a Pokémon of this gender belongs under: the female variant a
 * species keeps separately for its females, and the species itself for its
 * males.
 *
 * @param {number} speciesId
 * @param {'male'|'female'|null|undefined} gender
 * @returns {number}
 */
export function genderedSpecies(speciesId, gender) {
  const species = speciesOf(speciesId);
  if (!species) return speciesId;
  if (gender === 'female' && species.femaleVariant && speciesOf(species.femaleVariant)) return species.femaleVariant;
  if (gender === 'male' && species.gender === 'female' && species.dex) return species.dex;
  return speciesId;
}

/**
 * Which of a species' abilities this one turns out to have.
 *
 * A Pokémon a trainer sends out draws from the ordinary abilities, as the
 * games' trainers do. Something met in the wild draws from the whole pool with
 * the hidden ability among them and no better or worse odds than the rest:
 * the cartridges gate hidden abilities behind raids and Ability Patches, and
 * this game has neither, so a Pokémon walking around out there is the only
 * place one can come from.
 *
 * @param {import('../core/rng.mjs').Rng} rng
 * @param {any} species
 * @param {boolean} hiddenAbility whether the hidden ability is in the draw
 */
function pickAbility(rng, species, hiddenAbility) {
  const pool = hiddenAbility
    ? species.abilities
    : species.abilities.filter((entry) => !entry.hidden);
  if (pool.length) return rng.pick(pool).name;
  return species.abilities[0]?.name ?? 'none';
}

/**
 * Whether this one is male, female, or neither.
 *
 * The dex files it as eighths: -1 for a species with no gender at all, and
 * otherwise how many eighths of them are female. A Bulbasaur is 1, so one in
 * eight; a Chansey is 8, so all of them.
 *
 * @param {import('../core/rng.mjs').Rng} rng
 * @param {any} species
 * @returns {'male'|'female'|null}
 */
export function rollGender(rng, species) {
  const rate = species?.genderRate ?? -1;
  if (rate < 0) return null;
  return rng.next() < rate / 8 ? 'female' : 'male';
}

/**
 * Give a wild Pokémon whatever it turned out to be carrying.
 *
 * Only the wild: a trainer's Pokémon is handed its item by whoever built the
 * party, which is what the cartridges do too — `SetWildMonHeldItem` refuses to
 * run at all in a trainer battle.
 *
 * @param {import('../core/rng.mjs').Rng} rng
 * @param {Pokemon} pokemon
 * @param {{compoundEyes?: boolean}} [options] whether the lead has the ability
 *   that turns up more of them
 * @returns {string|null} what it ended up holding
 */
export function rollWildHeldItem(rng, pokemon, options = {}) {
  const slots = speciesOf(pokemon.speciesId)?.heldItems;
  if (!slots || (!slots.common && !slots.rare)) return null;

  // Both slots holding the same thing is how the games say "always".
  if (slots.common && slots.common === slots.rare) {
    pokemon.heldItem = slots.common;
    return pokemon.heldItem;
  }

  const odds = options.compoundEyes ? WILD_ITEM_ODDS_COMPOUND_EYES : WILD_ITEM_ODDS;
  const roll = rng.int(0, 99);
  if (roll < odds.nothing) return null;

  pokemon.heldItem = (roll < odds.common ? slots.common : slots.rare) ?? null;
  return pokemon.heldItem;
}

/**
 * Which slot of its species' ability list a Pokémon is filling.
 *
 * The games keep this rather than the ability itself, which is why a Pokémon
 * that evolves keeps the ability in the same place rather than the one it had
 * by name — an Eevee with Run Away becomes a Vaporeon with Water Absorb, not a
 * Vaporeon that has somehow kept running away.
 *
 * @param {Pokemon} pokemon
 * @returns {number} -1 when the ability is not one of the species' own
 */
export function abilitySlot(pokemon) {
  const species = speciesOf(pokemon.speciesId);
  return (species?.abilities ?? []).findIndex((entry) => entry.name === pokemon.ability);
}

/**
 * The move every Pokémon falls back on when it has nothing that hits.
 *
 * Tackle is the series' own answer to the same question — it is what a starter
 * opens with and what the games hand out when a moveset would otherwise have
 * nothing in it — and every Pokémon in this game can be given it, because the
 * alternative is a Pokémon that cannot fight.
 */
export const DEFAULT_ATTACK = 'tackle';

/** Whether a move actually does damage, as opposed to setting something up. */
export const isAttack = (slug) => {
  const move = moveOf(slug);
  return Boolean(move && move.damageClass !== 'status' && (move.power ?? 0) > 0);
};

/** The level every Pokémon is when it is caught, whatever level it was met at. */
export const CAUGHT_LEVEL = 5;

/**
 * Put a Pokémon back at a given level, with the moves that level knows.
 *
 * A caught Pokémon is a fresh one: it goes into the box at level 5 whatever it
 * was met at, so a catch is somebody to raise rather than a shortcut to a
 * strong one.
 *
 * @param {Pokemon} pokemon
 * @param {number} level
 */
export function resetToLevel(pokemon, level) {
  const species = speciesOf(pokemon.speciesId);
  pokemon.experience = experienceForLevel(species.growthRate, Math.max(1, level));
  pokemon.moves = defaultMoves(pokemon).map((move) => ({ move, pp: moveOf(move)?.pp ?? 5 }));
  // What it knows now is what it knows; nothing is waiting to be looked at.
  delete pokemon.learned;
  noteLearnedMoves(pokemon);
  pokemon.hp = maxHp(pokemon);
}

/**
 * The four most recent level-up moves available at the Pokémon's level, which
 * is what the games give a freshly encountered Pokémon — with the guarantee
 * that at least one of them hits.
 *
 * @param {Pokemon} pokemon
 * @returns {string[]}
 */
export function defaultMoves(pokemon) {
  const species = speciesOf(pokemon.speciesId);
  const level = levelOf(pokemon);
  const learnable = species.learnset.level
    .filter(([at]) => at <= level)
    .map(([, move]) => move)
    .filter((move) => moveOf(move));

  const unique = [...new Set(learnable)];
  let chosen = unique.slice(-4);

  if (chosen.length === 0) {
    // A species whose learnset starts above this level still needs something.
    const fallback = species.learnset.level.map(([, move]) => move).find((move) => moveOf(move));
    chosen = fallback ? [fallback] : [];
  }

  return withAttack(chosen, species);
}

/**
 * The same four moves, but with something that hits among them.
 *
 * Some species learn nothing but status moves for their first several levels —
 * a Smeargle knows only Sketch, a Magikarp only Splash and a Tackle it gets at
 * fifteen, a Metapod only Harden — and a companion that fights on its own for
 * hours had no way to win those fights: it stood there raising its defence
 * until something knocked it over. So the last slot is given the best hitting
 * move the species has anywhere in its level-up list, and failing that the
 * fallback above.
 *
 * The move is chosen from the species' own learnset first, so a Metapod gets
 * its own Tackle back rather than being handed one it was never meant to know.
 *
 * @param {string[]} moves
 * @param {any} species
 * @returns {string[]}
 */
function withAttack(moves, species) {
  if (moves.some(isAttack)) return moves;

  const fromSpecies = (species?.learnset?.level ?? [])
    .map(([, move]) => move)
    .filter((move) => isAttack(move));
  // The last one it would learn is the strongest thing it has a claim to.
  const attack = fromSpecies.at(-1) ?? (moveOf(DEFAULT_ATTACK) ? DEFAULT_ATTACK : null);
  if (!attack || moves.includes(attack)) return moves;

  // Replace the last slot rather than the first: a full set keeps the three
  // moves the level actually earned, and the one it gives up is the oldest of
  // the four it was carrying.
  if (moves.length >= 4) return [...moves.slice(0, 3), attack];
  return [...moves, attack];
}

/**
 * Make sure a Pokémon has something it can attack with, teaching it one if it
 * has not.
 *
 * Saves written before that was guaranteed are full of Pokémon that cannot
 * fight, and the companion is one of them, so the run repairs them on load
 * rather than leaving a player to notice it mid-battle.
 *
 * @param {Pokemon} pokemon
 * @returns {string|null} the move it was taught, if it needed one
 */
export function ensureAttack(pokemon) {
  if (!pokemon) return null;
  const known = (pokemon.moves ?? []).map((entry) => entry?.move).filter(Boolean);
  if (known.some(isAttack)) return null;

  const species = speciesOf(pokemon.speciesId);
  const [taught] = withAttack(known, species).filter((move) => !known.includes(move));
  if (!taught) return null;

  setMove(pokemon, Math.min(3, Math.max(0, known.length)), taught);
  return taught;
}

/** @param {Pokemon} pokemon */
export function levelOf(pokemon) {
  const species = speciesOf(pokemon.speciesId);
  return levelForExperience(species.growthRate, pokemon.experience);
}

/**
 * The base stats the Pokémon is currently wearing.
 *
 * An alternate forme carries its own set, and a battle reads them through the
 * forme the combatant is marked with — a Zen Mode below half really is twice
 * the attack and half the speed on its card. Left out, it is the forme the
 * Pokémon is wearing: outside a battle the shape it stands in (a Sky Forme
 * Shaymin, a 10% Zygarde), inside one whatever the battle has put it in.
 *
 * @param {Pokemon} pokemon
 * @param {string|null} [forme] the alternate forme to read, if any
 */
export function statsOf(pokemon, forme = pokemon.forme) {
  const species = speciesOf(pokemon.speciesId);
  const base = forme
    ? (species.forms ?? []).find((form) => form.slug === forme)?.stats ?? species.stats
    : species.stats;
  const nature = gameData().natures[pokemon.nature] ?? { increased: null, decreased: null };
  return computeStats(base, pokemon.ivs, levelOf(pokemon), nature);
}

/** @param {Pokemon} pokemon */
export const maxHp = (pokemon) => statsOf(pokemon).hp;

/** @param {Pokemon} pokemon */
export const displayName = (pokemon) => pokemon.nickname || null;

/**
 * Progress towards the next level, for the experience bar.
 * @param {Pokemon} pokemon
 * @returns {{level: number, into: number, needed: number, ratio: number}}
 */
export function experienceProgress(pokemon) {
  const species = speciesOf(pokemon.speciesId);
  const level = levelOf(pokemon);
  if (level >= 100) return { level, into: 0, needed: 0, ratio: 1 };

  const floor = experienceForLevel(species.growthRate, level);
  const ceiling = experienceForLevel(species.growthRate, level + 1);
  const into = pokemon.experience - floor;
  const needed = ceiling - floor;
  return { level, into, needed, ratio: needed > 0 ? Math.min(1, into / needed) : 0 };
}

/**
 * Award experience, and report what changed so the battle log can
 * narrate it.
 *
 * @param {Pokemon} pokemon
 * @param {{baseStats: Record<string, number>, baseExp: number, level: number}} defeated
 * @param {{trainerBattle?: boolean, experienceMultiplier?: number}} [options]
 * @returns {{experience: number, levelsGained: number, newLevel: number, learnable: string[]}}
 */
export function gainFromDefeat(pokemon, defeated, options = {}) {
  const before = levelOf(pokemon);
  const amount = experienceYield(
    { baseExp: defeated.baseExp, level: defeated.level },
    before,
    options.trainerBattle ? 1.5 : 1,
  );

  // A Lucky Egg pays more experience, applied to what the defeat was worth.
  // Level 100 is the top: experience stops at what reaching it takes, rather
  // than piling up behind a level that can no longer move.
  const ceiling = experienceForLevel(speciesOf(pokemon.speciesId)?.growthRate, 100);
  const gained = Math.max(0, Math.min(Math.round(amount * (options.experienceMultiplier ?? 1)), ceiling - pokemon.experience));
  pokemon.experience += gained;

  const after = levelOf(pokemon);
  // A level-up tops up the extra hit points immediately, as the games do.
  if (after > before) pokemon.hp = Math.min(maxHp(pokemon), pokemon.hp + (after - before) * 2);

  return {
    // What was actually added, a Lucky Egg's share included.
    experience: gained,
    levelsGained: after - before,
    newLevel: after,
    learnable: movesLearnedBetween(pokemon, before, after),
  };
}

/**
 * Level-up moves that became available while crossing levels.
 * @param {Pokemon} pokemon
 * @param {number} fromLevel exclusive
 * @param {number} toLevel inclusive
 */
export function movesLearnedBetween(pokemon, fromLevel, toLevel) {
  const species = speciesOf(pokemon.speciesId);
  const known = new Set(pokemon.moves.map((slot) => slot.move));
  return [
    ...new Set(
      species.learnset.level
        .filter(([at, move]) => at > fromLevel && at <= toLevel && moveOf(move) && !known.has(move))
        .map(([, move]) => move),
    ),
  ];
}

/**
 * Every move this Pokémon could have in a slot: its level-up moves up to its
 * current level, plus any TM the player has used on it.
 *
 * @param {Pokemon} pokemon
 * @param {string[]} [unlockedMachines] move slugs unlocked by TMs
 * @returns {string[]}
 */
export function availableMoves(pokemon, unlockedMachines = []) {
  const species = speciesOf(pokemon.speciesId);
  const level = levelOf(pokemon);
  // A forme with moves of its own — a Calyrex riding its steed — adds them to
  // the species'.
  const forme = pokemon.forme ? species.forms?.find((form) => form.slug === pokemon.forme)?.learnset : null;
  const sets = [species.learnset, ...(forme ? [forme] : [])];
  const fromLevels = sets.flatMap((set) => (set.level ?? []).filter(([at]) => at <= level).map(([, move]) => move));
  const fromMachines = unlockedMachines.filter((move) => sets.some((set) => set.machine?.includes(move)));
  // A tutor teaches whenever asked; there is no level to wait for.
  const fromTutors = sets.flatMap((set) => set.tutor ?? []);
  // And a shape a key item gave brings its own move, which a Necrozma in its
  // Dusk Mane has in no learnset at all.
  const fromForme = FORME_MOVES.get(pokemon.forme ?? '') ?? [];
  return [...new Set([...fromLevels, ...fromMachines, ...fromTutors, ...fromForme])].filter((move) => moveOf(move));
}

/**
 * Write down any move the Pokémon has newly come to be able to use — from a
 * level, an evolution, a machine unlocked, a shape a key item gave — in the
 * order it came to, and mark the ones not in its four slots as new until the
 * move list is looked at.
 *
 * A Pokémon with no record yet — one from a save older than the record, or
 * one just met — has everything it can use written down as already known.
 *
 * @param {Pokemon} pokemon
 * @param {string[]} [unlockedMachines]
 */
export function noteLearnedMoves(pokemon, unlockedMachines = []) {
  const available = availableMoves(pokemon, unlockedMachines);
  if (!Array.isArray(pokemon.learned)) {
    pokemon.learned = available;
    pokemon.newMoves = [];
    return;
  }
  const known = new Set(pokemon.learned);
  const equipped = new Set(pokemon.moves.map((slot) => slot.move));
  const fresh = new Set(pokemon.newMoves ?? []);
  for (const move of available) {
    if (known.has(move)) continue;
    pokemon.learned.push(move);
    if (!equipped.has(move)) fresh.add(move);
  }
  // A move put in a slot, or one it can no longer use, is not waiting to be seen.
  pokemon.newMoves = [...fresh].filter((move) => available.includes(move) && !equipped.has(move));
}

/**
 * The moves a Pokémon can use, most recently learned first, as the move list
 * shows them.
 *
 * @param {Pokemon} pokemon
 * @param {string[]} [unlockedMachines]
 */
export function movesByRecency(pokemon, unlockedMachines = []) {
  const order = pokemon.learned ?? [];
  const rank = (move) => {
    const index = order.lastIndexOf(move);
    return index < 0 ? -1 : index;
  };
  return availableMoves(pokemon, unlockedMachines).sort((a, b) => rank(b) - rank(a));
}

/**
 * The moves a species learns the moment something evolves into it — a
 * Charizard's Air Slash — taught straight into a free slot, as a level-up
 * move is. Those that do not fit are left in the move list to swap in.
 *
 * @param {Pokemon} pokemon just evolved
 * @returns {{learned: string[], waiting: string[]}}
 */
export function learnOnEvolution(pokemon) {
  const species = speciesOf(pokemon.speciesId);
  const known = new Set(pokemon.moves.map((slot) => slot.move));
  const fresh = (species?.learnset.level ?? [])
    .filter(([at, move]) => at === 0 && !known.has(move) && moveOf(move))
    .map(([, move]) => move);
  /** @type {{learned: string[], waiting: string[]}} */
  const out = { learned: [], waiting: [] };
  for (const move of new Set(fresh)) {
    if (pokemon.moves.length < 4) {
      setMove(pokemon, pokemon.moves.length, move);
      out.learned.push(move);
    } else {
      out.waiting.push(move);
    }
  }
  return out;
}

/**
 * Put a move in a slot, keeping its PP fresh.
 * @param {Pokemon} pokemon
 * @param {number} slot 0..3
 * @param {string} move
 */
export function setMove(pokemon, slot, move) {
  const pp = moveOf(move)?.pp ?? 5;
  // A new move in the slot starts at its own ceiling: what a PP Up bought
  // belonged to the move that was there, not to the slot.
  const entry = { move, pp, ppUp: 0 };
  if (slot < pokemon.moves.length) pokemon.moves[slot] = entry;
  else pokemon.moves.push(entry);
  pokemon.moves = pokemon.moves.slice(0, 4);
  // A Keldeo's shape follows whether it knows Secret Sword.
  settleForme(pokemon);
}

/**
 * Restore HP, PP and status — the healing event, and every league round.
 * @param {Pokemon} pokemon
 */
export function fullyHeal(pokemon) {
  pokemon.hp = maxHp(pokemon);
  pokemon.status = null;
  pokemon.statusTurns = 0;
  for (const slot of pokemon.moves) slot.pp = maxPp(slot);
}

/**
 * A move slot's full PP, with whatever a PP Up has bought for it.
 *
 * The raise is kept on the slot rather than on the move, because two Pokémon
 * knowing the same move need not have had the same spent on it — and because
 * the move data is reference data the save must never write into.
 *
 * @param {{move: string, pp: number, ppUp?: number}} slot
 */
export function maxPp(slot) {
  const base = moveOf(slot.move)?.pp ?? slot.pp;
  return base + Math.floor(base * (slot.ppUp ?? 0));
}

/** The item that stands in for a trade, as Legends: Arceus's Linking Cord does. */
export const TRADE_ITEM = 'linking-cord';

/**
 * The evolution this Pokémon is ready for, if any.
 *
 * Levelling up — past a level, with enough friendship, knowing a move or a
 * move of a type, holding an item, at the right hour — or being given an item
 * from the bag. A trade is a Linking Cord given from the bag, the way Legends:
 * Arceus did it; which of two a Clamperl becomes is still the item it holds.
 * A rule this game cannot meet (a place it has no map of) never fires, and
 * the dex step has already put a reachable one beside it wherever the games
 * had one.
 *
 * @param {Pokemon} pokemon
 * @param {{
 *   item?: string|null,
 *   timeOfDay?: string,
 *   crits?: number,
 *   box?: Array<Pokemon|null>,
 *   raining?: boolean,
 *   areaTags?: string[],
 * }} [context] `crits` is how many critical hits it landed in the battle it
 *   has just finished; `box` the Pokémon that count as its party
 * @returns {{to: number, trigger: string}|null}
 */
export function pendingEvolution(pokemon, context = {}) {
  const species = speciesOf(pokemon.speciesId);
  const level = levelOf(pokemon);

  // An Everstone stops the levelling kind and nothing else, which is exactly
  // what it is for: a Pokémon can still be handed a stone while holding one.
  const everstone = gameData().items[pokemon.heldItem ?? '']?.held?.on === 'noEvolve';
  const knows = (move) => pokemon.moves.some((slot) => slot.move === move);
  const knowsType = (type) => pokemon.moves.some((slot) => moveOf(slot.move)?.type === type);
  // The box is the party a companion travels without: a Remoraid in it, a
  // Dark type in it, counts as one alongside.
  const box = (context.box ?? []).filter(Boolean);

  const trades = [];
  /** @type {Array<{to: number, weight: number}>} */
  const levelled = [];
  for (const evolution of species.evolutions ?? []) {
    if (!speciesOf(evolution.to)) continue;
    // Another region's rule — an Exeggcute in Alola — has no place here.
    if (evolution.region) continue;

    if (evolution.trigger === 'level-up') {
      if (everstone || context.item) continue;
      if (evolution.location) continue;
      const reachable =
        evolution.minLevel ||
        evolution.happiness ||
        evolution.knownMove ||
        evolution.knownMoveType ||
        evolution.heldItem ||
        evolution.heldItems?.length ||
        evolution.steps ||
        evolution.recoil ||
        evolution.partySpecies;
      if (!reachable) continue;
      if (evolution.minLevel && level < evolution.minLevel) continue;
      if (evolution.happiness && friendshipOf(pokemon) < evolution.happiness) continue;
      if (evolution.knownMove && !knows(evolution.knownMove)) continue;
      if (evolution.knownMoveType && !knowsType(evolution.knownMoveType)) continue;
      if (evolution.timeOfDay && context.timeOfDay && !matchesTime(evolution.timeOfDay, context.timeOfDay)) continue;
      if (evolution.heldItem && pokemon.heldItem !== evolution.heldItem) continue;
      // Any one of several: a Milcery holding whichever Sweet.
      if (evolution.heldItems?.length && !evolution.heldItems.includes(pokemon.heldItem ?? '')) continue;
      // A Rockruff with Own Tempo, a Toxel of the right nature, a Burmy on
      // the ground its cloak is made of.
      if (evolution.ability && pokemon.ability !== evolution.ability) continue;
      if (evolution.natures?.length && !evolution.natures.includes(pokemon.nature)) continue;
      if (evolution.areaTags?.length && !(context.areaTags ?? []).some((tag) => evolution.areaTags.includes(tag))) continue;
      if (evolution.gender && !matchesGender(evolution.gender, pokemon.gender)) continue;
      if (evolution.steps && (pokemon.steps ?? 0) < evolution.steps) continue;
      if (evolution.recoil && (pokemon.recoilTaken ?? 0) < evolution.recoil) continue;
      if (evolution.rain && !context.raining) continue;
      if (evolution.partySpecies && !box.some((other) => other.speciesId === evolution.partySpecies)) continue;
      if (evolution.partyType && !box.some((other) => speciesOf(other.speciesId)?.types.includes(evolution.partyType))) {
        continue;
      }
      if (evolution.relativeStats !== null && evolution.relativeStats !== undefined) {
        const stats = statsOf(pokemon);
        if (Math.sign(stats.atk - stats.def) !== evolution.relativeStats) continue;
      }
      // The more particular rule wins: an Eevee that knows a Fairy move
      // becomes a Sylveon however fond of its trainer it is.
      const weight =
        2 * [evolution.knownMove, evolution.knownMoveType, evolution.heldItem, evolution.heldItems?.length, evolution.ability, evolution.areaTags?.length].filter(Boolean).length +
        [evolution.minLevel, evolution.happiness, evolution.timeOfDay, evolution.gender].filter(Boolean).length;
      levelled.push({ to: evolution.to, weight });
      continue;
    }

    // Counted rather than levelled: Rage Fist used twenty times, three
    // critical hits landed in the battle just won.
    if (evolution.trigger === 'use-move' && !context.item && !everstone) {
      if ((pokemon.moveUses?.[evolution.usedMove] ?? 0) >= (evolution.moveCount ?? 1)) levelled.push({ to: evolution.to, weight: 9 });
      continue;
    }
    if (evolution.trigger === 'three-critical-hits' && !context.item && !everstone) {
      if ((context.crits ?? 0) >= 3) levelled.push({ to: evolution.to, weight: 9 });
      continue;
    }

    if (evolution.trigger === 'use-item' && context.item && evolution.item === context.item) {
      if (evolution.gender && !matchesGender(evolution.gender, pokemon.gender)) continue;
      if (evolution.minLevel && level < evolution.minLevel) continue;
      return { to: evolution.to, trigger: 'use-item' };
    }

    if (evolution.trigger === 'trade' && context.item === TRADE_ITEM) trades.push(evolution);
  }

  if (levelled.length) {
    const top = Math.max(...levelled.map((entry) => entry.weight));
    const best = levelled.filter((entry) => entry.weight === top);
    // Two rules alike to the letter — a Wurmple's Silcoon and Cascoon — are
    // settled by something fixed about the Pokémon, the way the games use
    // its personality value: the same one every time for the same Wurmple.
    const chosen = best[personalityOf(pokemon) % best.length];
    return { to: chosen.to, trigger: 'level-up' };
  }

  // The trade that goes with the item the Pokémon is holding, if one does.
  const trade = trades.find((evolution) => evolution.heldItem && evolution.heldItem === pokemon.heldItem) ?? trades[0];
  return trade ? { to: trade.to, trigger: 'trade' } : null;
}

/**
 * A number fixed for a Pokémon for good, standing in for the personality
 * value the games keep: made from its genes and the moment it was caught.
 *
 * @param {Pokemon} pokemon
 */
function personalityOf(pokemon) {
  const genes = Object.values(pokemon.ivs ?? {}).reduce((sum, value) => sum * 31 + Number(value), 7);
  return Math.abs(Math.floor(genes + (pokemon.caughtAt ?? 0) / 1000));
}


/**
 * PokeAPI's gender numbers: 1 female, 2 male.
 *
 * @param {number} wanted
 * @param {'male'|'female'|null} gender
 */
function matchesGender(wanted, gender) {
  return wanted === 1 ? gender === 'female' : wanted === 2 ? gender === 'male' : true;
}

/**
 * @param {string} required `day`, `night`, `dusk`
 * @param {string} current one of the five background bands
 */
function matchesTime(required, current) {
  if (required === 'night') return current === 'night' || current === 'dusk';
  if (required === 'dusk') return current === 'dusk';
  return current === 'day' || current === 'dawn' || current === 'afternoon';
}

/**
 * Evolve in place, keeping level, moves and nickname.
 * @param {Pokemon} pokemon
 * @param {number} speciesId
 * @param {{pick: <T>(list: T[]) => T}} [rng] rolls an Alcremie's look
 */
export function evolveInto(pokemon, speciesId, rng) {
  const ratio = pokemon.hp / maxHp(pokemon);
  const slot = abilitySlot(pokemon);
  // A female Lechonk grows into the female Oinkologne.
  speciesId = genderedSpecies(speciesId, pokemon.gender);
  pokemon.speciesId = speciesId;
  const species = speciesOf(speciesId);
  if (!species.abilities.some((entry) => entry.name === pokemon.ability)) {
    // The same slot in the new species' list, which is what the games carry
    // across; a species with fewer abilities than the last falls back to its
    // first, and a hidden ability stays hidden where there is one to stay in.
    const kept = species.abilities[slot] ?? species.abilities[0];
    pokemon.ability = kept?.name ?? pokemon.ability;
  }
  // Whatever sweet the Milcery held, the Alcremie's look is left to chance.
  if (species.slug === 'alcremie') pokemon.look = randomLook(rng);
  // A Type: Null that was already holding a memory is a Silvally of that
  // type the moment it becomes one.
  settleForme(pokemon);
  pokemon.hp = Math.max(1, Math.round(maxHp(pokemon) * ratio));
  return pokemon;
}

/** The most friendship there is. */
export const MAX_FRIENDSHIP = 255;

/** How many steps walked alongside buy one point of friendship, as the games count them. */
export const STEPS_PER_FRIENDSHIP = 128;

/**
 * How fond of its trainer a Pokémon is: its own count, or its species' base
 * friendship for one from a save that never kept one.
 *
 * @param {Pokemon} pokemon
 */
export function friendshipOf(pokemon) {
  return pokemon.friendship ?? speciesOf(pokemon.speciesId)?.baseHappiness ?? 70;
}

/**
 * Friendship gained, as the games give it: more with a Soothe Bell held and
 * in a Luxury Ball, and never past the top.
 *
 * @param {Pokemon} pokemon
 * @param {number} amount negative for a loss
 */
export function gainFriendship(pokemon, amount) {
  let change = amount;
  if (amount > 0) {
    if (pokemon.heldItem === 'soothe-bell') change = Math.ceil(change * 1.5);
    if (pokemon.ball === 'luxury-ball') change += 1;
  }
  pokemon.friendship = Math.max(0, Math.min(MAX_FRIENDSHIP, friendshipOf(pokemon) + change));
}

/**
 * What levelling up is worth in friendship, level by level: more the less of
 * it there is, as the games pay it.
 *
 * @param {Pokemon} pokemon
 * @param {number} levels how many it just gained
 */
export function friendshipForLevels(pokemon, levels) {
  for (let level = 0; level < levels; level++) {
    const now = friendshipOf(pokemon);
    gainFriendship(pokemon, now < 100 ? 5 : now < 200 ? 3 : 2);
  }
}

/**
 * Count steps walked alongside: a Pawmo's thousand, and a point of friendship
 * every hundred and twenty-eight.
 *
 * @param {Pokemon} pokemon
 * @param {number} steps may be fractional
 */
export function walkSteps(pokemon, steps) {
  const before = pokemon.steps ?? 0;
  pokemon.steps = before + steps;
  const earned = Math.floor(pokemon.steps / STEPS_PER_FRIENDSHIP) - Math.floor(before / STEPS_PER_FRIENDSHIP);
  if (earned > 0) gainFriendship(pokemon, earned);
}
