/**
 * The sound engine's own bookkeeping: which track is playing, and what a cue
 * does to it.
 *
 * The synthesiser itself needs a Web Audio context and a window timer, so both
 * are stubbed here — nothing below listens to the result, only to which song
 * the engine decided should be sounding.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** A song the scheduler can run: one track, one note, half a second long. */
const SONG = { duration: 0.5, tracks: [{ program: 0, notes: [{ t: 0, d: 0.1, n: 60, v: 0.5 }] }] };

/** The timers the engine schedules on, driven by hand. */
const timers = new Map();
let nextTimer = 1;
let now = 0;

/** An audio parameter, reduced to what the engine calls on one. */
const param = () => ({ value: 0, setTargetAtTime() {}, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });

/** Every Web Audio node the engine touches, reduced to what it calls on them. */
const node = () => ({
  connect() {},
  disconnect() {},
  start() {},
  stop() {},
  setPeriodicWave() {},
  gain: param(),
  frequency: param(),
  detune: param(),
  playbackRate: param(),
  pan: param(),
  Q: param(),
  threshold: param(),
  knee: param(),
  ratio: param(),
  attack: param(),
  release: param(),
  type: '',
  buffer: null,
  loop: false,
  getChannelData: () => new Float32Array(1),
  onended: null,
});

globalThis.AudioContext = /** @type {any} */ (function AudioContextStub() {
  return {
    get currentTime() {
      return now;
    },
    destination: node(),
    sampleRate: 100,
    createGain: node,
    createOscillator: node,
    createBufferSource: node,
    createBiquadFilter: node,
    createBuffer: node,
    createStereoPanner: node,
    createConvolver: node,
    createDynamicsCompressor: node,
    createPeriodicWave: () => ({}),
  };
});

globalThis.window = /** @type {any} */ ({
  setInterval: (fn) => {
    const id = nextTimer++;
    timers.set(id, fn);
    return id;
  },
  clearInterval: (id) => timers.delete(id),
});

/**
 * A song with an intro: a fanfare for its first two seconds, then a body the
 * file marks as looping — the shape of every victory theme on the cartridge.
 */
const LOOPED = {
  duration: 10,
  loop: 2,
  tracks: [
    {
      program: 0,
      notes: [
        { t: 0, d: 0.1, n: 60, v: 0.5 },
        { t: 2.6, d: 0.1, n: 62, v: 0.5 },
        { t: 6, d: 0.1, n: 64, v: 0.5 },
      ],
    },
  ],
};

globalThis.fetch = /** @type {any} */ (
  async (address) => ({ ok: true, status: 200, json: async () => (String(address).includes('looped') ? LOOPED : SONG) })
);

const { AudioEngine } = await import('../../app/renderer/core/audio.mjs');

/** Run every scheduled tick once, the way the browser's timers would. */
const tick = (seconds = 0) => {
  now += seconds;
  for (const fn of [...timers.values()]) fn();
};

/** Let the engine's own promises — loading a song — finish. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Watch where the songs' level is sent: 0 under a cue, 1 otherwise. */
const watchDuck = (audio) => {
  const levels = [];
  audio.start();
  audio.songGain.gain.setTargetAtTime = (value) => levels.push(value);
  return levels;
};

test('a cue silences the music without stopping it, and lets it be heard again when it ends', async () => {
  const audio = new AudioEngine();
  const levels = watchDuck(audio);
  await audio.playMusic('route');
  const playing = audio.current;
  assert.equal(playing?.name, 'route');

  // The fanfare takes the speaker: the battle theme and a victory jingle
  // playing over each other was the whole complaint.
  await audio.playJingle('victory');
  assert.equal(audio.jingle?.name, 'victory');
  assert.deepEqual(levels, [0]);
  // Still going, underneath: a level-up chime sent the battle theme back to
  // its first bar when the cue stopped it outright.
  assert.equal(audio.current, playing);

  // Past the end of the cue, the same playthrough is heard again.
  tick(2);
  await settle();
  assert.equal(audio.jingle, null);
  assert.equal(audio.current, playing);
  assert.deepEqual(levels, [0, 1]);
});

