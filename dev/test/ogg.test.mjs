/**
 * The Ogg container the cries are re-encoded into: what is written reads back
 * as the same packets, with the header, the trimming and the checksums right.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { oggOpus, readOgg } from '../tools/lib/ogg.mjs';

const packet = (size, fill) => ({ data: new Uint8Array(size).fill(fill), samples: 960 });

test('an Ogg Opus file reads back as its header, its tags and its packets, every page checked', () => {
  // A packet over 255 bytes, one of exactly 255, and small ones.
  const packets = [packet(40, 1), packet(300, 2), packet(255, 3), packet(12, 4)];
  const file = oggOpus({ packets, preSkip: 312, samples: 3500, inputRate: 32728 });
  const pages = readOgg(file);

  assert.ok(pages.every((page) => page.crcOk), 'every checksum holds');
  assert.deepEqual(pages.map((page) => page.sequence), pages.map((_, index) => index));
  assert.equal(pages[0].flags & 0x02, 0x02, 'the first page begins the stream');
  assert.equal(pages.at(-1).flags & 0x04, 0x04, 'the last ends it');

  const head = pages[0].packets[0];
  assert.equal(new TextDecoder().decode(head.subarray(0, 8)), 'OpusHead');
  assert.equal(head[9], 1, 'one channel');
  assert.equal(head[10] | (head[11] << 8), 312, 'the pre-skip');
  assert.equal(new TextDecoder().decode(pages[1].packets[0].subarray(0, 8)), 'OpusTags');

  const audio = pages.slice(2).flatMap((page) => page.packets);
  assert.deepEqual(audio.map((data) => data.length), [40, 300, 255, 12]);
  assert.ok(audio.every((data, index) => data.every((byte) => byte === index + 1)));
  // Four packets of 960 is 3840 samples; the sound is 3500, so the last page
  // says where it really ends and the rest is trimmed.
  assert.equal(pages.at(-1).granule, 312n + 3500n);
});

test('a long sound is spread over pages, each ending where its last packet does', () => {
  const packets = Array.from({ length: 400 }, (_, index) => packet(20 + (index % 7), index % 250));
  const samples = 400 * 960 - 100;
  const pages = readOgg(oggOpus({ packets, preSkip: 312, samples }));
  assert.ok(pages.length > 3, 'more than one page of audio');
  const audio = pages.slice(2);
  assert.equal(audio.flatMap((page) => page.packets).length, 400);
  // Granules never go back, and none but the last runs past the true end.
  for (let index = 1; index < audio.length; index++) assert.ok(audio[index].granule >= audio[index - 1].granule);
  let decoded = 312;
  for (const page of audio.slice(0, -1)) {
    decoded += page.packets.length * 960;
    assert.equal(page.granule, BigInt(Math.min(decoded, 312 + samples)));
  }
  assert.equal(audio.at(-1).granule, BigInt(312 + samples));
});
