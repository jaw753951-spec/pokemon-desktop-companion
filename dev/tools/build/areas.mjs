/**
 * Render each shipped area as a seamless scrolling background, one image per
 * time of day, and emit the area manifest the field scene reads.
 */
import { join } from 'node:path';

import { fetchBuffer, fetchJson, writeOut } from '../lib/http.mjs';
import { decodePng, encodePng } from '../lib/png.mjs';
import { METATILE_SIZE } from '../lib/gba-gfx.mjs';
import { openMaps } from '../lib/maps.mjs';
import { crop, gradeTime, makeSeamless, overlay, pickLoopEnds, pickWalkPath, repeatToWidth, TIME_KEYS } from '../lib/image.mjs';
import { nameBundle } from '../lib/poke.mjs';
import { AREAS, BACKGROUND_HEIGHT, EMERALD, FIELD_WIDTH, FIRERED, POKEAPI } from '../sources.mjs';

/**
 * @param {{assetDir: string, dataDir: string, log: (message: string) => void, pool: <T>(task: () => Promise<T>) => Promise<T>}} context
 */
export async function buildAreas({ assetDir, dataDir, log, pool }) {
  // One map index and one encounter table per decompilation an area comes
  // from, opened the first time an area asks for it.
  /** @type {Map<string, Promise<any>>} */
  const mapsByGame = new Map();
  /** @type {Map<string, Promise<Map<string, any[]>>>} */
  const encountersByGame = new Map();
  const mapsFor = (game) => {
    if (!mapsByGame.has(game)) mapsByGame.set(game, openMaps(pool, game));
    return /** @type {Promise<any>} */ (mapsByGame.get(game));
  };
  const encountersFor = (game) => {
    if (!encountersByGame.has(game)) encountersByGame.set(game, loadEncounterTables(game === 'firered' ? FIRERED : EMERALD));
    return /** @type {Promise<Map<string, any[]>>} */ (encountersByGame.get(game));
  };
  const locationNames = await loadLocationNames(pool);
  /** The grass a walker goes into, per game, opened the first time an area asks. */
  /** @type {Map<string, Promise<{long: boolean[]|null, tall: boolean[]}>>} */
  const grassByGame = new Map();
  const grassFor = (game) => {
    if (!grassByGame.has(game)) grassByGame.set(game, loadGrassMasks(game));
    return /** @type {Promise<{long: boolean[]|null, tall: boolean[]}>} */ (grassByGame.get(game));
  };

  const wantedBlocks = Math.ceil(BACKGROUND_HEIGHT / METATILE_SIZE);
  /** @type {any[]} */
  const manifest = [];

  for (const area of AREAS) {
    const game = area.game ?? 'emerald';
    const maps = await mapsFor(game);
    const encounters = await encountersFor(game);
    const { map, layout, blockdata, image: rendered, over, isWater, isLongGrass, isTallGrass, isWarp, signs } = await maps.render(area.dir);
    const grass = await grassFor(game);
    // Two of the thirty maps are shorter than the window; they give what they
    // have and the field fills the remainder from their own top row.
    const bandBlocks = Math.min(wantedBlocks, layout.height);
    // The walk decides the crop, rather than the crop deciding the walk: the
    // strip is cut to a stretch of map the companion can cross end to end, so
    // the loop it walks has no hillside or tree in it at any point. See
    // `pickWalkPath` for why a whole-width strip could not manage that.
    // Nor through a doorway: the band is looped by mirroring it, and a
    // gatehouse's mouth at the end of the lane came back as half a door frame
    // stood on its own in the road, which the companion walked through.
    const path = pickWalkPath(blockdata, layout.width, layout.height, bandBlocks, (x, y) => isWater(x, y) || isWarp(x, y), area.lane);
    // Slid down the map where the area asks, to show what stands below the
    // lane; the lane itself stays where it was, higher in the strip.
    if (area.bandDrop) {
      path.bandRow = Math.max(0, Math.min(layout.height - bandBlocks, path.laneRow, path.bandRow + area.bandDrop));
    }
    // And cut to the stretch of the run whose ends mirror into the map going
    // on, or to the one the area names: see `pickLoopEnds`.
    if (area.loop && (area.loop[0] < path.column || area.loop[1] >= path.column + path.columns || area.loop[0] > area.loop[1])) {
      throw new Error(`${area.id}: loop ${area.loop} is not within the walkable run ${path.column}-${path.column + path.columns - 1}`);
    }
    const ends = area.loop
      ? { column: area.loop[0], columns: area.loop[1] - area.loop[0] + 1 }
      : pickLoopEnds(overlay(rendered, over), layout.width, path.bandRow, bandBlocks, path.column, path.columns, METATILE_SIZE);
    path.column = ends.column;
    path.columns = ends.columns;
    // The sign boards in the band, kept readable in its mirror image.
    const upright = signs
      .filter(({ x, y }) => x >= path.column && x < path.column + path.columns && y >= path.bandRow && y < path.bandRow + bandBlocks)
      .map(({ x, y }) => ({
        x: (x - path.column) * METATILE_SIZE,
        y: (y - path.bandRow) * METATILE_SIZE,
        width: METATILE_SIZE,
        height: METATILE_SIZE,
      }));
    const band = crop(
      rendered,
      path.column * METATILE_SIZE,
      path.bandRow * METATILE_SIZE,
      path.columns * METATILE_SIZE,
      bandBlocks * METATILE_SIZE,
    );
    const strip = repeatToWidth(makeSeamless(band, upright), FIELD_WIDTH * 2);
    // Where the companion's feet go within the strip: the bottom edge of the
    // lane whose blocks are clear, rather than a fixed fraction of the window.
    const groundY = Math.min(strip.height, (path.laneRow - path.bandRow + 1) * METATILE_SIZE);

    // Whatever the map draws over the lane itself — Route 110's Cycling Road
    // crossing overhead — is cut out as a layer of its own, so the field can
    // draw it over the companion and the companion walks under the bridge
    // rather than across the top of it. Only a bridge's columns are kept; see
    // `OVERPASS_BLOCKS` for what else is on that layer and why it is not.
    const overBand = crop(
      over,
      path.column * METATILE_SIZE,
      path.bandRow * METATILE_SIZE,
      path.columns * METATILE_SIZE,
      bandBlocks * METATILE_SIZE,
    );
    // Grass on the lane is walked through, not over: the companion goes into
    // it as a player in the cartridge does, the blades drawn over its feet —
    // to the waist in long grass, the ankles in tall. Laid on the
    // over-the-sprites layer, it is kept to the lane's own block as a tree's
    // crown is — see `keepOverLane`.
    sinkIntoGrass(overBand, band, (path.laneRow - path.bandRow + 1) * METATILE_SIZE, (index) => {
      const x = path.column + index;
      if (isLongGrass(x, path.laneRow)) return grass.long;
      if (isTallGrass(x, path.laneRow)) return grass.tall;
      return null;
    });
    // A lane up on a bridge's deck is walked across the top of it, not under:
    // the cartridge draws a sprite that high over the whole top layer.
    const laneElevations = Array.from({ length: path.columns }, (_, index) =>
      blockdata.readUInt16LE((path.laneRow * layout.width + path.column + index) * 2) >> 12,
    );
    const overhead = keepOverLane(overBand, groundY, aboveTopLayer(laneElevations));
    const overStrip = overhead ? repeatToWidth(makeSeamless(overhead.overlay, upright), FIELD_WIDTH * 2) : null;
    // Only what hides the companion whole — a bridge, a roof — keeps events
    // from starting under it; a tree top over its feet does not. A roof is
    // marked as one: it is a house's width, not a road's, and the room a
    // bridge is given either side left Route 7 no road at all between them.
    const spansOf = (raster) => (raster ? coveredSpans(repeatToWidth(makeSeamless(raster), FIELD_WIDTH * 2), groundY) : []);
    /** @type {Array<[number, number] | [number, number, 'roof']>} */
    const covered = [
      ...spansOf(overhead?.blocking ?? null),
      ...spansOf(overhead?.roofing ?? null).map(([from, to]) => /** @type {[number, number, 'roof']} */ ([from, to, 'roof'])),
    ];
    covered.sort((a, b) => a[0] - b[0]);

    // The water beside the lane. The walk itself never crosses water —
    // `pickWalkPath` keeps it on dry blocks — so a swimmer met on the road has
    // to be drawn out in the water nearest it: the row in front, then the one
    // behind, then two in front and two behind, as far as the strip shows.
    // Each column keeps how many rows away its water is.
    const inBand = (row) => row >= path.bandRow && row < path.bandRow + bandBlocks && row >= 0 && row < layout.height;
    const rowsOut = Array.from({ length: path.columns }, (_, index) => {
      const x = path.column + index;
      return WATER_ROWS.find((rows) => inBand(path.laneRow + rows) && isWater(x, path.laneRow + rows)) ?? null;
    });
    const water = rowsOut.some((rows) => rows !== null)
      ? stripRuns(rowsOut, METATILE_SIZE, FIELD_WIDTH * 2).map(([from, to, rows]) => [from, to, rows * METATILE_SIZE])
      : [];

    for (const time of TIME_KEYS) {
      const graded = gradeTime(strip, time);
      await writeOut(
        join(assetDir, 'areas', area.id, `${time}.png`),
        encodePng(graded.width, graded.height, graded.data),
      );
      if (overStrip) {
        const gradedOver = gradeTime(overStrip, time);
        await writeOut(
          join(assetDir, 'areas', area.id, `${time}-over.png`),
          encodePng(gradedOver.width, gradedOver.height, gradedOver.data),
        );
      }
    }

    const music = musicFor(map.music, game);
    const name = nameBundle(locationNames.get(area.location) ?? [], titleize(area.location));
    // PokeAPI has no Korean for Kanto; the area says the official name itself.
    if (area.ko) name.ko = area.ko;
    manifest.push({
      id: area.id,
      name,
      region: area.region ?? 'hoenn',
      tags: area.tags,
      ...(area.backdrop ? { backdrop: area.backdrop } : {}),
      width: strip.width,
      height: strip.height,
      groundY,
      // Stretches of the strip, in its own pixels, where something is drawn
      // over the lane; see `overhead` above. `[from, to]` for a bridge,
      // `[from, to, 'roof']` for a roof.
      ...(overStrip ? { overlay: true } : {}),
      ...(covered.length ? { covered } : {}),
      // Stretches with water beside the lane, which a swimming trainer is met
      // in: `[from, to, drop]`, drop being how far down from the lane the
      // water lies, in the strip's pixels (negative behind it).
      ...(water.length ? { water } : {}),
      music,
      weather: map.weather ? map.weather.replace('WEATHER_', '').toLowerCase() : 'none',
      encounters: encounters.get(map.id) ?? [],
    });

    log(
      `area ${area.id.padEnd(18)} ${strip.width}x${strip.height}  ground=${groundY}  ` +
        `walk=${path.columns} blocks @row ${path.laneRow} (headroom ${path.clearance})  ` +
        `music=${music ?? '-'}  mons=${manifest.at(-1).encounters.length}` +
        (covered.length ? `  covered=${covered.map(([from, to]) => `${from}-${to}`).join(',')}` : '') +
        (water.length ? `  water=${water.length} spans` : ''),
    );
  }

  await writeOut(join(dataDir, 'areas.json'), JSON.stringify(manifest));
  return manifest;
}