test("the music silenced under a cue keeps its place, its notes still queued on the songs' channel", async () => {
  const audio = new AudioEngine();
  /** @type {Array<{output: any, when: number}>} */
  const voiced = [];
  audio.playNote = (track, note, when, output) => voiced.push({ output, when });
  await audio.playMusic('route');
  await audio.playJingle('victory');
  voiced.length = 0;
  tick(0.6);
  // The song's notes go through a gain of its own, which feeds the songs'
  // channel: the one a recording of it crosses over from.
  const song = audio.current?.live;
  assert.ok(song, 'the song has a gain of its own');
  assert.ok(voiced.some((entry) => entry.output === song), 'the song goes on under the cue');
  assert.ok(voiced.every((entry) => entry.output === song || entry.output === audio.musicGain));
});

test('a track asked for during a cue is the one that comes back', async () => {
  const audio = new AudioEngine();
  await audio.playMusic('battle');
  await audio.playJingle('victory');

  // Leaving a battle asks for the area's music while the fanfare is still
  // going; it must not start underneath the cue, and it must not be lost.
  // The battle theme it replaces stops then and there.
  await audio.playMusic('route');
  assert.equal(audio.current, null);
  assert.equal(audio.wanted, 'route');

  tick(2);
  await settle();
  assert.equal(audio.current?.name, 'route');
  assert.equal(audio.current?.startedAt, now + 0.1, 'from its first bar');
});

test('a cue can be the opening run of a song alone, quick, landing on its last note, without bass or drums', async () => {
  const audio = new AudioEngine();
  const voiced = [];
  audio.playNote = (track, note, when, output) => {
    if (output === audio.musicGain) voiced.push(note);
  };
  // Three notes, then a chord counted as one — held, with a bass and a drum
  // coming in under it — then the melody the cue stops before.
  audio.loadSong = async () => ({
    duration: 10,
    loop: 2,
    tracks: [
      { notes: [{ t: 0, d: 0.1, n: 60, v: 0.5 }, { t: 0.1, d: 0.1, n: 62, v: 0.5 }, { t: 0.2, d: 0.1, n: 64, v: 0.5 }, { t: 0.3, d: 1.2, n: 67, v: 0.5 }, { t: 1.5, d: 0.1, n: 65, v: 0.5 }] },
      { notes: [{ t: 0.3, d: 1.3, n: 55, v: 0.5 }, { t: 0.5, d: 0.1, n: 50, v: 0.5 }] },
      { notes: [{ t: 0.3, d: 0.4, n: 40, v: 0.5 }] },
      { kit: {}, notes: [{ t: 0.3, d: 0.05, n: 40, v: 0.5 }] },
    ],
  });
  await audio.playJingle('run', { notes: 4 });
  assert.ok(Math.abs((audio.jingle?.limit ?? 0) - 0.9) < 1e-9, 'over once the last note has rung its 0.6 s');
  for (let step = 0; step < 30 && audio.jingle; step++) tick(0.1);
  assert.deepEqual(voiced.map((note) => note.n).sort(), [55, 60, 62, 64, 67], 'neither the bass nor the drum');
  assert.ok(voiced.every((note) => note.v === 0.5), 'no fade');
  assert.ok(voiced.filter((note) => note.t < 0.3).every((note) => note.d === 0.1), 'the run up as written');
  assert.deepEqual(voiced.filter((note) => note.t === 0.3).map((note) => Math.round(note.d * 1000)), [600, 600], 'the last held, but not for its written 1.2 s');
});

test('asking for the track already playing changes nothing', async () => {
  const audio = new AudioEngine();
  await audio.playMusic('route');
  const playing = audio.current;
  await audio.playMusic('route');
  assert.equal(audio.current, playing);
});

test('stopping the music leaves nothing waiting to come back', async () => {
  const audio = new AudioEngine();
  await audio.playMusic('route');
  await audio.playMusic(null);
  assert.equal(audio.current, null);
  assert.equal(audio.wanted, null);

  tick(2);
  assert.equal(audio.current, null);
});

test('a cue can be cut to its opening phrase', async () => {
  const audio = new AudioEngine();
  await audio.playMusic('route');
  // The stub song is half a second long; ask for a fifth of it.
  await audio.playJingle('victory', { seconds: 0.1 });
  assert.equal(audio.jingle?.limit, 0.1);

  // It is over — and the music back — well before the whole song would have
  // finished, which is the point of cutting it.
  now += 0.6;
  tick();
  await settle();
  assert.equal(audio.jingle, null);
  assert.equal(audio.current?.name, 'route');
});

