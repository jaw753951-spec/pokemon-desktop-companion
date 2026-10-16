/**
 * The Box tab: every Pokémon caught so far, in the grid the main series uses.
 *
 * Selecting one offers the same four actions the games do — take it along,
 * move it to another space, release it, or back out — and a fifth: marking it
 * a favourite, which keeps it in the top rows under a yellow star.
 *
 * The box has no limit: it grows a row at a time as it fills.
 */
import { url } from '../core/bridge.mjs';
import { artPath, speciesOf } from '../core/data.mjs';
import { button, el, scrollable, setChildren, shinyMark } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { levelOf, nameOf } from '../engine/pokemon.mjs';
import { championIcon } from './badges.mjs';
import { chooseAction, confirm } from './dialog.mjs';

/** Spaces to a row, as the grid lays them out, and the rows always shown. */
const ROW = 10;
const MIN_ROWS = 5;

/**
 * How far past the edge of the box's window, in pixels, a space's picture is
 * fetched before it scrolls into view, so a steady scroll meets pictures
 * already there.
 */
const FETCH_AHEAD = 120;

/**
 * How many pictures are fetched at once; the rest near the window wait their
 * turn, and any that scroll away before it comes are not fetched at all.
 */
const FETCHES_AT_ONCE = 12;

/**
 * How fast the box can scroll, in pixels a millisecond, and still fetch the
 * pictures it passes: about a window's height in a tenth of a second. Faster
 * than that, it is flying past rows nobody is looking at.
 */
const FLYING_PAST = 2.5;

/** How long a fast scroll has to slow down for before its pictures come. */
const SETTLE_MS = 80;

/**
 * The box is laid out once when the tab opens, and from then on put right
 * where it changed rather than built again: moving, marking, sorting or
 * swapping a Pokémon redraws the spaces, but each Pokémon keeps the space it
 * was drawn in, picture and all, wherever it moves to. Building every space
 * afresh set every picture in the box up again on each press.
 *
 * And a picture is only fetched once its space comes near the window: a box of
 * hundreds opens on its first few rows, and the rest arrive as it scrolls —
 * see {@link pictureLoader} for why a fast scroll does not fetch everything
 * it passes.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {{moving?: number|null}} state
 * @returns {HTMLElement}
 */
export function boxTab(app, session, state) {
  const grid = scrollable(el('div.box-grid'));
  const head = el('div.box-head');

  const pictures = pictureLoader(grid);

  /** The space each Pokémon is drawn in. @type {Map<any, HTMLElement>} */
  let drawn = new Map();

  const update = () => {
    const moving = state.moving ?? null;
    setChildren(head, header(app, session, state, update));

    // Every space in use and at least one free one, in whole rows.
    const spaces = Math.max(MIN_ROWS, Math.ceil((session.box.length + 1) / ROW)) * ROW;
    /** @type {Map<any, HTMLElement>} */
    const next = new Map();
    const children = [];
    for (let index = 0; index < spaces; index++) {
      const pokemon = session.box[index] ?? null;
      if (!pokemon) {
        children.push(emptySpace(app, session, index, state, update));
        continue;
      }
      const path = artPath(pokemon) ?? '';
      let node = drawn.get(pokemon);
      if (!node || node.dataset.art !== path) node = filledSpace(app, session, pokemon, path, state, update);
      dress(node, pokemon, moving === index);
      next.set(pokemon, node);
      children.push(node);
    }
    grid.replaceChildren(...children);
    drawn = next;
    pictures.refresh();
  };
  update();

  return el('div.tab-body.box-tab', {}, [head, grid]);
}

/**
 * The count, or what to do while a Pokémon is being moved, and the sort
 * buttons.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {{moving?: number|null}} state
 * @param {() => void} update
 */
function header(app, session, state, update) {
  const moving = state.moving !== null && state.moving !== undefined;
  return [
    moving
      ? el('div.box-hint', { text: t('box.moveTarget') })
      : el('div.box-hint', { text: t('box.count', { count: session.box.filter(Boolean).length }) }),
    moving ? null : el('div.box-sort', {}, [
      button(t(SORT_LABELS[session.boxSort.key]), () => sortMenu(app, session, update), { className: 'small' }),
      // Which way round, beside it: one press turns the box over.
      el('button.btn.small.box-sort-way', {
        type: 'button',
        text: session.boxSort.reverse ? '↓' : '↑',
        title: t(session.boxSort.reverse ? 'box.sortReverse' : 'box.sortForward'),
        'aria-label': t(session.boxSort.reverse ? 'box.sortReverse' : 'box.sortForward'),
        onClick: () => {
          session.sortBox(session.boxSort.key, !session.boxSort.reverse);
          app.audio.blip('confirm');
          update();
        },
      }),
    ]),
  ];
}

