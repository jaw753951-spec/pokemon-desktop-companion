/**
 * The capture screen.
 *
 * Laid out like Pokémon GO's: the target in the middle, the balls you actually
 * hold along the bottom with their real odds printed underneath, and the
 * throws you have left counted in the corner. Three throws, then it flees.
 */
import { CAPTURE_ATTEMPTS, FIELD_HEIGHT, FIELD_WIDTH, timeOfDay, VIEW_HEIGHT, VIEW_WIDTH } from '../../shared/constants.mjs';
import { loadSprite } from '../core/assets.mjs';
import { url } from '../core/bridge.mjs';
import { gameData, itemOf, speciesOf } from '../core/data.mjs';
import { button, el, setChildren, shinyMark } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { attemptCapture, captureChance } from '../engine/capture.mjs';
import { abilityName } from '../engine/abilities.mjs';
import { CAUGHT_LEVEL, fullyHeal, resetToLevel } from '../engine/pokemon.mjs';
import { BATTLE_SCALE, Battler, battlerArt, mirrorFor } from '../render/battler.mjs';
import { inFieldSpace } from '../render/field.mjs';
import { prompt } from '../ui/dialog.mjs';

/** How long the ball is in the air, and how high it arcs, in field pixels. */
const THROW_MS = 420;
const THROW_ARC = 26;

/** How long one shake takes, and how far the ball rocks over, in radians. */
const SHAKE_MS = 320;
const SHAKE_TILT = 0.5;

/** How wide the ball is drawn on this screen, in field pixels. */
const BALL_DRAWN = 14;

/** How many buttons fit on one row of the tray at full size. */
const TRAY_ROW = 12;

/**
 * @param {{
 *   session: import('../engine/session.mjs').Session,
 *   target: import('../engine/pokemon.mjs').Pokemon,
 *   onFinish: (result: {caught: boolean, fled: boolean}) => void,
 * }} options
 * @returns {import('../core/app.mjs').Scene}
 */
