/**
 * Sound: a small synthesiser for the soundtrack, plus sampled cries.
 *
 * The pipeline reduces each MIDI track to note events rather than rendering
 * audio, so music is a few kilobytes per song and is voiced here with
 * oscillators (`synth.mjs`) — which suits the GBA-era material it came from.
 * Notes are scheduled on a look-ahead timer so playback stays steady even
 * when the game loop stutters.
 */
import { loadAudioBuffer } from './assets.mjs';
import { url } from './bridge.mjs';
import { hasSample, playVoice, samplesOf, storeSample } from './synth.mjs';

/** How far ahead notes are queued, and how often the queue is topped up. */
const LOOKAHEAD_S = 0.4;
const TICK_MS = 120;

/** Hard cap on notes started per scheduling tick, so a dense bar cannot stall. */
const MAX_NOTES_PER_TICK = 64;

/**
 * How long a cue played for its intro takes to fade once the loop comes in:
 * about as long as the cartridge takes to fade the victory theme out when the
 * battle screen closes.
 */
const INTRO_FADE_S = 1.2;

export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.context = null;
    /** @type {GainNode|null} */
    this.musicGain = null;
    /** @type {GainNode|null} */
    this.effectGain = null;
    /** @type {GainNode|null} */
    this.cryGain = null;

    /** @type {{name: string, song: any, startedAt: number, cursors: number[], loops: number}|null} */
    this.current = null;
    /** @type {number|undefined} */
    this.timer = undefined;
    /** @type {Map<string, Promise<any>>} */
    this.songs = new Map();
    /** @type {Map<string, Promise<AudioBuffer>>} */
    this.buffers = new Map();

    this.musicVolume = 0.6;
    this.effectVolume = 0.8;
    this.cryVolume = 0.9;

    /** @type {{name: string, song: any, startedAt: number, cursors: number[], limit: number, fadeFrom: number}|null} */
    this.jingle = null;
    /** @type {number|undefined} */
    this.jingleTimer = undefined;

    /**
     * The track the game wants playing under everything else.
     *
     * Kept apart from `current`, which is only what the note scheduler happens
     * to be running: a cue silences the music while it plays, and this is what
     * comes back afterwards. It is also set the moment `playMusic` is called
     * rather than after the song has loaded, so a cue started in the same
     * frame as a track change resumes the new track and not the old one.
     * @type {string|null}
     */
    this.wanted = null;
  }

  /** Create the audio graph. Safe to call more than once. */
  start() {
    if (this.context) return;
    this.context = new AudioContext();
    this.musicGain = this.context.createGain();
    this.effectGain = this.context.createGain();
    this.cryGain = this.context.createGain();
    connectMusic(this.context, this.musicGain);
    this.effectGain.connect(this.context.destination);
    this.cryGain.connect(this.context.destination);
    this.applyVolumes();
  }

  /**
   * @param {{musicVolume?: number, effectVolume?: number, cryVolume?: number}} volumes
   */
  setVolumes({ musicVolume, effectVolume, cryVolume }) {
    if (typeof musicVolume === 'number') this.musicVolume = musicVolume;
    if (typeof effectVolume === 'number') this.effectVolume = effectVolume;
    if (typeof cryVolume === 'number') this.cryVolume = cryVolume;
    this.applyVolumes();
  }

  applyVolumes() {
    if (!this.context || !this.musicGain || !this.effectGain || !this.cryGain) return;
    const now = this.context.currentTime;
    // Music is mixed low: it plays under whatever the user is actually doing.
    this.musicGain.gain.setTargetAtTime(this.musicVolume * 0.22, now, 0.05);
    this.effectGain.gain.setTargetAtTime(this.effectVolume * 0.5, now, 0.05);
    this.cryGain.gain.setTargetAtTime(this.cryVolume * 0.6, now, 0.05);
  }

  /**
   * Play a track from `assets/bgm`, looping until something else is asked for.
   * @param {string|null} name
   */
  async playMusic(name) {
    if (!name) return this.stopMusic();
    this.start();
    // Recorded before anything is awaited, so whatever else happens in this
    // frame — a victory fanfare, a second track change — agrees on what the
    // music is meant to be.
    this.wanted = name;
    // A cue owns the speaker while it plays; this track comes back under it
    // when the cue finishes rather than starting underneath it now.
    if (this.jingle) return;
    if (this.current?.name === name) return;

    let song;
    try {
      song = await this.loadSong(name);
      await loadSamples(song);
    } catch {
      return; // a missing track is silence, not a broken game
    }
    // Something asked for a different track, or a cue started, while this one
    // was loading.
    if (!this.context || this.wanted !== name || this.jingle) return;

    this.haltMusic();
    this.current = {
      name,
      song,
      startedAt: this.context.currentTime + 0.1,
      cursors: song.tracks.map(() => 0),
      loops: 0,
    };
    this.timer = window.setInterval(() => this.schedule(), TICK_MS);
    this.schedule();
  }

  /**
   * Play one of the short cue tracks — the fanfares, the heal chime — once.
   *
   * A cue is music, and rides the music channel: the sound tab's music slider
   * is what a player reaches for to turn a victory fanfare down, not the one
   * labelled for the interface blips.
   *
   * These are sound effects that happen to be stored as MIDI: the cartridge
   * stops the area music, plays the jingle, and resumes. Looping them through
   * `playMusic` made the heal chime repeat forever, and replaced the area
   * music with two seconds of silence afterwards.
   *
   * Playing one *over* the music was no better — a victory fanfare and the
   * battle theme in two keys at once — so the music stands down for the cue
   * and `wanted` brings it back at the end, which is what the cartridge does.
   *
   * Scheduling reuses the music machinery, but on a private `current` that
   * clears itself at the end of the song instead of looping.
   *
   * @param {string|null} name
   * @param {{seconds?: number, intro?: boolean}} [options] how much of the cue
   *   to play. A fanfare written for a cartridge runs as long as the cartridge
   *   wanted to hold the screen; here it holds the area music off for that
   *   whole time, so the long ones are cut short. `seconds` is a hard cut;
   *   `intro` plays a looping song up to where its loop begins and fades the
   *   loop out as it comes in, which is how the victory themes are heard on
   *   the cartridge — a two-second fanfare, then the battle screen closing
   *   over a body written to be looped for as long as it stays open.
   */
  async playJingle(name, options = {}) {
    if (!name) return;
    this.start();
    if (!this.context) return;
    if (this.jingle?.name === name) return; // already playing this one

    let song;
    try {
      song = await this.loadSong(name);
      await loadSamples(song);
    } catch {
      return; // a missing cue is not worth a console error, let alone a break
    }
    if (!this.context || !this.musicGain) return;

    // The music steps aside for the cue; `wanted` still names it, so the end
    // of the cue puts it back.
    this.haltMusic();

    // A song that marks no loop has no intro to stop at, and plays whole.
    const intro = options.intro && song.loop > 0 ? song.loop : null;
    const wanted = intro !== null ? intro + INTRO_FADE_S : options.seconds ?? song.duration;
    // A floor only so a nonsense number cannot ask for a cue of no length.
    const limit = Math.max(0.05, Math.min(song.duration, wanted));
    const jingle = {
      name,
      song,
      startedAt: this.context.currentTime + 0.05,
      cursors: song.tracks.map(() => 0),
      limit,
      // Where the fade to the end starts; at the end itself, there is none.
      fadeFrom: Math.min(intro ?? limit, limit),
    };
    if (this.jingleTimer !== undefined) window.clearInterval(this.jingleTimer);
    this.jingle = jingle;
    this.jingleTimer = window.setInterval(() => this.scheduleJingle(), TICK_MS);
    this.scheduleJingle();
  }

  /**
   * Queue the jingle's notes once through, then stop scheduling and hand the
   * speaker back to the music.
   */
  scheduleJingle() {
    const jingle = this.jingle;
    if (!jingle || !this.context || !this.musicGain) return;
    const { song, cursors, limit, fadeFrom } = jingle;
    const horizon = this.context.currentTime + LOOKAHEAD_S;
    const end = jingle.startedAt + limit;
    let started = 0;

    // One pass is the whole cue: it is played once and never looped, so the
    // cursors run to the end of each track and stay there. Anything past the
    // cut is skipped rather than played, so a trimmed cue ends where it was
    // trimmed instead of going quiet with its notes still ringing.
    song.tracks.forEach((track, index) => {
      while (cursors[index] < track.notes.length && started < MAX_NOTES_PER_TICK) {
        const note = track.notes[cursors[index]];
        if (note.t >= limit) {
          cursors[index] = track.notes.length;
          break;
        }
        const when = jingle.startedAt + note.t;
        if (when > horizon) return;
        // Trimmed short if it would ring past the cut, and quieter the further
        // into the fade it starts.
        const room = limit - note.t;
        const fade = note.t <= fadeFrom ? 1 : Math.max(0, 1 - (note.t - fadeFrom) / (limit - fadeFrom));
        const clipped = note.d > room || fade < 1 ? { ...note, d: Math.min(note.d, room), v: note.v * fade } : note;
        this.playNote(track, clipped, Math.max(when, this.context.currentTime), this.musicGain, song.volume);
        cursors[index]++;
        started++;
      }
    });

    if (this.context.currentTime <= end + 0.2) return;

    this.stopJingle();
    // Whatever the game asked for while the cue held the speaker — or was
    // playing before it started — comes back now.
    if (this.wanted) void this.playMusic(this.wanted);
  }

  /** Stop the note scheduler, leaving `wanted` — and any cue — alone. */
  haltMusic() {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
    this.current = null;
  }

  /** Stop a cue that is playing, without resuming anything. */
  stopJingle() {
    if (this.jingleTimer !== undefined) window.clearInterval(this.jingleTimer);
    this.jingleTimer = undefined;
    this.jingle = null;
  }

  /** Silence for good: no track playing, and none waiting to come back. */
  stopMusic() {
    this.wanted = null;
    this.haltMusic();
    this.stopJingle();
  }

  /**
   * Queue every note that starts within the look-ahead window.
   *
   * A song plays through once, intro and all, and then goes round from its
   * loop's start to its end for as long as it is wanted: the intro is heard
   * once, as on the cartridge, and the loop comes round on its bar line.
   */
  schedule() {
    if (!this.context || !this.current || !this.musicGain) return;
    const { song, cursors } = this.current;
    const horizon = this.context.currentTime + LOOKAHEAD_S;
    const { start, length } = loopOf(song);
    let started = 0;

    // A song shorter than the look-ahead would otherwise schedule the same loop
    // repeatedly; advancing the origin as soon as the cursor runs out keeps one
    // iteration in flight at a time.
    for (let pass = 0; pass < 4; pass++) {
      const loops = this.current.loops;
      // Where this time round's second 0 falls: after the first time through,
      // each time round starts at the loop's start, a loop's length on.
      const origin = loops === 0 ? this.current.startedAt : this.current.startedAt + song.duration + (loops - 1) * length - start;
      let exhausted = true;

      song.tracks.forEach((track, index) => {
        while (cursors[index] < track.notes.length && started < MAX_NOTES_PER_TICK) {
          const note = track.notes[cursors[index]];
          if (note.t >= song.duration) {
            cursors[index] = track.notes.length;
            break;
          }
          const when = origin + note.t;
          if (when > horizon) {
            exhausted = false;
            return;
          }
          this.playNote(track, note, Math.max(when, this.context.currentTime), null, song.volume);
          cursors[index]++;
          started++;
        }
        if (cursors[index] < track.notes.length) exhausted = false;
      });

      if (started >= MAX_NOTES_PER_TICK) return;
      if (!exhausted) return;

      this.current.loops++;
      song.tracks.forEach((track, index) => {
        cursors[index] = firstFrom(track.notes, start);
      });
    }
  }

  /**
   * @param {import('./synth.mjs').Track} track the song's track, which says what it is played on
   * @param {import('./synth.mjs').Note} note
   * @param {number} when
   * @param {GainNode|null} [output] the channel to voice it on; the music by
   *   default, which is also where the cues go — a fanfare is music, and the
   *   music slider is what a player reaches for to quieten one
   * @param {number} [level] the song's own volume
   */
  playNote(track, note, when, output = null, level = 1) {
    if (!this.context || !this.musicGain) return;
    playVoice(this.context, track, note, when, output ?? this.musicGain, level);
  }

  /**
   * A Pokémon's cry. Missing cries are simply silent rather than fatal.
   *
   * Cries ride their own gain node so the sound tab can turn them down — or
   * off — without touching the effects they share a speaker with. Each is
   * brought to the same loudness: they were recorded across nine generations,
   * and the newest came out a fifth as loud as the oldest.
   *
   * @param {number} speciesId
   */
  async playCry(speciesId) {
    await this.playSample(`cries/${speciesId}.ogg`, this.cryGain, CRY_LEVEL_DB);
  }

  /**
   * @param {string} path
   * @param {GainNode|null} [output] the channel to voice it on, effects by default
   * @param {number|null} [level] how loud to make it, in dB (see {@link levelOf}),
   *   or as it was recorded
   */
  async playSample(path, output = null, level = null) {
    this.start();
    if (!this.context) return;
    const sink = output ?? this.effectGain;
    if (!sink) return;
    try {
      let pending = this.buffers.get(path);
      if (!pending) {
        pending = loadAudioBuffer(this.context, path);
        this.buffers.set(path, pending);
      }
      const source = this.context.createBufferSource();
      source.buffer = await pending;
      if (level === null) {
        source.connect(sink);
      } else {
        const trim = this.context.createGain();
        trim.gain.value = trimTo(source.buffer, level);
        source.connect(trim);
        trim.connect(sink);
      }
      source.start();
    } catch {
      // A missing sample should never interrupt the game.
    }
  }

  /**
   * Interface blips, synthesised so the game ships no sound-effect files.
   * @param {'select'|'confirm'|'cancel'|'error'|'hit'|'faint'|'catch'|'shiny'} kind
   */
  blip(kind) {
    this.start();
    if (!this.context || !this.effectGain) return;
    const spec = BLIPS[kind] ?? BLIPS.select;
    const now = this.context.currentTime;

    spec.steps.forEach((step, index) => {
      const oscillator = /** @type {AudioContext} */ (this.context).createOscillator();
      const gain = /** @type {AudioContext} */ (this.context).createGain();
      oscillator.type = spec.wave;
      oscillator.frequency.value = step.frequency;
      oscillator.connect(gain);
      gain.connect(/** @type {GainNode} */ (this.effectGain));

      const at = now + (step.at ?? index * spec.gap);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.linearRampToValueAtTime(0.35 * 10 ** ((spec.trim ?? 0) / 20) * (step.gain ?? 1), at + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + step.length);
      oscillator.start(at);
      oscillator.stop(at + step.length + 0.02);
      oscillator.onended = () => gain.disconnect();
    });
  }

  /** @param {string} name */
  loadSong(name) {
    let pending = this.songs.get(name);
    if (!pending) {
      pending = fetch(url('assets', `bgm/${name}.json`)).then((response) => {
        if (!response.ok) throw new Error(`No track ${name}`);
        return response.json();
      });
      this.songs.set(name, pending);
    }
    return pending;
  }
}

