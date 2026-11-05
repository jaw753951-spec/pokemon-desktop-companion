/**
 * The instruments the soundtrack is played on.
 *
 * Each track of a song names what the cartridge plays it on (see
 * `dev/tools/lib/voicegroups.mjs`): one of the Game Boy's own channels — a
 * pulse wave of some duty, the wave channel's 32-step table, noise — or a
 * recorded sample. The Game Boy channels are made here as the hardware makes
 * them. The samples are the cartridge's own (`assets/samples`, loaded with
 * {@link storeSample} before a song starts), played as its driver plays them:
 * at their rate on key 60, retuned to the note, looped where they loop and
 * shaped by the envelope the voice gives them. A sample that is not there is
 * stood in for by a tone built for what it is (a piano, a horn, a snare).
 */

/** The driver's frame, which its envelopes count in. */
const FRAME_S = 1 / 60;

/** How loud each kind of source sits against the others. */
const LEVEL = { sample: 0.42, recorded: 0.5, kit: 1.25, square: 0.75, wave: 0.5, noise: 1, drum: 1.4 };

/**
 * A swept pulse, softened: the fanfares that use one (the berry's, the
 * heal's) are otherwise played by recorded instruments, and a bare square
 * chirping up past 8 kHz stands out of them like a different game's sound.
 * Its top is taken off and it sits back under the xylophone, as on the
 * cartridge's small speaker, keeping the slide without the "pew".
 */
const SWEPT = { lowpass: 2200, level: 0.45 };

/**
 * The recorded samples, by name: their samples as -1 to 1, the file's own
 * rate, how many of them a second sound key 60 (`pitch`), and the loop.
 *
 * @type {Map<string, {data: Float32Array, rate: number, pitch: number, loop: number|null, end: number}>}
 */
const recorded = new Map();

/**
 * Keep a sample for the songs to play, from its file in `assets/samples`.
 *
 * Kept as the cartridge has it, slow and 8-bit, and played without a filter
 * of its own: a trumpet or a cymbal's brightness on the cartridge is in the
 * grit above what the sample holds, and smoothing that away left them dull.
 *
 * @param {string} name
 * @param {{rate: number, pitch: number, loop: number|null, end: number, pcm: string}} file
 */
export function storeSample(name, file) {
  const bytes = Uint8Array.from(atob(file.pcm), (char) => char.charCodeAt(0));
  const data = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) data[i] = (bytes[i] - 128) / 128;
  const end = Math.min(file.end, bytes.length);
  recorded.set(name, { data, rate: file.rate, pitch: file.pitch, loop: file.loop !== null && file.loop < end ? file.loop : null, end });
}

/** @param {string} name */
export const hasSample = (name) => recorded.has(name);

/**
 * The recorded samples a song plays.
 *
 * @param {{tracks: Track[]}} song
 */
export function samplesOf(song) {
  const names = new Set();
  for (const track of song.tracks) {
    for (const voice of [track.voice, ...(track.split ?? []).map((range) => range.voice), ...Object.values(track.kit ?? {})]) {
      if (voice?.w === 'sample') names.add(voice.s);
    }
  }
  return [...names];
}

/** How far apart the speakers a hard-panned part is put: all the way is tiring on headphones. */
const PAN_WIDTH = 0.7;

/**
 * @typedef {{w: 'sample', s: string, key?: number, fixed?: boolean, env: number[], p?: number}
 *   | {w: 'square', key?: number, duty: number, env: number[], sw?: number, p?: number}
 *   | {w: 'wave', key?: number, wave: number[], env: number[], p?: number}
 *   | {w: 'noise', key?: number, period: number, env: number[], p?: number}} Voice
 */

/**
 * @typedef {{program?: number, voice?: Voice, split?: Array<{to: number, voice: Voice}>, kit?: Record<number, Voice>}} Track
 * @typedef {{t: number, d: number, n: number, v: number, p?: number, b?: number, g?: Array<[number, number]>, m?: number, r?: number}} Note
 */

/**
 * The voice a track plays a key on: the kit's drum for that key, the split's
 * sample for its range, or the track's one voice. A track built before the
 * instruments were known is given a stand-in by its program.
 *
 * @param {Track} track
 * @param {number} key
 * @returns {Voice|null}
 */
