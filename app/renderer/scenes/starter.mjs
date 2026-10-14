/**
 * Starter selection.
 *
 * Three Poké Balls on a table; picking one opens it to reveal the Pokémon,
 * which is how the Gen-4 games stage this moment. The one under the pointer
 * stands above the balls at battle size, and the confirmation is asked along
 * the bottom of the screen — you decide while looking at what you are
 * deciding about, rather than at a box covering it.
 */
import { STARTERS } from '../../shared/constants.mjs';
import { url } from '../core/bridge.mjs';
import { gameData, speciesOf } from '../core/data.mjs';
import { button, el } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { Rng } from '../core/rng.mjs';
import { optimizeMoves } from '../engine/autoplan.mjs';
import { createPokemon } from '../engine/pokemon.mjs';
import { defaultAutoBattle } from '../engine/session.mjs';
import { confirm } from '../ui/dialog.mjs';
import { walkerPortrait } from '../ui/portrait.mjs';
import { startRun } from './field.mjs';

/** The level a starter begins at, as in the main series. */
const STARTER_LEVEL = 5;

/**
 * @param {{slot: number}} options
 * @returns {import('../core/app.mjs').Scene}
 */
export function starterScene({ slot }) {
  return {
    mount(app) {
      const caption = el('p.starter-caption', { text: t('starter.prompt') });
      const stage = el('div.starter-stage');

      const balls = el(
        'div.starter-balls',
        {},
        STARTERS.map((speciesId) => ballButton(app, speciesId, slot, caption, stage)),
      );

      return el('div.screen.starter-screen', {}, [
        stage,
        caption,
        balls,
        el('div.starter-back', {}, [
          button(t('common.back'), () => {
            app.audio.blip('cancel');
            app.pop();
          }, { className: 'small ghost' }),
        ]),
      ]);
    },
  };
}

/**
 * @param {import('../core/app.mjs').App} app
 * @param {number} speciesId
 * @param {number} slot
 * @param {HTMLElement} caption
 * @param {HTMLElement} stage
 */
function ballButton(app, speciesId, slot, caption, stage) {
  const species = speciesOf(speciesId);
  const label = localized(species.name, species.slug);

  const ball = el('img.starter-ball', { src: url('assets', 'items/poke-ball.png'), alt: label });

  let cried = false;
  const reveal = () => {
    stage.replaceChildren(portrait(speciesId, label));
    caption.textContent = label;
    // The cry belongs to opening the ball, not to the pointer passing over it.
    if (!cried) app.audio.playCry(speciesId);
    cried = true;
  };

  return el('button.starter-pick', {
    type: 'button',
    title: label,
    onMouseEnter: reveal,
    onMouseLeave: () => { cried = false; },
    onFocus: reveal,
    onClick: async () => {
      app.audio.blip('confirm');
      reveal();
      // Asked along the bottom, so the Pokémon it is asking about stays in
      // view above the question.
      if (!(await confirm(app, t('starter.confirm', { name: label }), { align: 'bottom' }))) return;
      await begin(app, slot, speciesId);
    },
  }, [ball]);
}

/**
 * The Pokémon as it will walk the road with you, drawn large.
 *
 * The same art, facing and proportions as the field, so the Pokémon picked
 * here is recognisably the one that sets off from the next screen.
 *
 * @param {number} speciesId
 * @param {string} label
 */
function portrait(speciesId, label) {
  return walkerPortrait({ speciesId }, { zoom: STARTER_ZOOM, maxHeight: STARTER_MAX_HEIGHT, label }) ?? el('div.starter-sprite');
}

/** Screen pixels per field pixel on the starter table, and the most it may stand. */
const STARTER_ZOOM = 4;
const STARTER_MAX_HEIGHT = 120;

/**
 * @param {import('../core/app.mjs').App} app
 * @param {number} slot
 * @param {number} speciesId
 */
async function begin(app, slot, speciesId) {
  const species = speciesOf(speciesId);
  const rng = new Rng();
  // Starters are a gift, so they get a guaranteed-decent spread rather than
  // the fully random one a wild Pokémon rolls.
  const starter = createPokemon(rng, speciesId, STARTER_LEVEL, { ivFloor: 12, ball: 'poke-ball' });
  // Its moves start set up as the Optimize button would.
  const autoBattle = defaultAutoBattle();
  optimizeMoves(starter, autoBattle);

  app.toast(t('starter.chosen', { name: localized(species.name, species.slug) }));
  app.audio.playCry(speciesId);

  startRun(app, {
    slot,
    save: newSave(rng, starter, autoBattle),
  });
}

/**
 * The shape of a fresh save.
 * @param {Rng} rng
 * @param {import('../engine/pokemon.mjs').Pokemon} starter
 * @param {any} autoBattle the move settings it starts with
 */
function newSave(rng, starter, autoBattle) {
  const areas = gameData().areas;
  return {
    seed: rng.seed,
    createdAt: Date.now(),
    party: { active: starter, box: [] },
    bag: { 'poke-ball': 5, potion: 3 },
    progress: {
      badges: [],
      champion: false,
      trainerWins: 0,
      playtime: 0,
      areaId: areas[0]?.id ?? null,
      machines: [],
    },
    dex: { seen: [starter.speciesId], caught: [starter.speciesId], champions: [] },
    autoBattle,
  };
}
