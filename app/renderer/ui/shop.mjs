/**
 * The shop: open from the road at any time, a Poké Mart without the walk to
 * one.
 *
 * It is laid out as the bag's item tabs are — the pockets along the top, the
 * stock on the left and what is being looked at on the right — so the shop
 * reads as the other side of the bag rather than a screen of its own to
 * learn. What is being bought comes with its price, how many the bag already
 * has, and a count to buy; a kept item — a Leftovers, a TM — comes one at a
 * time and not at all once had.
 */
import { url } from '../core/bridge.mjs';
import { moveOf } from '../core/data.mjs';
import { button, el, scrollable, setChildren } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { pocketOrder } from '../engine/bagorder.mjs';
import { alreadyOwned, buy, formatMoney, oneAtATime, shopStock } from '../engine/shop.mjs';
import { moveSummary } from './movecard.mjs';
import { applySearch, searchBox } from './itemsearch.mjs';

/** The pockets in the order the bag shows them. */
const POCKETS = ['medicine', 'misc', 'berries', 'pokeballs', 'machines'];

/** The most bought in one go. */
const MAX_COUNT = 99;

/**
 * @param {{session: import('../engine/session.mjs').Session, onClose: () => void}} options
 * @returns {import('../core/app.mjs').Scene}
 */
export function shopScene({ session, onClose }) {
  const state = shopState();
  /** @type {((event: KeyboardEvent) => void)|null} */
  let onKey = null;

  /** @type {import('../core/app.mjs').Scene} */
  const scene = {
    keepBelow: true,
    keepBelowRunning: true,

    unmount() {
      if (onKey) window.removeEventListener('keydown', onKey);
      onKey = null;
    },

    mount(app) {
      const purse = el('span.shop-money');
      // Laid out as the bag's own tab body is — a column whose split takes the
      // height left under the pockets — so the stock list has a height to
      // overflow and the wheel scrolls it. As a plain block the list simply
      // grew past the bottom of the window and was cut off there, and nothing
      // scrolled at all.
      const body = el('div.screen-body.tabbed.shop-body');

      const rebuild = () => {
        const keep = body.querySelector('.item-list')?.scrollTop ?? 0;
        purse.textContent = t('money.label', { amount: formatMoney(session.money) });
        setChildren(body, [shopTab(app, session, state, rebuild)]);
        const list = body.querySelector('.item-list');
        if (list) list.scrollTop = keep;
      };
      rebuild();

      // The up and down arrows walk the list, the way the games' shop menus
      // do. Only while the shop is the screen on top — never under a dialog
      // or another screen.
      onKey = (event) => {
        if (app.scene !== scene) return;
        if (stepShop(event, state, body)) {
          app.audio.blip('select');
          rebuild();
          body.querySelector('.item-row[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' });
        }
      };
      window.addEventListener('keydown', onKey);

      return el('div.screen.inventory-screen', {}, [
        el('div.screen-header', {}, [
          el('span', { text: t('shop.title') }),
          el('span.spacer'),
          purse,
          button(t('common.close'), () => {
            app.audio.blip('cancel');
            onClose();
          }, { className: 'small' }),
        ]),
        body,
      ]);
    },
  };
  return scene;
}

/**
 * What the shop remembers between rebuilds: the pocket open, the item looked
 * at, how many of it, and the words the stock is narrowed to.
 *
 * @returns {{pocket: string, selected: string|null, count: number, query: string}}
 */
export function shopState() {
  return { pocket: POCKETS[0], selected: null, count: 1, query: '' };
}

/**
 * The shop's counter — the pockets along the top, the stock on the left and
 * what is being looked at on the right — on its own, for the shop screen and
 * for a bag that keeps the shop as one of its tabs. `purse` puts the money
 * beside the pockets, for a screen whose header does not show it.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {{pocket: string, selected: string|null, count: number, query?: string}} state
 * @param {() => void} rebuild
 * @param {{purse?: boolean}} [options]
 * @returns {HTMLElement}
 */
export function shopTab(app, session, state, rebuild, options = {}) {
  const stock = shopStock();
  const list = scrollable(el('div.item-list'));
  // In the order the bag lists the same pocket, so a thing is in the same
  // place on both sides of the counter.
  const entries = stock.filter((entry) => entry.item.pocket === state.pocket).sort(pocketOrder(state.pocket));
  if (state.selected && !entries.some((entry) => entry.slug === state.selected)) state.selected = null;

  list.append(...entries.map(({ slug, item, price }) =>
    el(`button.item-row${alreadyOwned(session, slug) ? '.unlearnable' : ''}`, {
      type: 'button',
      'data-slug': slug,
      'aria-pressed': String(slug === state.selected),
      onClick: () => {
        app.audio.blip('select');
        state.selected = slug;
        state.count = 1;
        rebuild();
      },
    }, [
      el('img', { src: url('assets', `items/${slug}.png`), alt: '' }),
      el('span.item-name', { text: localized(item.name, slug) }),
      el('span.item-count', { text: t('money.label', { amount: formatMoney(price) }) }),
    ])));
  if (state.query) applySearch(list, state.query);

  return el('div.tab-body.items-tab', {}, [
    el('div.pocket-tabs', {}, [
      ...POCKETS.map((pocket) =>
        el('button.chip', {
          type: 'button',
          text: t(`items.pocket.${pocket}`),
          'aria-pressed': String(pocket === state.pocket),
          onClick: () => {
            app.audio.blip('select');
            state.pocket = pocket;
            state.selected = null;
            rebuild();
          },
        })),
      options.purse ? el('span.shop-money.inline', { text: t('money.label', { amount: formatMoney(session.money) }) }) : null,
      searchBox(state, () => list),
    ]),
    el('div.items-split', {}, [list, inspector(app, session, state, stock, rebuild)]),
  ]);
}