export function voiceAt(track, key) {
  if (track.kit) return track.kit[key] ?? null;
  if (track.split?.length) return (track.split.find((range) => key <= range.to) ?? track.split[track.split.length - 1]).voice;
  if (track.voice) return track.voice;
  const program = track.program ?? 0;
  if (program === 0 || program >= 128) return { w: 'sample', s: 'rnd_snare', key: 60, fixed: true, env: [255, 0, 255, 200] };
  return { w: 'sample', s: 'piano', key: 60, env: [255, 250, 0, 200] };
}

/**
 * A voice's envelope in seconds and shares of full: how long it takes to
 * reach full, how fast it falls to where it sustains (a time constant, or a
 * straight ramp for the Game Boy channels), and how fast it dies once let go.
 *
 * The recorded samples count in 0-255 steps a frame: the attack adds its
 * value each frame, and the decay and release multiply by theirs over 256.
 * The Game Boy channels have sixteen volumes, and step one volume at a time,
 * one step every so many frames: up to the note's own volume (`goal`), down to
 * the voice's share of it, and down to nothing once let go — so a quiet note
 * is let go of sooner than a loud one. A release of 0 cuts the note dead.
 *
 * @param {Voice} voice
 * @param {number} [goal] for a Game Boy channel, the note's volume, 1 to 15
 * @returns {{attack: number, decay: number, linear: boolean, sustain: number, release: number}}
 */
export function envelopeOf(voice, goal = 15) {
  const [a = 255, d = 0, s = 255, r = 0] = voice.env ?? [];
  if (voice.w === 'sample') {
    const fall = (factor) => (factor <= 0 ? 0 : factor >= 256 ? Infinity : -FRAME_S / Math.log(factor / 256));
    return {
      attack: a >= 255 ? 0.002 : Math.ceil(255 / Math.max(1, a)) * FRAME_S,
      decay: fall(d),
      linear: false,
      sustain: s / 255,
      release: Math.max(0.006, fall(r)),
    };
  }
  // m4a's own sum for where a held Game Boy note settles.
  const held = (goal * s + 15) >> 4;
  return {
    attack: a === 0 ? 0.002 : a * goal * FRAME_S,
    decay: d === 0 ? 0 : d * Math.max(0, goal - held) * FRAME_S,
    linear: true,
    sustain: held / goal,
    // A release of 0 stops the channel; a moment's fade keeps it from clicking.
    release: r === 0 ? 0.008 : Math.max(0.008, r * held * FRAME_S),
  };
}

/**
 * What stands in for a recorded sample: a pitched tone (the strength of each
 * harmonic, a filter over the top, and how fast it dies away of itself, if it
 * does), or a struck drum.
 *
 * @typedef {{harmonics: number[], lowpass?: number, ring?: number, thump?: boolean}} Tone
 * @typedef {{drum: Array<Hit>, base?: number}} Drum
 * @typedef {{tone?: OscillatorType, noise?: BiquadFilterType, from?: number, to?: number, sweep?: number,
 *   freq?: number, q?: number, decay: number, gain: number, pitched?: boolean, band?: number, bursts?: number}} Hit
 */

const sawtooth = (count, tilt = 1) => Array.from({ length: count }, (_, i) => 1 / (i + 1) ** tilt);