/** What each order is called, on its button and in its menu. */
const SORT_LABELS = /** @type {const} */ ({ dex: 'box.sortDex', clear: 'box.sortClear', shiny: 'box.sortShiny' });

/**
 * Ask which order to put the box in, and put it in that order the way round
 * it already is. Favourites stay at the top whichever it is.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {() => void} update
 */
async function sortMenu(app, session, update) {
  const key = await chooseAction(
    app,
    t('box.sort'),
    /** @type {Array<'dex'|'clear'|'shiny'>} */ (['dex', 'clear', 'shiny']).map((value) => ({ value, label: t(SORT_LABELS[value]) })),
  );
  if (!key) return;
  session.sortBox(key, session.boxSort.reverse);
  app.audio.blip('confirm');
  update();
}

/**
 * A free space: somewhere to put the Pokémon being moved, and nothing
 * otherwise.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {number} index
 * @param {{moving?: number|null}} state
 * @param {() => void} update
 */
function emptySpace(app, session, index, state, update) {
  const moving = state.moving ?? null;
  return el(`button.box-space.empty${moving === null ? '' : '.target'}`, {
    type: 'button',
    onClick: () => {
      if (state.moving === null || state.moving === undefined) return;
      moveTo(session, state.moving, index);
      state.moving = null;
      app.audio.blip('confirm');
      update();
    },
  });
}

/**
 * A Pokémon's space. It goes wherever the Pokémon does, so a press looks up
 * where that is now rather than remembering where it was drawn.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {any} pokemon
 * @param {string} path its picture
 * @param {{moving?: number|null}} state
 * @param {() => void} update
 */
function filledSpace(app, session, pokemon, path, state, update) {
  // Its picture is put up by the box's `pictureLoader` once it is near the
  // window.
  const picture = /** @type {HTMLImageElement} */ (el('img', { alt: '', decoding: 'async', dataset: { path } }));

  return el('button.box-space', {
    type: 'button',
    dataset: { art: path },
    onClick: () => {
      const index = session.box.indexOf(pokemon);
      if (index < 0) return;
      if (state.moving !== null && state.moving !== undefined) {
        moveTo(session, state.moving, index);
        state.moving = null;
        app.audio.blip('confirm');
        update();
        return;
      }
      openMenu(app, session, index, update, state);
    },
  }, [picture]);
}

/** The pictures the box has shown this run. @type {Set<string>} */
const shown = new Set();

/**
 * Puts up the pictures of the spaces in and near the box's window, fetching
 * the ones no space has shown yet a few at a time.
 *
 * Which spaces those are is worked out from where the box is scrolled to —
 * every row is the same height — each time it moves, top row first. Fetching
 * every space the moment it came near the window had a fast scroll down a
 * long box ask for every picture it passed, hundreds of them for rows long
 * gone by the time they arrived, and the box stuttered under them while the
 * rows it stopped on waited behind. Now a space that has scrolled away before
 * its turn is simply not fetched, and while the box is still flying past
 * nothing is: the rows go by too fast to read, and the work is what made it
 * stutter.
 *
 * @param {HTMLElement} grid the box's scrolling grid, its spaces in order
 * @returns {{refresh: () => void}} look again after the spaces change
 */
