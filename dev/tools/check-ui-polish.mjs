#!/usr/bin/env electron
/**
 * One-shot visual check for the UI-polish batch: boot the real game through
 * its own window factory, click a fresh run into existence, then push a
 * trainer battle and the settings screen so the pieces of this batch can be
 * photographed. Exits 0 when everything is on screen, nonzero otherwise.
 *
 *   xvfb-run -a npx electron --no-sandbox dev/tools/check-ui-polish.mjs
 */
import { app } from 'electron';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A scratch profile, so a save written here never turns the next boot's title
// screen into an overwrite prompt.
app.setPath('userData', await mkdtemp(join(tmpdir(), 'pdc-ui-')));

const { registerHandlers, registerProtocolHandler, registerProtocolScheme } = await import('../../app/main/ipc.mjs');
const { loadSettings } = await import('../../app/main/settings.mjs');
const { createWindow } = await import('../../app/main/window.mjs');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.commandLine.appendSwitch('disable-gpu');
registerProtocolScheme();

const fail = async (message) => {
  console.error(`FAIL: ${message}`);
  app.exit(1);
};

app.whenReady().then(async () => {
  registerProtocolHandler();
  registerHandlers();

  const window = createWindow({ ...(await loadSettings()), scale: 2, windowX: 0, windowY: 0 });
  await new Promise((resolve) => /** @type {any} */ (window.webContents).once('did-finish-load', resolve));
  window.webContents.on('console-message', (_event, _level, message) => console.log(`[renderer] ${message}`));

  await delay(2000);

  const save = (name, image) => writeFile(join('shots', `${name}.png`), image.toPNG());

  // A new run: same clicks a player makes.
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

  // The drag strip must be captionless — the point of the batch's first item.
  const strip = await window.webContents.executeJavaScript(`(() => ({
    title: Boolean(document.getElementById('dragbar-title')),
    field: Boolean(document.querySelector('.hud-window')),
  }))()`, true);
  console.log('drag strip:', JSON.stringify(strip));
  if (strip.title) return fail('the drag strip still carries its caption');

  await save('ui-polish-field', await window.webContents.capturePage());
  console.log('shot: ui-polish-field');

  // A trainer battle with a two-Pokémon party, so the ball counter has
  // something to count and the health-bar ghost has damage to trail.
  const battle = await window.webContents.executeJavaScript(`(async () => {
    const app = globalThis.__pdcApp;
    const { battleScene } = await import('./scenes/battle.mjs');
    const { createPokemon } = await import('./engine/pokemon.mjs');
    const { Rng } = await import('./core/rng.mjs');
    const foes = [createPokemon(new Rng(7), 19, 12, { ivFloor: 8 }), createPokemon(new Rng(8), 10, 12, { ivFloor: 8 })];
    app.push(battleScene({
      session: app.session,
      foes,
      trainer: { name: { ko: '트레이너', en: 'Trainer' }, portrait: null },
      backdrop: null,
      onFinish: () => {},
    }));
    return app.stack.length;
  })()`, true);
  console.log('battle pushed, stack:', JSON.stringify(battle));

  await delay(2500);
  const inBattle = await window.webContents.executeJavaScript(`(() => ({
    screen: Boolean(document.querySelector('.battle-screen')),
    balls: document.querySelectorAll('.battle-ball').length,
    catcher: Boolean(document.querySelector('.battle-clickcatch')),
    ghost: Boolean(document.querySelector('.battle-track > .ghost')),
  }))()`, true);
  console.log('battle screen:', JSON.stringify(inBattle));
  if (!inBattle.screen) return fail('battle screen did not open');
  if (inBattle.balls !== 2) return fail(`expected 2 foe balls, saw ${inBattle.balls}`);
  if (!inBattle.ghost) return fail('the health bars carry no damage ghost');
  await save('ui-polish-battle', await window.webContents.capturePage());
  console.log('shot: ui-polish-battle');

  // Click the battle: the beat hurries and a ripple spawns, fading in 260ms.
  // A real click answers as a pointerdown first — which is what the catcher
  // listens for — so the harness sends the same event the pointer would.
  const clicked = await window.webContents.executeJavaScript(`(async () => {
    const catcher = document.querySelector('.battle-clickcatch');
    const rect = catcher.getBoundingClientRect();
    catcher.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rect.left + 120, clientY: rect.top + 60 }));
    await new Promise((r) => setTimeout(r, 60));
    return Boolean(document.querySelector('.click-ripple'));
  })()`, true);
  console.log('ripple after click:', JSON.stringify(clicked));
  if (!clicked) return fail('clicking the battle spawned no ripple');
  await save('ui-polish-click', await window.webContents.capturePage());
  console.log('shot: ui-polish-click');

  // Settings, on the sound tab: music, effects and cries.
  const sound = await window.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const app = globalThis.__pdcApp;
    const { settingsScene } = await import('./ui/settings.mjs');
    app.push(settingsScene({ onClose: () => app.pop() }));
    await wait(150);
    const tabs = [...document.querySelectorAll('.tab')];
    const soundTab = tabs.find((tab) => tab.textContent.includes('소리') || tab.textContent.includes('Sound'));
    if (!soundTab) return { error: 'no sound tab' };
    soundTab.click();
    await wait(150);
    return { rows: [...document.querySelectorAll('.settings-rows .setting .label')].map((n) => n.textContent) };
  })()`, true);
  console.log('sound tab rows:', JSON.stringify(sound));
  if (!sound.rows || sound.rows.length !== 3) return fail(`sound tab shows ${JSON.stringify(sound)}`);
  await save('ui-polish-sound', await window.webContents.capturePage());
  console.log('shot: ui-polish-sound');

  console.log('PASS: the UI-polish batch is on screen');
  app.exit(0);
}).catch((error) => {
  console.error('FAIL:', error);
  app.exit(1);
});
