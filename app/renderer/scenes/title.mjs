/**
 * The title screen.
 *
 * Its backdrop is the area the most recently saved run was left in, for the
 * current time of day, so the game opens on the road it drops you back onto.
 * With no save to go by it is a random area.
 */
import { timeOfDay } from '../../shared/constants.mjs';
import { appControl, url } from '../core/bridge.mjs';
import { gameData } from '../core/data.mjs';
import { button, el } from '../core/dom.mjs';
import { t } from '../core/i18n.mjs';
import { settingsScene } from '../ui/settings.mjs';
import { slotScene } from './saveselect.mjs';

/**
 * The area behind the title: where the most recently saved run stands, or any
 * area when there is no save — or none whose area the game still has.
 *
 * @param {Array<{empty: boolean, summary: any}>} slots
 * @param {() => number} [random]
 */
export function titleArea(slots, random = Math.random) {
  const areas = gameData().areas;
  const latest = slots
    .filter((slot) => !slot.empty && slot.summary?.areaId)
    .sort((a, b) => (b.summary.savedAt ?? 0) - (a.summary.savedAt ?? 0))[0];
  return areas.find((area) => area.id === latest?.summary.areaId) ?? areas[Math.floor(random() * areas.length)];
}

/**
 * The game's name, a word to a part, with the game's icon standing behind the
 * middle one — DESKTOP, in its own name.
 *
 * @param {string} title
 */
function logo(title) {
  const words = title.split(' ');
  const behind = words.length === 3 ? 1 : -1;
  return el('div.logo', { role: 'heading', 'aria-label': title }, words.map((word, index) =>
    el(`span.word.w${index}`, { 'aria-hidden': 'true' }, index === behind ? [iconMark(), el('span.text', { text: word })] : [el('span.text', { text: word })]),
  ));
}

const SVG = 'http://www.w3.org/2000/svg';

/**
 * The game's icon (`dev/tools/make-icon.mjs`), drawn again as a vector: a
 * dark rounded tile with a two-tone ball on it. A picture would have to come
 * through the assets, which the window's address does not reach from here.
 */
function iconMark() {
  /** @param {string} tag @param {Record<string, string|number>} attributes */
  const make = (tag, attributes) => {
    const node = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  };
  const svg = make('svg', { viewBox: '0 0 100 100', class: 'mark', 'aria-hidden': 'true' });
  const clip = make('clipPath', { id: 'logo-ball' });
  clip.append(make('circle', { cx: 50, cy: 50, r: 36 }));
  const ball = make('g', { 'clip-path': 'url(#logo-ball)' });
  ball.append(
    make('rect', { x: 14, y: 14, width: 72, height: 36, fill: '#d8443c' }),
    make('rect', { x: 14, y: 50, width: 72, height: 36, fill: '#f6f6ee' }),
    make('rect', { x: 14, y: 46.6, width: 72, height: 6.8, fill: '#202636' }),
  );
  svg.append(
    make('defs', {}),
    make('rect', { x: 4, y: 4, width: 92, height: 92, rx: 22, fill: '#181e2e' }),
    ball,
    make('circle', { cx: 50, cy: 50, r: 10.5, fill: '#202636' }),
    make('circle', { cx: 50, cy: 50, r: 6.2, fill: '#f6f6ee' }),
  );
  svg.querySelector('defs')?.append(clip);
  return svg;
}

/**
 * @param {{slots: Array<any>}} options
 * @returns {import('../core/app.mjs').Scene}
 */
export function titleScene({ slots }) {
  return {
    mount(app) {
      const hasSave = slots.some((slot) => !slot.empty);
      const area = titleArea(slots);

      app.audio.playMusic(gameData().bgm.cues.title);

      // Which build this is, small in the corner, for a report of a bug to
      // say which version it was seen in.
      const build = el('div.build');
      appControl.version().then((version) => {
        build.textContent = `v${version}`;
      }).catch(() => {});

      return el('div.screen#title-screen', {}, [
        el('div.backdrop', {
          style: {
            backgroundImage: `url("${url('assets', `areas/${area.id}/${timeOfDay()}.png`)}")`,
          },
        }),
        logo(t('app.title')),
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
        build,
      ]);
    },
  };
}