/**
 * The elevations a sprite is drawn over a map's top layer at
 * (`sElevationToPriority` in `src/event_object_movement.c`): the upper floors
 * of Victory Road, a bridge's deck. Everything lower goes under it.
 */
const OVER_TOP_ELEVATIONS = new Set([4, 6, 8, 10, 12, 13, 14]);

/**
 * Whether the companion walks over the top layer at each column of the lane.
 *
 * Elevation 0 and 15 are not heights of their own: a block marked with either
 * — a stairway, a bridge's planks over a path below — keeps whatever height
 * the walker came onto it at, so it takes the nearest real one along the lane.
 *
 * @param {number[]} elevations one per block column of the lane
 * @returns {boolean[]}
 */
export function aboveTopLayer(elevations) {
  const real = (elevation) => elevation !== 0 && elevation !== 15;
  return elevations.map((elevation, index) => {
    if (real(elevation)) return OVER_TOP_ELEVATIONS.has(elevation);
    for (let distance = 1; distance < elevations.length; distance++) {
      for (const at of [index - distance, index + distance]) {
        if (real(elevations[at] ?? 0)) return OVER_TOP_ELEVATIONS.has(elevations[at]);
      }
    }
    return false;
  });
}

/**
 * How many blocks, from the lane up, an overpass has to fill before the field
 * draws it over the companion.
 *
 * The layer above the sprites holds more than bridges: a tree's crown is on
 * it, which is how a player in the games walks behind the top of a tree, and
 * several lanes run along a row of crowns. Those are drawn over the lane's own
 * block only — the companion's feet go behind the tree top, as a player's do,
 * where it used to walk across it — and do not hold events back. A bridge is
 * the thing that is solid all the way up the band — Route 110's Cycling Road
 * crosses the whole window — so only a column solid for this many blocks is
 * taken to be one, and drawn whole.
 */
