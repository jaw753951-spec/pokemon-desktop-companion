/**
 * Using an item, wherever it is used from.
 *
 * The bag screen, the battle screen and the auto-use policy all end up doing
 * the same thing to the same Pokémon, so what an item does lives here rather
 * than in whichever screen happened to need it first.
 */
import { timeOfDay } from '../../shared/constants.mjs';
import { weatherForArea } from '../../shared/area-tags.mjs';
import { abilityOf, gameData, itemOf, moveOf, speciesOf, typeEffectiveness } from '../core/data.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import {
  abilitySlot,
  changeEffort,
  clearStatus,
  createPokemon,
  effortOf,
  evolveInto,
  followMaxHp,
  friendshipForLevels,
  friendshipOf,
  gainFriendship,
  learnOnEvolution,
  levelOf,
  MAX_FRIENDSHIP,
  maxHp,
  maxPp,
  movesLearnedBetween,
  nameOf,
  noteLearnedMoves,
  offeredEvolution,
  pendingEvolution,
  setMove,
  statsOf,
} from './pokemon.mjs';
import { EFFORT_STAT_MAX, experienceForLevel, STATS } from './stats.mjs';
import {
  collectedByType,
  FORME_MOVE_RULES,
  formeAbility,
  nextForme,
  SET_FORMES,
  settleForme,
  signatureItems,
  standingTypes,
  USE_FORMES,
  useFormeItem,
} from './forms.mjs';

/**
 * What a player picks for an item that works on one move or one stat — or,
 * for a key item whose shape brings a move with no room for it, the slot the
 * new move goes over (`forget`). Without one, that move is given up.
 *
 * @typedef {{move?: number, stat?: string, forget?: number}} ItemChoice
 */

/**
 * What an item needs picked before it is used: a move for an Ether or a PP
 * Up, a stat for a Bottle Cap — or nothing.
 *
 * @param {string} slug
 * @returns {'move'|'stat'|null}
 */
export function itemNeedsChoice(slug) {
  const use = itemOf(slug)?.use;
  if (!use) return null;
  if (use.pp?.scope === 'one' || use.ppUp) return 'move';
  if (use.genes === 'one') return 'stat';
  return null;
}

/**
 * Apply an item to the travelling Pokémon.
 *
 * A TM is not consumed: using it teaches the move permanently, which is what
 * TMs do from Gen 5 onward and what makes them worth finding here.
 *
 * @param {import('../engine/session.mjs').Session} session
 * @param {string} slug
 * @param {ItemChoice} [choice] the move or stat a one-target item is for;
 *   without one it goes to the first move that can use it, or the weakest gene
 * @returns {{used: boolean, ok: boolean, message: string|null, evolution?: Evolving}} an
 *   evolution it sets off is left for the evolution screen to play out
 */
export function useItem(session, slug, choice = {}) {
  const item = itemOf(slug);
  const pokemon = session.active;
  if (!item) return { used: false, ok: false, message: t('items.cannotUse') };

  const label = localized(item.name, slug);

  if (item.pocket === 'machines') {
    const move = item.move;
    if (!move || !moveOf(move)) return { used: false, ok: false, message: t('items.cannotUse') };
    // The games name both the Pokémon and the move rather than refusing
    // silently, which is the only way to tell "wrong Pokémon" apart from
    // "wrong moment".
    if (!learnsMachine(pokemon, slug)) {
      return {
        used: false,
        ok: false,
        message: t('items.cannotLearn', {
          name: nameOf(pokemon),
          move: localized(moveOf(move)?.name, move),
        }),
      };
    }
    if (!session.machines.includes(move)) session.machines.push(move);
    return { used: true, ok: true, message: t('items.taught', { move: localized(moveOf(move)?.name, move) }) };
  }

  // A legendary's key item changes its shape and stays in the bag.
  if (item.use?.forme) {
    const own = speciesOf(pokemon.speciesId)?.slug ?? '';
    const forme = nextForme(pokemon, slug);
    if (forme === false) {
      return { used: false, ok: false, message: t('items.formeNothing', { name: nameOf(pokemon), item: label }) };
    }
    const plan = reshapeMoves(pokemon, pokemon.standing ?? own, forme ?? own, choice);
    // A Rotom that will not make room for its appliance's move stays out of
    // the appliance, and the item is not spent. A Calyrex or a Necrozma may
    // give its partner's move up and fuse anyway.
    if (plan.waiting && plan.required) {
      return {
        used: false,
        ok: false,
        message: t('items.formeNoRoom', { name: nameOf(pokemon), move: localized(moveOf(plan.waiting)?.name, plan.waiting) }),
      };
    }
    useFormeItem(pokemon, slug);
    pokemon.moves = plan.moves;
    // A nectar is drunk; a catalog or a meteorite stays in the bag.
    if (item.use.consumed) session.removeItem(slug);
    const form = speciesOf(pokemon.speciesId)?.forms?.find((entry) => entry.slug === forme);
    const changed = form
      ? t('items.formeChanged', { name: nameOf(pokemon), form: localized(form.name, forme ?? '') })
      : t('items.formeReverted', { name: nameOf(pokemon) });
    // What it forgot, then what it learned, in the order the games say it.
    const moves = [
      ...plan.forgot.map((move) => t('items.formeForgot', { name: nameOf(pokemon), move: localized(moveOf(move)?.name, move) })),
      ...plan.learned.map((move) => t('items.formeLearned', { name: nameOf(pokemon), move: localized(moveOf(move)?.name, move) })),
      ...(plan.waiting ? [t('items.formeGaveUp', { name: nameOf(pokemon), move: localized(moveOf(plan.waiting)?.name, plan.waiting) })] : []),
    ];
    return { used: true, ok: true, message: [changed, ...moves].join(' ') };
  }

  // Honey's scent calls a wild Pokémon over as the next thing to happen.
  if (item.use?.lure) {
    if (session.events.forced === 'wild') {
      return { used: false, ok: false, message: t('items.cannotUse') };
    }
    session.events.force('wild');
    session.removeItem(slug);
    return { used: true, ok: true, message: t('items.lured', { item: label }) };
  }

  // Anything with an effect of its own — a potion, an Ether, a vitamin, a
  // Rare Candy — does it here, whichever pocket it sits in.
  if (item.use) {
    const levelBefore = levelOf(pokemon);
    const maxBefore = maxHp(pokemon);
    if (applyUse(pokemon, item, choice)) {
      session.removeItem(slug);
      // A Rare Candy or an Exp. Candy that lifts the level does everything a
      // level won in battle does.
      const levelled = levelledUp(session, pokemon, levelBefore, maxBefore);
      const lines = [t('items.used', { name: label }), ...levelled.lines];
      // A Capsule or a Patch says what the ability turned into: "used it"
      // alone left the change to be found on the Pokémon screen, or not at all.
      if (item.use.ability) {
        const ability = formeAbility(pokemon) ?? pokemon.ability;
        lines.push(t('items.abilityChanged', { name: nameOf(pokemon), ability: localized(abilityOf(ability)?.name, ability) }));
      }
      return {
        used: true,
        ok: true,
        message: lines.join(' '),
        ...(levelled.evolution ? { evolution: levelled.evolution } : {}),
      };
    }
    // An Ability Patch or Capsule on a Pokémon with nothing to change to says
    // so — a bare "cannot be used" read as the item being broken.
    if (item.use.ability && pokemon.hp > 0) return { used: false, ok: false, message: t('items.noAbilityChange') };
    // A Pomeg and its kin have a Use of their own beside the one to hand them
    // over, so one that can do nothing says so rather than being handed over.
    if (item.use.effort) return { used: false, ok: false, message: t('items.cannotUse') };
    // A berry is both: something that can be eaten now and something that is
    // usually meant to be carried until it is needed. Using one on a Pokémon
    // at full health used to stop dead at "that cannot be used right now",
    // with no way to hand it over at all — so where the bag would offer to
    // hand the item over, a use that had nothing to do does that instead.
    //
    // Asked through `itemActions` rather than `canHold`, because the question
    // is what the bag offers for this item, not what could physically be
    // carried: PokeAPI marks a PP Max holdable, and holding one is not what
    // the medicine pocket is for. A PP Max with nothing left to buy has to go
    // on saying so.
    if (!itemActions(session, slug).equip) {
      return { used: false, ok: false, message: t('items.cannotUse') };
    }
  }

  // An evolution stone, if this Pokémon is waiting on one: handed to the
  // evolution screen, which `completeEvolution` finishes. It goes back in the
  // bag afterwards — an evolution item is kept, not spent — and, chosen by
  // the player, it is not one the screen lets them stop, as in the games.
  const evolution = pendingEvolution(pokemon, { item: slug });
  if (evolution) return { used: true, ok: true, message: null, evolution: { to: evolution.to, stoppable: false } };

  // Anything a Pokémon could carry becomes the held item instead of failing.
  if (canHold(slug)) return equipItem(session, slug);

  return { used: false, ok: false, message: t('items.cannotUse') };
}

