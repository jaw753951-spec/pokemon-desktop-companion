/**
 * Sound: a small synthesiser for the soundtrack, plus sampled cries.
 *
 * The pipeline reduces each MIDI track to note events rather than rendering
 * audio, so music is a few kilobytes per song and is voiced here with
 * oscillators (`synth.mjs`) — which suits the GBA-era material it came from.
 * Notes are scheduled on a look-ahead timer so playback stays steady even
 * when the game loop stutters.
 *
 * Voicing every note as it comes is what most of the game's running cost was,
 * though: a node or four built and wired for each of thirty-odd notes a
 * second, every second the music plays. So a song is also recorded, once, the
 * first time it is asked for — by the same synthesiser, off the clock and on
 * a thread of its own (`recordSong`) — and the recording takes over from the
 * live notes as soon as it is done (`handOver`). Playing a recording back
 * costs next to nothing. The cues stay live: they are short, and rare.
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

/** The key a part has to reach for an opening run to count it as more than bass (C3). */
const BASS_BELOW = 48;

/** How long the last note of an opening run rings: the "rong", held, but not into a melody. */
const RUN_LAST_S = 0.6;

/**
 * How fast the music goes quiet under a cue, and comes back after it, as Web
 * Audio time constants: out at once, back over about a third of a second, so
 * it picks up again mid-phrase without jumping in.
 */
const DUCK_OUT_S = 0.015;
const DUCK_IN_S = 0.1;

/** How far down the music channel sits under the music slider: under whatever the player is doing. */
const MUSIC_MIX = 0.22;

/**
 * The rate a song is recorded at. The synthesiser's brightest parts — the
 * cartridge's trumpets and cymbals, the pulse channels' edges — reach past
 * twelve kHz, which a 24 kHz recording would lose; 32 kHz keeps up to
 * sixteen, which is all the music has, at two-thirds of the memory of 48.
 */
export const TAPE_RATE = 32000;

/**
 * How many songs' recordings are kept: the area's, and the two battle themes
 * a walk keeps coming back to, so a fight does not have the road's music
 * recorded all over again after it.
 */
const TAPES_KEPT = 3;

/**
 * The music slider a song is recorded at, and played back scaled from. The
 * compressor on the music works on how loud it is, so a recording made at one
 * level and turned up or down is only the same as the live music at that
 * level; this is the one the game starts at.
 */
const TAPE_MUSIC_VOLUME = 0.6;

/** How long the live notes and the recording cross over for when one takes over. */
const TAPE_HANDOVER_S = 0.03;

/** How far ahead of now the takeover is put, so it lands on a time not yet played. */
const TAPE_LEAD_S = 0.08;

/**
 * How much of a song is queued at a time while it is recorded. Queueing the
 * whole song at once left thousands of notes waiting in the graph from the
 * first moment, and the recording took ten times as long.
 */
const TAPE_STEP_S = 1;