/**
 * A step may name its own start and loudness, for a sound that is not an even
 * run of notes. `trim` (dB) brings each to about the same loudness — measured
 * by `dev/tools/loudness.mjs` — so a confirm is not louder than a select.
 * @type {Record<string, {wave: OscillatorType, gap: number, trim?: number, steps: Array<{frequency: number, length: number, at?: number, gain?: number}>}>}
 */
const BLIPS = {
  select: { wave: 'square', gap: 0, trim: 1.7, steps: [{ frequency: 880, length: 0.05 }] },
  confirm: { wave: 'square', gap: 0.06, trim: -2.3, steps: [{ frequency: 660, length: 0.05 }, { frequency: 990, length: 0.09 }] },
  cancel: { wave: 'square', gap: 0.05, trim: -1.6, steps: [{ frequency: 520, length: 0.05 }, { frequency: 340, length: 0.08 }] },
  error: { wave: 'sawtooth', gap: 0.07, trim: 1.8, steps: [{ frequency: 220, length: 0.09 }, { frequency: 180, length: 0.12 }] },
  hit: { wave: 'square', gap: 0, steps: [{ frequency: 160, length: 0.1 }] },
  faint: { wave: 'triangle', gap: 0.08, trim: 2.4, steps: [{ frequency: 440, length: 0.1 }, { frequency: 220, length: 0.18 }] },
  catch: { wave: 'square', gap: 0.09, trim: -0.8, steps: [{ frequency: 660, length: 0.07 }, { frequency: 880, length: 0.07 }, { frequency: 1320, length: 0.16 }] },
  // Emerald's SE_SHINY (`sound/songs/midi/se_shiny.mid`) note for note: C7
  // and G7 twice, then C#7 and G#7 three times, dying away.
  shiny: {
    wave: 'triangle',
    gap: 0,
    trim: 2.9,
    steps: [
      [0, 96, 0.034, 1], [0.034, 103, 0.068, 1],
      [0.102, 96, 0.034, 0.819], [0.148, 103, 0.068, 0.819],
      [0.216, 97, 0.034, 0.63], [0.25, 104, 0.068, 0.63],
      [0.318, 97, 0.034, 0.378], [0.364, 104, 0.068, 0.378],
      [0.432, 97, 0.034, 0.252], [0.477, 104, 0.068, 0.252],
    ].map(([at, note, length, gain]) => ({ at, frequency: 440 * 2 ** ((note - 69) / 12), length, gain })),
  },
};