/**
 * Everything a level gained outside a battle brings, as one gained in it does
 * — which is what a Rare Candy or an Exp. Candy does in the games: the extra
 * hit points, the friendship, the moves of the levels crossed (straight into
 * a free slot, or waiting in the move list when there is none), and an
 * evolution the new level allows — handed back for the evolution screen, which
 * the player can stop it on. In the order the battle says it.
 *
 * @param {import('./session.mjs').Session} session
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {number} before the level it was at
 * @param {number} [maxBefore] its maximum hit points at that level; left out,
 *   the level brings no hit points with it
 * @returns {{lines: string[], evolution: Evolving|null}} what to say about it,
 *   nothing when the level did not move, and the evolution it sets off
 */
export function levelledUp(session, pokemon, before, maxBefore = maxHp(pokemon)) {
  const after = levelOf(pokemon);
  if (after <= before) return { lines: [], evolution: null };
  const learned = (move) => t('battle.learned', { name: nameOf(pokemon), move: localized(moveOf(move)?.name, move) });
  const waiting = (move) => t('battle.cannotLearnMore', { name: nameOf(pokemon), move: localized(moveOf(move)?.name, move) });

  followMaxHp(pokemon, maxBefore);
  friendshipForLevels(pokemon, after - before);
  const lines = [t('battle.levelUp', { name: nameOf(pokemon), level: after })];
  for (const move of movesLearnedBetween(pokemon, before, after)) {
    if (pokemon.moves.length < 4) {
      setMove(pokemon, pokemon.moves.length, move);
      lines.push(learned(move));
    } else {
      lines.push(waiting(move));
    }
  }

  const evolution = offeredEvolution(pokemon, {
    timeOfDay: timeOfDay(),
    box: session.box,
    raining: weatherForArea(session.area) === 'rain',
    areaTags: session.area?.tags ?? [],
  });

  noteLearnedMoves(pokemon, session.machines);
  return { lines, evolution: evolution ? { to: evolution.to, stoppable: true } : null };
}

/**
 * An evolution waiting on the evolution screen: what it becomes, and whether
 * the player may stop it — a levelling one, yes; one from an item, no.
 *
 * @typedef {{to: number, stoppable: boolean}} Evolving
 */

/**
 * An evolution the evolution screen has seen through: the new species, its
 * place in the Pokédex, the moves evolving teaches, and a Nincada's shell.
 *
 * @param {import('./session.mjs').Session} session
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {number} to
 * @returns {string[]} what to say about it, in the order the games say it
 */
export function completeEvolution(session, pokemon, to) {
  const from = nameOf(pokemon);
  const fromSpecies = pokemon.speciesId;
  evolveInto(pokemon, to, session.rng);
  session.markCaught(to);
  const lines = [t('battle.evolving', { name: from, target: localized(speciesOf(pokemon.speciesId)?.name, '') })];
  const taught = learnOnEvolution(pokemon);
  for (const move of taught.learned) {
    lines.push(t('battle.learned', { name: nameOf(pokemon), move: localized(moveOf(move)?.name, move) }));
  }
  for (const move of taught.waiting) {
    lines.push(t('battle.cannotLearnMore', { name: nameOf(pokemon), move: localized(moveOf(move)?.name, move) }));
  }
  const shell = shedAfterEvolving(session, fromSpecies, pokemon);
  if (shell) lines.push(t('battle.shed', { name: nameOf(shell) }));
  noteLearnedMoves(pokemon, session.machines);
  return lines;
}

/**
 * Whether an item is one a Pokémon could be given to carry.
 *
 * This is the **one** answer to that question, and both the bag's menu and
 * `equipItem` read it. They used to ask it differently — the menu offered
 * anything in the berry pocket, and the equip refused anything whose
 * `attributes` did not carry `holdable` — so a berry whose PokeAPI record
 * spells its attributes another way put a "give to hold" button on screen that
 * answered "that cannot be held" when it was pressed. A menu that offers
 * something the engine refuses is worse than no menu at all.
 *
 * The berry pocket is holdable by definition (the whole pocket is things a
 * Pokémon carries), as is anything the engine knows a held effect for.
 *
 * @param {string} slug
 */
export function canHold(slug) {
  const item = itemOf(slug);
  // A catching berry is given to what is being caught, not carried.
  if (!item || item.capture) return false;
  return (
    item.pocket === 'berries' ||
    Boolean(item.held) ||
    Boolean(item.attributes?.includes('holdable'))
  );
}

/**
 * Put an item in the travelling Pokémon's hand.
 *
 * Holding is what a tool or a berry is for — a Leftovers does nothing in the
 * bag — so the bag offers this rather than "use" for them. Whatever was being
 * held goes back into the bag, which is how the games swap one for another.
 *
 * @param {import('../engine/session.mjs').Session} session
 * @param {string} slug
 * @returns {{used: boolean, ok: boolean, message: string}}
 */
export function equipItem(session, slug) {
  const item = itemOf(slug);
  const pokemon = session.active;
  const itemName = localized(item?.name, slug);
  if (!item || !canHold(slug)) {
    return { used: false, ok: false, message: t('items.cannotEquip', { item: itemName }) };
  }
  if (pokemon.heldItem === slug) {
    return { used: false, ok: false, message: t('items.alreadyHeld', { name: nameOf(pokemon), item: itemName }) };
  }

  const previous = pokemon.heldItem;
  if (!session.removeItem(slug)) return { used: false, ok: false, message: t('items.cannotEquip', { item: itemName }) };
  if (previous) session.addItem(previous);
  pokemon.heldItem = slug;
  settleForme(pokemon);
  return {
    used: true,
    ok: true,
    // A swap says what came back as well as what went on, as the games do.
    message: previous
      ? t('items.swapped', { old: localized(itemOf(previous)?.name, previous), item: itemName })
      : t('items.equipped', { name: nameOf(pokemon), item: itemName }),
  };
}

