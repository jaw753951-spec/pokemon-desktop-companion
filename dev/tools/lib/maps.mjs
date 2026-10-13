/**
 * Drawing a map from the decompilation.
 *
 * A map is a layout — width, height, a block data file and the two tilesets it
 * addresses — and the layouts are listed in one index. Two build steps need
 * the same thing from that: the routes the companion walks along, and the
 * league's rooms. Both get it here, so neither owns the fetching.
 */
import { fetchBuffer, fetchJson } from './http.mjs';
import { decodePng } from './png.mjs';
import {
  combineMetatiles,
  combineTilesets,
  GEOMETRY,
  parseJascPal,
  renderMap,
  renderTopLayer,
  sliceTiles,
  tilesetDirName,
} from './gba-gfx.mjs';
import { EMERALD, FIRERED } from '../sources.mjs';

/** How many palettes a tileset can carry. */
const PALETTE_COUNT = 16;

/**
 * The metatile behaviours the cartridge lets a player surf on
 * (`TILE_FLAG_SURFABLE` in `src/metatile_behavior.c`): ponds, the sea, deep
 * water, waterfalls and currents. Their collision is clear — a Pokémon can
 * cross them, on a Surfer's back — so the collision bits alone let the walk
 * go straight across a lake. Shallow water and puddles are not among them:
 * those are waded, as on the cartridge.
 */
export const SURFABLE_BEHAVIORS = new Set([
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x18, 0x19, 0x1a, 0x22, 0x2a, 0x50, 0x51, 0x52, 0x53, 0x6c, 0x6d, 0x6f,
]);

/**
 * The long grass of Route 119 and Route 120 (`MB_LONG_GRASS`), which a walker
 * in the cartridge sinks into to the waist (`FLDEFF_LONG_GRASS`). Fire Red has
 * none.
 */
export const LONG_GRASS_BEHAVIORS = new Set([0x03]);

/**
 * Tall grass (`MB_TALL_GRASS`), the same number in both games, whose blades
 * the cartridge draws over a walker's feet (`FLDEFF_TALL_GRASS`).
 */
export const TALL_GRASS_BEHAVIORS = new Set([0x02]);

/**
 * Every way through to somewhere else — doors, ladders, the arrow warps at a
 * gatehouse's mouth, escalators — which both games keep together from 0x60
 * (`MB_NON_ANIMATED_DOOR` to `MB_DEEP_SOUTH_WARP` in Emerald, `MB_CAVE_DOOR`
 * to `MB_UP_RIGHT_STAIR_WARP` in Fire Red). They are open ground to the
 * collision bits, but each is the edge of a building or a hole in a wall.
 *
 * @param {number} from
 * @param {number} to
 */
const behaviorRange = (from, to) => new Set(Array.from({ length: to - from + 1 }, (_, index) => from + index));

/**
 * What differs between the two decompilations a map can come from.
 *
 * Fire Red numbers its behaviours a little differently (fast water where
 * Emerald has interior deep water, the Cycling Road's water) and stores each
 * metatile's attributes as a u32 with the behaviour in the low nine bits,
 * where Emerald's is a u16 with it in the low eight.
 *
 * The layer type — whether a metatile's second layer goes over the sprites or
 * under them — sits in bits 12-15 of Emerald's attributes and 29-30 of Fire
 * Red's.
 *
 * @type {Record<'emerald'|'firered', {base: string, geometry: import('./gba-gfx.mjs').Geometry,
 *   attributeBytes: number, behaviorMask: number, layerShift: number, surfable: Set<number>, longGrass: Set<number>, tallGrass: Set<number>, warps: Set<number>}>}
 */
export const GAMES = {
  emerald: {
    base: EMERALD,
    geometry: GEOMETRY.emerald,
    attributeBytes: 2,
    behaviorMask: 0xff,
    layerShift: 12,
    surfable: SURFABLE_BEHAVIORS,
    longGrass: LONG_GRASS_BEHAVIORS,
    tallGrass: TALL_GRASS_BEHAVIORS,
    warps: behaviorRange(0x60, 0x6e),
  },
  firered: {
    base: FIRERED,
    geometry: GEOMETRY.firered,
    attributeBytes: 4,
    behaviorMask: 0x1ff,
    layerShift: 29,
    surfable: new Set([0x10, 0x11, 0x12, 0x13, 0x15, 0x19, 0x1a, 0x1b, 0x22, 0x50, 0x51, 0x52, 0x53]),
    longGrass: new Set(),
    // And the grass on the Cycling Road's slope, which Fire Red's own
    // `MetatileBehavior_IsTallGrass` counts as tall grass too.
    tallGrass: new Set([...TALL_GRASS_BEHAVIORS, 0xd1]),
    warps: behaviorRange(0x60, 0x6c),
  },
};

/**
 * Open the map index, ready to draw any map in it.
 *
 * Tilesets are fetched once however many maps share them, which most of Hoenn
 * does — the thirty areas between them use a handful.
 *
 * @param {<T>(task: () => Promise<T>) => Promise<T>} pool
 * @param {'emerald'|'firered'} [game] which decompilation the maps come from
 */