/**
 * How loud a cry is brought to, as {@link levelOf} measures it: about six dB
 * over the music at the default volumes, where it is heard over a battle
 * theme without jumping out of it.
 */
const CRY_LEVEL_DB = -18.5;
/** No sample is turned more than this far either way, so a quiet one's hiss stays a hiss. */
const MAX_TRIM_DB = 12;

/** Each buffer's measured level and peak, made once. */
const levels = new WeakMap();

/**
 * How loud a recording is: the mean power of its tenth-of-a-second blocks,
 * leaving out the silence around it (anything under -60 dB, or 10 dB under
 * the rest), in dB.
 *
 * @param {AudioBuffer} buffer
 */
export function levelOf(buffer) {
  return measure(buffer).level;
}

/** @param {AudioBuffer} buffer */
function measure(buffer) {
  const known = levels.get(buffer);
  if (known) return known;
  const block = Math.max(1, Math.round(buffer.sampleRate / 10));
  const powers = [];
  let peak = 0;
  for (let start = 0; start < buffer.length; start += block) {
    const end = Math.min(buffer.length, start + block);
    let sum = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = start; i < end; i++) {
        sum += data[i] * data[i];
        peak = Math.max(peak, Math.abs(data[i]));
      }
    }
    powers.push(sum / ((end - start) * buffer.numberOfChannels));
  }
  const db = (power) => 10 * Math.log10(power || 1e-12);
  let kept = powers.filter((power) => db(power) > -60);
  if (kept.length) {
    const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
    kept = kept.filter((power) => db(power) > db(mean) - 10);
  }
  const result = { level: kept.length ? db(kept.reduce((a, b) => a + b, 0) / kept.length) : -120, peak };
  levels.set(buffer, result);
  return result;
}