const OVERPASS_BLOCKS = 4;

/** How much of a block has to be drawn for it to count as solid overhead. */
const OVERPASS_FILL = 0.6;

/**
 * How much of the lane's block, and the one below, a roof fills: all of it,
 * where the rounded crowns of a tree line overhanging the lane fill about
 * four fifths.
 */
const ROOF_FILL = 0.95;

/**
 * The part of a map's over-the-sprites layer that is a bridge over the lane,
 * or a roof overhanging it.
 *
 * A block column is kept, top to bottom, when its layer is solid from the
 * block the companion's feet stand in up through {@link OVERPASS_BLOCKS}
 * blocks, or solid in that block and the one below it; every other column is
 * cleared.
 *
 * A column the companion walks above the top layer at — see
 * {@link aboveTopLayer} — is cleared whatever is on it.
 *
 * @param {import('../lib/image.mjs').Raster} over
 * @param {number} groundY the bottom edge of the lane's row, in the band
 * @param {boolean[]} [onTop] per block column, whether the companion walks
 *   over the top layer there
 * @returns {{overlay: import('../lib/image.mjs').Raster, blocking: import('../lib/image.mjs').Raster|null,
 *   roofing: import('../lib/image.mjs').Raster|null}|null}
 *   what is drawn over the companion, and the parts of it that are a bridge
 *   and a roof; null when nothing crosses the lane
 */
