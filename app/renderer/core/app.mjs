/**
 * The application shell: services every screen shares, and the scene stack.
 *
 * A scene owns one screen. It may put DOM into the overlay, draw on the canvas,
 * or both — the title screen is pure DOM, the field is mostly canvas. Scenes
 * are pushed and popped rather than swapped so a menu can return to whatever
 * was underneath it.
 */
import { snapZoom, VIEW_HEIGHT, VIEW_WIDTH } from '../../shared/constants.mjs';
import { clear, el } from './dom.mjs';
import { settings as settingsApi, windowControl } from './bridge.mjs';
import { setLanguage } from './i18n.mjs';

/**
 * A screen. Every hook is optional: a DOM-only scene needs just `mount`.
 * @typedef {Object} Scene
 * @property {(app: App) => (HTMLElement|null|void)} [mount]
 * @property {(app: App) => void} [unmount]
 * @property {(deltaMs: number, app: App) => void} [update]
 * @property {(context: CanvasRenderingContext2D, app: App) => void} [render]
 *   draw on the shared canvas, every frame the scene is in sight
 * @property {(app: App) => void} [present] bring the scene's own layers up
 *   to the frame, every frame it is in sight, without drawing on the canvas
 * @property {(shown: boolean) => void} [setShown] whether the scene is in
 *   sight at all, told every frame
 * @property {(context: CanvasRenderingContext2D) => void} [snapshot] draw the
 *   scene's own layers onto a canvas the size of the view (see `App.snapshot`)
 * @property {boolean} [keepBelow] draw the scene beneath this one as well
 * @property {boolean} [keepBelowRunning] let the scene beneath this one go on
 *   updating: a menu opened over the road should not stop the walk
 * @property {(paused: boolean) => void} [setPaused] halt the scene's own motion
 *   while something else, such as a field event, plays out over it
 * @property {number} [offset] the field scene's world scroll, so events can
 *   spawn props just beyond the right edge of the view
 * @property {boolean} [busy] whether something is playing out on the field
 *   scene's road, for the tools that film it
 */

export class App {
  /**
   * @param {{settings: any, audio: import('./audio.mjs').AudioEngine}} services
   */
  constructor({ settings, audio }) {
    this.settings = settings;
    this.audio = audio;

    this.canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('scene'));
    this.context = /** @type {CanvasRenderingContext2D} */ (this.canvas.getContext('2d'));
    this.context.imageSmoothingEnabled = false;
    this.overlay = /** @type {HTMLElement} */ (document.getElementById('overlay'));
    this.toastNode = /** @type {HTMLElement} */ (document.getElementById('toast'));

    /** @type {Array<{scene: Scene, node: HTMLElement|null}>} */
    this.stack = [];
    /** @type {any} */
    this.session = null;

    this.lastFrame = 0;
    this.toastTimer = 0;
    /** Whether anything was drawn on the canvas last frame, so it needs clearing. */
    this.canvasUsed = true;
    /** @type {HTMLCanvasElement|null} */
    this.snapshotCanvas = null;