/** @type {Array<[RegExp, Tone|Drum]>} first match wins */
const SAMPLES = [
  // The kit.
  [/kick/, { drum: [{ tone: 'sine', from: 150, to: 45, sweep: 0.06, decay: 0.22, gain: 1 }, { noise: 'lowpass', freq: 900, decay: 0.02, gain: 0.3 }] }],
  [/taiko/, { drum: [{ tone: 'sine', from: 120, to: 58, sweep: 0.12, decay: 0.42, gain: 1 }, { noise: 'lowpass', freq: 500, decay: 0.07, gain: 0.35 }] }],
  [/timpani_with_snare/, { drum: [{ tone: 'triangle', from: 1, to: 0.97, sweep: 0.1, decay: 0.5, gain: 0.8, pitched: true }, { noise: 'bandpass', freq: 2400, q: 0.7, decay: 0.12, gain: 0.6 }], base: 261.63 }],
  [/snare/, { drum: [{ noise: 'bandpass', freq: 2400, q: 0.7, decay: 0.13, gain: 0.85 }, { tone: 'triangle', from: 220, to: 180, sweep: 0.03, decay: 0.06, gain: 0.45 }] }],
  [/tom/, { drum: [{ tone: 'sine', from: 1, to: 0.72, sweep: 0.18, decay: 0.3, gain: 1, pitched: true }, { noise: 'lowpass', freq: 1200, decay: 0.03, gain: 0.2 }], base: 130 }],
  [/cymbal_crash/, { drum: [{ noise: 'highpass', freq: 4200, decay: 0.85, gain: 0.5 }] }],
  [/ride_bell/, { drum: [{ noise: 'bandpass', freq: 6500, q: 0.8, decay: 0.45, gain: 0.3 }, { tone: 'square', from: 2300, decay: 0.35, gain: 0.07, band: 2300 }] }],
  [/close_hihat/, { drum: [{ noise: 'highpass', freq: 7500, decay: 0.045, gain: 0.45 }] }],
  [/open_hihat/, { drum: [{ noise: 'highpass', freq: 7000, decay: 0.24, gain: 0.4 }] }],
  [/hand_clap/, { drum: [{ noise: 'bandpass', freq: 1300, q: 1, decay: 0.11, gain: 0.85, bursts: 3 }] }],
  [/tambourine|jingle_bell/, { drum: [{ noise: 'highpass', freq: 6500, decay: 0.16, gain: 0.45 }] }],
  [/mute_high_conga/, { drum: [{ tone: 'sine', from: 1, to: 0.94, sweep: 0.04, decay: 0.1, gain: 0.9, pitched: true }], base: 330 }],
  [/conga/, { drum: [{ tone: 'sine', from: 1, to: 0.94, sweep: 0.05, decay: 0.2, gain: 0.9, pitched: true }], base: 220 }],
  [/cowbell/, { drum: [{ tone: 'square', from: 560, decay: 0.22, gain: 0.22, band: 900 }, { tone: 'square', from: 845, decay: 0.22, gain: 0.22, band: 900 }] }],
  [/open_triangle/, { drum: [{ tone: 'sine', from: 4200, decay: 0.9, gain: 0.22 }, { tone: 'sine', from: 6150, decay: 0.6, gain: 0.09 }] }],
  [/hyoushigi/, { drum: [{ tone: 'sine', from: 1700, to: 1500, sweep: 0.02, decay: 0.04, gain: 0.6 }, { noise: 'bandpass', freq: 2500, q: 2, decay: 0.02, gain: 0.4 }] }],
  [/ohtsuzumi/, { drum: [{ tone: 'sine', from: 1, to: 0.9, sweep: 0.03, decay: 0.07, gain: 0.8, pitched: true }, { noise: 'bandpass', freq: 3000, q: 1.5, decay: 0.03, gain: 0.5 }], base: 620 }],
  [/kotsuzumi/, { drum: [{ tone: 'sine', from: 1, to: 0.86, sweep: 0.09, decay: 0.22, gain: 0.9, pitched: true }], base: 380 }],
  [/indian_drum/, { drum: [{ tone: 'sine', from: 0.85, to: 1.15, sweep: 0.12, decay: 0.28, gain: 0.9, pitched: true }], base: 200 }],
  [/atarigane/, { drum: [{ tone: 'square', from: 1150, decay: 0.28, gain: 0.13, band: 1600 }, { tone: 'square', from: 1720, decay: 0.22, gain: 0.1, band: 1600 }] }],
  [/scream_drive/, { drum: [{ noise: 'bandpass', freq: 1800, q: 0.6, decay: 0.35, gain: 0.5 }] }],

  // Pitched instruments.
  [/timpani/, { harmonics: [1, 0.4, 0.18, 0.08], ring: 0.7, thump: true }],
  [/piano/, { harmonics: [1, 0.5, 0.32, 0.18, 0.12, 0.08, 0.05, 0.03], lowpass: 5000, ring: 1.4 }],
  [/detuned_ep/, { harmonics: [1, 0.25, 0.06, 0.03], ring: 1.2 }],
  [/pizzicato/, { harmonics: [1, 0.55, 0.35, 0.2, 0.12, 0.06], ring: 0.35 }],
  [/string/, { harmonics: sawtooth(16, 1.2), lowpass: 3200 }],
  [/trumpet/, { harmonics: [1, 0.85, 0.7, 0.55, 0.42, 0.3, 0.22, 0.15, 0.1, 0.06], lowpass: 4500 }],
  [/french_horn/, { harmonics: [1, 0.55, 0.28, 0.14, 0.07, 0.03], lowpass: 2200 }],
  [/tuba/, { harmonics: [1, 0.65, 0.35, 0.18, 0.08], lowpass: 1500 }],
  [/flute/, { harmonics: [1, 0.15, 0.06, 0.02] }],
  [/whistle/, { harmonics: [1, 0.05] }],
  [/organ/, { harmonics: [1, 0.7, 0.15, 0.5, 0.05, 0.3, 0, 0.2] }],
  [/nylon|guitar_?$/, { harmonics: [1, 0.65, 0.45, 0.3, 0.2, 0.12, 0.08, 0.05], ring: 0.9 }],
  [/overdrive|distortion/, { harmonics: sawtooth(24), lowpass: 2800 }],
  [/harp/, { harmonics: [1, 0.4, 0.2, 0.1, 0.05], ring: 1 }],
  [/slap_bass/, { harmonics: [1, 0.75, 0.55, 0.45, 0.35, 0.25, 0.15], ring: 0.6 }],
  [/synth_bass|mega_bass/, { harmonics: sawtooth(16), lowpass: 1400 }],
  [/fretless_bass/, { harmonics: [1, 0.5, 0.25, 0.12, 0.05] }],
  [/bass/, { harmonics: [1, 0.55, 0.3, 0.15, 0.08, 0.04], ring: 1.2 }],
  [/square_wave/, { harmonics: [1, 0, 1 / 3, 0, 1 / 5, 0, 1 / 7, 0, 1 / 9] }],
  [/xylophone/, { harmonics: [1, 0, 0.35, 0, 0.15], ring: 0.25 }],
  [/glockenspiel/, { harmonics: [1, 0, 0, 0.4, 0, 0, 0.2], ring: 0.9 }],
  [/tubular_bell/, { harmonics: [1, 0.3, 0.5, 0.2, 0.3, 0.1], ring: 2.2 }],
  [/bell/, { harmonics: [1, 0, 0.45, 0, 0.2], ring: 1 }],
];

