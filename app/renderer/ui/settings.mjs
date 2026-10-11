/**
 * The settings screen.
 *
 * Reachable from the title and, with "save and quit" added, from the field.
 * The settings are grouped into tabs the same way the bag is, so each screen
 * stays short enough to read at the window's own size.
 */
import { appControl, saves, settings as settingsApi } from '../core/bridge.mjs';
import { button, el, scrollable, setChildren } from '../core/dom.mjs';
import { gameData } from '../core/data.mjs';
import { languages, t } from '../core/i18n.mjs';
import { confirm } from './dialog.mjs';

/**
 * The tabs, in the order they appear. Each names the rows it shows; the
 * language tab builds its own from the sheet.
 */
const TABS = ['display', 'sound', 'language', 'credits'];

/**
 * @param {{
 *   onClose: () => void,
 *   onSaveAndExit?: () => Promise<void>|void,
 *   onSaveAndQuit?: () => Promise<void>|void,
 * }} options
 * @returns {import('../core/app.mjs').Scene}
 */
export function settingsScene({ onClose, onSaveAndExit, onSaveAndQuit }) {
  /** Which tab is open, kept across the re-mount a language change causes. */
  const state = { tab: TABS[0] };

  return {
    keepBelow: true,
    // The companion keeps walking under this: a menu is the player
    // stopping to read, not the Pokémon stopping to wait.
    keepBelowRunning: true,

    mount(app) {
      const tabs = el('div.tab-strip');
      // A tab's rows scroll rather than spill: the language tab is as long as
      // the sheet is, and the window is only 270 pixels tall.
      const rows = scrollable(el('div.settings-rows'));

      const rebuild = () => {
        setChildren(tabs, [
          ...TABS.map((name) =>
            el('button.tab', {
              type: 'button',
              text: t(`settings.tab.${name}`),
              'aria-pressed': String(state.tab === name),
              onClick: () => {
                if (state.tab === name) return;
                app.audio.blip('select');
                state.tab = name;
                rebuild();
              },
            }),
          ),
        ]);

        setChildren(rows, tabRows(app, state.tab, rebuild));
      };
      rebuild();

      return el('div.screen', { style: { background: 'rgba(16, 21, 32, 0.9)' } }, [
        el('div.screen-header', {}, [
          tabs,
          el('span.spacer'),
          button(t('settings.close'), () => {
            app.audio.blip('cancel');
            onClose();
          }, { className: 'small' }),
        ]),
        el('div.screen-body', { style: { display: 'flex', flexDirection: 'column' } }, [
          rows,
          // Leaving the run, in the two ways there are to leave it. Both write
          // the save first, and both ask before doing it: a misplaced click on
          // the settings screen should not end the session.
          onSaveAndExit || onSaveAndQuit
            ? el('div.settings-exits', {}, [
                onSaveAndExit
                  ? button(t('settings.saveAndExit'), () =>
                      leave(app, t('settings.saveAndExitConfirm'), onSaveAndExit), { className: 'small' })
                  : null,
                onSaveAndQuit
                  ? button(t('settings.saveAndQuit'), () =>
                      leave(app, t('settings.saveAndQuitConfirm'), onSaveAndQuit), { className: 'primary' })
                  : null,
              ])
            : null,
        ]),
      ]);
    },
  };
}

/**
 * Ask, then do it. The question is the only thing standing between a settings
 * screen and the end of a run, so it is asked for both ways out.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {string} question
 * @param {() => Promise<void>|void} act
 */
async function leave(app, question, act) {
  app.audio.blip('select');
  if (!(await confirm(app, question, { danger: true }))) return;
  await act();
}

/**
 * @param {import('../core/app.mjs').App} app
 * @param {string} tab
 * @param {() => void} rebuild
 * @returns {Array<HTMLElement|null>}
 */
function tabRows(app, tab, rebuild) {
  switch (tab) {
    case 'sound':
      return [
        volumeRow(app, 'settings.music', 'musicVolume'),
        volumeRow(app, 'settings.effects', 'effectVolume'),
        volumeRow(app, 'settings.cries', 'cryVolume'),
      ];
    case 'language':
      return languageRows(app, rebuild);
    case 'credits':
      return creditRows();
    case 'display':
    default:
      return [scaleRow(app), idleHudRow(app)];
  }
}

/** @param {import('../core/app.mjs').App} app */
function scaleRow(app) {
  const options = el('div.options');

  const render = (steps) => {
    setChildren(options, [
      ...steps.map((step) =>
        el('button.chip', {
          type: 'button',
          text: `${step}×`,
          'aria-pressed': String(app.settings.scale === step),
          onClick: async () => {
            app.audio.blip('select');
            await app.updateSettings({ scale: step });
            render(steps);
          },
        }),
      ),
    ]);
  };

  settingsApi.scaleSteps().then(render);
  return el('div.setting', {}, [el('span.label', { text: t('settings.scale') }), options]);
}

/**
 * Whether the field's windows fade out while the pointer is off the
 * companion, leaving only the road and the Pokémon walking it.
 *
 * @param {import('../core/app.mjs').App} app
 */
