/**
 * The Items tab: one sub-tab per pocket, the bag on the left and whatever is
 * being inspected on the right, at roughly three to two.
 *
 * The key pocket holds what is kept for good rather than carried: the charms,
 * and the badges the travelling Pokémon has won — each gym's, and the
 * champion's crown — which change with whichever Pokémon is travelling.
 *
 * A last tab holds what the bag does by itself — which berry to hand over
 * after a battle, and when to throw a potion during one.
 */
import { url } from '../core/bridge.mjs';
import { gameData, itemOf, moveOf, speciesOf } from '../core/data.mjs';
import { button, el, scrollable, setChildren } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { AFTER_BATTLE_TARGETS, equipItem, formeMoveNeed, itemActions, itemNeedsChoice, recommendedBerries, useItem } from '../engine/items.mjs';
import { pocketOrder } from '../engine/bagorder.mjs';
import { maxPp } from '../engine/pokemon.mjs';
import { STATS } from '../engine/stats.mjs';
import { badgeIcon, championIcon } from './badges.mjs';
import { moveSummary } from './movecard.mjs';
import { chooseAction, chooseFromList, chooseItem, confirm } from './dialog.mjs';

/** Pockets in the order the games show them, and the settings behind them. */
const POCKETS = ['medicine', 'misc', 'berries', 'pokeballs', 'machines', 'key'];
const OPTIONS = 'options';

/** When a potion is thrown without being asked for. */
const HEALING_CONDITIONS = ['never', 'hpTwoThirds', 'hpHalf', 'hpThird', 'hpQuarter'];

/**
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {() => void} refresh
 * @param {{pocket?: string, selected?: string|null, learnableOnly?: boolean}} state carried between re-renders
 * @returns {HTMLElement}
 */
export function itemsTab(app, session, refresh, state) {
  const pocket = state.pocket && [...POCKETS, OPTIONS].includes(state.pocket) ? state.pocket : POCKETS[0];

  const tabs = el('div.pocket-tabs', {}, [...POCKETS, OPTIONS].map((name) =>
    el('button.chip', {
      type: 'button',
      text: name === OPTIONS ? t('items.options') : t(`items.pocket.${name}`),
      'aria-pressed': String(name === pocket),
      onClick: () => {
        app.audio.blip('select');
        state.pocket = name;
        refresh();
      },
    }),
  ));

  if (pocket === OPTIONS) {
    return el('div.tab-body.items-tab', {}, [tabs, optionsPane(app, session, refresh)]);
  }

  // A machine the companion cannot learn is one it cannot use, and a case of
  // fifty TMs is a long way to scroll to find the six that fit. The machine
  // pocket can be narrowed to those, and greys the rest out when it is not.
  const machines = pocket === 'machines';
  const learnable = new Set(machines ? speciesOf(session.active?.speciesId)?.learnset?.machine ?? [] : []);
  const fits = (/** @type {string} */ slug) => learnable.has(itemOf(slug)?.move ?? '');
  const onlyLearnable = machines && Boolean(state.learnableOnly);
  // With the filter on, a machine for a move the companion already has in a
  // slot is as good as none: it is hidden along with the ones it cannot learn.
  const knownMoves = new Set((session.active?.moves ?? []).map((entry) => entry.move));
  const worthShowing = (/** @type {string} */ slug) => fits(slug) && !knownMoves.has(itemOf(slug)?.move ?? '');

  const entries = session.pocket(pocket).filter((entry) => !onlyLearnable || worthShowing(entry.slug));
  const badges = pocket === 'key' ? badgeEntries(session) : [];
  // What was being read survives a refresh — using one of three Potions
  // leaves the other two on the panel — but not the last of it going.
  const shown = [...entries.map((entry) => entry.slug), ...badges.map((badge) => badge.id)];
  if (state.selected && !shown.includes(state.selected)) state.selected = null;

  const inspector = el('div.item-inspector');
  const select = (slug) => {
    state.selected = slug;
    for (const row of list.querySelectorAll('.item-row')) {
      row.setAttribute('aria-pressed', String(/** @type {HTMLElement} */ (row).dataset.slug === slug));
    }
    showInspector(app, session, inspector, slug, refresh);
  };

  const list = scrollable(el('div.item-list'));

  if (entries.length === 0 && badges.length === 0) {
    list.append(el('div.empty', { text: onlyLearnable ? t('items.noLearnable') : t('items.empty') }));
  } else {
    list.append(
      ...entries
        .sort(pocketOrder(pocket))
        .map(({ slug, count, item }) =>
          el(machines && !fits(slug) ? 'button.item-row.unlearnable' : 'button.item-row', {
            type: 'button',
            dataset: { slug },
            'aria-pressed': String(slug === state.selected),
            // Reading an item is the click: what it does, and what can be
            // done with it, are on the panel beside the list rather than in
            // a menu over it.
            onClick: () => {
              app.audio.blip('select');
              select(slug);
            },
          }, [
            el('img', { src: url('assets', `items/${slug}.png`), alt: '' }),
            el('span.item-name', { text: localized(item.name, slug) }),
            el('span.item-count', { text: t('items.count', { count }) }),
          ]),
        ),
    );
    if (badges.length) {
      list.append(el('div.pocket-heading', { text: t('items.badgesOf', { name: pokemonName(session.active) }) }));
    }
    list.append(
      ...badges.map((badge) =>
        el('button.item-row.badge-row', {
          type: 'button',
          dataset: { slug: badge.id },
          'aria-pressed': String(badge.id === state.selected),
          onClick: () => {
            app.audio.blip('select');
            select(badge.id);
          },
        }, [
          badge.type ? badgeIcon(badge.type) : championIcon(),
          el('span.item-name', { text: badgeName(badge) }),
        ]),
      ),
    );
  }
  showInspector(app, session, inspector, state.selected ?? null, refresh);

  const filter = machines
    ? el('div.pocket-filter', {}, [
        el('button.chip', {
          type: 'button',
          text: t('items.learnableOnly'),
          'aria-pressed': String(onlyLearnable),
          onClick: () => {
            app.audio.blip('select');
            state.learnableOnly = !onlyLearnable;
            refresh();
          },
        }),
      ])
    : null;

  return el('div.tab-body.items-tab', {}, [tabs, filter, el('div.items-split', {}, [list, inspector])]);
}

