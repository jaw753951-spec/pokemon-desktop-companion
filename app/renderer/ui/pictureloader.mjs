/**
 * Pictures put up a few rows at a time as a grid scrolls: the box's, and the
 * Pokédex's, which lists every species there is and set over a thousand
 * pictures loading the moment it opened.
 */
import { url } from '../core/bridge.mjs';

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

/** The pictures a grid has shown this run, the box's or the Pokédex's. @type {Set<string>} */
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
 * @param {HTMLElement} grid the scrolling grid, its spaces in order, each with
 *   its picture first and the picture's path in `data-path`
 * @param {number} row spaces to a row, as the grid lays them out
 * @returns {{refresh: () => void}} look again after the spaces change
 */
export function pictureLoader(grid, row) {
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
    if (spaces.length <= row) return [];
    const first = spaces[0].getBoundingClientRect();
    const stride = spaces[row].getBoundingClientRect().top - first.top;
    if (stride <= 0) return [];
    // Where the first row sits in the scrolled content, and the stretch of it
    // wanted now.
    const offset = first.top - grid.getBoundingClientRect().top + grid.scrollTop;
    const top = grid.scrollTop - FETCH_AHEAD - offset;
    const bottom = grid.scrollTop + grid.clientHeight + FETCH_AHEAD - offset;
    const from = Math.max(0, Math.floor(top / stride)) * row;
    const to = Math.min(spaces.length, Math.ceil(bottom / stride) * row);
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