const FALLBACK = { harmonics: [1, 0.3, 0.1] };

/** @param {string} name */
export function sampleSound(name) {
  return SAMPLES.find(([pattern]) => pattern.test(name))?.[1] ?? FALLBACK;
}

const midiToFrequency = (note) => 440 * 2 ** ((note - 69) / 12);

/** Per context: the periodic waves and noise the voices are made from, made once. */
const stores = new WeakMap();
function store(context) {
  let entry = stores.get(context);
  if (!entry) {
    entry = { waves: new Map(), noise: null, metallic: null, buffers: new Map() };
    stores.set(context, entry);
  }
  return entry;
}

/**
 * A periodic wave from one cycle of samples, or from harmonic strengths.
 *
 * @param {BaseAudioContext} context
 * @param {string} key
 * @param {() => {real: Float32Array, imag: Float32Array}} make
 */
function periodic(context, key, make) {
  const waves = store(context).waves;
  let wave = waves.get(key);
  if (!wave) {
    const { real, imag } = make();
    wave = context.createPeriodicWave(real, imag);
    waves.set(key, wave);
  }
  return wave;
}

/** The Fourier series of one cycle of samples. */
export function seriesOf(samples) {
  const count = samples.length;
  const mean = samples.reduce((sum, value) => sum + value, 0) / count;
  const harmonics = Math.floor(count / 2);
  const real = new Float32Array(harmonics);
  const imag = new Float32Array(harmonics);
  for (let k = 1; k < harmonics; k++) {
    let re = 0;
    let im = 0;
    for (let j = 0; j < count; j++) {
      const angle = (2 * Math.PI * k * j) / count;
      re += (samples[j] - mean) * Math.cos(angle);
      im += (samples[j] - mean) * Math.sin(angle);
    }
    real[k] = (2 * re) / count;
    imag[k] = (2 * im) / count;
  }
  return { real, imag };
}

