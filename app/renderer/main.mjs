/**
 * Renderer entry point: load everything the game needs, then hand control to
 * the title screen — by way of the notice that this is a fan game.
 */
import { App, fitStage, runLoop, trackWindowDrag } from './core/app.mjs';
import { AudioEngine } from './core/audio.mjs';
import { saves, settings as settingsApi } from './core/bridge.mjs';
import { loadGameData } from './core/data.mjs';
import { el } from './core/dom.mjs';
import { setLanguage, t } from './core/i18n.mjs';
import { noticeScene } from './scenes/notice.mjs';
import { titleScene } from './scenes/title.mjs';

async function boot() {
  const overlay = /** @type {HTMLElement} */ (document.getElementById('overlay'));
  const splash = el('div#boot', { text: 'Loading…' });
  overlay.append(splash);

  fitStage();
  window.addEventListener('resize', fitStage);
  trackWindowDrag();

  const settings = await settingsApi.get();
  // The sheet has the last word on which languages exist, so a settings file
  // naming one it no longer lists is written back to whatever was used instead
  // — otherwise the settings screen would show no language ticked at all.
  const language = await setLanguage(settings.language);
  if (language !== settings.language) Object.assign(settings, await settingsApi.set({ language }));
  splash.textContent = t('app.loading');

  const [, slots] = await Promise.all([loadGameData(), saves.list()]);

  const audio = new AudioEngine();
  audio.setVolumes(settings);

  const app = new App({ settings, audio });
  // The screenshot harness in tools/ drives the game through this; nothing in
  // the app itself reads it.
  /** @type {any} */ (globalThis).__pdcApp = app;
  splash.remove();
  app.setScene(noticeScene({ onDone: () => app.setScene(titleScene({ slots })) }));
  runLoop(app);
}

boot().catch((error) => {
  console.error(error);
  const overlay = document.getElementById('overlay');
  if (overlay) {
    overlay.replaceChildren(el('div#boot', { text: `${t('app.loadFailed')}\n\n${error.message ?? error}` }));
  }
});