/**
 * What the bag does without being opened.
 *
 * Both settings are about the same thing — a fight the player is not watching
 * — so they sit together rather than one in the berry pocket and one in the
 * medicine pocket.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {() => void} refresh
 */
function optionsPane(app, session, refresh) {
  const policy = session.itemPolicy;

  // A scroller the bag knows about, so a press on any setting further down
  // leaves the pane where it was rather than back at the top: every press
  // rebuilds the tab, and only a `.scroll` keeps its place across that.
  return scrollable(el('div.item-options', {}, [
    el('div.item-options-heading', {}, [
      el('div.section-title', { text: t('items.berryRestock') }),
      el('span.spacer'),
      // Healing first, then a resist for its weakness, then a pinch berry —
      // picked for the companion walking now.
      button(t('items.berryRecommend'), () => {
        app.audio.blip('confirm');
        policy.berries = recommendedBerries(session, session.active);
        refresh();
      }, { className: 'small', title: t('items.berryRecommendNote') }),
    ]),
    el('p.meta', { text: t('items.berryRestockNote') }),
    ...[0, 1, 2].map((index) => berryRow(app, session, policy, index, refresh)),
    autoBerryRow(app, policy, refresh),
    el('p.meta', { text: t('items.berryAutoNote') }),

    el('div.section-title', { text: t('items.healingUse') }),
    el('p.meta', { text: t('items.healingUseNote') }),
    healingItemRow(app, session, policy, refresh),
    healingConditionRow(app, policy, refresh),

    el('div.section-title', { text: t('items.afterBattle') }),
    el('p.meta', { text: t('items.afterBattleNote') }),
    afterBattleRow(app, policy, refresh),
  ]));
}

/**
 * How far a win tops the companion back up, fullest last — and, under the
 * health it aims for, whether its condition and its low PP are seen to as
 * well, each a switch of its own.
 */
