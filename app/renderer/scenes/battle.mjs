/**
 * The battle scene.
 *
 * Battles are fought by the engine in whole turns; this scene plays the log it
 * produces back one entry at a time, so the fight reads at a watchable pace
 * even though it was decided instantly.
 */
import { FIELD_HEIGHT, FIELD_WIDTH, FOE_PLATFORM_DROP, timeOfDay, VIEW_HEIGHT, VIEW_WIDTH } from '../../shared/constants.mjs';
import { environmentType, weatherForArea } from '../../shared/area-tags.mjs';
import { loadImage, loadSprite } from '../core/assets.mjs';
import { url } from '../core/bridge.mjs';
import { abilityOf, gameData, moveOf, speciesOf, spriteKey } from '../core/data.mjs';
import { button, el, setChildren, shinyMark, statusMark } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { chooseFromList } from '../ui/dialog.mjs';
import { evolutionScene } from './evolution.mjs';
import { Battle } from '../engine/battle.mjs';
import { battleMedicine, healingItemFor, pickFind, restoreHeldItem, throwItem } from '../engine/items.mjs';
import {
  friendshipForLevels,
  gainFriendship,
  noteLearnedMoves,
  levelOf,
  maxHp,
  maxPp,
  offeredEvolution,
  setMove,
} from '../engine/pokemon.mjs';
import { settleForme } from '../engine/forms.mjs';
import { abilityName, afterBattle } from '../engine/abilities.mjs';

/** How often a Pickup finds something after a win, as Emerald's one in ten does. */
const PICKUP_CHANCE = 0.1;
import { BATTLE_SCALE, Battler, battlerArt, EMERGE_MS, mirrorFor, SHINY_MS } from '../render/battler.mjs';
import { drawBackdrop, loadBackdrop } from '../render/backdrop.mjs';
import { alreadyOwned } from '../engine/shop.mjs';
import { inFieldSpace } from '../render/field.mjs';
import { drawWeather } from '../render/weather.mjs';

/**
 * How long each log entry holds the screen.
 *
 * A click on the battle halves the wait for the entry currently on screen —
 * the cadence is a watchable default, not a rule — so these are the full-pace
 * numbers and `advance` does the halving.
 */
const BEAT_MS = { default: 620, intro: 1000, move: 520, damage: 680, stat: 700, status: 820, faint: 900, end: 1100, go: 1050 };

/**
 * A Pokémon sent out of its ball: how long the ball is in the air, how high it
 * arcs, how big it is drawn, and how long the light it opens in lasts. All in
 * field pixels and milliseconds.
 */
const TOSS_MS = 520;
const TOSS_ARC = 34;
const TOSS_BALL_SIZE = 12;
const BURST_MS = 260;

/** How much of a beat a click skips, as a share of the full wait. */
const CLICK_SPEEDUP = 0.5;

/**
 * The way into a battle, in milliseconds.
 *
 * The games never cut from the road to the fight: the screen flashes, goes
 * dark, and opens on the battle. A cut is the one thing that reads as a
 * mistake rather than as a transition, and this is a game whose battles
 * arrive on their own while the player is looking at something else — so the
 * moment it happens has to announce itself.
 *
 * Three phases: the road flashing white, the dark closing over it, and the
 * dark opening on the battle.
 */
const ENTRY_MS = 780;
const ENTRY_FLASHES = 3;
/** Where the flashing ends and the dark begins, as a share of the whole. */
const ENTRY_SHUT = 0.42;
/** Where the dark is complete and starts opening again. */
const ENTRY_OPEN = 0.62;

/**
 * The lines a condition reads, for the conditions that have one of their own.
 *
 * Only a burn and a poison bite at the end of a turn, and only sleep, freeze
 * and paralysis keep a Pokémon from moving — so those are the ones with
 * wording in the games. Anything else falls back to a plain line rather than
 * inventing a sentence the cartridge never says.
 */
const STATUS_HURT = { brn: 'status.brn.hurt', psn: 'status.psn.hurt' };
const STATUS_BLOCKED = { slp: 'status.slp.blocked', frz: 'status.frz.blocked', par: 'status.par.blocked' };

/**
 * How fast a health bar moves: the time a *whole* bar takes to drain, and the
 * least time any change takes.
 *
 * The games drain at a constant rate, so a scratch is over in a moment and a
 * heavy hit takes a visible while — which is how a player reads how much it
 * cost without looking at the number. A fixed duration for every change, which
 * is what a CSS transition gives, makes the two look the same and the bar look
 * as though it is guessing.
 */
const DRAIN_FULL_MS = 1100;
const DRAIN_MIN_MS = 110;

/**
 * The message box's top edge, in field pixels: it is 34 tall and sits 8 from
 * the bottom of the window, which is half that in the field's own space.
 */
const MESSAGE_TOP = FIELD_HEIGHT - 21;

/**
 * Where the two combatants stand: on the two platforms the backdrop draws, the
 * foe on the far one and the companion on the near one.
 *
 * Field coordinates, because the battlers are drawn in the same doubled space
 * as the backdrop behind them, and the backdrop is composed at exactly that
 * size — so these are the platforms' own pixels rather than a guess. The far
 * platform stands {@link FOE_PLATFORM_DROP} lower than the cartridge draws it,
 * for the height a Black and White sprite needs.
 *
 * Nothing is shrunk to fit: every battler is its sprite at its own size, and
 * the few tall enough to reach the top of the window, or the foe's name
 * plate, are cut off there.
 */
const FOE_SPOT = { x: Math.round(FIELD_WIDTH * 0.73), y: Math.round(FIELD_HEIGHT * 0.55) + FOE_PLATFORM_DROP };

/**
 * A gym leader stands on their side of the field while their challenge is
 * read out, as the cartridges show the trainer before the first Pokémon: this
 * much longer than the line would otherwise stay up, and then they step off
 * to the right, the way they came, as their first ball is thrown.
 */
const LEADER_HOLD_MS = 700;
const LEADER_EXIT_MS = 360;
const PLAYER_SPOT = { x: Math.round(FIELD_WIDTH * 0.26), y: MESSAGE_TOP - 3 };

/**
 * @param {{
 *   session: import('../engine/session.mjs').Session,
 *   foes: import('../engine/pokemon.mjs').Pokemon[],
 *   trainer?: {name: {ko: string, en: string}, portrait?: string|null, kind?: string}|null,
 *   leader?: boolean,
 *   boss?: boolean,
 *   backdrop?: string|null,
 *   music?: string|null,
 *   weather?: string|null,
 *   onFinish: (result: {outcome: 'won'|'lost'|'fled', defeated: import('../engine/pokemon.mjs').Pokemon[]}) => void,
 * }} options
 * @returns {import('../core/app.mjs').Scene}
 */
