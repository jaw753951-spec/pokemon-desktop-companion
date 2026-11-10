/**
 * Opus packets in an Ogg file, as RFC 7845 lays one out: a page with the
 * stream's header, a page with its (empty) tags, and the audio on pages after
 * them, each saying how far into the stream its last packet ends.
 *
 * The cries are encoded by the browser's own Opus encoder (see
 * `dev/tools/encode-cries.mjs`), which hands back bare packets; this is the
 * container round them that the game's decoder reads.
 */

/** Opus always counts in 48 kHz samples, whatever rate went in. */
const OPUS_RATE = 48000;

/** The most lacing values one page can hold. */
const MAX_SEGMENTS = 255;

/** Ogg's CRC-32: polynomial 0x04c11db7, not reflected, starting from zero. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 24;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    table[i] = crc >>> 0;
  }
  return table;
})();

/** @param {Uint8Array} bytes */
export function oggCrc(bytes) {
  let crc = 0;
  for (const byte of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  return crc >>> 0;
}

/**
 * One page.
 *
 * @param {{packets: Uint8Array[], granule: bigint, sequence: number, serial: number, first?: boolean, last?: boolean}} page
 */
function oggPage({ packets, granule, sequence, serial, first = false, last = false }) {
  /** @type {number[]} */
  const lacing = [];
  for (const packet of packets) {
    let left = packet.length;
    // A packet is told in 255s, ended by one value under 255 — a nought, for
    // one that is an exact multiple.
    while (left >= 255) {
      lacing.push(255);
      left -= 255;
    }
    lacing.push(left);
  }
  const body = packets.reduce((sum, packet) => sum + packet.length, 0);
  const page = new Uint8Array(27 + lacing.length + body);
  const view = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  page[4] = 0; // version
  page[5] = (first ? 0x02 : 0) | (last ? 0x04 : 0);
  view.setBigInt64(6, granule, true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  // The CRC is worked out with its own field nought, and written in after.
  page[26] = lacing.length;
  page.set(lacing, 27);
  let at = 27 + lacing.length;
  for (const packet of packets) {
    page.set(packet, at);
    at += packet.length;
  }
  view.setUint32(22, oggCrc(page), true);
  return page;
}

/** How many lacing values a packet takes. */
const segmentsOf = (packet) => Math.floor(packet.length / 255) + 1;

/**
 * An Ogg Opus file of encoded packets.
 *
 * `preSkip` is how many samples the decoder drops from the front (the
 * encoder's own delay), and `samples` how long the sound really is, so the
 * last page can say where it ends and the padding the last packet carries is
 * dropped too: decoded, the file is exactly as long as what went in.
 *
 * @param {{packets: Array<{data: Uint8Array, samples: number}>, preSkip: number, samples: number, channels?: number, inputRate?: number, serial?: number, vendor?: string}} stream
 * @returns {Uint8Array}
 */
export function oggOpus({ packets, preSkip, samples, channels = 1, inputRate = OPUS_RATE, serial = 0x50444301, vendor = 'pokemon-desktop-companion' }) {
  const head = new Uint8Array(19);
  const headView = new DataView(head.buffer);
  head.set(new TextEncoder().encode('OpusHead'), 0);
  head[8] = 1;
  head[9] = channels;
  headView.setUint16(10, preSkip, true);
  headView.setUint32(12, inputRate, true);
  headView.setInt16(16, 0, true);
  head[18] = 0;

  const vendorBytes = new TextEncoder().encode(vendor);
  const tags = new Uint8Array(8 + 4 + vendorBytes.length + 4);
  const tagsView = new DataView(tags.buffer);
  tags.set(new TextEncoder().encode('OpusTags'), 0);
  tagsView.setUint32(8, vendorBytes.length, true);
  tags.set(vendorBytes, 12);
  tagsView.setUint32(12 + vendorBytes.length, 0, true);

  const pages = [
    oggPage({ packets: [head], granule: 0n, sequence: 0, serial, first: true }),
    oggPage({ packets: [tags], granule: 0n, sequence: 1, serial }),
  ];

  const end = BigInt(preSkip + samples);
  let sequence = 2;
  let decoded = preSkip;
  /** @type {Uint8Array[]} */
  let held = [];
  let segments = 0;
  const flush = (last) => {
    // Never past the true end: that is how the padding is trimmed off.
    const granule = BigInt(decoded) < end ? BigInt(decoded) : end;
    pages.push(oggPage({ packets: held, granule: last ? end : granule, sequence: sequence++, serial, last }));
    held = [];
    segments = 0;
  };
  packets.forEach((packet, index) => {
    if (segments + segmentsOf(packet.data) > MAX_SEGMENTS) flush(false);
    held.push(packet.data);
    segments += segmentsOf(packet.data);
    decoded += packet.samples;
    if (index === packets.length - 1) flush(true);
  });
  if (!packets.length) pages.push(oggPage({ packets: [], granule: end, sequence: sequence++, serial, last: true }));

  const out = new Uint8Array(pages.reduce((sum, page) => sum + page.length, 0));
  let at = 0;
  for (const page of pages) {
    out.set(page, at);
    at += page.length;
  }
  return out;
}

/**
 * Read an Ogg file back into its pages, for checking one: each page's flags,
 * granule position, sequence, packets, and whether its CRC holds.
 *
 * @param {Uint8Array} file
 */
export function readOgg(file) {
  const pages = [];
  let at = 0;
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  while (at < file.length) {
    if (file[at] !== 0x4f || file[at + 1] !== 0x67 || file[at + 2] !== 0x67 || file[at + 3] !== 0x53) throw new Error(`no page at ${at}`);
    const count = file[at + 26];
    const lacing = file.subarray(at + 27, at + 27 + count);
    const length = 27 + count + lacing.reduce((sum, value) => sum + value, 0);
    const page = file.slice(at, at + length);
    const stored = view.getUint32(at + 22, true);
    page.fill(0, 22, 26);
    const packets = [];
    let start = at + 27 + count;
    let size = 0;
    for (const value of lacing) {
      size += value;
      if (value < 255) {
        packets.push(file.subarray(start, start + size));
        start += size;
        size = 0;
      }
    }
    pages.push({
      flags: file[at + 5],
      granule: view.getBigInt64(at + 6, true),
      sequence: view.getUint32(at + 18, true),
      packets,
      crcOk: oggCrc(page) === stored,
    });
    at += length;
  }
  return pages;
}
