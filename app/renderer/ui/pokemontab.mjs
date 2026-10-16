/**
 * The Pokémon tab: who you are travelling with, and what they can do.
 *
 * Left is the sprite as it appears on the field, with the stat hexagon the
 * main series uses; right is the level, typing and the four move slots. A slot
 * shows what the move actually does, and offers the list of moves this Pokémon
 * could hold instead — its level-up moves so far, plus anything a TM has
 * unlocked.
 */
import { MOVE_FLAG_SET } from '../../shared/move-flags.mjs';
import { abilityOf, gameData, moveOf, speciesOf } from '../core/data.mjs';
import { button, el, scrollable, shinyMark, statusMark } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { abilityName, abilityInert, abilityWorks } from '../engine/abilities.mjs';
import { standingTypes } from '../engine/forms.mjs';
import { unequipItem } from '../engine/items.mjs';
import { itemOf } from '../core/data.mjs';
import { experienceProgress, levelOf, maxHp, maxPp, movesByRecency, noteLearnedMoves, setMove, statsOf } from '../engine/pokemon.mjs';
import { computeStat, STATS } from '../engine/stats.mjs';
import { autoBattleScene } from './autobattle.mjs';
import { chooseFromList, describe } from './dialog.mjs';
import { moveCard, moveSummary } from './movecard.mjs';
import { walkerPortrait } from './portrait.mjs';
import { statHexagon, statTable } from './statgraph.mjs';
import { typeChip } from './typechip.mjs';

/**
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {() => void} refresh
 * @param {{moveSlot?: number|null}} [state] which slot's description is open,
 *   carried across the rebuilds that reading and changing a move cause
 * @returns {HTMLElement}
 */
export function pokemonTab(app, session, refresh, state = {}) {
  const pokemon = session.active;
  // Whatever it has come to know since the last look — a level, a machine,
  // an evolution — is written down before the slots are drawn.
  noteLearnedMoves(pokemon, session.machines);
  const species = speciesOf(pokemon.speciesId);
  const stats = statsOf(pokemon);
  const level = levelOf(pokemon);
  const progress = experienceProgress(pokemon);
  const name = localized(species?.name, '');
  // The companion as it walks the road, in the one picture it has everywhere.
  const walker = walkerPortrait(pokemon, { maxHeight: PORTRAIT_MAX_HEIGHT, label: name });

  return el('div.tab-body.pokemon-tab', {}, [
    el('div.pokemon-left', {}, [
      walker,
      statHexagon({ base: baselineStats(pokemon, level), actual: stats, effort: pokemon.evs }),
      statTable(stats, { hp: pokemon.hp, nature: gameData().natures?.[pokemon.nature], evs: pokemon.evs }),
    ]),

    scrollable(
      el('div.pokemon-right', {}, [
        el('div.pokemon-heading', {}, [
          el('span.pokemon-nickname', { text: pokemon.nickname || localized(species?.name, '') }),
          genderMark(pokemon),
          shinyMark(pokemon),
          statusMark(pokemon.status, t(`status.${pokemon.status}.short`)),
          el('span.pokemon-level', { text: t('slot.level', { level }) }),
        ]),
        // A masked Ogerpon is the mask's type as well as Grass.
        el('div.pokemon-types', {}, standingTypes(pokemon).map((type) => typeChip(type))),

        el('div.pokemon-line', {}, [
          el('span.label', { text: t('pokemon.hp') }),
          el('span', { text: `${Math.max(0, Math.round(pokemon.hp))}/${maxHp(pokemon)}` }),
        ]),
        el('div.pokemon-line', {}, [
          el('span.label', { text: t('pokemon.exp') }),
          el('span', { text: progress.needed ? `${progress.into}/${progress.needed}` : '—' }),
        ]),
        // The nature, by name as the games' summary gives it; which stats it
        // moves is on the table beside it, in red and blue.
        el('div.pokemon-line', {}, [
          el('span.label', { text: t('pokemon.nature') }),
          el('span', { text: localized(gameData().natures?.[pokemon.nature]?.name, pokemon.nature ?? '—') }),
        ]),
        abilityLine(app, pokemon),
        heldLine(app, session, refresh),

        el('div.section-title', { text: t('pokemon.moves') }),
        el('div.move-grid', {}, [0, 1, 2, 3].map((slot) => moveSlot(app, session, slot, refresh, state))),
        // What the selected slot does. A move's name and its numbers say
        // nothing about what it is for — which of two Water moves puts the
        // other side to sleep — so the description is on the screen where the
        // choice is made rather than only in the bag.
        moveDetail(app, session, refresh, state),

        button(t('pokemon.autoBattle'), () => {
          app.audio.blip('select');
          app.push(autoBattleScene({ session, onClose: () => app.pop() }));
        }, { className: 'small' }),
      ]),
    ),
  ]);
}

