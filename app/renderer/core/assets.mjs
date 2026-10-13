/**
 * Image and audio loading.
 *
 * Everything is fetched through the `pdc://` protocol and cached by URL, so a
 * sprite is decoded once however many times it appears. Sprite strips arrive
 * as one wide image plus a frame count, and `Sprite` turns that into something
 * the renderer can draw a single frame of.
 */
import { url } from './bridge.mjs';

/** @type {Map<string, Promise<HTMLImageElement>>} */
const images = new Map();

/**
 * @param {string} path relative to the assets root
 * @returns {Promise<HTMLImageElement>}
 */
export function loadImage(path) {
  const key = url('assets', path);
  let pending = images.get(key);
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Failed to load image ${path}`));
      image.src = key;
    });
    images.set(key, pending);
  }
  return pending;
}

/** Drop a decoded image so a long session does not hold the whole dex in memory. */
export function forgetImage(path) {
  images.delete(url('assets', path));
}

/**
 * Pictures shown as `<img>` elements, each fetched once and kept in the
 * renderer as an object URL.
 *
 * An `<img>` pointed at `pdc://` asks the main process for the file every time
 * a screen is built with it, and the box is built with every Pokémon in it.
 * Kept here, a picture shown before comes back without leaving the renderer —
 * reopening the bag, sorting the box — and two spaces holding the same
 * species share the one copy. They are small and never let go: the whole dex
 * of them is a few megabytes.
 *
 * @type {Map<string, Promise<string>>}
 */
const pictureUrls = new Map();

/** The ones already fetched, for a screen to show at once rather than wait a tick. @type {Map<string, string>} */
const readyPictureUrls = new Map();

/**
 * @param {string} path relative to the assets root
 * @returns {Promise<string>} a URL the picture can be shown from
 */
export function loadPictureUrl(path) {
  let pending = pictureUrls.get(path);
  if (!pending) {
    pending = fetch(url('assets', path))
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to load picture ${path} (${response.status})`);
        return response.blob();
      })
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        readyPictureUrls.set(path, objectUrl);
        return objectUrl;
      });
    // A failure is not remembered, so the next screen tries again.
    pending.catch(() => pictureUrls.delete(path));
    pictureUrls.set(path, pending);
  }
  return pending;
}

/**
 * The URL of a picture {@link loadPictureUrl} has already fetched, or null.
 * @param {string} path
 * @returns {string|null}
 */
export function readyPictureUrl(path) {
  return readyPictureUrls.get(path) ?? null;
}

/**
 * One animation: a horizontal strip of equal-width frames.
 */
export class Sprite {
  /**
   * @param {HTMLImageElement} image
   * @param {{width: number, height: number, frames: number, delay: number, durations?: number[], facing?: 'left'|'right'}} meta
   *   `durations` times each frame on its own, for a strip that does not hold
   *   them all equally; `facing` is which way the art looks
   */
  constructor(image, meta) {
    this.image = image;
    this.width = meta.width;
    this.height = meta.height;
    this.frames = Math.max(1, meta.frames);
    this.delay = Math.max(16, meta.delay || 120);
    /** @type {number[]|null} */
    this.durations =
      Array.isArray(meta.durations) && meta.durations.length === this.frames
        ? meta.durations.map((value) => Math.max(16, value))
        : null;
    /** @type {'left'|'right'} */
    this.facing = meta.facing ?? 'left';
  }

  /** Total loop length in milliseconds. */
  get duration() {
    return this.durations ? this.durations.reduce((sum, value) => sum + value, 0) : this.frames * this.delay;
  }

  /**
   * @param {number} elapsedMs
   * @returns {number} the frame index to show
   */
  frameAt(elapsedMs) {
    if (!this.durations) return Math.floor(elapsedMs / this.delay) % this.frames;
    let into = ((elapsedMs % this.duration) + this.duration) % this.duration;
    for (let index = 0; index < this.frames; index++) {
      into -= this.durations[index];
      if (into < 0) return index;
    }
    return this.frames - 1;
  }

  /**
   * Draw one frame with its bottom-centre at (x, y), which is where a sprite's
   * feet belong on the ground line.
   *
   * @param {CanvasRenderingContext2D} context
   * @param {number} x
   * @param {number} y
   * @param {{frame?: number, flip?: boolean, scale?: number, alpha?: number}} [options]
   */
  draw(context, x, y, options = {}) {
    const { frame = 0, flip = false, scale = 1, alpha = 1 } = options;
    const width = this.width * scale;
    const height = this.height * scale;
    const left = Math.round(x - width / 2);
    const top = Math.round(y - height);

    context.save();
    if (alpha !== 1) context.globalAlpha = alpha;
    if (flip) {
      context.translate(left + width, top);
      context.scale(-1, 1);
      context.drawImage(this.image, frame * this.width, 0, this.width, this.height, 0, 0, width, height);
    } else {
      context.drawImage(this.image, frame * this.width, 0, this.width, this.height, left, top, width, height);
    }
    context.restore();
  }
}

/**
 * @param {string} path
 * @param {{width: number, height: number, frames: number, delay: number, durations?: number[], facing?: 'left'|'right'}} meta
 * @returns {Promise<Sprite>}
 */
export async function loadSprite(path, meta) {
  return new Sprite(await loadImage(path), meta);
}

/**
 * A still image, wrapped so it can be drawn the same way as a sprite.
 * @param {string} path
 * @returns {Promise<Sprite>}
 */
export async function loadStill(path) {
  const image = await loadImage(path);
  return new Sprite(image, { width: image.naturalWidth, height: image.naturalHeight, frames: 1, delay: 1000 });
}

/**
 * Fetch and decode an audio file into a buffer the audio engine can play.
 * @param {AudioContext} context
 * @param {string} path
 * @returns {Promise<AudioBuffer>}
 */
export async function loadAudioBuffer(context, path) {
  const response = await fetch(url('assets', path));
  if (!response.ok) throw new Error(`Failed to load audio ${path}`);
  return context.decodeAudioData(await response.arrayBuffer());
}
