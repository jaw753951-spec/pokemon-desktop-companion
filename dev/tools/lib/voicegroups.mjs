/**
 * The cartridge's instruments, read from the decomp's voicegroups.
 *
 * A song's MIDI numbers its instruments by position in the song's own
 * voicegroup (`sound/voicegroups/<name>.inc`), not by General MIDI: program 0
 * of the champion's battle is a drum kit, 80 a Game Boy square wave, 73 a
 * flute. Each entry is one of the GBA's sound sources —
 *
 * - `voice_directsound`: a recorded sample (a piano, a timpani, a snare),
 *   with an attack/decay/sustain/release envelope in the driver's 0-255 steps;
 * - `voice_square_1` / `_2`: the Game Boy pulse channels, with a duty cycle;
 * - `voice_programmable_wave`: the Game Boy wave channel, playing a 32-step
 *   table of its own;
 * - `voice_noise`: the Game Boy noise channel;
 * - `voice_keysplit`: another voicegroup, a sample per range of keys (a piano
 *   recorded at four pitches);
 * - `voice_keysplit_all`: a drum kit — another voicegroup, an entry per key.
 *
 * The Game Boy channels' envelopes are in their own 0-7 (0-15 for the
 * sustain level) steps. Everything is passed on as written: the synth in
 * `app/renderer/core/audio.mjs` makes the sounds.
 */

/**
 * @typedef {{w: 'sample', s: string, key: number, fixed?: boolean, env: number[], p?: number}
 *   | {w: 'square', key: number, duty: number, env: number[], p?: number}
 *   | {w: 'wave', key: number, wave: number[], env: number[], p?: number}
 *   | {w: 'noise', key: number, period: number, env: number[], p?: number}} Voice
 * `env` is [attack, decay, sustain, release]; `key` is the note a kit's drum
 * sounds at; `p` a pan the voice fixes, -1 to 1.
 */

/**
 * @typedef {{voice?: Voice, split?: Array<{to: number, voice: Voice}>, kit?: Record<number, Voice>}} Instrument
 */

/**
 * Read every `voice_group` in some voicegroup files.
 *
 * @param {string} text
 * @returns {Map<string, {offset: number, entries: Array<{macro: string, args: string[]}>}>}
 */
export function parseVoicegroups(text) {
  const groups = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const code = line.replace(/@.*$/, '').trim();
    if (!code) continue;
    const head = code.match(/^voice_group\s+(\w+)(?:\s*,\s*(\d+))?/);
    if (head) {
      current = { offset: Number(head[2] ?? 0), entries: [] };
      groups.set(head[1], current);
      continue;
    }
    const entry = code.match(/^(voice_\w+)\s*(.*)$/);
    if (entry && current) current.entries.push({ macro: entry[1], args: entry[2].split(',').map((arg) => arg.trim()) });
  }
  return groups;
}

/**
 * Read the key split tables: for each, the voicegroup entry each range of
 * keys plays, as the highest key of the range.
 *
 * @param {string} text `sound/keysplit_tables.inc`
 * @returns {Map<string, Array<{index: number, to: number}>>}
 */
export function parseKeysplits(text) {
  const tables = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const code = line.replace(/@.*$/, '').trim();
    const head = code.match(/^keysplit\s+(\w+)/);
    if (head) {
      current = [];
      tables.set(head[1], current);
      continue;
    }
    const split = code.match(/^split\s+(\d+)\s*,\s*(\d+)/);
    if (split && current) current.push({ index: Number(split[1]), to: Number(split[2]) });
  }
  return tables;
}

/**
 * What a song's program plays.
 *
 * @param {object} library
 * @param {Map<string, {offset: number, entries: Array<{macro: string, args: string[]}>}>} library.groups
 * @param {Map<string, Array<{index: number, to: number}>>} library.keysplits
 * @param {(label: string) => number[]|null} library.wave a programmable wave's 32 steps
 * @param {string} group the song's voicegroup
 * @param {number} program
 * @param {number[]} keys the keys the song plays on it, for a kit
 * @returns {Instrument|null}
 */
export function instrumentFor(library, group, program, keys) {
  const entry = library.groups.get(group)?.entries[program];
  if (!entry) return null;
  if (entry.macro === 'voice_keysplit_all') {
    const kit = library.groups.get(entry.args[0].replace(/^voicegroup_/, ''));
    if (!kit) return null;
    /** @type {Record<number, Voice>} */
    const drums = {};
    for (const key of new Set(keys)) {
      const entry = kit.entries[key - kit.offset];
      if (!entry || isEmptySlot(entry)) continue;
      const voice = voiceOf(library, entry);
      if (voice) drums[key] = voice;
    }
    return { kit: drums };
  }
  if (entry.macro === 'voice_keysplit') {
    const voices = library.groups.get(entry.args[0].replace(/^voicegroup_/, ''));
    const table = library.keysplits.get(entry.args[1].replace(/^keysplit_/, ''));
    if (!voices || !table) return null;
    const split = table
      .map(({ index, to }) => ({ to, voice: voiceOf(library, voices.entries[index]) }))
      .filter((range) => range.voice);
    return split.length ? { split: /** @type {any} */ (split) } : null;
  }
  const voice = voiceOf(library, entry);
  return voice ? { voice } : null;
}

