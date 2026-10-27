#!/usr/bin/env electron
/**
 * Film the trailer: the real game, driven shot by shot, a frame at a time.
 *
 *   npx electron dev/tools/trailer/record.mjs --ffmpeg path/to/ffmpeg [--out trailer] [--lang en] [--only fight-1] [--stills 30]
 *     [--sound-only | --vertical-only]
 *
 * Boots the game's own main-process modules (as the screenshot harness does)
 * into a hidden 1920x1080 window, hands the page to `director.js`, and
 * pipes every frame it photographs straight into ffmpeg. The soundtrack is
 * mixed afterwards by `soundtrack.js` from what the shots asked the speakers
 * for, and the two are put together at the end — and cut again upright, for
 * the phone-shaped feeds. Nothing here ships.
 */
import { app, BrowserWindow, screen } from 'electron';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');

const userData = await mkdtemp(join(tmpdir(), 'pdc-trailer-'));
app.setPath('userData', userData);

const args = process.argv.slice(2);
const option = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};

const LANGUAGE = option('--lang', 'en');
const OUT_DIR = option('--out', join(ROOT, 'trailer'));
const FFMPEG = option('--ffmpeg', 'ffmpeg');
/** Film only the named shots (comma-separated), for working on one. */
const ONLY = option('--only', null)?.split(',') ?? null;
/** Mix the soundtrack again over the film already made, from its timeline. */
const SOUND_ONLY = args.includes('--sound-only');
/** Cut the upright version again from the finished film, and nothing else. */
const VERTICAL_ONLY = args.includes('--vertical-only');
/** Keep a still every so many frames, for looking at without playing the film. */
const STILLS = Number(option('--stills', '0'));
const WIDTH = 1920;
const HEIGHT = 1080;
/**
 * The page is laid out at half the film's size and drawn at twice the pixel
 * density: a window as big as the film is cut down to fit the screen on most
 * desktops, where this one always fits — and the text stays sharp.
 */
const DENSITY = 2;

await writeFile(join(userData, 'settings.json'), JSON.stringify({ language: LANGUAGE }));

app.commandLine.appendSwitch('force-device-scale-factor', String(DENSITY));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const { registerHandlers, registerProtocolHandler, registerProtocolScheme } = await import('../../../app/main/ipc.mjs');
const { RENDERER_DIR } = await import('../../../app/main/paths.mjs');
registerProtocolScheme();