function keepOverLane(over, groundY, onTop = []) {
  const drawnIn = (column, bottom) => {
    let drawn = 0;
    for (let y = bottom - METATILE_SIZE; y < bottom; y++) {
      for (let x = column; x < column + METATILE_SIZE; x++) {
        if (y >= 0 && over.data[(y * over.width + x) * 4 + 3] > 0) drawn++;
      }
    }
    return drawn / (METATILE_SIZE * METATILE_SIZE);
  };
  const columns = Math.floor(over.width / METATILE_SIZE);
  const solid = (index, block, fill = OVERPASS_FILL) =>
    drawnIn(index * METATILE_SIZE, groundY - block * METATILE_SIZE) >= fill;
  /** @type {Array<'bridge'|'roof'|null>} */
  const deck = Array.from({ length: columns }, (_, index) => {
    if (onTop[index]) return null;
    // A bridge: solid from the lane all the way up.
    let bridge = true;
    for (let block = 0; block < OVERPASS_BLOCKS && bridge; block++) bridge = solid(index, block);
    if (bridge) return 'bridge';
    // A roof: a building whose roof overhangs the lane from below, solid in
    // the lane's own block and on down into the building under it. Route 7's
    // lane runs along the top of a house's roof, and the companion walked
    // across the roof where a player in the games walks behind its edge. A
    // roof's edge is a straight line filling the whole block; a tree line's
    // crowns overhang the same way but round, never filling it — see
    // `ROOF_FILL` — and are left out for the reason `OVERPASS_BLOCKS` gives.
    return solid(index, 0, ROOF_FILL) && solid(index, -1, ROOF_FILL) ? 'roof' : null;
  });
  // The railings either side of the deck are thinner than the deck, and are
  // as much the bridge as it is.
  const kinds = deck.map(
    (kind, index) =>
      kind ??
      (!onTop[index] && drawnIn(index * METATILE_SIZE, groundY) > 0 ? (deck[index - 1] ?? deck[index + 1] ?? null) : null),
  );
  const keep = kinds.map(Boolean);
  // A tree whose crown overhangs the lane from the row below: only the
  // lane's own block of it is kept, so the companion walks behind the top of
  // the tree as a player in the games does, feet hidden and the rest showing.
  // Any of it at all: Fire Red's trees put only the tip of the crown on the
  // layer, a sliver of the block, and the companion walked across that tip.
  const crown = keep.map((kept, index) => !kept && !onTop[index] && drawnIn(index * METATILE_SIZE, groundY) > 0);
  if (!keep.some(Boolean) && !crown.some(Boolean)) return null;

  // What hides the companion whole, a bridge's worth and a roof's worth apart:
  // the two keep events back by different margins.
  const copyOf = (kind) =>
    kinds.includes(kind) ? { width: over.width, height: over.height, data: Uint8Array.from(over.data) } : null;
  const blocking = copyOf('bridge');
  const roofing = copyOf('roof');
  const clear = (raster, index, keepFrom = Infinity, keepTo = -Infinity) => {
    for (let y = 0; y < raster.height; y++) {
      if (y >= keepFrom && y < keepTo) continue;
      for (let x = index * METATILE_SIZE; x < (index + 1) * METATILE_SIZE; x++) raster.data[(y * raster.width + x) * 4 + 3] = 0;
    }
  };
  keep.forEach((kept, index) => {
    if (blocking && kinds[index] !== 'bridge') clear(blocking, index);
    if (roofing && kinds[index] !== 'roof') clear(roofing, index);
    if (kept) return;
    if (crown[index]) clear(over, index, groundY - METATILE_SIZE, groundY);
    else clear(over, index);
  });
  return { overlay: over, blocking, roofing };
}