function idleHudRow(app) {
  const box = el('input.checkbox', {
    type: 'checkbox',
    checked: app.settings.hideIdleHud !== false,
    onChange: (event) => {
      app.audio.blip('select');
      app.updateSettings({ hideIdleHud: /** @type {HTMLInputElement} */ (event.target).checked });
    },
  });
  return el('label.setting.checkrow', {}, [box, el('span.checkrow-label', { text: t('settings.hideIdleHud') })]);
}

/**
 * @param {import('../core/app.mjs').App} app
 * @param {string} labelKey
 * @param {'musicVolume'|'effectVolume'|'cryVolume'} key
 */
function volumeRow(app, labelKey, key) {
  const value = el('span.value', { text: `${Math.round(app.settings[key] * 100)}%` });
  const slider = el('input', {
    type: 'range',
    min: '0',
    max: '100',
    step: '5',
    value: String(Math.round(app.settings[key] * 100)),
    onInput: (event) => {
      const percent = Number(/** @type {HTMLInputElement} */ (event.target).value);
      value.textContent = `${percent}%`;
      // Apply immediately so the user hears the change while dragging, and let
      // the persisted write happen on the same call.
      app.updateSettings({ [key]: percent / 100 });
    },
  });

  return el('div.setting', {}, [el('span.label', { text: t(labelKey) }), slider, value]);
}

/**
 * One checkbox per language the sheet lists, each labelled in its own language
 * so it can be found without already reading the one in use.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {() => void} rebuild
 * @returns {HTMLElement[]}
 */
function languageRows(app, rebuild) {
  return languages().map((entry) => {
    const checked = app.settings.language === entry.code;
    const box = el('input.checkbox', {
      type: 'checkbox',
      checked,
      onChange: async (event) => {
        const input = /** @type {HTMLInputElement} */ (event.target);
        // One language is always in use, so the checked box cannot be cleared —
        // another one is ticked to change it.
        if (checked) {
          input.checked = true;
          return;
        }
        app.audio.blip('select');
        await app.updateSettings({ language: entry.code });
        // A language that took re-mounts every scene, this one included, and
        // this rebuild is redundant; one the main process refused leaves the
        // boxes ticked wrongly, and this is what puts them right.
        rebuild();
      },
    });

    // The label wraps the box, so the whole row is the hit target and names the
    // control without a second label of its own.
    return el('label.setting.checkrow', {}, [
      box,
      el('span.checkrow-label', { text: entry.label, lang: entry.code }),
    ]);
  });
}

/**
 * Who drew the art the game borrows.
 *
 * The Pokémon are Pokémon Black and White's own sprites up to Genesect and the
 * Smogon community's past it, which are shared on the condition that they are
 * credited — every artist, by name — and never sold.
 *
 * @returns {HTMLElement[]}
 */
function creditRows() {
  const { sprites, custom, trainers } = gameData().credits ?? {};
  if (!sprites && !custom) return [el('p.meta', { text: t('credits.none') })];
  return [
    ...(sprites
      ? [
          el('div.section-title', { text: t('credits.sprites') }),
          el('p.meta', { text: t('credits.spritesNote', { source: sprites.source, license: sprites.license }) }),
          el('p.meta.credits-url', { text: sprites.url }),
        ]
      : []),
    // Past Genesect the sprites are the Smogon community's, drawn in the same
    // style, and their artists are thanked by name.
    ...(custom
      ? [
          el('div.section-title', { text: t('credits.custom') }),
          el('p.meta', { text: t('credits.customNote', { source: custom.source }) }),
          el('p.meta.credits-url', { text: custom.url }),
          el('p.credits-names', { text: custom.artists.join(', ') }),
        ]
      : []),
    // The leaders and the league's people the games never drew in pixels:
    // one entry for each place their pictures come from, saying whose and
    // for whom.
    ...(Array.isArray(trainers) && trainers.length
      ? [
          el('div.section-title', { text: t('credits.trainers') }),
          ...trainers.flatMap((entry) => [
            el('p.meta', { text: t(`credits.trainers.${entry.key}`, { source: entry.source, license: entry.license, artist: entry.artist ?? '' }) }),
            el('p.meta.credits-url', { text: entry.url }),
          ]),
        ]
      : []),
  ];
}

/**
 * Save the current run and close the app.
 * @param {import('../core/app.mjs').App} app
 */
export async function saveAndQuit(app) {
  const session = app.session;
  if (!session) {
    await appControl.quit();
    return;
  }
  await appControl.quit(session.slot, session.toSave());
}

/**
 * Write the run and go back to the title screen, leaving the program running.
 *
 * The title screen is imported when it is needed rather than at the top of the
 * file: it reaches back here for its own settings button, and a cycle between
 * two modules that each want the other at load time is worth avoiding for the
 * sake of one button.
 *
 * @param {import('../core/app.mjs').App} app
 */
export async function saveAndExit(app) {
  const session = app.session;
  if (session) await session.save();
  app.session = null;

  const [{ titleScene }, slots] = await Promise.all([import('../scenes/title.mjs'), saves.list()]);
  app.setScene(titleScene({ slots }));
}