function afterBattleRow(app, policy, refresh) {
  const target = policy.afterBattle;

  /**
   * @param {'afterBattleStatus'|'afterBattlePp'} key
   * @param {string} label
   */
  const toggle = (key, label, title = '') => {
    const on = Boolean(policy[key]);
    return el(`button.chip${on ? '' : '.off'}`, {
      type: 'button',
      text: label,
      title: title || undefined,
      'aria-pressed': String(on),
      onClick: () => {
        app.audio.blip('select');
        policy[key] = !on;
        refresh();
      },
    });
  };

  return el('div.setting.item-option.after-battle-option', {}, [
    el('span.label', { text: t('items.afterBattleTarget') }),
    el('span.spacer'),
    el('div.after-battle-choices', {}, [
      el(`button.chip${target === 'never' ? '.off' : ''}`, {
        type: 'button',
        text: t(`items.afterBattle.${target}`),
        onClick: async () => {
          app.audio.blip('select');
          const chosen = await chooseFromList(app, t('items.afterBattleTarget'),
            Object.keys(AFTER_BATTLE_TARGETS).map((value) => ({
              value,
              label: t(`items.afterBattle.${value}`),
              detail: value === target ? t('auto.current') : '',
            })));
          if (chosen === null) return;
          policy.afterBattle = chosen;
          refresh();
        },
      }),
      el('div.after-battle-extras', {}, [
        toggle('afterBattleStatus', t('items.afterBattleStatus')),
        toggle('afterBattlePp', t('items.afterBattlePp'), t('items.afterBattlePpNote')),
      ]),
    ]),
  ]);
}

/**
 * Every berry in the bag, whichever pocket the data files it in — the restock
 * order once left out a berry the data had put among the medicine — in the
 * order of their names.
 *
 * @param {import('../engine/session.mjs').Session} session
 */
function heldBerries(session) {
  const pockets = new Map([...session.pocket('berries'), ...session.pocket('medicine')].map((entry) => [entry.slug, entry]));
  return [...pockets.values()]
    .filter((entry) => entry.item.pocket === 'berries' || entry.slug.endsWith('-berry'))
    .sort((a, b) => localized(a.item.name, a.slug).localeCompare(localized(b.item.name, b.slug)));
}

/**
 * One rank of the restock order. Only berries the bag holds are offered, plus
 * the empty choice — a rank left unset is simply skipped.
 */
function berryRow(app, session, policy, index, refresh) {
  const slug = policy.berries[index] ?? null;
  const item = slug ? itemOf(slug) : null;

  return el('div.setting.item-option', {}, [
    el('span.label', { text: t('items.priority', { rank: index + 1 }) }),
    el('span.spacer'),
    el(`button.chip${slug ? '' : '.off'}`, {
      type: 'button',
      text: item ? localized(item.name, slug) : t('items.unset'),
      onClick: async () => {
        app.audio.blip('select');
        const chosen = await chooseItem(app, t('items.priority', { rank: index + 1 }),
          heldBerries(session).map((entry) => ({
            value: entry.slug,
            label: localized(entry.item.name, entry.slug),
            icon: url('assets', `items/${entry.slug}.png`),
            count: entry.count,
            text: localized(entry.item.text, ''),
          })),
          {
            current: slug,
            clearLabel: t('items.unset'),
            confirmLabel: t('items.berryPick'),
            empty: t('items.noBerries'),
          });
        if (chosen === null) return;
        policy.berries[index] = chosen || null;
        refresh();
      },
    }),
  ]);
}

/**
 * Whether an empty hand the three ranks cannot fill is given the best berry in
 * the bag instead. See `bestBerry` for how it picks.
 */
function autoBerryRow(app, policy, refresh) {
  const on = Boolean(policy.autoBerry);

  return el('div.setting.item-option', {}, [
    el('span.label', { text: t('items.berryAuto') }),
    el('span.spacer'),
    el(`button.chip${on ? '' : '.off'}`, {
      type: 'button',
      text: on ? t('items.berryAuto.on') : t('items.berryAuto.off'),
      'aria-pressed': String(on),
      onClick: () => {
        app.audio.blip('select');
        policy.autoBerry = !on;
        refresh();
      },
    }),
  ]);
}

