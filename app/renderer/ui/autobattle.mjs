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
import { suggestPolicy } from '../engine/autoplan.mjs';
import { confirm, mountModal } from './dialog.mjs';
import { typeChip } from './typechip.mjs';

/**
 * When a move may be used, in groups, in the order the picker shows them.
 *
 * `never` is one of them rather than a separate switch: a move that is never
 * used and a move used only under some condition are the same decision. The
 * rank and health ones come in pairs — the companion's own, and the foe's.
 * Twenty-odd conditions in one list was a scroll through a keyhole, so the
 * picker shows one group at a time beside the names of the others.
 */
const CONDITION_GROUPS = [
  { key: 'basic', conditions: ['never', 'always'] },
  { key: 'turn', conditions: ['firstTurn', 'foeEntered', 'oncePerBattle', 'everyTwoTurns', 'everyThreeTurns', 'everyFourTurns'] },
  { key: 'matchup', conditions: ['superEffective', 'faster', 'slower', 'trainerBattle', 'wildBattle'] },
  { key: 'status', conditions: ['noStatus', 'foeStatus', 'selfStatus', 'noField', 'hasField'] },
  { key: 'rank', conditions: ['rankUp', 'rankDown', 'foeRankUp', 'foeRankDown'] },
  { key: 'hp', conditions: ['hpFull', 'hpAboveHalf', 'hpTwoThirds', 'hpHalf', 'hpThird', 'hpQuarter'] },
  { key: 'foeHp', conditions: ['foeHpFull', 'foeHpAboveHalf', 'foeHpTwoThirds', 'foeHpHalf', 'foeHpThird', 'foeHpQuarter'] },
];

/** Every condition, flat, in picker order. */
export const CONDITIONS = CONDITION_GROUPS.flatMap((group) => group.conditions);

/**
 * The group a condition belongs to, which also colours its chip.
 * @param {string} condition
 */
function groupOf(condition) {
  return CONDITION_GROUPS.find((group) => group.conditions.includes(condition)) ?? CONDITION_GROUPS[0];
}

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
            el('div.auto-tier-head', {}, [
              el('div.section-title', { text: t(state.moving === null ? 'auto.moves' : 'auto.moveTarget') }),
              el('span.spacer'),
              button(t('auto.optimize'), async () => {
                app.audio.blip('select');
                if (!(await confirm(app, t('auto.optimizeConfirm')))) return;
                optimize(session);
                state.moving = null;
                rebuild();
              }, { className: 'small', title: t('auto.optimizeHint') }),
            ]),
            el('div.auto-move-row.auto-move-head', {}, [
              el('span.auto-move-head-move'),
              el('span.auto-move-head-rank', { text: t('auto.first') }),
              el('span.auto-move-head-rank', { text: t('auto.second') }),
            ]),
            el('div.auto-moves', {}, session.active.moves.map((slot, index) => moveRow(app, session, state, index, rebuild))),
          ]),
          el('p.auto-order', { text: t('auto.order') }),
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
 * Set the companion's moves up as `suggestPolicy` would: each one's two
 * conditions, and their order. Other Pokémon's moves keep what they had.
 *
 * @param {import('../engine/session.mjs').Session} session
 */
function optimize(session) {
  const pokemon = session.active;
  const plan = suggestPolicy(pokemon);
  const policy = session.autoBattle;
  policy.moves = { ...(policy.moves ?? {}), ...plan.moves };
  policy.second = { ...(policy.second ?? {}), ...plan.second };
  const bySlug = new Map(pokemon.moves.map((slot) => [slot.move, slot]));
  const ordered = plan.order.map((slug) => bySlug.get(slug)).filter(Boolean);
  // Anything the plan did not name (a move the data does not know) stays at the end.
  const rest = pokemon.moves.filter((slot) => !plan.order.includes(slot.move));
  // In place, as the swap on this screen does, for anything holding the list.
  pokemon.moves.splice(0, pokemon.moves.length, ...ordered, ...rest);
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
   * One of the move's two conditions, and the picker it is chosen in.
   * @param {Record<string, string>} stored
   * @param {string} condition
   * @param {string} label
   */
  const conditionChip = (stored, condition, label) =>
    el(`button.chip.auto-condition${condition === 'never' ? '.off' : ''}`, {
      type: 'button',
      title: `${label} ${t('auto.condition')}: ${t(`auto.condition.${condition}`)}`,
      onClick: async () => {
        app.audio.blip('select');
        const chosen = await chooseCondition(app, `${localized(move?.name, slug)} · ${label}`, condition);
        if (chosen === null) return;
        stored[slug] = chosen;
        rebuild();
      },
    }, [
      el(`i.cond-dot.cond-${groupOf(condition).key}`, { 'aria-hidden': 'true' }),
      el('span.auto-condition-label', { text: t(`auto.condition.${condition}`) }),
    ]);

  return el('div.auto-move-row', {}, [
    handle,
    conditionChip(policy.moves, moveCondition(policy, slug), t('auto.first')),
    conditionChip(policy.second, secondCondition(policy, slug), t('auto.second')),
  ]);
}

/**
 * Choose a condition: the groups down the left, the one open on the right,
 * and what the one under the pointer means along the bottom. A press on a
 * condition takes it.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {string} title
 * @param {string} current
 * @returns {Promise<string|null>} null when cancelled
 */
export function chooseCondition(app, title, current) {
  return new Promise((resolve) => {
    mountModal(app, (dismiss) => {
      const finish = (/** @type {string|null} */ value) => {
        dismiss();
        resolve(value);
      };
      let open = groupOf(current);

      const help = el('p.cond-help');
      /** @param {string} condition */
      const explain = (condition) => {
        help.replaceChildren(
          el('b', { text: t(`auto.condition.${condition}`) }),
          ' ',
          t(`auto.help.${condition}`),
        );
      };

      const tabs = el('div.cond-groups');
      const options = el('div.cond-options');
      const draw = () => {
        setChildren(tabs, CONDITION_GROUPS.map((group) =>
          el(`button.cond-group${group === open ? '.open' : ''}`, {
            type: 'button',
            onClick: () => {
              if (group === open) return;
              app.audio.blip('select');
              open = group;
              draw();
            },
          }, [
            el(`i.cond-dot.cond-${group.key}`, { 'aria-hidden': 'true' }),
            el('span', { text: t(`auto.group.${group.key}`) }),
            group.conditions.includes(current) ? el('i.cond-here', { 'aria-hidden': 'true' }) : null,
          ])));
        setChildren(options, open.conditions.map((condition) =>
          el(`button.cond-option${condition === current ? '.current' : ''}`, {
            type: 'button',
            onMouseEnter: () => explain(condition),
            onFocus: () => explain(condition),
            onClick: () => {
              app.audio.blip('confirm');
              finish(condition);
            },
          }, [
            el('span', { text: t(`auto.condition.${condition}`) }),
            condition === current ? el('span.cond-current', { text: t('auto.current') }) : null,
          ])));
        explain(open.conditions.includes(current) ? current : open.conditions[0]);
      };
      draw();

      return el('div.panel.cond-picker', {}, [
        el('p.cond-title', { text: title }),
        el('div.cond-body', {}, [tabs, options]),
        help,
        el('div.cond-actions', {}, [
          el('span.spacer'),
          button(t('common.cancel'), () => {
            app.audio.blip('cancel');
            finish(null);
          }, { className: 'small' }),
        ]),
      ]);
    });
  });
}