export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.context = null;
    /** @type {GainNode|null} everything the game plays goes through this */
    this.masterGain = null;
    /** @type {GainNode|null} the music slider: the songs and the cues */
    this.musicGain = null;
    /**
     * @type {GainNode|null} the songs alone, under the music slider: what a
     *   cue silences while it plays, leaving the song running underneath
     */
    this.songGain = null;
    /** @type {GainNode|null} */
    this.effectGain = null;
    /** @type {GainNode|null} */
    this.cryGain = null;
    /**
     * @type {GainNode|null} where a recorded song plays: past the music's
     *   filter, compressor and room, which are in the recording already. It
     *   is silenced under a cue as `songGain` is.
     */
    this.tapeGain = null;
    /** @type {GainNode|null} the music slider, for the recordings */
    this.tapeLevel = null;
    /**
     * The songs recorded, or being recorded, most recently asked for last.
     * @type {Map<string, Promise<AudioBuffer|null>>}
     */
    this.tapes = new Map();

    /**
     * The song playing: where it is up to, live, and — once it has taken
     * over — its recording.
     *
     * `live` is the gain its live notes go through, which the recording
     * crosses over from; `queuedTo` is how far ahead they have been queued;
     * `recorded` is its recording once ready, and `tape` the recording once
     * it is the one playing.
     *
     * @type {{name: string, song: any, startedAt: number, cursors: number[], loops: number, live: GainNode|null, queuedTo: number, recorded: AudioBuffer|null, tape: {source: AudioBufferSourceNode, level: GainNode}|null}|null}
     */
    this.current = null;
    /** @type {number|undefined} */
    this.timer = undefined;
    /** @type {Map<string, Promise<any>>} */
    this.songs = new Map();
    /** @type {Map<string, Promise<AudioBuffer>>} */
    this.buffers = new Map();

    this.masterVolume = 1;
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
     * to be running: a track asked for while a cue plays waits for the cue to
     * end, and this is what starts then. It is also set the moment `playMusic`
     * is called rather than after the song has loaded, so a cue started in the
     * same frame as a track change resumes the new track and not the old one.
     * @type {string|null}
     */
    this.wanted = null;
  }

  /** Create the audio graph. Safe to call more than once. */
  start() {
    if (this.context) return;
    this.context = new AudioContext();
    this.masterGain = this.context.createGain();
    this.musicGain = this.context.createGain();
    this.songGain = this.context.createGain();
    this.effectGain = this.context.createGain();
    this.cryGain = this.context.createGain();
    this.masterGain.connect(this.context.destination);
    connectMusic(this.context, this.musicGain, this.masterGain);
    this.songGain.connect(this.musicGain);
    this.effectGain.connect(this.masterGain);
    this.cryGain.connect(this.masterGain);
    this.tapeGain = this.context.createGain();
    this.tapeLevel = this.context.createGain();
    this.tapeGain.connect(this.tapeLevel);
    this.tapeLevel.connect(this.masterGain);
    this.applyVolumes();
  }

  /**
   * @param {{masterVolume?: number, musicVolume?: number, effectVolume?: number, cryVolume?: number}} volumes
   */
  setVolumes({ masterVolume, musicVolume, effectVolume, cryVolume }) {
    if (typeof masterVolume === 'number') this.masterVolume = masterVolume;
    if (typeof musicVolume === 'number') this.musicVolume = musicVolume;
    if (typeof effectVolume === 'number') this.effectVolume = effectVolume;
    if (typeof cryVolume === 'number') this.cryVolume = cryVolume;
    this.applyVolumes();
  }

  applyVolumes() {
    if (!this.context || !this.masterGain || !this.musicGain || !this.effectGain || !this.cryGain) return;
    const now = this.context.currentTime;
    // The sound tab's overall slider, over the three below it.
    this.masterGain.gain.setTargetAtTime(this.masterVolume, now, 0.05);
    // Music is mixed low: it plays under whatever the user is actually doing.
    this.musicGain.gain.setTargetAtTime(this.musicVolume * MUSIC_MIX, now, 0.05);
    this.tapeLevel?.gain.setTargetAtTime(this.musicVolume / TAPE_MUSIC_VOLUME, now, 0.05);
    this.effectGain.gain.setTargetAtTime(this.effectVolume * 0.5, now, 0.05);
    this.cryGain.gain.setTargetAtTime(this.cryVolume * 0.6, now, 0.05);

    // With every slider at nought nothing can be heard, but the songs went on
    // being played and mixed into silence all the same, which kept the audio
    // thread as busy as the rest of the game put together. It is let go
    // instead, and picks up where it was when a slider comes up again.
    const silent = this.silent;
    if (silent && this.context.state === 'running') this.context.suspend().catch(() => {});
    else if (!silent && this.context.state === 'suspended') this.context.resume().catch(() => {});
    // A song that was not recorded while nothing could be heard is now.
    if (!silent && this.current && !this.current.recorded && !this.current.tape) this.record(this.current);
  }

  /** Whether every slider is at nought, so nothing the game plays can be heard. */
  get silent() {
    return this.masterVolume <= 0 || (this.musicVolume <= 0 && this.effectVolume <= 0 && this.cryVolume <= 0);
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
    // Already playing — perhaps silenced under a cue, in which case it is
    // still going round and is heard again, where it has got to, once the
    // cue ends. Starting it over was what made a battle theme begin again
    // every time a level-up chime interrupted it.
    if (this.current?.name === name) return;
    // A different track waits for a cue to end rather than starting under it,
    // and so is heard from its beginning. The one it replaces stops now.
    if (this.jingle) {
      this.haltMusic();
      return;
    }

    let song;
    try {
      song = await this.loadSong(name);
      await loadSamples(song);
    } catch {
      return; // a missing track is silence, not a broken game
    }
    // Something asked for a different track, or a cue started, while this one
    // was loading — or a second call for this same track got there first.
    if (!this.context || this.wanted !== name || this.jingle || this.current?.name === name) return;

    this.haltMusic();
    // Its live notes go through a gain of their own, under the songs' channel,
    // so the recording can cross over from them alone.
    const live = this.context.createGain();
    if (this.songGain) live.connect(this.songGain);
    const startedAt = this.context.currentTime + 0.1;
    this.current = {
      name,
      song,
      startedAt,
      cursors: song.tracks.map(() => 0),
      loops: 0,
      live,
      queuedTo: startedAt,
      recorded: null,
      tape: null,
    };
    this.timer = window.setInterval(() => this.schedule(), TICK_MS);
    this.schedule();
    this.record(this.current);
  }

  /**
   * Have the song playing recorded — or find the recording made the last time
   * it played — for it to take over from the live notes.
   *
   * Nothing is recorded while nothing can be heard: it would be work for
   * nobody. Turning a slider up again records it then.
   *
   * @param {NonNullable<AudioEngine['current']>} playing
   */
  record(playing) {
    if (this.silent) return;
    let pending = this.tapes.get(playing.name);
    if (pending) {
      // Asked for again: it is the most recent now.
      this.tapes.delete(playing.name);
    } else {
      pending = recordSong(playing.song).catch(() => null);
    }
    this.tapes.set(playing.name, pending);
    // Only the last few are kept. One still playing keeps its own recording
    // for as long as it plays; this only lets go of the engine's hold on it.
    while (this.tapes.size > TAPES_KEPT) this.tapes.delete(/** @type {string} */ (this.tapes.keys().next().value));
    pending.then((buffer) => {
      // Only for the very playthrough that asked: a song stopped, or started
      // over, in the meantime has a playthrough of its own.
      if (buffer && this.current === playing) playing.recorded = buffer;
    });
  }

  /**
   * Let the song's recording take over from its live notes, on a moment that
   * has been queued live but not yet heard: from then on the live notes fade
   * out as the recording, played from the same place in the song, fades in.
   * Both are the same synthesiser playing the same notes, so nothing is heard
   * to change but the cost.
   */
  handOver() {
    const playing = this.current;
    if (!this.context || !playing?.recorded || playing.tape || !this.tapeGain || !playing.live) return;
    const at = this.context.currentTime + TAPE_LEAD_S;
    // Everything up to the takeover has to be queued live already, or the
    // notes between would be heard from neither.
    if (playing.queuedTo < at + TAPE_HANDOVER_S) return;
    const { song } = playing;
    const { length } = loopOf(song);

    const source = this.context.createBufferSource();
    source.buffer = playing.recorded;
    source.loop = true;
    source.loopStart = song.duration;
    source.loopEnd = song.duration + length;
    const level = this.context.createGain();
    level.gain.setValueAtTime(0, at);
    level.gain.linearRampToValueAtTime(1, at + TAPE_HANDOVER_S);
    source.connect(level);
    level.connect(this.tapeGain);
    source.start(at, tapeOffset(song, at - playing.startedAt));

    playing.live.gain.setValueAtTime(1, at);
    playing.live.gain.linearRampToValueAtTime(0, at + TAPE_HANDOVER_S);
    playing.tape = { source, level };
    // No more live notes: the recording has the rest of them.
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Play one of the short cue tracks — the fanfares, the heal chime — once.
   *
   * A cue is music, and rides the music channel: the sound tab's music slider
   * is what a player reaches for to turn a victory fanfare down, not the one
   * labelled for the interface blips.
   *
   * These are sound effects that happen to be stored as MIDI. Looping them
   * through `playMusic` made the heal chime repeat forever, and replaced the
   * area music with two seconds of silence afterwards.
   *
   * Playing one *over* the music was no better — a victory fanfare and the
   * battle theme in two keys at once — so the music is silenced for the cue.
   * Silenced, not stopped: it goes on underneath and is heard again where it
   * has got to, so an item found on the road or a level gained mid-battle
   * does not send the song back to its first bar. A different track asked for
   * meanwhile starts once the cue is over (see `playMusic`).
   *
   * Scheduling reuses the music machinery, but on a private `current` that
   * clears itself at the end of the song instead of looping.
   *
   * @param {string|null} name
   * @param {{seconds?: number, intro?: boolean, notes?: number}} [options] how
   *   much of the cue to play. A fanfare written for a cartridge runs as long
   *   as the cartridge wanted to hold the screen; here it holds the area music
   *   off for that whole time, so the long ones are cut short. `seconds` is a
   *   hard cut; `intro` plays a looping song up to where its loop begins and
   *   fades the loop out as it comes in, which is how the victory themes are
   *   heard on the cartridge — a two-second fanfare, then the battle screen
   *   closing over a body written to be looped for as long as it stays open.
   *   `notes` plays the song's first so many notes — counting a chord as one
   *   — and nothing after them: the quick run up a victory theme opens with
   *   (see `openingRun`).
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
    if (options.notes) song = openingRun(song, options.notes);

    // The music goes quiet for the cue, and keeps its place.
    this.duck(true);

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
    // The track that went quiet under the cue is heard again; one the game
    // asked for while the cue played — or that had not finished loading —
    // starts now.
    if (this.wanted) void this.playMusic(this.wanted);
  }

  /** Stop the note scheduler, leaving `wanted` — and any cue — alone. */
  haltMusic() {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
    // A recording playing stops too, faded rather than cut off mid-note.
    const tape = this.current?.tape;
    if (tape && this.context) {
      const now = this.context.currentTime;
      tape.level.gain.cancelScheduledValues?.(now);
      tape.level.gain.setTargetAtTime(0, now, TAPE_HANDOVER_S);
      tape.source.stop(now + TAPE_HANDOVER_S * 8);
      tape.source.onended = () => tape.level.disconnect();
    }
    this.current = null;
  }

  /** Stop a cue that is playing, and let the music be heard again. */
  stopJingle() {
    if (this.jingleTimer !== undefined) window.clearInterval(this.jingleTimer);
    this.jingleTimer = undefined;
    this.jingle = null;
    this.duck(false);
  }

  /**
   * Silence the songs for a cue, or bring them back, without stopping them.
   * @param {boolean} quiet
   */
  duck(quiet) {
    if (!this.context || !this.songGain) return;
    // Each call starts from wherever the last left the level, so a cue that
    // ends while the music is still going quiet brings it back smoothly.
    this.songGain.gain.setTargetAtTime(quiet ? 0 : 1, this.context.currentTime, quiet ? DUCK_OUT_S : DUCK_IN_S);
    this.tapeGain?.gain.setTargetAtTime(quiet ? 0 : 1, this.context.currentTime, quiet ? DUCK_OUT_S : DUCK_IN_S);
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
    if (this.current.tape) return;
    this.queue();
    this.handOver();
  }

  /** Queue the live notes due within the look-ahead, and note how far that reaches. */
  queue() {
    if (!this.context || !this.current) return;
    const playing = this.current;
    const { song, cursors } = playing;
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
          this.playNote(track, note, Math.max(when, this.context.currentTime), playing.live ?? this.songGain, song.volume);
          cursors[index]++;
          started++;
        }
        if (cursors[index] < track.notes.length) exhausted = false;
      });

      // Capped short of the horizon: queued only as far as the notes it got
      // to, so a takeover is never put past them.
      if (started >= MAX_NOTES_PER_TICK) return;
      if (!exhausted) {
        playing.queuedTo = horizon;
        return;
      }

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
   * @param {GainNode|null} [output] the channel to voice it on: the songs'
   *   own, which a cue silences, or the music channel over it, which is where
   *   the cues go — a fanfare is music, and the music slider is what a player
   *   reaches for to quieten one
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

