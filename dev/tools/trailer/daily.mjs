#!/usr/bin/env node
/**
 * Film today's reel for the feed, whichever kind today's is.
 *
 *   node dev/tools/trailer/daily.mjs [--date 2026-11-14] [--again] [--dry]
 *   node dev/tools/trailer/daily.mjs --posted [--date 2026-11-14]
 *
 * Four days of the week are the serial — the next day of the journey
 * (`record.mjs --cut episode`) — and three are a stand-alone reel
 * (`--cut moment`), its script and its seed moving on each time so no two are
 * alike. Once the journey has its Champion every day is a stand-alone reel.
 *
 * What was filmed for each date is written to `trailer/daily.json`, so asking
 * again on the same day answers with the reel already made rather than
 * filming the journey a day further; `--again` films it over (the serial from
 * the save that day opened on). `--posted` marks the date's reel as uploaded.
 * The last line printed is the day's entry as JSON, for whoever runs this;
 * its `cover` is the second of the film to use as the reel's cover.
 *
 * Nothing here uploads anything: that is done by hand, or by the assistant
 * once the reel has been looked at and agreed to.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const OUT = join(ROOT, 'trailer');
const JOURNEY = join(OUT, 'journey');
const LOG = join(OUT, 'daily.json');
/** Kept beside the films rather than installed: the folder is not in the repository. */
const FFMPEG = join(OUT, 'tools', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

const args = process.argv.slice(2);
const option = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
const pad = (value, width = 2) => String(value).padStart(width, '0');
const now = new Date();
const DATE = option('--date', `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
const DRY = args.includes('--dry');

/** Sunday to Saturday: the serial on four of them, a stand-alone reel on the other three. */
const WEEK = ['episode', 'episode', 'moment', 'episode', 'moment', 'episode', 'moment'];
/** The stand-alone reels in the order they come round. */
const PLANS = ['catch', 'evolve', 'gym', 'shiny', 'road'];

const read = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback);
const log = read(LOG, { reels: [] });
const save = () => writeFileSync(LOG, `${JSON.stringify(log, null, 1)}\n`);
const today = () => log.reels.find((reel) => reel.date === DATE);

if (args.includes('--posted')) {
  const reel = today();
  if (!reel) throw new Error(`nothing was filmed for ${DATE}`);
  reel.posted = true;
  save();
  console.log(JSON.stringify(reel));
  process.exit(0);
}

/** Whether the journey has its Champion, after which there is no next day of it. */
function journeyDone() {
  const days = read(join(JOURNEY, 'journey.json'), { days: [] }).days;
  return days.some((day) => day.events.some((event) => event.kind === 'league' && event.champion));
}

/** Put the journey back to where the day being filmed again opened. */
function rewindJourney(day) {
  const state = read(join(JOURNEY, 'journey.json'), { days: [] });
  state.days = state.days.filter((entry) => entry.day < day);
  writeFileSync(join(JOURNEY, 'journey.json'), JSON.stringify(state, null, 1));
  const before = join(JOURNEY, `save-before-day-${pad(day, 3)}.json`);
  // The first day opened on no save at all.
  if (existsSync(before)) copyFileSync(before, join(JOURNEY, 'save.json'));
  else rmSync(join(JOURNEY, 'save.json'), { force: true });
}

let reel = today();
if (reel && existsSync(join(ROOT, reel.file)) && !args.includes('--again')) {
  console.log(`already filmed for ${DATE}`);
  console.log(JSON.stringify(reel));
  process.exit(0);
}
if (reel && reel.posted) throw new Error(`${DATE}'s reel has been posted: film another date instead`);

const [year, month, day] = DATE.split('-').map(Number);
const kind = reel?.kind ?? (journeyDone() ? 'moment' : WEEK[new Date(year, month - 1, day).getDay()]);
/** @type {string[]} */
let flags;
/** @type {any} */
let entry;
if (kind === 'episode') {
  if (reel?.day) rewindJourney(reel.day);
  const next = read(join(JOURNEY, 'journey.json'), { days: [] }).days.length + 1;
  flags = ['--cut', 'episode', '--seed', '11'];
  entry = { date: DATE, kind, day: next, file: `trailer/journey/day-${pad(next, 3)}.mp4` };
} else {
  // Counted over the reels of this kind made so far, so the scripts come round in turn.
  const count = reel?.count ?? log.reels.filter((made) => made.kind === 'moment' && made.date !== DATE).length;
  const plan = PLANS[count % PLANS.length];
  const seed = 3 + count * 7;
  // The desktop opening now and then: one stand-alone reel in six, about once a fortnight.
  const desktop = count % 6 === 5;
  flags = ['--cut', 'moment', '--plan', plan, '--seed', String(seed), ...(desktop ? ['--desktop'] : [])];
  entry = { date: DATE, kind, count, plan, seed, desktop, file: momentFile(plan, seed, desktop) };
}

/** Where the recorder leaves a stand-alone reel. */
function momentFile(plan, seed, desktop) {
  return `trailer/reel-${plan}-${seed}${desktop ? '-desktop' : ''}.mp4`;
}

/**
 * Whether a stand-alone reel did what it is for, from what the recorder said
 * happened in it: the evolution evolved, the catch caught, the gym's badge
 * won. The game's dice can say otherwise — a fight lost, a ball broken out of.
 */
function delivered(plan, seed, told) {
  const line = told.find((entry) => entry.startsWith(`${plan} ${seed}: `));
  if (!line) return false;
  const events = JSON.parse(line.slice(line.indexOf('[')));
  if (plan === 'evolve') return events.some((event) => event.evolved);
  if (plan === 'catch' || plan === 'shiny') return events.some((event) => event.kind === 'capture' && event.caught);
  if (plan === 'gym') return events.some((event) => event.badge);
  return true;
}

if (!DRY && !existsSync(FFMPEG)) throw new Error(`no ffmpeg at ${FFMPEG}`);
mkdirSync(OUT, { recursive: true });
const electron = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
/** Film it, and say what the recorder said happened. */
function film(withFlags) {
  const run = spawnSync(electron, [join(HERE, 'record.mjs'), '--ffmpeg', FFMPEG, '--no-captions', ...withFlags, ...(DRY ? ['--dry'] : [])], {
    cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  // What happened in it, in the recorder's own words.
  const told = output.split(/\r?\n/).filter((line) => /^(day \d+:|\w+ \d+: \[|cover: )|^\[page\] (capture|league|held)/.test(line));
  for (const line of told) console.log(line.slice(0, 400));
  if (run.status !== 0) {
    console.error(output.split(/\r?\n/).slice(-15).join('\n'));
    throw new Error(`the recorder exited with ${run.status}`);
  }
  return told;
}

let told = film(flags);
// A stand-alone reel that did not come off is filmed again on the next seed, a few times at most.
for (let tries = 1; entry.kind === 'moment' && !delivered(entry.plan, entry.seed, told) && tries <= 4; tries++) {
  console.log(`${entry.plan} ${entry.seed} did not come off; trying seed ${entry.seed + 1}`);
  entry.seed += 1;
  entry.file = momentFile(entry.plan, entry.seed, entry.desktop);
  flags[flags.indexOf('--seed') + 1] = String(entry.seed);
  told = film(flags);
}
if (DRY) {
  console.log(JSON.stringify({ ...entry, dry: true }));
  process.exit(0);
}
if (!existsSync(join(ROOT, entry.file))) throw new Error(`the recorder left no ${entry.file}`);
entry.summary = told.find((line) => /^day \d+:/.test(line)) ?? `${entry.plan} reel`;
// The moment the reel's cover is taken from, in seconds (see `coverAt` in director.js).
const cover = Number.parseFloat(told.find((line) => line.startsWith('cover: '))?.slice(7) ?? '');
entry.cover = Number.isFinite(cover) ? Math.round(cover * 10) / 10 : 2;
entry.posted = false;
log.reels = [...log.reels.filter((made) => made.date !== DATE), entry].sort((a, b) => a.date.localeCompare(b.date));
save();
console.log(JSON.stringify(entry));
