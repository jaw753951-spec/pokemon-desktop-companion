/**
 * Auto-battle settings.
 *
 * Each move the companion has is used under two conditions of its own, a
 * first and a second. One that names a moment is used the moment it holds,
 * before anything else: every move's first ahead of any move's second, and
 * within each, the first in the order the moves sit in their slots. When no
 * moment has come, the moves allowed always are left, and the hardest hit
 * among them is used. So the screen is the moves in their order, each with its
 * two conditions beside it, where a press on a move picks it up and a press
 * on another puts it there.
 *
 * Everything here edits the policy the battle engine reads, and the moves'
 * own order, so the effect of a change is immediate.
 */
import { moveOf } from '../core/data.mjs';
import { button, el, scrollable, setChildren } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { moveCondition, secondCondition } from '../engine/battle.mjs';
import { chooseFromList } from './dialog.mjs';
import { typeChip } from './typechip.mjs';

/**
 * When a move may be used, in the order the picker lists them.
 *
 * `never` is one of them rather than a separate switch: a move that is never
 * used and a move used only under some condition are the same decision. The
 * rank and health ones come in pairs — the companion's own, and the foe's.
 */
const CONDITIONS = [
  'never',
  'always',
  'firstTurn',
  'everyTwoTurns',
  'everyThreeTurns',
  'everyFourTurns',
  'noStatus',
  'foeStatus',
  'noField',
  'rankUp',
  'rankDown',
  'foeRankUp',
  'foeRankDown',
  'hpTwoThirds',
  'hpHalf',
  'hpThird',
  'hpQuarter',
  'foeHpTwoThirds',
  'foeHpHalf',
  'foeHpThird',
  'foeHpQuarter',
];

/**
 * @param {{session: import('../engine/session.mjs').Session, onClose: () => void}} options
 * @returns {import('../core/app.mjs').Scene}
 */
export function autoBattleScene({ session, onClose }) {
  /** The slot picked up to be moved, if one is. */
  const state = { moving: /** @type {number|null} */ (null) };

  return {
    keepBelow: true,

    mount(app) {
      const body = scrollable(el('div.auto-body'));

      const rebuild = () => {
        setChildren(body, [
          el('div.auto-tier', {}, [
            el('div.section-title', { text: t(state.moving === null ? 'auto.moves' : 'auto.moveTarget') }),
            el('div.auto-move-row.auto-move-head', {}, [
              el('span.auto-move-head-move'),
              el('span.auto-move-head-rank', { text: t('auto.first') }),
              el('span.auto-move-head-rank', { text: t('auto.second') }),
            ]),
            el('div.auto-moves', {}, session.active.moves.map((slot, index) => moveRow(app, session, state, index, rebuild))),
          ]),
        ]);
      };
      rebuild();

      return el('div.screen', { style: { background: 'rgba(16, 21, 32, 0.92)' } }, [
        el('div.screen-header', {}, [
          el('span', { text: t('auto.title') }),
          el('span.spacer'),
          button(t('common.close'), () => {
            app.audio.blip('cancel');
            onClose();
          }, { className: 'small' }),
        ]),
        el('div.screen-body', {}, [body]),
      ]);
    },
  };
}

/**
 * One of the companion's moves, in its place in the order, with its two
 * conditions beside it.
 *
 * The move itself is the handle for the order: pressed, it is picked up, and
 * pressed again on another move, the two change places — the box's way of
 * moving a Pokémon. Pressing the one picked up puts it back down. The chips
 * are its first and second conditions, `never` included.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {{moving: number|null}} state
 * @param {number} index
 * @param {() => void} rebuild
 */
function moveRow(app, session, state, index, rebuild) {
  const policy = session.autoBattle;
  policy.moves = policy.moves ?? {};
  policy.second = policy.second ?? {};
  const slug = session.active.moves[index].move;
  const move = moveOf(slug);

  const picked = state.moving === index;
  const handle = el(`button.auto-move${picked ? '.moving' : ''}${state.moving !== null && !picked ? '.target' : ''}`, {
    type: 'button',
    title: t('auto.reorder'),
    onClick: () => {
      if (state.moving === null) {
        app.audio.blip('select');
        state.moving = index;
      } else {
        const from = state.moving;
        state.moving = null;
        if (from !== index) {
          const moves = session.active.moves;
          [moves[from], moves[index]] = [moves[index], moves[from]];
          app.audio.blip('confirm');
        } else {
          app.audio.blip('cancel');
        }
      }
      rebuild();
    },
  }, [
    el('span.auto-move-order', { text: String(index + 1) }),
    el('span.auto-move-name', { text: localized(move?.name, slug) }),
    move?.type ? typeChip(move.type, true) : null,
  ]);

  /**
   * One of the move's two conditions, and the list it is picked from.
   * @param {Record<string, string>} stored
   * @param {string} condition
   * @param {string} label
   */
  const conditionChip = (stored, condition, label) =>
    el(`button.chip${condition === 'never' ? '.off' : ''}`, {
      type: 'button',
      text: t(`auto.condition.${condition}`),
      title: `${label} ${t('auto.condition')}`,
      onClick: async () => {
        app.audio.blip('select');
        const chosen = await chooseFromList(
          app,
          `${localized(move?.name, slug)} · ${label}`,
          CONDITIONS.map((value) => ({
            value,
            label: t(`auto.condition.${value}`),
            detail: value === condition ? t('auto.current') : '',
          })),
        );
        if (chosen === null) return;
        stored[slug] = chosen;
        rebuild();
      },
    });

  return el('div.auto-move-row', {}, [
    handle,
    conditionChip(policy.moves, moveCondition(policy, slug), t('auto.first')),
    conditionChip(policy.second, secondCondition(policy, slug), t('auto.second')),
  ]);
}