/**
 * Where in a song's recording a moment of its playthrough is.
 *
 * A recording is the song once through, intro and all, and then its loop once
 * more — the second time round, which starts with the end of the first still
 * ringing into it, is the part that goes round. So a moment in the first
 * playthrough is that far in, and any later one is that far round the loop,
 * from where the loop's second time starts.
 *
 * @param {{duration: number, loop?: number}} song
 * @param {number} elapsed seconds since the playthrough began
 */
export function tapeOffset(song, elapsed) {
  if (elapsed < song.duration) return Math.max(0, elapsed);
  const { length } = loopOf(song);
  return song.duration + ((elapsed - song.duration) % length);
}

/**
 * Record a song the way it is played live: the same voices through the same
 * filter, compressor and room, at {@link TAPE_MUSIC_VOLUME} — once through and
 * its loop once more (see {@link tapeOffset}). On a thread of its own and many
 * times faster than it plays: a minute of music takes about half a second.
 *
 * @param {{duration: number, loop?: number, volume?: number, tracks: Array<import('./synth.mjs').Track & {notes: import('./synth.mjs').Note[]}>}} song
 * @param {number} [rate]
 * @returns {Promise<AudioBuffer|null>} null where there is no way to record
 */
export async function recordSong(song, rate = TAPE_RATE) {
  if (typeof OfflineAudioContext === 'undefined') return null;
  const { start, length } = loopOf(song);
  const seconds = song.duration + length;
  const context = new OfflineAudioContext(2, Math.ceil(seconds * rate), rate);
  const music = context.createGain();
  music.gain.value = TAPE_MUSIC_VOLUME * MUSIC_MIX;
  connectMusic(context, music, context.destination);

  /** @type {Array<{track: import('./synth.mjs').Track, note: import('./synth.mjs').Note, when: number}>} */
  const notes = [];
  for (const track of song.tracks) {
    for (const note of track.notes) {
      if (note.t >= song.duration) continue;
      notes.push({ track, note, when: note.t });
      if (note.t >= start) notes.push({ track, note, when: song.duration + (note.t - start) });
    }
  }
  notes.sort((a, b) => a.when - b.when);

  // Queued a little at a time as the recording reaches it, as when it plays.
  let next = 0;
  const queue = (until) => {
    while (next < notes.length && notes[next].when < until) {
      const { track, note, when } = notes[next++];
      playVoice(context, track, note, when, music, song.volume);
    }
  };
  queue(TAPE_STEP_S * 1.5);
  for (let at = TAPE_STEP_S; at < seconds - TAPE_STEP_S / 2; at += TAPE_STEP_S) {
    const step = at;
    context.suspend(step).then(() => {
      queue(step + TAPE_STEP_S * 1.5);
      return context.resume();
    });
  }
  return context.startRendering();
}