/**
 * Hand back what a battle used up: a Focus Sash, a gem, a herb, a balloon
 * are the Pokémon's again when the fight is over — only a berry, eaten, is
 * gone for good.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {string|null} slug what it went in holding
 * @returns {boolean} whether it was given back
 */
export function restoreHeldItem(pokemon, slug) {
  if (!slug || pokemon.heldItem || !itemOf(slug)) return false;
  // A berry eaten is gone; anything else that was used up comes back.
  if (itemOf(slug)?.pocket === 'berries' || slug.endsWith('-berry')) return false;
  pokemon.heldItem = slug;
  return true;
}

/**
 * Take the held item back into the bag.
 *
 * @param {import('./session.mjs').Session} session
 * @returns {{used: boolean, ok: boolean, message: string}}
 */
export function unequipItem(session) {
  const pokemon = session.active;
  const slug = pokemon.heldItem;
  if (!slug) return { used: false, ok: false, message: t('items.holdsNothing', { name: nameOf(pokemon) }) };

  session.addItem(slug);
  pokemon.heldItem = null;
  settleForme(pokemon);
  return {
    used: true,
    ok: true,
    message: t('items.unequipped', {
      name: nameOf(pokemon),
      item: localized(itemOf(slug)?.name, slug),
    }),
  };
}

/**
 * What the bag can do with an item, for the Pokémon travelling right now.
 *
 * The pocket decides most of it: medicine is used, a machine is taught, a ball
 * is only ever thrown on the capture screen, and a tool or a berry is carried.
 * The exception is a stone the companion is waiting on, which is used on it
 * rather than held — the one thing in those two pockets that does something
 * from the bag.
 *
 * @param {import('./session.mjs').Session} session
 * @param {string} slug
 * @returns {{use: boolean, equip: boolean}}
 */
export function itemActions(session, slug) {
  const item = itemOf(slug);
  if (!item) return { use: false, equip: false };

  // A ball is thrown at what the companion knocked down, from the capture
  // screen; there is nothing for the bag's own menu to do with one.
  if (item.pocket === 'pokeballs') return { use: false, equip: false };
  if (item.pocket === 'machines') return { use: true, equip: false };
  if (item.pocket === 'medicine') return { use: Boolean(item.use), equip: false };
  // A charm works by being in the bag, and only there.
  if (item.pocket === 'key') return { use: false, equip: false };

  // A key item for a legendary's shape is used, not held — and only offered
  // to the species it is for.
  if (item.use?.forme) {
    const species = speciesOf(session.active?.speciesId)?.slug ?? '';
    // A nectar sets one style rather than stepping through them, so it is
    // filed apart from the key items — but it is used from the bag the same.
    return { use: Boolean(USE_FORMES.get(slug)?.has(species) || SET_FORMES.get(slug)?.has(species)), equip: false };
  }

  return {
    // A Pomeg and its kin are fed from the bag, as a vitamin is; anything else
    // out here is used only to evolve something.
    use: Boolean(item.use?.effort) || Boolean(pendingEvolution(session.active, { item: slug })),
    // The same question `equipItem` answers, asked through the same function:
    // a menu that offers what the engine then refuses is the bug this pair
    // used to have.
    equip: canHold(slug),
  };
}

/**
 * Apply an item's use effect: what its own effect text says it does.
 *
 * The amounts are read off the item during the build — "Restores 20 HP",
 * "Restores 10 PP for one move" — so nothing here has
 * to guess at a number or match on a name. An item the build could make no
 * sense of never reaches the bag, so anything arriving here has an effect;
 * what it can still fail at is being pointless right now, which is what a
 * false return means.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {any} item
 * @param {ItemChoice} [choice]
 * @returns {boolean} whether anything changed
 */
function applyUse(pokemon, item, choice = {}) {
  const use = item.use;
  if (!use) return false;

  const max = maxHp(pokemon);

  // Every effect is for a Pokémon still standing.
  if (pokemon.hp <= 0) return false;
  let changed = false;

  if (use.hp !== undefined && pokemon.hp < max) {
    pokemon.hp = Math.min(max, pokemon.hp + (use.hp === 'full' ? max : use.hp));
    changed = true;
  }

  if (use.status && pokemon.status && (use.status === 'any' || use.status === pokemon.status)) {
    clearStatus(pokemon);
    changed = true;
  }

  if (use.pp) changed = restorePp(pokemon, use.pp, choice.move) || changed;

  if (use.level) {
    const level = levelOf(pokemon);
    if (level < MAX_LEVEL) {
      pokemon.experience = experienceForLevel(speciesOf(pokemon.speciesId).growthRate, level + use.level);
      changed = true;
    }
  }

  // An Exp. Candy is experience handed over directly rather than a level.
  if (use.experience) {
    if (levelOf(pokemon) < MAX_LEVEL) {
      const ceiling = experienceForLevel(speciesOf(pokemon.speciesId).growthRate, MAX_LEVEL);
      pokemon.experience = Math.min(ceiling, pokemon.experience + use.experience);
      changed = true;
    }
  }

  // A Mint rewrites which stats the nature favours, keeping the name of the
  // one it was born with — which is what the games do, and why a screen shows
  // the mint's nature rather than the original.
  if (use.nature && gameData().natures[use.nature] && pokemon.nature !== use.nature) {
    pokemon.nature = use.nature;
    changed = true;
  }

  // A Bottle Cap maxes the genes: one stat, or all of them.
  if (use.genes) changed = maximizeGenes(pokemon, use.genes, choice.stat) || changed;

  // An Ability Capsule swaps the two ordinary abilities; an Ability Patch
  // hands over the hidden one, and hands it back if it is already out.
  if (use.ability) changed = switchAbility(pokemon, use.ability) || changed;

  // A PP Up raises a move's ceiling rather than filling it.
  if (use.ppUp) changed = raiseMaxPp(pokemon, use.ppUp, choice.move) || changed;

  // A vitamin, a feather or a mochi trains one stat's effort; a Pomeg and its
  // kin take ten of it away.
  if (use.effort) changed = trainEffort(pokemon, use.effort) || changed;

  // A Fresh-Start Mochi takes every point of it back.
  if (use.resetEffort && effortOf(pokemon) > 0) {
    changeEffort(pokemon, Object.fromEntries(STATS.map((stat) => [stat, -EFFORT_STAT_MAX])));
    changed = true;
  }

  return changed;
}

/**
 * One stat's effort moved by an item, and the friendship that comes with it
 * as the games pay it — more the less fond the Pokémon already is.
 *
 * A vitamin or a feather that can add nothing — the stat at 252, or the six
 * at 510 — does nothing at all. A berry still pleases a Pokémon with no effort
 * left in that stat to take, so it goes on raising friendship until there is
 * none of that left to raise either.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {{stat: string, amount: number, friendship?: number[]}} effort
 */
function trainEffort(pokemon, effort) {
  const moved = changeEffort(pokemon, { [effort.stat]: effort.amount })[effort.stat] !== 0;
  const gain = effort.friendship;
  const fond = Boolean(gain) && (moved || effort.amount < 0) && friendshipOf(pokemon) < MAX_FRIENDSHIP;
  if (fond && gain) {
    const now = friendshipOf(pokemon);
    gainFriendship(pokemon, now < 100 ? gain[0] : now < 200 ? gain[1] : gain[2]);
  }
  return moved || fond;
}

/**
 * What the companion's held item makes of the next field event: a Cleanse
 * Tag or a Pure Incense keeps a third of the wild Pokémon away.
 *
 * @param {import('../engine/session.mjs').Session} session
 * @returns {{wild?: number}}
 */
