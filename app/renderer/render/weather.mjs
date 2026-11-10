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

/**
 * The sky an area's weather is drawn with, or null for a clear one.
 *
 * @param {string|null|undefined} weather
 */
export function skyOf(weather) {
  return (weather && SKIES[/** @type {keyof typeof SKIES} */ (weather)]) || null;
}

/** How tall a tile of the road's weather is, in field pixels. */
const TILE_HEIGHT = 160;
/** How wide one may be: no narrower than the view, so it never repeats across it. */
const TILE_WIDTH = { min: FIELD_WIDTH, max: 330 };

/**
 * The tile the road's weather repeats on, and how far it slides each time
 * round.
 *
 * On the road the weather is not drawn mark by mark any more: one tile of it
 * is drawn once, laid over the view as a repeating picture, and slid along by
 * the compositor, which costs the page nothing a frame. For the slide to loop
 * without a jump it has to end exactly one repeat of the tile away from where
 * it started — `across` tiles sideways and `down` tiles down — in the
 * direction the sky blows. So the tile's width is chosen to make that so: the
 * rain's slant is a seventh of its fall, so a rain tile is a seventh as wide
 * per tile fallen as the slant is long.
 *
 * @param {{speed: {x: number, y: number}}} sky
 * @returns {{width: number, height: number, across: number, down: number}}
 */
export function weatherTile(sky) {
  const height = TILE_HEIGHT;
  const slant = Math.abs(sky.speed.x) / Math.max(1, sky.speed.y);
  if (slant === 0) return { width: TILE_WIDTH.min, height, across: 0, down: 1 };
  let best = null;
  for (let across = 1; across <= 12; across++) {
    for (let down = 1; down <= 12; down++) {
      const width = (slant * down * height) / across;
      if (width < TILE_WIDTH.min || width > TILE_WIDTH.max) continue;
      if (!best || across + down < best.across + best.down) best = { width: Math.round(width), height, across, down };
    }
  }
  return best ?? { width: TILE_WIDTH.min, height, across: 0, down: 1 };
}

/**
 * Draw one tile of a sky's marks, wrapped at its edges so it repeats without a
 * seam — the same marks {@link drawWeather} draws, placed by the same noise.
 *
 * @param {CanvasRenderingContext2D} context in field pixels
 * @param {{speed: {x: number, y: number}, length: number, colour: string, marks: number}} sky
 * @param {{width: number, height: number}} tile
 * @param {number} seed which of the sky's layers this is, so two are not alike
 * @param {number} count how many marks to put on it
 */
export function drawWeatherTile(context, sky, tile, seed, count) {
  context.save();
  context.strokeStyle = sky.colour;
  context.fillStyle = sky.colour;
  context.lineWidth = 1;
  const speed = Math.hypot(sky.speed.x, sky.speed.y) || 1;
  for (let index = 0; index < count; index++) {
    const x = Math.round(noise(index, seed * 7 + 1) * tile.width);
    const y = Math.round(noise(index, seed * 7 + 2) * tile.height);
    const length = sky.length * (1 + (noise(index, seed * 7 + 3) - 0.5) * 2 * SPEED_JITTER);
    const dx = Math.round((sky.speed.x / speed) * length);
    const dy = Math.round((sky.speed.y / speed) * length);
    // Drawn again a tile over wherever it runs off an edge.
    for (const shiftX of [-tile.width, 0, tile.width]) {
      for (const shiftY of [-tile.height, 0, tile.height]) {
        if (sky.length === 0) {
          context.fillRect(x + shiftX, y + shiftY, 1, 1);
          continue;
        }
        context.beginPath();
        context.moveTo(x + shiftX, y + shiftY);
        context.lineTo(x + shiftX + dx, y + shiftY + dy);
        context.stroke();
      }
    }
  }
  context.restore();
}

/**
 * How many marks a tile carries for the sky to look as thick as it does drawn
 * mark by mark, which spreads its pool over a band a little larger than the
 * view.
 *
 * @param {{marks: number}} sky
 * @param {{width: number, height: number}} tile
 */
export function marksPerTile(sky, tile) {
  const band = (FIELD_WIDTH + 80) * (FIELD_HEIGHT + 40);
  return Math.round((sky.marks * tile.width * tile.height) / band);
}
