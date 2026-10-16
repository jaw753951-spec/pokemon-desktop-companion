/**
 * RGBA raster helpers shared by the asset build steps.
 *
 * Everything here works on plain `{width, height, data}` records holding
 * straight (non-premultiplied) RGBA8, which is what `png.mjs` hands back and
 * what `encodePng` expects.
 */

/**
 * @typedef {Object} Raster
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array|Buffer} data
 */

/**
 * @param {number} width
 * @param {number} height
 * @returns {Raster}
 */
export function createRaster(width, height) {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/**
 * @param {Raster} source
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @returns {Raster}
 */
export function crop(source, x, y, width, height) {
  const out = createRaster(width, height);
  for (let row = 0; row < height; row++) {
    const sourceY = y + row;
    if (sourceY < 0 || sourceY >= source.height) continue;
    for (let column = 0; column < width; column++) {
      const sourceX = x + column;
      if (sourceX < 0 || sourceX >= source.width) continue;
      const from = (sourceY * source.width + sourceX) * 4;
      const to = (row * width + column) * 4;
      out.data[to] = source.data[from];
      out.data[to + 1] = source.data[from + 1];
      out.data[to + 2] = source.data[from + 2];
      out.data[to + 3] = source.data[from + 3];
    }
  }
  return out;
}

/** @param {Raster} source @returns {Raster} */
export function mirrorX(source) {
  const out = createRaster(source.width, source.height);
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const from = (y * source.width + (source.width - 1 - x)) * 4;
      const to = (y * source.width + x) * 4;
      out.data.set(source.data.subarray(from, from + 4), to);
    }
  }
  return out;
}

/**
 * Concatenate rasters left to right. They must share a height.
 * @param {Raster[]} parts
 * @returns {Raster}
 */
export function concatX(parts) {
  const height = parts[0].height;
  const width = parts.reduce((sum, part) => sum + part.width, 0);
  const out = createRaster(width, height);
  let offset = 0;
  for (const part of parts) {
    for (let y = 0; y < height; y++) {
      const from = y * part.width * 4;
      out.data.set(part.data.subarray(from, from + part.width * 4), (y * width + offset) * 4);
    }
    offset += part.width;
  }
  return out;
}

/**
 * Turn a band into a strip that loops without a seam, by appending its mirror
 * image ("ping-pong" tiling). Mirrored terrain reads naturally in a top-down
 * map, and both joins are pixel-exact.
 *
 * The mirror is taken whole, its edge column and all, so the two joins fall
 * on block boundaries: a block at either end of the band comes back as itself
 * and its mirror image side by side, two flowers where the map had one. The
 * mirror used to be taken around the band's last column of pixels, which
 * folded whatever stood in the end block into one symmetric shape half again
 * as wide — a flower became a cross, a patch's rim a line down the middle of
 * the road.
 *
 * Text does not mirror. Each rectangle in `upright` — a sign board — is put
 * back the right way round where the mirror image lays it down.
 *
 * @param {Raster} band
 * @param {Array<{x: number, y: number, width: number, height: number}>} [upright]
 * @returns {Raster}
 */
export function makeSeamless(band, upright = []) {
  const strip = concatX([band, mirrorX(band)]);
  for (const { x, y, width, height } of upright) {
    const at = 2 * band.width - x - width;
    for (let row = y; row < y + height; row++) {
      const from = (row * band.width + x) * 4;
      strip.data.set(band.data.subarray(from, from + width * 4), (row * strip.width + at) * 4);
    }
  }
  return strip;
}