function pictureLoader(grid) {
  /** The pictures being fetched. @type {Set<HTMLImageElement>} */
  const fetching = new Set();

  // How fast the box is scrolling.
  let lastTop = grid.scrollTop;
  let lastAt = performance.now();
  let flyingUntil = 0;
  /** @type {number|null} */
  let settle = null;
  /** @type {number|null} */
  let frame = null;

  const schedule = () => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      next();
    });
  };

  /** The pictures still to put up in and near the window, top row first. */
  const wanted = () => {
    const spaces = grid.children;
    if (spaces.length <= ROW) return [];
    const first = spaces[0].getBoundingClientRect();
    const stride = spaces[ROW].getBoundingClientRect().top - first.top;
    if (stride <= 0) return [];
    // Where the first row sits in the scrolled content, and the stretch of it
    // wanted now.
    const offset = first.top - grid.getBoundingClientRect().top + grid.scrollTop;
    const top = grid.scrollTop - FETCH_AHEAD - offset;
    const bottom = grid.scrollTop + grid.clientHeight + FETCH_AHEAD - offset;
    const from = Math.max(0, Math.floor(top / stride)) * ROW;
    const to = Math.min(spaces.length, Math.ceil(bottom / stride) * ROW);
    /** @type {HTMLImageElement[]} */
    const out = [];
    for (let index = from; index < to; index++) {
      const picture = spaces[index].firstElementChild;
      if (!(picture instanceof HTMLImageElement) || picture.hasAttribute('src') || fetching.has(picture)) continue;
      if (!picture.dataset.path || picture.dataset.failed) continue;
      out.push(picture);
    }
    return out;
  };

  const next = () => {
    if (!grid.isConnected) return;
    const wait = flyingUntil - performance.now();
    if (wait > 0) {
      if (settle === null) {
        settle = window.setTimeout(() => {
          settle = null;
          schedule();
        }, wait);
      }
      return;
    }
    for (const picture of wanted()) {
      const path = /** @type {string} */ (picture.dataset.path);
      // One the box has shown before is in the renderer's memory already.
      if (shown.has(path)) {
        picture.src = url('assets', path);
        continue;
      }
      if (fetching.size >= FETCHES_AT_ONCE) continue;
      fetching.add(picture);
      picture.addEventListener('load', () => {
        shown.add(path);
        fetching.delete(picture);
        schedule();
      }, { once: true });
      picture.addEventListener('error', () => {
        // A missing picture leaves the space empty rather than the box
        // broken, and is not asked for again.
        picture.dataset.failed = 'true';
        fetching.delete(picture);
        schedule();
      }, { once: true });
      picture.src = url('assets', path);
    }
  };

  grid.addEventListener('scroll', () => {
    const now = performance.now();
    const speed = Math.abs(grid.scrollTop - lastTop) / Math.max(1, now - lastAt);
    lastTop = grid.scrollTop;
    lastAt = now;
    if (speed > FLYING_PAST) flyingUntil = now + SETTLE_MS;
    schedule();
  }, { passive: true });

  return { refresh: schedule };
}

/**
 * What a Pokémon's space says about it now: its name and level, its marks,
 * and whether it is the one being moved. The picture stays as it is.
 *
 * @param {HTMLElement} node
 * @param {any} pokemon
 * @param {boolean} moving
 */
function dress(node, pokemon, moving) {
  const species = speciesOf(pokemon.speciesId);
  node.title = `${pokemon.nickname || localized(species?.name, '')} ${t('slot.level', { level: levelOf(pokemon) })}`;
  node.classList.toggle('moving', moving);
  const picture = /** @type {Node} */ (node.firstChild);
  setChildren(node, [
    picture,
    shinyMark(pokemon),
    pokemon.favorite ? el('i.favorite-mark') : null,
    // The crown of a Pokémon that has beaten the League.
    pokemon.champion ? el('i.champion-pin', {}, [championIcon()]) : null,
  ]);
}

/**
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {number} index
 * @param {() => void} update
 * @param {{moving?: number|null}} state
 */
async function openMenu(app, session, index, update, state) {
  const pokemon = session.box[index];
  if (!pokemon) return;
  const label = nameOf(pokemon);

  const choice = await chooseAction(app, label, [
    { value: 'switch', label: t('box.switch') },
    { value: 'move', label: t('box.move') },
    { value: 'favorite', label: pokemon.favorite ? t('box.unfavorite') : t('box.makeFavorite') },
    { value: 'release', label: t('box.release'), danger: true },
  ]);

  if (choice === 'favorite') {
    app.audio.blip('confirm');
    session.toggleFavorite(index);
    update();
    return;
  }

  if (choice === 'switch') {
    session.switchActive(index);
    app.toast(t('box.switched', { name: label }));
    app.audio.playCry(session.active.speciesId);
    update();
    return;
  }

  if (choice === 'move') {
    state.moving = index;
    update();
    return;
  }

  if (choice === 'release') {
    if (!(await confirm(app, t('box.releaseConfirm'), { danger: true }))) return;
    session.box[index] = null;
    app.toast(t('box.released', { name: label }));
    update();
  }
}

/**
 * Swap two spaces. Moving onto an empty space leaves the original empty, which
 * is how the games' box cursor behaves.
 *
 * @param {import('../engine/session.mjs').Session} session
 * @param {number} from
 * @param {number} to
 */
function moveTo(session, from, to) {
  if (from === to) return;
  while (session.box.length <= Math.max(from, to)) session.box.push(null);
  const moved = session.box[from];
  session.box[from] = session.box[to] ?? null;
  session.box[to] = moved;
}