export function battleScene({ session, foes, trainer = null, leader = false, boss = leader, backdrop = null, music = null, weather = undefined, onFinish }) {
  const battle = new Battle({
    rng: session.rng,
    player: session.active,
    foes,
    policy: session.autoBattle,
    // The bag, reduced to the three things a battle asks of it.
    items: {
      choose: (pokemon) => autoHeal(session, pokemon),
      throw: (slug, pokemon, choice) => throwItem(session, slug, pokemon, choice),
    },
    trainerBattle: Boolean(trainer),
    firstRun: session.firstRun,
    // A gym leader or a League round.
    bossBattle: boss,
    // The sky the place is under, unless the caller names one of its own.
    weather: weather === undefined ? weatherForArea(session.area) : weather,
    // And the ground, for a Camouflage.
    environment: environmentType(session.area?.tags ?? []),
  });

  /** @type {import('../engine/battle.mjs').LogEntry[]} */
  let queue = [];
  let beat = 0;
  let finished = false;
  /** How far into the way in, in milliseconds; past `ENTRY_MS` it is over. */
  let entering = 0;
  /** The battle's own controls, hidden until the screen has opened on them. */
  let screenRoot = /** @type {HTMLElement|null} */ (null);
  /** @type {import('../engine/pokemon.mjs').Pokemon[]} */
  const defeated = [];
  /** The level the companion came in at, for the friendship levelling earns. */
  const startLevel = levelOf(session.active);
  /** What the companion went in holding, which a battle may use up. */
  const startItem = session.active.heldItem;

  /** @type {HTMLImageElement|null} */
  let backdropImage = null;
  /** @type {Battler|null} */
  let playerBattler = null;
  /** @type {Battler|null} */
  let foeBattler = null;
  let loadedFoeId = '';
  /**
   * A sparkle asked for before the battler it is for had loaded its art,
   * started as soon as it has.
   */
  const shinyPending = { player: /** @type {(() => void)|null} */ (null), foe: /** @type {(() => void)|null} */ (null) };
  /** The sprite key the player's battler was drawn from, so a changed shape reloads it. */
  let loadedPlayerId = '';
  /**
   * What the companion looks like: itself, or what a Transform or an
   * Imposter made it, which a trainer's next Pokémon coming out must not undo.
   * @type {import('../engine/pokemon.mjs').Pokemon|null}
   */
  let playerLook = null;

  /**
   * Whether each side's Pokémon has come out of its ball yet. A battler that
   * finishes loading before its ball lands stays hidden until it does. A wild
   * Pokémon was never in one: it is standing there from the start.
   */
  const sentOut = { player: false, foe: !trainer };

  /**
   * The gym leader's own picture, standing where their Pokémon will (see
   * `LEADER_HOLD_MS`): how long ago they started to leave, or -1 while they
   * are still there, and whether the line has yet to send them off.
   */
  const leaderFigure = { image: /** @type {HTMLImageElement|null} */ (null), leaving: -1, pending: false };
  const leaderArt = leader && trainer?.portrait && gameData().actors?.portraits?.[trainer.portrait] ? trainer.portrait : null;
  if (leaderArt) loadImage(`trainers/portraits/${leaderArt}.png`).then((image) => { leaderFigure.image = image; }).catch(() => {});
  /**
   * Balls in the air, and the light each opens in once it lands.
   * @type {Array<{side: 'player'|'foe', pokemon: any, image: HTMLImageElement|null,
   *   from: {x: number, y: number}, to: {x: number, y: number}, elapsed: number, landed: boolean}>}
   */
  let tosses = [];

  /**
   * Throw a side's Pokémon out in the ball it lives in — the one it was caught
   * in, for anything the player caught, and a Poké Ball for everything else.
   *
   * @param {'player'|'foe'} side
   * @param {import('../engine/pokemon.mjs').Pokemon|null} pokemon
   */
  const toss = (side, pokemon) => {
    const ball = pokemon?.ball && gameData().items[pokemon.ball] ? pokemon.ball : 'poke-ball';
    const spot = side === 'player' ? PLAYER_SPOT : FOE_SPOT;
    const entry = {
      side,
      pokemon,
      image: /** @type {HTMLImageElement|null} */ (null),
      // The companion's trainer stands off the bottom left; a foe's off the top right.
      from: side === 'player' ? { x: -8, y: spot.y - 44 } : { x: FIELD_WIDTH + 8, y: spot.y - 52 },
      to: { x: spot.x, y: spot.y - 8 },
      elapsed: 0,
      landed: false,
    };
    loadImage(`items/${ball}.png`).then((image) => { entry.image = image; }).catch(() => {});
    sentOut[side] = false;
    // The ball leaves the belt as it is thrown, not when the engine says so.
    if (side === 'foe') {
      foeOut = pokemon;
      updateFoeBalls();
    }
    const battler = side === 'player' ? playerBattler : foeBattler;
    if (battler) battler.visible = false;
    tosses.push(entry);
  };

  /**
   * Start a shiny's sparkle on one side, now or as soon as its art is in, with
   * the chime on the first star.
   *
   * @param {'player'|'foe'} side
   * @param {import('../core/app.mjs').App} app
   */
  const sparkle = (side, app) => {
    const chime = () => app.audio.blip('shiny');
    const battler = side === 'player' ? playerBattler : foeBattler;
    if (battler) battler.showShiny(chime);
    else shinyPending[side] = chime;
  };

  /**
   * How much longer than its usual beat a line has to hold for a shiny coming
   * out of a ball, the way the cartridge holds the battle until its sparkle is
   * over. Nothing for anything else.
   *
   * @param {{shiny?: boolean}|null|undefined} pokemon
   * @param {number} beat the line's usual length
   */
  const holdForShiny = (pokemon, beat) => (pokemon?.shiny ? Math.max(beat, TOSS_MS + EMERGE_MS + SHINY_MS) : beat);

  /**
   * @param {number} deltaMs
   * @param {import('../core/app.mjs').App} app
   */
  const updateTosses = (deltaMs, app) => {
    for (const entry of tosses) {
      entry.elapsed += deltaMs;
      if (entry.landed || entry.elapsed < TOSS_MS) continue;
      // The ball opens: the Pokémon comes out in a flash of light, and calls.
      entry.landed = true;
      sentOut[entry.side] = true;
      const battler = entry.side === 'player' ? playerBattler : foeBattler;
      if (battler) {
        battler.visible = true;
        battler.setPose('emerge');
      }
      // A shiny sparkles once it is out of its ball, as it does in the games.
      if (entry.pokemon?.shiny) sparkle(entry.side, app);
      app.audio.blip('confirm');
      if (entry.pokemon && entry.side === 'player') app.audio.playCry(entry.pokemon.speciesId);
    }
    tosses = tosses.filter((entry) => entry.elapsed < TOSS_MS + BURST_MS);
  };

  /**
   * The gym leader on the far platform, feet where their Pokémon's will be,
   * until they have stepped off the right of the screen.
   *
   * @param {CanvasRenderingContext2D} context field space
   */
  const drawLeader = (context) => {
    const image = leaderFigure.image;
    if (!image || leaderFigure.leaving >= LEADER_EXIT_MS) return;
    const progress = leaderFigure.leaving < 0 ? 0 : leaderFigure.leaving / LEADER_EXIT_MS;
    const left = Math.round(FOE_SPOT.x - image.width / 2 + progress * progress * (FIELD_WIDTH - FOE_SPOT.x + image.width));
    context.drawImage(image, left, Math.round(FOE_SPOT.y - image.height));
  };

  /** @param {CanvasRenderingContext2D} context field space */
  const drawTosses = (context) => {
    for (const entry of tosses) {
      if (!entry.landed) {
        const progress = Math.min(1, entry.elapsed / TOSS_MS);
        const x = entry.from.x + (entry.to.x - entry.from.x) * progress;
        const y = entry.from.y + (entry.to.y - entry.from.y) * progress - Math.sin(progress * Math.PI) * TOSS_ARC;
        if (!entry.image) continue;
        context.save();
        context.translate(Math.round(x), Math.round(y));
        // Spinning as it flies, the way a thrown ball does.
        context.rotate(progress * Math.PI * 3 * (entry.side === 'player' ? 1 : -1));
        const scale = TOSS_BALL_SIZE / Math.max(entry.image.naturalWidth, entry.image.naturalHeight);
        const width = entry.image.naturalWidth * scale;
        const height = entry.image.naturalHeight * scale;
        context.drawImage(entry.image, -width / 2, -height / 2, width, height);
        context.restore();
        continue;
      }
      // The burst it opens in: a ring of light, widening and fading.
      const burst = Math.min(1, (entry.elapsed - TOSS_MS) / BURST_MS);
      context.save();
      context.globalAlpha = (1 - burst) * 0.85;
      context.fillStyle = '#ffffff';
      context.beginPath();
      context.arc(entry.to.x, entry.to.y, 4 + burst * 18, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }
  };
  /**
   * The foe whose name and bar are on screen.
   *
   * Not `battle.foe`: the engine has finished the turn before any of it is
   * played back, so by then the next Pokémon is already out — or the fight is
   * over and there is none. This is the one the player is looking at.
   * @type {import('../engine/pokemon.mjs').Pokemon|null}
   */
  let shownFoe = battle.foe?.pokemon ?? null;
  /** The entry being played, so the bars can read what it stood at. */
  let playing = /** @type {import('../engine/battle.mjs').LogEntry|null} */ (null);

  const message = el('div.battle-message');
  const conditions = el('div.battle-field');
  /** The weather the field is drawn under, as far as the playback has got. */
  let shownWeather = /** @type {string|null} */ (null);
  const playerPlate = nameplate(session.active);
  const foePlate = nameplate(shownFoe);
  const playerBar = healthBar();
  const foeBar = healthBar();
  /** The trainer's remaining party, drawn as the balls still on their belt. */
  const foeBalls = el('div.battle-balls');
  /** The trainer's whole party, in the order they were handed to the battle. */
  const foeParty = [...foes];
  /** Which of it is out on the field, as played — not as the engine has it. */
  let foeOut = /** @type {import('../engine/pokemon.mjs').Pokemon|null} */ (null);
  /** And which of it has fainted, as played. */
  const foeFallen = new Set();
  /** Every Pokémon is seen the moment it appears. */
  for (const foe of foes) session.markSeen(foe.speciesId);

  /**
   * Put a battle sprite on a side, from the picture both sides fight in.
   *
   * Both sides go through the same path — keyed on the sprite key, so a
   * Pokémon whose shape changes mid-fight is reloaded like a new picture
   * rather than left wearing the old one.
   *
   * @param {'player'|'foe'} side
   * @param {import('../engine/pokemon.mjs').Pokemon|null} pokemon
   */
  const loadBattler = (side, pokemon) => {
    const key = spriteKey(pokemon);
    if (!pokemon || !key) return;
    const loaded = side === 'player' ? loadedPlayerId : loadedFoeId;
    if (key === loaded) return;
    if (side === 'player') loadedPlayerId = key;
    else loadedFoeId = key;

    const art = battlerArt(pokemon);
    if (!art) return;
    loadSprite(art.path, art.meta).then((sprite) => {
      const latest = side === 'player' ? loadedPlayerId : loadedFoeId;
      if (latest !== key) return; // a newer shape already took the spot
      const battler = new Battler({
        sprite,
        ...(side === 'foe'
          ? {
              x: FOE_SPOT.x,
              y: FOE_SPOT.y,
              facing: -1,
              scale: BATTLE_SCALE,
              flip: mirrorFor(sprite, 'left'),
            }
          : {
              x: PLAYER_SPOT.x,
              y: PLAYER_SPOT.y,
              facing: 1,
              scale: BATTLE_SCALE,
              // The companion stands on the left, looking up the field at its
              // opponent.
              flip: mirrorFor(sprite, 'right'),
            }),
      });
      // Hidden until its ball has landed, if it is still in the air.
      battler.visible = sentOut[side];
      // A sparkle under way carries on on the new picture, and one asked for
      // before there was a picture starts now.
      battler.takeSparkleFrom(side === 'player' ? playerBattler : foeBattler);
      const chime = shinyPending[side];
      if (chime) {
        shinyPending[side] = null;
        battler.showShiny(chime);
      }
      if (side === 'player') playerBattler = battler;
      else foeBattler = battler;
    });
  };

  const loadFoeSprite = () => loadBattler('foe', battle.foe?.pokemon ?? null);

  /**
   * The balls still on the opponent's belt: one for every Pokémon neither out
   * on the field nor fainted, so a ball goes the moment it is thrown, and one
   * called back by a Roar goes back on.
   *
   * Counted from what has been played rather than from the engine, which has
   * the whole turn worked out before any of it is shown: read from there, the
   * count moved a turn out of step with the Pokémon coming out. A wild Pokémon
   * has no trainer, and the row stays empty.
   */
  function updateFoeBalls() {
    // A wild Pokémon has no belt: the row said "one" over every wild battle.
    const standing = trainer ? foeParty.filter((pokemon) => pokemon !== foeOut && !foeFallen.has(pokemon)).length : 0;
    setChildren(
      foeBalls,
      Array.from({ length: standing }, () =>
        el('img.battle-ball', { src: url('assets', 'items/poke-ball.png'), alt: '' })),
    );
  }

  /**
   * A click on the battle brings the next entry on at half the remaining wait
   * — enough to hurry the fight along without skipping what is being said —
   * and answers with a ring where the pointer landed.
   * @param {import('../core/app.mjs').App} app
   * @param {MouseEvent} event
   */
  function hurryBeat(app, event) {
    if (finished || entering < ENTRY_MS) return;
    // Half of the beat that is still to run, floored so a late click does not
    // revive a beat that had already finished.
    beat = Math.min(beat, Math.max(beat * (1 - CLICK_SPEEDUP), 16));
    app.clickRipple(event);
  }

  return {
    keepBelow: true,

    mount(app) {
      loadBattler('player', session.active);
      loadFoeSprite();
      if (backdrop) loadBackdrop(backdrop).then((image) => { backdropImage = image; });

      app.audio.playMusic(music ?? gameData().bgm.cues[trainer ? 'battleTrainer' : 'battleWild']);
      app.audio.playCry(battle.foe?.pokemon.speciesId ?? session.active.speciesId);

      queue = [
        { kind: 'intro', data: {} },
        { kind: 'go', data: {} },
      ];
      updateBars();
      updateField();
      updateFoeBalls();

      // The whole screen is the click target: hurrying a fight along is what
      // anyone mashing through a message box expects, and the scene already
      // ignores pointer events except where the bag button asks for them.
      const screenNode = el('div.battle-clickcatch');
      screenNode.addEventListener('pointerdown', (event) => hurryBeat(app, event));

      screenRoot = el('div.screen.battle-screen', {}, [
        screenNode,
        el('div.battle-bar.foe', {}, [foePlate.root, foeBar.root]),
        el('div.battle-bar.player', {}, [playerPlate.root, playerBar.root]),
        el('div.battle-actions', {}, [
          foeBalls,
          button(t('battle.bag'), () => openBag(app), { className: 'small' }),
          button(t('battle.run'), () => run(app), { className: 'small' }),
        ]),
        conditions,
        message,
      ]);
      // Nothing of the battle shows until the dark opens on it.
      screenRoot.style.visibility = 'hidden';
      return screenRoot;
    },

    update(deltaMs, app) {
      // The way in runs before anything is said, so the first line of the
      // fight is not read out over a road the player is still looking at.
      if (entering < ENTRY_MS) {
        entering += deltaMs;
        if (screenRoot) {
          screenRoot.style.visibility = entering / ENTRY_MS >= ENTRY_OPEN ? 'visible' : 'hidden';
        }
        return;
      }

      playerBattler?.update(deltaMs);
      foeBattler?.update(deltaMs);
      updateTosses(deltaMs, app);
      playerBar.update(deltaMs);
      foeBar.update(deltaMs);
      if (leaderFigure.leaving >= 0) leaderFigure.leaving += deltaMs;

      if (finished) return;
      beat -= deltaMs;
      // The leader has been looked at long enough — or the player clicked on —
      // and steps off as the first ball goes up.
      if (leaderFigure.pending && beat <= holdForShiny(shownFoe ?? battle.foe?.pokemon, BEAT_MS.intro)) {
        leaderFigure.pending = false;
        leaderFigure.leaving = 0;
        toss('foe', shownFoe ?? battle.foe?.pokemon ?? null);
      }
      if (beat > 0) return;

      if (queue.length === 0) {
        if (!battle.running) {
          finishUp(app);
          return;
        }
        queue = battle.takeTurn();
        if (queue.length === 0) {
          finishUp(app);
          return;
        }
      }

      const entry = queue.shift();
      if (entry) {
        beat = play(entry, app);
        // The party count follows the faints and the send-outs, wherever in
        // the turn they happened to fall.
        updateFoeBalls();
      }
    },

    render(context) {
      const step = entering / ENTRY_MS;

      // The road is still on the canvas underneath; it flashes rather than
      // being covered, which is the first half of the way in.
      if (step < ENTRY_SHUT) {
        drawEntryFlash(context, step / ENTRY_SHUT);
        return;
      }

      // Until the backdrop has decoded, dim whatever the field left on the
      // canvas rather than flashing the map at full brightness for a frame.
      if (!backdropImage) {
        context.fillStyle = 'rgba(12, 16, 26, 0.55)';
        context.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
      }

      inFieldSpace(context, (field) => {
        if (backdropImage) drawBackdrop(field, backdropImage);
        drawLeader(field);
        foeBattler?.draw(field);
        playerBattler?.draw(field);
        drawTosses(field);
        // The sky over the fight: rain streaking across it, sand blowing, hail
        // and snow falling, a warm wash of sun — over the Pokémon, as on the road.
        drawWeather(field, shownWeather, performance.now());
      });

      if (step < 1) drawEntryShutters(context, step);
    },
  };

  /**
   * The road going white, three times, on the way into a fight.
   * @param {CanvasRenderingContext2D} context
   * @param {number} step 0 to 1 across the flashing phase
   */
  function drawEntryFlash(context, step) {
    const pulse = Math.abs(Math.sin(step * Math.PI * ENTRY_FLASHES));
    context.save();
    context.globalAlpha = Math.min(1, pulse * (0.4 + step * 0.8));
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
    context.restore();
  }

  /**
   * The dark closing over the road and opening on the battle.
   * @param {CanvasRenderingContext2D} context
   * @param {number} step 0 to 1 across the whole way in
   */
  function drawEntryShutters(context, step) {
    const shut = step < ENTRY_OPEN
      ? (step - ENTRY_SHUT) / (ENTRY_OPEN - ENTRY_SHUT)
      : 1 - (step - ENTRY_OPEN) / (1 - ENTRY_OPEN);
    const reach = Math.ceil((VIEW_HEIGHT / 2) * Math.max(0, Math.min(1, shut * 1.1)));
    if (reach <= 0) return;

    context.save();
    context.fillStyle = '#05070c';
    context.fillRect(0, 0, VIEW_WIDTH, reach);
    context.fillRect(0, VIEW_HEIGHT - reach, VIEW_WIDTH, reach);
    context.restore();
  }

  /**
   * Open the bag mid-battle.
   *
   * Whatever is chosen is thrown on the companion's next action rather than
   * immediately: a turn spent on an item is a turn not spent attacking, which
   * is the cost the games charge for it.
   *
   * @param {import('../core/app.mjs').App} app
   */
  async function openBag(app) {
    if (finished) return;
    app.audio.blip('select');

    // Every medicine a fight can use, the ones that would do nothing now
    // greyed out: an Antidote is in the bag whether or not anything is
    // poisoned, as the games' bag shows it.
    const medicine = battleMedicine(session, session.active);
    const detailOf = (entry) => {
      const use = entry.item.use;
      if (entry.kind === 'hp') return t('battle.restores', { amount: entry.usable && entry.restores ? entry.restores : entry.power });
      if (entry.kind === 'status') return use.status === 'any' ? t('battle.curesAll') : t('battle.cures', { status: t(`status.${use.status}.short`) });
      return t(entry.scope === 'one' ? 'battle.ppOne' : 'battle.ppAll');
    };
    const chosen = await chooseFromList(
      app,
      t('battle.bag'),
      medicine.map((entry) => ({
        value: entry.slug,
        label: localized(entry.item.name, entry.slug),
        detail: `${t('items.count', { count: entry.count })}  ·  ${detailOf(entry)}`,
        disabled: !entry.usable,
      })),
      { empty: t('battle.noItems') },
    );

    if (!chosen || finished) return;
    // An Ether is for one move, and the player says which: one that is down
    // on its PP, as the games list them.
    /** @type {{move?: number}} */
    let choice = {};
    if (medicine.some((entry) => entry.slug === chosen && entry.scope === 'one')) {
      const moves = session.active.moves;
      const picked = await chooseFromList(
        app,
        t('items.chooseMove'),
        moves.map((entry, index) => ({
          value: index,
          label: localized(moveOf(entry.move)?.name, entry.move),
          detail: `PP ${entry.pp}/${maxPp(entry)}`,
          disabled: entry.pp >= maxPp(entry),
        })),
      );
      if (picked === null || finished) return;
      choice = { move: picked };
    }
    battle.queueItem(chosen, choice);
    say(t('battle.itemReady', { item: localized(gameData().items[chosen]?.name, chosen) }));
  }

  /**
   * Run, on the next turn — which the games try before anybody moves. A
   * trainer will not let the companion go, and says so without the turn
   * being spent.
   *
   * @param {import('../core/app.mjs').App} app
   */
  function run(app) {
    if (finished || entering < ENTRY_MS) return;
    if (!battle.queueEscape()) {
      app.audio.blip('error');
      say(t('battle.noRunning'));
      return;
    }
    app.audio.blip('select');
    say(t('battle.runReady'));
  }

  /**
   * Show one log entry and return how long to hold on it.
   * @param {import('../engine/battle.mjs').LogEntry} entry
   * @param {import('../core/app.mjs').App} app
   * @returns {number}
   */
  function play(entry, app) {
    playing = entry;
    const player = session.active;
    const foe = shownFoe ?? battle.foe?.pokemon;

    switch (entry.kind) {
      case 'intro':
        // The field used to toast this line and the battle repeat it a beat
        // later; the announcement lives here now, where the fight is.
        say(trainer
          ? t(leader ? 'event.leader' : 'event.trainer', { trainer: localized(trainer.name, '') })
          : t('event.wild', { name: nameOf(foe) }));
        // A trainer's Pokémon comes out of a ball; a wild one is already there.
        // A gym leader is seen first, and throws once the line has been read.
        if (leaderArt) {
          leaderFigure.pending = true;
          return LEADER_HOLD_MS + holdForShiny(foe, BEAT_MS.intro);
        }
        if (trainer) {
          toss('foe', foe);
          return holdForShiny(foe, BEAT_MS.intro);
        }
        // A wild one is there from the start, and sparkles while it is
        // announced; the line waits for the stars, as the cartridge's does. No
        // line of its own says so — the games never had one.
        if (foe?.shiny) {
          sparkle('foe', app);
          return Math.max(BEAT_MS.intro, SHINY_MS);
        }
        return BEAT_MS.intro;

      // The companion is sent out after whatever it is being sent out against
      // has been named, which is the order the games read in.
      case 'go':
        say(t('battle.go', { name: nameOf(player) }));
        toss('player', player);
        return holdForShiny(player, BEAT_MS.go);

      case 'move': {
        const attacker = entry.side === 'player' ? player : foe;
        const move = moveOf(entry.data?.move);
        say(t('battle.usedMove', {
          name: nameOf(attacker),
          move: move ? localized(move.name, entry.data?.move) : t('battle.struggle'),
        }));
        if (entry.data?.reveal) battlerFor(entry.side)?.comeBack();
        battlerFor(entry.side)?.setPose('attack');
        break;
      }

      case 'damage': {
        battlerFor(entry.side)?.setPose('hit');
        app.audio.blip('hit');
        updateBars();
        return BEAT_MS.damage;
      }

      case 'critical':
        say(t('battle.critical'));
        break;

      case 'effectiveness': {
        const value = entry.data?.effectiveness ?? 1;
        const name = nameOf(entry.side === 'player' ? player : foe);
        if (value === 0) say(t('battle.noEffect', { name }));
        else if (value > 1) say(t('battle.superEffective'));
        else say(t('battle.notVeryEffective'));
        break;
      }

      case 'miss':
        say(t('battle.missed', { name: nameOf(entry.side === 'player' ? player : foe) }));
        break;

      case 'status': {
        const name = nameOf(entry.side === 'player' ? player : foe);
        const status = entry.data?.status;
        // A null status is one that has just lifted: woken, thawed, or cured
        // by an ability. Each says so in its own words rather than leaving
        // whatever was on the screen before it standing.
        if (status) say(t(entry.data?.toxic ? 'status.psn.toxic' : `status.${status}.gained`, { name }));
        else if (entry.data?.woke) say(t('status.slp.ended', { name }));
        else if (entry.data?.thawed) say(t('status.frz.ended', { name }));
        else say(t('status.cured', { name }));
        // The condition's own effect plays over the Pokémon as it takes hold.
        if (status) battlerFor(entry.side)?.showStatus(status);
        updateBars();
        return status ? BEAT_MS.status : BEAT_MS.default;
      }

      case 'statusBlocked':
        say(t(STATUS_BLOCKED[entry.data?.status] ?? 'battle.cannotMove', {
          name: nameOf(entry.side === 'player' ? player : foe),
        }));
        // And again whenever it stops the Pokémon moving, as the games play it.
        if (entry.data?.status) battlerFor(entry.side)?.showStatus(entry.data.status);
        return BEAT_MS.status;

      case 'statusDamage':
        say(t(STATUS_HURT[entry.data?.status] ?? 'battle.statusHurt', {
          name: nameOf(entry.side === 'player' ? player : foe),
        }));
        if (entry.data?.status) battlerFor(entry.side)?.showStatus(entry.data.status);
        battlerFor(entry.side)?.setPose('hit');
        updateBars();
        return Math.max(BEAT_MS.damage, BEAT_MS.status);

      case 'stat': {
        // How far it moved decides the wording, as in the games: one stage
        // rises, two rise sharply, three or more drastically.
        const change = entry.data?.change ?? 0;
        const steps = Math.min(3, Math.max(1, Math.abs(change)));
        say(t(`battle.stat.${change < 0 ? 'fell' : 'rose'}${steps}`, {
          name: nameOf(entry.side === 'player' ? player : foe),
          stat: t(`stat.${entry.data?.stat}`),
        }));
        battlerFor(entry.side)?.showStatChange(change > 0 ? 1 : -1);
        app.audio.blip(change > 0 ? 'confirm' : 'cancel');
        return BEAT_MS.stat;
      }

      case 'statFailed': {
        // Already as high or as low as the stage goes.
        const change = entry.data?.change ?? 0;
        say(t(`battle.stat.${change < 0 ? 'bottomed' : 'maxed'}`, {
          name: nameOf(entry.side === 'player' ? player : foe),
          stat: t(`stat.${entry.data?.stat}`),
        }));
        break;
      }

      case 'heal':
        // A heal a move line has already announced moves the bar and nothing
        // else.
        if (!entry.data?.quiet) say(t('battle.healed', { name: nameOf(entry.side === 'player' ? player : foe) }));
        updateBars();
        break;

      // One of the move lines: who it is about is the entry's side, and the
      // rest is what the line names.
      case 'message': {
        const self = entry.side === 'player' ? player : foe;
        const other = entry.side === 'player' ? foe : player;
        const data = entry.data ?? {};
        say(t(data.key, {
          name: nameOf(self),
          target: nameOf(other),
          team: t(entry.side === 'foe' ? 'battle.team.foe' : 'battle.team.player'),
          move: data.move ? localized(moveOf(data.move)?.name, data.move) : '',
          item: data.item ? localized(gameData().items[data.item]?.name, data.item) : '',
          ability: data.ability ? localized(abilityOf(data.ability)?.name, data.ability) : '',
          type: data.type ? localized(gameData().types[data.type]?.name, data.type) : '',
          count: data.count ?? '',
          stat: data.stat ? t(`stat.${data.stat}`) : '',
        }));
        // "flew up high", "dug a hole": the Pokémon goes where the line says,
        // and is not seen again until its move comes down.
        if (data.hide) battlerFor(entry.side)?.goAway(data.hide);
        updateBars();
        break;
      }

      case 'volatile':
        say(t(entry.data?.fatigue ? 'move.fatigue' : `volatile.${entry.data?.state}.start`, {
          name: nameOf(entry.side === 'player' ? player : foe),
          move: localized(moveOf(entry.data?.move)?.name, entry.data?.move ?? ''),
        }));
        // Confusion plays its own effect as it takes hold, like a condition.
        if (entry.data?.state === 'confusion') {
          battlerFor(entry.side)?.showStatus('confusion');
          updateBars();
          return BEAT_MS.status;
        }
        updateBars();
        break;

      case 'volatileActive':
        say(t(`volatile.${entry.data?.state}.active`, {
          name: nameOf(entry.side === 'player' ? player : foe),
        }));
        // And again each turn it is checked, as the games play it.
        if (entry.data?.state === 'confusion') {
          battlerFor(entry.side)?.showStatus('confusion');
          return BEAT_MS.status;
        }
        break;

      case 'volatileBlocked':
        say(t(`volatile.${entry.data?.state}.blocked`, {
          name: nameOf(entry.side === 'player' ? player : foe),
        }));
        break;

      case 'volatileEnded':
        say(t(`volatile.${entry.data?.state}.end`, {
          name: nameOf(entry.side === 'player' ? player : foe),
        }));
        updateBars();
        break;

      case 'confusionDamage':
        say(t('battle.confusionDamage', { name: nameOf(entry.side === 'player' ? player : foe) }));
        battlerFor(entry.side)?.setPose('hit');
        app.audio.blip('hit');
        updateBars();
        return BEAT_MS.damage;

      case 'perished':
        say(t('battle.perished', { name: nameOf(entry.side === 'player' ? player : foe) }));
        updateBars();
        break;

      case 'protect':
        say(t('battle.protecting', { name: nameOf(entry.side === 'player' ? player : foe) }));
        break;

      case 'protected':
        say(t('battle.protected', { name: nameOf(entry.side === 'player' ? player : foe) }));
        break;

      case 'bounced':
        say(t('battle.bounced', { name: nameOf(entry.side === 'player' ? player : foe) }));
        break;

      case 'loafing':
        say(t('battle.loafing', { name: nameOf(entry.side === 'player' ? player : foe) }));
        break;

      case 'stole':
      case 'regrew': {
        const slug = entry.data?.item ?? '';
        say(t(entry.kind === 'stole' ? 'battle.stole' : 'battle.regrew', {
          name: nameOf(entry.side === 'player' ? player : foe),
          item: localized(gameData().items[slug]?.name, slug),
        }));
        break;
      }

      case 'formChanged': {
        // The shape a Pokémon now wears: the sprite is reloaded by the key
        // change, the way a sent-out one is. A forme of null means back to
        // the ordinary shape, which is the usual thing a message names.
        const shifter = entry.side === 'player' ? player : foe;
        loadBattler(entry.side, entry.side === 'player' ? player : foe);
        if (entry.data?.forme) {
          const formName = speciesOf(shifter?.speciesId)?.forms?.find((form) => form.slug === entry.data.forme);
          say(t('battle.formChanged', {
            name: nameOf(shifter),
            form: localized(formName?.name, entry.data.forme),
          }));
        } else {
          say(t('battle.formReverted', { name: nameOf(shifter) }));
        }
        updateBars();
        app.audio.blip('confirm');
        break;
      }

      case 'formBroken':
        // The disguise shattering is its own moment: the ability line already
        // played, and the shape swap rides the same key change as above.
        loadBattler(entry.side, entry.side === 'player' ? player : foe);
        say(t('battle.formBroken', {
          name: nameOf(entry.side === 'player' ? player : foe),
          ability: localized(abilityOf(entry.data?.ability)?.name, entry.data?.ability ?? ''),
        }));
        battlerFor(entry.side)?.setPose('hit');
        app.audio.blip('hit');
        updateBars();
        return BEAT_MS.damage;

      case 'typeChanged':
        say(t('battle.typeChanged', {
          name: nameOf(entry.side === 'player' ? player : foe),
          types: (entry.data?.types ?? [])
            .map((type) => localized(gameData().types[type]?.name, type))
            .join('·'),
        }));
        break;

      case 'hazard':
        say(t(`hazard.${entry.data?.hazard}`));
        break;

      case 'hazardCleared':
        say(t('hazard.cleared'));
        break;

      case 'hazardDamage':
        say(t('battle.hazardDamage', { name: nameOf(entry.side === 'player' ? player : foe) }));
        battlerFor(entry.side)?.setPose('hit');
        updateBars();
        return BEAT_MS.damage;

      case 'noEffect':
        say(t('battle.noEffect', { name: nameOf(entry.side === 'player' ? player : foe) }));
        break;

      // A move that went off and achieved nothing — not one the target was
      // immune to, which is the line above.
      case 'failed':
        say(t('battle.failed'));
        break;

      case 'flinch':
        say(t('battle.flinched', { name: nameOf(entry.side === 'player' ? player : foe) }));
        break;

      case 'ability':
        say(t('battle.ability', {
          name: nameOf(entry.side === 'player' ? player : foe),
          ability: localized(abilityOf(entry.data?.ability)?.name, entry.data?.ability ?? ''),
        }));
        break;

      case 'transformed': {
        // It looks like what it copied from here on; the nameplate keeps its
        // own name, as the games' does.
        const self = entry.side === 'player' ? player : foe;
        if (self) {
          const look = /** @type {any} */ ({ ...self, speciesId: entry.data?.speciesId, forme: entry.data?.forme ?? undefined });
          if (entry.side === 'player') playerLook = look;
          loadBattler(entry.side, look);
        }
        say(t('battle.transformed', {
          name: nameOf(self),
          target: localized(speciesOf(entry.data?.speciesId)?.name, ''),
        }));
        break;
      }

      case 'frisked': {
        const self = entry.side === 'player' ? player : foe;
        const other = entry.side === 'player' ? foe : player;
        const slug = entry.data?.item ?? '';
        say(t('battle.frisked', {
          name: nameOf(self),
          target: nameOf(other),
          item: localized(gameData().items[slug]?.name, slug),
        }));
        break;
      }

      case 'abilityChanged':
        say(t('battle.abilityChanged', {
          name: nameOf(entry.side === 'player' ? player : foe),
          ability: localized(abilityOf(entry.data?.ability)?.name, entry.data?.ability ?? ''),
        }));
        break;

      case 'abilityTraced':
        say(t('battle.abilityTraced', {
          name: nameOf(player),
          ability: localized(abilityOf(entry.data?.ability)?.name, entry.data?.ability ?? ''),
        }));
        break;

      case 'abilityDamage':
        battlerFor(entry.side)?.setPose('hit');
        app.audio.blip('hit');
        updateBars();
        return BEAT_MS.damage;

      case 'weather':
        say(t(`weather.${entry.data?.weather}.start`));
        updateField();
        break;

      case 'weatherEnded':
        say(t(`weather.${entry.data?.value}.end`));
        updateField();
        break;

      case 'weatherDamage':
        say(t(`weather.${entry.data?.weather}.hurt`, { name: nameOf(entry.side === 'player' ? player : foe) }));
        battlerFor(entry.side)?.setPose('hit');
        updateBars();
        break;

      case 'terrain':
        say(t(`terrain.${entry.data?.terrain}.start`));
        updateField();
        break;

      case 'terrainEnded':
        say(t(`terrain.${entry.data?.value}.end`));
        updateField();
        break;

      case 'screen':
        say(t(`screen.${entry.data?.screen}`));
        break;

      case 'screenEnded':
        say(t('screen.ended'));
        break;

      case 'trickRoom':
        say(t(entry.data?.state === 'ended' ? 'field.trickRoomEnded' : 'field.trickRoom', {
          name: nameOf(entry.side === 'player' ? player : foe),
        }));
        break;

      case 'trickRoomEnded':
        say(t('field.trickRoomEnded'));
        break;

      case 'tailwind':
        say(t(entry.side === 'player' ? 'field.tailwind' : 'field.tailwindFoe'));
        break;

      case 'tailwindEnded':
        say(t(entry.side === 'player' ? 'field.tailwindEnded' : 'field.tailwindFoeEnded'));
        break;

      case 'charging':
        say(t('battle.charging', {
          name: nameOf(entry.side === 'player' ? player : foe),
          move: localized(moveOf(entry.data?.move)?.name, entry.data?.move ?? ''),
        }));
        break;

      case 'recharge':
        say(t('battle.recharge', { name: nameOf(entry.side === 'player' ? player : foe) }));
        break;

      case 'restored':
        say(t('battle.restored', {
          name: nameOf(entry.side === 'player' ? player : foe),
          item: localized(gameData().items[entry.data?.item]?.name, entry.data?.item ?? ''),
        }));
        break;

      case 'item': {
        const name = localized(gameData().items[entry.data?.item]?.name, entry.data?.item ?? '');
        say(entry.data?.used
          ? t('battle.itemUsed', { name: nameOf(player), item: name })
          : t('items.cannotUse'));
        app.audio.blip(entry.data?.used ? 'confirm' : 'error');
        updateBars();
        break;
      }

      case 'berry':
      case 'heldFired': {
        // A berry is eaten; a policy, a seed or an orb simply goes off. The
        // item's own pocket is what tells them apart, so the engine does not
        // have to carry two log entries for one moment.
        const slug = entry.data?.item ?? '';
        const item = gameData().items[slug];
        const holder = entry.side === 'foe' ? foe : player;
        say(t(item?.pocket === 'berries' ? 'battle.berryEaten' : 'battle.heldFired', {
          name: nameOf(holder),
          item: localized(item?.name, slug),
        }));
        app.audio.blip('confirm');
        updateBars();
        break;
      }

      case 'endure': {
        const holder = entry.side === 'player' ? player : foe;
        // A Sturdy holds on where a Focus Sash would have been spent, so the
        // line names whichever of the two did it.
        const name = entry.data?.ability
          ? localized(abilityOf(entry.data.ability)?.name, entry.data.ability)
          : localized(gameData().items[entry.data?.item]?.name, entry.data?.item ?? '');
        say(t('battle.endured', { name: nameOf(holder), item: name }));
        app.audio.blip('hit');
        updateBars();
        break;
      }

      case 'faint': {
        // From the entry rather than from `battle.foe`: by the time the log is
        // played back the engine has already moved on, and the last foe to
        // fall leaves `battle.foe` empty — which is why the line read
        // "은(는) 쓰러졌다!" with no name, and why nothing reached the tray.
        const fainter = entry.data?.pokemon ?? (entry.side === 'player' ? player : foe);
        if (entry.side === 'foe' && fainter) foeFallen.add(fainter);
        say(t('battle.fainted', { name: nameOf(fainter) }));
        battlerFor(entry.side)?.setPose('lose');
        app.audio.blip('faint');
        if (entry.side === 'foe' && fainter) defeated.push(fainter);
        return BEAT_MS.faint;
      }

      case 'sendOut': {
        loadedFoeId = '';
        loadedPlayerId = '';
        if (trainer) toss('foe', entry.data?.pokemon ?? battle.foe?.pokemon ?? null);
        loadFoeSprite();
        loadBattler('player', playerLook ?? player);
        updateBars();
        // A trainer sends the next one out; only a wild Pokémon appears of its
        // own accord, so only a wild battle reads the encounter line here.
        const sent = entry.data?.pokemon ?? battle.foe?.pokemon ?? null;
        shownFoe = sent;
        foePlate.set(sent);
        updateBars();
        say(trainer
          ? t('battle.foeSentOut', { trainer: localized(trainer.name, ''), name: nameOf(sent) })
          : t('event.wild', { name: nameOf(sent) }));
        // A trainer's shiny sparkles out of its ball; a wild one in place.
        if (!trainer && sent?.shiny) sparkle('foe', app);
        return trainer ? holdForShiny(sent, BEAT_MS.faint) : sent?.shiny ? Math.max(BEAT_MS.faint, SHINY_MS) : BEAT_MS.faint;
      }

      case 'experience':
        say(t('battle.expGained', { name: nameOf(player), amount: entry.data?.amount ?? 0 }));
        break;

      case 'levelUp':
        say(t('battle.levelUp', { name: nameOf(player), level: entry.data?.level ?? levelOf(player) }));
        app.audio.playJingle(gameData().bgm.cues.levelUp ?? null);
        updateBars();
        break;

      case 'canLearn': {
        // A free slot means the move is simply learned, as in the games; with
        // four moves already the player swaps it in from the Pokémon screen.
        const move = entry.data?.move;
        if (!move) break;
        const moveName = localized(moveOf(move)?.name, move);
        if (player.moves.length < 4) {
          setMove(player, player.moves.length, move);
          say(t('battle.learned', { name: nameOf(player), move: moveName }));
          break;
        }
        // Four already. The games say so rather than dropping the move
        // silently, which left no sign anywhere that there was something new
        // waiting in the Pokémon screen's move list.
        say(t('battle.cannotLearnMore', { name: nameOf(player), move: moveName }));
        app.toast(t('battle.cannotLearnMore', { name: nameOf(player), move: moveName }), 3200);
        break;
      }

      case 'end':
        // A battle that ends while one side is up in the sky or under the
        // ground brings it back to see the end.
        playerBattler?.comeBack();
        foeBattler?.comeBack();
        if (battle.outcome === 'won') {
          // The games say nothing more after a wild Pokémon's faint and the
          // experience — the fight is simply over — and name the trainer beaten.
          if (trainer) say(t(leader ? 'battle.wonLeader' : 'battle.wonTrainer', { trainer: localized(trainer.name, '') }));
          // A companion that went down last has won lying down.
          if (player.hp > 0) playerBattler?.setPose('win');
        } else if (battle.outcome === 'fled' || battle.outcome === 'escaped') {
          // Nobody was beaten: the line that sent it away has already been
          // said, and the battle simply ends — the wild one gone from its
          // spot, or the companion away from it, which leaves the wild one
          // standing.
          if (battle.outcome === 'fled') foeBattler?.setPose('lose');
        } else {
          say(t('battle.lost'));
        }
        return BEAT_MS.end;

      default:
        return 120;
    }
    return BEAT_MS[entry.kind] ?? BEAT_MS.default;
  }

  /** @param {import('../core/app.mjs').App} app */
  function finishUp(app) {
    if (finished) return;
    finished = true;

    // Anything but a berry that the battle used up is the companion's again.
    restoreHeldItem(session.active, startItem);

    // Whatever shape the battle put anyone in — a Primal Kyogre, a Crowned
    // Zacian, a Zen Mode — is let go of; a held mask or a chosen Sky Forme
    // stays on.
    for (const pokemon of [session.active, ...defeated]) settleForme(pokemon);

    // A Natural Cure and a Regenerator do on the way out what they do on
    // being switched out; a Pickup now and then finds something after a win.
    afterBattle(session.active, maxHp(session.active));
    // A bad poison is an ordinary one once the battle is over, as it is since
    // Black and White: the counter that made it worse is a battle's.
    session.active.toxic = false;
    if (battle.outcome === 'won' && abilityName(session.active) === 'pickup' && session.rng.chance(PICKUP_CHANCE)) {
      const pool = (gameData().itemTiers?.['poke-ball'] ?? []).filter((slug) => !alreadyOwned(session, slug));
      const found = pickFind(session, pool);
      if (found) {
        session.addItem(found);
        app.toast(t('battle.pickup', { name: nameOf(session.active), item: localized(gameData().items[found]?.name, found) }), 3200);
      }
    }
    // A Honey Gather comes back with Honey now and then, likelier the higher
    // its level: five percent for every ten levels begun.
    const honeyChance = Math.ceil(levelOf(session.active) / 10) * 0.05;
    if (abilityName(session.active) === 'honey-gather' && gameData().items.honey && !alreadyOwned(session, 'honey') && session.rng.chance(honeyChance)) {
      session.addItem('honey');
      app.toast(t('battle.pickup', { name: nameOf(session.active), item: localized(gameData().items.honey?.name, 'honey') }), 3200);
    }

    // Friendship: levelling up earns it, fainting costs a little.
    const levels = levelOf(session.active) - startLevel;
    if (levels > 0) friendshipForLevels(session.active, levels);
    if (battle.outcome === 'lost') gainFriendship(session.active, -1);

    // An evolution the win allows plays out on its own screen, over this one,
    // before the battle hands back to whoever started it — unless the player
    // stopped it at this level already.
    const evolution = battle.outcome === 'won'
      ? offeredEvolution(session.active, {
          timeOfDay: timeOfDay(),
          crits: battle.player.marks.crits ?? 0,
          box: session.box,
          raining: weatherForArea(session.area) === 'rain',
          areaTags: session.area?.tags ?? [],
        })
      : null;
    if (evolution) {
      app.push(evolutionScene({
        session,
        pokemon: session.active,
        to: evolution.to,
        stoppable: true,
        onFinish: () => {
          app.pop();
          handBack();
        },
      }));
      return;
    }
    handBack();
  }

  /** Whatever this battle's levels and evolution taught noted down, and the battle over. */
  function handBack() {
    noteLearnedMoves(session.active, session.machines);

    battle.release();
    onFinish({
      outcome: battle.outcome === 'lost' ? 'lost' : battle.outcome === 'fled' || battle.outcome === 'escaped' ? 'fled' : 'won',
      defeated,
    });
  }

  /** @param {'player'|'foe'|undefined} side */
  function battlerFor(side) {
    return side === 'player' ? playerBattler : foeBattler;
  }

  /** @param {string} text */
  function say(text) {
    message.textContent = text;
  }

  /**
   * Point both bars at what the line being played says they stood at.
   *
   * Falling back to the Pokémon's own hit points covers the first paint, and
   * any entry written before the stamp existed.
   */
  function updateBars() {
    playerBar.set(session.active, playing?.hp?.player);
    foeBar.set(shownFoe, playing?.hp?.foe);
    playerPlate.set(session.active, playing?.statuses ? playing.statuses.player : undefined, playing?.confused?.player ?? false);
    foePlate.set(shownFoe, playing?.statuses ? playing.statuses.foe : undefined, playing?.confused?.foe ?? false);
  }

  /**
   * What is over and under the field, as a line of chips above the message
   * box: a battle where the rain decides the damage should say that it is
   * raining for as long as it is, not only on the turn it started.
   */
  function updateField() {
    const field = battle.field;
    shownWeather = field.weather ?? null;
    setChildren(conditions, [
      field.weather
        ? el('span.field-chip', { text: t(`weather.${field.weather}.name`), title: t(`weather.${field.weather}.start`) })
        : null,
      field.terrain
        ? el('span.field-chip', { text: t(`terrain.${field.terrain}.name`), title: t(`terrain.${field.terrain}.start`) })
        : null,
    ]);
  }

  /**
   * @param {import('../engine/pokemon.mjs').Pokemon|null|undefined} pokemon
   * @returns {string}
   */
  function nameOf(pokemon) {
    if (!pokemon) return '';
    return pokemon.nickname || localized(speciesOf(pokemon.speciesId)?.name, '');
  }

}

/**
 * A name and level caption over a health bar, with the status condition
 * beside the name as the games' nameplates carry it.
 *
 * It can be pointed at somebody else: a trainer sends out a second Pokémon and
 * the plate over the bar was still naming the one that fainted.
 */
function nameplate(pokemon) {
  const node = el('span.battle-name');

  /**
   * @param {import('../engine/pokemon.mjs').Pokemon|null|undefined} next
   * @param {string|null} [status] the condition to show, where the caller
   *   knows it better than the Pokémon does — during the playback of a turn
   *   the engine has already finished
   * @param {boolean} [confused] whether it is confused, which only a battle
   *   knows and which sits beside the condition
   */
  const set = (next, status, confused = false) => {
    if (!next) {
      node.textContent = '';
      return;
    }
    const species = speciesOf(next.speciesId);
    const name = next.nickname || localized(species?.name, '');
    // The ♂ and ♀ in their own colours, as the games' nameplates draw them.
    const condition = status === undefined ? next.status : status;
    setChildren(node, [
      name,
      next.gender ? el(`span.gender-mark.${next.gender}`, { text: t(`pokemon.gender.${next.gender}`) }) : null,
      shinyMark(next, t('pokemon.shiny')),
      statusMark(condition, t(`status.${condition}.short`)),
      confused ? statusMark('confusion', t('status.confusion.short')) : null,
      `  ${t('slot.level', { level: levelOf(next) })}`,
    ]);
  };

  set(pokemon);
  return { root: node, set };
}

/**
 * One bar, moving at one speed — which is what the games have.
 *
 * The bar is animated here rather than by a CSS transition: a transition runs
 * for the time it is given whatever distance it has to cover, so a two-point
 * scratch and a bar-emptying hit took exactly as long as each other. The
 * number counts along with it, as it does on the cartridge, so the two never
 * disagree about how much is left.
 */
export function healthBar() {
  const fill = el('i');
  const text = el('span.battle-hp');
  const track = el('div.battle-track', {}, [fill, text]);

  /** What the bar is showing, what it is heading for, and how fast. */
  let shown = /** @type {{hp: number, max: number}|null} */ (null);
  let goal = 0;
  /** Hit points a millisecond, signed. */
  let rate = 0;

  function paint() {
    if (!shown) {
      fill.style.width = '0%';
      text.textContent = '';
      return;
    }
    const ratio = shown.max > 0 ? Math.max(0, Math.min(1, shown.hp / shown.max)) : 0;
    fill.style.width = `${ratio * 100}%`;
    // The thresholds the games change colour at: half, and a fifth.
    fill.style.background = ratio > 0.5 ? '#63bb5b' : ratio > 0.2 ? '#f3d23b' : '#d8443c';
    text.textContent = `${Math.round(shown.hp)}/${shown.max}`;
  }

  return {
    root: track,

    /**
     * @param {import('../engine/pokemon.mjs').Pokemon|null} pokemon
     * @param {number} [at] the hit points to show, where the caller knows them
     *   better than the Pokémon does — which is any moment during the playback
     *   of a turn the engine has already finished
     */
    set(pokemon, at) {
      if (!pokemon) {
        shown = null;
        rate = 0;
        paint();
        return;
      }

      const max = maxHp(pokemon);
      const hp = Math.max(0, Math.min(max, typeof at === 'number' ? at : pokemon.hp));

      // A bar arriving for the first time, or one whose Pokémon has just
      // changed shape under it, is simply drawn where it stands.
      if (!shown || shown.max !== max) {
        shown = { hp, max };
        goal = hp;
        rate = 0;
        paint();
        return;
      }

      goal = hp;
      const distance = Math.abs(goal - shown.hp) / max;
      const duration = Math.max(DRAIN_MIN_MS, distance * DRAIN_FULL_MS);
      rate = (goal - shown.hp) / duration;
      paint();
    },

    /** @param {number} deltaMs */
    update(deltaMs) {
      if (!shown || rate === 0 || shown.hp === goal) return;
      const next = shown.hp + rate * deltaMs;
      shown.hp = rate > 0 ? Math.min(goal, next) : Math.max(goal, next);
      if (shown.hp === goal) rate = 0;
      paint();
    },
  };
}

/**
 * The item the policy would throw this turn, if any.
 *
 * A condition is the whole of it — the same vocabulary the auto-battle screen
 * uses — and `never` means the bag only opens when the player opens it.
 *
 * @param {import('../engine/session.mjs').Session} session
 * @param {import('../engine/pokemon.mjs').Pokemon} pokemon
 * @returns {string|null}
 */
function autoHeal(session, pokemon) {
  const policy = session.itemPolicy?.healing;
  if (!policy || policy.condition === 'never') return null;

  const health = pokemon.hp / Math.max(1, maxHp(pokemon));
  const thresholds = { hpTwoThirds: 2 / 3, hpHalf: 1 / 2, hpThird: 1 / 3, hpQuarter: 1 / 4 };
  const threshold = thresholds[policy.condition];
  if (threshold === undefined || health > threshold) return null;

  return healingItemFor(session, pokemon, policy.item);
}
