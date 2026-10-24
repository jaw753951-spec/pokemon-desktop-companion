/**
 * Gen-3 (GBA) tileset and map rendering.
 *
 * The pokeemerald/pokefirered decompilations store overworld graphics exactly
 * as the cartridge did: 8x8 4-bpp tiles in an indexed PNG, JASC palettes, and
 * binary metatile/blockdata tables. This module turns those back into pixels so
 * the pipeline can render real in-game areas as the companion's backgrounds.
 *
 * Layout of the formats (verified against pokeemerald@master):
 *   tiles.png        128px-wide indexed PNG; tile n is at (n%16*8, n/16*8)
 *   palettes/NN.pal  JASC-PAL, 16 RGB entries; primary owns 0-5, secondary 6-12
 *   metatiles.bin    8 x uint16 per metatile (bottom layer 2x2, then top 2x2)
 *                    bits 0-9 tile, 10 xflip, 11 yflip, 12-15 palette
 *   map.bin          uint16 per 16x16 block: bits 0-9 metatile, 10-11 collision,
 *                    12-15 elevation
 */

export const TILE_SIZE = 8;
export const METATILE_SIZE = 16;
export const PALETTES_IN_PRIMARY = 6;
export const TILES_IN_PRIMARY = 512;
export const METATILES_IN_PRIMARY = 512;

/**
 * Where a map's primary tileset ends and its secondary begins, per game.
 *
 * Emerald gives the primary 512 tiles, 512 metatiles and six palettes; Fire
 * Red gives it 640, 640 and seven (`include/fieldmap.h` in each). The formats
 * are otherwise the same, which is what lets Kanto be drawn by this module at
 * all — but a Kanto map drawn with Emerald's split reads its secondary tiles
 * from the middle of its primary.
 *
 * @typedef {{tilesInPrimary: number, metatilesInPrimary: number, palettesInPrimary: number}} Geometry
 * @type {Record<'emerald'|'firered', Geometry>}
 */
export const GEOMETRY = {
  emerald: { tilesInPrimary: TILES_IN_PRIMARY, metatilesInPrimary: METATILES_IN_PRIMARY, palettesInPrimary: PALETTES_IN_PRIMARY },
  firered: { tilesInPrimary: 640, metatilesInPrimary: 640, palettesInPrimary: 7 },
};

/**
 * `gTileset_PetalburgWoods` -> `petalburg_woods`
 * @param {string} symbol
 */
export function tilesetDirName(symbol) {
  return symbol
    .replace(/^gTileset_/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * Parse a JASC-PAL file into 16 RGB triples.
 * @param {Buffer} buffer
 * @returns {Array<[number, number, number]>}
 */
export function parseJascPal(buffer) {
  const lines = buffer.toString('ascii').split(/\r?\n/);
  if (lines[0].trim() !== 'JASC-PAL') throw new Error('Not a JASC-PAL file');
  const count = Number.parseInt(lines[2], 10);
  const colors = [];
  for (let i = 0; i < count; i++) {
    const parts = lines[3 + i].trim().split(/\s+/).map(Number);
    colors.push(/** @type {[number, number, number]} */ ([parts[0], parts[1], parts[2]]));
  }
  return colors;
}

/**
 * Slice an indexed tile sheet into per-tile palette-index arrays.
 * @param {import('./png.mjs').DecodedPng} png
 * @returns {Uint8Array[]} one 64-entry array per tile
 */
export function sliceTiles(png) {
  if (!png.indices) throw new Error('Tile sheet must be an indexed PNG');
  const columns = Math.floor(png.width / TILE_SIZE);
  const rows = Math.floor(png.height / TILE_SIZE);
  /** @type {Uint8Array[]} */
  const tiles = [];
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < columns; tx++) {
      const tile = new Uint8Array(TILE_SIZE * TILE_SIZE);
      for (let y = 0; y < TILE_SIZE; y++) {
        for (let x = 0; x < TILE_SIZE; x++) {
          tile[y * TILE_SIZE + x] = png.indices[(ty * TILE_SIZE + y) * png.width + tx * TILE_SIZE + x];
        }
      }
      tiles.push(tile);
    }
  }
  return tiles;
}

