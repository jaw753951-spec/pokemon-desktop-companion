/*
 * A short's sound, mixed offline in the game's page with the game's own audio
 * engine (`core/audio.mjs`): nothing composed for the film, only what the game
 * asked the speakers for while the take ran, played back where it asked.
 *
 * The engine is given an offline context wired the way `AudioEngine.start`
 * wires a live one, at the volumes the game ships with but for the music's,
 * which is turned up. A song is its
 * recording, as it is in the game once the recording has taken over from the
 * live notes; a cue silences the song under it and lets it back afterwards;
 * cries and blips go through the engine's own channels.
 *
 * Not part of the shipped app.
 */
window.__gameSound = async ({ audio, length }) => {
  const { AudioEngine, connectMusic, loadSamples, loopOf, openingRun, recordSong } = await import('./core/audio.mjs');
  const { loadAudioBuffer } = await import('./core/assets.mjs');

  const RATE = 48000;
  /**
   * Rendered this long before the film starts and cut off afterwards: the
   * engine eases its volumes in from full, which is not to be heard.
   */
  const LEAD = 0.5;
  /** As in the engine: a cue's fade past its intro, and how the song gives way to one. */
  const INTRO_FADE_S = 1.2;
  const DUCK_OUT_S = 0.015;
  const DUCK_IN_S = 0.1;
  const HANDOVER_S = 0.03;

  const context = new OfflineAudioContext(2, Math.ceil((length + LEAD) * RATE), RATE);
  const engine = new AudioEngine();
  engine.context = /** @type {any} */ (context);
  engine.masterGain = context.createGain();
  engine.musicGain = context.createGain();
  engine.songGain = context.createGain();
  engine.effectGain = context.createGain();
  engine.cryGain = context.createGain();
  engine.masterGain.connect(context.destination);
  connectMusic(context, engine.musicGain, engine.masterGain);
  engine.songGain.connect(engine.musicGain);
  engine.effectGain.connect(engine.masterGain);
  engine.cryGain.connect(engine.masterGain);
  engine.tapeGain = context.createGain();
  engine.tapeLevel = context.createGain();
  engine.tapeGain.connect(engine.tapeLevel);
  engine.tapeLevel.connect(engine.masterGain);
  // The game's own balance, but for the music slider, which is all the way
  // up: the game keeps its music under whatever else the desktop is for, and
  // a film is only listened to.
  engine.musicVolume = 1;
  engine.applyVolumes();

  const songs = new Map();
  /** A song and its recording, made once. */
  async function songOf(name) {
    if (!songs.has(name)) {
      songs.set(name, (async () => {
        const song = await engine.loadSong(name);
        await loadSamples(song);
        return { song, tape: await recordSong(song, RATE) };
      })().catch(() => null));
    }
    return songs.get(name);
  }

  /** What is to happen at a moment of the render, which is stopped there for it. */
  const moments = new Map();
  function at(time, action) {
    const when = Math.round(((time + LEAD) * RATE) / 128) * 128 / RATE;
    if (when <= 0) return;
    if (!moments.has(when)) moments.set(when, []);
    moments.get(when).push(action);
  }

  let playing = null;
  let cueEnds = -1;
  let cueName = null;

  function halt(time) {
    if (!playing) return;
    playing.level.gain.setTargetAtTime(0, time, HANDOVER_S);
    playing.source.stop(time + HANDOVER_S * 8);
    playing = null;
  }

  const entries = [...audio].sort((a, b) => a.t - b.t);
  for (const entry of entries) {
    const time = entry.t + LEAD;

    if (entry.method === 'stopMusic' || (entry.method === 'playMusic' && !entry.args[0])) {
      halt(time);
    } else if (entry.method === 'playMusic') {
      const name = entry.args[0];
      if (playing?.name === name) continue;
      const loaded = await songOf(name);
      halt(time);
      if (!loaded?.tape) continue;
      const { song, tape } = loaded;
      const source = context.createBufferSource();
      source.buffer = tape;
      source.loop = true;
      source.loopStart = song.duration;
      source.loopEnd = song.duration + loopOf(song).length;
      const level = context.createGain();
      source.connect(level);
      level.connect(engine.tapeGain);
      // One asked for under a cue starts when the cue is over, from its beginning.
      source.start(Math.max(time + 0.1, cueEnds));
      playing = { name, source, level };
    } else if (entry.method === 'playJingle') {
      const [name, options = {}] = entry.args;
      if (!name || (cueName === name && time < cueEnds)) continue;
      let song;
      try {
        song = await engine.loadSong(name);
        await loadSamples(song);
      } catch {
        continue;
      }
      if (options.notes) song = openingRun(song, options.notes);
      const intro = options.intro && song.loop > 0 ? song.loop : null;
      const wanted = intro !== null ? intro + INTRO_FADE_S : options.seconds ?? song.duration;
      const limit = Math.max(0.05, Math.min(song.duration, wanted));
      const fadeFrom = Math.min(intro ?? limit, limit);
      const startedAt = time + 0.05;
      engine.tapeGain.gain.setTargetAtTime(0, time, DUCK_OUT_S);
      for (const track of song.tracks) {
        for (const note of track.notes) {
          if (note.t >= limit) break;
          const room = limit - note.t;
          const fade = note.t <= fadeFrom ? 1 : Math.max(0, 1 - (note.t - fadeFrom) / (limit - fadeFrom));
          const clipped = note.d > room || fade < 1 ? { ...note, d: Math.min(note.d, room), v: note.v * fade } : note;
          engine.playNote(track, clipped, startedAt + note.t, engine.musicGain, song.volume);
        }
      }
      // The engine notices the cue is over on its next look, a moment after it ends.
      cueName = name;
      cueEnds = startedAt + limit + 0.3;
      engine.tapeGain.gain.setTargetAtTime(1, cueEnds, DUCK_IN_S);
    } else if (entry.method === 'playCry') {
      const path = `cries/${entry.args[0]}.ogg`;
      if (!engine.buffers.has(path)) engine.buffers.set(path, loadAudioBuffer(/** @type {any} */ (context), path));
      await engine.buffers.get(path).catch(() => null);
      at(entry.t, () => engine.playCry(entry.args[0]));
    } else if (entry.method === 'blip') {
      at(entry.t, () => engine.blip(entry.args[0]));
    }
  }

  // A cry and a blip are voiced at the context's present, so the render stops
  // at each moment one was asked for.
  for (const [when, actions] of moments) {
    context.suspend(when).then(async () => {
      for (const action of actions) await action();
      context.resume();
    });
  }

  const rendered = await context.startRendering();

  // Without the lead-in, brought up to just under full scale, as 16-bit WAV.
  const skip = Math.round(LEAD * RATE);
  const channels = [rendered.getChannelData(0).subarray(skip), rendered.getChannelData(1).subarray(skip)];
  let peak = 0;
  for (const channel of channels) for (const value of channel) peak = Math.max(peak, Math.abs(value));
  const gain = peak > 0 ? 0.89 / peak : 1;
  const frames = channels[0].length;
  const bytes = new Uint8Array(44 + frames * 4);
  const view = new DataView(bytes.buffer);
  const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + frames * 4, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < 2; c++) {
      const value = Math.max(-1, Math.min(1, channels[c][i] * gain));
      view.setInt16(44 + (i * 2 + c) * 2, Math.round(value * 32767), true);
    }
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