/**
 * The entry the decomp writes in a kit's unused keys: a plain square wave at
 * full, which in a drum pattern is a stray beep on C4 rather than a drum, so
 * a kit's note on one is left silent.
 *
 * @param {{macro: string, args: string[]}} entry
 */
function isEmptySlot(entry) {
  return entry.macro === 'voice_square_1' && entry.args.join(',') === '60,0,0,2,0,0,15,0';
}

/**
 * One entry of a voicegroup as a voice, or null for one that is not a sound.
 *
 * @param {object} library
 * @param {{macro: string, args: string[]}|undefined} entry
 * @returns {Voice|null}
 */
function voiceOf(library, entry) {
  if (!entry) return null;
  const { macro, args } = entry;
  const numbers = args.map(Number);
  const pan = (value) => (value ? { p: Math.round(((value - 64) / 63) * 100) / 100 } : {});
  if (macro.startsWith('voice_directsound')) {
    const [key, panValue, sample, ...env] = args;
    return {
      w: 'sample',
      s: sample.replace(/^DirectSoundWaveData_/, ''),
      key: Number(key),
      ...(macro.includes('no_resample') ? { fixed: true } : {}),
      env: env.map(Number),
      ...pan(Number(panValue)),
    };
  }
  if (macro.startsWith('voice_square_1')) {
    const [key, panValue, , duty, ...env] = numbers;
    return { w: 'square', key, duty, env, ...pan(panValue) };
  }
  if (macro.startsWith('voice_square_2')) {
    const [key, panValue, duty, ...env] = numbers;
    return { w: 'square', key, duty, env, ...pan(panValue) };
  }
  if (macro.startsWith('voice_programmable_wave')) {
    const [key, panValue, label, ...env] = args;
    const wave = library.wave(label);
    return wave ? { w: 'wave', key: Number(key), wave, env: env.map(Number), ...pan(Number(panValue)) } : null;
  }
  if (macro.startsWith('voice_noise')) {
    const [key, panValue, period, ...env] = numbers;
    return { w: 'noise', key, period, env, ...pan(panValue) };
  }
  return null;
}

/**
 * A programmable wave's 32 four-bit steps, from its 16-byte sample file.
 *
 * @param {Uint8Array} bytes
 */
export function waveSteps(bytes) {
  const steps = [];
  for (const byte of bytes.subarray(0, 16)) steps.push(byte >> 4, byte & 0x0f);
  return steps;
}

/**
 * The options a song is built with, from `sound/songs/midi/midi.cfg`: its
 * voicegroup (`-G`) and its master volume (`-V`, out of 127).
 *
 * @param {string} text
 * @returns {Map<string, {group: string, volume: number}>}
 */
export function parseMidiConfig(text) {
  const songs = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(\w+)\.mid:\s*(.*)$/);
    if (!match) continue;
    const group = match[2].match(/-G_?(\w+)/)?.[1];
    const volume = Number(match[2].match(/-V(\d+)/)?.[1] ?? 127);
    if (group) songs.set(match[1], { group, volume });
  }
  return songs;
}

/**
 * One of the decomp's recorded samples (`sound/direct_sound_samples/*.wav`),
 * as the game ships it: its 8-bit samples, the rate it plays at on its own
 * key (60), and where it loops.
 *
 * The decomp's WAVs carry what the cartridge's sample header holds in two
 * chunks of their own: `agbp`, the playback rate on key 60 in 1024ths of a
 * Hz, and `agbl`, the sample's length — the loop runs from the `smpl`
 * chunk's loop start to there and round again. One sample more follows it, a
 * copy of the loop's first, which the driver never plays: it is there for a
 * mixer that reads one sample ahead. Looping through it plays that sample
 * twice each time round, a tick that buzzes on a held high note. A sample
 * with no loop plays once.
 *
 * @param {Uint8Array} bytes
 * @returns {{rate: number, pitch: number, loop: number|null, end: number, pcm: string}}
 *   `rate` is the file's sample rate, `pitch` the exact rate on key 60, `end`
 *   where it ends (and its loop goes round), and `pcm` the unsigned 8-bit
 *   samples, base64, with the one after the end
 */
export function parseSample(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (text(0) !== 'RIFF' || text(8) !== 'WAVE') throw new Error('not a WAV file');
  let rate = 0;
  let pitch = 0;
  let loop = null;
  let end = -1;
  /** @type {Uint8Array|null} */
  let data = null;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = text(at);
    const length = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      if (view.getUint16(body + 14, true) !== 8) throw new Error('not an 8-bit sample');
      rate = view.getUint32(body + 4, true);
    } else if (id === 'smpl' && view.getUint32(body + 28, true) > 0) {
      loop = view.getUint32(body + 36 + 8, true);
    } else if (id === 'agbp') {
      pitch = view.getUint32(body, true) / 1024;
    } else if (id === 'agbl') {
      end = view.getUint32(body, true);
    } else if (id === 'data') {
      data = bytes.subarray(body, body + length);
    }
    at = body + length + (length & 1);
  }
  if (!data || !rate) throw new Error('a sample with no data');
  const size = end >= 0 ? Math.min(end, data.length) : data.length;
  const kept = Math.min(size + 1, data.length);
  return { rate, pitch: pitch || rate, loop, end: size, pcm: Buffer.from(data.subarray(0, kept)).toString('base64') };
}