/**
 * What the companion is carrying, and the way to take it back.
 *
 * The bag hands an item over; this is the other half of that, so a held item
 * is not something the player can only swap and never simply remove.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {() => void} refresh
 */
function heldLine(app, session, refresh) {
  const pokemon = session.active;
  const held = pokemon.heldItem;

  return el('div.pokemon-line', {}, [
    el('span.label', { text: t('pokemon.held') }),
    held
      ? el('button.chip', {
          type: 'button',
          text: localized(gameData().items[held]?.name, held),
              onClick: async () => {
            app.audio.blip('select');
            const item = itemOf(held);
            const off = await describe(app, {
              title: localized(item?.name, held),
              subtitle: item?.pocket ? t(`items.pocket.${item.pocket}`) : null,
              body: localized(item?.text, ''),
              // The description says what the item is for; whether it does
              // it here goes underneath, as the bag's inspect screen puts it.
              extra: item?.works ? null : el('span.meta', { text: t('items.noEffectYet') }),
              action: { label: t('items.takeBack'), danger: true },
            });
            if (!off) return;
            const result = unequipItem(session);
            app.audio.blip(result.ok ? 'confirm' : 'error');
            app.toast(result.message);
            if (result.used) refresh();
          },
        })
      : el('span', { text: '—' }),
  ]);
}

/**
 * The stats this species would have at this level with no investment at all.
 *
 * Plotting that under the Pokémon's real stats makes the hexagon show what the
 * companion's own training has added, rather than just the species' shape.
 * A forme with stats of its own is measured against those — a Speed Forme
 * Deoxys has not trained its Defense away.
 *
 * @param {import('../engine/pokemon.mjs').Pokemon} pokemon
 * @param {number} level
 * @returns {Record<string, number>}
 */
function baselineStats(pokemon, level) {
  const species = speciesOf(pokemon.speciesId);
  const base = (pokemon.forme && species?.forms?.find((form) => form.slug === pokemon.forme)?.stats) || species?.stats;
  /** @type {Record<string, number>} */
  const out = {};
  for (const stat of STATS) {
    out[stat] = computeStat(base?.[stat] ?? 1, 0, 0, level, 1, stat === 'hp');
  }
  return out;
}

/** The tallest the portrait may stand above the stat hexagon, in pixels. */
const PORTRAIT_MAX_HEIGHT = 70;

/**
 * The panel under the four slots: what the chosen move does, and the way to
 * swap it out.
 *
 * Clicking a slot used to go straight to the replacement list, which meant
 * there was nowhere in the game that said what a move the companion already
 * knows actually does. Reading is the click now, and changing it is the button
 * on what you have read.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {() => void} refresh
 * @param {{moveSlot?: number|null}} state
 */
function moveDetail(app, session, refresh, state) {
  const slot = state.moveSlot;
  if (slot === null || slot === undefined) return null;
  const entry = session.active.moves[slot];
  if (!entry || !moveOf(entry.move)) return null;

  const card = el('div.move-detail', {}, [
    moveCard(entry.move, { slot: entry }),
    button(t('pokemon.replaceMove'), () => openReplace(app, session, slot, refresh), { className: 'small' }),
  ]);

  // The slots sit low enough on a short window that the card opens below the
  // fold. `nearest` brings it up only when it is actually out of sight, so a
  // card already on screen does not make the page jump.
  requestAnimationFrame(() => {
    if (card.isConnected) card.scrollIntoView({ block: 'nearest' });
  });
  return card;
}

/**
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {number} slot
 * @param {() => void} refresh
 * @param {{moveSlot?: number|null}} state which slot's description is open
 */
function moveSlot(app, session, slot, refresh, state) {
  const pokemon = session.active;
  const entry = pokemon.moves[slot];
  const move = entry ? moveOf(entry.move) : null;

  // A red dot on the slots while it knows a move not yet looked at in the
  // list, which is where a slot's move is changed.
  const fresh = (pokemon.newMoves ?? []).length > 0 ? el('i.new-dot', { 'aria-hidden': 'true' }) : null;

  // An empty slot has nothing to describe, so it goes straight to the list.
  if (!move) {
    return el('button.move-slot.empty', {
      type: 'button',
      onClick: () => openReplace(app, session, slot, refresh),
    }, ['—', fresh]);
  }

  return el('button.move-slot', {
    type: 'button',
    'aria-pressed': String(state.moveSlot === slot),
    onClick: () => {
      app.audio.blip('select');
      state.moveSlot = state.moveSlot === slot ? null : slot;
      refresh();
    },
  }, [
    el('span.move-name', { text: localized(move.name, entry.move) }),
    el('span.move-meta', {}, [
      typeChip(move.type, true),
      el('span.move-pp', { text: `PP ${entry.pp}/${maxPp(entry)}` }),
    ]),
    moveClasses(move),
    fresh,
  ]);
}

