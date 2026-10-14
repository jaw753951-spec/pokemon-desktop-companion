#!/usr/bin/env electron
/**
 * Capture the running game, for checking screens without a desktop.
 *
 *   xvfb-run -a npx electron tools/screenshot.mjs [--out shots] [--wait 4000] [--until 15-auto-condition]
 *
 * This is an alternative Electron entry point that boots the real main process
 * modules, then drives the renderer through a short script of clicks so each
 * screen can be photographed. Nothing here is part of the shipped app.
 */
import { app } from 'electron';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every run starts from nothing. A pass that reaches the end writes a save, and
// the next one would then open its slot on "overwrite this?" rather than on the
// starter screen — so the whole script would photograph the wrong screens.
// `userData` decides where that save lands and is read as `paths.mjs` loads,
// which is why the main-process modules are imported after it moves.
app.setPath('userData', await mkdtemp(join(tmpdir(), 'pdc-shots-')));

const { registerHandlers, registerProtocolHandler, registerProtocolScheme } = await import('../../app/main/ipc.mjs');
const { loadSettings } = await import('../../app/main/settings.mjs');
const { createWindow } = await import('../../app/main/window.mjs');

const args = process.argv.slice(2);
const option = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};

const OUT_DIR = option('--out', join(process.cwd(), 'shots'));
const SETTLE_MS = Number(option('--wait', '2500'));
/** The last step to photograph, for a run after one screen in particular. */
const UNTIL = option('--until', null);

/** How long a screen is left to settle before it is photographed. */
const SETTLE_AFTER_MS = 1200;

/**
 * Each step names a shot and the renderer-side script that sets it up.
 * Selectors are matched on visible text so the script survives restyling.
 *
 * A shot is taken a moment after its script returns, so a screen that is still
 * settling is photographed settled. `settle` shortens that wait for the steps
 * that are chasing a particular frame of an animation rather than a screen.
 */
