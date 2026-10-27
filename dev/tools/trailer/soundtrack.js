/*
 * The trailer's soundtrack, mixed offline in the game's page with the game's
 * own synthesiser (`core/audio.mjs`), so the music is the music the game plays.
 *
 * One track carries the whole film — Emerald's champion battle, edited at bar
 * lines to fit the cuts — heard through the companion's little window first
 * (muffled, quieter) and opening up as the camera pushes in. The Hall of Fame
 * takes over for the ceremony, as it does in the game, and fades with the
 * logo. The cries and blips the shots asked for are laid over it where they
 * were asked for.
 *
 * Not part of the shipped app.
 */
window.__soundtrack = async ({ cuts, audio, length }) => {
  const { AudioEngine } = await import('./core/audio.mjs');
  const { loadAudioBuffer } = await import('./core/assets.mjs');
  const { url } = await import('./core/bridge.mjs');

  const RATE = 48000;
  const BAR = 1.1321;
  /** How far a note may sit off the bar line it belongs to, in seconds. */
  const SLACK = 0.002;
  const at = (name) => cuts.find((cut) => cut.name === name)?.at ?? 0;
  const song = async (name) => (await fetch(url('assets', `bgm/${name}.json`))).json();

  const context = new OfflineAudioContext(2, Math.ceil(length * RATE), RATE);
  const engine = new AudioEngine();
  engine.context = /** @type {any} */ (context);
  engine.musicGain = context.createGain();
  engine.effectGain = context.createGain();
  engine.cryGain = context.createGain();
  const noise = context.createBuffer(1, RATE, RATE);
  const samples = noise.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  engine.noise = noise;

  const master = context.createGain();
  const squeeze = context.createDynamicsCompressor();
  squeeze.threshold.value = -14;
  squeeze.ratio.value = 4;
  squeeze.attack.value = 0.004;
  squeeze.release.value = 0.2;
  master.connect(squeeze);
  squeeze.connect(context.destination);

  // The music, through the window and then out of it.
  const muffle = context.createBiquadFilter();
  muffle.type = 'lowpass';
  muffle.Q.value = 0.9;
  const floor = context.createBiquadFilter();
  floor.type = 'highpass';
  floor.frequency.value = 35;
  engine.musicGain.connect(muffle);
  muffle.connect(floor);
  floor.connect(master);
  const zoom = at('zoom');
  const open = at('walk');
  muffle.frequency.setValueAtTime(520, 0);
  muffle.frequency.setValueAtTime(520, zoom);
  muffle.frequency.exponentialRampToValueAtTime(18000, open);
  engine.musicGain.gain.setValueAtTime(0.2, 0);
  engine.musicGain.gain.setValueAtTime(0.2, zoom);
  engine.musicGain.gain.linearRampToValueAtTime(0.42, open);

  // Under the music rather than over it: this is a trailer, not the game.
  engine.effectGain.gain.value = 0.3;
  engine.cryGain.gain.value = 0.26;
  engine.effectGain.connect(master);
  engine.cryGain.connect(master);

  /**
   * Lay a stretch of a song on the film: song seconds `from` to `to`, starting
   * at film second `start`, through a gain of its own for the fades.
   */
  function lay(track, { from, to, start, fadeIn = 0, fadeOut = 0, level = 1 }) {
    const bus = context.createGain();
    bus.connect(engine.musicGain);
    const end = start + (to - from);
    bus.gain.setValueAtTime(fadeIn ? 0.0001 : level, start);
    if (fadeIn) bus.gain.linearRampToValueAtTime(level, start + fadeIn);
    if (fadeOut) {
      bus.gain.setValueAtTime(level, end - fadeOut);
      bus.gain.linearRampToValueAtTime(0.0001, end);
    }
    for (const part of track.tracks) {
      for (const note of part.notes) {
        // Note times are kept to the millisecond, so a note on a bar line can
        // sit a hair before the line worked out from the bar's length: it is
        // that bar's downbeat, and leaving it out left a gap at every edit.
        if (note.t < from - SLACK || note.t >= to - SLACK) continue;
        const room = to - note.t;
        engine.playNote(part.program, { ...note, d: Math.min(note.d, room + 0.04) }, Math.max(start, start + (note.t - from)), bus);
      }
    }
  }

  const champion = await song('mus_vs_champion');
  const fame = await song('mus_hall_of_fame');

  // Bars 4 to 28 under the desktop, the road, the berries and the fights,
  // through the bare bars that close the first section; then on from the
  // climax at 36, as the section after them, for the leaders — a cut between
  // two openings of a section, which the song itself could make. Under the
  // League's shutter it moves on again to 46, into the run up to the drop at
  // 50, so the last blow lands where the music falls away.
  const leaders = at('leader-1');
  const league = at('league');
  const ceremony = at('hall-of-fame');
  lay(champion, { from: 4 * BAR, to: 4 * BAR + leaders, start: 0, fadeOut: 0.03 });
  lay(champion, { from: 36 * BAR, to: 36 * BAR + (league - leaders), start: leaders, fadeIn: 0.02, fadeOut: 0.12 });
  lay(champion, { from: 46 * BAR, to: 46 * BAR + (ceremony - league), start: league, fadeIn: 0.05, fadeOut: 0.25 });
  lay(fame, { from: 0, to: Math.min(fame.duration, length - ceremony), start: ceremony, fadeOut: 1.4, level: 1.1 });

  // What the shots asked the speakers for.
  const cries = new Map();
  for (const entry of audio) {
    if (entry.method !== 'playCry') continue;
    const id = entry.args[0];
    if (!cries.has(id)) cries.set(id, await loadAudioBuffer(/** @type {any} */ (context), `cries/${id}.ogg`).catch(() => null));
  }
  const blips = new Map();
  for (const entry of audio) {
    if (entry.method === 'playCry') {
      const buffer = cries.get(entry.args[0]);
      if (!buffer) continue;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(engine.cryGain);
      source.start(entry.t);
    } else if (entry.method === 'blip') {
      // A blip is voiced at the context's present, so the render stops there.
      const when = Math.round((entry.t * RATE) / 128) * 128 / RATE;
      if (when <= 0) continue;
      if (!blips.has(when)) blips.set(when, []);
      blips.get(when).push(entry.args[0]);
    }
  }
  for (const [when, kinds] of blips) {
    context.suspend(when).then(() => {
      for (const kind of kinds) engine.blip(kind);
      context.resume();
    });
  }

  const rendered = await context.startRendering();

  // Brought up to just under full scale, and written out as 16-bit WAV.
  const channels = [rendered.getChannelData(0), rendered.getChannelData(1)];
  let peak = 0;
  for (const channel of channels) for (const value of channel) peak = Math.max(peak, Math.abs(value));
  const gain = peak > 0 ? 0.89 / peak : 1;
  const frames = rendered.length;
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
