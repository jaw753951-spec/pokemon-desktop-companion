/**
 * What a move is, in the words the screens share.
 *
 * The bag's machine pocket and the Pokémon tab were each describing a move in
 * their own way — one printed a bare name, the other a type and a power with
 * no explanation — so a player comparing a TM against the move already in a
 * slot was reading two different things. Both now ask here.
 */
import { gameData, moveOf } from '../core/data.mjs';
import { el } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { maxPp } from '../engine/pokemon.mjs';
import { typeChip } from './typechip.mjs';

/**
 * A move's numbers on one line: its type, whether it is physical, special or a
 * status move, and what it costs to throw.
 *
 * A status move has no power and some moves never miss; both are written as a
 * dash rather than left out, so the line has the same shape every time. A
 * move a Pokémon knows costs what its slot holds, which a PP Up raises.
 *
 * @param {string} slug
 * @param {{move: string, pp: number, ppUp?: number}|null} [slot] the slot it sits in, when known
 * @returns {string}
 */
export function moveSummary(slug, slot = null) {
  const move = moveOf(slug);
  if (!move) return '';
  const type = localized(gameData().types[move.type]?.name, move.type ?? '');
  const kind = t(`move.class.${move.damageClass ?? 'status'}`);
  return [
    type,
    kind,
    `${t('move.power')} ${move.power ?? '—'}`,
    `${t('move.accuracy')} ${move.accuracy ?? '—'}`,
    `PP ${slot ? maxPp(slot) : move.pp ?? '—'}`,
  ].join('  ·  ');
}

/**
 * The same thing as a block: the name, a type chip, the numbers and the move's
 * own description.
 *
 * @param {string} slug
 * @param {{heading?: string|null, slot?: {move: string, pp: number, ppUp?: number}|null}} [options]
 *   a caption over the card, and the slot the move sits in, when known
 * @returns {HTMLElement}
 */
export function moveCard(slug, options = {}) {
  const move = moveOf(slug);
  if (!move) return el('div.move-card', {}, [el('span.meta', { text: t('move.unknown') })]);

  return el('div.move-card', {}, [
    options.heading ? el('span.meta', { text: options.heading }) : null,
    el('div.move-card-head', {}, [
      el('span.move-card-name', { text: localized(move.name, slug) }),
      typeChip(move.type, true),
    ]),
    el('span.meta', { text: moveSummary(slug, options.slot ?? null) }),
    el('p.move-card-text', { text: localized(move.text, '') || t('move.noText') }),
  ]);
}