test('a cue is never stretched past the song it came from', async () => {
  const audio = new AudioEngine();
  await audio.playJingle('victory', { seconds: 30 });
  assert.equal(audio.jingle?.limit, 0.5);
});

test('cues play on the music channel, where the music slider reaches them', async () => {
  const audio = new AudioEngine();
  const voiced = [];
  audio.playNote = (program, note, when, output) => voiced.push(output);

  await audio.playJingle('victory');
  assert.ok(voiced.length > 0, 'the cue should have voiced something');
  for (const output of voiced) assert.equal(output, audio.musicGain);
});

test('a cue played for its intro stops where the loop begins, fading the loop out', async () => {
  const audio = new AudioEngine();
  const voiced = [];
  // Only the cue's own notes: the route plays either side of it, and on
  // underneath it on its own channel.
  audio.playNote = (program, note, when, output) => {
    if (audio.jingle && output === audio.musicGain) voiced.push(note);
  };

  await audio.playMusic('route');
  await audio.playJingle('looped', { intro: true });
  // The fanfare, then a little over a second of the loop fading under it —
  // not the ten seconds of loop the file goes on to hold.
  assert.equal(audio.jingle?.fadeFrom, 2);
  assert.ok(audio.jingle.limit > 2 && audio.jingle.limit < 4, `limit ${audio.jingle.limit}`);

  for (let step = 0; step < 40 && audio.jingle; step++) {
    tick(0.1);
    await settle();
  }
  assert.equal(audio.jingle, null);
  assert.equal(audio.current?.name, 'route');

  assert.deepEqual(voiced.map((note) => note.n), [60, 62], 'the note deep in the loop is never played');
  assert.equal(voiced[0].v, 0.5, 'the intro plays at full strength');
  assert.ok(voiced[1].v > 0 && voiced[1].v < 0.5, 'the loop comes in already fading');
});

test('asking for the intro of a song with no loop plays all of it', async () => {
  const audio = new AudioEngine();
  await audio.playJingle('victory', { intro: true });
  assert.equal(audio.jingle?.limit, 0.5);
  assert.equal(audio.jingle?.fadeFrom, 0.5);
});

test('a looping song plays its intro once and then goes round its loop', async () => {
  const audio = new AudioEngine();
  /** @type {Array<{n: number, when: number}>} */
  const voiced = [];
  audio.playNote = (track, note, when) => voiced.push({ n: note.n, when });

  const started = now;
  await audio.playMusic('looped');
  // Three times through the song's length, a tenth of a second at a time.
  for (let step = 0; step < 300; step++) tick(0.1);
  audio.stopMusic();

  const at = (n) => voiced.filter((note) => note.n === n).map((note) => Math.round((note.when - started) * 10) / 10);
  // The fanfare at 0 is the intro, heard once; the loop is 2 to 10, so its
  // notes come back every eight seconds rather than every ten.
  assert.deepEqual(at(60), [0.1]);
  assert.deepEqual(at(62).slice(0, 3), [2.7, 10.7, 18.7]);
  assert.deepEqual(at(64).slice(0, 3), [6.1, 14.1, 22.1]);
});

test('a track plays on the instrument its voicegroup gives it, a kit by the key', async () => {
  const { voiceAt } = await import('../../app/renderer/core/synth.mjs');
  /** @typedef {import('../../app/renderer/core/synth.mjs').Voice} Voice */
  /** @type {Voice} */
  const snare = { w: 'sample', s: 'sc88pro_rnd_snare', key: 60, fixed: true, env: [255, 0, 255, 242] };
  const kit = { kit: { 38: snare } };
  assert.equal(voiceAt(kit, 38), snare);
  assert.equal(voiceAt(kit, 39), null, 'a key the kit leaves empty is silent');

  /** @type {Voice} */
  const low = { w: 'sample', s: 'sc88pro_piano1_48', key: 60, env: [255, 250, 0, 200] };
  /** @type {Voice} */
  const high = { w: 'sample', s: 'sc88pro_piano1_84', key: 60, env: [255, 250, 0, 200] };
  const piano = { split: [{ to: 55, voice: low }, { to: 108, voice: high }] };
  assert.equal(voiceAt(piano, 40), low);
  assert.equal(voiceAt(piano, 80), high);
  assert.equal(voiceAt(piano, 120), high, 'above the last range is the last range');

  /** @type {Voice} */
  const square = { w: 'square', duty: 2, env: [0, 0, 15, 0] };
  assert.equal(voiceAt({ voice: square }, 60), square);
  // A track from before the instruments were known still makes a sound.
  assert.ok(voiceAt({ program: 33 }, 40));
});

