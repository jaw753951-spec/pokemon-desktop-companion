/**
 * The evolution screen.
 *
 * As the games play it: the Pokémon on a dark screen, "What? … is evolving!",
 * a glow that turns it white, then its own shape and the one it is becoming
 * flashing in turn, faster and faster, until a flash leaves the new one
 * standing there in colour. A press while it flashes asks whether to stop it,
 * the B button's place here — for a levelling evolution only, as in the
 * games: one an item was used for goes ahead.
 *
 * The companion is left alone for hours at a time, so nothing waits on the
 * player: every line moves on by itself, and a press only hurries it.
 */
import { FIELD_HEIGHT, FIELD_WIDTH, VIEW_HEIGHT, VIEW_WIDTH } from '../../shared/constants.mjs';
import { loadSprite } from '../core/assets.mjs';
import { gameData } from '../core/data.mjs';
import { el } from '../core/dom.mjs';
import { t } from '../core/i18n.mjs';
import { completeEvolution } from '../engine/items.mjs';
import { evolveInto, nameOf, stopEvolution } from '../engine/pokemon.mjs';
import { BATTLE_SCALE, Battler, battlerArt, mirrorFor } from '../render/battler.mjs';
import { inFieldSpace } from '../render/field.mjs';
import { confirm } from '../ui/dialog.mjs';

/** How long "What? … is evolving!" stands before the flashing, the last part of it glowing white. */
const INTRO_MS = 1800;
const GLOW_MS = 700;

/** How long the two shapes flash in turn. */
const MORPH_MS = 5400;

/** The flash the new shape comes out of. */
const REVEAL_MS = 700;

/** How long each line stands before the next, unless pressed on. */
const LINE_MS = 2200;

/** How long the white fades off a Pokémon stopped mid-flash. */
const SETTLE_MS = 400;

/**
 * Whether the flashing is on the new shape at this point in it. Each shape
 * holds for a little less time than the last: two-thirds of a second at
 * first, a sixteenth at the end.
 *
 * @param {number} elapsedMs
 */
export function morphShowsNew(elapsedMs) {
  let at = 0;
  let hold = MORPH_FIRST_HOLD_MS;
  let showingNew = false;
  while (at + hold <= elapsedMs) {
    at += hold;
    showingNew = !showingNew;
    hold = Math.max(MORPH_LAST_HOLD_MS, hold * MORPH_SPEED_UP);
  }
  return showingNew;
}

const MORPH_FIRST_HOLD_MS = 640;
const MORPH_LAST_HOLD_MS = 60;
const MORPH_SPEED_UP = 0.8;

/**
 * @param {{
 *   session: import('../engine/session.mjs').Session,
 *   pokemon: import('../engine/pokemon.mjs').Pokemon,
 *   to: number,
 *   stoppable: boolean,
 *   lead?: string[],
 *   onFinish: (result: {evolved: boolean}) => void,
 * }} options `lead` is said before it begins — a Rare Candy's level, say
 * @returns {import('../core/app.mjs').Scene}
 */
