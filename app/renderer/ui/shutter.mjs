/**
 * The dark closing over the picture from top and bottom and opening again —
 * the way into a battle — for leaving one screen for another the same way.
 */
import { el } from '../core/dom.mjs';

/** How long it takes to close, stays shut, and takes to open, in ms. */
export const SHUTTER_MS = { close: 320, hold: 140, open: 380 };

const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

/**
 * Close the shutter, call `onShut` behind it — where the screen changes — and
 * open it again on whatever is there now.
 *
 * @param {{onShut: () => void}} options
 */
export function shutter({ onShut }) {
  const stage = /** @type {HTMLElement} */ (document.getElementById('stage'));
  const top = el('div.shutter.top');
  const bottom = el('div.shutter.bottom');
  stage.append(top, bottom);
  const { close, hold, open } = SHUTTER_MS;
  const started = performance.now();
  let shut = false;
  const behind = () => {
    if (shut) return;
    shut = true;
    onShut();
  };

  const frame = () => {
    const t = performance.now() - started;
    let amount = 1;
    if (t < close) {
      amount = ease(t / close);
    } else if (t >= close + hold) {
      behind();
      amount = 1 - ease(Math.min(1, (t - close - hold) / open));
    } else {
      behind();
    }
    // A shade past halfway each, so no line of the picture shows between them.
    top.style.height = bottom.style.height = `${amount * 50.5}%`;
    if (t < close + hold + open) {
      requestAnimationFrame(frame);
    } else {
      top.remove();
      bottom.remove();
    }
  };
  requestAnimationFrame(frame);
}