export function eventModifiers(session) {
  return heldPassive(session.active, 'repel') ? { wild: 2 / 3 } : {};
}

/**
 * The move a key item's new shape brings that has no room to go, if using the
 * item would bring one — which is what the bag asks the player about first:
 * the moves it would be learned over, and whether giving it up is allowed.
 *
 * @param {import('../engine/session.mjs').Session} session
 * @param {string} slug
 * @returns {{move: string, required: boolean, moves: string[]}|null}
 */
export function formeMoveNeed(session, slug) {
  const pokemon = session.active;
  if (!pokemon || !itemOf(slug)?.use?.forme) return null;
  const forme = nextForme(pokemon, slug);
  if (forme === false) return null;
  const own = speciesOf(pokemon.speciesId)?.slug ?? '';
  const plan = reshapeMoves(pokemon, pokemon.standing ?? own, forme ?? own);
  return plan.waiting ? { move: plan.waiting, required: plan.required, moves: plan.moves.map((slot) => slot.move) } : null;
}

/**
 * What a change of shape does to a Pokémon's moves, worked out on a copy so it
 * can be asked about before anything happens (see `FORME_MOVE_RULES`).
 *
 * Each move the old shape brought gives way to the one the new shape brings
 * in its place; one with nothing in its place is forgotten, and a Kyurem that
 * learns Scary Face while fused forgets it again rather than know it twice. A
 * new move with no old one to take the place of is learned into a free slot,
 * or over the slot the player picked; with no slot and no pick it is left
 * `waiting`. Back in its own shape, a Calyrex forgets whatever its own shape
 * cannot learn, and anything left with no moves remembers its fallback.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {string} from the shape it is in (its species' slug for its own)
 * @param {string} to the shape it is going to
 * @param {ItemChoice} [choice]
 * @returns {{moves: Array<{move: string, pp: number, ppUp?: number}>, learned: string[], forgot: string[], waiting: string|null, required: boolean}}
 */
export function reshapeMoves(pokemon, from, to, choice = {}) {
  const species = speciesOf(pokemon.speciesId);
  const rule = FORME_MOVE_RULES.get(species?.slug ?? '');
  const moves = pokemon.moves.map((slot) => ({ ...slot }));
  /** @type {string[]} */
  const learned = [];
  /** @type {string[]} */
  const forgot = [];
  /** @type {string|null} */
  let waiting = null;
  const out = () => ({ moves, learned, forgot, waiting, required: Boolean(rule?.required) });
  if (!rule) return out();

  const fresh = (move) => ({ move, pp: moveOf(move)?.pp ?? 5, ppUp: 0 });
  const knows = (move) => moves.findIndex((slot) => slot.move === move);
  const forget = (at) => forgot.push(moves.splice(at, 1)[0].move);

  const old = rule.moves[from] ?? [];
  const next = rule.moves[to] ?? [];
  for (let place = 0; place < Math.max(old.length, next.length); place++) {
    const was = old[place];
    const now = next[place] && moveOf(next[place]) ? next[place] : null;
    const at = was && was !== now ? knows(was) : -1;
    if (now && knows(now) >= 0) {
      if (at >= 0) forget(at);
    } else if (now && at >= 0) {
      forgot.push(was);
      moves[at] = fresh(now);
      learned.push(now);
    } else if (now && rule.learns) {
      if (moves.length < 4) {
        moves.push(fresh(now));
        learned.push(now);
      } else if (Number.isInteger(choice.forget) && moves[/** @type {number} */ (choice.forget)]) {
        forgot.push(moves[/** @type {number} */ (choice.forget)].move);
        moves[/** @type {number} */ (choice.forget)] = fresh(now);
        learned.push(now);
      } else {
        waiting = now;
      }
    } else if (!now && at >= 0) {
      forget(at);
    }
  }

  // Off its steed, a Calyrex keeps only what a Calyrex can learn.
  if (rule.unlearnable && to === species.slug) {
    const own = new Set([
      ...(species.learnset.level ?? []).map(([, move]) => move),
      ...(species.learnset.machine ?? []),
      ...(species.learnset.tutor ?? []),
    ]);
    for (let at = moves.length - 1; at >= 0; at--) if (!own.has(moves[at].move)) forget(at);
  }
  if (!moves.length && rule.fallback && moveOf(rule.fallback)) {
    moves.push(fresh(rule.fallback));
    learned.push(rule.fallback);
  }
  return out();
}

/**
 * Max the genes a Bottle Cap is spent on: the stat the player picked, or —
 * with no pick, as the auto-use has none — the lowest one.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {'one'|'all'} scope
 * @param {string} [stat]
 */
function maximizeGenes(pokemon, scope, stat) {
  const weakest = [...STATS].sort((a, b) => (pokemon.ivs[a] ?? 0) - (pokemon.ivs[b] ?? 0))[0];
  const stats = scope === 'all' ? [...STATS] : [stat && STATS.includes(stat) ? stat : weakest];
  let changed = false;
  for (const stat of stats) {
    if ((pokemon.ivs[stat] ?? 0) >= MAX_IV) continue;
    pokemon.ivs = { ...pokemon.ivs, [stat]: MAX_IV };
    changed = true;
  }
  return changed;
}

/**
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {'swap'|'hidden'} how
 */
function switchAbility(pokemon, how) {
  const abilities = speciesOf(pokemon.speciesId)?.abilities ?? [];
  if (abilities.length === 0) return false;

  if (how === 'hidden') {
    const hidden = abilities.find((entry) => entry.hidden);
    if (!hidden) return false;
    // A Patch used on a Pokémon that already has the hidden ability puts the
    // ordinary one back, as it does in the games.
    const next = pokemon.ability === hidden.name ? abilities.find((entry) => !entry.hidden) : hidden;
    if (!next || next.name === pokemon.ability) return false;
    pokemon.ability = next.name;
    return true;
  }

  const ordinary = abilities.filter((entry) => !entry.hidden);
  if (ordinary.length < 2) return false;
  const slot = abilitySlot(pokemon);
  // The Capsule has nothing to swap a hidden ability with.
  if (slot < 0 || abilities[slot]?.hidden) return false;
  const next = ordinary[(ordinary.findIndex((entry) => entry.name === pokemon.ability) + 1) % ordinary.length];
  if (!next || next.name === pokemon.ability) return false;
  pokemon.ability = next.name;
  return true;
}

/**
 * Raise a move's ceiling, and fill what was just added.
 *
 * The raise is kept per slot rather than on the move, because two Pokémon can
 * know the same move with different amounts spent on it. A slot at the cap
 * takes nothing, which is what makes a PP Max worth holding on to.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {{fraction: number, max: number}} ppUp
 * @param {number} [index] the move slot picked, if one was
 */
function raiseMaxPp(pokemon, ppUp, index) {
  const room = (entry) => entry && (entry.ppUp ?? 0) < ppUp.max - 1e-9 && moveOf(entry.move);
  const slot = index !== undefined ? (room(pokemon.moves[index]) ? pokemon.moves[index] : null) : pokemon.moves.find(room);
  if (!slot) return false;

  const before = maxPp(slot);
  slot.ppUp = Math.min(ppUp.max, (slot.ppUp ?? 0) + ppUp.fraction);
  slot.pp += maxPp(slot) - before;
  return true;
}

/** The highest a gene goes. */
const MAX_IV = 31;

/**
 * Put PP back: into the first move that has lost any, or into all of them.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {{amount: number|'full', scope: 'one'|'all'}} pp
 * @param {number} [index] the move slot picked, if one was
 */
