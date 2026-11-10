/**
 * The road, drawn as layers the compositor moves rather than as one picture
 * painted again every frame.
 *
 * The field used to clear the whole canvas and draw everything on it sixty
 * times a second — the road, whatever stood on it, the companion, the bridge,
 * the weather — although almost none of it changes from one frame to the next:
 * the road only slides, a pixel at a time, a few dozen times a second. Now
 * each part is its own layer under the game's canvas:
 *
 * - the road and the bridge over it are drawn once, as strips long enough to
 *   slide a whole map's width, and only moved;
 * - an event's prop is drawn on a layer of its own that moves with the road,
 *   painted again only when the prop's own picture changes (a tree swaying, a
 *   door opening);
 * - the companion is painted again only when it hops, bobs, kicks up dust or
 *   picks something up;
 * - the weather is one tile drawn once and slid; and the hour's light is put
 *   on each layer of standing things as it is painted.
 *
 * Moving a layer costs the page nothing it has to draw; the compositor puts the
 * same pixels somewhere else.
 */
import { FIELD_HEIGHT, FIELD_WIDTH, FIELD_ZOOM, VIEW_HEIGHT, VIEW_WIDTH } from '../../shared/constants.mjs';
import { light } from './daylight.mjs';
import { drawWeather, drawWeatherTile, marksPerTile, skyOf, weatherTile } from './weather.mjs';

/**
 * How wide the layer an event's prop is drawn on is, in field pixels, with the
 * prop drawn at its middle. Wide enough for the widest thing an event puts on
 * the road — a gym is 96 across, a large Pokémon a little more — either side
 * of the spot it stands on.
 */
export const PROP_SPAN = 192;
const PROP_ANCHOR = PROP_SPAN / 2;

/**
 * How far right of the view a prop is still drawn: past that it has not come
 * into sight yet. As the field always had it.
 */
const PROP_AHEAD = 64;

/** The two speeds a sky's marks fall at, so the pool is never in step. */
const SKY_PACES = [0.82, 1.18];

/** How far snow drifts either way, in field pixels, and how long a sway takes. */
const SNOW_DRIFT = { px: 2, ms: 1400 };

/**
 * What the field hands over each frame.
 *
 * @typedef {Object} FieldView
 * @property {number} offset the world scroll, in field pixels
 * @property {string} hour the band of the day the standing things are lit for
 * @property {HTMLImageElement|null} background the road, graded for the hour
 * @property {HTMLImageElement|null} overlay a bridge over the lane, if any
 * @property {string|null} weather the sky the area is under
 * @property {number} elapsed the run's clock, for a still of the weather
 * @property {{key: string, x: number, draw: (context: CanvasRenderingContext2D, x: number) => void}|null} prop
 *   the event standing on the road: `x` where it stands on the view, `draw`
 *   drawing it at a given x, and `key` changing whenever its picture does
 * @property {{key: string, draw: (context: CanvasRenderingContext2D) => void}} actor
 *   the companion and whatever it holds up, in the view's own coordinates
 * @property {number} flash how white the road is washed, 0 to 1
 * @property {number} shut how far shut the screen is for a crossing, 0 to 1
 */

/** @returns {ReturnType<typeof buildLayers>} */
export function createFieldLayers() {
  return buildLayers();
}