/**
 * How much of a long-grass block, from the ground up, is drawn over the
 * companion. The cartridge draws the whole block over a walker's feet, which
 * hides a person — 32 pixels tall — to the waist; a Charmander on the road is
 * twenty, and the whole block buried it to the eyes. Half a block hides it to
 * the waist the same way, and the tips of the blades stand behind it.
 */
const LONG_GRASS_DEPTH = METATILE_SIZE / 2;

/**
 * Which pixels of a grass block are blades a walker goes behind, from each
 * game's own picture of a walker in it (`graphics/field_effects/pics/`, the
 * first frame — a walker standing still — which is the same art as the
 * block's own). Colour 0 is clear on the Game Boy Advance; in the long grass,
 * colour 13 is the ground between the blades, which shows the walker through
 * rather than drawing over it. Tall grass is only blades at the bottom of
 * its block, and is taken whole.
 *
 * Fire Red has its own tall grass, drawn a little differently from
 * Emerald's, and no long grass.
 *
 * @param {string} game
 * @returns {Promise<{long: boolean[]|null, tall: boolean[]}>} one per pixel of
 *   a block, row by row; the long grass only the bottom
 *   {@link LONG_GRASS_DEPTH} rows of it
 */
async function loadGrassMasks(game) {
  const base = game === 'firered' ? FIRERED : EMERALD;
  /** @param {string} name @param {(index: number, y: number) => boolean} blade */
  const maskOf = async (name, blade) => {
    const picture = decodePng(await fetchBuffer(`${base}/graphics/field_effects/pics/${name}.png`));
    const mask = [];
    for (let y = 0; y < METATILE_SIZE; y++) {
      for (let x = 0; x < METATILE_SIZE; x++) mask.push(blade(picture.indices?.[y * picture.width + x] ?? 0, y));
    }
    return mask;
  };
  return {
    long: game === 'firered' ? null : await maskOf('long_grass', (index, y) => y >= METATILE_SIZE - LONG_GRASS_DEPTH && index !== 0 && index !== 13),
    tall: await maskOf('tall_grass', (index) => index !== 0),
  };
}