/**
 * Where a band should end, at each side, so that the strip's two mirror
 * joins read as the map going on rather than as a seam.
 *
 * A join at the right edge of a block column puts that column's mirror image
 * next to it, where the map has its next column. When the two look alike —
 * open ground, a tree line, the middle of a road — the join cannot be told
 * from the map. When they do not, the mirror makes something the map never
 * had: a sand patch's rim against its own mirror image is a line of grass
 * down the road, a flower against its own is a pair grown into one, half a
 * dome against its own half is a building no one built. So each block on the
 * edge column is compared, blurred to its colours, with its neighbour across
 * the join, and what differs by more than a tile's own texture is counted
 * against the join.
 *
 * The run is then cut to the pair of ends whose joins cost least, with
 * length weighed against it: anything under {@link LOOP_GOOD_BLOCKS} is
 * charged for being short, since a short loop shows the same scenery over and
 * over, and none is cut below {@link LOOP_MIN_BLOCKS}.
 *
 * @param {Raster} image the whole map, everything on it drawn
 * @param {number} widthInBlocks the map's width
 * @param {number} bandRow the band's first block row
 * @param {number} bandBlocks how many block rows it spans
 * @param {number} column the walkable run's first block column
 * @param {number} columns how long the run is
 * @param {number} [blockSize]
 * @returns {{column: number, columns: number}}
 */
export function pickLoopEnds(image, widthInBlocks, bandRow, bandBlocks, column, columns, blockSize = 16) {
  /** @type {Map<number, Float32Array>} */
  const looks = new Map();
  const look = (x, y) => {
    const key = y * widthInBlocks + x;
    if (!looks.has(key)) looks.set(key, blockColours(image, x, y, blockSize));
    return /** @type {Float32Array} */ (looks.get(key));
  };
  // What a join at the given side of a block column costs: `side` is -1 for
  // its left edge, 1 for its right.
  const joinCost = (x, side) => {
    const next = x + side;
    if (next < 0 || next >= widthInBlocks) return Infinity;
    let cost = 0;
    for (let y = bandRow; y < bandRow + bandBlocks; y++) {
      cost += Math.max(0, colourDistance(mirrorColours(look(x, y)), look(next, y)) - TEXTURE_ALLOWANCE);
    }
    return cost;
  };

  const shortest = Math.min(columns, LOOP_MIN_BLOCKS);
  let best = { column, columns, score: Infinity };
  for (let first = column; first < column + columns; first++) {
    const left = joinCost(first, -1);
    for (let last = first + shortest - 1; last < column + columns; last++) {
      const length = last - first + 1;
      const score = left + joinCost(last, 1) + SHORT_LOOP_COST * Math.max(0, LOOP_GOOD_BLOCKS - length) - length / 10;
      if (score < best.score) best = { column: first, columns: length, score };
    }
  }
  return { column: best.column, columns: best.columns };
}

/** The fewest blocks a band is cut down to; a strip is twice this, mirrored. */
const LOOP_MIN_BLOCKS = 8;

/** A band shorter than this is charged {@link SHORT_LOOP_COST} a block for it. */
const LOOP_GOOD_BLOCKS = 16;
const SHORT_LOOP_COST = 8;

/**
 * How far apart, per colour channel on average, two blurred blocks can be and
 * still pass for the same ground: grass against its mirror image differs by
 * its blades, which the eye does not follow across a join.
 */
const TEXTURE_ALLOWANCE = 20;

/** A block blurred to two columns of four cells each, as mean RGB. */
const COLOUR_COLUMNS = 2;
const COLOUR_ROWS = 4;

/**
 * @param {Raster} image
 * @param {number} blockX
 * @param {number} blockY
 * @param {number} blockSize
 */
function blockColours(image, blockX, blockY, blockSize) {
  const out = new Float32Array(COLOUR_COLUMNS * COLOUR_ROWS * 3);
  const cellWidth = blockSize / COLOUR_COLUMNS;
  const cellHeight = blockSize / COLOUR_ROWS;
  for (let cellY = 0; cellY < COLOUR_ROWS; cellY++) {
    for (let cellX = 0; cellX < COLOUR_COLUMNS; cellX++) {
      const sum = [0, 0, 0];
      for (let y = 0; y < cellHeight; y++) {
        for (let x = 0; x < cellWidth; x++) {
          const offset = ((blockY * blockSize + cellY * cellHeight + y) * image.width + blockX * blockSize + cellX * cellWidth + x) * 4;
          for (let channel = 0; channel < 3; channel++) sum[channel] += image.data[offset + channel];
        }
      }
      for (let channel = 0; channel < 3; channel++) {
        out[(cellY * COLOUR_COLUMNS + cellX) * 3 + channel] = sum[channel] / (cellWidth * cellHeight);
      }
    }
  }
  return out;
}

