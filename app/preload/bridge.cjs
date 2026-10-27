/**
 * The renderer's only channel to the main process.
 *
 * Deliberately a small, fixed surface: the game can read and write its own
 * settings and save slots and nudge its window, and nothing else. Assets and
 * game data are fetched over the `pdc://` protocol instead of passing through
 * here, so nothing large ever crosses the bridge.
 */
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('pdc', {
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
    scaleSteps: () => invoke('settings:scaleSteps'),
  },
  saves: {
    list: () => invoke('saves:list'),
    read: (slot) => invoke('saves:read', slot),
    write: (slot, save) => invoke('saves:write', { slot, save }),
    remove: (slot) => invoke('saves:delete', slot),
  },
  window: {
    beginDrag: () => invoke('window:dragStart'),
    dragTo: (dx, dy) => invoke('window:dragTo', { dx, dy }),
    endDrag: () => invoke('window:dragEnd'),
  },
  app: {
    quit: (slot, save) => invoke('app:quit', { slot, save }),
    version: () => invoke('app:version'),
  },
});
