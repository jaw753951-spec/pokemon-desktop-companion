/**
 * Standard MIDI File parser.
 *
 * The decomp ships every track as an SMF under `sound/songs/midi/`. The game
 * does not want to run a full synthesiser over raw MIDI at runtime, so the
 * pipeline flattens each file here into absolute-time note events which
 * `src/renderer/core/audio.mjs` replays through WebAudio oscillators.
 *
 * What the cartridge's sound driver (m4a) makes of the controllers a file
 * carries is kept on each note, read at the moment it starts: the channel's
 * volume, its pan, the pitch bend (and the bends that slide a held note), and
 * the depth and speed of its vibrato. A channel that changes instrument part
 * way through gives one track per instrument, so every note keeps the voice
 * it was written for.
 */

/**
 * @typedef {Object} Note
 * @property {number} t   start time in seconds
 * @property {number} d   duration in seconds
 * @property {number} n   MIDI note number
 * @property {number} v   loudness 0..1: the velocity under the channel's volume
 * @property {number} [p] pan, -1 (left) to 1 (right), when it is not the middle
 * @property {number} [b] pitch bend at the start, in semitones, when there is one
 * @property {Array<[number, number]>} [g] the bend moving while the note is
 *   held: [seconds into the note, semitones]
 * @property {number} [m] vibrato depth either side, in semitones
 * @property {number} [r] vibrato speed, in Hz
 */

/**
 * @typedef {Object} Track
 * @property {number} channel
 * @property {number} program the song's voicegroup entry the notes are played on
 * @property {Note[]} notes
 */

/** What m4a starts a track on, for a file that does not say. */
const DEFAULT_VOLUME = 100;
const DEFAULT_BEND_RANGE = 2;
const DEFAULT_LFO_SPEED = 22;
/** m4a counts 24 ticks to the beat, whatever the file's own division. */
const DRIVER_TICKS_PER_BEAT = 24;

/**
 * @param {Buffer} buffer
 * @returns {{duration: number, loop?: number, tracks: Track[]}} `loop` is where
 *   a looping song's intro ends, in seconds, when the file marks one; a song
 *   that loops runs to its loop's end (`duration`) and goes back to `loop`
 */