/** @param {Float32Array} colours */
function mirrorColours(colours) {
  const out = new Float32Array(colours.length);
  for (let cellY = 0; cellY < COLOUR_ROWS; cellY++) {
    for (let cellX = 0; cellX < COLOUR_COLUMNS; cellX++) {
      for (let channel = 0; channel < 3; channel++) {
        out[(cellY * COLOUR_COLUMNS + cellX) * 3 + channel] = colours[(cellY * COLOUR_COLUMNS + COLOUR_COLUMNS - 1 - cellX) * 3 + channel];
      }
    }
  }
  return out;
}

/** @param {Float32Array} a @param {Float32Array} b */
function colourDistance(a, b) {
  let sum = 0;
  for (let index = 0; index < a.length; index++) sum += Math.abs(a[index] - b[index]);
  return sum / a.length;
}

/**
 * One raster laid over another of the same size, where the top one is drawn.
 *
 * @param {Raster} base
 * @param {Raster} top
 * @returns {Raster}
 */
export function overlay(base, top) {
  const out = { width: base.width, height: base.height, data: Uint8Array.from(base.data) };
  for (let offset = 0; offset < out.data.length; offset += 4) {
    const alpha = top.data[offset + 3] / 255;
    if (!alpha) continue;
    for (let channel = 0; channel < 3; channel++) {
      out.data[offset + channel] = Math.round(top.data[offset + channel] * alpha + out.data[offset + channel] * (1 - alpha));
    }
  }
  return out;
}

/**
 * Repeat a seamless strip until it is at least `minWidth` wide, so the field
 * scene can always scroll a full view width past the wrap point.
 *
 * @param {Raster} strip
 * @param {number} minWidth
 * @returns {Raster}
 */
export function repeatToWidth(strip, minWidth) {
  if (strip.width >= minWidth) return strip;
  const copies = Math.ceil(minWidth / strip.width);
  return concatX(new Array(copies).fill(strip));
}

/**
 * Colour grades applied to an area background to suggest the time of day.
 * Values are `[multiply r,g,b, add r,g,b]` in 0..1 / -255..255.
 * @type {Record<string, {multiply: [number, number, number], add: [number, number, number]}>}
 */
export const TIME_GRADES = {
  // 아침 — cool, slightly hazy dawn light
  dawn: { multiply: [1.0, 0.96, 0.95], add: [14, 6, 16] },
  // 점심 — the unmodified daytime palette
  day: { multiply: [1.0, 1.0, 1.0], add: [0, 0, 0] },
  // 오후 — low golden sun
  afternoon: { multiply: [1.04, 0.98, 0.86], add: [10, 2, -6] },
  // 저녁 — sunset reds bleeding into shadow
  dusk: { multiply: [0.92, 0.72, 0.68], add: [26, 2, 8] },
  // 밤 — moonlit blue, well darkened
  night: { multiply: [0.48, 0.52, 0.78], add: [2, 4, 22] },
};

/** @type {Array<keyof typeof TIME_GRADES>} */
export const TIME_KEYS = ['dawn', 'day', 'afternoon', 'dusk', 'night'];

/**
 * @param {Raster} source
 * @param {keyof typeof TIME_GRADES} time
 * @returns {Raster}
 */