/**
 * Draw the blades of each grass block of the lane onto the band's
 * over-the-sprites layer, in the map's own pixels, wherever that layer has
 * nothing of its own.
 *
 * @param {import('../lib/image.mjs').Raster} over the band's top layer, written to
 * @param {import('../lib/image.mjs').Raster} band the band as drawn
 * @param {number} groundY the bottom edge of the lane's row, in the band
 * @param {(index: number) => boolean[]|null} maskFor per block column of the
 *   band, the blades of the grass on it (see {@link loadGrassMasks}), or null
 */
export function sinkIntoGrass(over, band, groundY, maskFor) {
  const columns = Math.floor(band.width / METATILE_SIZE);
  for (let index = 0; index < columns; index++) {
    const mask = maskFor(index);
    if (!mask) continue;
    for (let y = 0; y < METATILE_SIZE; y++) {
      const row = groundY - METATILE_SIZE + y;
      if (row < 0 || row >= band.height) continue;
      for (let x = 0; x < METATILE_SIZE; x++) {
        if (!mask[y * METATILE_SIZE + x]) continue;
        const offset = (row * band.width + index * METATILE_SIZE + x) * 4;
        if (over.data[offset + 3] > 0) continue;
        for (let channel = 0; channel < 4; channel++) over.data[offset + channel] = band.data[offset + channel];
      }
    }
  }
}

/** Which rows beside the lane are looked at for water, nearest first: in front, behind, then two out. */
const WATER_ROWS = [1, -1, 2, -2];

/**
 * A value per block column of the walked band, as `[from, to, value]` pixel
 * runs of the finished strip — laid out the way the band itself is: the band,
 * then its mirror image (`makeSeamless`), repeated until the strip is
 * `minWidth` wide (`repeatToWidth`). Columns whose value is null are left out.
 *
 * @template T
 * @param {Array<T|null>} values one per block column of the band
 * @param {number} blockSize pixels per block
 * @param {number} minWidth
 * @returns {Array<[number, number, T]>}
 */
export function stripRuns(values, blockSize, minWidth) {
  const band = values.flatMap((value) => new Array(blockSize).fill(value));
  const seamless = [...band, ...[...band].reverse()];
  const copies = seamless.length >= minWidth ? 1 : Math.ceil(minWidth / seamless.length);
  const strip = new Array(copies).fill(seamless).flat();

  /** @type {Array<[number, number, T]>} */
  const runs = [];
  let start = 0;
  for (let x = 1; x <= strip.length; x++) {
    if (x < strip.length && strip[x] === strip[start]) continue;
    if (strip[start] !== null && strip[start] !== undefined) runs.push([start, x, strip[start]]);
    start = x;
  }
  return runs;
}