app.whenReady().then(async () => {
  registerProtocolHandler();
  registerHandlers();
  await mkdir(join(OUT_DIR, 'stills'), { recursive: true });

  // A window is kept inside its display's work area, so a film-sized one on a
  // display with a taskbar comes out short. It is put, hidden, on a display
  // with room for it — an offscreen window is held to the primary display's
  // area whatever it is told, so it cannot be used.
  const size = { width: WIDTH / DENSITY, height: HEIGHT / DENSITY };
  const display = screen.getAllDisplays().find((entry) => entry.workArea.width >= size.width && entry.workArea.height >= size.height);
  if (!display) console.warn('no display has room for the whole film: the frames will be stretched to fit');
  const area = (display ?? screen.getPrimaryDisplay()).workArea;
  const window = new BrowserWindow({
    ...size,
    x: area.x,
    y: area.y,
    show: false,
    frame: false,
    skipTaskbar: true,
    useContentSize: true,
    webPreferences: {
      preload: join(RENDERER_DIR, '..', 'preload', 'bridge.cjs'),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  window.webContents.on('console-message', (event) => console.log(`[page] ${/** @type {any} */ (event).message}`));
  await window.loadFile(join(RENDERER_DIR, 'index.html'));
  const run = (code) => window.webContents.executeJavaScript(code, true);

  const video = join(OUT_DIR, ONLY ? `video-${ONLY.join('+')}.mp4` : 'video.mp4');
  if (!SOUND_ONLY && !VERTICAL_ONLY) await film(run, window, video);
  if (!ONLY && !VERTICAL_ONLY) await mix(run, video);
  if (!ONLY) await upright();
  app.quit();
});

app.on('window-all-closed', () => app.quit());

/**
 * Film every shot into `video`, and write down where the cuts fell and what
 * the shots asked the speakers for.
 */
async function film(run, window, video) {
  // Ended on a value that can be sent back: the script's own last value cannot.
  await run(`${await readFile(join(HERE, 'director.js'), 'utf8')};true`);
  const wallpaper = `data:image/jpeg;base64,${(await readFile(option('--wallpaper', 'C:/Windows/Web/Wallpaper/Windows/img0.jpg'))).toString('base64')}`;
  const icon = `data:image/png;base64,${(await readFile(join(ROOT, 'dev', 'build', 'icon.png'))).toString('base64')}`;
  const shots = await run(`window.__trailer.setup(${JSON.stringify({ wallpaper, icon })})`);
  console.log(shots.map((shot) => `${shot.name}:${shot.frames}`).join(' '));

  const encoder = spawn(FFMPEG, [
    '-y', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${WIDTH}x${HEIGHT}`, '-r', '60', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    video,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const finished = new Promise((resolve) => encoder.on('close', resolve));

  let filmed = 0;
  const started = Date.now();
  for (const [index, shot] of shots.entries()) {
    const wanted = !ONLY || ONLY.includes(shot.name);
    await run(`window.__trailer.begin(${index})`);
    for (let frame = 0; frame < shot.frames; frame++) {
      await run(`window.__trailer.frame(${index}, ${frame})`);
      if (!wanted) continue;
      await run('window.__trailer.painted()');
      let image = await window.webContents.capturePage();
      const size = image.getSize();
      if (size.width !== WIDTH || size.height !== HEIGHT) image = image.resize({ width: WIDTH, height: HEIGHT, quality: 'best' });
      if (!encoder.stdin.write(image.toBitmap())) await new Promise((resolve) => encoder.stdin.once('drain', resolve));
      if ((STILLS && frame % STILLS === 0) || frame === 0) {
        await writeFile(join(OUT_DIR, 'stills', `${shot.name}-${String(frame).padStart(4, '0')}.png`), image.toPNG());
      }
      filmed++;
      // A shot that fades in does so off the last frame of this one.
      if (frame === shot.frames - 1 && shots[index + 1]?.freeze) {
        const still = 'data:image/png;base64,' + image.toPNG().toString('base64');
        await run('window.__trailer.freeze(' + JSON.stringify(still) + ')');
      }
    }
    console.log(`filmed ${shot.name} (${filmed} frames, ${((Date.now() - started) / 1000).toFixed(0)}s)`);
  }
  encoder.stdin.end();
  await finished;

  const cuts = await run('window.__trailer.cuts()');
  const log = await run('window.__trailer.audioLog()');
  const length = shots.reduce((sum, shot) => sum + shot.frames, 0) / 60;
  await writeFile(join(OUT_DIR, 'timeline.json'), JSON.stringify({ length, shots, cuts, audio: log }, null, 1));
}

/**
 * Mix the soundtrack in the game's page, with the game's own synthesiser, and
 * put it under the film.
 */
async function mix(run, video) {
  const timeline = JSON.parse(await readFile(join(OUT_DIR, 'timeline.json'), 'utf8'));
  const { cuts, audio: log } = timeline;
  const length = timeline.length ?? timeline.shots.reduce((sum, shot) => sum + shot.frames, 0) / 60;
  await run(`${await readFile(join(HERE, 'soundtrack.js'), 'utf8')};true`);
  const wav = await run(`window.__soundtrack(${JSON.stringify({ cuts, audio: log, length })})`);
  const audio = join(OUT_DIR, 'soundtrack.wav');
  await writeFile(audio, Buffer.from(wav, 'base64'));
  const final = join(OUT_DIR, `trailer-${LANGUAGE}.mp4`);
  await ffmpeg(['-i', video, '-i', audio, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-shortest', final]);
  console.log(`wrote ${final}`);
}

/**
 * The film cut upright (1080x1920) for Shorts, Reels and TikTok.
 *
 * The game is a 16:9 picture whose windows sit at its edges, so cropping it
 * to a phone's shape would cut the name plates and the message box in half.
 * It is laid across the middle at the full width instead, and the space above
 * and below is filled with the same frame blown up, blurred and dimmed, so
 * the fill moves and changes colour with whatever is on screen.
 */
async function upright() {
  const final = join(OUT_DIR, `trailer-${LANGUAGE}.mp4`);
  const vertical = join(OUT_DIR, `trailer-${LANGUAGE}-vertical.mp4`);
  await ffmpeg([
    '-i', final,
    '-filter_complex', [
      '[0:v]split=2[fill][band]',
      // Blurred small and scaled back up, which is a softer blur and far cheaper.
      '[fill]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,scale=135:240,gblur=sigma=9,scale=1080:1920,eq=brightness=-0.24:saturation=1.2[back]',
      '[band]scale=1080:-2:flags=lanczos[front]',
      '[back][front]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]',
    ].join(';'),
    '-map', '[v]', '-map', '0:a',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-r', '60', '-movflags', '+faststart',
    '-c:a', 'copy',
    vertical,
  ]);
  console.log(`wrote ${vertical}`);
}

/** @param {string[]} parameters */
function ffmpeg(parameters) {
  return new Promise((resolve, reject) => {
    spawn(FFMPEG, ['-y', '-loglevel', 'error', ...parameters], { stdio: 'inherit' })
      .on('close', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`ffmpeg exited with ${code}`))));
  });
}