/** The Game Boy pulse's duty settings: an eighth, a quarter, a half, three quarters high. */
const DUTIES = [0.125, 0.25, 0.5, 0.75];

function pulseWave(context, duty) {
  return periodic(context, `pulse${duty}`, () => {
    const high = DUTIES[duty] ?? 0.5;
    return seriesOf(Array.from({ length: 256 }, (_, i) => (i / 256 < high ? 1 : -1)));
  });
}

function tableWave(context, steps) {
  return periodic(context, `table${steps.join(',')}`, () => seriesOf(steps.map((step) => step / 7.5 - 1)));
}

function toneWave(context, harmonics) {
  return periodic(context, `tone${harmonics.join(',')}`, () => {
    const real = new Float32Array(harmonics.length + 1);
    const imag = new Float32Array(harmonics.length + 1);
    harmonics.forEach((strength, index) => (imag[index + 1] = strength));
    return { real, imag };
  });
}

/** A second of white noise, and the Game Boy's short-period (7-bit) noise. */
function noiseOf(context, metallic = false) {
  const entry = store(context);
  if (!metallic && entry.noise) return entry.noise;
  if (metallic && entry.metallic) return entry.metallic;
  const length = metallic ? 127 : context.sampleRate;
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  if (metallic) {
    let lfsr = 0x7f;
    for (let i = 0; i < length; i++) {
      const bit = (lfsr ^ (lfsr >> 1)) & 1;
      lfsr = (lfsr >> 1) | (bit << 6);
      data[i] = bit ? 1 : -1;
    }
    entry.metallic = buffer;
  } else {
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    entry.noise = buffer;
  }
  return buffer;
}

/**
 * Sound one note of a track.
 *
 * @param {BaseAudioContext} context
 * @param {Track} track
 * @param {Note} note
 * @param {number} when
 * @param {AudioNode} sink
 * @param {number} [level] the song's own volume
 */
