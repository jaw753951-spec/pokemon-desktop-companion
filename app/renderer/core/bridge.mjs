/**
 * Typed access to the preload bridge.
 *
 * Isolating `window.pdc` here keeps every Node-facing call in one place, which
 * is also what would need swapping if the game were ever run in a browser.
 */

/**
 * Resolved on use rather than at import, so that the modules which only need
 * `url` or a pure helper from this file stay importable outside Electron —
 * the unit tests rely on that.
 * @returns {any}
 */
function api() {
  const bridge = /** @type {any} */ (globalThis).pdc;
  if (!bridge) throw new Error('Preload bridge is missing — the renderer cannot reach the main process.');
  return bridge;
}

export const settings = {
  get: () => api().settings.get(),
  set: (patch) => api().settings.set(patch),
  scaleSteps: () => api().settings.scaleSteps(),
};

export const saves = {
  list: () => api().saves.list(),
  read: (slot) => api().saves.read(slot),
  write: (slot, save) => api().saves.write(slot, save),
  remove: (slot) => api().saves.remove(slot),
};

export const windowControl = {
  /** Take hold of the window; the main process remembers where it stands. */
  beginDrag: () => api().window.beginDrag(),
  /**
   * Put the window where the pointer has carried it, measured from where the
   * drag began rather than from the last message.
   * @param {number} dx @param {number} dy
   */
  dragTo: (dx, dy) => api().window.dragTo(dx, dy),
  /** Let go, and keep where it ended up. */
  endDrag: () => api().window.endDrag(),
};

export const appControl = {
  quit: (slot, save) => api().app.quit(slot, save),
  /** The build's version number, e.g. `1.0.2`. */
  version: () => api().app.version(),
};

/**
 * Fetch a JSON file served over the `pdc://` protocol.
 * @param {'data'|'authored'|'assets'} root
 * @param {string} path
 * @returns {Promise<any>}
 */
export async function loadJson(root, path) {
  const response = await fetch(`pdc://${root}/${path}`);
  if (!response.ok) throw new Error(`Failed to load pdc://${root}/${path} (${response.status})`);
  return response.json();
}

/**
 * @param {'data'|'authored'|'assets'} root
 * @param {string} path
 */
export const url = (root, path) => `pdc://${root}/${path}`;
