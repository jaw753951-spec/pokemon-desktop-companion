import test from 'node:test';
import assert from 'node:assert/strict';

import { decodePng, encodePng } from '../tools/lib/png.mjs';
import {
  concatX,
  createRaster,
  crop,
  gradeTime,
  makeSeamless,
  mirrorX,
  opaqueBounds,
  pickLoopEnds,
  pickWalkPath,
} from '../tools/lib/image.mjs';
import { parseJascPal, tilesetDirName, combineMetatiles } from '../tools/lib/gba-gfx.mjs';

/** Build a small RGBA raster from a `(x, y) -> [r,g,b,a]` function. */
function raster(width, height, fn) {
  const out = createRaster(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out.data.set(fn(x, y), (y * width + x) * 4);
  }
  return out;
}

test('png encodes and decodes losslessly', () => {
  const source = raster(7, 5, (x, y) => [x * 30, y * 40, (x + y) * 10, x === 0 ? 0 : 255]);
  const decoded = decodePng(encodePng(source.width, source.height, source.data));
  assert.equal(decoded.width, 7);
  assert.equal(decoded.height, 5);
  assert.deepEqual([...decoded.data], [...source.data]);
});

test('crop clamps to the source bounds', () => {
  const source = raster(4, 4, (x, y) => [x, y, 0, 255]);
  const out = crop(source, 2, 2, 4, 4);
  assert.equal(out.width, 4);
  assert.deepEqual([...out.data.subarray(0, 4)], [2, 2, 0, 255]);
  // Outside the source stays zeroed rather than wrapping.
  assert.deepEqual([...out.data.subarray(8, 12)], [0, 0, 0, 0]);
});

test('mirrorX reverses columns', () => {
  const source = raster(3, 1, (x) => [x, 0, 0, 255]);
  const out = mirrorX(source);
  assert.deepEqual([out.data[0], out.data[4], out.data[8]], [2, 1, 0]);
});

test('concatX joins rasters left to right', () => {
  const a = raster(2, 2, () => [1, 0, 0, 255]);
  const b = raster(3, 2, () => [2, 0, 0, 255]);
  const out = concatX([a, b]);
  assert.equal(out.width, 5);
  assert.equal(out.data[0], 1);
  assert.equal(out.data[2 * 4], 2);
});

test('makeSeamless loops by mirroring the whole band, joins on its edges', () => {
  const band = raster(5, 1, (x) => [x * 10, 0, 0, 255]);
  const strip = makeSeamless(band);
  assert.equal(strip.width, 10);
  const column = (i) => strip.data[i * 4];
  // The band runs forward, then mirrors back, and wrapping past the end lands
  // on the band's first column again: each join is between a column and its
  // own mirror image, so nothing is folded into the end column.
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(column), [0, 10, 20, 30, 40, 40, 30, 20, 10, 0]);
});

test('makeSeamless keeps a sign the right way round in the mirror image', () => {
  const band = raster(6, 1, (x) => [x * 10, 0, 0, 255]);
  // A sign two pixels wide at x 1-2.
  const strip = makeSeamless(band, [{ x: 1, y: 0, width: 2, height: 1 }]);
  const column = (i) => strip.data[i * 4];
  // Mirrored, it lands at 9-10; it reads 10, 20 there, not 20, 10.
  assert.deepEqual([6, 7, 8, 9, 10, 11].map(column), [50, 40, 30, 10, 20, 0]);
});

test('pickLoopEnds keeps a mirror join off anything that would double into something new', () => {
  const block = 16;
  // Open ground, but for something in the left half of the blocks at either
  // end of the walkable run, columns 2 and 21.
  const width = 24;
  const map = raster(width * block, block, (x) =>
    [2, 21].includes(Math.floor(x / block)) && x % block < block / 2 ? [250, 250, 250, 255] : [40, 160, 80, 255],
  );
  // Ending the band on either of them, or on the block beside one, puts it
  // against its own mirror image: a shape the map does not have. The band is
  // cut in to the open ground past them.
  assert.deepEqual(pickLoopEnds(map, width, 0, 1, 2, 20, block), { column: 4, columns: 16 });
  // With nothing in the way, the whole run is kept, short of the map's edge.
  const open = raster(width * block, block, () => [40, 160, 80, 255]);
  assert.deepEqual(pickLoopEnds(open, width, 0, 1, 0, width, block), { column: 1, columns: 22 });
});