/**
 * A song's first so many notes, a chord counting as one, as a song of their
 * own: the "do-ro-ro-ro-rong" a victory theme opens with, and nothing after.
 *
 * It is a run, so it stays one: every note is held no longer than the run's
 * steps are apart, but the last, which rings for `RUN_LAST_S` — long enough
 * to land on, not so long it turns the flourish into the start of a melody. The bass that comes in under the last note is
 * left out too, for the same reason: a pitched part that plays nothing above
 * C3 there is the band arriving, not the run — and so are the drums.
 *
 * @template {{duration: number, loop?: number, tracks: Array<{kit?: object, notes: Array<{t: number, d: number, n: number}>}>}} Song
 * @param {Song} song
 * @param {number} count
 * @returns {Song}
 */
export function openingRun(song, count) {
  // To the millisecond, so a chord whose notes the file puts a hair apart
  // still counts once.
  const at = (time) => Math.round(time * 1000);
  const onsets = [...new Set(song.tracks.flatMap((track) => track.notes.map((note) => at(note.t))))].sort((a, b) => a - b);
  if (onsets.length <= count) return song;
  const cut = onsets[count];
  const run = onsets.slice(0, count);
  const step = run.length > 1 ? Math.max(...run.slice(1).map((onset, i) => onset - run[i])) / 1000 : Infinity;
  const last = run[run.length - 1];
  let duration = 0;
  const tracks = song.tracks.map((track) => {
    const notes = track.notes.filter((note) => at(note.t) < cut);
    if (track.kit || (notes.length && notes.every((note) => note.n < BASS_BELOW))) return { ...track, notes: [] };
    return {
      ...track,
      notes: notes.map((note) => {
        const d = Math.min(note.d, at(note.t) === last ? Math.max(step, RUN_LAST_S) : step);
        duration = Math.max(duration, note.t + d);
        return d === note.d ? note : { ...note, d };
      }),
    };
  });
  return { ...song, tracks, duration, loop: 0 };
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
