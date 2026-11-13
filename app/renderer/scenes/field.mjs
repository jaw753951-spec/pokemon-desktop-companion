/**
 * The travelling scene — the game's home screen.
 *
 * The companion walks rightwards forever; the world scrolls, the area changes
 * every few minutes, and the run autosaves on its own. Once a minute an event
 * spawns something ahead on the path, and the walk carries on until it is
 * reached — so nothing ever simply appears on top of the player.
 */
import {
  EVENT_RETRY_MS,
  OVERPASS_RETRY_MS,
  FIELD_HEIGHT,
  HOLD_BOOST_EVENT,
  HOLD_BOOST_LOOK,
  HOLD_BOOST_RATE,
  HOLD_BOOST_WALK,
  CROSSING_MS,
  timeOfDay,
} from '../../shared/constants.mjs';
import { loadImage, loadSprite } from '../core/assets.mjs';
import { artOf, gameData, speciesOf, spriteKey } from '../core/data.mjs';
import { nameOf, walkSteps } from '../engine/pokemon.mjs';

import { name as localized, t } from '../core/i18n.mjs';
import { eventModifiers, healAfterBattle, restockBerry } from '../engine/items.mjs';
import { callRestStop } from '../engine/rest.mjs';
import { earn, formatMoney, lossFor, prizeFor } from '../engine/shop.mjs';
import { Session } from '../engine/session.mjs';
import {
  actorHeight,
  actorScale,
  boostPace,
  COMPANION_X,
  drawStepDust,
  drawWalker,
  groundY,
  idleBob,
  nearOverpass,
  nextBoost,
  setGroundY,
  WALK_SPEED,
} from '../render/field.mjs';
import { backdropForArea } from '../render/backdrop.mjs';
import { createFieldLayers } from '../render/fieldlayers.mjs';
import { weatherForArea } from '../../shared/area-tags.mjs';
import { LEADER_REST_AFTER_LOSS } from '../../shared/constants.mjs';
import { createHud } from '../render/hud.mjs';
import { battleScene } from './battle.mjs';
import { captureScene } from './capture.mjs';
import { createEventRunner, drawCarried, drawProp, eventGround, propLook } from './fieldevents.mjs';
import { leagueScene } from './league.mjs';
import { shutter } from '../ui/shutter.mjs';
import { inventoryScene } from '../ui/inventory.mjs';
import { shopScene } from '../ui/shop.mjs';
import { pokedexScene } from '../ui/pokedex.mjs';
import { chooseAction, confirm } from '../ui/dialog.mjs';
import { saveAndExit, saveAndQuit, settingsScene } from '../ui/settings.mjs';

/** Field pixels to a step: one tile of the map. */
const STEP_PX = 16;

/**
 * How long the pointer has to be off the companion before the windows over
 * the road fade out, when the setting asks for it. Half a minute: long enough
 * that a glance away and back finds them where they were, and only a
 * companion left to walk on its own sheds them.
 */
export const HUD_IDLE_MS = 30000;

/**
 * Start or resume a run, replacing whatever is on screen.
 * @param {import('../core/app.mjs').App} app
 * @param {{slot: number, save: any}} options
 */
export function startRun(app, { slot, save }) {
  const session = new Session({ slot, save });
  app.session = session;
  app.setScene(fieldScene(session));
}

/**
 * @param {Session} session
 * @returns {import('../core/app.mjs').Scene}
 */