/**
 * The stretches of a finished overlay strip that cover the lane, as
 * `[from, to)` pixel spans.
 *
 * @param {import('../lib/image.mjs').Raster} strip
 * @param {number} groundY
 * @returns {Array<[number, number]>}
 */
function coveredSpans(strip, groundY) {
  /** @type {Array<[number, number]>} */
  const spans = [];
  let start = -1;
  for (let x = 0; x <= strip.width; x++) {
    let covers = false;
    for (let y = groundY - METATILE_SIZE; x < strip.width && y < groundY && !covers; y++) {
      covers = strip.data[(y * strip.width + x) * 4 + 3] > 0;
    }
    if (covers && start < 0) start = x;
    if (!covers && start >= 0) {
      spans.push([start, x]);
      start = -1;
    }
  }
  return spans;
}

/**
 * The track a map plays, as the audio step names it.
 *
 * Emerald's own maps name their tracks directly. Fire Red's name Fire Red's
 * — `MUS_ROUTE1` — and Emerald's sound folder carries the same songs under an
 * `mus_rg_` prefix, which is where the audio step fetches every track from.
 *
 * @param {string|undefined} constant
 * @param {string} game
 */
function musicFor(constant, game) {
  if (!constant || constant === 'MUS_NONE') return null;
  const name = constant.toLowerCase();
  return game === 'firered' ? name.replace(/^mus_/, 'mus_rg_') : name;
}

/**
 * Encounter tables from the decompilation, flattened to
 * `{species, minLevel, maxLevel, weight, water?}` per map, `weight` being the
 * species' share of the map's encounters in per cent, `water` how much of
 * that share is met surfing or fishing, as a fraction — which a Dive Ball
 * counts — and `fishing` how much of it on a rod, which a Lure Ball does. A
 * species only ever met on foot has neither.
 *
 * The share is the cartridge's own: a table is twelve land slots at 20, 20,
 * 10, 10, 10, 10, 5, 5, 4, 4, 1 and 1 per cent, and a species is the sum of
 * the slots it fills. This used to keep only the list of species, so every
 * Pokémon a map named was drawn as often as every other — Route 113's
 * Skarmory, one slot in twenty, as often as its Spinda, seven in ten.
 *
 * A map's tables are the ways of meeting something there — walking the
 * grass, surfing, fishing, smashing rocks — each with its own rates deciding
 * within it. Walking is half of the map where it has a walking table, since
 * the companion is on foot; the rest share the other half. So a lakeside
 * route's Magikarp and Tentacool are still on it, as they always were, but
 * a pond's one surfing species does not outnumber the route it sits on.
 *
 * Fire Red files each map twice, once per version; the two are merged, so a
 * route has both games' Pokémon on it, each version's table counting for
 * half.
 *
 * @param {string} base the decompilation's URL
 * @returns {Promise<Map<string, Array<{species: string, minLevel: number, maxLevel: number, weight: number, water?: number, fishing?: number}>>>}
 */