test('gradeTime darkens night and leaves day untouched', () => {
  const source = raster(1, 1, () => [200, 200, 200, 128]);
  const day = gradeTime(source, 'day');
  assert.deepEqual([...day.data], [200, 200, 200, 128]);

  const night = gradeTime(source, 'night');
  assert.ok(night.data[0] < 200 && night.data[2] < 200, 'night should darken');
  assert.ok(night.data[2] > night.data[0], 'night should skew blue');
  assert.equal(night.data[3], 128, 'alpha is preserved');
});

test('opaqueBounds finds the tight box, or null when empty', () => {
  const source = raster(5, 5, (x, y) => (x === 3 && y === 1 ? [1, 2, 3, 255] : [0, 0, 0, 0]));
  assert.deepEqual(opaqueBounds(source), { x: 3, y: 1, width: 1, height: 1 });
  assert.equal(opaqueBounds(raster(2, 2, () => [0, 0, 0, 0])), null);
});

/**
 * A map built from a picture: `.` is passable, `#` is not. One character per
 * block, one string per row.
 * @param {string[]} rows
 */
function blockMap(rows) {
  const width = rows[0].length;
  const blocks = Buffer.alloc(width * rows.length * 2);
  rows.forEach((row, y) => {
    [...row].forEach((cell, x) => {
      blocks.writeUInt16LE(cell === '.' ? 0 : 1 << 10, (y * width + x) * 2);
    });
  });
  return { blocks, width, height: rows.length };
}

test('pickWalkPath crops to ground the companion can actually cross', () => {
  // A route with a hill in the middle of the otherwise open row, which is
  // exactly the shape that had the companion walking through Route 112.
  const rows = [
    '##########',
    '...##.....',
    '...##.....',
    '...##.....',
    '##########',
  ];
  const { blocks, width, height } = blockMap(rows);
  const path = pickWalkPath(blocks, width, height, 4);

  // The five-block run to the right of the hill, not the three to its left.
  assert.equal(path.laneRow, 3);
  assert.equal(path.column, 5);
  assert.equal(path.columns, 5);
  assert.equal(path.clearance, 2);
  // And the strip is placed so the lane sits inside it.
  assert.ok(path.laneRow >= path.bandRow && path.laneRow < path.bandRow + 4);
  assert.ok(path.bandRow >= 0 && path.bandRow + 4 <= height);
});

test('pickWalkPath walks the row an area names, the longest run on it', () => {
  // A road two rows wide under a fence, and grass below it: left alone, the
  // lane is the grass, the only row with two clear rows over it. Named, the
  // road's nearer row is walked, along its whole length rather than the
  // stretch of it that happens to have the most headroom.
  const rows = [
    '##############',
    '##########....',
    '..............',
    '..............',
    '..............',
    '..............',
    '..............',
    '##############',
  ];
  const { blocks, width, height } = blockMap(rows);
  assert.equal(pickWalkPath(blocks, width, height, 5).laneRow, 4);

  const named = pickWalkPath(blocks, width, height, 5, undefined, 3);
  assert.equal(named.laneRow, 3);
  assert.equal(named.column, 0);
  assert.equal(named.columns, 14);
  assert.equal(named.clearance, 1);
});

test('pickWalkPath gives up headroom before it gives up ground', () => {
  // Nothing has two clear rows above it, but the bottom row runs clear for
  // the width of the map — a cave corridor.
  const rows = [
    '##########',
    '#........#',
    '#.####...#',
    '#........#',
    '##########',
  ];
  const { blocks, width, height } = blockMap(rows);
  const path = pickWalkPath(blocks, width, height, 4);

  assert.equal(path.columns, 8);
  assert.ok(path.clearance < 2, 'a corridor this tight cannot keep both rows of headroom');
});