function buildLayers() {
  const root = layer('div', 'field-layers');
  root.setAttribute('aria-hidden', 'true');

  const ground = strip();
  const prop = paintedLayer(PROP_SPAN);
  const flash = layer('div', 'field-flash');
  const actor = paintedLayer(FIELD_WIDTH);
  const bridge = strip();
  const sky = weatherLayer();
  const shutTop = layer('div', 'field-shut');
  const shutBottom = layer('div', 'field-shut field-shut-bottom');
  root.append(ground.node, prop.node, flash, actor.node, bridge.node, sky.node, shutTop, shutBottom);

  /** @type {FieldView|null} */
  let last = null;
  let shown = true;
  let flashShown = -1;
  let shutShown = -1;

  return {
    root,

    /** @param {boolean} value whether the field is in sight at all */
    setShown(value) {
      if (value === shown) return;
      shown = value;
      root.hidden = !value;
    },

    /**
     * Bring every layer up to the frame. Cheap when nothing has changed:
     * nothing is painted, and a layer that has not moved is not touched.
     *
     * @param {FieldView} view
     */
    sync(view) {
      last = view;
      const scroll = Math.round(view.offset);
      ground.show(view.background, scroll, '#101520');
      bridge.show(view.overlay, scroll, null);

      if (view.prop && view.prop.x < FIELD_WIDTH + PROP_AHEAD && view.prop.x > -PROP_ANCHOR) {
        const { draw, x } = view.prop;
        prop.paint(`${view.prop.key}|${view.hour}`, view.hour, (context) => draw(context, PROP_ANCHOR));
        prop.place(x - PROP_ANCHOR);
        prop.setShown(true);
      } else {
        prop.setShown(false);
      }

      actor.paint(`${view.actor.key}|${view.hour}`, view.hour, view.actor.draw);

      if (view.flash !== flashShown) {
        flashShown = view.flash;
        flash.style.opacity = String(view.flash);
      }

      sky.show(view.weather);
      sky.step(view.elapsed);

      // The dark the road changes behind, closing in from above and below.
      const reach = view.shut > 0 ? Math.ceil((VIEW_HEIGHT / 2) * Math.min(1, view.shut * 1.15)) : 0;
      if (reach !== shutShown) {
        shutShown = reach;
        shutTop.style.height = `${reach}px`;
        shutBottom.style.height = `${reach}px`;
      }
    },

    /**
     * The road as it stands, drawn onto a canvas the size of the view — for
     * the tools that photograph a part of the screen, which read pixels off
     * a canvas rather than the window.
     *
     * @param {CanvasRenderingContext2D} context
     */
    snapshot(context) {
      if (!last || !shown) return;
      const view = last;
      context.save();
      context.imageSmoothingEnabled = false;
      context.scale(FIELD_ZOOM, FIELD_ZOOM);
      ground.snapshot(context);
      prop.snapshot(context);
      if (view.flash > 0) {
        context.fillStyle = `rgba(255, 255, 255, ${view.flash})`;
        context.fillRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT);
      }
      actor.snapshot(context);
      bridge.snapshot(context);
      drawWeather(context, view.weather, view.elapsed);
      context.restore();
      if (shutShown > 0) {
        context.fillStyle = '#05070c';
        context.fillRect(0, 0, VIEW_WIDTH, shutShown);
        context.fillRect(0, VIEW_HEIGHT - shutShown, VIEW_WIDTH, shutShown);
      }
    },

    /** Take the layers off the page and stop the weather. */
    destroy() {
      sky.show(null);
      root.remove();
    },
  };
}

/**
 * @param {string} tag
 * @param {string} className
 */
