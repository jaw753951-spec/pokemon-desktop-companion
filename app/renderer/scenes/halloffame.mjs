/**
 * The Hall of Fame: what becoming champion looks like.
 *
 * As Emerald plays it, cut down to the one Pokémon this game travels with: the
 * room's machine flashes white, the screen opens on the mint, striped record
 * the cartridge keeps, and the champion slides in to stand in the middle of it
 * while its entry — number, name and level — comes up underneath. Then
 * "Welcome to the HALL OF FAME!" and the confetti, as the cartridge closes on.
 * The crown the bag keeps for a champion drops into the entry last, so the
 * badge is seen being won rather than turning up in the key pocket afterwards.
 *
 * Nothing waits on the player, as with the evolution screen: the companion is
 * often left alone, so the ceremony plays through and hands back by itself,
 * and a press only moves it on.
 */
import { FIELD_HEIGHT, FIELD_WIDTH, VIEW_HEIGHT, VIEW_WIDTH } from '../../shared/constants.mjs';
import { loadSprite } from '../core/assets.mjs';
import { gameData, speciesOf } from '../core/data.mjs';
import { el, shinyMark } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { levelOf, nameOf } from '../engine/pokemon.mjs';
import { BATTLE_SCALE, Battler, battlerArt, mirrorFor } from '../render/battler.mjs';
import { inFieldSpace } from '../render/field.mjs';

/**
 * When each part of the ceremony begins, in milliseconds from the start.
 *
 * The flash first, then the champion sliding in, its entry, the welcome and
 * the confetti, and the crown; `end` is when it hands back, after a fade to
 * white as long as {@link FADE_MS}.
 */
export const FAME_CUES = { enter: 450, plate: 1250, welcome: 2200, crown: 3700, end: 8200 };

/** How long the champion takes to slide in from the right. */
const SLIDE_MS = 700;

/** The white the ceremony opens out of, and the white it closes into. */
const FLASH_MS = 450;
const FADE_MS = 600;

/** How long the entry and the welcome take to come up, and the crown to drop in. */
const RISE_MS = 260;
const CROWN_DROP_MS = 420;

/** How far above its place the crown drops from, in view pixels. */
const CROWN_DROP_PX = 150;

/** Where the champion stands, in field pixels: the middle, feet on the glow. */
const SPOT = { x: Math.round(FIELD_WIDTH / 2), y: Math.round(FIELD_HEIGHT * 0.7) };

/** The record's mint and its paler stripes, as Emerald draws them. */
const MINT = '#9edcbf';
const STRIPE = '#b4e6cf';
const STRIPE_WIDTH = 14;
/** How fast the stripes drift, in view pixels a second. */
const STRIPE_DRIFT = 12;

/** Emerald's confetti colours. */
const CONFETTI = ['#f86058', '#f8d030', '#58b0f8', '#78e070', '#f890d8', '#ffffff'];
/** How many pieces fall at once, at most. */
const CONFETTI_COUNT = 70;

/**
 * Which part of the ceremony a moment falls in.
 *
 * @param {number} elapsedMs
 * @returns {'flash'|'enter'|'plate'|'welcome'|'crown'|'fade'|'done'}
 */
export function famePhase(elapsedMs) {
  if (elapsedMs >= FAME_CUES.end) return 'done';
  if (elapsedMs >= FAME_CUES.end - FADE_MS) return 'fade';
  if (elapsedMs >= FAME_CUES.crown) return 'crown';
  if (elapsedMs >= FAME_CUES.welcome) return 'welcome';
  if (elapsedMs >= FAME_CUES.plate) return 'plate';
  if (elapsedMs >= FAME_CUES.enter) return 'enter';
  return 'flash';
}

/**
 * The cue a press moves on to: the next one after this moment, so a press
 * skips what is still coming in rather than the whole ceremony at once.
 *
 * @param {number} elapsedMs
 */
export function nextFameCue(elapsedMs) {
  const order = [FAME_CUES.enter, FAME_CUES.plate, FAME_CUES.welcome, FAME_CUES.crown, FAME_CUES.end - FADE_MS];
  return order.find((at) => at > elapsedMs) ?? FAME_CUES.end;
}

/**
 * @param {{
 *   pokemon: import('../engine/pokemon.mjs').Pokemon,
 *   league: {name?: {ko: string, en: string}, region?: string},
 *   onFinish: () => void,
 * }} options
 * @returns {import('../core/app.mjs').Scene}
 */
