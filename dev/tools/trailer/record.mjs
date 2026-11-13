#!/usr/bin/env electron
/**
 * Film the trailer: the real game, driven shot by shot, a frame at a time.
 *
 *   npx electron dev/tools/trailer/record.mjs --ffmpeg path/to/ffmpeg [--out trailer] [--lang en] [--only fight-1] [--stills 30]
 *     [--upright] [--no-captions] [--sound-only]
 *     [--cut encounter [--seed 7] [--dry]]
 *     [--cut moment --plan catch|shiny|evolve|gym|road [--seed 3] [--desktop] [--dry]]
 *     [--cut episode [--journey trailer/journey] [--starter Squirtle] [--catch 263,25] [--events 4] [--budget 30] [--dry [--advance]]]
 *
 * Boots the game's own main-process modules (as the screenshot harness does)
 * into a hidden 1920x1080 window, hands the page to `director.js`, and
 * pipes every frame it photographs straight into ffmpeg. The soundtrack is
 * mixed afterwards by `soundtrack.js` from what the shots asked the speakers
 * for, and the two are put together at the end. With `--upright` the same
 * film is shot again in a 1080x1920 window for the phone-shaped feeds —
 * Shorts, Reels, TikTok — with the camera on each shot's subject and a line
 * about it above the picture. `--cut` films one of the shorts instead of the
 * trailer — a single upright take with the game's own sound
 * (`reel-<cut>.mp4`); how it goes follows from `--seed`, and `--dry`
 * runs it without filming, to read what happens in it. `--cut episode` is the
 * next day of the serial: it picks the journey up from the save in `--journey`
 * (a new run on the first day), films `--events` of the road's events until
 * it has `--budget` seconds, and leaves the save and `day-NNN.mp4` there for
 * the day after. A dry run of it changes nothing, unless it is told to
 * `--advance` the journey a day without a film. Nothing here ships.
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
/** Film the phone-shaped cut rather than the landscape one. */
const UPRIGHT = args.includes('--upright') || args.includes('--cut');
/** Keep a still every so many frames, for looking at without playing the film. */
const STILLS = Number(option('--stills', '0'));
/** Leave the upright cut's lines off the picture, for creators who put their own words over it. */
/** One of the shorts rather than the trailer (see `director.js`): one upright take, with the game's own sound. */
const SHORT = option('--cut', null);
/** What the short's dice start from. */
const SEED = Number(option('--seed', '1'));
/** Run the shots without photographing them, to read what happens in them. */
const DRY = args.includes('--dry');
const BARE = args.includes('--no-captions');
/** The serial's folder: its save, what has happened so far, and each day's reel. */
const JOURNEY_DIR = option('--journey', join(OUT_DIR, 'journey'));
const JOURNEY = SHORT === 'episode' ? await openJourney() : null;
/** A stand-alone reel's script (see `momentPlan` in director.js), and whether it opens on the desktop. */
const PLAN = option('--plan', 'road');
const DESKTOP = args.includes('--desktop');
/**
 * The window is landscape either way. A window as tall as the phone's frame
 * fits on no ordinary display, so the upright cut is drawn lying on its side
 * (see `director.js`) and stood up again by ffmpeg.
 */
const WIDTH = 1920;
const HEIGHT = 1080;
/** What this cut's files are called apart from the other's. */
const CUT = SHORT ? `-${SHORT}` : UPRIGHT ? '-upright' : '';
const FINAL = JOURNEY
  ? join(JOURNEY_DIR, `day-${String(JOURNEY.day).padStart(3, '0')}.mp4`)
  : SHORT === 'moment'
  ? join(OUT_DIR, `reel-${PLAN}-${SEED}${DESKTOP ? '-desktop' : ''}.mp4`)
  : SHORT
  ? join(OUT_DIR, `reel-${SHORT}.mp4`)
  : join(OUT_DIR, `trailer-${LANGUAGE}${UPRIGHT ? '-vertical' : ''}${BARE ? '-nocaption' : ''}.mp4`);
/**
 * The page is laid out at half the film's size and drawn at twice the pixel
 * density: a window as big as the film is cut down to fit the screen on most
 * desktops, where this one always fits — and the text stays sharp.
 */
const DENSITY = 2;

await writeFile(join(userData, 'settings.json'), JSON.stringify({ language: LANGUAGE }));
// The journey so far goes in the first slot, for the title screen to continue from.
if (JOURNEY?.save) {
  await mkdir(join(userData, 'saves'), { recursive: true });
  await writeFile(join(userData, 'saves', 'slot0.json'), JOURNEY.save);
}

