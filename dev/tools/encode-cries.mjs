#!/usr/bin/env electron
/**
 * Re-encode the cries smaller: every `.ogg` in one folder, decoded and encoded
 * again as mono Opus, into another.
 *
 *   electron dev/tools/encode-cries.mjs <from> <to>
 *
 * PokeAPI's cries are Vorbis at about 86 kbps — far more than most second-long
 * mono cries need, and over half of everything the game ships besides
 * Electron. Node has no Opus encoder, but the browser in Electron has one
 * (WebCodecs), and the decoder the game plays them with; so this runs in a
 * hidden Electron window, which the assets pipeline starts (see
 * `build/sprites.mjs`).
 *
 * Each cry is given the lowest of {@link BITRATES} that keeps it whole. Opus
 * at a low rate gives up the top of the sound first, and the cries differ a
 * great deal in how much of them is up there: some lose nothing at 32 kbps,
 * the hissing and screeching ones lose a quarter of their energy. So every
 * file is decoded again once written, and only kept if it is as long as it
 * went in and has lost no more than {@link LEVEL_TOLERANCE_DB}; failing that
 * it tries the next rate up, and a cry no rate keeps whole is left as it came.
 */
import { app, BrowserWindow } from 'electron';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { oggOpus } from './lib/ogg.mjs';

const [from, to] = process.argv.slice(2).filter((arg) => !arg.startsWith('--')).slice(-2);

/** The rates a cry is tried at, lowest first. */
const BITRATES = [32000, 48000, 64000];

/** How many cries go to the page at a time. */
const BATCH = 40;

/**
 * How much quieter a re-encoded cry may come out than it went in, in dB: half
 * a dB is a tenth of its energy, all of it from the top of the sound.
 */
const LEVEL_TOLERANCE_DB = 0.5;

/** The page's side: decode, encode, and check a file once it is written. */
const PAGE = `<!doctype html><meta charset="utf-8"><script>
const bytesOf = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const b64Of = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
async function decode(bytes) {
  const context = new OfflineAudioContext(1, 1, 48000);
  const buffer = await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
  }
  return mono;
}
const rmsDb = (data) => { let sum = 0; for (const x of data) sum += x * x; return 10 * Math.log10(sum / Math.max(1, data.length) || 1e-12); };
window.encode = async (b64, bitrate) => {
  const mono = await decode(bytesOf(b64));
  const packets = [];
  let description = null;
  let failure = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      packets.push({ data: b64Of(data), samples: Math.round((chunk.duration * 48000) / 1e6) });
      const given = meta?.decoderConfig?.description;
      if (given && !description) description = b64Of(new Uint8Array(given.buffer ?? given, given.byteOffset ?? 0, given.byteLength));
    },
    error: (error) => { failure = String(error); },
  });
  encoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate, opus: { complexity: 10 } });
  encoder.encode(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: mono.length, numberOfChannels: 1, timestamp: 0, data: mono }));
  await encoder.flush();
  encoder.close();
  if (failure) throw new Error(failure);
  return { packets, description, samples: mono.length, level: rmsDb(mono) };
};
window.check = async (b64) => {
  const mono = await decode(bytesOf(b64));
  return { samples: mono.length, level: rmsDb(mono) };
};
</script>`;

/** The encoder's own delay, from the header it gives — or libopus's, at 48 kHz. */
function preSkipOf(description) {
  if (description) {
    const head = Buffer.from(description, 'base64');
    if (head.length >= 12 && head.toString('ascii', 0, 8) === 'OpusHead') return head.readUInt16LE(10);
  }
  return 312;
}

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  let failed = false;
  const page = join(await mkdtemp(join(tmpdir(), 'pdc-cries-')), 'encode.html');
  try {
    await writeFile(page, PAGE);
    const window = new BrowserWindow({ show: false });
    await window.loadFile(page);
    await mkdir(to, { recursive: true });

    const files = (await readdir(from)).filter((name) => name.endsWith('.ogg')).sort();
    let before = 0;
    let after = 0;
    /** How many cries each rate kept, and how many were left as they came. @type {Map<string, number>} */
    const kept = new Map([...BITRATES.map((rate) => String(rate / 1000)), 'original'].map((label) => [label, 0]));
    const broken = [];
    for (let start = 0; start < files.length; start += BATCH) {
      const batch = files.slice(start, start + BATCH);
      await Promise.all(batch.map(async (name) => {
        const source = await readFile(join(from, name));
        let chosen = null;
        let label = 'original';
        for (const bitrate of BITRATES) {
          const encoded = await window.webContents.executeJavaScript(`encode(${JSON.stringify(source.toString('base64'))}, ${bitrate})`);
          const file = oggOpus({
            packets: encoded.packets.map((packet) => ({ data: Buffer.from(packet.data, 'base64'), samples: packet.samples })),
            preSkip: preSkipOf(encoded.description),
            samples: encoded.samples,
          });
          const check = await window.webContents.executeJavaScript(`check(${JSON.stringify(Buffer.from(file).toString('base64'))})`);
          // A file that does not decode to the length it was made from is
          // broken, not merely dull: that stops the run.
          if (Math.abs(check.samples - encoded.samples) > 1) {
            broken.push(`${name}: ${encoded.samples} samples came back ${check.samples}`);
            return;
          }
          if (encoded.level - check.level <= LEVEL_TOLERANCE_DB && file.length < source.length) {
            chosen = file;
            label = String(bitrate / 1000);
            break;
          }
        }
        const out = chosen ?? source;
        await writeFile(join(to, name), out);
        kept.set(label, /** @type {number} */ (kept.get(label)) + 1);
        before += source.length;
        after += out.length;
      }));
      process.stdout.write(`\r  cries encoded ${Math.min(start + BATCH, files.length)}/${files.length}`);
    }
    process.stdout.write('\n');
    console.log(`  cries ${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB (${[...kept].map(([rate, count]) => (rate === 'original' ? `${count} left as they came` : `${count} at ${rate} kbps`)).join(', ')})`);
    if (broken.length) {
      failed = true;
      console.error(`  ${broken.length} cries came out broken:\n    ${broken.slice(0, 10).join('\n    ')}`);
    }
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    await rm(join(page, '..'), { recursive: true, force: true });
  }
  app.exit(failed ? 1 : 0);
});