/** Which potion the automatic throw reaches for, or whatever fits. */
function healingItemRow(app, session, policy, refresh) {
  const slug = policy.healing.item;
  const item = slug ? itemOf(slug) : null;

  return el('div.setting.item-option', {}, [
    el('span.label', { text: t('items.healingItem') }),
    el('span.spacer'),
    el('button.chip', {
      type: 'button',
      text: item ? localized(item.name, slug) : t('items.healingAuto'),
      onClick: async () => {
        app.audio.blip('select');
        const held = session.pocket('medicine').filter((entry) => entry.item.category !== 'status-cures');
        const chosen = await chooseFromList(app, t('items.healingItem'), [
          { value: '', label: t('items.healingAuto'), detail: t('items.healingAutoNote') },
          ...held.map((entry) => ({
            value: entry.slug,
            label: localized(entry.item.name, entry.slug),
            detail: t('items.count', { count: entry.count }),
          })),
        ]);
        if (chosen === null) return;
        policy.healing.item = chosen || null;
        refresh();
      },
    }),
  ]);
}

/** The health it is thrown at, in the same words the auto-battle screen uses. */
function healingConditionRow(app, policy, refresh) {
  const condition = policy.healing.condition;

  return el('div.setting.item-option', {}, [
    el('span.label', { text: t('auto.condition') }),
    el('span.spacer'),
    el(`button.chip${condition === 'never' ? '.off' : ''}`, {
      type: 'button',
      text: t(`auto.condition.${condition}`),
      onClick: async () => {
        app.audio.blip('select');
        const chosen = await chooseFromList(app, t('auto.condition'),
          HEALING_CONDITIONS.map((value) => ({
            value,
            label: t(`auto.condition.${value}`),
            detail: value === condition ? t('auto.current') : '',
          })));
        if (chosen === null) return;
        policy.healing.condition = chosen;
        refresh();
      },
    }),
  ]);
}

/**
 * What an item is, and what can be done with it: the description, and along
 * the bottom the buttons for whatever this item is offered for.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {HTMLElement} inspector
 * @param {string|null} slug
 * @param {() => void} refresh
 */
function showInspector(app, session, inspector, slug, refresh) {
  if (!slug) {
    inspector.replaceChildren(el('span.meta.inspect-hint', { text: t('items.inspectHint') }));
    return;
  }
  const badge = badgeEntries(session).find((entry) => entry.id === slug);
  if (badge) {
    showBadge(inspector, badge);
    return;
  }
  const item = itemOf(slug);
  if (!item) return;

  const machineMove = item.pocket === 'machines' ? item.move : null;
  const move = machineMove ? moveOf(machineMove) : null;

  setChildren(inspector, [
    el('img.inspect-icon', { src: url('assets', `items/${slug}.png`), alt: '' }),
    el('span.inspect-name', { text: localized(item.name, slug) }),
    // A machine's own flavour text is a sentence about machines — the same one
    // on every TM in some generations, a description of the move in others.
    // What the player is choosing between is the move, so a machine shows the
    // move: its name, what it does, and its numbers, the same way every time.
    machineMove
      ? el('div.inspect-machine', {}, [
          el('span.inspect-move-name', {
            text: localized(move?.name, machineMove),
          }),
          el('span.meta', { text: moveSummary(machineMove) }),
          el('p.inspect-text', { text: localized(move?.text, '') }),
        ])
      : el('p.inspect-text', { text: localized(item.text, '') }),
    // The bag carries everything this game could one day act on, which is more
    // than it acts on today; an item says so itself rather than leaving the
    // player to find out by using it.
    item.works ? null : el('span.meta.inspect-inert', { text: t('items.noEffectYet') }),
    itemButtons(app, session, slug, refresh),
  ]);
}

/**
 * The buttons under an item's description.
 *
 * What the item is for decides what it is offered for: a potion is used, a
 * Leftovers is handed over to carry, and a ball is neither — it is thrown at
 * something the companion has knocked down, from the capture screen. Tossing
 * is always there, quieter than the rest, and asks first.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {string} slug
 * @param {() => void} refresh
 */
