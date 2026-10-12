/**
 * The companion window.
 *
 * It is a frameless, transparent, always-on-top panel taking roughly one
 * sixteenth of the screen's area — a quarter of its width and height — pinned
 * to the top of the desktop and dragged by its own title strip, in the manner
 * of desktop pets like Ruety's Retirement. The renderer always draws at a
 * fixed 480x270 and is scaled to fit, so the pixel art stays exact.
 */
import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';

import { RENDERER_DIR } from './paths.mjs';
import { VIEW_HEIGHT, VIEW_WIDTH, windowZoom } from '../shared/constants.mjs';

/** @type {BrowserWindow|null} */
let current = null;

/**
 * Where the window stood when the drag now in progress began.
 *
 * A drag moves the window to an absolute place rather than nudging it by a
 * step: the renderer sends how far the pointer has travelled since it took
 * hold, and that is added to this. A message that arrives late then lands the
 * window where the pointer already is, instead of adding a step that has
 * been taken twice — which is what made the companion shake.
 *
 * @type {{x: number, y: number}|null}
 */
let dragFrom = null;

/**
 * The size the window is meant to be, in the display-independent pixels the
 * scale setting works in.
 *
 * Nothing but the scale setting changes it. Dragged between two monitors
 * scaled differently — a laptop at 150% beside a desk monitor at 100% —
 * Windows converts the window's place by one display's scale and its size by
 * the other's, and every move along the way rounded the size a little larger:
 * the companion grew as it was carried across, and went on growing for as
 * long as it was dragged. So the size goes with every move, and anything that
 * changes it anyway is undone (`holdSize`).
 *
 * @type {{width: number, height: number}|null}
 */
let intended = null;

/**
 * @param {import('./settings.mjs').Settings} settings
 * @returns {BrowserWindow}
 */
