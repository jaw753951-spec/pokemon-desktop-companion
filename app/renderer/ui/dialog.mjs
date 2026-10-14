/**
 * Modal prompts: the yes/no confirmations and small pickers the game leans on.
 *
 * Each returns a promise that settles when the user chooses, so callers can
 * `await` them inline rather than threading callbacks through the UI.
 */
import { button, el, scrollable } from '../core/dom.mjs';
import { t } from '../core/i18n.mjs';

/**
 * @param {import('../core/app.mjs').App} app
 * @param {string} message
 * @param {{confirmLabel?: string, cancelLabel?: string, danger?: boolean, align?: 'center'|'bottom'}} [options]
 * @returns {Promise<boolean>}
 */
export function confirm(app, message, options = {}) {
  return new Promise((resolve) => {
    const close = mountModal(app, (dismiss) =>
      el('div.panel', {}, [
        el('p', { text: message }),
        el('div.actions', {}, [
          button(options.confirmLabel ?? t('common.yes'), () => {
            app.audio.blip('confirm');
            dismiss();
            resolve(true);
          }, { className: options.danger ? 'primary' : '' }),
          button(options.cancelLabel ?? t('common.no'), () => {
            app.audio.blip('cancel');
            dismiss();
            resolve(false);
          }),
        ]),
      ]),
      { align: options.align },
    );
    void close;
  });
}

/**
 * A short list of labelled actions, as used by the box and item screens.
 *
 * @template T
 * @param {import('../core/app.mjs').App} app
 * @param {string} title
 * @param {Array<{value: T, label: string, danger?: boolean}>} choices
 * @returns {Promise<T|null>} null when dismissed
 */
export function chooseAction(app, title, choices) {
  return new Promise((resolve) => {
    mountModal(app, (dismiss) =>
      el('div.panel', {}, [
        title ? el('p', { text: title }) : null,
        el(
          'div.actions',
          { style: { flexWrap: 'wrap' } },
          choices.map((choice) =>
            button(choice.label, () => {
              app.audio.blip(choice.danger ? 'cancel' : 'confirm');
              dismiss();
              resolve(choice.value);
            }, { className: choice.danger ? 'ghost' : '' }),
          ),
        ),
        button(t('common.cancel'), () => {
          app.audio.blip('cancel');
          dismiss();
          resolve(null);
        }, { className: 'small' }),
      ]),
    );
  });
}

/**
 * A single line of text, for naming a caught Pokémon.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {string} title
 * @param {{placeholder?: string, initial?: string, maxLength?: number}} [options]
 * @returns {Promise<string|null>} null when skipped
 */
export function prompt(app, title, options = {}) {
  return new Promise((resolve) => {
    /** @type {HTMLInputElement} */
    const input = /** @type {any} */ (
      el('input', {
        type: 'text',
        value: options.initial ?? '',
        placeholder: options.placeholder ?? '',
        maxlength: options.maxLength ?? 12,
        style: {
          '-webkit-app-region': 'no-drag',
          font: 'inherit',
          fontSize: '12px',
          padding: '3px 6px',
          border: '2px solid var(--frame)',
          borderRadius: '4px',
          textAlign: 'center',
        },
      })
    );

    const dismiss = mountModal(app, (close) => {
      const accept = () => {
        app.audio.blip('confirm');
        close();
        resolve(input.value.trim() || null);
      };
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') accept();
      });
      return el('div.panel', {}, [
        el('p', { text: title }),
        input,
        el('div.actions', {}, [
          button(t('common.ok'), accept, { className: 'primary' }),
          button(t('common.no'), () => {
            app.audio.blip('cancel');
            close();
            resolve(null);
          }),
        ]),
      ]);
    });
    void dismiss;
    setTimeout(() => input.focus(), 0);
  });
}

/**
 * A scrollable list picker.
 *
 * @template T
 * @param {import('../core/app.mjs').App} app
 * @param {string} title
 * @param {Array<{value: T, label: string, detail?: string, fresh?: boolean, disabled?: boolean}>} entries
 *   `fresh` marks one with the red new-thing dot; `disabled` shows one greyed
 *   out and not to be chosen
 * @param {{empty?: string}} [options] what to say when there is nothing to choose
 * @returns {Promise<T|null>}
 */
export function chooseFromList(app, title, entries, options = {}) {
  return new Promise((resolve) => {
    mountModal(app, (dismiss) => {
      const list = scrollable(
        el(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '3px', maxHeight: '150px' } },
          entries.length
            ? entries.map((entry) =>
                el(
                  'button.slot',
                  {
                    type: 'button',
                    disabled: entry.disabled ?? false,
                    style: { padding: '3px 6px' },
                    onClick: () => {
                      if (entry.disabled) return;
                      app.audio.blip('confirm');
                      dismiss();
                      resolve(entry.value);
                    },
                  },
                  [
                    el('span.lines', {}, [
                      el('span.headline', {}, [entry.label, entry.fresh ? el('i.new-dot.inline', { 'aria-hidden': 'true' }) : null]),
                      entry.detail ? el('span.meta', { text: entry.detail }) : null,
                    ]),
                  ],
                ),
              ).concat(entries.some((entry) => !entry.disabled)
                ? []
                : [el('p.meta', { text: options.empty ?? t('pokemon.noReplacement') })])
            : [el('p.meta', { text: options.empty ?? t('pokemon.noReplacement') })],
        ),
      );

      return el('div.panel', { style: { width: '280px' } }, [
        el('p', { text: title }),
        list,
        button(t('common.cancel'), () => {
          app.audio.blip('cancel');
          dismiss();
          resolve(null);
        }, { className: 'small' }),
      ]);
    });
  });
}