export function captureScene({ session, target, onFinish }) {
  let attempts = CAPTURE_ATTEMPTS;
  // Whether a Ball Fetch has already brought one back.
  let fetched = false;
  /** The catching berry given for the next throw, if any. @type {string|null} */
  let fed = null;
  let busy = false;
  let settled = false;

  /** @type {Battler|null} */
  let battler = null;

  /**
   * The ball in flight, and then on the ground.
   *
   * The throw is the whole of what a capture screen shows happening: an arc
   * up to the Pokémon, a flash as it goes in, and the ball rocking on the
   * spot once per shake the roll passed. Without it the odds simply changed
   * and a message appeared.
   *
   * @type {{
   *   icon: HTMLImageElement|null,
   *   phase: 'fly'|'shake'|'caught'|'broke',
   *   elapsed: number,
   *   shakes: number,
   *   caught: boolean,
   *   from: {x: number, y: number},
   * }|null}
   */
  let thrown = null;
  /** Where the target stands, filled in once its sprite has been measured. */
  let targetSpot = { x: Math.round(FIELD_WIDTH / 2), y: Math.round(FIELD_HEIGHT * 0.52) };

  /**
   * Put a ball in the air.
   * @param {string} ball
   * @param {number} shakes
   * @param {boolean} caught
   */
  function throwAt(ball, shakes, caught) {
    const icon = new Image();
    icon.src = url('assets', `items/${ball}.png`);
    thrown = {
      icon,
      phase: 'fly',
      elapsed: 0,
      shakes,
      caught,
      from: { x: Math.round(FIELD_WIDTH * 0.2), y: FIELD_HEIGHT - 26 },
    };
  }

  /** @param {number} deltaMs */
  function tickThrow(deltaMs) {
    if (!thrown) return;
    thrown.elapsed += deltaMs;

    if (thrown.phase === 'fly' && thrown.elapsed >= THROW_MS) {
      thrown.phase = 'shake';
      thrown.elapsed = 0;
      // The Pokémon is inside the ball from the moment it lands.
      if (battler) battler.visible = false;
      return;
    }
    if (thrown.phase === 'shake' && thrown.elapsed >= thrown.shakes * SHAKE_MS) {
      thrown.phase = thrown.caught ? 'caught' : 'broke';
      thrown.elapsed = 0;
      // One that broke out is back on its feet.
      if (!thrown.caught && battler) battler.visible = true;
    }
  }

  /** Where the ball is this frame, and how far over it is rocking. */
  function ballAt() {
    if (!thrown) return null;
    const { phase, elapsed } = thrown;
    if (phase === 'fly') {
      const step = Math.min(1, elapsed / THROW_MS);
      return {
        x: thrown.from.x + (targetSpot.x - thrown.from.x) * step,
        // A lobbed arc rather than a straight line: up and over.
        y: thrown.from.y + (targetSpot.y - thrown.from.y) * step - Math.sin(step * Math.PI) * THROW_ARC,
        tilt: step * Math.PI * 2,
      };
    }
    // Rocking on the spot, once per shake, settling between each.
    const turn = (elapsed % SHAKE_MS) / SHAKE_MS;
    const rocking = phase === 'shake' ? Math.sin(turn * Math.PI * 2) * SHAKE_TILT : 0;
    return { x: targetSpot.x, y: targetSpot.y, tilt: rocking };
  }

  const label = () => localized(speciesOf(target.speciesId)?.name, '');
  const counter = el('div.capture-attempts');
  const message = el('div.battle-message', {
    text: target.shiny ? `${t('capture.title')}  ${t('battle.shiny')}` : t('capture.title'),
  });
  const balls = el('div.capture-balls');
  const berries = el('div.capture-balls.capture-berries');
  const tray = el('div.capture-tray', {}, [berries, balls]);

  return {
    keepBelow: true,

    mount(app) {
      // Field coordinates, and the same picture at the same size the fight
      // was drawn in, so the Pokémon being thrown at is the one that was
      // standing there a second ago.
      const y = Math.round(FIELD_HEIGHT * 0.52);
      const art = battlerArt(target);
      if (art) {
        loadSprite(art.path, art.meta).then((sprite) => {
          const scale = BATTLE_SCALE;
          battler = new Battler({
            sprite,
            x: Math.round(FIELD_WIDTH / 2),
            y,
            facing: -1,
            scale,
            flip: mirrorFor(sprite, 'left'),
          });
          // The ball is thrown at the middle of the Pokémon, not at its feet.
          targetSpot = { x: battler.x, y: Math.round(y - (sprite.height * scale) / 2) };
          // A shiny sparkles as it is first seen here, as it did in the fight;
          // the star beside its name keeps saying so once the line has gone.
          if (target.shiny) battler.showShiny(() => app.audio.blip('shiny'));
        });
      }
      app.audio.playCry(target.speciesId);

      renderCounter();
      renderBalls(app);
      renderBerries(app);

      return el('div.screen.capture-screen', {}, [
        counter,
        el('div.capture-name', {}, [label(), shinyMark(target, t('pokemon.shiny'))]),
        tray,
        message,
        el('div.capture-close', {}, [
          button(t('common.cancel'), () => finish(app, false), { className: 'small ghost' }),
        ]),
      ]);
    },

    update(deltaMs) {
      battler?.update(deltaMs);
      tickThrow(deltaMs);
    },

    render(context) {
      context.fillStyle = 'rgba(10, 14, 24, 0.78)';
      context.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
      inFieldSpace(context, (field) => {
        battler?.draw(field);
        drawThrow(field);
      });
    },
  };

  /**
   * The ball, wherever it is in the throw.
   * @param {CanvasRenderingContext2D} context
   */
  function drawThrow(context) {
    const at = ballAt();
    if (!thrown?.icon?.complete || !at) return;

    const width = BALL_DRAWN;
    const height = Math.max(
      1,
      Math.round((width * thrown.icon.naturalHeight) / Math.max(1, thrown.icon.naturalWidth)),
    );

    context.save();
    context.translate(at.x, at.y);
    context.rotate(at.tilt);
    context.drawImage(thrown.icon, -width / 2, -height / 2, width, height);
    context.restore();

    // The flash as it opens, and again as it closes for good.
    if (thrown.phase === 'fly' || thrown.phase === 'caught') {
      const step = thrown.phase === 'fly'
        ? Math.max(0, thrown.elapsed / THROW_MS - 0.85) / 0.15
        : Math.max(0, 1 - thrown.elapsed / 260);
      if (step > 0) {
        context.save();
        context.globalAlpha = Math.min(0.75, step);
        context.fillStyle = '#ffffff';
        context.beginPath();
        context.arc(at.x, at.y, width * (0.6 + step), 0, Math.PI * 2);
        context.fill();
        context.restore();
      }
    }
  }

  /** The throws left, counted in balls — three of them say it without a word. */
  function renderCounter() {
    setChildren(counter, [
      ...Array.from({ length: CAPTURE_ATTEMPTS }, (_, index) =>
        el('img', {
          src: url('assets', 'items/poke-ball.png'),
          alt: '',
          style: { width: '12px', height: '12px', opacity: index < attempts ? '1' : '0.25' },
        }),
      ),
    ]);
  }

  /**
   * What the balls that care about the moment need to know about it.
   *
   * @returns {import('../engine/capture.mjs').CaptureContext}
   */
  function throwContext() {
    return {
      throws: CAPTURE_ATTEMPTS - attempts,
      active: session.active,
      caught: session.caught,
      areaTags: session.area?.tags ?? [],
      time: timeOfDay(),
      berry: fed,
    };
  }

  /**
   * The catching berries in the bag, to give before a throw: one at a time,
   * and gone with the next ball.
   *
   * @param {import('../core/app.mjs').App} app
   */
  function renderBerries(app) {
    const held = Object.keys(session.bag ?? {})
      .filter((slug) => itemOf(slug)?.capture && session.countOf(slug) > 0);
    if (!held.length) {
      berries.replaceChildren();
      fitTray();
      return;
    }
    setChildren(berries, held.map((slug) => el('button.capture-ball', {
      type: 'button',
      disabled: busy || settled || Boolean(fed),
      title: localized(itemOf(slug)?.name, slug),
      onClick: () => feed(app, slug),
    }, [
      el('img', { src: url('assets', `items/${slug}.png`), alt: localized(itemOf(slug)?.name, slug) }),
      el('span.count', { text: t('items.count', { count: session.countOf(slug) }) }),
    ])));
    fitTray();
  }

  /**
   * Smaller buttons once there are more balls than one row of them holds: the
   * tray grows up the screen from the message box, and three rows of
   * full-size buttons reached over the Pokémon being thrown at.
   */
  function fitTray() {
    const rows = [berries, balls].map((row) => row.querySelectorAll('.capture-ball').length);
    tray.classList.toggle('dense', rows.some((count) => count > TRAY_ROW));
  }

  /**
   * Give a catching berry before the next throw.
   *
   * @param {import('../core/app.mjs').App} app
   * @param {string} slug
   */
  function feed(app, slug) {
    if (busy || settled || fed || !session.removeItem(slug)) return;
    fed = slug;
    app.audio.blip('confirm');
    message.textContent = t('capture.fed', { name: label(), item: localized(itemOf(slug)?.name, slug) });
    renderBalls(app);
    renderBerries(app);
  }

  /** @param {import('../core/app.mjs').App} app */
  function renderBalls(app) {
    const held = session.balls();
    if (held.length === 0) {
      balls.replaceChildren(el('span.meta', { text: t('capture.noBalls') }));
      fitTray();
      return;
    }

    setChildren(balls, [
      ...held.map(({ slug, count, item }) => {
        const chance = Math.round(captureChance(target, slug, throwContext()) * 100);
        return el('button.capture-ball', {
          type: 'button',
          disabled: busy,
          title: localized(item.name, slug),
          onClick: () => throwBall(app, slug),
        }, [
          el('img', { src: url('assets', `items/${slug}.png`), alt: localized(item.name, slug) }),
          el('span.count', { text: t('items.count', { count }) }),
          el('span.odds', { text: t('capture.rate', { rate: chance }) }),
        ]);
      }),
    ]);
    fitTray();
  }

  /**
   * @param {import('../core/app.mjs').App} app
   * @param {string} ball
   */
  async function throwBall(app, ball) {
    if (busy || settled || attempts <= 0) return;
    if (!session.removeItem(ball)) return;

    // The context is read before this throw is counted: a Quick Ball's
    // first throw is the one with none before it.
    const context = throwContext();
    busy = true;
    attempts--;
    renderCounter();
    renderBalls(app);
    app.audio.blip('select');

    const result = attemptCapture(session.rng, target, ball, context);
    // The berry is spent on this throw, whatever it comes to.
    fed = null;
    // The ball goes up, the Pokémon goes in, and it rocks once per shake the
    // roll passed. Nothing is said until that has played out.
    throwAt(ball, Math.max(1, result.shakes), result.caught);
    message.textContent = t('capture.thrown');
    await wait(THROW_MS + Math.max(1, result.shakes) * SHAKE_MS + 260);

    if (result.caught) {
      settled = true;
      app.audio.blip('catch');
      app.audio.playJingle(gameData().bgm.cues.caught ?? null);
      message.textContent = t('capture.success', { name: label() });

      const nickname = await prompt(app, t('capture.nickname', { name: label() }), {
        placeholder: t('capture.nicknamePlaceholder'),
        maxLength: 12,
      });
      target.nickname = nickname;
      target.ball = ball;
      // A Friend Ball makes a friend of it straight away.
      if (ball === 'friend-ball') target.friendship = Math.max(target.friendship ?? 0, 150);
      // It was knocked down before the ball was thrown — that is how this
      // game earns the throw — so it arrives patched up rather than at no hit
      // points, which would have made it faint the moment it was swapped in.
      // Whatever level it was met at, it goes into the box at level 5.
      resetToLevel(target, CAUGHT_LEVEL);
      fullyHeal(target);
      const stored = session.storeInBox(target);

      app.toast(stored
        ? t('capture.sentToBox', { name: target.nickname || label() })
        : t('capture.boxFull'));
      // A full box has nowhere to put it. Reporting it as caught anyway threw
      // the Pokémon away along with the ball, so it is handed back instead —
      // the tray keeps it until room is made.
      finish(app, stored);
      return;
    }

    busy = false;
    thrown = null;
    if (battler) battler.visible = true;

    // A Ball Fetch goes and gets the first ball that missed.
    if (!fetched && abilityName(session.active) === 'ball-fetch' && ball !== 'master-ball') {
      fetched = true;
      session.addItem(ball);
      app.toast(t('battle.pickup', { name: (session.active.nickname || localized(speciesOf(session.active.speciesId)?.name, '')), item: localized(gameData().items[ball]?.name, ball) }), 2600);
    }

    if (attempts <= 0) {
      settled = true;
      message.textContent = t('capture.fled', { name: label() });
      app.audio.blip('cancel');
      await wait(1200);
      finish(app, false, true);
      return;
    }

    message.textContent = t('capture.failed');
    renderBalls(app);
    renderBerries(app);
  }

  /**
   * @param {import('../core/app.mjs').App} app
   * @param {boolean} caught
   * @param {boolean} [fled] whether it ran rather than being let go, which is
   *   the difference between losing the chance and keeping it for later
   */
  function finish(app, caught, fled = false) {
    if (!caught) app.audio.blip('cancel');
    onFinish({ caught, fled });
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
