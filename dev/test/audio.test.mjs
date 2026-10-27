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

/** Every Web Audio node the engine touches, reduced to what it calls on them. */
const node = () => ({
  connect() {},
  disconnect() {},
  start() {},
  stop() {},
  gain: { setTargetAtTime() {}, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
  frequency: { value: 0 },
  Q: { value: 0 },
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

test('a cue silences the music and hands it back when it ends', async () => {
  const audio = new AudioEngine();
  await audio.playMusic('route');
  assert.equal(audio.current?.name, 'route');

  // The fanfare takes the speaker: the battle theme and a victory jingle
  // playing over each other was the whole complaint.
  await audio.playJingle('victory');
  assert.equal(audio.jingle?.name, 'victory');
  assert.equal(audio.current, null);
  assert.equal(audio.wanted, 'route');

  // Past the end of the cue, the music comes back on its own.
  tick(2);
  await settle();
  assert.equal(audio.jingle, null);
  assert.equal(audio.current?.name, 'route');
});

test('a track asked for during a cue is the one that comes back', async () => {
  const audio = new AudioEngine();
  await audio.playMusic('battle');
  await audio.playJingle('victory');

  // Leaving a battle asks for the area's music while the fanfare is still
  // going; it must not start underneath the cue, and it must not be lost.
  await audio.playMusic('route');
  assert.equal(audio.current, null);
  assert.equal(audio.wanted, 'route');

  tick(2);
  await settle();
  assert.equal(audio.current?.name, 'route');
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
  // Only the cue's own notes: the route plays either side of it.
  audio.playNote = (program, note) => {
    if (audio.jingle) voiced.push(note);
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

test('the drum kit and the timpani are struck, not held as tones', async () => {
  const { voiceFor } = await import('../../app/renderer/core/audio.mjs');
  // Program 0 is the decomp's drum kit: the champion theme's snare is its 38,
  // a band of noise up where a snare sits rather than a low D.
  const snare = voiceFor(0, 38);
  assert.equal(snare.wave, 'noise');
  assert.ok(snare.band > 1000, `snare at ${snare.band} Hz`);
  assert.ok(voiceFor(0, 57).release > snare.release, 'a cymbal rings on longer than a snare');
  // The drum channel's kit is voiced the same way.
  assert.equal(voiceFor(128, 38).band, snare.band);
  // The timpani keeps its pitch but dies away instead of sustaining.
  const timpani = voiceFor(47, 52);
  assert.notEqual(timpani.wave, 'noise');
  assert.ok(timpani.hold && timpani.sustain < 0.2);
  // A melodic program is left as it was.
  assert.equal(voiceFor(48, 60).hold, undefined);
});