/**
 * Pick an item out of many, seeing what each one is before choosing it.
 *
 * The one-line list the other pickers use shows four entries at a time and
 * nothing about any of them but a name, which is no way to choose between
 * twenty berries. This lays them out as a grid of icons with their names and
 * counts, and the one under the pointer — or the last one clicked — is shown
 * large beside the grid with its description, and a button to take it.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {string} title
 * @param {Array<{value: string, label: string, icon: string, count: number, text?: string}>} entries
 * @param {{current?: string|null, clearLabel?: string, confirmLabel?: string, empty?: string}} [options]
 *   `clearLabel` offers a way to choose nothing, which resolves to ''
 * @returns {Promise<string|null>} the value chosen, '' for nothing, null if cancelled
 */
export function chooseItem(app, title, entries, options = {}) {
  return new Promise((resolve) => {
    mountModal(app, (dismiss) => {
      const finish = (value) => {
        dismiss();
        resolve(value);
      };

      const detail = el('div.item-picker-detail');
      /** @param {typeof entries[number]|null} entry */
      const show = (entry) => {
        if (!entry) {
          detail.replaceChildren(el('span.meta', { text: options.empty ?? t('pokemon.noReplacement') }));
          return;
        }
        detail.replaceChildren(
          el('img.item-picker-icon', { src: entry.icon, alt: '', onError: hideBroken }),
          el('span.item-picker-name', { text: entry.label }),
          el('span.meta', { text: t('items.count', { count: entry.count }) }),
          el('p.item-picker-text', { text: entry.text ?? '' }),
          button(options.confirmLabel ?? t('common.ok'), () => {
            app.audio.blip('confirm');
            finish(entry.value);
          }, { className: 'small' }),
        );
      };

      const grid = scrollable(el('div.item-picker-grid', {}, entries.map((entry) =>
        el(`button.item-picker-tile${entry.value === options.current ? '.current' : ''}`, {
          type: 'button',
          title: entry.label,
          onMouseEnter: () => show(entry),
          onFocus: () => show(entry),
          onClick: () => {
            app.audio.blip('select');
            show(entry);
          },
          // A second click on the one already shown takes it.
          onDblclick: () => {
            app.audio.blip('confirm');
            finish(entry.value);
          },
        }, [
          el('img', { src: entry.icon, alt: '', onError: hideBroken }),
          el('span.item-picker-lines', {}, [
            el('span.item-picker-label', { text: entry.label }),
            el('span.item-picker-count', { text: t('items.count', { count: entry.count }) }),
          ]),
        ]),
      )));

      show(entries.find((entry) => entry.value === options.current) ?? entries[0] ?? null);

      return el('div.panel.item-picker', {}, [
        el('p', { text: title }),
        el('div.item-picker-body', {}, [grid, detail]),
        el('div.item-picker-actions', {}, [
          options.clearLabel
            ? button(options.clearLabel, () => {
                app.audio.blip('select');
                finish('');
              }, { className: 'small ghost' })
            : null,
          el('span.spacer'),
          button(t('common.cancel'), () => {
            app.audio.blip('cancel');
            finish(null);
          }, { className: 'small' }),
        ]),
      ]);
    });
  });
}

/**
 * An item the data has no picture for is shown by its name alone, rather than
 * as a broken-image box.
 *
 * @param {Event} event
 */
const hideBroken = (event) => {
  /** @type {HTMLElement} */ (event.target).style.visibility = 'hidden';
};

/**
 * A card that says what something is, with an optional button under it.
 *
 * The bag and the Pokémon screen both had text stacked into a row that had no
 * room for it — an ability's whole description under its name, a held item
 * with nothing to say about itself. Asking for it opens this instead.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {{title: string, subtitle?: string|null, body?: string|null, extra?: HTMLElement|null,
 *   action?: {label: string, danger?: boolean}|null}} content
 * @returns {Promise<boolean>} whether the action was taken
 */
export function describe(app, content) {
  return new Promise((resolve) => {
    mountModal(app, (dismiss) =>
      el('div.panel.describe', {}, [
        el('span.describe-title', { text: content.title }),
        content.subtitle ? el('span.meta', { text: content.subtitle }) : null,
        content.body ? el('p.describe-body', { text: content.body }) : null,
        content.extra ?? null,
        el('div.actions', {}, [
          content.action
            ? button(content.action.label, () => {
                app.audio.blip(content.action?.danger ? 'cancel' : 'confirm');
                dismiss();
                resolve(true);
              }, { className: content.action.danger ? 'ghost' : 'primary' })
            : null,
          button(t('common.close'), () => {
            app.audio.blip('cancel');
            dismiss();
            resolve(false);
          }, { className: 'small' }),
        ]),
      ]),
    );
  });
}

/**
 * Mount a modal layer and hand the builder a function that removes it.
 * @param {import('../core/app.mjs').App} app
 * @param {(dismiss: () => void) => HTMLElement} build
 * @returns {() => void}
 */
export function mountModal(app, build, options = {}) {
  // A modal normally sits in the middle of the screen, over whatever asked the
  // question. `bottom` moves it out of the way for a screen whose question is
  // about something the player has to be able to see while answering.
  const layer = el(`div.modal${options.align === 'bottom' ? '.bottom' : ''}`);
  const dismiss = () => layer.remove();
  layer.append(build(dismiss));
  app.overlay.append(layer);
  return dismiss;
}