function itemButtons(app, session, slug, refresh) {
  const item = itemOf(slug);
  const actions = itemActions(session, slug);

  /** @param {'use'|'equip'} kind */
  const act = async (kind) => {
    // An Ether, a PP Up or a Bottle Cap works on one thing, and the player
    // says which.
    /** @type {import('../engine/items.mjs').ItemChoice} */
    let choice = {};
    const needs = kind === 'use' ? itemNeedsChoice(slug) : null;
    if (needs === 'move') {
      const pokemon = session.active;
      const picked = await chooseAction(app, t('items.chooseMove'), pokemon.moves.map((entry, index) => ({
        label: `${localized(moveOf(entry.move)?.name, entry.move)} ${entry.pp}/${maxPp(entry)}`,
        value: String(index),
      })));
      if (picked === null) return;
      choice = { move: Number(picked) };
    } else if (needs === 'stat') {
      const pokemon = session.active;
      const picked = await chooseAction(app, t('items.chooseStat'), STATS.map((stat) => ({
        label: `${t(`stat.${stat}`)} ${pokemon.ivs[stat] ?? 0}`,
        value: stat,
      })));
      if (picked === null) return;
      choice = { stat: picked };
    }
    // A new shape whose move has no room: the player picks what it goes over,
    // or — where the games allow it — lets the move go. Backing out of the
    // question is backing out of using the item.
    const forme = kind === 'use' ? formeMoveNeed(session, slug) : null;
    if (forme) {
      const pokemon = session.active;
      const moveName = (move) => localized(moveOf(move)?.name, move);
      const picked = await chooseAction(
        app,
        t('items.formeForgetWhich', {
          name: pokemon.nickname || localized(speciesOf(pokemon.speciesId)?.name, ''),
          move: moveName(forme.move),
        }),
        [
          ...forme.moves.map((move, index) => ({ label: moveName(move), value: String(index) })),
          ...(forme.required ? [] : [{ label: t('items.formeGiveUp'), value: 'none', danger: true }]),
        ],
      );
      if (picked === null) return;
      if (picked !== 'none') choice = { forget: Number(picked) };
    }
    const result = kind === 'equip' ? equipItem(session, slug) : useItem(session, slug, choice);
    app.toast(result.message ?? t('items.cannotUse'));
    // A refusal is worth a sound too: a TM the companion cannot learn says so
    // and nothing else happens, which used to be silent.
    app.audio.blip(result.ok ? 'confirm' : 'error');
    if (result.used) refresh();
  };

  return el('div.inspect-actions', {}, [
    actions.use ? button(t('items.use'), () => act('use'), { className: 'small' }) : null,
    actions.equip ? button(t('items.equip'), () => act('equip'), { className: 'small' }) : null,
    el('span.spacer'),
    // A key item is not something the games let a trainer throw away.
    item?.pocket === 'key' ? null : button(t('items.toss'), async () => {
      app.audio.blip('select');
      if (!(await confirm(app, t('items.tossConfirm'), { danger: true }))) return;
      session.removeItem(slug);
      app.toast(t('items.tossed', { name: localized(item?.name, slug) }));
      refresh();
    }, { className: 'small ghost' }),
  ]);
}

/**
 * The badges the travelling Pokémon holds, as the key pocket lists them: each
 * gym's in the order it was won, then the champion's crown.
 *
 * @param {import('../engine/session.mjs').Session} session
 * @returns {Array<{id: string, type: string|null}>}
 */
export function badgeEntries(session) {
  const pokemon = session.active;
  if (!pokemon) return [];
  return [
    ...(pokemon.badges ?? []).map((type) => ({ id: `badge:${type}`, type })),
    ...(pokemon.champion ? [{ id: 'badge:champion', type: null }] : []),
  ];
}

/** @param {{type: string|null}} badge */
function badgeName(badge) {
  if (!badge.type) return t('slot.champion');
  return `${localized(gameData().types[badge.type]?.name, badge.type)} ${t('badge.word')}`;
}

/** @param {import('../engine/pokemon.mjs').Pokemon} pokemon */
function pokemonName(pokemon) {
  return pokemon.nickname || localized(speciesOf(pokemon.speciesId)?.name, '');
}

/**
 * One badge on the panel, large, with what it was won for.
 *
 * @param {HTMLElement} inspector
 * @param {{type: string|null}} badge
 */
function showBadge(inspector, badge) {
  setChildren(inspector, [
    el('div.inspect-badge', {}, [badge.type ? badgeIcon(badge.type) : championIcon()]),
    el('span.inspect-name', { text: badgeName(badge) }),
    el('p.inspect-text', {
      text: badge.type
        ? t('items.badgeText', { type: localized(gameData().types[badge.type]?.name, badge.type) })
        : t('items.championText'),
    }),
  ]);
}