test("envelopes keep the driver's shape: struck sounds die, held ones sustain", async () => {
  const { envelopeOf } = await import('../../app/renderer/core/synth.mjs');
  // The champion theme's pizzicato: full at once, falling to nothing.
  const pizzicato = envelopeOf({ w: 'sample', s: 'pizzicato_strings', key: 60, env: [255, 216, 0, 165] });
  assert.ok(pizzicato.attack < 0.01);
  assert.equal(pizzicato.sustain, 0);
  assert.ok(pizzicato.decay > 0.05 && pizzicato.decay < 0.2, `decay ${pizzicato.decay}`);
  // Its flute: held at full, and let go quickly.
  const flute = envelopeOf({ w: 'sample', s: 'flute', key: 60, env: [255, 0, 255, 165] });
  assert.equal(flute.sustain, 1);
  assert.ok(flute.release < 0.1);
  // A Game Boy square at sustain 7 of 15, a step a frame down from full.
  const square = envelopeOf({ w: 'square', duty: 2, env: [0, 1, 7, 1] });
  assert.ok(Math.abs(square.sustain - 7 / 15) < 1e-9);
  assert.ok(Math.abs(square.decay - 8 / 60) < 1e-9);
  // Release 0 cuts the note, all but at once.
  assert.ok(envelopeOf({ w: 'square', duty: 2, env: [0, 0, 15, 0] }).release < 0.02);
});

test('samples are stood in for by what they are', async () => {
  const { sampleSound } = await import('../../app/renderer/core/synth.mjs');
  assert.ok('drum' in sampleSound('sc88pro_rnd_snare'), 'a snare is struck');
  assert.ok('drum' in sampleSound('drum_and_percussion_kick'));
  assert.ok('drum' in sampleSound('sd90_ambient_tom'));
  const timpani = sampleSound('sc88pro_timpani');
  assert.ok('harmonics' in timpani && timpani.ring > 0, 'the timpani has a pitch and rings out');
  const flute = sampleSound('sc88pro_flute');
  assert.ok('harmonics' in flute && !flute.ring, 'a flute is held as long as the key');
  const pizzicato = sampleSound('sc88pro_pizzicato_strings');
  assert.ok('harmonics' in pizzicato && pizzicato.ring, 'a pizzicato is plucked, not bowed');
  assert.ok('harmonics' in sampleSound('sc88pro_string_ensemble_72'));
});

/**
 * A context that writes down what the synth asks of it: each oscillator's
 * frequency, and the automation on each gain.
 */
function recordingContext() {
  const oscillators = [];
  const gains = [];
  const param = (log) => ({
    value: 0,
    setValueAtTime: (value, at) => log?.push(['set', value, at]),
    linearRampToValueAtTime: (value, at) => log?.push(['ramp', value, at]),
    setTargetAtTime: (value, at) => log?.push(['target', value, at]),
    exponentialRampToValueAtTime: (value, at) => log?.push(['exp', value, at]),
  });
  const base = () => ({ connect() {}, disconnect() {}, start() {}, stop() {}, setPeriodicWave() {}, frequency: param(), detune: param(), Q: param(), playbackRate: param(), pan: param() });
  return {
    oscillators,
    gains,
    sampleRate: 48000,
    createOscillator() {
      const node = base();
      oscillators.push(node);
      return node;
    },
    createGain() {
      const log = [];
      const node = { ...base(), gain: param(log), log };
      gains.push(node);
      return node;
    },
    createBiquadFilter: base,
    createBufferSource: base,
    createStereoPanner: base,
    createBuffer: () => ({ getChannelData: () => new Float32Array(1) }),
    createPeriodicWave: () => ({}),
  };
}

test('the wave channel sounds its table an octave under a pulse channel on the same note', async () => {
  const { playVoice } = await import('../../app/renderer/core/synth.mjs');
  const note = { t: 0, d: 0.2, n: 69, v: 0.8 };
  const context = recordingContext();
  /** @type {any} */
  const sink = {};
  playVoice(/** @type {any} */ (context), { voice: { w: 'square', duty: 2, env: [0, 0, 15, 0] } }, note, 0, sink);
  playVoice(/** @type {any} */ (context), { voice: { w: 'wave', wave: Array(32).fill(0), env: [0, 0, 15, 0] } }, note, 0, sink);
  assert.deepEqual(context.oscillators.map((oscillator) => oscillator.frequency.value), [440, 220]);
});

