/**
 * The persistent overlay on the travelling view: who you are travelling with,
 * where you are, and the buttons into the menus.
 */
import { url } from '../core/bridge.mjs';
import { artPath, speciesOf } from '../core/data.mjs';
import { button, el, setChildren, shinyMark, statusMark } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { leagueOpen } from '../engine/session.mjs';
import { experienceProgress, levelOf, maxHp } from '../engine/pokemon.mjs';
import { formatMoney } from '../engine/shop.mjs';
import { badgeIcon, championIcon } from '../ui/badges.mjs';

/** The gyms a League challenge needs, and so the badge case's empty places. */
const BADGE_SLOTS = 8;

/**
 * @param {{
 *   onInventory: () => void,
 *   onPokedex: () => void,
 *   onSettings: () => void,
 *   onShop: () => void,
 *   onLeague: () => void,
 *   onTraySelect: (index: number) => void,
 * }} handlers
 */
export function createHud(handlers) {
  const areaLabel = el('span', { style: { fontSize: '10px', color: 'var(--ink)', fontWeight: '700' } });
  const nameLabel = el('span', { style: { fontSize: '11px', fontWeight: '700' } });
  const levelLabel = el('span', { style: { fontSize: '10px', color: 'var(--ink-soft)' } });
  /** The companion's status condition, beside its name as the games show it. */
  const statusSlot = el('span');
  let shownStatus = /** @type {string|null|undefined} */ (undefined);
  const hpFill = el('i', { style: barFill('#63bb5b') });
  const expFill = el('i', { style: barFill('#4d90d5') });
  const hpText = el('span', { style: { fontSize: '9px', color: 'var(--ink-soft)' } });

  // A fixed button over the bag, Pokédex and settings row rather than a
  // floating one, so it is always in the same place when the League opens.
  const leagueButton = button(t('field.toLeague'), handlers.onLeague, { className: 'small primary' });
  leagueButton.hidden = true;

  /**
   * The caption over the tray.
   *
   * Without it the tray is a column of unlabelled icons in a corner, and a
   * player who has just knocked something down has no way of knowing that the
   * offer to catch it is sitting there. It is hidden while the tray is empty.
   */
  const trayLabel = el('div.hud-window', {
    style: { padding: '1px 5px', fontSize: '9px', fontWeight: '700', color: 'var(--ink)' },
    text: t('tray.title'),
  });

  const tray = el('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      alignItems: 'flex-end',
    },
  });

  /**
   * The badge case and the purse, opposite the status window.
   *
   * Both used to be a menu away — the badges on the Pokémon tab, the money
   * only in the shop — and they are what a player checks on the way to the
   * League. The case has a place for each of the eight gyms, so how far there
   * is to go reads at a glance; the crown follows once the champion falls.
   */
  const badgeCase = el('div.hud-badges');
  const moneyLabel = el('span.hud-money');
  const purse = el('div.panel.hud-window.hud-purse', {}, [badgeCase, moneyLabel]);

  // The tray hangs under the purse, so the two never overlap however long
  // the tray grows.
  const corner = el('div', {
    style: {
      position: 'absolute',
      top: '20px',
      right: '6px',
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
      alignItems: 'flex-end',
    },
  }, [purse, tray]);

  const status = el('div.panel.hud-window', {
    style: {
      position: 'absolute',
      left: '6px',
      top: '20px',
      width: '150px',
      padding: '4px 6px',
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
    },
  }, [
    el('div', { style: { display: 'flex', alignItems: 'baseline', gap: '4px' } }, [nameLabel, statusSlot, levelLabel]),
    el('div', { style: barTrack() }, [hpFill]),
    el('div', { style: { display: 'flex', justifyContent: 'space-between' } }, [
      el('span', { text: t('pokemon.hp'), style: { fontSize: '9px', color: 'var(--ink-soft)' } }),
      hpText,
    ]),
    el('div', { style: { ...barTrack(), height: '3px' } }, [expFill]),
  ]);

  const buttons = el('div', {
    style: { position: 'absolute', left: '6px', bottom: '6px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px' },
  }, [
    leagueButton,
    el('div', { style: { display: 'flex', gap: '4px' } }, [
      button(t('field.inventory'), handlers.onInventory, { className: 'small' }),
      button(t('field.pokedex'), handlers.onPokedex, { className: 'small' }),
      button(t('field.settings'), handlers.onSettings, { className: 'small' }),
    ]),
  ]);

  // The shop, open from anywhere on the road, beside where the road is named.
  const areaBadge = el('div', {
    style: {
      position: 'absolute',
      right: '6px',
      bottom: '6px',
      display: 'flex',
      alignItems: 'center',
      gap: '4px',
    },
  }, [
    button(t('field.shop'), handlers.onShop, { className: 'small' }),
    el('div.hud-window', { style: { padding: '2px 8px' } }, [areaLabel]),
  ]);

  const root = el('div.screen.hud', { style: { pointerEvents: 'none' } }, [status, corner, buttons, areaBadge]);
  for (const node of [status, purse, tray, buttons, areaBadge]) node.style.pointerEvents = 'auto';
  // Everything but the tray steps aside while idle: a Pokémon waiting to be
  // caught is an offer that runs out, so it stays in sight.
  for (const node of [status, purse, buttons, areaBadge]) node.classList.add('hud-fade');

  /** What the tray was last built from, so it is only rebuilt when it changes. */
  let trayKey = '';
  /** Likewise the badge case. */
  let badgeKey = '';

  return {
    root,
    tray,

    /**
     * Fade the windows out, or bring them back. The tray of Pokémon waiting
     * to be caught stays put. Faded, the rest still answer a click — but the
     * pointer has to be over the companion to make one, and that is what
     * brings them back.
     *
     * @param {boolean} idle
     */
    setIdle(idle) {
      root.classList.toggle('idle', idle);
    },

    /** @param {import('../engine/session.mjs').Session} session */
    update(session) {
      // Rebuilt from the session rather than on notification, so a Pokémon
      // reaching the tray by any route shows up without a separate call.
      // Whether each is registered as caught is in the key too: catching one
      // marks every other of its species waiting in the tray.
      const key = session.tray
        .map((pokemon) => `${pokemon.speciesId}:${pokemon.caughtAt}:${session.caught.has(pokemon.speciesId)}`)
        .join(',');
      if (key !== trayKey) {
        trayKey = key;
        this.updateTray(session.tray, handlers.onTraySelect, (speciesId) => session.caught.has(speciesId));
      }

      const pokemon = session.active;
      const species = speciesOf(pokemon.speciesId);
      const max = maxHp(pokemon);
      const progress = experienceProgress(pokemon);

      nameLabel.textContent = pokemon.nickname || localized(species.name, species.slug);
      levelLabel.textContent = t('slot.level', { level: levelOf(pokemon) });
      if ((pokemon.status ?? null) !== shownStatus) {
        shownStatus = pokemon.status ?? null;
        setChildren(statusSlot, [statusMark(shownStatus, t(`status.${shownStatus}.short`))]);
      }
      hpText.textContent = `${Math.max(0, Math.round(pokemon.hp))}/${max}`;

      const ratio = max > 0 ? Math.max(0, pokemon.hp) / max : 0;
      hpFill.style.width = `${ratio * 100}%`;
      hpFill.style.background = ratio > 0.5 ? '#63bb5b' : ratio > 0.2 ? '#f3d23b' : '#d8443c';
      expFill.style.width = `${progress.ratio * 100}%`;

      const badges = pokemon.badges ?? [];
      const nextBadgeKey = `${badges.join(',')}|${Boolean(pokemon.champion)}`;
      if (nextBadgeKey !== badgeKey) {
        badgeKey = nextBadgeKey;
        const empty = Math.max(0, BADGE_SLOTS - badges.length);
        setChildren(badgeCase, [
          ...badges.map((type) => badgeIcon(type)),
          ...Array.from({ length: empty }, () => el('span.badge-slot', { 'aria-hidden': 'true' })),
          pokemon.champion ? championIcon() : null,
        ]);
        badgeCase.title = t('slot.badges', { count: badges.length });
      }
      moneyLabel.textContent = t('money.label', { amount: formatMoney(session.money) });

      areaLabel.textContent = localized(session.area?.name, session.area?.id ?? '');
      leagueButton.hidden = !leagueOpen(session);
    },

    /**
     * The tray of defeated Pokémon waiting to be caught or let go.
     *
     * A species already registered as caught wears a small Poké Ball in its
     * corner, as the games mark a wild Pokémon's nameplate once the Pokédex
     * has it; a shiny wears the box's red star in the other.
     *
     * @param {Array<import('../engine/pokemon.mjs').Pokemon>} entries
     * @param {(index: number) => void} onSelect
     * @param {(speciesId: number) => boolean} [caught]
     */
    updateTray(entries, onSelect, caught = () => false) {
      setChildren(tray, [
        entries.length ? trayLabel : null,
        ...entries.map((pokemon, index) =>
          el('button.hud-window.tray-slot', {
            type: 'button',
            title: localized(speciesOf(pokemon.speciesId)?.name, ''),
            style: {
              '-webkit-app-region': 'no-drag',
              position: 'relative',
              width: '30px',
              height: '30px',
              padding: '0',
              cursor: 'pointer',
            },
            onClick: () => onSelect(index),
          }, [
            el('img', {
              src: url('assets', artPath(pokemon) ?? ''),
              alt: '',
              style: { width: '28px', height: '28px', objectFit: 'contain' },
            }),
            caught(pokemon.speciesId) ? el('i.caught-mark', { 'aria-hidden': 'true' }) : null,
            shinyMark(pokemon),
          ]),
        ),
      ]);
    },
  };
}

const barTrack = () => ({
  position: 'relative',
  height: '5px',
  borderRadius: '3px',
  background: 'rgba(56, 74, 99, 0.3)',
  overflow: 'hidden',
});

/** @param {string} color */
const barFill = (color) => ({
  display: 'block',
  height: '100%',
  width: '0%',
  background: color,
  transition: 'width 220ms ease-out',
});
