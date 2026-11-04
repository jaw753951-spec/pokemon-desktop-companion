#!/usr/bin/env electron
/**
 * Measure how loud the game's sounds are, as it plays them at its default
 * volumes, and level the music.
 *
 *   npx electron dev/tools/loudness.mjs [--write]
 *
 * Every song and cue is played through the game's own synth and music bus,
 * the interface blips through the effects channel and the cries through
 * theirs, and each is measured K-weighted and gated as integrated LUFS is.
 * The report lists them by loudness. With `--write`, each song's trim is set
 * so that it lands on the target (cues a little above the songs they stand
 * in for) and written to `build/bgm-levels.mjs`; `npm run assets -- --only
 * audio` then builds the songs with it. Run it again after changing the
 * synth or the songs, and it corrects the trims it finds there.
 */
import { app, BrowserWindow } from 'electron';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BGM_TRIM_DB } from './build/bgm-levels.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const WRITE = process.argv.includes('--write');

/** Where a song should land, and a cue — a fanfare is heard over nothing. */
const TARGET = { song: -26, cue: -25 };
/** No song is turned more than this far either way. */
const MAX_TRIM_DB = 10;

app.setPath('userData', await mkdtemp(join(tmpdir(), 'pdc-loudness-')));
const { registerHandlers, registerProtocolHandler, registerProtocolScheme } = await import('../../app/main/ipc.mjs');
const { RENDERER_DIR } = await import('../../app/main/paths.mjs');
registerProtocolScheme();

app.whenReady().then(async () => {
  registerProtocolHandler();
  registerHandlers();
  const window = new BrowserWindow({
    width: 480,
    height: 270,
    show: false,
    webPreferences: { preload: join(RENDERER_DIR, '..', 'preload', 'bridge.cjs'), contextIsolation: true, sandbox: false, backgroundThrottling: false },
  });
  await window.loadFile(join(RENDERER_DIR, 'index.html'));
  // Ended on the setup's promise: the script's own last value cannot be sent back.
  const page = await readFile(join(HERE, 'loudness-page.js'), 'utf8');
  const ready = await window.webContents.executeJavaScript(`${page};window.__loudnessReady`, true).catch((error) => {
    console.error('could not set up the page:', error);
    return false;
  });
  if (!ready) return app.exit(1);

  const songs = (await readdir(join(ROOT, 'assets', 'bgm'))).map((file) => file.replace('.json', ''));
  const cries = (await readdir(join(ROOT, 'assets', 'cries'))).map((file) => file.replace('.ogg', ''));
  const items = [
    ...songs.map((name) => ['song', name]),
    ...['select', 'confirm', 'cancel', 'error', 'hit', 'faint', 'catch', 'shiny'].map((name) => ['blip', name]),
    ...cries.map((name) => ['cry', name]),
  ];

  // One call a sound, each with a time limit, so one that hangs is reported
  // and passed over rather than holding up the rest.
  const rows = [];
  for (const [index, [kind, name]] of items.entries()) {
    const call = window.webContents.executeJavaScript(`window.__loudness.${kind}(${JSON.stringify(name)})`, true);
    const limit = new Promise((resolve) => setTimeout(() => resolve({ error: 'timed out' }), 30000));
    const row = await Promise.race([call, limit]).catch((error) => ({ error: String(error) }));
    rows.push({ kind: kind === 'song' ? row.kind ?? kind : kind, name, ...row });
    if (row.error) console.warn(`${kind} ${name}: ${row.error}`);
    if (index % 100 === 99) console.log(`${index + 1}/${items.length}`);
  }

  const plural = { song: 'songs', cue: 'cues', blip: 'blips', cry: 'cries' };
  for (const kind of ['song', 'cue', 'blip', 'cry']) {
    const list = rows.filter((row) => row.kind === kind && typeof row.lufs === 'number').sort((a, b) => a.lufs - b.lufs);
    if (!list.length) continue;
    const at = (share) => list[Math.min(list.length - 1, Math.floor(share * list.length))].lufs;
    const peak = Math.max(...list.map((row) => row.peak));
    console.log(`\n${plural[kind]}: ${list.length}, ${list[0].lufs} to ${list.at(-1).lufs} LUFS (median ${at(0.5)}, middle 80% ${at(0.1)} to ${at(0.9)}), loudest peak ${peak} dB`);
    if (kind !== 'cry') console.log('  ' + list.map((row) => `${row.name.replace(/^mus_/, '')} ${row.lufs}`).join(', '));
  }

  if (WRITE) {
    const trims = {};
    for (const row of rows) {
      if ((row.kind !== 'song' && row.kind !== 'cue') || typeof row.lufs !== 'number') continue;
      const trim = (BGM_TRIM_DB[row.name] ?? 0) + TARGET[row.kind] - row.lufs;
      trims[row.name] = Math.round(Math.max(-MAX_TRIM_DB, Math.min(MAX_TRIM_DB, trim)) * 10) / 10;
    }
    const lines = Object.keys(trims)
      .sort()
      .map((name) => `  ${name}: ${trims[name]},`);
    await writeFile(join(HERE, 'build', 'bgm-levels.mjs'), `${HEADER}export const BGM_TRIM_DB = {\n${lines.join('\n')}\n};\n`);
    console.log(`\nwrote build/bgm-levels.mjs: run \`npm run assets -- --only audio\` to build the songs with it`);
  }
  app.quit();
});

const HEADER = `/**
 * How far each song is turned up or down, in dB, so that one is about as loud
 * as the next, on top of the master volume the cartridge builds it with.
 *
 * Written by \`dev/tools/loudness.mjs --write\` from the songs as the game
 * plays them; not edited by hand.
 */
`;