export function gradeTime(source, time) {
  const { multiply, add } = TIME_GRADES[time];
  const out = createRaster(source.width, source.height);
  for (let i = 0; i < source.width * source.height; i++) {
    const offset = i * 4;
    out.data[offset] = clamp8(source.data[offset] * multiply[0] + add[0]);
    out.data[offset + 1] = clamp8(source.data[offset + 1] * multiply[1] + add[1]);
    out.data[offset + 2] = clamp8(source.data[offset + 2] * multiply[2] + add[2]);
    out.data[offset + 3] = source.data[offset + 3];
  }
  return out;
}

const clamp8 = (value) => (value < 0 ? 0 : value > 255 ? 255 : value | 0);

/**
 * Tight bounding box of non-transparent pixels, or null when fully transparent.
 * @param {Raster} source
 * @returns {{x: number, y: number, width: number, height: number}|null}
 */
export function opaqueBounds(source) {
  let minX = source.width;
  let minY = source.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      if (source.data[(y * source.width + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Make a colour fully transparent wherever it appears. GBA sprite sheets mark
 * transparency with palette entry 0 rather than an alpha channel.
 * @param {Raster} source
 * @param {[number, number, number]} color
 * @returns {Raster}
 */
export function keyOut(source, color) {
  const out = { width: source.width, height: source.height, data: Uint8Array.from(source.data) };
  for (let i = 0; i < source.width * source.height; i++) {
    const offset = i * 4;
    if (out.data[offset] === color[0] && out.data[offset + 1] === color[1] && out.data[offset + 2] === color[2]) {
      out.data[offset + 3] = 0;
    }
  }
  return out;
}

/**
 * How many blocks of unbroken walkable ground a strip has to have before it is
 * worth cutting the area out of.
 *
 * Under this the loop is so short the repeat is all you see, so a shorter run
 * of ground is traded for a taller sprite: the search drops a row of headroom
 * and tries again.
 */
const MIN_RUN_BLOCKS = 12;

/**
 * Find the stretch of map the companion can actually walk along.
 *
 * This used to be two steps — choose a horizontal band of the map, then the
 * *best* row inside it — scoring rows by the share of their blocks that were
 * passable, and charging each row for how many distinct metatiles it used so
 * a tree line lost to open ground. A share is not a promise:
 * every one of the thirty shipped areas ended up on a lane with blocks in it
 * the sprite had no business crossing, and Route 112 — where a lane that is
 * ninety per cent clear runs straight at the side of a hill — is where it
 * showed. A map-wide row that is passable end to end does not exist either:
 * every map has impassable edges, so there is nothing to find.
 *
 * So the strip is **cut down to the walk** instead of the walk being fitted to
 * the strip. This looks for the longest unbroken run of blocks where the
 * sprite's feet *and* the rows its body passes through are all passable, and
 * hands back both the row and the columns it runs between; the caller crops
 * the background to exactly that, and the companion is then on walkable ground
 * at every point of a loop that has no impassable block in it at all.
 *
 * Headroom is given up before ground is: a cave with nothing twelve blocks
 * long and three rows tall is searched again for two rows, and then for the
 * feet alone, so a tight interior clips a shoulder rather than shrinking to a
 * four-block loop.
 *
 * @param {Buffer} blockdata `map.bin`, uint16 per block with collision in bits 10-11
 * @param {number} widthInBlocks
 * @param {number} heightInBlocks
 * @param {number} bandBlocks how many block rows the strip spans
 * @param {(x: number, y: number) => boolean} [isWater] blocks the collision
 *   leaves open but a Pokémon could only cross by surfing — Route 103's lake
 *   among them, which the walk used to stroll across
 * @param {number} [lane] the map row to walk along, where the area names one:
 *   the run is then the longest on that row, with as much headroom as it has
 * @returns {{bandRow: number, laneRow: number, column: number, columns: number, clearance: number}}
 */
export function pickWalkPath(blockdata, widthInBlocks, heightInBlocks, bandBlocks, isWater = () => false, lane = undefined) {
  const passable = (x, y) => {
    const offset = (y * widthInBlocks + x) * 2;
    if (offset + 1 >= blockdata.length) return false;
    return ((blockdata.readUInt16LE(offset) >> 10) & 0x03) === 0 && !isWater(x, y);
  };

  /**
   * The longest clear run anywhere on the map, at this much headroom and no
   * higher up the map than `minRow`.
   *
   * The floor matters: the strip is anchored to the bottom of the window, so a
   * lane found on the map's very top row would put the companion's feet a few
   * pixels below the top edge of the screen with the whole map hanging under
   * it. Seafloor Cavern's longest clear run really is its top row.
   */
  const longestRun = (clearance, minRow, maxRow = heightInBlocks - 1) => {
    /** @type {{laneRow: number, column: number, columns: number}|null} */
    let best = null;
    for (let y = Math.max(clearance, minRow); y <= Math.min(maxRow, heightInBlocks - 1); y++) {
      let run = 0;
      let start = 0;
      for (let x = 0; x <= widthInBlocks; x++) {
        let clear = x < widthInBlocks;
        for (let above = 0; clear && above <= clearance; above++) clear = passable(x, y - above);

        if (clear) {
          if (run === 0) start = x;
          run++;
          continue;
        }
        if (run > 0 && (!best || run > best.columns)) best = { laneRow: y, column: start, columns: run };
        run = 0;
      }
    }
    return best;
  };

  const wanted = Math.min(2, Math.max(0, bandBlocks - 1));
  const above = Math.min(heightInBlocks - 1, Math.round((bandBlocks - 1) * LANE_IN_BAND));

  /** @type {{laneRow: number, column: number, columns: number, clearance: number}|null} */
  let chosen = null;
  // Lanes that can sit where a walking sprite reads best are looked for first:
  // far enough down the map to have the band's worth of map above them, and
  // far enough up to have the rest below. A lane on the map's last few rows
  // slides the band up against the bottom edge and puts the companion's feet
  // down by the window's bottom edge — Route 121's did, on its very last row.
  // Only a map with nothing in that middle settles for one nearer an edge.
  const lowest = heightInBlocks - bandBlocks + above;
  const searches = lane === undefined ? [[above, lowest], [above, heightInBlocks - 1], [0, heightInBlocks - 1]] : [[lane, lane]];
  for (const [minRow, maxRow] of searches) {
    for (let clearance = wanted; clearance >= 0; clearance--) {
      const found = longestRun(clearance, minRow, maxRow);
      if (!found) continue;
      // Keep the roomiest one seen so far, so dropping to no headroom at all
      // still cannot make the strip shorter than it already was.
      if (!chosen || found.columns > chosen.columns) chosen = { ...found, clearance };
      // On a row the area names, the walk is the point rather than the
      // headroom: the longest run on it wins, at whatever headroom it has.
      if (lane === undefined && chosen.columns >= MIN_RUN_BLOCKS) break;
    }
    if (chosen) break;
  }

  // A map with nothing passable on it at all: fall back to the whole width at
  // the band's own reading height rather than producing an empty strip.
  if (!chosen) {
    const bandRow = Math.max(0, Math.min(heightInBlocks - bandBlocks, 0));
    return {
      bandRow,
      laneRow: bandRow + Math.round((bandBlocks - 1) * LANE_IN_BAND),
      column: 0,
      columns: widthInBlocks,
      clearance: 0,
    };
  }

  // The lane sits where a walking sprite reads best inside the strip, with the
  // strip slid back inside the map at the top and bottom edges.
  const bandRow = Math.max(0, Math.min(heightInBlocks - bandBlocks, chosen.laneRow - above));
  return { bandRow, laneRow: chosen.laneRow, column: chosen.column, columns: chosen.columns, clearance: chosen.clearance };
}

/** Where down the strip the walked row sits, as a fraction of its height. */
const LANE_IN_BAND = 0.62;
