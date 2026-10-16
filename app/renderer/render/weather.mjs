/**
 * The sky a place is under, drawn over the map.
 *
 * A battle fought on Route 119 opens in rain and one in the desert opens in a
 * sandstorm, because the area's own tags say so — but the road the companion
 * walked in on was bright and still either way, so the weather arrived out of
 * nowhere the moment a fight started. This draws the same sky on the field.
 *
 * Everything is procedural: there is no weather art in the asset set, and a
 * few hundred streaks placed by arithmetic cost nothing and never need
 * downloading.
 */
import { FIELD_HEIGHT, FIELD_WIDTH } from '../../shared/constants.mjs';

/**
 * How each sky is drawn: how many marks it puts in the air, how fast they
 * travel in field pixels a second, and the wash laid under them.
 *
 * The pool is spread over a band a little larger than the view, so about
 * three in five of it is on screen at a time. These counts came down a long
 * way — ninety streaks on a 240x135 field was a curtain rather than weather,
 * and it sat in front of everything the player was trying to look at. A dozen
 * or so says the same thing about the sky and leaves the road readable.
 */
const SKIES = {
  rain: { marks: 30, speed: { x: -70, y: 320 }, length: 7, colour: 'rgba(168, 202, 240, 0.55)', wash: 'rgba(28, 44, 78, 0.22)' },
  snow: { marks: 22, speed: { x: -18, y: 46 }, length: 0, colour: 'rgba(238, 246, 255, 0.85)', wash: 'rgba(96, 122, 160, 0.18)' },
  sandstorm: { marks: 26, speed: { x: -260, y: 24 }, length: 11, colour: 'rgba(222, 196, 138, 0.5)', wash: 'rgba(168, 140, 86, 0.26)' },
  sun: { marks: 0, speed: { x: 0, y: 0 }, length: 0, colour: 'rgba(0, 0, 0, 0)', wash: 'rgba(255, 216, 140, 0.16)' },
  hail: { marks: 22, speed: { x: -40, y: 210 }, length: 3, colour: 'rgba(226, 244, 255, 0.8)', wash: 'rgba(96, 122, 160, 0.18)' },
};

/** How much either way a mark's own speed differs from its sky's. */
const SPEED_JITTER = 0.35;

/**
 * A number in `[0, 1)` for a pair of integers: the same pair always gives the
 * same number, and neighbouring pairs give unrelated ones.
 *
 * This is what makes the weather random without keeping any state. The marks
 * used to be placed at `index * 83` across and `index * 47` down, wrapped to
 * the view. Either one on its own looks well spread, but both are linear in
 * the same index, so the pair of them is a lattice: the drops sat on evenly
 * spaced parallel diagonals, and the rain read as a printed pattern sliding
 * past rather than as weather.
 *
 * @param {number} a
 * @param {number} b
 */
function noise(a, b) {
  let hash = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) >>> 0;
  hash = (hash ^ (hash >>> 13)) >>> 0;
  hash = Math.imul(hash, 1274126177) >>> 0;
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}

/**
 * One mark's place at a moment.
 *
 * Three things are drawn from the mark's own index rather than computed from
 * it, which is what turns a lattice into weather: **where it starts**, **how
 * fast it goes** (a third either way, so the pool never falls in step), and
 * **which column it comes down in on each new fall** — so a drop is somewhere
 * new every time round instead of retracing one line for ever.
 *
 * Wrapping both axes is kept from the original, because it is what makes the
 * marks cover the view evenly: a mark that leaves one edge is immediately owed
 * back at the other, so there are no thin patches however the wind blows. No
 * state is kept between frames, so the weather still costs nothing when nobody
 * is looking at it and never drifts out of step with itself.
 *
 * @param {number} index
 * @param {number} elapsed milliseconds since the run started
 * @param {{speed: {x: number, y: number}, length: number}} sky
 * @returns {{x: number, y: number, length: number}}
 */
function markAt(index, elapsed, sky) {
  const spanX = FIELD_WIDTH + 80;
  const spanY = FIELD_HEIGHT + 40;

  const pace = 1 + (noise(index, 0) - 0.5) * 2 * SPEED_JITTER;
  const seconds = (elapsed / 1000) * pace;

  const travelled = noise(index, 1) * spanY + sky.speed.y * seconds;
  // A new fall — each time the mark wraps past the bottom — gets a column of
  // its own, so nothing about where it fell last time survives.
  const fall = Math.floor(travelled / spanY);
  const column = noise(index, 2) * spanX + noise(index, fall * 2 + 3) * spanX;

  return {
    x: wrap(column + sky.speed.x * seconds, spanX) - 40,
    y: wrap(travelled, spanY) - 20,
    length: sky.length * pace,
  };
}

const wrap = (value, span) => ((value % span) + span) % span;

/**
 * Draw the weather over the field, in the field's own coordinates.
 *
 * @param {CanvasRenderingContext2D} context
 * @param {string|null|undefined} weather
 * @param {number} elapsed milliseconds, for where the marks have got to
 */
export function drawWeather(context, weather, elapsed) {
  const sky = weather ? SKIES[weather] : null;
  if (!sky) return;

  context.save();
  if (sky.wash) {
    context.fillStyle = sky.wash;
    context.fillRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT);
  }

  context.strokeStyle = sky.colour;
  context.fillStyle = sky.colour;
  context.lineWidth = 1;

  for (let index = 0; index < sky.marks; index++) {
    const mark = markAt(index, elapsed, sky);
    if (sky.length === 0) {
      // Snow falls as flakes rather than streaks, and drifts sideways as it
      // goes so it does not read as a column of dots.
      const drift = Math.sin(elapsed / 700 + index) * 2;
      context.fillRect(Math.round(mark.x + drift), Math.round(mark.y), 1, 1);
      continue;
    }
    // A streak lies along the direction it is travelling in.
    const speed = Math.hypot(sky.speed.x, sky.speed.y) || 1;
    const dx = (sky.speed.x / speed) * mark.length;
    const dy = (sky.speed.y / speed) * mark.length;
    context.beginPath();
    context.moveTo(Math.round(mark.x), Math.round(mark.y));
    context.lineTo(Math.round(mark.x + dx), Math.round(mark.y + dy));
    context.stroke();
  }
  context.restore();
}