test('a Game Boy note let go before it has decayed starts its release then, not after', async () => {
  const { playVoice } = await import('../../app/renderer/core/synth.mjs');
  const context = recordingContext();
  // Decay of 7 frames a step from full down to nothing: two seconds, on a
  // note held for a tenth of one.
  playVoice(/** @type {any} */ (context), { voice: { w: 'square', duty: 2, env: [0, 7, 0, 1] } }, { t: 0, d: 0.1, n: 60, v: 1 }, 0, /** @type {any} */ ({}));
  const [gain] = context.gains;
  const last = Math.max(...gain.log.filter(([kind]) => kind !== 'target').map(([, , at]) => at));
  assert.ok(last <= 0.1 + 1e-9, `the decay ran on to ${last}`);
  assert.deepEqual(gain.log.at(-1).slice(0, 1), ['target']);
  assert.equal(gain.log.at(-1)[2], 0.1, 'released at the end of the note');
});

test('a recorded sample is retuned from key 60 and loops where it loops; a fixed one is not retuned', async () => {
  const { playVoice, storeSample } = await import('../../app/renderer/core/synth.mjs');
  const pcm = Buffer.from(Array(100).fill(128)).toString('base64');
  storeSample('test_flute', { rate: 4000, pitch: 4000, loop: 40, end: 99, pcm });
  // The high piano is slower than an audio buffer may be.
  storeSample('test_high', { rate: 1672, pitch: 1672.4, loop: null, end: 100, pcm });
  const sources = [];
  /** @type {any} */
  const context = recordingContext();
  context.createBuffer = (channels, length, rate) => ({ sampleRate: rate, length, getChannelData: () => new Float32Array(length) });
  context.createBufferSource = () => {
    const source = { connect() {}, start() {}, stop() {}, playbackRate: { value: 0 }, detune: { setValueAtTime() {} }, loop: false, loopStart: 0, loopEnd: 0, buffer: null };
    sources.push(source);
    return source;
  };
  const sink = /** @type {any} */ ({});
  const note = (n) => ({ t: 0, d: 0.5, n, v: 0.8 });
  playVoice(/** @type {any} */ (context), { voice: { w: 'sample', s: 'test_flute', key: 60, env: [255, 0, 255, 165] } }, note(72), 0, sink);
  playVoice(/** @type {any} */ (context), { voice: { w: 'sample', s: 'test_flute', key: 60, fixed: true, env: [255, 0, 255, 165] } }, note(72), 0, sink);
  playVoice(/** @type {any} */ (context), { voice: { w: 'sample', s: 'test_high', key: 60, env: [255, 0, 255, 165] } }, note(60), 0, sink);
  const [up, fixed, high] = sources;
  assert.equal(up.playbackRate.value, 2, 'an octave up is twice as fast');
  assert.equal(up.loop, true);
  assert.equal(up.loopStart, 40 / 4000);
  assert.equal(up.loopEnd, 99 / 4000, 'round before the sample after the end');
  assert.equal(fixed.playbackRate.value, 1);
  assert.ok(high.buffer.sampleRate >= 3000);
  assert.ok(Math.abs(high.playbackRate.value * high.buffer.sampleRate - 1672.4) < 1e-6, 'and still plays at its own rate');
  assert.equal(high.loop, false);
});

test('the Game Boy channels play nothing lower than C2', async () => {
  const { playVoice } = await import('../../app/renderer/core/synth.mjs');
  const context = recordingContext();
  const sink = /** @type {any} */ ({});
  playVoice(/** @type {any} */ (context), { voice: { w: 'square', duty: 2, env: [0, 0, 15, 0] } }, { t: 0, d: 0.2, n: 33, v: 0.8 }, 0, sink);
  playVoice(/** @type {any} */ (context), { voice: { w: 'square', duty: 2, env: [0, 0, 15, 0] } }, { t: 0, d: 0.2, n: 36, v: 0.8 }, 0, sink);
  const [low, c2] = context.oscillators.map((oscillator) => oscillator.frequency.value);
  assert.equal(low, c2);
});