export function playVoice(context, track, note, when, sink, level = 1) {
  const voice = voiceAt(track, note.n);
  if (!voice) return;
  // A kit's drum sounds at the key the kit gives it, not the key it is on;
  // a recorded one is struck and rings out, and a Game Boy one (a hi-hat on
  // the noise channel) is held for as long as the note, as the driver does.
  const key = track.kit ? voice.key ?? 60 : note.n;
  const struck = Boolean(track.kit) && voice.w === 'sample';
  const goal = Math.max(1, Math.round(note.v * level * 15));
  const pan = voice.p ?? note.p ?? 0;

  let out = sink;
  if (pan && typeof context.createStereoPanner === 'function') {
    const panner = context.createStereoPanner();
    panner.pan.value = pan * PAN_WIDTH;
    panner.connect(sink);
    out = panner;
  }

  if (voice.w === 'sample') {
    const sample = recorded.get(voice.s);
    if (sample) {
      const nodes = sampled(context, voice.s, sample, voice, key, note, when, out);
      // A kit's samples are a few hundredths of a second of hit, and want
      // more level than a held instrument to be heard as well.
      shape(nodes, voice, 0, note, when, false, note.v * level * (track.kit ? LEVEL.kit : LEVEL.recorded));
      return;
    }
    const sound = sampleSound(voice.s);
    if ('drum' in sound) {
      const pitch = voice.fixed ? 1 : 2 ** ((key - 60) / 12);
      strike(context, sound, pitch, when, note.v * level * LEVEL.drum, out);
      return;
    }
    const nodes = tone(context, toneWave(context, sound.harmonics), key, note, when, out, sound.lowpass);
    if (sound.thump) strike(context, { drum: [{ noise: 'lowpass', freq: 300, decay: 0.05, gain: 0.5 }] }, 1, when, note.v * level * LEVEL.drum, out);
    shape(nodes, voice, sound.ring, note, when, struck, note.v * level * LEVEL.sample);
    return;
  }

  if (voice.w === 'noise') {
    const source = context.createBufferSource();
    source.buffer = noiseOf(context, voice.period === 1);
    source.loop = true;
    const filter = context.createBiquadFilter();
    if (voice.period === 1) {
      // The short pattern's pitch follows the key, as the hardware's clock does.
      source.playbackRate.value = (midiToFrequency(key + 12) * 127) / context.sampleRate;
      filter.type = 'highpass';
      filter.frequency.value = 200;
    } else {
      filter.type = 'bandpass';
      filter.frequency.value = Math.max(200, Math.min(12000, midiToFrequency(key + 36)));
      filter.Q.value = 0.8;
    }
    const gain = context.createGain();
    source.connect(filter);
    filter.connect(gain);
    gain.connect(out);
    shape({ gain, sources: [source] }, voice, 0, note, when, false, (goal / 15) * LEVEL.noise, goal);
    return;
  }

  // The driver plays nothing on a Game Boy channel lower than C2: a lower
  // note comes out on C2.
  const low = Math.max(36, key);
  if (voice.w === 'square') {
    // A sweep that runs off the top of the channel's range switches it off,
    // through a gate of its own so the envelope's shape is left alone.
    let gate = null;
    if (voice.sw) {
      gate = context.createGain();
      gate.connect(out);
    }
    const nodes = tone(context, pulseWave(context, voice.duty), low, note, when, gate ?? out, gate ? SWEPT.lowpass : 0);
    if (gate) sweep(nodes.source.frequency, gate.gain, voice.sw ?? 0, midiToFrequency(low), when, note.d + 0.1);
    shape(nodes, voice, 0, note, when, false, (goal / 15) * LEVEL.square * (gate ? SWEPT.level : 1), goal);
    return;
  }
  // The wave channel plays its whole 32-step table in the time a pulse
  // channel plays one cycle twice over — an octave down on the same setting —
  // so the cartridge's tables hold their shape twice to sound at the note.
  const nodes = tone(context, tableWave(context, voice.wave), low, note, when, out, 0, 0.5);
  shape(nodes, voice, 0, note, when, false, (goal / 15) * LEVEL.wave, goal);
}

/**
 * The first pulse channel's frequency sweep, as the hardware runs it.
 *
 * The register says how often to step (`time`, in 128ths of a second), which
 * way (`down`), and how far: each step adds or takes away the channel's
 * eleven-bit frequency value shifted right by `shift`. Going up, the step
 * that would carry it past 2047 switches the channel off instead — which is
 * what makes the short rising chirp a fanfare's sparkle ends on, rather than
 * the steady beep it played as while the sweep was ignored.
 *
 * @param {AudioParam} frequency the oscillator's
 * @param {AudioParam} gate a gain the note passes through, shut at overflow
 * @param {number} register the voice's sweep value (NR10)
 * @param {number} hz the note's own frequency
 * @param {number} when
 * @param {number} length how long the note can be heard for, at most
 */
export function sweep(frequency, gate, register, hz, when, length) {
  const steps = sweepSteps(register, hz, length);
  for (const step of steps) {
    if (step.hz === null) {
      gate.setValueAtTime(1, when + step.at);
      gate.linearRampToValueAtTime(0, when + step.at + 0.003);
      return;
    }
    frequency.setValueAtTime(step.hz, when + step.at);
  }
}

/**
 * Where a sweep takes a note, step by step: when each step comes, a second
 * from the note's start, and the frequency it lands on — or `null`, the step
 * that runs the channel off the top of its range and silences it.
 *
 * @param {number} register
 * @param {number} hz
 * @param {number} length
 * @returns {Array<{at: number, hz: number|null}>}
 */