export function parseMidi(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'MThd') throw new Error('Not a MIDI file');
  const trackCount = buffer.readUInt16BE(10);
  const division = buffer.readUInt16BE(12);
  if (division & 0x8000) throw new Error('SMPTE time division is not supported');

  /** @type {Array<{tick: number, usPerQuarter: number}>} */
  const tempoMap = [{ tick: 0, usPerQuarter: 500000 }];
  /** @type {RawTrack[]} */
  const rawTracks = [];
  /** Where the song loops back to and from, if the file marks it. */
  const markers = { loopTick: -1, loopEndTick: -1 };

  let offset = 14;
  for (let index = 0; index < trackCount && offset < buffer.length; index++) {
    if (buffer.toString('ascii', offset, offset + 4) !== 'MTrk') break;
    const length = buffer.readUInt32BE(offset + 4);
    const end = offset + 8 + length;
    parseTrack(buffer, offset + 8, end, tempoMap, rawTracks, markers);
    offset = end;
  }

  tempoMap.sort((a, b) => a.tick - b.tick);
  const toSeconds = buildTickConverter(tempoMap, division);
  const tempoAt = (tick) => {
    let current = tempoMap[0].usPerQuarter;
    for (const change of tempoMap) {
      if (change.tick > tick) break;
      current = change.usPerQuarter;
    }
    return current;
  };

  /** @type {Track[]} */
  const tracks = [];
  let lastSound = 0;
  for (const raw of rawTracks) {
    if (raw.notes.length === 0) continue;
    /** @type {Note[]} */
    const notes = raw.notes.map((note) => {
      const t = toSeconds(note.tick);
      const d = Math.max(0.02, toSeconds(note.endTick) - t);
      lastSound = Math.max(lastSound, t + d);
      /** @type {Note} */
      const out = { t: round(t), d: round(d), n: note.n, v: round((note.v / 127) * (note.volume / 127)) };
      if (note.pan !== 64) out.p = round(Math.max(-1, Math.min(1, (note.pan - 64) / 63)));
      const bends = raw.bends;
      const start = bendAt(bends, note.tick);
      if (start !== 0) out.b = round(start);
      const glide = bends.filter((bend) => bend.tick > note.tick && bend.tick < note.endTick);
      if (glide.length) out.g = glide.map((bend) => [round(toSeconds(bend.tick) - t), round(bend.semitones)]);
      if (note.mod > 0) {
        // m4a's vibrato: a triangle of ±mod/16 semitones, stepped once a
        // tick, a full cycle every 256/speed ticks.
        const ticksPerSecond = (1e6 / tempoAt(note.tick)) * DRIVER_TICKS_PER_BEAT;
        out.m = round(note.mod / 16);
        out.r = round((ticksPerSecond * note.lfoSpeed) / 256);
      }
      return out;
    });
    notes.sort((a, b) => a.t - b.t);
    tracks.push({ channel: raw.channel, program: raw.program, notes });
  }

  // The decomp marks a looping song's loop with `[` and `]` markers: whatever
  // comes before the `[` is an intro that plays once, and the `]` is where the
  // song goes back to it — on the bar line, which can be later than the last
  // note ends. A victory theme is a two-second fanfare and a long body looped
  // under the experience screen, and this is what lets a cue play the one
  // without the other.
  const looped = markers.loopTick >= 0 && markers.loopEndTick > markers.loopTick;
  const duration = looped ? toSeconds(markers.loopEndTick) : lastSound;
  const loop = looped ? { loop: round(toSeconds(markers.loopTick)) } : {};
  return { duration: round(duration), ...loop, tracks };
}

const round = (value) => Math.round(value * 1000) / 1000;

/**
 * @typedef {{tick: number, endTick: number, n: number, v: number, volume: number, pan: number, mod: number, lfoSpeed: number}} RawNote
 * @typedef {{channel: number, program: number, notes: RawNote[], bends: Array<{tick: number, semitones: number}>}} RawTrack
 */

/** The bend in force at a tick, from a channel's bends in order. */
function bendAt(bends, tick) {
  let semitones = 0;
  for (const bend of bends) {
    if (bend.tick > tick) break;
    semitones = bend.semitones;
  }
  return semitones;
}

