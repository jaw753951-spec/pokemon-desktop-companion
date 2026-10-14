/**
 * Drawing the travelling view: the map scrolling past and the companion
 * walking across it.
 *
 * The aim is the overworld of the handheld games rather than a character on a
 * backdrop, so four things are deliberate. The whole field is drawn at twice
 * size, which puts about fifteen tiles across the window — the framing a Game
 * Boy Advance actually had, instead of twice as much map at half the size. The
 * map fills that frame, because a letterboxed strip reads as scenery instead
 * of a place. The companion is its one picture, its Black and White sprite,
 * drawn at one density for the whole dex and at one scale here.
 * And its hop is driven by distance travelled rather than by the clock, so the
 * sprite is tied to the ground the way a stepped tile-grid sprite is — speed
 * up the walk and it hops faster, stop and it settles into its standing bob.
 */
import {
  FIELD_HEIGHT,
  FIELD_WIDTH,
  FIELD_ZOOM,
  HOLD_BOOST_GLIDE_MS,
  HOLD_BOOST_RAMP_MS,
} from '../../shared/constants.mjs';
/**
 * Where the companion's feet sit.
 *
 * Each area carries its own line — the pipeline picks the row whose blocks are
 * clear of scenery, so the companion walks down the path instead of through
 * the tree line — and this is the fallback until one is loaded.
 */
const DEFAULT_GROUND_Y = Math.round(FIELD_HEIGHT * 0.62);

let ground = DEFAULT_GROUND_Y;

/** The ground line the field is currently drawing on. */
export function groundY() {
  return ground;
}

/**
 * Put the ground line where the area wants it, in field coordinates.
 * @param {number|null|undefined} value
 */
export function setGroundY(value) {
  ground = Number.isFinite(value) ? Math.round(/** @type {number} */ (value)) : DEFAULT_GROUND_Y;
}

/**
 * How much larger than its own art an actor is drawn on the field: not at all.
 *
 * The overworld people sheets are built for the map's 16-pixel tile, and drawn
 * at the map's own size they stand in it as the cartridge stands them. They
 * used to be half again as big, which was drawn for the days a Pokémon walked
 * the road as a box icon and needed the help; next to the Pokémon's own sprite
 * a trainer at half again towered over it.
 *
 * This is the figure for the things that really are tile art: the props an
 * event puts on the road. A trainer is drawn larger (see {@link TRAINER_SCALE}). A Pokémon is sized by
 * {@link actorScale} instead — see there for why.
 */
export const ACTOR_SCALE = 1;

/**
 * How much larger than its own art a trainer waiting on the road is drawn:
 * half again. At the map's own size a trainer read as a speck beside the
 * Pokémon it was about to send out; half again is the step up that keeps
 * every art pixel a whole number of screen pixels — three, where a map pixel
 * is two — so the sheet stays crisp.
 */
export const TRAINER_SCALE = 1.5;

/**
 * How much larger than its own art a Pokémon is drawn on the field: half, for
 * every one of them, so each art pixel lands on one screen pixel of the
 * window's 480x270 where a map pixel lands on two.
 *
 * The field used to draw a copy of the art halved as pixel art, to keep its
 * pixels the map's size. A battle sprite is drawn with one-pixel detail — a
 * pupil, a highlight, an outline in the colour of what it outlines — and
 * halving it kept a quarter of its pixels: outlines broke off, eyes became
 * red blots and Pikachu lost its face. The sprite itself at half size is the
 * same size on the road and loses nothing. One scale for the whole dex, since
 * the art is already sized to the Pokémon.
 */
export const POKEMON_SCALE = 1 / FIELD_ZOOM;

/**
 * What to draw a Pokémon's field art at: {@link POKEMON_SCALE}, whoever it is.
 * Anything without art of its own is drawn at the scale the props use.
 *
 * @param {{width: number, height: number}|null|undefined} sprite
 * @param {{speciesId: number}|null|undefined} [pokemon]
 * @returns {number}
 */
export function actorScale(sprite, pokemon) {
  void pokemon;
  return sprite?.height ? POKEMON_SCALE : ACTOR_SCALE;
}

/** How tall a Pokémon without art is taken to be, for what is drawn over it. */
export const ACTOR_HEIGHT = 24;

/**
 * How tall that Pokémon actually comes out, which is what anything drawn over
 * its head — a carried berry, say — has to clear.
 *
 * @param {{width: number, height: number}|null|undefined} sprite
 * @param {{speciesId: number}|null|undefined} [pokemon]
 */