/**
 * Move the shop's choice up or down its list for an arrow key: from nothing
 * chosen, down starts at the top and up at the bottom. Whether it moved, so
 * the caller rebuilds and plays the sound.
 *
 * @param {KeyboardEvent} event
 * @param {{selected: string|null, count: number}} state
 * @param {HTMLElement} root where the shop's rows are
 * @returns {boolean}
 */
export function stepShop(event, state, root) {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
  const target = /** @type {HTMLElement|null} */ (event.target);
  if (target?.closest?.('input, textarea, select')) return false;
  // Only the rows a search has left showing.
  const shown = [...root.querySelectorAll('.item-row:not([hidden])')].map((row) => /** @type {HTMLElement} */ (row).dataset.slug ?? '');
  if (shown.length === 0) return false;
  event.preventDefault();

  const down = event.key === 'ArrowDown';
  const at = state.selected ? shown.indexOf(state.selected) : -1;
  const next = at < 0 ? (down ? 0 : shown.length - 1) : Math.max(0, Math.min(shown.length - 1, at + (down ? 1 : -1)));
  if (next === at) return false;
  state.selected = shown[next];
  state.count = 1;
  return true;
}

/**
 * What is being looked at: what it does, what it costs, and the way to buy it.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {{selected: string|null, count: number}} state
 * @param {Array<{slug: string, item: any, price: number}>} stock
 * @param {() => void} rebuild
 */
function inspector(app, session, state, stock, rebuild) {
  // The description on top, scrolling on its own when a machine's move text
  // runs long; the count and the buy button in a footer pinned to the bottom,
  // so they are in the same place whatever is being read — one line of text
  // or eight, an item bought by the dozen or one kept for good.
  const panel = el('div.item-inspector.shop-inspector');
  const entry = stock.find((candidate) => candidate.slug === state.selected);
  if (!entry) {
    panel.append(el('span.meta.inspect-hint', { text: t('shop.hint') }));
    return panel;
  }
  const { slug, item, price } = entry;
  const move = item.pocket === 'machines' ? moveOf(item.move) : null;
  const owned = alreadyOwned(session, slug);
  const many = !oneAtATime(slug);
  const total = price * state.count;

  const setCount = (count) => {
    state.count = Math.max(1, Math.min(MAX_COUNT, count));
    app.audio.blip('select');
    rebuild();
  };

  const buyButton = button(t('shop.buy', { amount: formatMoney(total) }), () => {
    const result = buy(session, slug, state.count);
    // The count stays where it was set after a purchase, so buying the same
    // ten again is one press rather than setting ten all over; it goes back
    // to one only when another item is picked.
    if (result === 'bought') {
      app.audio.blip('confirm');
      app.toast(t('shop.bought', { item: localized(item.name, slug), count: many ? state.count : 1 }));
    } else {
      app.audio.blip('error');
      app.toast(t(result === 'poor' ? 'shop.poor' : 'shop.owned'));
    }
    rebuild();
  }, { className: 'small primary', disabled: owned || session.money < total });

  setChildren(panel, [
    scrollable(el('div.inspect-scroll', {}, [
      el('img.inspect-icon', { src: url('assets', `items/${slug}.png`), alt: '' }),
      el('span.inspect-name', { text: localized(item.name, slug) }),
      move
        ? el('div.inspect-machine', {}, [
            el('span.inspect-move-name', { text: localized(move.name, item.move) }),
            el('span.meta', { text: moveSummary(item.move) }),
            el('p.inspect-text', { text: localized(move.text, '') }),
          ])
        : el('p.inspect-text', { text: localized(item.text, '') }),
    ])),
    el('div.shop-footer', {}, [
      el(`span.meta${owned ? '.inspect-inert' : ''}`, {
        text: owned ? t('shop.owned') : t('shop.inBag', { count: session.countOf(slug) }),
      }),
      // The count row keeps its height for a kept item too, bought one at a
      // time, so the button under it does not move.
      el(`div.shop-count-row${many && !owned ? '' : '.idle'}`, {}, [
        button('−', () => setCount(state.count - 1), { className: 'small' }),
        el('span.shop-count', { text: `×${state.count}` }),
        button('+', () => setCount(state.count + 1), { className: 'small' }),
        button('×10', () => setCount(state.count + 10), { className: 'small' }),
      ]),
      buyButton,
    ]),
  ]);
  return panel;
}