const STEPS = [
  { name: '01-title', script: 'null' },
  { name: '02-slots', script: 'clickText("button", ["새 게임", "New Game"])' },
  { name: '03-starter', script: 'clickText("button", ["1."])' },
  {
    name: '04-starter-confirm',
    script: 'clickImageAlt(["파이리", "Charmander"])',
  },
  {
    name: '05-field',
    script: 'clickText("button", ["예", "Yes"])',
  },
  { name: '06-settings-display', script: 'clickText("button", ["설정", "Settings"])' },
  { name: '07-settings-sound', script: 'clickText("button.tab", ["소리", "Sound"])' },
  { name: '08-settings-language', script: 'clickText("button.tab", ["언어", "Language"])' },
  { name: '09-bag-pokemon', script: 'clickText("button", ["닫기", "Close"]) && await wait(250) && clickText("button", ["가방", "Bag"])' },
  // A fresh run owns three potions and nothing else, and its box is empty, so
  // these three tabs are stocked first — as with the badges below, the shot is
  // of the screen, not of what an hour of play happens to have earned.
  { name: '10-bag-items', script: 'seedBag() && clickText("button.tab", ["아이템", "Items"])' },
  // What the bag does by itself, which is a screen of its own behind the last
  // pocket tab.
  { name: '11-bag-options', script: 'clickText("button.chip", ["사용 설정", "Use"]) && await wait(300)' },
  { name: '12-bag-box', script: 'seedBox() && clickText("button.tab", ["박스", "Box"])' },
  // The badges are in the key pocket under the charms, the travelling
  // Pokémon's own, with the first open on the panel.
  { name: '13-bag-badges', script: 'seedBadges(8) && seedKeyPocket() && clickText("button.tab", ["아이템", "Items"]) && await wait(250) && clickText("button.chip", ["소중한 것", "Key Items"]) && await wait(250) && clickFirst(".badge-row")' },
  { name: '14-auto-battle', script: 'clickText("button.tab", ["포켓몬", "Pokémon"]) && await wait(250) && clickText("button", ["자동전투", "Auto-battle"])' },
  // The list behind one of those conditions, which is where a kind is switched
  // off as well as gated.
  // The one-press setup, taken: its question answered yes.
  { name: '14b-auto-optimized', script: 'clickText("button", ["자동 최적화", "Optimize"]) && await wait(300) && clickText(".modal button", ["예", "Yes"])' },
  { name: '15-auto-condition', script: 'clickText("button.auto-condition", []) && await wait(400)' },
  { name: '16-pokedex', script: 'closeAll() && clickText("button", ["도감", "Pokédex"])' },
  // Charmander, because the starter is the one species this run has certainly
  // caught: an entry only seen shows a silhouette and no description.
  { name: '17-dex-entry', script: 'clickDexEntry(4)' },
  // An event spawns beyond the right edge and is walked into, so each of these
  // waits for the state it wants rather than for a fixed time.
  { name: '18-event-berry', script: 'closeAll() && await forceEvent("berry") && await waitFor(() => walkStopped(), 25000)' },
  { name: '19-event-berry-held', script: 'await waitFor(() => bagGrew(), 16000)' },
  { name: '20-event-ball', script: 'closeAll() && await forceEvent("ball") && await waitFor(() => walkStopped(), 25000)' },
  { name: '21-event-ball-held', script: 'await waitFor(() => bagGrew(), 16000)' },
  // A rest stop is a Pokémon Center to walk up to, so it is waited for like
  // the berry tree — and then held on long enough for the door to open and the
  // companion to step inside.
  { name: '22-event-center', script: 'closeAll() && await forceEvent("heal") && await waitFor(() => walkStopped(1), 25000, 100)', settle: 0 },
  { name: '23-event-center-inside', script: 'await wait(900)', settle: 0 },
  { name: '24-event-center-out', script: 'await wait(4700)', settle: 0 },
  // A level-5 starter loses every wild battle it is thrown into, which left
  // the tray and capture shots empty. Levelling it first makes the whole tail
  // of the run — win, tray, capture screen — actually reachable.
  { name: '25-battle-wild', script: 'equipForCapture(40) && await forceEvent("wild") && await waitFor(() => inBattle(), 25000) && await wait(1500)' },
  { name: '26-battle-end', script: 'await waitFor(() => !inBattle(), 60000) && await wait(1500)' },
  // Seeded rather than won: a wild Pokémon rolls up to fifteen levels above
  // the companion, so no amount of levelling makes the battle a sure thing,
  // and these two shots are about the screens, not the fight.
  { name: '27-tray-menu', script: 'closeAll() && seedTray() && await wait(500) && clickTray() && await wait(600)' },
  { name: '28-capture', script: 'clickText("button", ["포획", "Catch"]) && await wait(1500)' },
  // A catching berry given: the odds under the balls go up at once.
  { name: '28b-capture-berry', script: 'clickImageAlt(["황금 라즈열매", "Golden Razz Berry"]) && await wait(400)' },
  // Last of the events, because it deliberately leaves one mid-approach:
  // `forceEvent` cannot preempt an event that is already running, so anything
  // after it would get this trainer's battle instead of what it asked for.
  // A leader is met at their gym: walked up to like a Pokémon Center, and the
  // battle opens as the companion goes through the door.
  { name: '29-gym-door', script: 'closeAll() && summonLeader() && await forceEvent("trainer") && await waitFor(() => walkStopped(1), 25000, 100)', settle: 0 },
  // A gym leader battle, which the wild one does not show: a portrait, a name
  // plate and a party of more than one.
  { name: '30-battle-leader', script: 'await waitFor(() => inBattle(), 25000) && await wait(1800)' },
  // And back out of the gym's door once it is over.
  { name: '30b-gym-out', script: 'await waitFor(() => !inBattle(), 120000) && await wait(800)', settle: 0 },
  // The league opens on the eighth badge, so the case is filled the rest of
  // the way rather than played through.
  { name: '31-league', script: 'closeAll() && seedBadges(8) && useLeague("hoenn") && await wait(900) && clickText("button", ["포켓몬 리그로 간다", "To the League"]) && await wait(1200)' },
  // The league's own rooms. Fighting four rounds to reach the champion would
  // take longer than the whole run and could be lost on any of them, so each
  // round's battle is opened directly — the same scene the league opens, with
  // the same party and the same chamber behind it.
  { name: '32-battle-elite', script: 'await leagueBattle(0) && await wait(2000)' },
  { name: '33-battle-champion', script: 'await leagueBattle(-1) && await wait(2000)' },
  // Saving turns Continue on, and the slot list then shows a run in progress
  // rather than three empty rows. The settings screen's own Save and quit
  // closes the window, which would end the run before these two were taken,
  // so the save is written and the title rebuilt in its place.
  { name: '34-title-saved', script: 'await saveAndShowTitle()' },
  { name: '35-slots-filled', script: 'clickText("button", ["계속하기", "Continue"])' },
];

app.commandLine.appendSwitch('disable-gpu');
registerProtocolScheme();

