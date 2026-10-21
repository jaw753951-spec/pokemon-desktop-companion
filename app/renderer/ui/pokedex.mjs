/**
 * The Pokédex.
 *
 * Every species is listed from the start, but as a silhouette and a number
 * until it has been met. Meeting one reveals its name and sprite; catching one
 * opens the entry proper — which is how the games have always staged it.
 *
 * The pictures come as the box's do, a few rows at a time near the window
 * (see `pictureLoader`): every species at once was over a thousand of them
 * set loading the moment the Pokédex opened.
 */
import { url } from '../core/bridge.mjs';
import { artPath, gameData, speciesOf } from '../core/data.mjs';
import { button, el, scrollable, setChildren } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { pictureLoader } from './pictureloader.mjs';
import { typeChip } from './typechip.mjs';

/** Entries to a row, as `.dex-grid` lays them out. */
const DEX_ROW = 9;

/**
 * @param {{session: import('../engine/session.mjs').Session, onClose: () => void}} options
 * @returns {import('../core/app.mjs').Scene}
 */
export function pokedexScene({ session, onClose }) {
  return {
    keepBelow: true,
    // The companion keeps walking under this: a menu is the player
    // stopping to read, not the Pokémon stopping to wait.
    keepBelowRunning: true,

    mount(app) {
      const detail = el('div.dex-detail');
      const grid = scrollable(el('div.dex-grid'));

      // A regional Pokémon sits right after the one it is a variety of, and
      // shares its number.
      const dexOf = (id) => speciesOf(id)?.dex ?? id;
      const ids = Object.keys(gameData().species)
        .map(Number)
        .sort((a, b) => dexOf(a) - dexOf(b) || a - b);

      setChildren(grid, ids.map((id) => entryButton(app, session, id, detail)));
      pictureLoader(grid, DEX_ROW).refresh();
      showDetail(session, detail, null);

      return el('div.screen.dex-screen', {}, [
        el('div.screen-header', {}, [
          el('span', { text: t('dex.title') }),
          el('span.meta', { text: t('dex.seen', { count: session.seen.size }) }),
          el('span.meta', { text: t('dex.caught', { count: session.caught.size }) }),
          el('span.spacer'),
          button(t('common.close'), () => {
            app.audio.blip('cancel');
            onClose();
          }, { className: 'small' }),
        ]),
        el('div.dex-split', {}, [grid, detail]),
      ]);
    },
  };
}

/**
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {number} id
 * @param {HTMLElement} detail
 */
function entryButton(app, session, id, detail) {
  const seen = session.seen.has(id);
  const species = speciesOf(id);

  return el(`button.dex-entry${seen ? '' : '.unseen'}`, {
    type: 'button',
    title: seen ? [localized(species?.name, ''), localized(species?.form, '')].filter(Boolean).join(' · ') : t('dex.unknown'),
    onClick: () => {
      app.audio.blip('select');
      showDetail(session, detail, id);
      if (session.caught.has(id)) app.audio.playCry(id);
    },
  }, [
    // Put up by the Pokédex's `pictureLoader` once it is near the window.
    el('img', { alt: '', decoding: 'async', dataset: { path: artPath({ speciesId: id }) ?? '' } }),
    el('span.dex-number', { text: String(species?.dex ?? id).padStart(4, '0') }),
    session.champions.has(id) ? el('span.dex-champion', { text: '★' }) : null,
  ]);
}

/**
 * @param {import('../engine/session.mjs').Session} session
 * @param {HTMLElement} detail
 * @param {number|null} id
 */
function showDetail(session, detail, id) {
  if (!id) {
    detail.replaceChildren(el('span.meta', { text: t('dex.notSeen') }));
    return;
  }

  const species = speciesOf(id);
  const seen = session.seen.has(id);
  const caught = session.caught.has(id);

  if (!seen) {
    setChildren(detail, [
      el('span.dex-detail-number', { text: `No.${String(species?.dex ?? id).padStart(4, '0')}` }),
      el('span.dex-detail-name', { text: t('dex.unknown') }),
      el('span.meta', { text: t('dex.notSeen') }),
    ]);
    return;
  }

  setChildren(detail, [
    el('img.dex-detail-sprite', { src: url('assets', artPath({ speciesId: id }) ?? ''), alt: '' }),
    el('span.dex-detail-number', { text: `No.${String(species?.dex ?? id).padStart(4, '0')}` }),
    el('span.dex-detail-name', { text: localized(species?.name, '') }),
    // The form under the name, as the games' Pokédex labels it: the name is
    // the species' own, and an Alolan Raichu is told apart here.
    species?.form ? el('span.dex-detail-form', { text: localized(species.form, '') }) : null,
    session.champions.has(id) ? el('span.dex-champion-mark', { text: t('dex.championBadge') }) : null,

    caught
      ? el('div.dex-facts', {}, [
          el('div.pokemon-types', {}, (species?.types ?? []).map((type) => typeChip(type, true))),
          el('span.meta', { text: localized(species?.genus, '') }),
          el('div.dex-measures', {}, [
            el('span', { text: `${t('dex.height')} ${(species.height / 10).toFixed(1)}m` }),
            el('span', { text: `${t('dex.weight')} ${(species.weight / 10).toFixed(1)}kg` }),
          ]),
          el('p.dex-text', { text: localized(species?.text, '') }),
        ])
      : el('span.meta', { text: t('dex.notCaught') }),
  ]);
}

