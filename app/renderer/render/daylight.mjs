/**
 * The light of the hour, laid over the things the pipeline could not grade.
 *
 * Area backgrounds are rendered five times over and graded at build time, so
 * a route is properly blue at night. Everything else on the map — the Pokémon
 * Center, the berry trees, the trainers, the companion itself — is one
 * picture shared by every hour, so at midnight a building stood in full
 * daylight on a moonlit road.
 *
 * Grading each of those five times over would be five times the download for
 * art that is a few kilobytes and rarely on screen. So they are lit here
 * instead: drawn on layers of their own and washed with the hour's colour,
 * which is an approximation of the pipeline's own grade and costs one fill.
 */

/**
 * The wash for each band.
 *
 * These are not guesses. The pipeline grades a background by multiplying each
 * channel and adding to it — `out = m·c + k`, the `TIME_GRADES` table in
 * `dev/tools/lib/image.mjs` — and a single fill can only do `out = (1-a)·c +
 * a·t`. The two agree on a straight line through the whole range of a channel
 * if `a` and `t` are chosen for it, so they were: the alpha was searched and
 * the colour solved by least squares against the pipeline's own numbers over
 * every value a pixel can hold. The fits land within a few units of 255 —
 * night, the harshest of them, inside eleven.
 *
 * `day` is nothing at all: the unmodified palette is the daytime one, and the
 * fit agrees, coming out as a neutral grey at two per cent.
 *
 * @type {Record<string, {colour: string, strength: number}|null>}
 */
export const DAYLIGHT = {
  dawn: { colour: 'rgb(255, 140, 255)', strength: 0.07 },
  day: null,
  afternoon: { colour: 'rgb(251, 123, 0)', strength: 0.115 },
  dusk: { colour: 'rgb(190, 0, 0)', strength: 0.25 },
  night: { colour: 'rgb(0, 2, 114)', strength: 0.455 },
};

/**
 * Light what has just been drawn on a layer of standing things.
 *
 * `source-atop` is what keeps the wash inside the pixels that were drawn: the
 * road behind them has already been graded by the pipeline and must not be
 * graded twice. Each of the field's layers of standing things — the props,
 * the companion — is lit as it is painted, which is only when it changes.
 *
 * @param {CanvasRenderingContext2D} context the layer, in its own units
 * @param {string} time one of the five bands
 * @param {number} width how much of the layer to light
 * @param {number} height
 */
export function light(context, time, width, height) {
  const wash = DAYLIGHT[time];
  if (!wash) return;
  context.save();
  context.globalCompositeOperation = 'source-atop';
  context.globalAlpha = wash.strength;
  context.fillStyle = wash.colour;
  context.fillRect(0, 0, width, height);
  context.restore();
}