app.whenReady().then(async () => {
  registerProtocolHandler();
  registerHandlers();

  const window = createWindow({ ...(await loadSettings()), scale: 2, windowX: 0, windowY: 0 });
  await new Promise((resolve) => /** @type {any} */ (window.webContents).once('did-finish-load', resolve));
  await mkdir(OUT_DIR, { recursive: true });

  window.webContents.on('console-message', (_event, _level, message) => console.log(`[renderer] ${message}`));

  await delay(SETTLE_MS);

  for (const step of STEPS) {
    try {
      await window.webContents.executeJavaScript(`(async () => {\n${HELPERS}\nreturn (${step.script});\n})()`, true);
    } catch (error) {
      console.error(`step ${step.name} failed: ${error}`);
    }
    await delay(step.settle ?? SETTLE_AFTER_MS);
    const image = await window.webContents.capturePage();
    await writeFile(join(OUT_DIR, `${step.name}.png`), image.toPNG());
    console.log(`captured ${step.name}`);
    if (step.name === UNTIL) break;
  }

  app.quit();
});

app.on('window-all-closed', () => app.quit());

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Injected before every step's script. */
const HELPERS = `
const wait = (ms) => new Promise((r) => setTimeout(() => r(true), ms));
const clickImageAlt = (alts) => {
  const image = [...document.querySelectorAll('img')].find((node) => alts.includes(node.alt));
  if (image) { (image.closest('button') || image).click(); return true; }
  console.log('no image alt among: ' + [...document.querySelectorAll('img')].map((n) => n.alt).join(' | '));
  return false;
};
const app = () => window.__pdcApp;
const closeAll = () => {
  // Press the screen's own close button where there is one: popping the stack
  // skips the handler that unpauses the field and puts the companion back on
  // the path, which left later field shots with an empty patch of grass.
  for (let i = 0; i < 4 && app().stack.length > 1; i++) {
    if (!clickText('button', ['닫기', 'Close', '취소', 'Cancel'])) break;
  }
  while (app().stack.length > 1) app().pop();
  app().scene.setPaused?.(false);
  return true;
};
/**
 * Reach past the once-a-minute timer so a shot does not have to wait for it.
 * Waits for whatever the game started on its own to finish first, otherwise
 * the forced event is dropped as "already busy".
 */
const forceEvent = async (kind) => {
  closeAll();
  const session = app().session;
  // Wait until the companion is walking again: an event still playing out
  // would make the field ignore the forced roll as "already busy".
  for (let i = 0; i < 160; i++) {
    session.eventTimer = 60000;
    const before = app().scene.offset;
    await wait(400);
    if (app().stack.length === 1 && app().scene.offset > before + 5) break;
    closeAll();
  }
  const roll = session.events.roll;
  session.events.roll = () => { session.events.roll = roll; return kind; };
  session.eventTimer = 0;
  return true;
};
/**
 * Make the run capable of reaching the capture screen: a companion that can
 * win a wild battle, healed through the session so its HP lands on its new
 * maximum rather than some number out of range, and balls to throw.
 */
const equipForCapture = (level) => {
  const session = app().session;
  session.active.experience = Math.round(1.2 * level ** 3);
  session.heal();
  session.addItem('poke-ball', 5);
  return true;
};
/**
 * Open one round of the league challenge, in its own chamber.
 *
 * Round -1 means the last one, the champion's. The scene is built from the
 * league's own data rather than fought for: winning four rounds to photograph
 * the fifth would take longer than everything before it and could fail on any
 * of them.
 */
const leagueBattle = async (round) => {
  closeAll();
  const session = app().session;
  useLeague('hoenn');
  // The league patches the challenger up between rounds, and a companion left
  // fainted by the gym leader would lose this battle before the shot is taken.
  session.heal();

  const { battleScene } = await import('./scenes/battle.mjs');
  const { buildParty, leagueLevel, resolveLeague } = await import('./scenes/league.mjs');
  const { backdropForLeagueRound } = await import('./render/backdrop.mjs');

  const league = resolveLeague(session);
  const rounds = [...league.eliteFour, league.champion];
  const index = round < 0 ? rounds.length + round : round;
  const trainer = rounds[index];

  app().push(battleScene({
    session,
    foes: buildParty(session, trainer, leagueLevel(index, rounds.length)),
    trainer,
    backdrop: backdropForLeagueRound(index, rounds.length),
    onFinish: () => app().pop(),
  }));
  return true;
};
/**
 * Write the run to its slot and go back to the title, the way Save and quit
 * would if it did not also close the window.
 */
const saveAndShowTitle = async () => {
  const session = app().session;
  const { saves } = await import('./core/bridge.mjs');
  const { titleScene } = await import('./scenes/title.mjs');
  await saves.write(session.slot, session.toSave());
  while (app().stack.length > 1) app().pop();
  app().setScene(titleScene({ slots: await saves.list() }));
  return true;
};
/** Stock the bag across every pocket, which a fresh run has not had time to do. */
const seedBag = () => {
  const session = app().session;
  for (const [item, count] of [['potion', 5], ['super-potion', 2], ['revive', 1], ['poke-ball', 10],
    ['great-ball', 3], ['oran-berry', 4], ['sitrus-berry', 2], ['tm01', 1], ['fire-stone', 1], ['golden-razz-berry', 2], ['silver-razz-berry', 1]]) {
    session.addItem(item, count);
  }
  return true;
};
/** Put a few Pokémon in the box, which is empty until something is caught. */
const seedBox = () => {
  const session = app().session;
  if (session.box.filter(Boolean).length > 0) return true;
  for (const speciesId of ['10', '25', '52', '74', '129', '133']) {
    const entry = JSON.parse(JSON.stringify(session.active));
    entry.speciesId = speciesId;
    entry.nickname = null;
    session.storeInBox(entry);
  }
  return true;
};
/** Fill the badge case, which no screenshot run is long enough to earn. */
const BADGE_TYPES = ['rock', 'water', 'electric', 'grass', 'poison', 'psychic', 'fire', 'ground'];
const seedBadges = (count) => {
  app().session.badges = BADGE_TYPES.slice(0, count);
  return true;
};
/** A charm in the bag, and the champion's crown after the badges. */
const seedKeyPocket = () => {
  const session = app().session;
  session.addItem('shiny-charm');
  session.active.champion = true;
  return true;
};
/** Click the first element a selector finds. */
const clickFirst = (selector) => {
  const node = document.querySelector(selector);
  if (!node) throw new Error('nothing matches ' + selector);
  node.click();
  return true;
};
/**
 * Pin the next league challenge to a region whose line-up ships portraits:
 * only Hoenn's Elite Four have official art in pret/pokeemerald, so any other
 * region draws the screen without one.
 *
 * The game rolls a whole line-up on entry, so this leans on the roll itself
 * and puts it back the moment it has served one.
 */
const useLeague = (region) => {
  const session = app().session;
  const pick = session.rng.pick.bind(session.rng);
  session.rng.pick = (list) => {
    const match = Array.isArray(list) ? list.find((entry) => entry && entry.region === region) : null;
    if (!match) return pick(list);
    session.rng.pick = pick;
    return match;
  };
  return true;
};
/** Guarantee the next trainer is a gym leader rather than a passer-by. */
const summonLeader = () => {
  app().session.trainerWins = 999;
  app().session.badges = [];
  return true;
};
/** Put something in the post-battle tray, whether or not the battle went well. */
const seedTray = () => {
  const session = app().session;
  if (session.tray.length === 0) session.addToTray(JSON.parse(JSON.stringify(session.active)));
  return true;
};
/** Open the menu on the first Pokémon waiting in the post-battle tray. */
const clickTray = () => {
  const entry = document.querySelector('.screen button img[src*="/pokemon/"]');
  if (entry) { (entry.closest('button') || entry).click(); return true; }
  console.log('tray is empty');
  return false;
};
/** Open one Pokédex entry by its number, rather than whatever sorts first. */
const clickDexEntry = (id) => {
  const number = String(id).padStart(4, '0');
  const entry = [...document.querySelectorAll('button.dex-entry')]
    .find((node) => node.querySelector('.dex-number')?.textContent === number);
  if (entry) { entry.click(); return true; }
  console.log('no dex entry numbered ' + number);
  return false;
};
/**
 * Poll until a predicate holds, or give up so a shot is still taken.
 *
 * The interval is how closely a shot can chase a moment: a step waiting for a
 * door to start opening has to look more often than one waiting for a battle.
 */
const waitFor = async (predicate, timeoutMs, intervalMs = 200) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return true;
    await wait(intervalMs);
  }
  console.log('waitFor timed out');
  return true;
};
const inBattle = () => app().stack.length > 1;
let lastOffset = -1;
let stillFrames = 0;
const walkStopped = (frames = 3) => {
  const offset = Math.round(app().scene.offset ?? 0);
  stillFrames = offset === lastOffset ? stillFrames + 1 : 0;
  lastOffset = offset;
  return stillFrames > frames;
};
let bagAtStart = -1;
const bagGrew = () => {
  const size = Object.values(app().session.bag).reduce((a, b) => a + b, 0);
  if (bagAtStart < 0) bagAtStart = size;
  return size > bagAtStart;
};
const clickText = (selector, texts) => {
  const nodes = [...document.querySelectorAll(selector)];
  const match = texts.length === 0
    ? nodes[0]
    : nodes.find((node) => texts.some((text) => (node.textContent || '').includes(text)));
  if (match) { match.click(); return true; }
  console.log('no match for ' + JSON.stringify(texts) + ' among: ' + nodes.map((n) => n.textContent).join(' | '));
  return false;
};
`;