export function sweepSteps(register, hz, length) {
  const time = (register >> 4) & 7;
  const down = (register & 8) !== 0;
  const shift = register & 7;
  if (!time || !shift) return [];
  // The channel's frequency value: 131072 / (2048 - x) Hz.
  let x = Math.max(0, Math.min(2047, Math.round(2048 - 131072 / hz)));
  const steps = [];
  for (let at = time / 128; at <= length && steps.length < 256; at += time / 128) {
    x = down ? x - (x >> shift) : x + (x >> shift);
    if (x > 2047) {
      steps.push({ at, hz: null });
      break;
    }
    steps.push({ at, hz: 131072 / (2048 - x) });
  }
  return steps;
}

/**
 * An oscillator at a key, bent and wobbled as the note says.
 *
 * @param {number} [lowpass] a filter over the top, in Hz
 * @param {number} [cycle] how much of a cycle of the wave sounds at the key
 * @returns {{source: OscillatorNode, gain: GainNode, sources: AudioScheduledSourceNode[]}}
 */
function tone(context, wave, key, note, when, out, lowpass = 0, cycle = 1) {
  const oscillator = context.createOscillator();
  oscillator.setPeriodicWave(wave);
  oscillator.frequency.value = midiToFrequency(key) * cycle;
  const sources = [oscillator, ...bend(context, oscillator.detune, note, when)];
  const gain = context.createGain();
  if (lowpass) {
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = lowpass;
    filter.Q.value = 0.5;
    oscillator.connect(filter);
    filter.connect(gain);
  } else {
    oscillator.connect(gain);
  }
  gain.connect(out);
  return { source: oscillator, gain, sources };
}

/**
 * Bend a note as it says — where it starts, where it slides to while held —
 * and wobble it with its vibrato. Gives back the vibrato's oscillator, if it
 * has one, to start and stop with the note.
 *
 * @param {BaseAudioContext} context
 * @param {AudioParam} detune
 * @param {Note} note
 * @param {number} when
 * @returns {AudioScheduledSourceNode[]}
 */
function bend(context, detune, note, when) {
  if (note.b) detune.setValueAtTime(note.b * 100, when);
  for (const [at, semitones] of note.g ?? []) detune.setValueAtTime(semitones * 100, when + at);
  if (!note.m || !note.r) return [];
  const lfo = context.createOscillator();
  lfo.type = 'triangle';
  lfo.frequency.value = note.r;
  const depth = context.createGain();
  depth.gain.value = note.m * 100;
  lfo.connect(depth);
  depth.connect(detune);
  return [lfo];
}

/**
 * One of the cartridge's recorded samples at a key: at its own rate on key
 * 60 and retuned from there (or not at all, for a voice that plays it as it
 * is), going round its loop for as long as the note is held.
 *
 * @returns {{gain: GainNode, sources: AudioScheduledSourceNode[]}}
 */
function sampled(context, name, sample, voice, key, note, when, out) {
  const buffer = bufferOf(context, name, sample);
  const source = context.createBufferSource();
  source.buffer = buffer;
  const retune = voice.fixed ? 1 : 2 ** ((key - 60) / 12);
  source.playbackRate.value = (sample.pitch / buffer.sampleRate) * retune;
  if (sample.loop !== null && sample.loop < sample.end) {
    source.loop = true;
    source.loopStart = sample.loop / buffer.sampleRate;
    source.loopEnd = sample.end / buffer.sampleRate;
  }
  const gain = context.createGain();
  source.connect(gain);
  gain.connect(out);
  return { gain, sources: [source, ...bend(context, source.detune, note, when)] };
}

/**
 * A sample as an audio buffer for a context, made once. A buffer cannot be
 * slower than 3000 a second, which the high piano is, so a slow one is given
 * a rate doubled until it is not — its playback rate takes that back out.
 */
function bufferOf(context, name, sample) {
  const buffers = store(context).buffers;
  let buffer = buffers.get(name);
  if (!buffer) {
    let rate = sample.rate;
    while (rate < 3000) rate *= 2;
    buffer = context.createBuffer(1, sample.data.length, rate);
    buffer.getChannelData(0).set(sample.data);
    buffers.set(name, buffer);
  }
  return buffer;
}

/**
 * Run a note's loudness through its voice's envelope: up, down to where it
 * sustains (or away to nothing, for a sound that rings out of itself), and
 * off when the key is let go — or, for a kit's drum, when it has rung out.
 */