function parseTrack(buffer, start, end, tempoMap, rawTracks, markers) {
  let pos = start;
  let tick = 0;
  let runningStatus = 0;

  /** What each channel of this track is set to, as the file goes. */
  const channels = new Map();
  const state = (channel) => {
    let entry = channels.get(channel);
    if (!entry) {
      entry = { program: 0, volume: DEFAULT_VOLUME, pan: 64, bendRange: DEFAULT_BEND_RANGE, bend: 0, mod: 0, lfoSpeed: DEFAULT_LFO_SPEED, bends: [], tracks: new Map() };
      channels.set(channel, entry);
    }
    return entry;
  };
  /** The track a channel's notes go on while it plays one instrument. */
  const trackFor = (channel) => {
    const entry = state(channel);
    let track = entry.tracks.get(entry.program);
    if (!track) {
      track = { channel, program: entry.program, notes: [], bends: entry.bends };
      entry.tracks.set(entry.program, track);
      rawTracks.push(track);
    }
    return track;
  };
  /** @type {Map<number, RawNote[]>} */
  const sounding = new Map();

  while (pos < end) {
    const delta = readVarInt(buffer, pos);
    pos = delta.next;
    tick += delta.value;

    let status = buffer[pos];
    if (status < 0x80) {
      status = runningStatus;
    } else {
      pos++;
      if (status < 0xf0) runningStatus = status;
    }

    if (status === 0xff) {
      const type = buffer[pos++];
      const length = readVarInt(buffer, pos);
      pos = length.next;
      if (type === 0x51) {
        tempoMap.push({ tick, usPerQuarter: (buffer[pos] << 16) | (buffer[pos + 1] << 8) | buffer[pos + 2] });
      }
      if (type === 0x06) {
        const text = buffer.toString('ascii', pos, pos + length.value);
        if (text === '[' && markers.loopTick < 0) markers.loopTick = tick;
        if (text === ']') markers.loopEndTick = Math.max(markers.loopEndTick, tick);
      }
      pos += length.value;
      if (type === 0x2f) break;
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      const length = readVarInt(buffer, pos);
      pos = length.next + length.value;
      continue;
    }

    const command = status & 0xf0;
    const channel = status & 0x0f;

    if (command === 0xc0) {
      state(channel).program = buffer[pos++];
      continue;
    }
    if (command === 0xd0) {
      pos++;
      continue;
    }

    const data1 = buffer[pos++];
    const data2 = buffer[pos++];

    if (command === 0xb0) {
      const entry = state(channel);
      // The controllers m4a listens to (mid2agb's VOL, PAN, MOD, BENDR, LFOS).
      if (data1 === 7) entry.volume = data2;
      else if (data1 === 10) entry.pan = data2;
      else if (data1 === 1) entry.mod = data2;
      else if (data1 === 20) entry.bendRange = data2;
      else if (data1 === 21) entry.lfoSpeed = data2;
      continue;
    }
    if (command === 0xe0) {
      // m4a keeps the top seven bits, -64 to 63, as a share of the range.
      const entry = state(channel);
      entry.bend = data2 - 64;
      entry.bends.push({ tick, semitones: (entry.bend / 64) * entry.bendRange });
      continue;
    }

    if (command === 0x90 && data2 > 0) {
      const entry = state(channel);
      const note = { tick, endTick: tick, n: data1, v: data2, volume: entry.volume, pan: entry.pan, mod: entry.mod, lfoSpeed: entry.lfoSpeed };
      trackFor(channel).notes.push(note);
      const key = channel * 128 + data1;
      const stack = sounding.get(key) ?? [];
      stack.push(note);
      sounding.set(key, stack);
    } else if (command === 0x80 || (command === 0x90 && data2 === 0)) {
      const key = channel * 128 + data1;
      const stack = sounding.get(key);
      const note = stack?.shift();
      if (note) note.endTick = tick;
    }
  }

  // Anything still held at end-of-track ends there.
  for (const stack of sounding.values()) {
    for (const note of stack) if (note.endTick === note.tick) note.endTick = tick;
  }
}

/**
 * @param {Array<{tick: number, usPerQuarter: number}>} tempoMap
 * @param {number} ticksPerQuarter
 */
function buildTickConverter(tempoMap, ticksPerQuarter) {
  // Precompute the elapsed seconds at each tempo change so lookups are O(log n).
  const points = [{ tick: 0, seconds: 0, usPerQuarter: tempoMap[0].usPerQuarter }];
  for (let i = 1; i < tempoMap.length; i++) {
    const previous = points[points.length - 1];
    const deltaTicks = tempoMap[i].tick - previous.tick;
    const seconds = previous.seconds + (deltaTicks * previous.usPerQuarter) / (ticksPerQuarter * 1e6);
    points.push({ tick: tempoMap[i].tick, seconds, usPerQuarter: tempoMap[i].usPerQuarter });
  }

  return (tick) => {
    let low = 0;
    let high = points.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (points[mid].tick <= tick) low = mid;
      else high = mid - 1;
    }
    const point = points[low];
    return point.seconds + ((tick - point.tick) * point.usPerQuarter) / (ticksPerQuarter * 1e6);
  };
}

function readVarInt(buffer, pos) {
  let value = 0;
  let byte;
  do {
    byte = buffer[pos++];
    value = (value << 7) | (byte & 0x7f);
  } while (byte & 0x80);
  return { value, next: pos };
}
