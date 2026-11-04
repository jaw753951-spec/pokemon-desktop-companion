/*
 * The page side of `loudness.mjs`, run inside the game's own page: sets up
 * `window.__loudness`, one function a kind of sound, each giving back its
 * loudness and peak as the game plays it at its default volumes.
 *
 * Not part of the shipped app.
 */
window.__loudnessReady = (async () => {
  // The game's data loads with the game.
  for (let i = 0; i < 400 && !window.__pdcApp?.scene; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  const { AudioEngine, connectMusic, loadSamples } = await import('./core/audio.mjs');
  const { playVoice } = await import('./core/synth.mjs');
  const { gameData } = await import('./core/data.mjs');
  const { url } = await import('./core/bridge.mjs');
  const RATE = 48000;
  // The default volumes (app/main/settings.mjs) through the engine's own scaling.
  const engine = new AudioEngine();
  const MUSIC = engine.musicVolume * 0.22;
  const EFFECT = engine.effectVolume * 0.5;

  /** K-weighted, in 100 ms blocks gated at -70 and at 10 below their mean. */
  async function loudness(buffer) {
    const context = new OfflineAudioContext(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    const source = context.createBufferSource();
    source.buffer = buffer;
    const shelf = context.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 1681;
    shelf.gain.value = 4;
    const high = context.createBiquadFilter();
    high.type = 'highpass';
    high.frequency.value = 38;
    high.Q.value = 0.5;
    source.connect(shelf);
    shelf.connect(high);
    high.connect(context.destination);
    source.start();
    const weighted = await context.startRendering();
    const block = Math.round(buffer.sampleRate * 0.1);
    const powers = [];
    for (let start = 0; start + block <= weighted.length; start += block) {
      let sum = 0;
      for (let c = 0; c < weighted.numberOfChannels; c++) {
        const data = weighted.getChannelData(c);
        for (let i = start; i < start + block; i++) sum += data[i] * data[i];
      }
      powers.push(sum / block);
    }
    const lufs = (power) => -0.691 + 10 * Math.log10(power);
    let kept = powers.filter((power) => lufs(power) > -70);
    if (!kept.length) return { lufs: null, peak: null };
    const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
    kept = kept.filter((power) => lufs(power) > lufs(mean) - 10);
    let peak = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) for (const x of buffer.getChannelData(c)) peak = Math.max(peak, Math.abs(x));
    const round = (x) => Math.round(x * 10) / 10;
    return { lufs: round(lufs(kept.reduce((a, b) => a + b, 0) / kept.length)), peak: round(20 * Math.log10(peak || 1e-9)) };
  }

  const cueOf = {};
  for (const [role, name] of Object.entries(gameData().bgm.cues)) cueOf[name] = role;
  // The cues the game plays once; the rest of the cue list loops like any song.
  const once = new Set(['victoryWild', 'victoryTrainer', 'victoryLeader', 'victoryLeague', 'heal', 'levelUp', 'evolved', 'caught', 'obtainItem', 'obtainBerry', 'obtainTm', 'obtainBadge']);
  const intro = new Set(['victoryWild', 'victoryTrainer', 'victoryLeader', 'victoryLeague']);

  window.__loudness = {
    async song(name) {
      const song = await (await fetch(url('assets', `bgm/${name}.json`))).json();
      await loadSamples(song);
      const role = cueOf[name];
      const cue = once.has(role);
      // A song's first minute; a cue as long as it is played for.
      const length = cue ? (intro.has(role) && song.loop ? song.loop + 1.2 : song.duration) : Math.min(60, song.duration);
      const context = new OfflineAudioContext(2, Math.ceil((length + 1) * RATE), RATE);
      const music = context.createGain();
      music.gain.value = MUSIC;
      connectMusic(context, music);
      for (const track of song.tracks) {
        for (const note of track.notes) {
          if (note.t < length && note.t < song.duration) playVoice(context, track, { ...note, d: Math.min(note.d, length - note.t) }, note.t + 0.02, music, song.volume);
        }
      }
      return { kind: cue ? 'cue' : 'song', ...(await loudness(await context.startRendering())) };
    },
    async blip(kind) {
      const context = new OfflineAudioContext(2, RATE, RATE);
      const blips = new AudioEngine();
      blips.context = /** @type {any} */ (context);
      blips.effectGain = context.createGain();
      blips.effectGain.gain.value = EFFECT;
      blips.effectGain.connect(context.destination);
      blips.start = () => {};
      blips.blip(kind);
      return loudness(await context.startRendering());
    },
    async cry(id) {
      const context = new OfflineAudioContext(2, RATE * 4, RATE);
      const cries = new AudioEngine();
      cries.context = /** @type {any} */ (context);
      cries.cryGain = context.createGain();
      cries.cryGain.gain.value = engine.cryVolume * 0.6;
      cries.cryGain.connect(context.destination);
      cries.start = () => {};
      await cries.playCry(Number(id));
      return loudness(await context.startRendering());
    },
  };
  return true;
})();