export function actorHeight(sprite, pokemon) {
  if (!sprite?.height) return ACTOR_HEIGHT;
  return Math.round(sprite.height * actorScale(sprite, pokemon));
}

/** Field pixels per second. About one tile every half-second. */
export const WALK_SPEED = 34;

/**
 * How far the hurry has come on after another frame, from 0 (the ordinary
 * pace) to 1 (all of it): up while the pointer is held, gliding down after.
 *
 * @param {number} level where it was
 * @param {boolean} held whether the pointer is down
 * @param {number} deltaMs
 */
export function nextBoost(level, held, deltaMs) {
  if (held) return Math.min(1, level + deltaMs / HOLD_BOOST_RAMP_MS);
  return Math.max(0, level - deltaMs / HOLD_BOOST_GLIDE_MS);
}

/**
 * The multiple of the ordinary pace a hurry this far on comes to, eased at
 * both ends so the change of speed has no corner in it.
 *
 * @param {number} level from {@link nextBoost}
 * @param {number} full the multiple at full hurry
 */
export function boostPace(level, full) {
  const t = Math.min(1, Math.max(0, level));
  return 1 + (full - 1) * t * t * (3 - 2 * t);
}

/** The companion holds this column while the world slides past it. */
export const COMPANION_X = Math.round(FIELD_WIDTH * 0.32);

/**
 * Distance covered per walk frame. The GBA moves a character one 16px tile per
 * two frames of its cycle, which is what this reproduces.
 */
export const STRIDE = 8;

/**
 * The four-beat walk: plant, step, plant, step. Each step lifts the picture a
 * pixel off the ground, which is how a Pokémon drawn in one picture reads as
 * walking without legs that move.
 *
 * @type {Array<{lift: number}>}
 */
const WALK_CYCLE = [{ lift: 0 }, { lift: 1 }, { lift: 0 }, { lift: 1 }];

/**
 * The bob a Pokémon makes standing where it is, in the pixels of whatever it
 * is drawn in — the field's, or a battle's — and milliseconds.
 *
 * Every Pokémon is one still picture, and one that holds perfectly still
 * reads as the game having frozen. It rises and falls on the spot the way a
 * companion gathering berries does: up only, since it cannot sink into the
 * ground, and by whole pixels of the space it stands in, so it steps as the
 * map and the battle do. The road, a battle and its tab all use the same one.
 */
const IDLE_BOB_PX = 2;
const IDLE_BOB_MS = 460;

/**
 * How far off the ground a standing Pokémon is this far into standing.
 *
 * @param {number} elapsed milliseconds
 * @returns {number} pixels
 */
export const idleBob = (elapsed) => Math.round(Math.abs(Math.sin((elapsed / IDLE_BOB_MS) * Math.PI)) * IDLE_BOB_PX);

/** The most an {@link idleBob} lifts, for the screens that leave room over the head. */
export const IDLE_BOB_HEIGHT = IDLE_BOB_PX;

/**
 * Run `draw` in field space: twice size, with pixels kept square.
 *
 * Everything inside works in the field's own 240x135 coordinates and comes out
 * at the window's 480x270, so a source pixel always lands on exactly four
 * screen pixels and nothing is ever drawn on a half-pixel.
 *
 * @param {CanvasRenderingContext2D} context
 * @param {(context: CanvasRenderingContext2D) => void} draw
 */
export function inFieldSpace(context, draw) {
  context.save();
  context.imageSmoothingEnabled = false;
  context.scale(FIELD_ZOOM, FIELD_ZOOM);
  draw(context);
  context.restore();
}

/**
 * @param {CanvasRenderingContext2D} context
 * @param {HTMLImageElement|null} background
 * @param {number} offset world scroll, in field pixels
 */
export function drawBackground(context, background, offset) {
  context.fillStyle = '#101520';
  context.fillRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT);
  if (!background) return;

  const width = background.naturalWidth;
  const height = background.naturalHeight;
  // Anchored to the bottom, so the ground line stays put when a short map
  // contributes fewer rows than the field has.
  const top = FIELD_HEIGHT - height;

  // Modulo can be negative for a negative offset; normalise so the first tile
  // always starts at or before the left edge.
  let start = -(((offset % width) + width) % width);

  while (start < FIELD_WIDTH) {
    const x = Math.round(start);
    context.drawImage(background, x, top, width, height);
    // A map shorter than the field leaves a gap overhead; its own top row
    // fills it, so the terrain carries on instead of ending at a hard edge.
    if (top > 0) context.drawImage(background, 0, 0, width, 1, x, 0, width, top);
    start += width;
  }
}