function restorePp(pokemon, pp, index) {
  const spent = pokemon.moves.filter((slot) => slot.pp < maxPp(slot));
  const chosen = index !== undefined ? spent.filter((slot) => slot === pokemon.moves[index]) : spent.slice(0, 1);
  const targets = pp.scope === 'all' ? spent : chosen;
  if (targets.length === 0) return false;

  for (const slot of targets) {
    const full = maxPp(slot);
    slot.pp = pp.amount === 'full' ? full : Math.min(full, slot.pp + pp.amount);
  }
  return true;
}

/** The level nothing grows past. */
const MAX_LEVEL = 100;

/**
 * The medicine in the bag that would do this Pokémon some good right now,
 * weakest first — a Potion is the right answer to a scratch, and hoarding the
 * Full Restore for when it is needed is what a player does by hand.
 *
 * @param {import('./session.mjs').Session} session
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * `power` is what the item is worth — the amount it promises, or a full bar
 * where it promises none — and `restores` what that comes to on this Pokémon
 * right now, which is what there is any point showing.
 *
 * @returns {Array<{slug: string, count: number, item: any, power: number, restores: number}>}
 */
export function healingItems(session, pokemon) {
  const max = maxHp(pokemon);
  const missing = max - pokemon.hp;

  return session
    .pocket('medicine')
    // What a battle can throw: the ones that put hit points back. A status
    // cure has its moment, and this is not it.
    .filter(({ item }) => item.use?.hp !== undefined)
    .map(({ slug, count, item }) => {
      const power = item.use.hp === 'full' ? max : item.use.hp;
      return { slug, count, item, power, restores: Math.min(missing, power) };
    })
    .filter((entry) => entry.restores > 0)
    .sort((a, b) => a.power - b.power || a.slug.localeCompare(b.slug));
}

/**
 * The item an automatic throw should use: the one the player named, or the
 * smallest that covers the damage taken.
 *
 * @param {import('./session.mjs').Session} session
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {string|null} preferred a slug, or null for "whatever fits"
 */
export function healingItemFor(session, pokemon, preferred) {
  const available = healingItems(session, pokemon);
  if (available.length === 0) return null;

  if (preferred) {
    const named = available.find((entry) => entry.slug === preferred);
    return named ? named.slug : null;
  }

  const missing = maxHp(pokemon) - pokemon.hp;
  const covers = available.find((entry) => entry.power >= missing);
  // Nothing covers it: the largest heal on hand is the next best thing.
  return (covers ?? available[available.length - 1]).slug;
}

/**
 * How far a win tops the companion back up from the bag, as a share of its
 * full health. `never` leaves it as the fight left it.
 */
export const AFTER_BATTLE_TARGETS = { never: 0, hpHalf: 1 / 2, hpTwoThirds: 2 / 3, full: 1 };

/** A backstop on one top-up, so a bag that somehow stops helping cannot spin. */
const MAX_TOP_UP_ITEMS = 12;

/** A move is topped up after a battle once it is down to this share of its PP. */
export const PP_LOW_SHARE = 1 / 4;

/**
 * Top a Pokémon up from the bag after a battle, as far as `target` asks, and
 * — each where its switch is on — cure its condition and put PP back into
 * the moves running low.
 *
 * Each potion is the smallest that closes what is left of the gap, and the
 * largest on hand when none does — the same "whatever fits" the automatic
 * throw uses, aimed at the target rather than at a full bar, so a Potion is
 * not spent where a Potion's worth is not missing and a Hyper Potion is not
 * spent on a scratch. A condition takes the narrowest cure the bag has. A
 * move down to a quarter of its PP takes the smallest Ether, one move at a
 * time, and an Elixir only when there is no Ether left.
 *
 * @param {import('./session.mjs').Session} session
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {string} target a key of {@link AFTER_BATTLE_TARGETS}
 * @param {{status?: boolean, pp?: boolean}} [also] the condition, and the PP
 * @returns {Array<{slug: string, count: number}>} what was used, in order
 */
export function healAfterBattle(session, pokemon, target, also = {}) {
  if (pokemon.hp <= 0) return [];
  const share = AFTER_BATTLE_TARGETS[target] ?? 0;
  const goal = Math.ceil(maxHp(pokemon) * share);
  const cure = also.status ?? target === 'full';

  /** @type {Map<string, number>} */
  const used = new Map();
  const spend = (/** @type {string} */ slug) => used.set(slug, (used.get(slug) ?? 0) + 1);
  for (let step = 0; share > 0 && step < MAX_TOP_UP_ITEMS && pokemon.hp < goal; step++) {
    const available = healingItems(session, pokemon);
    if (available.length === 0) break;
    const gap = goal - pokemon.hp;
    const pick = available.find((entry) => entry.power >= gap) ?? available[available.length - 1];
    if (!throwItem(session, pick.slug, pokemon)) break;
    spend(pick.slug);
  }
  if (cure && pokemon.status) {
    const remedy = statusCures(session, pokemon)[0];
    if (remedy && throwItem(session, remedy.slug, pokemon)) spend(remedy.slug);
  }
  if (also.pp) {
    for (let step = 0; step < MAX_TOP_UP_ITEMS; step++) {
      // The move furthest down first.
      const low = pokemon.moves
        .map((entry, index) => ({ entry, index, share: entry ? entry.pp / Math.max(1, maxPp(entry)) : 1 }))
        .filter(({ share: left }) => left <= PP_LOW_SHARE)
        .sort((a, b) => a.share - b.share)[0];
      if (!low) break;
      const items = ppItems(session, pokemon);
      const pick = items.find((entry) => entry.scope === 'one') ?? items[0];
      if (!pick || !throwItem(session, pick.slug, pokemon, { move: low.index })) break;
      spend(pick.slug);
    }
  }
  return [...used].map(([slug, count]) => ({ slug, count }));
}

/**
 * The medicine in the bag that would cure this Pokémon's status condition,
 * narrowest first: the cure for exactly this condition, then one for any, and
 * one that heals as well last — an Antidote before a Full Heal before a Full
 * Restore, which is worth keeping for when the health is wanted too.
 *
 * @param {import('./session.mjs').Session} session
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @returns {Array<{slug: string, count: number, item: any}>}
 */
export function statusCures(session, pokemon) {
  if (!pokemon.status || pokemon.hp <= 0) return [];
  const rank = (use) => (use.hp !== undefined ? 2 : use.status === 'any' ? 1 : 0);
  return session
    .pocket('medicine')
    .filter(({ item }) => item.use?.status && (item.use.status === 'any' || item.use.status === pokemon.status))
    .sort((a, b) => rank(a.item.use) - rank(b.item.use) || (a.item.cost ?? 0) - (b.item.cost ?? 0) || a.slug.localeCompare(b.slug));
}

/**
 * The PP medicine a battle can throw: an Ether or a Max Ether for one move
 * run low, an Elixir or a Max Elixir for all of them — the ones that would
 * put something back: the one-move kind first, the smaller of each first.
 *
 * @param {import('./session.mjs').Session} session
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @returns {Array<{slug: string, count: number, item: any, scope: 'one'|'all'}>}
 */
export function ppItems(session, pokemon) {
  if (pokemon.hp <= 0) return [];
  const short = pokemon.moves.some((entry) => entry && entry.pp < maxPp(entry));
  if (!short) return [];
  return session
    .pocket('medicine')
    .filter(({ item }) => item.use?.pp)
    .map(({ slug, count, item }) => ({ slug, count, item, scope: item.use.pp.scope === 'one' ? /** @type {const} */ ('one') : /** @type {const} */ ('all') }))
    // One move's worth before every move's, then the smaller of each first.
    .sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'one' ? -1 : 1) || (a.item.cost ?? 0) - (b.item.cost ?? 0) || a.slug.localeCompare(b.slug));
}