export function evolutionScene({ session, pokemon, to, stoppable, lead = [], onFinish }) {
  /** @typedef {'lead'|'intro'|'morph'|'reveal'|'lines'|'stopped'|'done'} Phase */
  /** @type {Phase} */
  let phase = lead.length ? 'lead' : 'intro';
  let elapsed = 0;
  /** Held while the stop question is open: nothing moves under it. */
  let paused = false;
  /** @type {string[]} */
  let lines = [...lead];
  let line = 0;
  /** The music to go back to once the evolution's own has played. */
  let before = /** @type {string|null} */ (null);
  let evolved = false;

  /** @type {Battler|null} */
  let from = null;
  /** The shape it is becoming, for the flashing; then the Pokémon as it now is. @type {Battler|null} */
  let into = null;

  const fromName = nameOf(pokemon);
  const message = el('div.battle-message');

  /**
   * A battler for some art, stood where this screen keeps it.
   *
   * @param {{speciesId: number, shiny?: boolean, forme?: string|null, gender?: string|null}} shape
   * @returns {Promise<Battler|null>}
   */
  async function standing(shape) {
    const art = battlerArt(shape);
    if (!art) return null;
    const sprite = await loadSprite(art.path, art.meta);
    return new Battler({
      sprite,
      x: Math.round(FIELD_WIDTH / 2),
      y: Math.round(FIELD_HEIGHT * 0.66),
      facing: -1,
      scale: BATTLE_SCALE,
      flip: mirrorFor(sprite, 'left'),
    });
  }

  /** @param {string} text */
  function say(text) {
    message.textContent = text;
  }

  /** @param {Phase} next */
  function enter(next) {
    phase = next;
    elapsed = 0;
  }

  /** @param {import('../core/app.mjs').App} app */
  function begin(app) {
    enter('intro');
    say(t('evolution.start', { name: fromName }));
    app.audio.playCry(pokemon.speciesId);
    before = app.audio.wanted ?? null;
    void app.audio.playMusic(gameData().bgm?.cues?.evolution ?? null);
  }

  /** @param {import('../core/app.mjs').App} app */
  function evolve(app) {
    lines = completeEvolution(session, pokemon, to);
    evolved = true;
    line = 0;
    enter('reveal');
    // The fanfare first, so the music asked for after it waits for it to end.
    void app.audio.playJingle(gameData().bgm?.cues?.evolved ?? null);
    void app.audio.playMusic(before);
    app.audio.playCry(pokemon.speciesId);
    // An Alcremie's look is rolled as it evolves, so the picture is the one
    // it came out with rather than the shape it flashed in.
    void standing(pokemon).then((battler) => {
      if (battler) into = battler;
    });
  }

  /** @param {import('../core/app.mjs').App} app */
  function stop(app) {
    stopEvolution(pokemon);
    enter('stopped');
    say(t('evolution.stopped', { name: fromName }));
    void app.audio.playMusic(before);
  }

  /** @param {import('../core/app.mjs').App} app */
  function nextLine(app) {
    line++;
    elapsed = 0;
    if (phase === 'lead' && line >= lines.length) {
      begin(app);
      return;
    }
    if (line >= lines.length) {
      finish();
      return;
    }
    say(lines[line]);
  }

  function finish() {
    if (phase === 'done') return;
    enter('done');
    onFinish({ evolved });
  }

  /** @param {import('../core/app.mjs').App} app */
  async function press(app) {
    if (paused) return;
    if (phase === 'lead' || phase === 'lines') {
      app.audio.blip('select');
      nextLine(app);
      return;
    }
    if (phase === 'stopped') {
      finish();
      return;
    }
    if (!stoppable || (phase !== 'intro' && phase !== 'morph')) return;
    paused = true;
    app.audio.blip('select');
    const stopIt = await confirm(app, t('evolution.stopAsk', { name: fromName }), {
      confirmLabel: t('evolution.stop'),
      cancelLabel: t('evolution.keep'),
      danger: true,
    });
    paused = false;
    // The question may outlast the flashing it was asked over; an evolution
    // already through is not undone.
    if (stopIt && (phase === 'intro' || phase === 'morph')) stop(app);
  }

  return {
    mount(app) {
      void standing(pokemon).then((battler) => {
        from = battler;
      });
      // The shape it is becoming, for its silhouette. A copy is evolved for
      // it, with the first look of an Alcremie's: the colours do not show.
      const becoming = structuredClone(pokemon);
      evolveInto(becoming, to, { pick: (list) => list[0] });
      void standing(becoming).then((battler) => {
        if (phase !== 'reveal' && phase !== 'lines') into = battler;
      });

      if (phase === 'lead') say(lines[0]);
      else begin(app);

      return el('div.screen.evolution-screen', { onClick: () => void press(app) }, [message]);
    },

    update(deltaMs, app) {
      if (paused || phase === 'done') return;
      elapsed += deltaMs;
      from?.update(deltaMs);
      into?.update(deltaMs);

      if ((phase === 'lead' || phase === 'lines') && elapsed >= LINE_MS) nextLine(app);
      else if (phase === 'intro' && elapsed >= INTRO_MS) enter('morph');
      else if (phase === 'morph' && elapsed >= MORPH_MS) evolve(app);
      else if (phase === 'reveal' && elapsed >= REVEAL_MS) {
        enter('lines');
        say(lines[0]);
      } else if (phase === 'stopped' && elapsed >= LINE_MS) finish();
    },

    render(context) {
      const sky = context.createLinearGradient(0, 0, 0, VIEW_HEIGHT);
      sky.addColorStop(0, '#202a4a');
      sky.addColorStop(1, '#0a0e1a');
      context.fillStyle = sky;
      context.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);

      inFieldSpace(context, (field) => {
        if (phase === 'lead') {
          from?.draw(field);
        } else if (phase === 'intro') {
          from?.draw(field);
          from?.drawTint(field, '#ffffff', Math.max(0, (elapsed - (INTRO_MS - GLOW_MS)) / GLOW_MS));
        } else if (phase === 'morph') {
          (morphShowsNew(elapsed) ? into ?? from : from)?.drawTint(field, '#ffffff', 1);
        } else if (evolved) {
          const fade = phase === 'reveal' ? 1 - elapsed / REVEAL_MS : 0;
          into?.draw(field);
          if (fade > 0) into?.drawTint(field, '#ffffff', fade);
        } else {
          from?.draw(field);
          const fade = phase === 'stopped' ? 1 - elapsed / SETTLE_MS : 0;
          if (fade > 0) from?.drawTint(field, '#ffffff', fade);
        }
      });

      // The flash the new shape stands in.
      if (phase === 'reveal') {
        context.save();
        context.globalAlpha = Math.max(0, 1 - elapsed / REVEAL_MS) * 0.85;
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
        context.restore();
      }
    },
  };
}