test("the first pulse channel's sweep slides the note, and running off the top silences it", async () => {
  const { sweepSteps } = await import('../../app/renderer/core/synth.mjs');
  // The berry fanfare's last chirp: up a sixty-fourth each 128th of a second
  // from A4, until the channel's frequency value passes 2047.
  const up = sweepSteps(0x16, 440, 0.2);
  assert.ok(Math.abs(up[0].at - 1 / 128) < 1e-9);
  assert.ok(up[0].hz > 440 && up[1].hz > up[0].hz, 'rising');
  assert.equal(up.at(-1)?.hz, null, 'switched off at the top');
  assert.ok(up.length < 15, 'within a tenth of a second');
  // Down never runs off, and only falls.
  const down = sweepSteps(0x1d, 1046.5, 0.1);
  assert.ok(down.every((step, i) => step.hz !== null && step.hz < (i ? down[i - 1].hz : 1046.5)));
  // No step time, or no shift, is no sweep at all.
  assert.deepEqual(sweepSteps(0x06, 440, 1), []);
  assert.deepEqual(sweepSteps(0x10, 440, 1), []);
});

/** A buffer of a steady tone for a while, then silence. */
function steadyBuffer(amplitude, seconds, silence = 0) {
  const rate = 1000;
  const data = new Float32Array(Math.round((seconds + silence) * rate));
  for (let i = 0; i < seconds * rate; i++) data[i] = i % 2 ? amplitude : -amplitude;
  return /** @type {any} */ ({ sampleRate: rate, length: data.length, numberOfChannels: 1, getChannelData: () => data });
}

test('a recording\'s level is how loud it is while it sounds, not counting the silence after', async () => {
  const { levelOf } = await import('../../app/renderer/core/audio.mjs');
  const half = 20 * Math.log10(0.5);
  assert.ok(Math.abs(levelOf(steadyBuffer(0.5, 1)) - half) < 0.01);
  // The same sound with a second of silence after it measures the same.
  assert.ok(Math.abs(levelOf(steadyBuffer(0.5, 1, 1)) - half) < 0.01);
});

test('cries are brought to one loudness, the quiet up and the loud down', async () => {
  const audio = new AudioEngine();
  audio.start();
  /** @type {any[]} */
  const trims = [];
  const context = /** @type {any} */ (audio.context);
  const createGain = context.createGain;
  context.createGain = () => {
    const gain = createGain();
    trims.push(gain);
    return gain;
  };
  // Both within the twelve dB a cry may be moved either way.
  /** @type {Array<[string, number]>} */
  const recordings = [['cries/1.ogg', 0.3], ['cries/2.ogg', 0.05]];
  for (const [path, amplitude] of recordings) audio.buffers.set(path, Promise.resolve(steadyBuffer(amplitude, 0.5)));
  await audio.playCry(1);
  await audio.playCry(2);
  const [loud, quiet] = trims.map((gain) => gain.gain.value);
  // Each lands on the same level: 0.3 × loud = 0.05 × quiet, to a float's precision.
  assert.ok(loud < 1 && quiet > 1);
  assert.ok(Math.abs((0.3 * loud) / (0.05 * quiet) - 1) < 1e-6);
});

test('a quiet cry with a sharp crack in it is not turned up past full scale', async () => {
  const audio = new AudioEngine();
  audio.start();
  /** @type {any[]} */
  const trims = [];
  const context = /** @type {any} */ (audio.context);
  const createGain = context.createGain;
  context.createGain = () => {
    const gain = createGain();
    trims.push(gain);
    return gain;
  };
  // Quiet all through but for one sample at half of full scale.
  const crack = steadyBuffer(0.02, 0.5);
  crack.getChannelData(0)[10] = 0.5;
  audio.buffers.set('cries/3.ogg', Promise.resolve(crack));
  await audio.playCry(3);
  assert.ok(trims[0].gain.value <= 2 + 1e-9, `turned up ${trims[0].gain.value} times`);
});

const { tapeOffset } = await import('../../app/renderer/core/audio.mjs');