async function loadEncounterTables(base) {
  const data = await fetchJson(`${base}/src/data/wild_encounters.json`);
  const group = data.wild_encounter_groups.find((entry) => entry.label === 'gWildMonHeaders');
  /** @type {Record<string, number[]>} each method's slot rates, in per cent */
  const rates = Object.fromEntries(group.fields.map((field) => [field.type, field.encounter_rates]));

  /** @type {Map<string, Map<string, {species: string, minLevel: number, maxLevel: number, weight: number, water: number, fishing: number}>>} */
  const byMap = new Map();
  /** @type {Map<string, number>} how many tables each map has, so versions share it */
  const tables = new Map();

  for (const entry of group.encounters) {
    const methods = ['land_mons', 'water_mons', 'rock_smash_mons', 'fishing_mons'].filter((field) => entry[field]?.mons?.length);
    if (!methods.length) continue;
    const merged = byMap.get(entry.map) ?? new Map();
    byMap.set(entry.map, merged);
    tables.set(entry.map, (tables.get(entry.map) ?? 0) + 1);

    for (const field of methods) {
      const slots = entry[field].mons ?? [];
      const slotRates = rates[field] ?? [];
      // Fishing's rates are three rods' worth, each summing to a hundred.
      const total = slotRates.slice(0, slots.length).reduce((sum, rate) => sum + rate, 0) || 1;
      slots.forEach((mon, slot) => {
        // `SPECIES_NIDORAN_F` -> `nidoran-f`, matching PokeAPI's slugs.
        const species = mon.species.replace('SPECIES_', '').toLowerCase().replace(/_/g, '-');
        const share = ((slotRates[slot] ?? 0) / total) * methodShare(field, methods);
        const water = WATER_METHODS.has(field) ? share : 0;
        const fishing = field === 'fishing_mons' ? share : 0;
        const existing = merged.get(species);
        if (existing) {
          existing.minLevel = Math.min(existing.minLevel, mon.min_level);
          existing.maxLevel = Math.max(existing.maxLevel, mon.max_level);
          existing.weight += share;
          existing.water += water;
          existing.fishing += fishing;
        } else {
          merged.set(species, { species, minLevel: mon.min_level, maxLevel: mon.max_level, weight: share, water, fishing });
        }
      });
    }
  }

  /** @type {Map<string, Array<{species: string, minLevel: number, maxLevel: number, weight: number, water?: number, fishing?: number}>>} */
  const out = new Map();
  for (const [map, merged] of byMap) {
    const versions = tables.get(map) ?? 1;
    out.set(
      map,
      [...merged.values()]
        .map(({ water, fishing, ...mon }) => {
          const fraction = (part) => (mon.weight > 0 ? Math.round((part / mon.weight) * 100) / 100 : 0);
          const wet = fraction(water);
          const rod = fraction(fishing);
          return {
            ...mon,
            weight: Math.round((mon.weight / versions) * 100) / 100,
            ...(wet > 0 ? { water: wet } : {}),
            ...(rod > 0 ? { fishing: rod } : {}),
          };
        })
        .sort((a, b) => b.weight - a.weight),
    );
  }
  return out;
}

/** The tables met on the water rather than on foot or under a rock. */
const WATER_METHODS = new Set(['water_mons', 'fishing_mons']);

/**
 * How much of a map, in per cent, one of its ways of meeting Pokémon is.
 *
 * @param {string} field
 * @param {string[]} methods every table the map has
 */
function methodShare(field, methods) {
  if (!methods.includes('land_mons') || methods.length === 1) return 100 / methods.length;
  return field === 'land_mons' ? 50 : 50 / (methods.length - 1);
}

/**
 * The official name of each shipped location in every language PokeAPI has one
 * for, left as PokeAPI's own list so the caller can bundle it against the right
 * fallback. Hoenn is the region with the widest coverage, which is why the game
 * stays in it.
 *
 * @param {<T>(task: () => Promise<T>) => Promise<T>} pool
 * @returns {Promise<Map<string, Array<{name: string, language: {name: string}}>>>}
 */
async function loadLocationNames(pool) {
  const wanted = new Set(AREAS.map((area) => area.location));
  const index = await fetchJson(`${POKEAPI}/location/index.json`);
  /** @type {Map<string, Array<{name: string, language: {name: string}}>>} */
  const names = new Map();

  await Promise.all(
    index.results
      .filter((entry) => wanted.has(entry.name))
      .map((entry) =>
        pool(async () => {
          const location = await fetchJson(`${POKEAPI}${entry.url.replace('/api/v2', '')}index.json`);
          names.set(entry.name, location.names ?? []);
        }),
      ),
  );
  return names;
}

/** `hoenn-route-101` -> `Hoenn Route 101` */
function titleize(slug) {
  return slug
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