test('pickWalkPath never walks a block it cannot cross', () => {
  const rows = [
    '..#.......',
    '..........',
    '....#.....',
    '..........',
    '.......#..',
    '..........',
  ];
  const { blocks, width, height } = blockMap(rows);
  const path = pickWalkPath(blocks, width, height, 4);

  const passable = (x, y) => (blocks.readUInt16LE((y * width + x) * 2) >> 10 & 0x03) === 0;
  for (let x = path.column; x < path.column + path.columns; x++) {
    for (let above = 0; above <= path.clearance; above++) {
      assert.ok(passable(x, path.laneRow - above), `block ${x},${path.laneRow - above} is not passable`);
    }
  }
});

test('pickWalkPath keeps the lane off the very top of the map', () => {
  // The longest clear run is the top row, which would leave the companion
  // standing a few pixels below the top edge of the window.
  const rows = [
    '..........',
    '####.#####',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
  ];
  const { blocks, width, height } = blockMap(rows);
  const path = pickWalkPath(blocks, width, height, 9);

  assert.ok(path.laneRow > 0, `lane landed on row ${path.laneRow}`);
  assert.ok(path.laneRow - path.bandRow >= 4, 'the lane sits low enough in the strip to read');
});

test('tilesetDirName converts decomp symbols to directory names', () => {
  assert.equal(tilesetDirName('gTileset_General'), 'general');
  assert.equal(tilesetDirName('gTileset_PetalburgWoods'), 'petalburg_woods');
  assert.equal(tilesetDirName('gTileset_MtPyre'), 'mt_pyre');
});

test('parseJascPal reads the 16 palette entries', () => {
  const text = ['JASC-PAL', '0100', '3', '24 41 82', '255 255 255', '0 0 0', ''].join('\r\n');
  assert.deepEqual(parseJascPal(Buffer.from(text, 'ascii')), [
    [24, 41, 82],
    [255, 255, 255],
    [0, 0, 0],
  ]);
});

test('combineMetatiles places secondary metatiles after the primary block', () => {
  const primary = Buffer.alloc(16 * 2); // two metatiles
  primary.writeUInt16LE(0x1234, 0);
  const secondary = Buffer.alloc(16);
  secondary.writeUInt16LE(0x0abc, 0);

  const combined = combineMetatiles(primary, secondary);
  assert.equal(combined[0], 0x1234);
  assert.equal(combined[512 * 8], 0x0abc);
  assert.equal(combined.length, (512 + 1) * 8);
});

test('every sprite the vendored sources list is in the repository, and nothing unlisted is', async () => {
  const { readdir, readFile: read } = await import('node:fs/promises');
  const { join, relative, sep } = await import('node:path');
  const { VENDOR_DIR } = await import('../tools/lib/vendor.mjs');
  const walk = async (dir) =>
    (await readdir(dir, { withFileTypes: true })).flatMap((entry) => entry).reduce(async (acc, entry) => {
      const list = await acc;
      const path = join(dir, entry.name);
      return entry.isDirectory() ? [...list, ...(await walk(path))] : [...list, path];
    }, Promise.resolve(/** @type {string[]} */ ([])));
  for (const source of ['pokeapi']) {
    const root = join(VENDOR_DIR, source);
    const index = JSON.parse(await read(join(root, 'index.json'), 'utf8'));
    assert.match(index.commit, /^[0-9a-f]{40}$/, `${source} is pinned to a commit`);
    // Paths as the index files them, with forward slashes on every OS.
    const files = (await walk(root)).map((path) => relative(root, path).split(sep).join('/')).filter((path) => path !== 'index.json');
    assert.deepEqual([...files].sort(), [...index.present].sort(), `${source}: index and files disagree`);
    assert.equal(index.present.filter((path) => index.absent.includes(path)).length, 0);
  }
});