/**
 * Draw what the map puts over the people on it — a bridge overhead — tiled
 * exactly as the background under it is.
 *
 * @param {CanvasRenderingContext2D} context
 * @param {HTMLImageElement|null} overlay
 * @param {number} offset
 */
export function drawOverlay(context, overlay, offset) {
  if (!overlay) return;
  const width = overlay.naturalWidth;
  const height = overlay.naturalHeight;
  const top = FIELD_HEIGHT - height;
  let start = -(((offset % width) + width) % width);
  while (start < FIELD_WIDTH) {
    context.drawImage(overlay, Math.round(start), top, width, height);
    start += width;
  }
}

/**
 * How far either side of a bridge an event is kept away, in field pixels.
 *
 * A trainer half under the deck, or a Pokémon Center with a bridge through
 * its roof, is not a picture the map was ever meant to show.
 */
export const OVERPASS_MARGIN = 40;

/**
 * How far either side of a roof a prop that would vanish behind it is kept.
 *
 * A roof the lane runs behind hides only the lane's own block — the feet of
 * whatever stands there — so it holds no event back. A ball, or a Pokémon no
 * taller than that block, would be hidden whole, and is moved on past it.
 */
export const ROOF_MARGIN = 4;

/** How much of whatever stands on the lane a roof's edge hides, in field pixels. */
export const ROOF_COVER = 16;

/**
 * Whether a stretch of road runs under, or too close to, a bridge: something
 * the map draws over the whole of whoever is on the lane.
 *
 * @param {{width: number, covered?: Array<[number, number, string?]>}|null|undefined} area
 * @param {[number, number]} ground strip coordinates before wrapping, as
 *   `eventGround` gives them
 * @param {number} [margin]
 */
export function nearOverpass(area, ground, margin = OVERPASS_MARGIN) {
  return nearSpans(area, ground, margin, (kind) => kind !== 'roof');
}

/**
 * Whether a stretch of road runs behind a roof's edge, which hides the lane's
 * own block and nothing above it.
 *
 * @param {{width: number, covered?: Array<[number, number, string?]>}|null|undefined} area
 * @param {[number, number]} ground
 * @param {number} [margin]
 */
export function behindRoof(area, ground, margin = ROOF_MARGIN) {
  return nearSpans(area, ground, margin, (kind) => kind === 'roof');
}

/**
 * @param {{width: number, covered?: Array<[number, number, string?]>}|null|undefined} area
 * @param {[number, number]} ground
 * @param {number} margin
 * @param {(kind: string|undefined) => boolean} counts which spans to look at
 */
function nearSpans(area, [from, to], margin, counts) {
  const spans = area?.covered;
  if (!spans?.length || !area.width) return false;
  const width = area.width;
  // Each span stands once per repeat of the strip; the stretch is compared
  // with the copies either side of it as well as its own.
  const base = Math.floor(from / width) * width;
  for (const shift of [base - width, base, base + width]) {
    for (const [start, end, kind] of spans) {
      if (!counts(kind)) continue;
      if (from < shift + end + margin && to > shift + start - margin) return true;
    }
  }
  return false;
}

/**
 * Where a swimming trainer can be met: whether there is water beside the lane
 * all the way across a stretch of it, and if so how far down from the lane it
 * lies — a row in front, a row behind (negative), or two.
 *
 * @param {{width: number, water?: Array<[number, number, number?]>}|null|undefined} area
 * @param {number} x the middle of the stretch, strip coordinates before wrapping
 * @param {number} half how far either side of it must be water
 * @returns {number|null} the drop in field pixels, or null for dry ground
 */
export function waterDrop(area, x, half) {
  const spans = area?.water;
  if (!spans?.length || !area.width) return null;
  const at = ((x % area.width) + area.width) % area.width;
  // The stretch may straddle the wrap, so each span is tried once a strip to
  // either side as well.
  for (const shift of [-area.width, 0, area.width]) {
    for (const [start, end, drop] of spans) {
      if (at - half >= start + shift && at + half <= end + shift) return drop ?? WATER_ROW;
    }
  }
  return null;
}