/**
 * The ♂ or ♀ beside a name, for the species that have one.
 *
 * It is not decoration: infatuation needs one of each, and a Rivalry reads
 * both, so a player looking at why a move did nothing needs to be able to see
 * it.
 *
 * @param {import('../engine/pokemon.mjs').Pokemon} pokemon
 */
function genderMark(pokemon) {
  if (!pokemon.gender) return null;
  return el(`span.gender-mark.${pokemon.gender}`, { text: t(`pokemon.gender.${pokemon.gender}`) });
}

/**
 * How a move is classified, as a row of chips: contact, punch, sound, powder
 * and the rest.
 *
 * These are what half the abilities and a good number of the held items key
 * off — a Static only answers a move that touched it, a pair of Safety
 * Goggles only stops powder — so a player choosing between two moves of the
 * same type and power is often choosing between these.
 *
 * @param {any} move
 */
function moveClasses(move) {
  const flags = (move.flags ?? []).filter((flag) => MOVE_FLAG_SET.has(flag));
  if (flags.length === 0) return null;
  return el('span.move-flags', {}, flags.map((flag) => el('span.move-flag', { text: t(`moveFlag.${flag}`) })));
}

/**
 * The ability, as a name that can be asked about.
 *
 * An ability the engine has not been taught yet says so when asked, in the
 * same words the bag uses for an item it cannot act on — a player should not
 * have to fight a battle to find out that nothing was going to happen.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/pokemon.mjs').Pokemon} pokemon
 */
function abilityLine(app, pokemon) {
  // A masked Ogerpon has the mask's ability, and says so here too.
  const slug = abilityName(pokemon) ?? pokemon.ability;
  const ability = abilityOf(slug);
  const hidden = (speciesOf(pokemon.speciesId)?.abilities ?? []).some(
    (entry) => entry.name === slug && entry.hidden,
  );

  return el('div.pokemon-line', {}, [
    el('span.label', { text: t('pokemon.ability') }),
    // The name only. What it does is a paragraph, and a paragraph in a row on
    // a 270-pixel screen pushed the move slots off the bottom of the page.
    el('button.chip', {
      type: 'button',
      text: localized(ability?.name, slug),
      onClick: () => {
        app.audio.blip('select');
        void describe(app, {
          title: localized(ability?.name, slug),
          subtitle: hidden ? t('pokemon.hiddenAbility') : null,
          body: localized(ability?.text, ability?.effect ?? ''),
          // What it says is always shown; whether it does it here goes under.
          extra: abilityInert(slug)
            ? el('span.meta', { text: t('pokemon.abilityInert') })
            : abilityWorks(slug)
              ? null
              : el('span.meta', { text: t('items.noEffectYet') }),
        });
      },
    }),
  ]);
}

/**
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {number} slot
 * @param {() => void} refresh
 */
async function openReplace(app, session, slot, refresh) {
  const pokemon = session.active;
  const known = new Set(pokemon.moves.map((entry) => entry.move));
  const fresh = new Set(pokemon.newMoves ?? []);
  // The newest first, so what was just learned is at the top rather than
  // somewhere down a list of forty; the new ones carry the dot. The moves
  // already in a slot stay in the list, greyed out, so the player can see the
  // whole set while choosing — but a move cannot sit in two slots, so none of
  // them can be picked.
  const listed = movesByRecency(pokemon, session.machines);
  const moves = [...listed, ...[...known].filter((move) => !listed.includes(move))];
  const choices = moves.map((move) => ({
    value: move,
    label: localized(moveOf(move)?.name, move),
    detail: moveSummary(move, pokemon.moves.find((entry) => entry?.move === move) ?? null),
    fresh: fresh.has(move),
    disabled: known.has(move),
  }));

  // Opening the list is looking at them.
  pokemon.newMoves = [];
  const chosen = await chooseFromList(app, t('pokemon.replaceMove'), choices);
  if (chosen) setMove(pokemon, slot, chosen);
  refresh();
}