export function hallOfFameScene({ pokemon, league, onFinish }) {
  let elapsed = 0;
  let finished = false;
  /** @type {Battler|null} */
  let champion = null;
  let landed = false;
  let crowned = false;
  /** @type {Array<{x: number, y: number, fall: number, sway: number, phase: number, color: string, size: number}>} */
  const confetti = [];

  const species = speciesOf(pokemon.speciesId);
  const entry = el('div.fame-entry', {}, [
    el('span.fame-number', { text: `No.${String(species?.id ?? pokemon.speciesId).padStart(3, '0')}` }),
    el('span.fame-name', {}, [nameOf(pokemon), shinyMark(pokemon)]),
    el('span.fame-level', { text: `Lv.${levelOf(pokemon)}` }),
  ]);
  const rays = el('i.fame-rays');
  const crown = /** @type {HTMLImageElement} */ (el('img.fame-crown', { src: crownImage().toDataURL(), alt: '' }));
  const title = el('div.fame-title', {}, [
    el('span.fame-crown-slot', {}, [rays, crown]),
    el('span.fame-lines', {}, [
      el('span.fame-league', { text: t('fame.champion', { league: localized(league.name, league.region ?? '') }) }),
      el('span.fame-congrats', { text: t('fame.congrats') }),
    ]),
  ]);
  const plate = el('div.fame-plate', {}, [entry]);
  const welcome = el('div.fame-welcome', { text: t('fame.welcome') });

  /** @param {import('../core/app.mjs').App} app */
  function press(app) {
    if (finished) return;
    app.audio.blip('select');
    elapsed = Math.max(elapsed, nextFameCue(elapsed));
  }

  function finish() {
    if (finished) return;
    finished = true;
    onFinish();
  }

  return {
    mount(app) {
      const art = battlerArt(pokemon);
      if (art) {
        void loadSprite(art.path, art.meta).then((sprite) => {
          champion = new Battler({
            sprite,
            x: FIELD_WIDTH + 60,
            y: SPOT.y,
            facing: -1,
            scale: BATTLE_SCALE,
            flip: mirrorFor(sprite, 'left'),
          });
        });
      }
      void app.audio.playMusic(gameData().bgm?.cues?.hallOfFame ?? null);
      setRise(plate, 0);
      setRise(welcome, 0);
      return el('div.screen.fame-screen', { onClick: () => press(app) }, [welcome, plate]);
    },

    update(deltaMs, app) {
      if (finished) return;
      elapsed += deltaMs;
      champion?.update(deltaMs);

      if (champion) {
        const slide = Math.min(1, Math.max(0, (elapsed - FAME_CUES.enter) / SLIDE_MS));
        const eased = 1 - (1 - slide) ** 3;
        champion.x = Math.round(FIELD_WIDTH + 60 + (SPOT.x - FIELD_WIDTH - 60) * eased);
        if (slide >= 1 && !landed) {
          landed = true;
          app.audio.playCry(pokemon.speciesId);
        }
      }

      // The entry and the welcome rise into place, a frame at a time like the
      // rest of the screen rather than on a transition of their own.
      setRise(plate, (elapsed - FAME_CUES.plate) / RISE_MS);
      setRise(welcome, (elapsed - FAME_CUES.welcome) / RISE_MS, -1);

      if (elapsed >= FAME_CUES.crown && plate.firstChild !== title) {
        plate.replaceChildren(title);
        plate.classList.add('champion');
      }
      if (elapsed >= FAME_CUES.crown) {
        const since = elapsed - FAME_CUES.crown;
        const drop = Math.min(1, since / CROWN_DROP_MS);
        // Falls in, and bounces once as it lands.
        const bounce = drop < 1 ? -(1 - drop * drop) * CROWN_DROP_PX : -Math.sin(Math.min(1, (since - CROWN_DROP_MS) / 220) * Math.PI) * 5;
        crown.style.transform = `translateY(${Math.round(bounce)}px)`;
        const glow = Math.min(1, Math.max(0, (since - CROWN_DROP_MS) / 300));
        rays.style.opacity = String(glow);
        rays.style.transform = `rotate(${Math.round((since / 1000) * 40)}deg)`;
        if (!crowned && drop >= 1) {
          crowned = true;
          champion?.setPose('win');
          app.audio.blip('shiny');
        }
      }

      if (elapsed >= FAME_CUES.welcome) updateConfetti(deltaMs);

      if (famePhase(elapsed) === 'done') finish();
    },

    render(context) {
      drawRecord(context, elapsed);

      inFieldSpace(context, (field) => {
        drawGlow(field, Math.min(1, Math.max(0, (elapsed - FAME_CUES.enter) / SLIDE_MS)));
        champion?.draw(field);
        drawConfetti(field);
      });

      const flash = elapsed < FLASH_MS ? 1 - elapsed / FLASH_MS : 0;
      const fade = Math.max(0, (elapsed - (FAME_CUES.end - FADE_MS)) / FADE_MS);
      const white = Math.max(flash, Math.min(1, fade));
      if (white > 0) {
        context.save();
        context.globalAlpha = white;
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
        context.restore();
      }
    },
  };

  /** @param {number} deltaMs */
  function updateConfetti(deltaMs) {
    // A few pieces at a time from above the top edge, so the fall is a steady
    // shower rather than one sheet of paper coming down together.
    const wanted = Math.min(CONFETTI_COUNT, Math.floor((elapsed - FAME_CUES.welcome) / 30));
    while (confetti.length < wanted) confetti.push(newPiece(-4 - Math.random() * 30));
    for (const piece of confetti) {
      piece.y += (piece.fall * deltaMs) / 1000;
      piece.phase += deltaMs / 1000;
      if (piece.y > FIELD_HEIGHT + 4) Object.assign(piece, newPiece(-4));
    }
  }

  /** @param {CanvasRenderingContext2D} context field space */
  function drawConfetti(context) {
    for (const piece of confetti) {
      const x = Math.round(piece.x + Math.sin(piece.phase * 3 + piece.sway) * 3);
      // Turning over as it falls: drawn thin on every other beat.
      const flat = Math.sin(piece.phase * 6 + piece.sway) > 0;
      context.fillStyle = piece.color;
      context.fillRect(x, Math.round(piece.y), piece.size, flat ? 1 : piece.size);
    }
  }
}