/**
 * Everything in the medicine pocket a battle can throw — hit points, a
 * condition, PP — whether or not it would do anything right now, as the
 * games' bag lists it in a fight. Each says which it is and whether it would
 * help; the bag shows the rest greyed out rather than leaving them out, which
 * read as the bag having no Antidote at all.
 *
 * In the order the bag lists them: hit points (the smaller first), then the
 * conditions (one condition's cure before the cure-alls), then PP (one move's
 * before every move's).
 *
 * @param {import('./session.mjs').Session} session
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @returns {Array<{slug: string, count: number, item: any, kind: 'hp'|'status'|'pp', usable: boolean, power?: number, restores?: number, scope?: 'one'|'all'}>}
 */
export function battleMedicine(session, pokemon) {
  const alive = pokemon.hp > 0;
  const max = maxHp(pokemon);
  const missing = Math.max(0, max - pokemon.hp);
  const short = pokemon.moves.some((entry) => entry && entry.pp < maxPp(entry));
  const medicine = session.pocket('medicine');

  const hp = medicine
    .filter(({ item }) => item.use?.hp !== undefined)
    .map(({ slug, count, item }) => {
      const power = item.use.hp === 'full' ? max : item.use.hp;
      // A Full Restore is worth throwing for its cure alone.
      const cures = Boolean(item.use.status && pokemon.status);
      return { slug, count, item, kind: /** @type {const} */ ('hp'), power, restores: Math.min(missing, power), usable: alive && (missing > 0 || cures) };
    })
    .sort((a, b) => a.power - b.power || a.slug.localeCompare(b.slug));

  const status = medicine
    .filter(({ item }) => item.use?.status && item.use.hp === undefined)
    .map(({ slug, count, item }) => ({
      slug,
      count,
      item,
      kind: /** @type {const} */ ('status'),
      usable: alive && Boolean(pokemon.status) && (item.use.status === 'any' || item.use.status === pokemon.status),
    }))
    .sort((a, b) =>
      Number(a.item.use.status === 'any') - Number(b.item.use.status === 'any') ||
      (a.item.cost ?? 0) - (b.item.cost ?? 0) ||
      a.slug.localeCompare(b.slug));

  const pp = medicine
    .filter(({ item }) => item.use?.pp)
    .map(({ slug, count, item }) => ({
      slug,
      count,
      item,
      kind: /** @type {const} */ ('pp'),
      scope: item.use.pp.scope === 'one' ? /** @type {const} */ ('one') : /** @type {const} */ ('all'),
      usable: alive && short,
    }))
    .sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'one' ? -1 : 1) || (a.item.cost ?? 0) - (b.item.cost ?? 0) || a.slug.localeCompare(b.slug));

  return [...hp, ...status, ...pp];
}

/**
 * Take one healing item from the bag and apply it, wherever it was thrown
 * from.
 *
 * @param {import('./session.mjs').Session} session
 * @param {string} slug
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {{move?: number}} [choice] which move an Ether is for
 * @returns {boolean} whether it was used
 */
export function throwItem(session, slug, pokemon, choice = {}) {
  const item = itemOf(slug);
  if (!item || session.countOf(slug) <= 0) return false;
  if (!applyUse(pokemon, item, choice)) return false;
  session.removeItem(slug);
  return true;
}

/**
 * How much a berry is worth holding for this Pokémon; 0 or less is not one
 * to hold at all.
 *
 * The kinds rank in the order they save a fight:
 *
 * 1. **halving a 4× weakness** — the one hit that would end it outright;
 * 2. **healing** that restores at least a fifth of its health (a Sitrus), the
 *    most first, leaving out any its nature would confuse it with;
 * 3. **halving a 2× weakness**;
 * 4. **a small heal** — an Oran is ten hit points, which stops mattering well
 *    before the end of the game;
 * 5. **a pinch berry** for the attacking stat it leans on, then Speed, then
 *    any stat, then the rest;
 * 6. **a cure** — a Lum for anything, then one for a single condition — and
 *    a Leppa for a move run dry;
 * 7. a heal its nature dislikes, as a last resort.
 *
 * @param {any} held the berry's parsed held effect
 * @param {{hp: number, types: string[], leansOn: string, confuses: (held: any) => boolean}} context
 */
function berryScore(held, context) {
  if (!held) return 0;
  if (held.on === 'resist' && held.moveType) {
    const effectiveness = typeEffectiveness(held.moveType, context.types);
    if (effectiveness >= 4) return 700 + effectiveness;
    if (effectiveness > 1) return 500 + effectiveness;
    return 0;
  }
  if (held.on === 'hp' && held.heal) {
    const amount = held.heal.amount ?? Math.floor(context.hp * (held.heal.fraction ?? 0));
    const share = context.hp > 0 ? Math.min(1, amount / context.hp) : 0;
    if (context.confuses(held)) return 10 + share;
    return (share >= 1 / 5 ? 600 : 400) + share * 100;
  }
  if (held.on === 'hp' && held.stat) {
    if (held.stat === context.leansOn) return 304;
    if (held.stat === 'spe') return 303;
    if (held.stat === 'random') return 302;
    return 301;
  }
  if (held.on === 'status') return held.status === 'any' ? 202 : 200;
  if (held.on === 'pp') return 201;
  return 0;
}

/**
 * What {@link berryScore} needs to know about the Pokémon.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 */
function berryContext(pokemon) {
  const nature = gameData().natures?.[pokemon.nature];
  const stats = statsOf(pokemon);
  return {
    hp: maxHp(pokemon),
    types: standingTypes(pokemon),
    leansOn: (stats.atk ?? 0) >= (stats.spa ?? 0) ? 'atk' : 'spa',
    confuses: (/** @type {any} */ held) =>
      Boolean(held.dislikes && nature?.decreased === held.dislikes && nature.increased !== nature.decreased),
  };
}

/**
 * The berry in the bag that suits this Pokémon best, or null if the bag holds
 * none worth holding. See {@link berryScore} for the order.
 *
 * @param {import('./session.mjs').Session} session
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @returns {string|null}
 */