function layer(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

/**
 * A strip of map — the road, or the bridge over it — long enough to slide a
 * whole map's width across the view, drawn once for each picture it is given
 * and then only moved.
 *
 * It is drawn at the view's pixels, twice the map's, as the road always was:
 * a picture scaled smoothly — the trailer's camera does — then softens as it
 * did, rather than from pixels half as fine.
 */
function strip() {
  const node = /** @type {HTMLCanvasElement} */ (layer('canvas', 'field-strip'));
  node.width = 0;
  node.height = 0;
  const context = /** @type {CanvasRenderingContext2D} */ (node.getContext('2d'));
  /** @type {HTMLImageElement|null} */
  let image = null;
  let width = 0;
  let shift = -1;

  return {
    node,

    /**
     * @param {HTMLImageElement|null} next
     * @param {number} scroll the world scroll, in whole field pixels
     * @param {string|null} fill what shows where the map does not reach
     */
    show(next, scroll, fill) {
      if (next !== image) {
        image = next;
        build(fill);
        shift = -1;
      }
      if (!image || !width) return;
      // Modulo can be negative for a negative scroll; normalised so the strip
      // always starts at or before the left edge.
      const at = ((scroll % width) + width) % width;
      if (at === shift) return;
      shift = at;
      node.style.transform = `translate3d(${-at * FIELD_ZOOM}px, 0, 0)`;
    },

    /** @param {CanvasRenderingContext2D} target in field pixels */
    snapshot(target) {
      if (image && width) target.drawImage(node, -shift, 0, node.width / FIELD_ZOOM, FIELD_HEIGHT);
    },
  };

  /** @param {string|null} fill */
  function build(fill) {
    if (!image || !image.naturalWidth) {
      width = 0;
      node.hidden = true;
      return;
    }
    width = image.naturalWidth;
    const height = image.naturalHeight;
    // Enough copies that a whole map's width of sliding leaves no gap.
    const copies = Math.ceil(FIELD_WIDTH / width) + 1;
    node.width = width * copies * FIELD_ZOOM;
    node.height = FIELD_HEIGHT * FIELD_ZOOM;
    node.style.width = `${node.width}px`;
    node.style.height = `${node.height}px`;
    // Resizing a canvas resets it, the scale and the smoothing with it.
    context.imageSmoothingEnabled = false;
    context.setTransform(FIELD_ZOOM, 0, 0, FIELD_ZOOM, 0, 0);
    context.clearRect(0, 0, width * copies, FIELD_HEIGHT);
    if (fill) {
      context.fillStyle = fill;
      context.fillRect(0, 0, width * copies, FIELD_HEIGHT);
    }
    // Anchored to the bottom, so the ground line stays put when a short map
    // contributes fewer rows than the field has.
    const top = FIELD_HEIGHT - height;
    for (let copy = 0; copy < copies; copy++) {
      const x = copy * width;
      context.drawImage(image, x, top, width, height);
      // A map shorter than the field leaves a gap overhead; its own top row
      // fills it, so the terrain carries on instead of ending at a hard edge.
      if (top > 0 && fill) context.drawImage(image, 0, 0, width, 1, x, 0, width, top);
    }
    node.hidden = false;
  }
}

/**
 * A layer of standing things, painted only when what is on it changes and lit
 * for the hour as it is. At the view's own pixels, since a Pokémon is drawn at
 * half the field's scale.
 *
 * @param {number} span how wide it is, in field pixels
 */
function paintedLayer(span) {
  const node = /** @type {HTMLCanvasElement} */ (layer('canvas', 'field-painted'));
  node.width = span * FIELD_ZOOM;
  node.height = FIELD_HEIGHT * FIELD_ZOOM;
  node.style.width = `${node.width}px`;
  node.style.height = `${node.height}px`;
  const context = /** @type {CanvasRenderingContext2D} */ (node.getContext('2d'));
  context.imageSmoothingEnabled = false;
  context.scale(FIELD_ZOOM, FIELD_ZOOM);
  let painted = '';
  let placed = 0;
  let visible = true;

  return {
    node,

    /**
     * @param {string} key the same key, the same picture
     * @param {string} hour
     * @param {(context: CanvasRenderingContext2D) => void} draw
     */
    paint(key, hour, draw) {
      if (key === painted) return;
      painted = key;
      context.clearRect(0, 0, span, FIELD_HEIGHT);
      context.save();
      draw(context);
      context.restore();
      light(context, hour, span, FIELD_HEIGHT);
    },

    /** @param {number} x where its left edge stands on the view, in field pixels */
    place(x) {
      if (x === placed) return;
      placed = x;
      node.style.transform = `translate3d(${x * FIELD_ZOOM}px, 0, 0)`;
    },

    /** @param {boolean} value */
    setShown(value) {
      if (value === visible) return;
      visible = value;
      node.hidden = !value;
    },

    /** @param {CanvasRenderingContext2D} target in field pixels */
    snapshot(target) {
      if (visible) target.drawImage(node, placed, 0, span, FIELD_HEIGHT);
    },
  };
}

/**
 * The sky over the road: the area's wash, and its marks as two sheets of one
 * repeating tile slid along at two speeds, so the pool never falls in step.
 */
function weatherLayer() {
  const node = layer('div', 'field-sky');
  node.hidden = true;
  /** @type {string|null} */
  let current = null;
  /**
   * Each sheet of marks, and how it moves: one repeat of its tile along the
   * way the sky blows every `period` milliseconds, from `from` to `to`.
   *
   * @type {Array<{node: HTMLElement, period: number, from: {x: number, y: number}, to: {x: number, y: number}, placed: string}>}
   */
  let sheets = [];
  /** The sheets' holder, which sways for snow. @type {HTMLElement|null} */
  let drift = null;
  let drifted = '';

  return {
    node,

    /** @param {string|null} weather */
    show(weather) {
      if (weather === current) return;
      current = weather;
      sheets = [];
      drift = null;
      drifted = '';
      node.replaceChildren();
      const sky = skyOf(weather);
      node.hidden = !sky;
      if (!sky) return;

      if (sky.wash) {
        const wash = layer('div', 'field-sky-wash');
        wash.style.background = sky.wash;
        node.append(wash);
      }
      if (sky.marks <= 0) return;

      const tile = weatherTile(sky);
      const count = marksPerTile(sky, tile);
      const holder = layer('div', 'field-sky-drift');
      node.append(holder);
      if (sky.length === 0) drift = holder;
      SKY_PACES.forEach((pace, seed) => {
        const marks = layer('div', 'field-sky-marks');
        marks.style.backgroundImage = `url(${tileImage(sky, tile, seed, Math.ceil(count / SKY_PACES.length))})`;
        marks.style.backgroundSize = `${tile.width * FIELD_ZOOM}px ${tile.height * FIELD_ZOOM}px`;
        marks.style.width = `${(FIELD_WIDTH + tile.across * tile.width) * FIELD_ZOOM}px`;
        marks.style.height = `${(FIELD_HEIGHT + tile.down * tile.height) * FIELD_ZOOM}px`;
        holder.append(marks);
        const leftward = sky.speed.x < 0;
        const fromX = leftward ? 0 : -tile.across * tile.width;
        sheets.push({
          node: marks,
          period: ((tile.down * tile.height) / (sky.speed.y * pace)) * 1000,
          from: { x: fromX, y: -tile.down * tile.height },
          to: { x: fromX + (leftward ? -1 : 1) * tile.across * tile.width, y: 0 },
          placed: '',
        });
      });
    },

    /**
     * Move the marks on to where they are at this moment, a whole field pixel
     * at a time.
     *
     * It is the game's own frames that move them, and only once a mark has come
     * a whole pixel, rather than an animation of the page's: that moved them a
     * fraction of a pixel at every refresh of the display and had the window
     * put together again each time, which cost as much as everything else on
     * the road together.
     *
     * @param {number} elapsed milliseconds, the run's clock
     */
    step(elapsed) {
      for (const sheet of sheets) {
        const along = (elapsed % sheet.period) / sheet.period;
        const x = Math.round(sheet.from.x + (sheet.to.x - sheet.from.x) * along);
        const y = Math.round(sheet.from.y + (sheet.to.y - sheet.from.y) * along);
        const placed = `translate3d(${x * FIELD_ZOOM}px, ${y * FIELD_ZOOM}px, 0)`;
        if (placed === sheet.placed) continue;
        sheet.placed = placed;
        sheet.node.style.transform = placed;
      }
      // Snow drifts from side to side as it comes down, a pixel at a time.
      if (drift) {
        const swing = (elapsed % (SNOW_DRIFT.ms * 2)) / SNOW_DRIFT.ms;
        const x = Math.round(-SNOW_DRIFT.px + 2 * SNOW_DRIFT.px * (swing <= 1 ? swing : 2 - swing));
        const next = `translate3d(${x * FIELD_ZOOM}px, 0, 0)`;
        if (next !== drifted) {
          drifted = next;
          drift.style.transform = next;
        }
      }
    },
  };
}

/**
 * One tile of a sky's marks, as a picture the page can repeat.
 *
 * @param {any} sky
 * @param {{width: number, height: number}} tile
 * @param {number} seed
 * @param {number} count
 */
function tileImage(sky, tile, seed, count) {
  const canvas = document.createElement('canvas');
  canvas.width = tile.width * FIELD_ZOOM;
  canvas.height = tile.height * FIELD_ZOOM;
  const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  context.scale(FIELD_ZOOM, FIELD_ZOOM);
  drawWeatherTile(context, sky, tile, seed + 1, count);
  return canvas.toDataURL('image/png');
}