test("a moment of a playthrough is found in the song's recording: once through, then round its loop", () => {
  const song = { duration: 10, loop: 2 };
  // The first time through is the recording's first ten seconds.
  assert.equal(tapeOffset(song, 3), 3);
  // After that it goes round the loop's second time, from 10 to 18.
  assert.equal(tapeOffset(song, 10), 10);
  assert.equal(tapeOffset(song, 11.5), 11.5);
  assert.equal(tapeOffset(song, 18), 10);
  assert.equal(tapeOffset(song, 19.5), 11.5);
  // A song with no loop marked goes round the whole of itself.
  assert.equal(tapeOffset({ duration: 4 }, 5), 5);
  assert.equal(tapeOffset({ duration: 4 }, 9), 5);
  assert.equal(tapeOffset(song, -0.05), 0);
});

/**
 * Watch the recording an engine plays: the buffer source it makes, where it
 * starts it, and whether it is stopped.
 */
const watchTape = (audio) => {
  audio.start();
  const made = [];
  audio.context.createBufferSource = () => {
    const source = { ...node(), started: null, stopped: null };
    source.start = (when, offset) => (source.started = { when, offset });
    source.stop = (when) => (source.stopped = when);
    made.push(source);
    return source;
  };
  return made;
};

test('a recording takes over from the live notes, from where the song has got to, and they stop', async () => {
  const audio = new AudioEngine();
  const made = watchTape(audio);
  const started = now;
  await audio.playMusic('looped');
  const playing = audio.current;
  // Its recording is in: the next tick hands over.
  playing.recorded = /** @type {any} */ ({ duration: 18 });
  const queued = timers.size;
  tick(0.12);
  assert.ok(playing.tape, 'the recording is playing');
  const tape = /** @type {any} */ (playing.tape.source);
  assert.ok(made.includes(tape));
  const { when, offset } = tape.started;
  assert.ok(when > now && when <= playing.queuedTo, 'on a moment already queued live but not yet heard');
  assert.ok(Math.abs(offset - (when - (started + 0.1))) < 1e-9, 'from the same place in the song');
  assert.equal(tape.loopStart, 10);
  assert.equal(tape.loopEnd, 18);
  assert.equal(timers.size, queued - 1, 'no more live notes are queued');

  // Asked for again, it goes on as it is.
  await audio.playMusic('looped');
  assert.equal(audio.current, playing);

  // Silenced under a cue like the live music is.
  const ducked = [];
  /** @type {any} */ (audio.tapeGain).gain.setTargetAtTime = (/** @type {number} */ value) => ducked.push(value);
  await audio.playJingle('victory');
  assert.deepEqual(ducked, [0]);
  audio.stopJingle();

  // And stopped with the music.
  audio.stopMusic();
  assert.ok(tape.stopped !== null, 'the recording stops');
  assert.equal(audio.current, null);
});

test('songs are recorded once, the last few kept, and nothing is recorded while nothing can be heard', async () => {
  let recordings = 0;
  globalThis.OfflineAudioContext = /** @type {any} */ (function OfflineStub(channels, length, rate) {
    const context = new globalThis.AudioContext();
    return {
      ...context,
      currentTime: 0,
      sampleRate: rate,
      suspend: () => new Promise(() => {}),
      resume: async () => {},
      startRendering: async () => {
        recordings++;
        return { length, sampleRate: rate, numberOfChannels: channels };
      },
    };
  });
  try {
    const audio = new AudioEngine();
    await audio.playMusic('song-1');
    await settle();
    assert.equal(recordings, 1);
    assert.ok(audio.current?.recorded, 'its recording is ready to take over');

    for (const name of ['song-2', 'song-3', 'song-4']) {
      await audio.playMusic(name);
      await settle();
    }
    assert.equal(recordings, 4);
    assert.deepEqual([...audio.tapes.keys()], ['song-2', 'song-3', 'song-4']);

    // One kept is not recorded again.
    await audio.playMusic('song-3');
    await settle();
    assert.equal(recordings, 4);
    assert.ok(audio.current?.recorded);
    assert.deepEqual([...audio.tapes.keys()], ['song-2', 'song-4', 'song-3']);

    // With every slider down nothing is recorded — until one comes up.
    audio.setVolumes({ masterVolume: 0 });
    await audio.playMusic('song-5');
    await settle();
    assert.equal(recordings, 4);
    audio.setVolumes({ masterVolume: 1 });
    await settle();
    assert.equal(recordings, 5);
    assert.ok(audio.current?.recorded);
    audio.stopMusic();
  } finally {
    delete globalThis.OfflineAudioContext;
  }
});