export function createWindow(settings) {
  const { width, height } = windowSize(settings.scale);
  const position = clampToDisplay(settings.windowX, settings.windowY, width, height);
  intended = { width, height };

  current = new BrowserWindow({
    width,
    height,
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    useContentSize: true,
    webPreferences: {
      preload: join(RENDERER_DIR, '..', 'preload', 'bridge.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  // 'screen-saver' keeps the companion above full-screen apps too, which is the
  // point of a desktop companion; without it the window hides behind games.
  current.setAlwaysOnTop(true, 'screen-saver');
  current.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // The window is only ever moved, never minimized, maximized or put full
  // screen. The options above take those away from the window's own controls,
  // but a window manager can still force them — a keyboard shortcut, a menu
  // on the window, a double-click some desktops honour on any window — so
  // each is undone the moment it happens. A minimized companion would be lost
  // besides: it has no taskbar entry to bring it back by.
  current.on('minimize', () => current?.restore());
  current.on('maximize', () => current?.unmaximize());
  current.on('enter-full-screen', () => current?.setFullScreen(false));
  // Nor is it ever resized but by the scale setting.
  current.on('resize', holdSize);

  current.loadFile(join(RENDERER_DIR, 'index.html'));
  current.on('closed', () => {
    current = null;
  });

  return current;
}

/** @returns {BrowserWindow|null} */
export function getWindow() {
  return current && !current.isDestroyed() ? current : null;
}

/** Take hold of the window: remember where it is now. */
export function beginDrag() {
  const window = getWindow();
  if (!window) return false;
  const [x, y] = window.getPosition();
  dragFrom = { x, y };
  return true;
}

/**
 * Put the window where the pointer has carried it.
 *
 * @param {number} dx how far the pointer has moved since the drag began
 * @param {number} dy
 */
export function dragTo(dx, dy) {
  const window = getWindow();
  if (!window || !dragFrom) return false;
  const x = Math.round(dragFrom.x + (Number.isFinite(dx) ? dx : 0));
  const y = Math.round(dragFrom.y + (Number.isFinite(dy) ? dy : 0));
  // Place and size together, so crossing onto a display scaled differently
  // cannot leave the size to be worked out again — and rounded up — each step.
  if (intended) window.setContentBounds({ x, y, width: intended.width, height: intended.height });
  else window.setPosition(x, y);
  return true;
}

/**
 * Put the window back to the size it is meant to be, if anything — a move
 * across displays, a window manager — has changed it.
 */
function holdSize() {
  const window = getWindow();
  if (!window || !intended) return;
  const [width, height] = window.getContentSize();
  if (width !== intended.width || height !== intended.height) window.setContentSize(intended.width, intended.height);
}

/** Let go, and report where the window ended up so the setting can keep it. */
export function endDrag() {
  dragFrom = null;
  const window = getWindow();
  if (!window) return null;
  const [x, y] = window.getPosition();
  return { x, y };
}

/**
 * Resize around the window's current centre, so changing the scale does not
 * throw the companion into a corner.
 *
 * The centre is kept in so far as the resized window can stay on screen; when
 * it cannot, the window slides back just far enough to fit rather than being
 * teleported to the default top-centre spot — the user placed the companion,
 * and a scale change should not undo that.
 *
 * @param {number} scale
 */
export function applyScale(scale) {
  const window = getWindow();
  if (!window) return null;

  const { width, height } = windowSize(scale);
  const [currentWidth, currentHeight] = window.getContentSize();
  const [x, y] = window.getPosition();
  const centreX = x + currentWidth / 2;
  const centreY = y + currentHeight / 2;

  const position = keepOnDisplay(Math.round(centreX - width / 2), Math.round(centreY - height / 2), width, height);
  intended = { width, height };
  window.setContentSize(width, height);
  window.setPosition(position.x, position.y);
  return { width, height, ...position };
}

/**
 * The companion occupies about 1/16 of the screen's area at scale 1, so a
 * quarter of each dimension, held to the renderer's 16:9 aspect.
 *
 * The size is worked out from a *snapped* zoom rather than snapped afterwards
 * (`windowZoom`).
 * The renderer draws 480x270 and scales it by whole quarter steps at or above
 * 1:1, so a window sized to anything else left the picture sitting in a band
 * of window it did not fill — the dark border the companion appeared to be
 * wearing. Deriving the window from the zoom the renderer is going to use
 * means the two agree and there is no band.
 *
 * @param {number} scale
 */
export function windowSize(scale) {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const zoom = windowZoom(scale, screenWidth, screenHeight);
  return { width: Math.round(VIEW_WIDTH * zoom), height: Math.round(VIEW_HEIGHT * zoom) };
}


/**
 * Keep the window on a real display. Defaults to the top centre of the primary
 * screen, which is where a companion belongs.
 */
function clampToDisplay(x, y, width, height) {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();

  if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) {
    return {
      x: Math.round(primary.workArea.x + (primary.workArea.width - width) / 2),
      y: primary.workArea.y + 8,
    };
  }

  const fits = displays.some((display) => {
    const area = display.workArea;
    return x + width > area.x && x < area.x + area.width && y + height > area.y && y < area.y + area.height;
  });
  if (fits) return { x: Math.round(x), y: Math.round(y) };

  return {
    x: Math.round(primary.workArea.x + (primary.workArea.width - width) / 2),
    y: primary.workArea.y + 8,
  };
}

/**
 * Nudge a window that would sit partly or wholly off-screen back into the
 * display it came from, rather than relocating it. The least move that fits
 * wins: a companion dragged half onto a second monitor stays on that monitor.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 */
function keepOnDisplay(x, y, width, height) {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return {
      x: Math.round(primary.workArea.x + (primary.workArea.width - width) / 2),
      y: primary.workArea.y + 8,
    };
  }

  // The display holding most of the window today is the one it belongs on.
  let best = null;
  let bestOverlap = -1;
  for (const display of displays) {
    const area = display.workArea;
    const overlapX = Math.max(0, Math.min(x + width, area.x + area.width) - Math.max(x, area.x));
    const overlapY = Math.max(0, Math.min(y + height, area.y + area.height) - Math.max(y, area.y));
    const overlap = overlapX * overlapY;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = area;
    }
  }
  if (!best) best = primary.workArea;

  return {
    x: Math.round(Math.max(best.x, Math.min(x, best.x + best.width - width))),
    y: Math.round(Math.max(best.y, Math.min(y, best.y + best.height - height))),
  };
}