/**
 * The gain that brings a recording to a level, within {@link MAX_TRIM_DB} —
 * and never so far up that its loudest moment goes past full scale: a quiet
 * cry with one sharp crack in it stays a little under the rest instead.
 */
function trimTo(buffer, level) {
  const { level: measured, peak } = measure(buffer);
  if (measured <= -100) return 1;
  const gain = 10 ** (Math.max(-MAX_TRIM_DB, Math.min(MAX_TRIM_DB, level - measured)) / 20);
  return peak > 0 ? Math.min(gain, Math.max(1, 1 / peak)) : gain;
}

/** The samples asked for so far, loaded or loading, so each is fetched once. */
const sampleLoads = new Map();

/**
 * Fetch the recorded samples a song plays, before it starts. One that cannot
 * be had is left out, and the synth stands in for it.
 *
 * @param {{tracks: import('./synth.mjs').Track[]}} song
 */
export async function loadSamples(song) {
  await Promise.all(
    samplesOf(song).map((name) => {
      if (hasSample(name)) return null;
      let pending = sampleLoads.get(name);
      if (!pending) {
        pending = fetch(url('assets', `samples/${name}.json`))
          .then((response) => (response.ok ? response.json() : null))
          .then((file) => file && storeSample(name, file))
          .catch(() => null);
        sampleLoads.set(name, pending);
      }
      return pending;
    }),
  );
}