export function bestBerry(session, pokemon) {
  const context = berryContext(pokemon);

  // Every berry in the bag, whichever pocket the data files it in.
  const held = [...session.pocket('berries'), ...session.pocket('medicine')]
    .filter(({ slug, item }) => (item?.pocket === 'berries' || slug.endsWith('-berry')) && item?.held && item.works !== false);

  let best = null;
  let bestScore = 0;
  for (const { slug, item } of held.sort((a, b) => a.slug.localeCompare(b.slug))) {
    const score = berryScore(item.held, context);
    if (score > bestScore) {
      best = slug;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The berry to put in a Pokémon's hand from the player's own order: the first
 * of the three ranks that is actually in the bag.
 *
 * @param {import('./session.mjs').Session} session
 * @param {Array<string|null>} priorities
 */
export function berryToHold(session, priorities) {
  for (const slug of priorities) {
    if (slug && session.countOf(slug) > 0 && itemOf(slug)) return slug;
  }
  return null;
}

/**
 * The order the Recommend button fills the three ranks with for this Pokémon:
 * a berry that heals it, then one that halves a hit it is weak to, then one
 * that raises a stat when it is in a pinch.
 *
 * Each is the best of its kind — the heal that restores the most, the resist
 * berry for the type it is weakest to, the pinch berry for the attacking stat
 * it leans on, then Speed — out of the berries the bag holds where it holds
 * any of the kind, and out of every berry where it does not, so the order is
 * ready for the first one found.
 *
 * @param {import('./session.mjs').Session} session
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @returns {Array<string|null>} three ranks
 */
export function recommendedBerries(session, pokemon) {
  const berries = Object.entries(gameData().items).filter(
    ([slug, item]) => item?.pocket === 'berries' && item.works !== false && item.held && slug.endsWith('-berry'),
  );
  const context = berryContext(pokemon);

  /** @param {(held: any) => boolean} kind */
  const best = (kind) => {
    const scored = berries
      .filter(([, item]) => kind(item.held))
      .map(([slug, item]) => ({ slug, score: berryScore(item.held, context), have: session.countOf(slug) > 0 }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
    return (scored.find((entry) => entry.have) ?? scored[0])?.slug ?? null;
  };

  return [
    best((held) => held.on === 'hp' && Boolean(held.heal) && !context.confuses(held)),
    best((held) => held.on === 'resist'),
    best((held) => held.on === 'hp' && Boolean(held.stat)),
  ];
}

/**
 * Hand the companion a berry if it is holding nothing — whatever it held has
 * been eaten, used up or knocked away. The player's three ranks come first;
 * with none of them in the bag, and the automatic setting on, the berry in the
 * bag that suits it best takes the place. Returns the berry handed over, if
 * any.
 *
 * @param {import('./session.mjs').Session} session
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 */
export function restockBerry(session, pokemon) {
  if (!pokemon || pokemon.heldItem) return null;
  const policy = session.itemPolicy;
  const berry = berryToHold(session, policy?.berries ?? []) ?? (policy?.autoBerry ? bestBerry(session, pokemon) : null);
  if (!berry) return null;

  session.removeItem(berry);
  pokemon.heldItem = berry;
  return berry;
}

/**
 * The Pokémon whose held items do nothing for the moment: the ones standing
 * in a Magic Room, and one whose Klutz a battle handed it. The battle adds and
 * removes them; nothing here is saved.
 *
 * @type {WeakSet<object>}
 */
export const itemsSuppressed = new WeakSet();

/**
 * What the held item does simply by being held, if anything.
 *
 * The consumable rules — a berry waiting for half a bar or for a paralysis —
 * are read by `heldTrigger`; this is the other half: the Leftovers that heal
 * every turn, the Choice Band that trades moves for power, the Charcoal that
 * makes a fire move hit harder. Both come off the same parsed effect, told
 * apart by what the effect is keyed on.
 *
 * @param {import('./pokemon.mjs').Pokemon|null|undefined} pokemon
 * @param {string} kind the effect to ask for
 * @returns {any|null}
 */
export function heldPassive(pokemon, kind) {
  // A Klutz carries its item and gets nothing from it, and nothing gets
  // anything from one under a Magic Room.
  if (pokemon?.ability === 'klutz' || (pokemon && itemsSuppressed.has(pokemon))) return null;
  const held = pokemon?.heldItem ? itemOf(pokemon.heldItem)?.held : null;
  return held && held.on === kind ? held : null;
}

/**
 * What a held item keeps off its holder.
 *
 * A pair of Safety Goggles refuses powder and the weather, Protective Pads
 * refuse whatever touching would have cost, a Clear Amulet refuses a stat
 * drop and a Covert Cloak refuses a move's side effects. All four are the same
 * shape — a shield with a list of what it stops — so they are asked the same
 * question.
 *
 * @param {import('./pokemon.mjs').Pokemon|null|undefined} pokemon
 * @param {string} against the kind of harm
 * @returns {any} the shield's value for it, or null
 */
export function heldShield(pokemon, against) {
  const shield = heldPassive(pokemon, 'shield');
  return shield?.[against] ?? null;
}

/**
 * Whether a held item's effect applies to this Pokémon at all.
 *
 * Most do not care who is holding them. A Thick Club cares a great deal — it
 * doubles the Attack of a Cubone and does nothing for anything else — so the
 * ones that name a species are checked against the one holding them. Names are
 * compared without their punctuation, because a Farfetch'd is filed as
 * `farfetchd` and written with an apostrophe.
 *
 * @param {any} held the parsed held effect
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 */
export function itemSuits(held, pokemon) {
  if (!held?.species?.length) return true;
  // A regional form is the species the item was made for: an Alolan Marowak
  // swings a Thick Club as any Marowak does.
  const species = speciesOf(pokemon.speciesId);
  const base = species?.dex ? speciesOf(species.dex) : species;
  const slug = (base?.slug ?? '').replace(/[^a-z0-9]/g, '');
  return held.species.includes(slug);
}

/**
 * Whether the held item's moment has come.
 *
 * Every berry that does something while held carries the rule it does it by —
 * the pipeline reads it off the item's own effect text — so this is only a
 * matter of asking whether the rule is satisfied now. An Oran waits for half
 * health, a Liechi for a quarter, a Cheri for the paralysis it cures, a Leppa
 * for a move that has run dry.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {{early?: boolean}} [options] whether a Gluttony is reaching early
 * @returns {{slug: string, held: any}|null}
 */
export function heldTrigger(pokemon, options = {}) {
  if (itemsSuppressed.has(pokemon)) return null;
  const slug = pokemon.heldItem;
  const held = slug ? itemOf(slug)?.held : null;
  if (!slug || !held || pokemon.hp <= 0) return null;

  switch (held.on) {
    case 'hp': {
      // A Gluttony reaches for a berry at half health however low the berry
      // itself waits for, which is what makes the pinch berries worth holding.
      const at = options.early ? Math.max(held.at, 1 / 2) : held.at;
      return pokemon.hp <= maxHp(pokemon) * at ? { slug, held } : null;
    }
    case 'status':
      return pokemon.status && (held.status === 'any' || held.status === pokemon.status) ? { slug, held } : null;
    case 'pp':
      return emptyMove(pokemon) ? { slug, held } : null;
    default:
      return null;
  }
}

/**
 * Do what the held item promises, as far as the Pokémon itself is concerned.
 *
 * A berry that raises a stat is the battle's business rather than the
 * Pokémon's — stages live on the combatant, not on the save — so that one is
 * left to the caller and reported as unhandled here.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {any} held
 * @returns {boolean} whether anything changed
 */
export function applyHeldEffect(pokemon, held) {
  if (held.on === 'hp' && held.heal) {
    const max = maxHp(pokemon);
    const amount = held.heal.amount ?? Math.max(1, Math.floor(max * held.heal.fraction));
    if (pokemon.hp >= max) return false;
    pokemon.hp = Math.min(max, pokemon.hp + amount);
    return true;
  }

  if (held.on === 'status') {
    if (!pokemon.status) return false;
    clearStatus(pokemon);
    return true;
  }

  if (held.on === 'pp') {
    const slot = emptyMove(pokemon);
    if (!slot) return false;
    slot.pp = Math.min(maxPp(slot), slot.pp + held.amount);
    return true;
  }

  return false;
}

/**
 * The first move that has run out of PP, which is what a Leppa Berry is
 * waiting for.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 */
function emptyMove(pokemon) {
  return pokemon.moves.find((slot) => slot.pp <= 0 && moveOf(slot.move)) ?? null;
}

/**
 * How often an item find is a legendary's own item, while that legendary is
 * the one travelling and does not have it yet.
 *
 * A Blue Orb is no use to a Pikachu, and a bag that filled up with seventeen
 * memories and four drives for Pokémon the player never met would be clutter.
 * So those items are only ever found by the Pokémon they are for — and rarely,
 * a tenth of the finds, which is something like one an hour of walking.
 */
export const SIGNATURE_FIND_CHANCE = 0.1;

/**
 * The same on the save's first run, before it has a champion: a third as
 * often, so a forme change or an orb is something the first trip earns
 * slowly rather than a few hours' walking.
 */
export const FIRST_RUN_SIGNATURE_FIND_CHANCE = 0.03;

/**
 * How often a find is one of a set a Pokémon collects a type at a time —
 * Arceus's plates, Silvally's memories, Genesect's drives — once the save has
 * a champion: three times the one-off items' odds. Seventeen plates at the
 * rate of one orb took the best part of a day's walking to gather, and each is
 * only one type of the many the Pokémon is meant to switch between. The first
 * run keeps the one-off items' slow rate for these too.
 */
export const COLLECTION_FIND_CHANCE = 0.3;

/** Built once: which species each signature item is for. */
let signature = /** @type {Map<string, string[]>|null} */ (null);

/**
 * The legendary's own item an item find turns out to be, if it does.
 *
 * @param {import('./session.mjs').Session} session
 * @returns {string|null}
 */
export function signatureFind(session) {
  signature ??= signatureItems();
  const species = speciesOf(session.active?.speciesId);
  const slug = species?.slug ?? '';
  const held = new Set([session.active, ...session.box].map((pokemon) => pokemon?.heldItem).filter(Boolean));
  // And what it evolves by, where the ordinary finds never hand that out: a
  // Galarica Cuff, a Leader's Crest, an apple for an Applin.
  const ordinary = new Set(Object.values(gameData().itemTiers ?? {}).flat());
  const evolvesBy = (species?.evolutions ?? [])
    .flatMap((evolution) => [evolution.item, evolution.heldItem])
    .filter((item) => item && !ordinary.has(item));
  const wanted = [
    ...[...signature].filter(([, owners]) => owners.includes(slug)).map(([item]) => item),
    ...evolvesBy,
  ].filter((item, index, all) => all.indexOf(item) === index && itemOf(item) && !held.has(item) && session.countOf(item) === 0);
  const chance = session.firstRun
    ? FIRST_RUN_SIGNATURE_FIND_CHANCE
    : (wanted.some(collectedByType) ? COLLECTION_FIND_CHANCE : SIGNATURE_FIND_CHANCE);
  if (!wanted.length || !session.rng.chance(chance)) return null;
  return session.rng.pick(wanted);
}

/**
 * Whether a Pokémon's species can be taught a TM's move.
 *
 * @param {import('./pokemon.mjs').Pokemon|null|undefined} pokemon
 * @param {string} slug the TM
 */
export function learnsMachine(pokemon, slug) {
  const move = itemOf(slug)?.move;
  return Boolean(move && pokemon && speciesOf(pokemon.speciesId)?.learnset.machine.includes(move));
}

/**
 * How often, on the save's first run, a TM found is drawn again from the ones
 * the travelling Pokémon can learn. A Pokémon learns a fifth or so of the
 * TMs, so four finds in five were a TM it could do nothing with; this makes
 * it more like three in five that it can use. After a champion the TMs come
 * as they fall.
 */
export const LEARNABLE_MACHINE_SHARE = 0.5;

/**
 * How many of a supply in the bag halve the chance of finding it rather than
 * another: none counts in full, five half, fifteen a quarter.
 */
export const STOCK_HALVES_AT = 5;

/**
 * How much a find leans to a supply the bag has `count` of.
 *
 * @param {number} count
 */
export function stockWeight(count) {
  return 1 / (1 + Math.max(0, count) / STOCK_HALVES_AT);
}

/**
 * One of some supplies — berries, potions, anything the bag stocks by the
 * dozen — leaning to whichever the bag is shortest of, so a find tops up what
 * is running out rather than piling onto what is already plenty.
 *
 * @param {import('./session.mjs').Session} session
 * @param {string[]} slugs
 * @returns {string|null}
 */
export function shortestSupply(session, slugs) {
  return session.rng.weighted(slugs.map((slug) => ({ value: slug, weight: stockWeight(session.countOf(slug)) })));
}

/** The kinds of medicine a battle gets through: what restores HP, cures or restores PP. */
const EVERYDAY_MEDICINE = new Set(['healing', 'status-cures', 'pp-recovery']);

/**
 * Whether an item is medicine a battle gets through — a potion, a cure, an
 * Ether — rather than a vitamin, a mint or a Rare Candy.
 *
 * @param {string} slug
 */
export function isEverydayMedicine(slug) {
  const item = itemOf(slug);
  return item?.pocket === 'medicine' && EVERYDAY_MEDICINE.has(item.category);
}

/**
 * An item found out of a pool: any of it alike, except that a potion, a cure
 * or an Ether gives way to whichever of those the bag is shortest of (see
 * `shortestSupply`), and on the save's first run a TM is now and then traded
 * for one the travelling Pokémon can learn (see `LEARNABLE_MACHINE_SHARE`).
 * How often a find is a TM, a ball or a potion at all is the pool's, as it
 * was.
 *
 * Only those lean. The Pokémon Center hands out potions by the dozen, so a
 * find leaning across the whole medicine pocket gave up its potions to the
 * vitamins and mints, held one or none apiece as the cures are; kept to the
 * medicine a battle uses, what the potions give up goes to the cures and the
 * Ethers. A ball is found as it falls: the balls the bag is short of are the
 * ones the companion never throws, and leaning to them traded Ultra Balls for
 * Heal Balls — more throws a catch, and more catches missed for want of one.
 *
 * @param {import('./session.mjs').Session} session
 * @param {string[]} pool
 * @returns {string|null}
 */
export function pickFind(session, pool) {
  if (!pool.length) return null;
  let found = session.rng.pick(pool);
  if (isEverydayMedicine(found)) found = shortestSupply(session, pool.filter(isEverydayMedicine)) ?? found;
  if (!session.firstRun || itemOf(found)?.pocket !== 'machines') return found;
  const learnable = pool.filter((slug) => itemOf(slug)?.pocket === 'machines' && learnsMachine(session.active, slug));
  return learnable.length && session.rng.chance(LEARNABLE_MACHINE_SHARE) ? session.rng.pick(learnable) : found;
}

/**
 * A Nincada that became a Ninjask leaves its shell behind: a Shedinja, if
 * there is a Poké Ball in the bag to put it in and room in the box, the way
 * the games leave one in a free party slot.
 *
 * @param {import('./session.mjs').Session} session
 * @param {number} fromSpeciesId the species that just evolved
 * @param {import('./pokemon.mjs').Pokemon} evolved
 * @returns {import('./pokemon.mjs').Pokemon|null} the Shedinja, if one was left
 */
export function shedAfterEvolving(session, fromSpeciesId, evolved) {
  const shed = speciesOf(fromSpeciesId)?.evolutions?.find((evolution) => evolution.trigger === 'shed');
  if (!shed || !speciesOf(shed.to) || session.countOf('poke-ball') <= 0 || session.boxFull) return null;
  const shell = createPokemon(session.rng, shed.to, levelOf(evolved), { ball: 'poke-ball' });
  shell.ivs = { ...evolved.ivs };
  shell.nature = evolved.nature;
  if (!session.storeInBox(shell)) return null;
  session.removeItem('poke-ball');
  return shell;
}
