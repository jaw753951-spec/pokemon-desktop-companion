/**
 * Sound: a small synthesiser for the soundtrack, plus sampled cries.
 *
 * The pipeline reduces each MIDI track to note events rather than rendering
 * audio, so music is a few kilobytes per song and is voiced here with
 * oscillators — which suits the GBA-era material it came from. Notes are
 * scheduled on a look-ahead timer so playback stays steady even when the game
 * loop stutters.
 */
import { loadAudioBuffer } from './assets.mjs';
import { url } from './bridge.mjs';

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
    /** @type {AudioBuffer|null} */
    this.noise = null;

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
    this.noise = createNoiseBuffer(this.context);
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
        this.playNote(track.program, clipped, Math.max(when, this.context.currentTime), this.musicGain);
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

  /** Queue every note that starts within the look-ahead window. */
  schedule() {
    if (!this.context || !this.current || !this.musicGain) return;
    const { song, cursors } = this.current;
    const horizon = this.context.currentTime + LOOKAHEAD_S;
    let started = 0;

    // A song shorter than the look-ahead would otherwise schedule the same loop
    // repeatedly; advancing the origin as soon as the cursor runs out keeps one
    // iteration in flight at a time.
    for (let pass = 0; pass < 4; pass++) {
      const origin = this.current.startedAt + this.current.loops * song.duration;
      let exhausted = true;

      song.tracks.forEach((track, index) => {
        while (cursors[index] < track.notes.length && started < MAX_NOTES_PER_TICK) {
          const note = track.notes[cursors[index]];
          const when = origin + note.t;
          if (when > horizon) {
            exhausted = false;
            return;
          }
          this.playNote(track.program, note, Math.max(when, this.context.currentTime));
          cursors[index]++;
          started++;
        }
        if (cursors[index] < track.notes.length) exhausted = false;
      });

      if (started >= MAX_NOTES_PER_TICK) return;
      if (!exhausted) return;

      this.current.loops++;
      cursors.fill(0);
    }
  }

  /**
   * @param {number} program General MIDI program, 128 for percussion
   * @param {{t: number, d: number, n: number, v: number}} note
   * @param {number} when
   * @param {GainNode|null} [output] the channel to voice it on; the music by
   *   default, which is also where the cues go — a fanfare is music, and the
   *   music slider is what a player reaches for to quieten one
   */
  playNote(program, note, when, output = null) {
    if (!this.context || !this.musicGain) return;
    const sink = output ?? this.musicGain;
    const voice = voiceFor(program, note.n);
    // A drum or a timpani is struck: it rings as long as it rings, however
    // long the file holds the key down.
    const duration = Math.min(note.d, voice.hold ?? 4);
    const gain = this.context.createGain();
    gain.connect(sink);

    /** @type {AudioScheduledSourceNode} */
    let source;
    if (voice.wave === 'noise') {
      const buffer = this.context.createBufferSource();
      buffer.buffer = this.noise;
      buffer.loop = true;
      const filter = this.context.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = voice.band ?? midiToFrequency(note.n);
      filter.Q.value = voice.q ?? 1.2;
      buffer.connect(filter);
      filter.connect(gain);
      source = buffer;
    } else {
      const oscillator = this.context.createOscillator();
      oscillator.type = /** @type {OscillatorType} */ (voice.wave);
      oscillator.frequency.value = midiToFrequency(note.n + voice.transpose);
      oscillator.connect(gain);
      source = oscillator;
    }

    const peak = note.v * voice.gain;
    const attack = voice.attack;
    const release = voice.hold ? voice.release : Math.min(voice.release, duration);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.linearRampToValueAtTime(peak, when + attack);
    gain.gain.setTargetAtTime(peak * voice.sustain, when + attack, Math.max(0.02, duration / 3));
    gain.gain.setTargetAtTime(0.0001, when + duration, release / 3);

    // Stopped once the release has died away, not part way down it: at one
    // release the envelope is still at a twentieth, and cutting a low note off
    // there is a click.
    source.start(when);
    source.stop(when + duration + release * 2);
    source.onended = () => gain.disconnect();
  }

  /**
   * A Pokémon's cry. Missing cries are simply silent rather than fatal.
   *
   * Cries ride their own gain node so the sound tab can turn them down — or
   * off — without touching the effects they share a speaker with.
   *
   * @param {number} speciesId
   */
  async playCry(speciesId) {
    await this.playSample(`cries/${speciesId}.ogg`, this.cryGain);
  }

  /**
   * @param {string} path
   * @param {GainNode|null} [output] the channel to voice it on, effects by default
   */
  async playSample(path, output = null) {
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
      source.connect(sink);
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
      gain.gain.linearRampToValueAtTime(0.35 * (step.gain ?? 1), at + 0.005);
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
 * run of notes.
 * @type {Record<string, {wave: OscillatorType, gap: number, steps: Array<{frequency: number, length: number, at?: number, gain?: number}>}>}
 */
const BLIPS = {
  select: { wave: 'square', gap: 0, steps: [{ frequency: 880, length: 0.05 }] },
  confirm: { wave: 'square', gap: 0.06, steps: [{ frequency: 660, length: 0.05 }, { frequency: 990, length: 0.09 }] },
  cancel: { wave: 'square', gap: 0.05, steps: [{ frequency: 520, length: 0.05 }, { frequency: 340, length: 0.08 }] },
  error: { wave: 'sawtooth', gap: 0.07, steps: [{ frequency: 220, length: 0.09 }, { frequency: 180, length: 0.12 }] },
  hit: { wave: 'square', gap: 0, steps: [{ frequency: 160, length: 0.1 }] },
  faint: { wave: 'triangle', gap: 0.08, steps: [{ frequency: 440, length: 0.1 }, { frequency: 220, length: 0.18 }] },
  catch: { wave: 'square', gap: 0.09, steps: [{ frequency: 660, length: 0.07 }, { frequency: 880, length: 0.07 }, { frequency: 1320, length: 0.16 }] },
  // Emerald's SE_SHINY (`sound/songs/midi/se_shiny.mid`) note for note: C7
  // and G7 twice, then C#7 and G#7 three times, dying away.
  shiny: {
    wave: 'triangle',
    gap: 0,
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
 * Map a General MIDI program onto one of the four voices the synth has.
 *
 * Two of the decomp's programs are not what General MIDI calls them, because
 * its MIDI numbers each song's own voicegroup rather than the GM bank. Program
 * 0 is the drum kit, as the drum channel is — every program-0 track repeats a
 * handful of drum notes — and was voiced as a pitched tone, so a snare came out
 * as a low D under the tune. And 47 is the timpani, which was a held string.
 *
 * @param {number} program
 * @param {number} note the key, which picks the drum of a kit
 * @returns {{wave: string, gain: number, transpose: number, attack: number, sustain: number, release: number,
 *   hold?: number, band?: number, q?: number}} `hold` caps a struck note's length, and `band` and `q` place a
 *   drum's noise
 */
export function voiceFor(program, note = 60) {
  if (program >= 128 || program === 0) return { wave: 'noise', gain: 0.55, transpose: 0, attack: 0.002, sustain: 0.15, hold: 0.04, ...drumOf(note) };
  if (program === 47) return { wave: 'triangle', gain: 0.6, transpose: 0, attack: 0.003, sustain: 0.1, release: 0.35, hold: 0.1 };
  if (program < 8) return { wave: 'triangle', gain: 0.5, transpose: 0, attack: 0.004, sustain: 0.55, release: 0.12 };
  if (program < 32) return { wave: 'square', gain: 0.32, transpose: 0, attack: 0.006, sustain: 0.6, release: 0.1 };
  // At the pitch it is written at: the tracks already put their bass low, and
  // an octave under that went down to 20 Hz, which a laptop speaker cannot
  // play and breaks up trying to.
  if (program < 40) return { wave: 'sawtooth', gain: 0.42, transpose: 0, attack: 0.006, sustain: 0.7, release: 0.1 };
  if (program < 56) return { wave: 'sawtooth', gain: 0.26, transpose: 0, attack: 0.03, sustain: 0.8, release: 0.18 };
  if (program < 80) return { wave: 'square', gain: 0.3, transpose: 0, attack: 0.012, sustain: 0.75, release: 0.12 };
  if (program < 112) return { wave: 'sawtooth', gain: 0.24, transpose: 0, attack: 0.02, sustain: 0.7, release: 0.16 };
  return { wave: 'noise', gain: 0.4, transpose: 0, attack: 0.002, sustain: 0.3, release: 0.1 };
}

/**
 * Where a drum of the kit sits, as a band of noise, and how long it rings.
 *
 * The kit's keys follow General MIDI's drum map, as the cartridge's own kit
 * does: the bass drum at the bottom, the snares, the hi-hats and toms, and the
 * cymbals above.
 *
 * @param {number} note
 */
function drumOf(note) {
  if (note <= 36) return { band: 110, q: 1.4, release: 0.08 };
  if (note <= 40) return { band: 1900, q: 0.7, release: 0.12 };
  if (note === 42 || note === 44) return { band: 8000, q: 0.9, release: 0.04 };
  if (note === 46) return { band: 7500, q: 0.9, release: 0.2 };
  if (note === 49 || note === 52 || note === 55 || note === 57) return { band: 6000, q: 0.5, release: 0.7 };
  if (note === 51 || note === 53 || note === 59) return { band: 5000, q: 1, release: 0.35 };
  if (note <= 50) return { band: 160 + (note - 41) * 45, q: 1.2, release: 0.14 };
  return { band: midiToFrequency(Math.min(note + 12, 120)), q: 1.2, release: 0.1 };
}

const midiToFrequency = (note) => 440 * 2 ** ((note - 69) / 12);

/**
 * Below this the music has nothing a small speaker can play, and what it
 * cannot play it distorts on, so it is taken out before it gets there.
 */
const MUSIC_FLOOR_HZ = 35;

/**
 * Send the music channel to the speakers through a gentle high-pass at
 * {@link MUSIC_FLOOR_HZ}.
 *
 * @param {BaseAudioContext} context
 * @param {GainNode} music
 */
export function connectMusic(context, music) {
  const floor = context.createBiquadFilter();
  floor.type = 'highpass';
  floor.frequency.value = MUSIC_FLOOR_HZ;
  floor.Q.value = 0.7;
  music.connect(floor);
  floor.connect(context.destination);
}

/** @param {AudioContext} context */
function createNoiseBuffer(context) {
  const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}