    // A message goes at the first press anywhere, so it never stands over the
    // button the player wants next. A press on the message itself only clears
    // it: the button that surfaces from under it is not pressed too.
    window.addEventListener('pointerdown', () => this.dismissToast(), true);
  }

  /** The scene currently on top, or null before the first one is pushed. */
  get scene() {
    return this.stack.length ? this.stack[this.stack.length - 1].scene : null;
  }

  /**
   * Replace the whole stack with one scene.
   * @param {Scene} scene
   */
  setScene(scene) {
    while (this.stack.length) this.pop();
    this.push(scene);
  }

  /**
   * Put a scene on top of the current one.
   * @param {Scene} scene
   */
  push(scene) {
    const container = document.createElement('div');
    container.className = 'screen';
    this.overlay.append(container);

    const node = scene.mount?.(this) ?? null;
    if (node instanceof HTMLElement) container.append(node);

    this.stack.push({ scene, node: container });
    this.syncVisibility();
    return scene;
  }

  /** Remove the top scene and return to the one below it. */
  pop() {
    const top = this.stack.pop();
    if (!top) return;
    top.scene.unmount?.(this);
    top.node?.remove();
    this.syncVisibility();
  }

  /**
   * Only the top scene's controls are usable, so only its DOM is shown. A
   * scene beneath may still be drawn on the canvas — that is what `keepBelow`
   * is for — but its buttons and panels would otherwise sit over the screen on
   * top of it.
   */
  syncVisibility() {
    this.stack.forEach((entry, index) => {
      if (entry.node) entry.node.hidden = index !== this.stack.length - 1;
    });
  }

  /**
   * @param {number} deltaMs
   */
  tick(deltaMs) {
    // The top scene updates, and so does everything under a scene that says
    // the one below it may keep going — a bag opened over the road stops the
    // player, not the companion. Deepest first, so a scene that reads what the
    // one below it did sees this frame's state rather than the last frame's.
    // By index rather than over a copy: a scene that closes itself mid-update
    // shortens the stack, and the loop should stop there rather than go on to
    // update something that has already been unmounted.
    for (let index = this.firstUpdateIndex(); index < this.stack.length; index++) {
      this.stack[index]?.scene.update?.(deltaMs, this);
    }

    const firstVisible = this.firstRenderIndex();
    for (let index = 0; index < this.stack.length; index++) {
      this.stack[index].scene.setShown?.(index >= firstVisible);
    }
    for (let index = firstVisible; index < this.stack.length; index++) {
      this.stack[index].scene.present?.(this);
    }

    // The canvas is only cleared and drawn on while something draws on it.
    // The road keeps layers of its own under it, so a canvas left clear over
    // the road is left alone rather than cleared again every frame — which
    // counts as a change, and has the whole window put together again.
    let drawing = false;
    for (let index = firstVisible; index < this.stack.length; index++) {
      if (this.stack[index].scene.render) drawing = true;
    }
    if (drawing || this.canvasUsed) {
      const context = this.context;
      context.clearRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
      for (let index = firstVisible; index < this.stack.length; index++) {
        this.stack[index].scene.render?.(context, this);
      }
      this.canvasUsed = drawing;
    }

    if (this.toastTimer > 0) {
      this.toastTimer -= deltaMs;
      if (this.toastTimer <= 0) this.toastNode.hidden = true;
    }
  }

  /**
   * The picture as it stands, on one canvas the size of the view: the layers
   * a scene keeps under the canvas, and the canvas over them. For the tools
   * that read pixels off the game rather than photographing the window.
   *
   * @returns {HTMLCanvasElement}
   */
  snapshot() {
    if (!this.snapshotCanvas) {
      this.snapshotCanvas = document.createElement('canvas');
      this.snapshotCanvas.width = VIEW_WIDTH;
      this.snapshotCanvas.height = VIEW_HEIGHT;
    }
    const context = /** @type {CanvasRenderingContext2D} */ (this.snapshotCanvas.getContext('2d'));
    context.clearRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
    const firstVisible = this.firstRenderIndex();
    for (let index = firstVisible; index < this.stack.length; index++) {
      this.stack[index].scene.snapshot?.(context);
    }
    context.drawImage(this.canvas, 0, 0);
    return this.snapshotCanvas;
  }

  /**
   * The deepest scene that still runs, which is as far down as the chain of
   * `keepBelowRunning` scenes above it reaches.
   */
  firstUpdateIndex() {
    let index = this.stack.length - 1;
    while (index > 0 && this.stack[index].scene.keepBelowRunning) index--;
    return Math.max(0, index);
  }

  /** The deepest scene that still needs drawing under the current one. */
  firstRenderIndex() {
    for (let index = this.stack.length - 1; index >= 0; index--) {
      if (!this.stack[index].scene.keepBelow) return index;
    }
    return 0;
  }

  /**
   * A brief message along the bottom edge.
   * @param {string} message
   * @param {number} [durationMs]
   */
  toast(message, durationMs = 2600) {
    this.toastNode.textContent = message;
    this.toastNode.hidden = false;
    this.toastTimer = durationMs;
  }

  /** Take the message down before its time is up. */
  dismissToast() {
    this.toastTimer = 0;
    this.toastNode.hidden = true;
  }

  /**
   * A small ring where the pointer landed, gone in a quarter-second.
   *
   * It is appended to the body rather than into the scaled stage, so it tracks
   * the cursor in window coordinates — a click on a battle at twice the scale
   * ripples under the pointer, not a quarter of the window away from it.
   * @param {MouseEvent} event
   */
  clickRipple(event) {
    const ring = el('div.click-ripple', {
      style: { left: `${event.clientX}px`, top: `${event.clientY}px` },
    });
    document.body.append(ring);
    ring.addEventListener('animationend', () => ring.remove());
  }

  /**
   * Apply and persist a settings change, reacting to the ones that need it.
   * @param {Partial<any>} patch
   */
  async updateSettings(patch) {
    const before = this.settings;
    this.settings = await settingsApi.set(patch);
    this.audio.setVolumes(this.settings);
    if (this.settings.language !== before.language) {
      await setLanguage(this.settings.language);
      this.refreshScenes();
    }
    if (this.settings.scale !== before.scale) fitStage();
    return this.settings;
  }

  /** Re-mount every scene in place, used when the language changes. */
  refreshScenes() {
    for (const entry of this.stack) {
      if (!entry.node) continue;
      entry.scene.unmount?.(this);
      clear(entry.node);
      const node = entry.scene.mount?.(this) ?? null;
      if (node instanceof HTMLElement) entry.node.append(node);
    }
  }
}

