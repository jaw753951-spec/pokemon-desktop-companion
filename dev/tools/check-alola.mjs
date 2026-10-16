#!/usr/bin/env electron
/**
 * One-shot check: enter the league with Alola rolled, and photograph the
 * challenge screen that opens. Exits 0 when the screen shows an Alola round,
 * nonzero when it does not — so a caller can gate on it.
 *
 *   xvfb-run -a npx electron --no-sandbox dev/tools/check-alola.mjs
 */
import { app } from 'electron';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every run starts from nothing, exactly as the screenshot pass does: a save
// written here would turn the next boot's title screen into an overwrite prompt.
app.setPath('userData', await mkdtemp(join(tmpdir(), 'pdc-check-')));

const { registerHandlers, registerProtocolHandler, registerProtocolScheme } = await import('../../app/main/ipc.mjs');
const { loadSettings } = await import('../../app/main/settings.mjs');
const { createWindow } = await import('../../app/main/window.mjs');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.commandLine.appendSwitch('disable-gpu');
registerProtocolScheme();

app.whenReady().then(async () => {
  registerProtocolHandler();
  registerHandlers();

  const window = createWindow({ ...(await loadSettings()), scale: 2, windowX: 0, windowY: 0 });
  await new Promise((resolve) => /** @type {any} */ (window.webContents).once('did-finish-load', resolve));
  window.webContents.on('console-message', (_event, _level, message) => console.log(`[renderer] ${message}`));

  await delay(2000);

  const fail = async (message) => {
    console.error(`FAIL: ${message}`);
    const image = await window.webContents.capturePage();
    await writeFile('shots/alola-fail.png', image.toPNG());
    app.exit(1);
  };

  // Start a run, pick a starter and confirm it, landing on the field — the
  // same clicks the screenshot pass makes.
  const started = await window.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(() => r(true), ms));
    const clickText = (selector, texts) => {
      const node = [...document.querySelectorAll(selector)].find((el) =>
        texts.some((text) => el.textContent?.trim().includes(text)));
      if (node) { node.click(); return true; }
      return false;
    };
    const clickImageAlt = (alts) => {
      const image = [...document.querySelectorAll('img')].find((node) => alts.includes(node.alt));
      if (image) { (image.closest('button') || image).click(); return true; }
      return false;
    };
    // Past the fan-game notice the game opens on.
    document.getElementById('notice-screen')?.click();
    await wait(400);
    if (!clickText('button', ['새 게임', 'New Game'])) return 'no new-game button';
    await wait(600);
    if (!clickText('button', ['1.'])) return 'no slot button';
    await wait(600);
    if (!clickText('button', ['1.'])) return 'no starter button';
    await wait(600);
    if (!clickImageAlt(['파이리', 'Charmander'])) return 'no starter image';
    await wait(600);
    if (!clickText('button', ['예', 'Yes'])) return 'no confirm button';
    await wait(1200);
    return 'ok';
  })()`, true);
  if (started !== 'ok') return fail(`run did not start: ${started}`);

  // Eight badges turn the league button on, and the rng shim makes Alola the
  // league the next roll lands on — the same trick the screenshot pass uses.
  const entered = await window.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(() => r(true), ms));
    const clickText = (selector, texts) => {
      const node = [...document.querySelectorAll(selector)].find((el) =>
        texts.some((text) => el.textContent?.trim().includes(text)));
      if (node) { node.click(); return true; }
      return false;
    };
    const session = window.__pdcApp.session;
    session.badges = ['rock', 'water', 'electric', 'fire', 'psychic', 'ice', 'dragon', 'dark'];
    const pick = session.rng.pick.bind(session.rng);
    session.rng.pick = (list) => {
      const match = Array.isArray(list) ? list.find((entry) => entry && entry.region === 'alola') : null;
      if (!match) return pick(list);
      session.rng.pick = pick;
      return match;
    };
    if (!clickText('button', ['포켓몬 리그로 간다', 'To the League'])) return 'no league button';
    await wait(1500);
    return 'ok';
  })()`, true);
  if (entered !== 'ok') return fail(`league not entered: ${entered}`);

  const state = await window.webContents.executeJavaScript(`(() => {
    const heading = document.querySelector('.league-heading')?.textContent ?? '';
    const caption = document.querySelector('.league-caption')?.textContent ?? '';
    const stack = window.__pdcApp.stack.length;
    const scene = window.__pdcApp.scene?.constructor?.name ?? '';
    return { heading, caption, stack, scene };
  })()`, true);
  console.log('league state:', JSON.stringify(state));

  const image = await window.webContents.capturePage();
  await writeFile('shots/alola-league-entry.png', image.toPNG());
  console.log('captured shots/alola-league-entry.png');

  const sessionState = await window.webContents.executeJavaScript(`(() => {
    const session = window.__pdcApp.session;
    return { leagueRegion: session.leagueRegion, badges: session.badges.length, alternate: session.leagueRun?.alternate ?? null };
  })()`, true);
  console.log('session:', JSON.stringify(sessionState));

  if (!state.heading.includes('알로라') && !state.heading.includes('Alola')) {
    return fail(`heading does not name Alola: ${state.heading}`);
  }
  if (sessionState.leagueRegion !== 'alola') {
    return fail(`session leagueRegion is not alola: ${sessionState.leagueRegion}`);
  }

  // Four rounds and a champion: the alternates roll must have filled the
  // fourth seat, so the ladder is five battles deep either way. The league the
  // scene resolved is read back through the same game data, not re-resolved —
  // resolving again would roll a whole new league and prove nothing.
  const rounds = await window.webContents.executeJavaScript(`(async () => {
    const session = window.__pdcApp.session;
    const leagues = (await import('./core/data.mjs')).gameData().leagues ?? [];
    const league = leagues.find((entry) => entry.region === session.leagueRegion);
    if (!league) return null;
    // The roll is kept on the run, not folded into the shared data: the
    // fourth seat is whoever of the alternates the challenge drew.
    return {
      eliteFour: [...league.eliteFour.map((m) => m.id), ...(session.leagueRun?.alternate ? [session.leagueRun.alternate] : [])],
      champion: league.champion.id,
    };
  })()`, true);
  if (!rounds) return fail('the resolved league is not in the game data');
  console.log('rounds:', JSON.stringify(rounds));
  if (rounds.eliteFour.length !== 4) {
    return fail(`elite four is not four: ${JSON.stringify(rounds.eliteFour)}`);
  }
  const seen = new Set(rounds.eliteFour);
  if (seen.size !== 4) return fail('a seat is duplicated');
  if (!seen.has('alola-hala') && !seen.has('alola-molayne')) {
    return fail('neither Hala nor Molayne is in the ladder');
  }

  console.log('PASS: Alola league opens with four seats and a champion');
  app.exit(0);
});

app.on('window-all-closed', () => app.quit());