app.commandLine.appendSwitch('force-device-scale-factor', String(DENSITY));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const { registerHandlers, registerProtocolHandler, registerProtocolScheme } = await import('../../../app/main/ipc.mjs');
const { RENDERER_DIR } = await import('../../../app/main/paths.mjs');
registerProtocolScheme();

app.whenReady().then(async () => {
  registerProtocolHandler();
  registerHandlers();
  await mkdir(join(OUT_DIR, `stills${CUT}`), { recursive: true });

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
  // It is cut to the primary display's work area as it is made, wherever it
  // is told to go; sized again once there, it is its full size.
  window.setContentSize(size.width, size.height);
  window.webContents.on('console-message', (event) => console.log(`[page] ${/** @type {any} */ (event).message}`));
  await window.loadFile(join(RENDERER_DIR, 'index.html'));
  const run = (code) => window.webContents.executeJavaScript(code, true);
  const inner = await run('[innerWidth, innerHeight]');
  if (inner[0] !== size.width || inner[1] !== size.height) console.warn(`the page is ${inner.join('x')}, not ${size.width}x${size.height}: the frames will be stretched to fit`);

  const video = join(OUT_DIR, ONLY ? `video${CUT}-${ONLY.join('+')}.mp4` : `video${CUT}.mp4`);
  if (!SOUND_ONLY) await film(run, window, video);
  if (!ONLY && !DRY) await mix(run, video);
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
  const shots = await run(`window.__trailer.setup(${JSON.stringify({ wallpaper, icon, upright: UPRIGHT, captions: !BARE, cut: SHORT ?? 'trailer', seed: SEED, plan: PLAN, intro: DESKTOP, ...(JOURNEY ? { day: JOURNEY.day, resume: Boolean(JOURNEY.save), events: Number(option('--events', '4')), budget: Number(option('--budget', '30')), starter: option('--starter', 'Squirtle'), wanted: option('--catch', '').split(',').filter(Boolean).map(Number) } : {}) })})`);
  console.log(shots.map((shot) => `${shot.name}:${shot.frames}`).join(' '));

  const encoder = DRY ? null : spawn(FFMPEG, [
    '-y', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${WIDTH}x${HEIGHT}`, '-r', '60', '-i', '-',
    ...(UPRIGHT ? ['-vf', 'transpose=cclock'] : []),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    video,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const finished = encoder ? new Promise((resolve) => encoder.on('close', resolve)) : Promise.resolve();

  let filmed = 0;
  /** Every frame the game was run through, filmed or not: the film's length. */
  let rolled = 0;
  const started = Date.now();
  for (const [index, shot] of shots.entries()) {
    const wanted = !ONLY || ONLY.includes(shot.name);
    await run(`window.__trailer.begin(${index})`);
    // A hidden window is not drawn again until it is photographed, so the
    // first photograph after the page has been laid out afresh is of how it
    // stood before: one is taken and thrown away before the film starts.
    if (index === 0 && encoder) {
      for (let i = 0; i < 2; i++) {
        await run('window.__trailer.painted()');
        await window.webContents.capturePage();
      }
    }
    for (let frame = 0; frame < shot.frames; frame++) {
      // A shot that decides its own length says when it has had its last frame.
      const answer = await run(`window.__trailer.frame(${index}, ${frame})`);
      const over = answer === 'over' || answer === 'over-skip';
      // Run, but not for the film: what a short leaves to happen off camera.
      const skipped = answer === 'skip' || answer === 'over-skip';
      rolled++;
      if (!wanted || !encoder || skipped) {
        if (over) break;
        continue;
      }
      await run('window.__trailer.painted()');
      let image = await window.webContents.capturePage();
      const size = image.getSize();
      if (size.width !== WIDTH || size.height !== HEIGHT) image = image.resize({ width: WIDTH, height: HEIGHT, quality: 'best' });
      if (!encoder.stdin.write(image.toBitmap())) await new Promise((resolve) => encoder.stdin.once('drain', resolve));
      if ((STILLS && frame % STILLS === 0) || frame === 0) {
        await writeFile(join(OUT_DIR, `stills${CUT}`, `${shot.name}-${String(frame).padStart(4, '0')}.png`), image.toPNG());
      }
      filmed++;
      // A shot that fades in does so off the last frame of this one.
      if (frame === shot.frames - 1 && shots[index + 1]?.freeze) {
        const still = 'data:image/png;base64,' + image.toPNG().toString('base64');
        await run('window.__trailer.freeze(' + JSON.stringify(still) + ')');
      }
      if (over) break;
    }
    console.log(`filmed ${shot.name} (${filmed} frames, ${((Date.now() - started) / 1000).toFixed(0)}s)`);
  }
  encoder?.stdin.end();
  await finished;
  if (JOURNEY) await closeJourney(run);
  if (SHORT === 'moment') console.log(`${PLAN} ${SEED}: ${JSON.stringify((await run('window.__trailer.journey()')).log)}`);
  if (DRY) return;

  const cuts = await run('window.__trailer.cuts()');
  const log = await run('window.__trailer.audioLog()');
  // A short's film is the frames photographed; the rest of it happened off camera.
  const length = (SHORT ? filmed : rolled) / 60;
  await writeFile(join(OUT_DIR, `timeline${CUT}.json`), JSON.stringify({ length, shots, cuts, audio: log }, null, 1));
}

/**
 * Mix the soundtrack in the game's page, with the game's own synthesiser, and
 * put it under the film.
 */
async function mix(run, video) {
  const timeline = JSON.parse(await readFile(join(OUT_DIR, `timeline${CUT}.json`), 'utf8'));
  const { cuts, audio: log } = timeline;
  const length = timeline.length ?? timeline.shots.reduce((sum, shot) => sum + shot.frames, 0) / 60;
  if (SHORT) return mixShort(run, video, { audio: log, length });
  await run(`${await readFile(join(HERE, 'soundtrack.js'), 'utf8')};true`);
  const wav = await run(`window.__soundtrack(${JSON.stringify({ cuts, audio: log, length })})`);
  const audio = join(OUT_DIR, `soundtrack${CUT}.wav`);
  await writeFile(audio, Buffer.from(wav, 'base64'));
  // With the end card as its cover, so the file shows the game's logo
  // rather than the desktop it opens on: a frame from the card's last second,
  // once everything on it has come in.
  const cover = join(OUT_DIR, `cover${CUT}.png`);
  await ffmpeg(['-ss', String(Math.max(0, length - 1)), '-i', video, '-frames:v', '1', cover]);
  await ffmpeg([
    '-i', video, '-i', audio, '-i', cover,
    '-map', '0:v', '-map', '1:a', '-map', '2:v',
    '-c:v:0', 'copy', '-c:v:1', 'png', '-disposition:v:1', 'attached_pic',
    // Not cut to the shortest stream: the cover is one frame long. The
    // soundtrack is mixed to the film's own length.
    '-c:a', 'aac', '-b:a', '256k', FINAL,
  ]);
  console.log(`wrote ${FINAL}`);
}

/**
 * A short's sound is the game's own — the road's music, the fight's, the cries
 * and the hits, as the game asked for them — put under the film as it is.
 */
async function mixShort(run, video, { audio: log, length }) {
  await run(`${await readFile(join(HERE, 'gamesound.js'), 'utf8')};true`);
  const wav = await run(`window.__gameSound(${JSON.stringify({ audio: log, length })})`);
  const audio = join(OUT_DIR, `soundtrack${CUT}.wav`);
  await writeFile(audio, Buffer.from(wav, 'base64'));
  await ffmpeg([
    '-i', video, '-i', audio, '-map', '0:v', '-map', '1:a',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-shortest', '-movflags', '+faststart', FINAL,
  ]);
  console.log(`wrote ${FINAL}`);
}

/** The serial so far: the day about to be filmed, and the run as the day before left it. */
async function openJourney() {
  await mkdir(JOURNEY_DIR, { recursive: true });
  const state = JSON.parse(await readFile(join(JOURNEY_DIR, 'journey.json'), 'utf8').catch(() => '{"days":[]}'));
  const save = await readFile(join(JOURNEY_DIR, 'save.json'), 'utf8').catch(() => null);
  return { state, save, day: state.days.length + 1 };
}

/**
 * Write the day down: what happened in it, and the run as the next day picks
 * it up. A dry run reads the day without keeping it.
 */
async function closeJourney(run) {
  const { day, save, log } = await run('window.__trailer.journey()');
  console.log(`day ${day}: ${log.map((entry) => `${entry.kind}${entry.filmed ? '' : ' (off camera)'}`).join(', ')}`);
  if ((DRY && !args.includes('--advance')) || !save) return;
  await writeFile(join(JOURNEY_DIR, 'save.json'), save);
  // The save each day opened on is kept, so a day can be filmed again.
  if (JOURNEY.save) await writeFile(join(JOURNEY_DIR, `save-before-day-${String(day).padStart(3, '0')}.json`), JOURNEY.save);
  JOURNEY.state.days.push({ day, filmed: new Date().toISOString(), events: log });
  await writeFile(join(JOURNEY_DIR, 'journey.json'), JSON.stringify(JOURNEY.state, null, 1));
}

/** @param {string[]} parameters */
function ffmpeg(parameters) {
  return new Promise((resolve, reject) => {
    spawn(FFMPEG, ['-y', '-loglevel', 'error', ...parameters], { stdio: 'inherit' })
      .on('close', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`ffmpeg exited with ${code}`))));
  });
}
