/**
 * electron-builder's afterPack hook: take out the parts of Electron the game
 * never uses before the package is zipped.
 *
 * `dxcompiler.dll` and `dxil.dll` are DirectX's shader compiler, which
 * Chromium loads only for WebGPU. The game draws with a 2D canvas and the
 * page's own layers, and never asks for WebGPU; the two are 26 MB of the
 * unpacked app and about 9 MB of the download. Only the Windows build has them.
 *
 * Kept as CommonJS because electron-builder requires its hooks.
 *
 * @param {{electronPlatformName: string, appOutDir: string}} context
 */
const { rm } = require('node:fs/promises');
const { join } = require('node:path');

/** Files dropped from each platform's package. */
const UNUSED = {
  win32: ['dxcompiler.dll', 'dxil.dll'],
};

exports.default = async function afterPack(context) {
  for (const name of UNUSED[context.electronPlatformName] ?? []) {
    await rm(join(context.appOutDir, name), { force: true });
  }
};
