/**
 * The notice the game opens on, before the title: that it is a fan game made
 * for nothing, and that every name, picture and tune in it belongs to the
 * companies that made Pokémon.
 *
 * The words are the ones fan games and fan sites have settled on, in
 * whichever language the game is set to. A press anywhere goes on to the
 * title, and so does waiting: the companion is started and left, and a
 * notice nobody is there to read should not hold it.
 */
import { el } from '../core/dom.mjs';
import { t } from '../core/i18n.mjs';

/** How long the notice stands before the title comes up by itself. */
export const NOTICE_MS = 7000;

/**
 * @param {{onDone: () => void}} options
 * @returns {import('../core/app.mjs').Scene}
 */
export function noticeScene({ onDone }) {
  let shown = 0;
  let done = false;
  /** @type {((event: KeyboardEvent) => void)|null} */
  let onKey = null;

  const finish = () => {
    if (done) return;
    done = true;
    onDone();
  };

  return {
    mount() {
      onKey = (event) => {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape') finish();
      };
      window.addEventListener('keydown', onKey);

      return el('div.screen#notice-screen', { onClick: finish }, [
        el('div.notice', {}, [
          el('div.notice-title', { text: t('notice.title') }),
          el('p', { text: t('notice.fan') }),
          el('p', { text: t('notice.rights') }),
        ]),
        el('div.notice-continue', { text: t('notice.continue') }),
      ]);
    },

    unmount() {
      if (onKey) window.removeEventListener('keydown', onKey);
      onKey = null;
    },

    update(deltaMs) {
      shown += deltaMs;
      if (shown >= NOTICE_MS) finish();
    },
  };
}