/**
 * @typedef {Object} Tileset
 * @property {Uint8Array[]} tiles
 * @property {Array<Array<[number, number, number]>>} palettes sparse, indexed 0-15
 */

/**
 * Combine a primary and a secondary tileset into the address space a map sees.
 * @param {Tileset} primary
 * @param {Tileset|null} secondary
 * @param {Geometry} [geometry] the game's split; Emerald's by default
 */
export function combineTilesets(primary, secondary, geometry = GEOMETRY.emerald) {
  const { tilesInPrimary, palettesInPrimary } = geometry;
  /** @type {Uint8Array[]} */
  const tiles = new Array(tilesInPrimary + (secondary?.tiles.length ?? 0));
  for (let i = 0; i < tiles.length; i++) tiles[i] = EMPTY_TILE;
  primary.tiles.forEach((tile, i) => { if (i < tilesInPrimary) tiles[i] = tile; });
  secondary?.tiles.forEach((tile, i) => { tiles[tilesInPrimary + i] = tile; });

  /** @type {Array<Array<[number, number, number]>>} */
  const palettes = new Array(16);
  for (let i = 0; i < palettesInPrimary; i++) palettes[i] = primary.palettes[i] ?? FALLBACK_PALETTE;
  for (let i = palettesInPrimary; i < 16; i++) {
    palettes[i] = secondary?.palettes[i] ?? primary.palettes[i] ?? FALLBACK_PALETTE;
  }
  return { tiles, palettes };
}

/** A tile index past the end of the set reads as nothing drawn. */
export const EMPTY_TILE = new Uint8Array(TILE_SIZE * TILE_SIZE);
const FALLBACK_PALETTE = /** @type {Array<[number, number, number]>} */ (
  Array.from({ length: 16 }, () => [0, 0, 0])
);

/**
 * Combine primary and secondary metatile tables.
 * @param {Buffer} primary
 * @param {Buffer|null} secondary
 * @param {Geometry} [geometry] the game's split; Emerald's by default
 * @returns {Uint16Array} 8 entries per metatile
 */
export function combineMetatiles(primary, secondary, geometry = GEOMETRY.emerald) {
  const inPrimary = geometry.metatilesInPrimary;
  const total = inPrimary + (secondary ? secondary.length / 16 : 0);
  const out = new Uint16Array(total * 8);
  for (let i = 0; i < Math.min(primary.length / 2, inPrimary * 8); i++) {
    out[i] = primary.readUInt16LE(i * 2);
  }
  if (secondary) {
    for (let i = 0; i < secondary.length / 2; i++) {
      out[inPrimary * 8 + i] = secondary.readUInt16LE(i * 2);
    }
  }
  return out;
}

/**
 * Draw one 16x16 metatile into an RGBA canvas.
 *
 * @param {Uint8Array} out RGBA canvas
 * @param {number} canvasWidth
 * @param {number} destX
 * @param {number} destY
 * @param {number} metatileId
 * @param {{tiles: Uint8Array[], palettes: Array<Array<[number, number, number]>>}} tileset
 * @param {Uint16Array} metatiles
 * @param {[number, number]} [entries] which of the eight tiles to draw — all
 *   of them by default, `[4, 8]` for the second layer alone
 */