function shape({ gain, sources }, voice, ring, note, when, struck, peak, goal = 15) {
  const envelope = envelopeOf(voice, goal);
  const top = when + envelope.attack;
  // A drum is struck and left: it ends when it has died away, however long
  // the file holds the key.
  const held = struck ? Math.max(0.05, ring || envelope.decay || 0.1) * 3 : Math.max(note.d, envelope.attack);
  const off = when + held;
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.linearRampToValueAtTime(Math.max(0.0001, peak), top);
  let target = peak * envelope.sustain;
  let fall = envelope.decay;
  // A sound that dies away of itself (a piano, a pluck) does so even where
  // its voice holds a level, but never slower than the voice lets it.
  if (ring) {
    target = 0;
    fall = envelope.sustain < 0.02 && fall > 0 ? Math.min(fall, ring) : ring;
  }
  if (envelope.linear && !ring) {
    if (envelope.decay > 0) {
      // Only as far down as it gets before the key is let go: a ramp that
      // ran on past the let-go would hold the note up through its release.
      const until = Math.min(top + envelope.decay, off);
      const share = (until - top) / envelope.decay;
      gain.gain.linearRampToValueAtTime(Math.max(0.0001, peak + (target - peak) * share), until);
    } else {
      gain.gain.setValueAtTime(Math.max(0.0001, target), top);
    }
  } else if (fall === 0) {
    gain.gain.setValueAtTime(Math.max(0.0001, target), top);
  } else if (Number.isFinite(fall)) {
    gain.gain.setTargetAtTime(target, top, fall);
  }
  gain.gain.setTargetAtTime(0, off, envelope.release / 3);
  const end = off + envelope.release * 2 + 0.02;
  for (const source of sources) {
    source.start(when);
    source.stop(end);
  }
  sources[0].onended = () => gain.disconnect();
}

/**
 * A drum: each layer a tone swept from one pitch to another or a band of
 * noise, struck and dying away.
 *
 * @param {BaseAudioContext} context
 * @param {Drum} sound
 * @param {number} pitch how far the kit retunes it, as a ratio
 */
function strike(context, sound, pitch, when, level, out) {
  const base = (sound.base ?? 1) * pitch;
  for (const hit of sound.drum) {
    const bursts = hit.bursts ?? 1;
    for (let burst = 0; burst < bursts; burst++) {
      const at = when + burst * 0.012;
      const gain = context.createGain();
      /** @type {AudioScheduledSourceNode} */
      let source;
      let head = gain;
      if (hit.noise) {
        const buffer = context.createBufferSource();
        buffer.buffer = noiseOf(context);
        buffer.loop = true;
        const filter = context.createBiquadFilter();
        filter.type = hit.noise;
        filter.frequency.value = hit.freq ?? 1000;
        filter.Q.value = hit.q ?? 0.7;
        buffer.connect(filter);
        filter.connect(gain);
        source = buffer;
      } else {
        const oscillator = context.createOscillator();
        oscillator.type = hit.tone ?? 'sine';
        const scale = hit.pitched ? base : pitch;
        const from = (hit.from ?? 1) * scale;
        oscillator.frequency.setValueAtTime(from, at);
        if (hit.to) oscillator.frequency.exponentialRampToValueAtTime(hit.to * scale, at + (hit.sweep ?? 0.05));
        if (hit.band) {
          const filter = context.createBiquadFilter();
          filter.type = 'bandpass';
          filter.frequency.value = hit.band;
          oscillator.connect(filter);
          filter.connect(gain);
        } else {
          oscillator.connect(gain);
        }
        source = oscillator;
      }
      head.connect(out);
      const peak = Math.max(0.0001, level * hit.gain * (burst === bursts - 1 ? 1 : 0.6));
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.linearRampToValueAtTime(peak, at + 0.002);
      gain.gain.setTargetAtTime(0.0001, at + 0.002, hit.decay / 3);
      source.start(at);
      source.stop(at + hit.decay * 2.5 + 0.02);
      source.onended = () => gain.disconnect();
    }
  }
}