/**
 * Scale the fixed-size stage to fill the window. Snapping to whole pixels
 * where possible keeps sprite edges clean.
 */
export function fitStage() {
  const stage = /** @type {HTMLElement} */ (document.getElementById('stage'));
  const snapped = snapZoom(Math.min(window.innerWidth / VIEW_WIDTH, window.innerHeight / VIEW_HEIGHT));
  stage.style.transform = `scale(${snapped})`;
  stage.style.left = `${Math.round((window.innerWidth - VIEW_WIDTH * snapped) / 2)}px`;
  stage.style.top = `${Math.round((window.innerHeight - VIEW_HEIGHT * snapped) / 2)}px`;
}

/**
 * Drive an app with the display's refresh rate.
 * @param {App} app
 */
export function runLoop(app) {
  let previous = performance.now();

  const frame = (now) => {
    // Clamp the step so a backgrounded window does not fast-forward the game
    // when it comes back.
    const delta = Math.min(now - previous, 100);
    previous = now;
    try {
      app.tick(delta);
    } catch (error) {
      // One bad frame must not end the run: the companion is meant to be left
      // alone for hours, so the loop reports and carries on.
      console.error('frame failed', error);
    }
    // Requested outside the try, so a throw can never stop the loop.
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}

/**
 * Drag the window by its top strip with the pointer, rather than leaving it to
 * the frameless window's own drag region — which answers on some window sizes
 * and not others. The position is remembered once, on the drop.
 *
 * Two things make this work where stepping the window along by the distance
 * between two pointer events did not.
 *
 * The measurement is taken from the *desk*, not from the window. Every client
 * coordinate is relative to a window that is itself being moved: nudge the
 * window right and a pointer that has not moved at all reports itself further
 * left, so a drag driven by client deltas argues with itself — which is the
 * shaking. `screenX` and `screenY` do not move when the window does.
 *
 * And the window is put somewhere rather than nudged. Each message carries the
 * whole distance travelled since the drag began, so a message that arrives
 * late lands the window where the pointer already is instead of adding a step
 * that has been taken twice.
 */
export function trackWindowDrag() {
  const handles = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('[data-drag]')]);
  if (handles.length === 0) return;

  /** Where on the desk the drag began, or null while not dragging. */
  let from = null;

  for (const handle of handles) {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      from = { x: event.screenX, y: event.screenY };
      handle.setPointerCapture(event.pointerId);
      void windowControl.beginDrag();
    });

    handle.addEventListener('pointermove', (event) => {
      if (!from) return;
      void windowControl.dragTo(event.screenX - from.x, event.screenY - from.y);
    });

    const release = (event) => {
      if (!from) return;
      from = null;
      if (event.type === 'pointerup' && handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
      void windowControl.endDrag();
    };
    handle.addEventListener('pointerup', release);
    handle.addEventListener('pointercancel', release);
  }
}
