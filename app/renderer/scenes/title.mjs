/**
 * The title screen.
 *
 * Its backdrop is a random area background for the current time of day, so the
 * game already looks like the world it drops you into.
 */
import { timeOfDay } from '../../shared/constants.mjs';
import { appControl, url } from '../core/bridge.mjs';
import { gameData } from '../core/data.mjs';
import { button, el } from '../core/dom.mjs';
import { t } from '../core/i18n.mjs';
import { settingsScene } from '../ui/settings.mjs';
import { slotScene } from './saveselect.mjs';

/**
 * @param {{slots: Array<any>}} options
 * @returns {import('../core/app.mjs').Scene}
 */
export function titleScene({ slots }) {
  return {
    mount(app) {
      const hasSave = slots.some((slot) => !slot.empty);
      const areas = gameData().areas;
      const area = areas[Math.floor(Math.random() * areas.length)];

      app.audio.playMusic(gameData().bgm.cues.title);

      return el('div.screen#title-screen', {}, [
        el('div.backdrop', {
          style: {
            backgroundImage: `url("${url('assets', `areas/${area.id}/${timeOfDay()}.png`)}")`,
          },
        }),
        el('div.logo', { text: t('app.title') }),
        el('div.menu', {}, [
          button(t('title.newGame'), () => {
            app.audio.blip('confirm');
            app.push(slotScene({ mode: 'new', slots }));
          }, { className: 'primary' }),
          button(t('title.continue'), () => {
            app.audio.blip('confirm');
            app.push(slotScene({ mode: 'continue', slots }));
          }, { disabled: !hasSave }),
          button(t('title.settings'), () => {
            app.audio.blip('select');
            app.push(settingsScene({ onClose: () => app.pop() }));
          }),
          // No run is open here, so there is nothing to save on the way out.
          button(t('title.quit'), () => {
            app.audio.blip('cancel');
            appControl.quit();
          }),
        ]),
      ]);
    },
  };
}