export function fieldScene(session) {
  /** @type {HTMLImageElement|null} */
  let background = null;
  /** A bridge over the lane, drawn over the companion. @type {HTMLImageElement|null} */
  let overlay = null;
  /** The companion's picture. @type {import('../core/assets.mjs').Sprite|null} */
  let companion = null;

  let loadedAreaKey = '';
  /** Which art is on screen: the species, and which of its two palettes. */
  let loadedSpriteId = '';
  let offset = 0;
  /**
   * Set while a battle, the capture screen or the league is on top: those
   * replace the view, so the walk and its timers stop with it.
   */
  let paused = false;
  /**
   * Set while the bag, the Pokédex or the settings are open.
   *
   * The companion keeps walking under them — a menu is the player stopping to
   * read, not the Pokémon stopping to wait — but nothing new is *started*
   * while one is up: a battle erupting underneath an open bag would leave the
   * two screens stacked on each other. The turn is held rather than dropped,
   * so it comes round again a few seconds after the menu closes.
   */
  let menuOpen = false;
  /**
   * Whether the pointer is being held on the travelling view.
   *
   * A press on the companion makes it get on with it: the road scrolls faster
   * and the event clock runs fast while this is true, which is the part of it
   * a player can actually see. It is a live state rather than a stock of
   * clicks: it is what the hand is doing, and `boost` follows it.
   */
  let boosting = false;
  /**
   * How far the hurry has come on, 0 to 1 — up while the pointer is held and
   * gliding back down after it is let go, so the road neither lurches into a
   * run nor stops dead. See `nextBoost`.
   */
  let boost = 0;
  /** How far into the walk to the next area, in milliseconds; 0 when settled. */
  let crossing = 0;
  /** Whether the area has already changed behind the shut screen. */
  let crossed = false;
  /** An area change waiting for the road to be clear of an event. */
  let pendingCrossing = false;
  /**
   * Cleared while a battle or the capture screen is up: those draw their own
   * version of the companion, and two of it at once reads as a bug.
   */
  let showActor = true;

  let hud = /** @type {ReturnType<typeof createHud>|null} */ (null);
  /** The road's layers, under the game's canvas. @type {ReturnType<typeof createFieldLayers>|null} */
  let layers = null;
  /** @type {ReturnType<typeof createEventRunner>|null} */
  let events = null;
  /** @type {import('../core/app.mjs').App|null} */
  let host = null;
  /** The overlay listeners this scene registered, removed on unmount. */
  let onPointerDown = null;
  let onPointerUp = null;
  let onHoverIn = null;
  let onHoverOut = null;
  /**
   * Whether the pointer is over the companion's window, and how long it has
   * been away if not. It starts away: a companion just opened under a pointer
   * that never moves fades like any other, and the first nudge brings the
   * windows back.
   */
  let hovering = false;
  let awayMs = 0;

  /** Load whatever art the current area and companion need. */
  const refreshArt = (app) => {
    const key = `${session.area?.id}/${timeOfDay()}`;
    if (session.area && key !== loadedAreaKey) {
      loadedAreaKey = key;
      // The strip is anchored to the bottom of the field, so the area's own
      // walkable lane is measured from there too.
      setGroundY(FIELD_HEIGHT - session.area.height + session.area.groundY);
      loadImage(`areas/${session.area.id}/${timeOfDay()}.png`)
        .then((image) => {
          // A slower load must not overwrite a newer area.
          if (loadedAreaKey === key) background = image;
        })
        .catch(() => {
          background = null;
        });
      overlay = null;
      if (session.area.overlay) {
        loadImage(`areas/${session.area.id}/${timeOfDay()}-over.png`)
          .then((image) => {
            if (loadedAreaKey === key) overlay = image;
          })
          .catch(() => {
            overlay = null;
          });
      }
      resumeMusic(app);
    }

    const speciesId = spriteKey(session.active);
    if (speciesId !== loadedSpriteId) {
      loadedSpriteId = speciesId;
      // Its battle picture, drawn at half a battle's size on the road and
      // sized to the Pokémon, so a Wurmple stays ankle-high and a Wailord
      // fills the road.
      const art = artOf(session.active);
      if (art) {
        loadSprite(art.path, art.meta)
          .then((sprite) => {
            if (loadedSpriteId === speciesId) companion = sprite;
          })
          .catch(() => {
            companion = null;
          });
      }
    }
  };

  /**
   * @param {import('../core/app.mjs').App} app
   * @param {number} index
   */
  async function openTrayMenu(app, index) {
    const pokemon = session.tray[index];
    if (!pokemon) return;
    const label = localized(speciesOf(pokemon.speciesId)?.name, '');

    const choice = await chooseAction(app, label, [
      { value: 'capture', label: t('tray.capture') },
      { value: 'release', label: t('tray.release'), danger: true },
    ]);

    if (choice === 'capture') {
      session.tray.splice(index, 1);
      openCapture(app, pokemon);
      return;
    }

    if (choice === 'release') {
      if (!(await confirm(app, t('tray.releaseConfirm'), { danger: true }))) return;
      session.tray.splice(index, 1);
      app.toast(t('tray.released', { name: label }));
    }
  }

  /**
   * Open the capture screen on a Pokémon that has been knocked down.
   *
   * One that is neither caught nor scared off goes back to the tray, so
   * closing the screen by mistake does not throw the catch away.
   *
   * @param {import('../core/app.mjs').App} app
   * @param {import('../engine/pokemon.mjs').Pokemon} target
   */
  function openCapture(app, target) {
    paused = true;
    showActor = false;
    app.push(
      captureScene({
        session,
        target,
        onFinish: ({ caught, fled }) => {
          app.pop();
          paused = false;
          showActor = true;
          if (!caught && !fled) session.addToTray(target);
          resumeMusic(app);
          refreshArt(app);
        },
      }),
    );
  }

  /**
   * @param {import('../core/app.mjs').App} app
   * @param {{foes: any[], trainer: any|null, leader: any|null}} setup
   */
  function startBattle(app, setup) {
    paused = true;
    showActor = false;
    app.push(
      battleScene({
        session,
        foes: setup.foes,
        trainer: setup.trainer,
        leader: Boolean(setup.leader),
        // A gym leader is fought in their gym, everyone else where they stand.
        backdrop: setup.leader ? 'leader' : backdropForArea(session.area),
        music: setup.leader ? gameData().bgm.cues.battleLeader : undefined,
        // A leader's win is met with the badge's cue, once the fight is over.
        fanfare: setup.leader ? null : victoryCue(setup),
        onFinish: (result) => {
          app.pop();
          paused = false;
          showActor = true;
          // The audio engine holds this as the track to come back to once a
          // cue has finished — the win's, which is already playing, or the
          // badge's below — so the area's music is what returns rather than
          // the battle theme.
          resumeMusic(app);
          finishBattle(app, setup, result);
        },
      }),
    );
  }

  /**
   * The cue a win over a trainer or a wild Pokémon is met with, which the
   * battle plays as the companion's win pose starts.
   *
   * @param {{trainer: any|null}} setup
   */
  function victoryCue(setup) {
    const cues = gameData().bgm.cues;
    // A trainer's theme up to where its loop begins, faded as the loop comes
    // in. A wild win is just the five-note run up that opens its theme, left
    // to ring: it comes round too often to hold the road's music off for the
    // rest.
    return setup.trainer
      ? { name: cues.victoryTrainer ?? null, options: { intro: true } }
      : { name: cues.victoryWild ?? null, options: { notes: 5 } };
  }

  /**
   * @param {import('../core/app.mjs').App} app
   * @param {{foes: any[], trainer: any|null, leader: any|null}} setup
   * @param {{outcome: 'won'|'lost'|'fled', defeated: any[]}} result
   */
  function finishBattle(app, setup, result) {
    // Sent away, or gone: nothing was won and nothing lost.
    if (result.outcome === 'fled') {
      patchUp(app);
      restock(app);
      refreshArt(app);
      return;
    }
    if (result.outcome === 'lost') {
      // Blacking out costs the catch and nothing else. A wild Pokémon that was
      // never beaten cannot be thrown a ball — it is the one that walked away
      // — while a trainer takes no more from you than the walk to the next
      // rest stop, which is where the companion heads either way, on the one
      // hit point the loss leaves it.
      // Losing to a trainer pays them, as the games have it; a wild Pokémon
      // takes nothing.
      const paid = setup.trainer ? lossFor(session) : 0;
      if (paid > 0) earn(session, -paid);
      // A leader lost to does not stand in the road again at the next trainer.
      if (setup.leader) session.leaderRest = LEADER_REST_AFTER_LOSS;
      session.blackOut();
      // Enough of these in a row and the road eases off for a while, quietly.
      session.noteBattle('lost');
      // The wild one is named, or the line read "the wild {name} ran away".
      const wild = setup.foes[0];
      const lost = setup.trainer
        ? t('battle.lost')
        : t('battle.lostWild', { name: nameOf(wild) });
      app.toast([lost, paid > 0 ? t('money.paid', { amount: formatMoney(paid) }) : null].filter(Boolean).join('\n'));
      restock(app);
      refreshArt(app);
      return;
    }

    // A win ends a run of losses.
    session.noteBattle('won');

    // A trainer beaten pays a prize: so much a level of their last Pokémon.
    if (setup.trainer) {
      const prize = prizeFor(setup.foes, setup.leader ? 'leader' : 'trainer');
      earn(session, prize);
      app.toast(t('money.prize', { amount: formatMoney(prize) }), 2600);
    }

    if (setup.leader) {
      session.badges.push(setup.leader.type);
      session.trainerWins = 0;
      app.audio.playJingle(gameData().bgm.cues.obtainBadge ?? null);
      app.toast(t('badge.obtained', { name: badgeLabel(setup.leader) }));
    } else if (setup.trainer) {
      session.trainerWins++;
    } else {
      // Only wild Pokémon can be caught, so only they reach the tray — and
      // only when the companion was the one left standing.
      for (const pokemon of result.defeated) session.addToTray(pokemon);
    }

    // Won on the way down — the last of the foe's taken with it on a recoil —
    // keeps everything the win was worth, and the companion is carried to
    // the next Pokémon Center as after a loss, on one hit point, with nothing
    // paid for it.
    if (session.active.hp <= 0) session.blackOut();
    patchUp(app);
    restock(app);
    refreshArt(app);
  }

  /**
   * The walk from one area to the next.
   *
   * The road used to change under the companion's feet between one frame and
   * the next. The games never do that: they close the screen, change what is
   * behind it, and open it again, and the few hundred milliseconds of dark is
   * what makes somewhere else read as somewhere else rather than as a glitch.
   *
   * The companion keeps walking the whole way through — it is going
   * somewhere, not waiting — and the area is swapped at the darkest point.
   *
   * @param {number} deltaMs
   * @param {import('../core/app.mjs').App} app
   */
  function tickCrossing(deltaMs, app) {
    // One starts as soon as the road is clear of whatever was happening on it.
    if (pendingCrossing && crossing === 0 && !events?.busy && !menuOpen) {
      pendingCrossing = false;
      crossing = 1;
      crossed = false;
    }
    if (crossing === 0) return;

    crossing += deltaMs;
    // Halfway, with the screen shut: the road behind it becomes another road.
    if (!crossed && crossing >= CROSSING_MS / 2) {
      crossed = true;
      session.rotateArea();
      refreshArt(app);
      app.toast(localized(session.area?.name, session.area?.id ?? ''), 2200);
    }
    if (crossing >= CROSSING_MS) crossing = 0;
  }

  /**
   * How far shut the screen is, 0 open and 1 closed.
   *
   * Shut and open take the same time as each other, so the swap at the middle
   * falls where the screen is fully dark.
   */
  function crossingShut() {
    if (crossing === 0) return 0;
    const half = CROSSING_MS / 2;
    return crossing <= half ? crossing / half : Math.max(0, 1 - (crossing - half) / half);
  }

  /**
   * Put the area's own music back on.
   *
   * Everything that opens over the road — a battle, the capture screen, the
   * league — plays music of its own, and nothing brought the area's back
   * afterwards: a fight left the battle theme looping over the walk until the
   * area happened to rotate. The audio engine ignores a track that is already
   * playing, so this is safe to call on every return.
   *
   * @param {import('../core/app.mjs').App} app
   */
  function resumeMusic(app) {
    app.audio.playMusic(session.area?.music ?? null);
  }

  /**
   * Put a berry back in the companion's hand if the fight emptied it, which is
   * what the bag's restock setting is for.
   *
   * @param {import('../core/app.mjs').App} app
   */
  function restock(app) {
    const berry = restockBerry(session, session.active);
    if (berry) app.toast(t('items.restocked', { name: localized(gameData().items[berry]?.name, berry) }));
  }

  /**
   * Top the companion back up from the bag after a win, as far as the bag's
   * after-battle setting asks. Only after a win: a loss sends it to the next
   * Pokémon Center, which heals it for nothing.
   *
   * @param {import('../core/app.mjs').App} app
   */
  function patchUp(app) {
    const policy = session.itemPolicy;
    const used = healAfterBattle(session, session.active, policy?.afterBattle ?? 'full', {
      status: policy?.afterBattleStatus ?? true,
      pp: policy?.afterBattlePp ?? false,
    });
    if (used.length === 0) return;
    const items = used
      .map(({ slug, count }) => {
        const name = localized(gameData().items[slug]?.name, slug);
        return count > 1 ? `${name} ${t('items.count', { count })}` : name;
      })
      .join(', ');
    app.toast(t('items.afterBattleUsed', { items }));
  }

  return {
    mount(app) {
      host = app;
      hud = createHud({
        onInventory: () => {
          app.audio.blip('select');
          menuOpen = true;
          app.push(inventoryScene({ session, onClose: () => closeMenu(app) }));
        },
        onPokedex: () => {
          app.audio.blip('select');
          menuOpen = true;
          app.push(pokedexScene({ session, onClose: () => closeMenu(app) }));
        },
        onShop: () => {
          app.audio.blip('select');
          menuOpen = true;
          app.push(shopScene({ session, onClose: () => closeMenu(app) }));
        },
        onSettings: () => {
          app.audio.blip('select');
          menuOpen = true;
          app.push(
            settingsScene({
              onClose: () => closeMenu(app),
              onSaveAndExit: () => saveAndExit(app),
              onSaveAndQuit: () => saveAndQuit(app),
            }),
          );
        },
        onLeague: () => {
          // One press: the road stops where it is, and the button does
          // nothing more while the shutter is on its way down.
          if (paused) return;
          app.audio.blip('confirm');
          paused = true;
          // The dark closes over the road and opens on the League's hall, as
          // it does on the way into a battle. Only here, on the way in: the
          // rounds and the bag inside come and go as they did.
          shutter({
            onShut: () => {
              showActor = false;
              app.push(
                leagueScene({
                  session,
                  onLeave: () => closeMenu(app),
                  onCrowned: () => {
                    // Champion or not, the run carries on with everything intact.
                    closeMenu(app);
                  },
                }),
              );
            },
          });
        },
        onTraySelect: (index) => openTrayMenu(app, index),
      });

      events = createEventRunner({
        session,
        onBattle: (setup) => startBattle(app, setup),
      });

      // The stage is scaled, so the pointer's own coordinates are of no use
      // here: holding it anywhere on the road says "get on with it", wherever
      // on the view it landed.
      //
      // Held rather than counted, and released rather than spent: the road
      // runs fast while the pointer is down and glides back to its own pace
      // within a second of it coming up. A stock of clicks that drained
      // afterwards had the companion sprinting for seconds after the player
      // had stopped asking it to.
      onPointerDown = (event) => {
        // Not while something else owns the screen: a press on an open bag is
        // aimed at the bag, wherever in it the pointer landed.
        if (paused || menuOpen) return;
        if (/** @type {PointerEvent} */ (event).button !== 0) return;
        // A press on a control is not a poke at the road, however it reaches
        // this listener on its way up: the tray and the dialogs it opens sit
        // in the same overlay, and a menu button answers for itself.
        const target = event.target;
        if (target instanceof Element && target.closest('button, .modal, .panel')) return;

        boosting = true;
        // A ring marks where the pointer landed, as it does everywhere else.
        app.clickRipple(event);
      };
      // Every way a press can end, including the pointer leaving the window
      // mid-press — a button released off-screen must not leave the road
      // running fast with nothing holding it.
      onPointerUp = () => {
        boosting = false;
      };

      const overlay = document.getElementById('overlay');
      overlay?.addEventListener('pointerdown', onPointerDown);
      for (const name of ['pointerup', 'pointercancel', 'pointerleave']) {
        overlay?.addEventListener(name, onPointerUp);
      }
      window.addEventListener('blur', onPointerUp);

      // Over the window or off it. A move counts as well as an entry, since
      // an entry made before this scene mounted is never seen again.
      onHoverIn = () => {
        hovering = true;
        awayMs = 0;
      };
      onHoverOut = () => {
        hovering = false;
      };
      document.documentElement.addEventListener('mouseenter', onHoverIn);
      document.documentElement.addEventListener('mousemove', onHoverIn);
      document.documentElement.addEventListener('mouseleave', onHoverOut);

      // The road goes under the game's canvas, which the screens opened over
      // it — a battle, the capture screen — still draw on.
      layers = createFieldLayers();
      document.getElementById('stage')?.insertBefore(layers.root, app.canvas);

      refreshArt(app);
      hud.update(session);
      return hud.root;
    },

    unmount() {
      const overlay = document.getElementById('overlay');
      if (onPointerDown) overlay?.removeEventListener('pointerdown', onPointerDown);
      if (onPointerUp) {
        for (const name of ['pointerup', 'pointercancel', 'pointerleave']) {
          overlay?.removeEventListener(name, onPointerUp);
        }
        window.removeEventListener('blur', onPointerUp);
      }
      if (onHoverIn) {
        document.documentElement.removeEventListener('mouseenter', onHoverIn);
        document.documentElement.removeEventListener('mousemove', onHoverIn);
      }
      if (onHoverOut) document.documentElement.removeEventListener('mouseleave', onHoverOut);
      onPointerDown = null;
      onPointerUp = null;
      onHoverIn = null;
      onHoverOut = null;
      boosting = false;
      boost = 0;
      hud = null;
      events = null;
      host = null;
      layers?.destroy();
      layers = null;
    },

    update(deltaMs, app) {
      // With nobody looking, the windows step aside and leave the companion
      // on its road; a pointer over it brings them back.
      if (!hovering) awayMs += deltaMs;
      hud?.setIdle(app.settings.hideIdleHud !== false && !hovering && awayMs >= HUD_IDLE_MS);

      if (paused) return;

      // Holding the pointer on the travelling view runs the event clock fast,
      // so the next one comes round sooner, and the road past with it. The
      // frame the pointer goes up both are back to normal with nothing owed
      // either way. Menus and battles sit above this scene, so a press on
      // those never reaches here.
      boost = nextBoost(boost, boosting, deltaMs);
      const walking = events?.walking ?? true;
      if (walking) {
        const from = offset;
        offset += (WALK_SPEED * boostPace(boost, HOLD_BOOST_WALK) * deltaMs) / 1000;
        // Never past whatever is being walked up to: a long frame would carry
        // the companion a few pixels beyond the spot, which at a door leaves
        // it standing at the side of the doorway instead of in it.
        const stop = events?.stopAt;
        if (stop !== null && stop !== undefined && offset > stop) offset = stop;
        // A tile of road is a step, the way the games count them.
        if (session.active && offset > from) walkSteps(session.active, (offset - from) / STEP_PX);
      }

      // One hurry at a time. On the open road holding winds the event clock
      // on; while an event is playing out it hurries that event instead, and
      // the clock keeps its own pace — winding both meant a held press on a
      // berry tree also used up the wait for the next event, which then
      // arrived the moment the picking was done.
      const { autosave, event } = session.tick(deltaMs, {
        eventRate: events?.busy ? 1 : boostPace(boost, HOLD_BOOST_RATE),
      });

      tickCrossing(deltaMs, app);

      // A turn that came due mid-event is held rather than dropped: the timer
      // goes back to a few seconds instead of its whole period, so the walk
      // picks it up as soon as the road is clear again.
      if (event) {
        // Nor does one play out under a bridge: it waits until the road ahead
        // is open sky again.
        if (events?.busy || menuOpen || crossing > 0) {
          session.eventTimer = EVENT_RETRY_MS;
        } else if (nearOverpass(session.area, eventGround(offset))) {
          session.eventTimer = OVERPASS_RETRY_MS;
        } else {
          // Running short of health, PP, potions or balls calls a rest stop
          // once; it is no longer one of the rolls.
          callRestStop(session);
          events?.start(session.events.roll(session.rng, eventModifiers(session)), offset);
          // Ten things happen in a place, and then somewhere else.
          if (session.countEvent()) pendingCrossing = true;
        }
      }
      if (autosave) {
        session
          .save()
          .then(() => app.toast(t('field.saved'), 1400))
          .catch(() => {});
      }

      // Held while a menu is open: the walk and the clocks carry on under one,
      // but an event part way through does not get to reach its battle and
      // push a fight on top of the bag the player is reading.
      // And whatever is playing out on the road — a berry picked, a ball
      // opened, the find held up — plays at the event hurry while held; the
      // walk up to it goes at the walk's.
      const eventPace = boostPace(boost, events?.walking ? HOLD_BOOST_WALK : HOLD_BOOST_EVENT);
      if (!menuOpen) events?.update(deltaMs * eventPace, offset, app, deltaMs * boostPace(boost, HOLD_BOOST_LOOK));
      refreshArt(app);
      hud?.update(session);
    },

    present() {
      layers?.sync(view());
    },

    setShown(shown) {
      layers?.setShown(shown);
    },

    snapshot(context) {
      layers?.snapshot(context);
    },

    setPaused(value) {
      paused = value;
      // Whatever was holding the road fast is not holding it any more: a menu
      // opening over it ends the hurry along with everything else.
      if (value) {
        boosting = false;
        boost = 0;
      }
    },

    get offset() {
      return offset;
    },

    /**
     * Whether something is playing out on the road: an event, or the walk
     * into the next area. For the tools that film the road, which wait for it
     * to be clear before they move on.
     */
    get busy() {
      return Boolean(events?.busy) || crossing > 0 || pendingCrossing;
    },
  };

  /**
   * The road as it stands this frame, for its layers (see `fieldlayers.mjs`).
   *
   * Each part that changes is named by a key — the same key, the same picture
   * — so a layer is painted again only when what is on it has changed, and
   * otherwise only moved.
   *
   * @returns {import('../render/fieldlayers.mjs').FieldView}
   */
  function view() {
    const hour = timeOfDay();
    const scroll = Math.round(offset);

    const standing = events?.standing ?? null;
    const prop = standing
      ? {
          key: propLook(standing),
          // Where it stands moves with the road a whole pixel at a time, in
          // step with the road under it.
          x: COMPANION_X + Math.round(standing.worldX) - scroll,
          draw: (/** @type {CanvasRenderingContext2D} */ context, /** @type {number} */ x) => drawProp(context, standing, x),
        }
      : null;

    const alpha = events?.actorAlpha ?? 1;
    const shown = Boolean(companion && showActor && !events?.hidesActor && alpha > 0);
    const moving = !paused && (events?.walking ?? true);
    const lift = events?.actorLift ?? null;
    const carried = events?.carried ?? null;
    const scale = actorScale(companion, session.active);
    // Walking, it changes as it covers ground — the hop, the dust; standing,
    // as it bobs, or as whatever it is busy with lifts it.
    const pose = moving ? `walk${scroll}` : lift !== null ? `lift${lift}` : `bob${idleBob(session.playtime)}`;
    const actorKey = [
      shown ? `${loadedSpriteId}|${scale}|${pose}|${lift ?? ''}|${alpha}` : 'none',
      carried ? carried.icon : '',
    ].join('|');

    return {
      offset,
      hour,
      background,
      overlay,
      weather: weatherForArea(session.area),
      elapsed: session.playtime,
      prop,
      actor: {
        key: actorKey,
        draw: (context) => {
          // Held up over its head, clear of whatever height it is.
          if (carried) drawCarried(context, carried, actorHeight(companion, session.active));
          if (!shown || !companion) return;
          const walk = {
            x: COMPANION_X,
            y: groundY(),
            distance: scroll,
            moving,
            // Standing still in front of a berry tree for ten seconds reads as
            // a frozen game; the bob says it is picking.
            lift,
            scale,
            time: session.playtime,
          };
          // Faded as it steps through a doorway, shadow and all.
          context.globalAlpha *= alpha;
          drawStepDust(context, walk);
          // A hop while the road moves, and its standing bob while it does not.
          drawWalker(context, companion, walk);
        },
      },
      flash: events?.takeFlash() ?? 0,
      shut: crossingShut(),
    };
  }

  /** @param {import('../core/app.mjs').App} app */
  function closeMenu(app) {
    app.pop();
    paused = false;
    menuOpen = false;
    showActor = true;
    resumeMusic(app);
    refreshArt(app);
    void host;
  }
}

/**
 * A badge is named for its type, which avoids inventing names for the badges
 * of regions whose leaders the game generates rather than ships.
 * @param {any} leader
 */
function badgeLabel(leader) {
  const type = gameData().types[leader.type];
  return localized(type?.name, leader.type);
}
