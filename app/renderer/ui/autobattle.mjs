/**
 * Auto-battle settings.
 *
 * Two things decide what the companion does on its turn. Each move it has is
 * used under a condition of its own, and one whose condition names a moment
 * is used the moment it holds, before anything else — the first such in the
 * order the moves sit in their slots. The mode then decides among what is
 * left, over the same slots. So the screen keeps the mode on top, picked at a
 * glance, and the moves below it in their order, each with its condition,
 * where a press on a move picks it up and a press on another puts it there.
 *
 * Everything here edits the policy the battle engine reads, and the moves'
 * own order, so the effect of a change is immediate.
 */
import { moveOf } from '../core/data.mjs';
import { button, el, scrollable, setChildren } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { moveCondition } from '../engine/battle.mjs';
import { chooseFromList } from './dialog.mjs';
import { typeChip } from './typechip.mjs';

/** Exactly one of these is active, as the brief requires. */
const MODES = ['repeatAll', 'repeatLast', 'damageFirst'];

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
          el('div.auto-tier.auto-tier-1', {}, [modeRow(app, session, rebuild)]),
          el('div.auto-tier.auto-tier-3', {}, [
            el('div.section-title', { text: t(state.moving === null ? 'auto.moves' : 'auto.moveTarget') }),
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
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {() => void} rebuild
 */
function modeRow(app, session, rebuild) {
  const policy = session.autoBattle;
  return el('div.auto-modes', {}, MODES.map((mode) =>
      el('button.chip', {
        type: 'button',
        text: t(`auto.${mode}`),
        'aria-pressed': String(policy.mode === mode),
        onClick: () => {
          app.audio.blip('select');
          // Only one may be active, so selecting replaces rather than toggles.
          policy.mode = mode;
          rebuild();
        },
      }),
    ));
}

/**
 * One of the companion's moves, in its place in the order, with its
 * condition beside it.
 *
 * The move itself is the handle for the order: pressed, it is picked up, and
 * pressed again on another move, the two change places — the box's way of
 * moving a Pokémon. Pressing the one picked up puts it back down. The chip is
 * its condition, `never` included.
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
  const slug = session.active.moves[index].move;
  const move = moveOf(slug);
  const condition = moveCondition(policy, slug);

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

  return el('div.auto-move-row', {}, [
    handle,
    el(`button.chip${condition === 'never' ? '.off' : ''}`, {
      type: 'button',
      text: t(`auto.condition.${condition}`),
      title: t('auto.condition'),
      onClick: async () => {
        app.audio.blip('select');
        const chosen = await chooseFromList(
          app,
          localized(move?.name, slug),
          CONDITIONS.map((value) => ({
            value,
            label: t(`auto.condition.${value}`),
            detail: value === condition ? t('auto.current') : '',
          })),
        );
        if (chosen === null) return;
        policy.moves[slug] = chosen;
        rebuild();
      },
    }),
  ]);
}
