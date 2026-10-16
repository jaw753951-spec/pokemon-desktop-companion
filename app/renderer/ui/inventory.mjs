/**
 * The bag: the tabs the brief calls for, opening on Pokémon.
 *
 * Each tab rebuilds itself from the session whenever something changes, which
 * keeps the screens stateless apart from the small amount of view state — the
 * open pocket, the Pokémon being moved — carried in `state`.
 */
import { button, el, setChildren } from '../core/dom.mjs';
import { t } from '../core/i18n.mjs';
import { boxTab } from './boxtab.mjs';
import { itemsTab } from './itemstab.mjs';
import { pokemonTab } from './pokemontab.mjs';
import { shopState, shopTab, stepShop } from './shop.mjs';

/** The tabs the bag opens with on the road. */
const TABS = ['pokemon', 'items', 'box'];

/**
 * `tabs` swaps the bag's tabs for another set: the League's bag has the shop
 * where the box would be, since no Pokémon is swapped in the middle of a
 * challenge.
 *
 * @param {{session: import('../engine/session.mjs').Session, onClose: () => void, tabs?: Array<'pokemon'|'items'|'box'|'shop'>}} options
 * @returns {import('../core/app.mjs').Scene}
 */
export function inventoryScene({ session, onClose, tabs: shownTabs = /** @type {any} */ (TABS) }) {
  /** View state that should survive a rebuild but not a reopen. */
  const state = {
    /** The shop's own, when it is one of the tabs. */
    shop: shopState(),
    tab: 'pokemon',
    pocket: 'medicine',
    moving: /** @type {number|null} */ (null),
    /** Which move slot the Pokémon tab is showing the description for. */
    moveSlot: /** @type {number|null} */ (null),
    /** The item the items tab is showing, which the arrow keys move. */
    selected: /** @type {string|null} */ (null),
  };

  /** @type {((event: KeyboardEvent) => void)|null} */
  let onKey = null;

  /** @type {import('../core/app.mjs').Scene} */
  const scene = {
    keepBelow: true,
    // The companion keeps walking under this: a menu is the player
    // stopping to read, not the Pokémon stopping to wait.
    keepBelowRunning: true,

    unmount() {
      if (onKey) window.removeEventListener('keydown', onKey);
      onKey = null;
    },

    mount(app) {
      const tabs = el('div.tab-strip');
      const body = el('div.screen-body.tabbed');

      /**
       * Rebuild the open tab.
       *
       * The body is replaced wholesale, which threw the reader back to the top
       * of the page every time anything was touched — reading a move's
       * description meant scrolling down to the slots, clicking, and being
       * carried back up above the sprite. So where each scroller stood is
       * carried across, except when the tab itself changes and the top is
       * where you want to be.
       *
       * @param {{keepScroll?: boolean}} [options]
       */
      const rebuild = (options = {}) => {
        const keep = options?.keepScroll === false ? [] : scrollOffsets(body);

        setChildren(tabs, [
          ...shownTabs.map((name) =>
            el('button.tab', {
              type: 'button',
              text: t(`inventory.${name}`),
              'aria-pressed': String(state.tab === name),
              onClick: () => {
                if (state.tab === name) return;
                app.audio.blip('select');
                state.tab = name;
                state.moving = null;
                state.moveSlot = null;
                rebuild({ keepScroll: false });
              },
            }),
          ),
        ]);

        body.replaceChildren(render(app, session, state, rebuild));
        restoreScroll(body, keep);
      };
      rebuild();

      // On the items tab the up and down arrows walk the pocket's list, as
      // they do in the shop, keeping the chosen row in view. Only while the
      // bag is the screen on top, so a dialog opened from it keeps its keys.
      onKey = (event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        if (app.scene === scene && state.tab === 'shop') {
          if (stepShop(event, state.shop, body)) {
            app.audio.blip('select');
            rebuild();
            body.querySelector('.item-row[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' });
          }
          return;
        }
        if (app.scene !== scene || state.tab !== 'items') return;
        const target = /** @type {HTMLElement|null} */ (event.target);
        if (target?.closest?.('input, textarea, select')) return;
        // Only the rows a search has left showing.
        const shown = [...body.querySelectorAll('.item-row:not([hidden])')].map((row) => /** @type {HTMLElement} */ (row).dataset.slug ?? '');
        if (shown.length === 0) return;
        event.preventDefault();

        const down = event.key === 'ArrowDown';
        const at = state.selected ? shown.indexOf(state.selected) : -1;
        const next = at < 0 ? (down ? 0 : shown.length - 1) : Math.max(0, Math.min(shown.length - 1, at + (down ? 1 : -1)));
        if (next === at) return;
        app.audio.blip('select');
        state.selected = shown[next];
        rebuild();
        body.querySelector('.item-row[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' });
      };
      window.addEventListener('keydown', onKey);

      return el('div.screen.inventory-screen', {}, [
        el('div.screen-header', {}, [
          tabs,
          el('span.spacer'),
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
 * Where every scroller inside a node stands, in the order they appear.
 * @param {HTMLElement} node
 * @returns {number[]}
 */
function scrollOffsets(node) {
  return [...node.querySelectorAll('.scroll')].map((element) => element.scrollTop);
}

/**
 * Put them back, as far as the rebuilt page allows.
 * @param {HTMLElement} node
 * @param {number[]} offsets
 */
function restoreScroll(node, offsets) {
  [...node.querySelectorAll('.scroll')].forEach((element, index) => {
    const wanted = offsets[index];
    if (typeof wanted === 'number') element.scrollTop = wanted;
  });
}

/**
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {any} state
 * @param {() => void} rebuild
 */
function render(app, session, state, rebuild) {
  switch (state.tab) {
    case 'items':
      return itemsTab(app, session, rebuild, state);
    case 'box':
      return boxTab(app, session, state);
    case 'shop':
      return shopTab(app, session, state.shop, rebuild, { purse: true });
    case 'pokemon':
    default:
      return pokemonTab(app, session, rebuild, state);
  }
}