/** One block of the map, in field pixels: the row in front of the lane. */
const WATER_ROW = 16;

/**
 * A soft ellipse under a sprite, which grounds it against the background.
 * @param {CanvasRenderingContext2D} context
 * @param {number} x
 * @param {number} y
 * @param {number} width
 */
export function drawShadow(context, x, y, width) {
  context.save();
  // Relative to whatever the sprite is drawn at, so a companion fading into
  // a doorway takes its shadow with it.
  context.globalAlpha *= 0.25;
  context.fillStyle = '#000';
  context.beginPath();
  context.ellipse(x, y, Math.max(5, width * 0.4), Math.max(2, width * 0.15), 0, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

/**
 * Which beat of the walk the companion is on after travelling this far.
 *
 * @param {number} distance field pixels covered
 * @returns {{lift: number}}
 */
export function walkFrame(distance) {
  const step = Math.floor(distance / STRIDE) % WALK_CYCLE.length;
  return WALK_CYCLE[(step + WALK_CYCLE.length) % WALK_CYCLE.length];
}

/**
 * Draw a Pokémon on the road, facing the way it is going.
 *
 * It is one still picture, moved rather than animated: it hops a pixel on
 * each step while it walks, by distance, and bobs on the spot by the clock
 * while it stands. A companion lifted by something it is busy with — picking
 * berries, stepping through a door — takes that lift instead of its bob.
 *
 * Art facing the other way is mirrored about its own centre column.
 *
 * @param {CanvasRenderingContext2D} context
 * @param {import('../core/assets.mjs').Sprite} sprite
 * @param {{
 *   x: number,
 *   y: number,
 *   distance: number,
 *   moving: boolean,
 *   facing?: 'left'|'right',
 *   scale?: number,
 *   lift?: number|null,
 *   time?: number,
 * }} options `lift` raises the sprite off the ground without its shadow, for
 *   a companion busy with something where it stands — taken as it is, nought
 *   included; null (or left out) when it is not busy and bobs on its own.
 *   `time` is the clock a standing bob keeps
 */
export function drawWalker(
  context,
  sprite,
  { x, y, distance, moving, facing = 'right', scale = POKEMON_SCALE, lift = null, time = 0 },
) {
  const raised = lift ?? 0;
  const hop = moving ? walkFrame(distance).lift : lift !== null ? 0 : idleBob(time);
  const flip = (sprite.facing ?? 'left') !== facing;

  // On whole screen pixels, which at half scale are half-pixels of the
  // field's own space: a sprite rounded to whole field pixels there would be
  // squeezed a pixel on every odd side, and one left on a stray fraction
  // lands on a half pixel at one edge and a whole one at the other, which the
  // hop then makes shimmer.
  const snap = (value) => Math.round(value * FIELD_ZOOM) / FIELD_ZOOM;
  const width = snap(sprite.width * scale);
  const height = snap(sprite.height * scale);
  // The shadow stays on the ground whatever the sprite is doing above it,
  // which is what makes a bob read as leaving the ground rather than as the
  // whole thing sliding up the screen.
  drawShadow(context, x, y, width);

  const left = snap(x - width / 2);
  const top = snap(y - height - hop - raised);

  context.save();
  if (flip) {
    // Mirror about the sprite's own centre column, so flipping does not move
    // it off the spot it is standing on.
    context.translate(left * 2 + width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(sprite.image, 0, 0, sprite.width, sprite.height, left, top, width, height);
  context.restore();
}

/**
 * The dust a step kicks up, drawn behind the companion on the beats its feet
 * land. Small and brief — it is there to sell contact with the ground.
 *
 * @param {CanvasRenderingContext2D} context
 * @param {{x: number, y: number, distance: number, moving: boolean}} options
 */
export function drawStepDust(context, { x, y, distance, moving }) {
  if (!moving) return;

  const progress = (distance % STRIDE) / STRIDE;
  if (progress > 0.55) return;

  const fade = 1 - progress / 0.55;
  context.save();
  context.globalAlpha *= 0.28 * fade;
  context.fillStyle = '#e8e2cf';
  const spread = 3 + (1 - fade) * 4;
  context.fillRect(Math.round(x - 9 - spread), Math.round(y - 1), 2, 1);
  context.fillRect(Math.round(x - 12 - spread), Math.round(y - 3), 1, 1);
  context.restore();
}