export async function openMaps(pool, game = 'emerald') {
  const profile = GAMES[game];
  const { base } = profile;
  const { layouts } = await fetchJson(`${base}/data/layouts/layouts.json`);
  const index = new Map(layouts.filter((layout) => layout && layout.id).map((layout) => [layout.id, layout]));
  const cache = new Map();

  return {
    /**
     * Draw one map, and hand back what it was drawn from.
     *
     * @param {string} dir the map's directory, such as `Route101`
     * @returns {Promise<{
     *   map: any,
     *   layout: any,
     *   blockdata: Buffer,
     *   image: {width: number, height: number, data: Uint8Array},
     *   over: {width: number, height: number, data: Uint8Array},
     *   isWater: (x: number, y: number) => boolean,
     *   isLongGrass: (x: number, y: number) => boolean,
     *   isTallGrass: (x: number, y: number) => boolean,
     *   isWarp: (x: number, y: number) => boolean,
     *   signs: Array<{x: number, y: number}>,
     * }>}
     */
    async render(dir) {
      const map = await fetchJson(`${base}/data/maps/${dir}/map.json`);
      const layout = index.get(map.layout);
      if (!layout) throw new Error(`No layout ${map.layout} for map ${dir}`);

      const primary = await loadTileset(cache, pool, base, 'primary', layout.primary_tileset);
      const secondary = layout.secondary_tileset
        ? await loadTileset(cache, pool, base, 'secondary', layout.secondary_tileset)
        : null;

      const tileset = combineTilesets(primary, secondary, profile.geometry);
      const metatiles = combineMetatiles(primary.metatiles, secondary ? secondary.metatiles : null, profile.geometry);
      const blockdata = await fetchBuffer(`${base}/${layout.blockdata_filepath}`);

      // A block's behaviour lives with its metatile, in whichever tileset the
      // metatile's number falls in: the primary's first, then the secondary's.
      const inPrimary = profile.geometry.metatilesInPrimary;
      const size = profile.attributeBytes;
      const attributesOf = (metatileId) => {
        const [attributes, index] =
          metatileId < inPrimary
            ? [primary.attributes, metatileId]
            : [secondary?.attributes ?? null, metatileId - inPrimary];
        if (!attributes || (index + 1) * size > attributes.length) return 0;
        return size === 4 ? attributes.readUInt32LE(index * size) : attributes.readUInt16LE(index * size);
      };
      const behaviorOf = (metatileId) => attributesOf(metatileId) & profile.behaviorMask;
      // Layer type 1 ("covered") puts both layers under the sprites; 0 and 2
      // put the second one over them.
      const overSprites = (metatileId) => ((attributesOf(metatileId) >>> profile.layerShift) & 0x3) !== 1;
      /** @param {Set<number>} behaviors */
      const blockIs = (behaviors) => (x, y) => {
        const offset = (y * layout.width + x) * 2;
        if (x < 0 || y < 0 || x >= layout.width || offset + 1 >= blockdata.length) return false;
        return behaviors.has(behaviorOf(blockdata.readUInt16LE(offset) & 0x3ff));
      };
      const isWater = blockIs(profile.surfable);
      const isLongGrass = blockIs(profile.longGrass);
      const isTallGrass = blockIs(profile.tallGrass);
      const isWarp = blockIs(profile.warps);
      // The signposts, which are a block of their own each: the route signs
      // and trainer tips boards of the shared tileset. A sign event on
      // anything else — a notice painted across the Cycling Road, a cave's
      // board — is part of something wider and is left out.
      const signs = (map.bg_events ?? [])
        .filter((event) => event.type === 'sign' && event.x >= 0 && event.y >= 0 && event.x < layout.width && event.y < layout.height)
        .filter((event) => (blockdata.readUInt16LE((event.y * layout.width + event.x) * 2) & 0x3ff) < inPrimary)
        .map((event) => ({ x: event.x, y: event.y }));

      return {
        map,
        layout,
        blockdata,
        image: renderMap(blockdata, layout.width, layout.height, tileset, metatiles),
        over: renderTopLayer(blockdata, layout.width, layout.height, tileset, metatiles, overSprites),
        isWater,
        isLongGrass,
        isTallGrass,
        isWarp,
        signs,
      };
    },
  };
}

/**
 * @param {Map<string, any>} cache
 * @param {<T>(task: () => Promise<T>) => Promise<T>} pool
 * @param {string} root the decompilation's base URL
 * @param {'primary'|'secondary'} role
 * @param {string} symbol
 */
async function loadTileset(cache, pool, root, role, symbol) {
  const key = `${role}/${symbol}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const base = `${root}/data/tilesets/${role}/${tilesetDirName(symbol)}`;
  const tiles = sliceTiles(decodePng(await fetchBuffer(`${base}/tiles.png`)));

  /** @type {Array<Array<[number, number, number]>>} */
  const palettes = new Array(PALETTE_COUNT);
  await Promise.all(
    Array.from({ length: PALETTE_COUNT }, (_, index) =>
      pool(async () => {
        const file = await fetchBuffer(`${base}/palettes/${String(index).padStart(2, '0')}.pal`, {
          allowMissing: true,
        });
        if (file) palettes[index] = parseJascPal(file);
      }),
    ),
  );

  const tileset = {
    tiles,
    palettes,
    metatiles: await fetchBuffer(`${base}/metatiles.bin`),
    // One u16 per metatile, its behaviour in the low byte.
    attributes: await fetchBuffer(`${base}/metatile_attributes.bin`, { allowMissing: true }),
  };
  cache.set(key, tileset);
  return tileset;
}