/**
 * Where a song's loop starts, and how long it is. A song that marks no loop
 * goes round whole.
 *
 * @param {{duration: number, loop?: number}} song
 */
export function loopOf(song) {
  const start = song.loop > 0 && song.loop < song.duration ? song.loop : 0;
  return { start, length: song.duration - start };
}

/** The first of a track's notes at or after a time (they are in order). */
function firstFrom(notes, time) {
  const index = notes.findIndex((note) => note.t >= time - 0.0005);
  return index < 0 ? notes.length : index;
}

/**
 * Below this the music has nothing a small speaker can play, and what it
 * cannot play it distorts on, so it is taken out before it gets there.
 */
const MUSIC_FLOOR_HZ = 35;

/**
 * How the music reaches the speakers: through a gentle high-pass at
 * {@link MUSIC_FLOOR_HZ}, a little room around it — the songs are built with
 * the driver's reverb on (`-R50`), and the square waves are hard without it
 * — and a soft compressor, so one song is about as loud as the next and a
 * loud bar does not jump out of a quiet one. The top is left as it is: the
 * cartridge's trumpets and cymbals are bright, and taking it down dulled them.
 *
 * @param {BaseAudioContext} context
 * @param {GainNode} music
 * @param {AudioNode} [destination]
 */
export function connectMusic(context, music, destination = context.destination) {
  const floor = context.createBiquadFilter();
  floor.type = 'highpass';
  floor.frequency.value = MUSIC_FLOOR_HZ;
  floor.Q.value = 0.7;
  const level = context.createDynamicsCompressor();
  // Slow enough to let a drum's hit through and to come back up between
  // beats without pumping in time with them.
  level.threshold.value = -18;
  level.knee.value = 12;
  level.ratio.value = 2;
  level.attack.value = 0.03;
  level.release.value = 0.4;
  music.connect(floor);
  floor.connect(level);
  level.connect(destination);

  const room = context.createConvolver();
  room.buffer = roomOf(context);
  const wet = context.createGain();
  // Enough to take the edge off; more and the quick notes run into each other.
  wet.gain.value = 0.12;
  floor.connect(room);
  room.connect(wet);
  wet.connect(level);
}

/**
 * A small room's echo: a second of noise dying away, darker as it goes, a
 * little different in each ear.
 *
 * @param {BaseAudioContext} context
 */
function roomOf(context) {
  const length = Math.round(context.sampleRate * 1.1);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let dark = 0;
    for (let i = 0; i < length; i++) {
      const t = i / context.sampleRate;
      // Smoothed more the later it comes, which is the air taking the top off.
      const smoothing = Math.min(0.92, 0.3 + t * 0.7);
      dark = dark * smoothing + (Math.random() * 2 - 1) * (1 - smoothing);
      data[i] = dark * Math.exp(-t / 0.28) * (t < 0.012 ? t / 0.012 : 1);
    }
  }
  return buffer;
}