/**
 * The light the champion stands in.
 *
 * @param {CanvasRenderingContext2D} context field space
 * @param {number} strength
 */
function drawGlow(context, strength) {
  if (strength <= 0) return;
  context.save();
  context.globalAlpha = 0.55 * strength;
  context.fillStyle = '#ffffff';
  context.beginPath();
  context.ellipse(SPOT.x, SPOT.y - 1, 40, 8, 0, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

/**
 * The mint record the champion is entered on, its stripes drifting.
 *
 * @param {CanvasRenderingContext2D} context view space
 * @param {number} elapsedMs
 */
function drawRecord(context, elapsedMs) {
  context.fillStyle = MINT;
  context.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
  context.save();
  context.fillStyle = STRIPE;
  const shift = ((elapsedMs / 1000) * STRIPE_DRIFT) % (STRIPE_WIDTH * 2);
  for (let x = -VIEW_HEIGHT - STRIPE_WIDTH * 2; x < VIEW_WIDTH + STRIPE_WIDTH * 2; x += STRIPE_WIDTH * 2) {
    const left = Math.round(x - shift);
    context.beginPath();
    context.moveTo(left, 0);
    context.lineTo(left + STRIPE_WIDTH, 0);
    context.lineTo(left + STRIPE_WIDTH + VIEW_HEIGHT, VIEW_HEIGHT);
    context.lineTo(left + VIEW_HEIGHT, VIEW_HEIGHT);
    context.closePath();
    context.fill();
  }
  context.restore();
}

/**
 * Slide a panel into place from below (or above), fading it in.
 *
 * @param {HTMLElement} node
 * @param {number} progress 0 before it starts, 1 once it is up
 * @param {1|-1} [from] below, or above
 */
function setRise(node, progress, from = 1) {
  const step = Math.min(1, Math.max(0, progress));
  const eased = 1 - (1 - step) ** 2;
  node.style.opacity = String(step);
  node.style.transform = `translateY(${Math.round((1 - eased) * 16 * from)}px)`;
}

/**
 * A confetti piece somewhere along the top edge.
 *
 * @param {number} y
 */
function newPiece(y) {
  return {
    x: Math.random() * FIELD_WIDTH,
    y,
    fall: 28 + Math.random() * 26,
    sway: Math.random() * Math.PI * 2,
    phase: 0,
    color: CONFETTI[Math.floor(Math.random() * CONFETTI.length)],
    size: Math.random() < 0.5 ? 2 : 1,
  };
}

/**
 * The crown the champion is given, as pixel art: the bag's crown badge (the
 * same outline, `M1 13V4l4 4 3-6 3 6 4-4v9z` on a sixteen-pixel grid) cut on
 * the grid, rimmed, lit from the top left and set with three stones.
 */
function crownImage() {
  const size = 16;
  const outline = [[1, 13], [1, 4], [5, 8], [8, 2], [11, 8], [15, 4], [15, 13]];
  const inside = (x, y) => {
    let hit = false;
    for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
      const [xi, yi] = outline[i];
      const [xj, yj] = outline[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  const filled = (x, y) => x >= 0 && y >= 0 && x < size && y < size && inside(x + 0.5, y + 0.5);

  const canvas = document.createElement('canvas');
  canvas.width = size + 2;
  canvas.height = size + 2;
  const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  for (let y = -1; y <= size; y++) {
    for (let x = -1; x <= size; x++) {
      let colour = null;
      if (filled(x, y)) {
        if (y >= 11) colour = '#c8901a';
        else if (!filled(x - 1, y - 1) || !filled(x, y - 1)) colour = '#fff3a0';
        else colour = '#f6c630';
      } else if (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1)) {
        colour = '#5a4000';
      }
      if (!colour) continue;
      context.fillStyle = colour;
      context.fillRect(x + 1, y + 1, 1, 1);
    }
  }
  // Three stones along the band.
  for (const [x, colour] of /** @type {Array<[number, string]>} */ ([[4, '#e84848'], [8, '#4890f0'], [12, '#e84848']])) {
    context.fillStyle = colour;
    context.fillRect(x, 10, 2, 2);
  }
  return canvas;
}
