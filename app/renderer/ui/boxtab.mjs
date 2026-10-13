/**
 * The Box tab: every Pokémon caught so far, in the grid the main series uses.
 *
 * Selecting one offers the same four actions the games do — take it along,
 * move it to another space, release it, or back out — and a fifth: marking it
 * a favourite, which keeps it in the top rows under a yellow star.
 *
 * The box has no limit: it grows a row at a time as it fills.
 */
import { loadPictureUrl, readyPictureUrl } from '../core/assets.mjs';
import { artPath, speciesOf } from '../core/data.mjs';
import { button, el, scrollable, setChildren, shinyMark } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { levelOf } from '../engine/pokemon.mjs';
import { championIcon } from './badges.mjs';
import { chooseAction, confirm } from './dialog.mjs';

/** Spaces to a row, as the grid lays them out, and the rows always shown. */
const ROW = 10;
const MIN_ROWS = 5;

/**
 * How far past the edge of the box's window a space's picture is fetched
 * before it scrolls into view, so a steady scroll meets pictures already
 * there.
 */
const FETCH_AHEAD = '120px 0px';

/**
 * The box is laid out once when the tab opens, and from then on put right
 * where it changed rather than built again: moving, marking, sorting or
 * swapping a Pokémon redraws the spaces, but each Pokémon keeps the space it
 * was drawn in, picture and all, wherever it moves to. Building every space
 * afresh set every picture in the box up again on each press.
 *
 * And a picture is only fetched once its space comes near the window: a box of
 * hundreds opens on its first few rows, and the rest arrive as it scrolls.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {{moving?: number|null}} state
 * @returns {HTMLElement}
 */
export function boxTab(app, session, state) {
  const grid = scrollable(el('div.box-grid'));
  const head = el('div.box-head');

  // A space's picture is fetched the first time it comes near the window.
  const nearby = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        nearby.unobserve(entry.target);
        showPicture(/** @type {HTMLImageElement} */ (entry.target));
      }
    },
    { root: grid, rootMargin: FETCH_AHEAD },
  );

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
      if (!node || node.dataset.art !== path) node = filledSpace(app, session, pokemon, path, state, update, nearby);
      dress(node, pokemon, moving === index);
      next.set(pokemon, node);
      children.push(node);
    }
    grid.replaceChildren(...children);
    drawn = next;
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
 * @param {IntersectionObserver} nearby
 */
function filledSpace(app, session, pokemon, path, state, update, nearby) {
  const picture = /** @type {HTMLImageElement} */ (el('img', { alt: '', loading: 'lazy', decoding: 'async', dataset: { path } }));
  const ready = readyPictureUrl(path);
  if (ready) picture.src = ready;
  else if (path) nearby.observe(picture);

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

/**
 * Put a space's picture up, fetching it first if no space has shown it yet.
 * @param {HTMLImageElement} picture
 */
function showPicture(picture) {
  const path = picture.dataset.path ?? '';
  loadPictureUrl(path)
    .then((src) => {
      picture.src = src;
    })
    .catch(() => {
      // A missing picture leaves the space empty rather than the box broken.
    });
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
    shinyMark(pokemon, t('pokemon.shiny')),
    pokemon.favorite ? el('i.favorite-mark', { title: t('box.favorite') }) : null,
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
  const label = pokemon.nickname || localized(speciesOf(pokemon.speciesId)?.name, '');

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