export function drawMetatile(out, canvasWidth, destX, destY, metatileId, tileset, metatiles, entries = [0, 8]) {
  const base = metatileId * 8;
  if (base + 8 > metatiles.length) return;

  // Entries 0-3 are the bottom layer, 4-7 the top layer drawn over it.
  for (let entry = entries[0]; entry < entries[1]; entry++) {
    const value = metatiles[base + entry];
    const tileIndex = value & 0x3ff;
    const flipX = Boolean(value & 0x400);
    const flipY = Boolean(value & 0x800);
    const palette = tileset.palettes[(value >> 12) & 0x0f] ?? FALLBACK_PALETTE;
    const tile = tileset.tiles[tileIndex] ?? EMPTY_TILE;

    const quadrant = entry % 4;
    const offsetX = destX + (quadrant % 2) * TILE_SIZE;
    const offsetY = destY + Math.floor(quadrant / 2) * TILE_SIZE;

    for (let y = 0; y < TILE_SIZE; y++) {
      for (let x = 0; x < TILE_SIZE; x++) {
        const index = tile[(flipY ? TILE_SIZE - 1 - y : y) * TILE_SIZE + (flipX ? TILE_SIZE - 1 - x : x)];
        if (index === 0) continue; // palette index 0 is transparent on every layer
        const px = offsetX + x;
        const py = offsetY + y;
        if (px < 0 || py < 0 || px >= canvasWidth) continue;
        const target = (py * canvasWidth + px) * 4;
        if (target + 3 >= out.length) continue;
        const color = palette[index] ?? [0, 0, 0];
        out[target] = color[0];
        out[target + 1] = color[1];
        out[target + 2] = color[2];
        out[target + 3] = 255;
      }
    }
  }
}

/**
 * Render only what a map draws over the people walking on it.
 *
 * A metatile's second four tiles go on the layer above the sprites unless its
 * layer type says otherwise, which is how a player walks under the Cycling
 * Road's deck on Route 110 instead of across it. Everything else is left
 * transparent, so the result can be laid over a scene the full map was drawn
 * under.
 *
 * @param {Buffer} blockdata `map.bin`
 * @param {number} widthInBlocks
 * @param {number} heightInBlocks
 * @param {{tiles: Uint8Array[], palettes: Array<Array<[number, number, number]>>}} tileset
 * @param {Uint16Array} metatiles
 * @param {(metatileId: number) => boolean} overSprites whether a metatile's
 *   second layer is drawn above the sprites
 */
export function renderTopLayer(blockdata, widthInBlocks, heightInBlocks, tileset, metatiles, overSprites) {
  const width = widthInBlocks * METATILE_SIZE;
  const height = heightInBlocks * METATILE_SIZE;
  const data = new Uint8Array(width * height * 4);

  for (let by = 0; by < heightInBlocks; by++) {
    for (let bx = 0; bx < widthInBlocks; bx++) {
      const offset = (by * widthInBlocks + bx) * 2;
      if (offset + 1 >= blockdata.length) continue;
      const metatileId = blockdata.readUInt16LE(offset) & 0x3ff;
      if (!overSprites(metatileId)) continue;
      drawMetatile(data, width, bx * METATILE_SIZE, by * METATILE_SIZE, metatileId, tileset, metatiles, [4, 8]);
    }
  }

  return { width, height, data };
}

/**
 * Render a whole map layout to RGBA.
 *
 * @param {Buffer} blockdata `map.bin`
 * @param {number} widthInBlocks
 * @param {number} heightInBlocks
 * @param {{tiles: Uint8Array[], palettes: Array<Array<[number, number, number]>>}} tileset
 * @param {Uint16Array} metatiles
 * @returns {{width: number, height: number, data: Uint8Array}}
 */
export function renderMap(blockdata, widthInBlocks, heightInBlocks, tileset, metatiles) {
  const width = widthInBlocks * METATILE_SIZE;
  const height = heightInBlocks * METATILE_SIZE;
  const data = new Uint8Array(width * height * 4);

  // The GBA shows the backdrop colour wherever every layer is transparent.
  const backdrop = tileset.palettes[0]?.[0] ?? [0, 0, 0];
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = backdrop[0];
    data[i * 4 + 1] = backdrop[1];
    data[i * 4 + 2] = backdrop[2];
    data[i * 4 + 3] = 255;
  }

  for (let by = 0; by < heightInBlocks; by++) {
    for (let bx = 0; bx < widthInBlocks; bx++) {
      const offset = (by * widthInBlocks + bx) * 2;
      if (offset + 1 >= blockdata.length) continue;
      const metatileId = blockdata.readUInt16LE(offset) & 0x3ff;
      drawMetatile(data, width, bx * METATILE_SIZE, by * METATILE_SIZE, metatileId, tileset, metatiles);
    }
  }

  return { width, height, data };
}
