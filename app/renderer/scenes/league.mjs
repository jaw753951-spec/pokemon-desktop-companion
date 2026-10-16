/**
 * The Pokémon League.
 *
 * Opens once eight badges are in hand. Which region's Elite Four and Champion
 * you face is rolled each time you walk in — the four and their champion are
 * one line-up and travel together, so a challenge is always somebody's real
 * league rather than a pick-and-mix. Between rounds the companion is fully
 * restored and you choose whether to go straight on or to prepare: the bag,
 * with the shop where the box would be, opened over the challenge, which
 * closing brings you back from.
 */
import { VIEW_HEIGHT, VIEW_WIDTH } from '../../shared/constants.mjs';
import { url } from '../core/bridge.mjs';
import { gameData, speciesOf } from '../core/data.mjs';
import { stableHash } from '../core/rng.mjs';
import { button, el, setChildren } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { createPokemon, nameOf } from '../engine/pokemon.mjs';
import { capRoster, evolveToLevel, giveTrainerItems, LEAGUE_PARTY_CAP } from '../engine/encounter.mjs';
import { backdropForLeagueRound, drawBackdrop, loadRoom } from '../render/backdrop.mjs';
import { inFieldSpace } from '../render/field.mjs';
import { alreadyOwned, earn, formatMoney, lossFor, prizeFor } from '../engine/shop.mjs';
import { restockBerry } from '../engine/items.mjs';
import { battleScene } from './battle.mjs';
import { inventoryScene } from '../ui/inventory.mjs';

/**
 * The level each round's team stands at: the Elite Four in order, then the
 * champion.
 *
 * Fixed rather than pitched against the challenger. A league levelled to
 * whoever walked in was the same climb at level 50 as at 90, so there was
 * nothing to train for; this one sits in the 70s, where the eighth badge
 * comes (see `BADGE_LEVELS`), and the champion at 80 at the top of it.
 */
export const LEAGUE_LEVELS = [70, 72, 74, 76, 80];

/**
 * The level for one round of a league of so many, the last always the
 * champion's.
 *
 * @param {number} index
 * @param {number} count
 */
export function leagueLevel(index, count) {
  const last = LEAGUE_LEVELS.length - 1;
  return index >= count - 1 ? LEAGUE_LEVELS[last] : LEAGUE_LEVELS[Math.min(index, last - 1)];
}

/**
 * @param {{
 *   session: import('../engine/session.mjs').Session,
 *   onLeave: () => void,
 *   onCrowned: () => void,
 * }} options
 * @returns {import('../core/app.mjs').Scene}
 */
export function leagueScene({ session, onLeave, onCrowned }) {
  const league = resolveLeague(session);
  const rounds = [...league.eliteFour, league.champion];

  // A challenge left part-way — the game closed in the middle of it — picks
  // up where it stood: the same league, at the round reached.
  let index = Math.min(Math.max(0, session.leagueRun?.round ?? 0), rounds.length - 1);
  let busy = false;
  /** The room this round is challenged in, drawn behind the challenge screen. */
  let room = /** @type {HTMLImageElement|null} */ (null);
  let loadedRoom = '';

  const heading = el('div.league-heading');
  const portrait = /** @type {HTMLImageElement} */ (el('img.league-portrait', { alt: '' }));
  const caption = el('div.league-caption');
  const actions = el('div.league-actions');

  return {
    keepBelow: true,

    mount(app) {
      app.audio.playMusic(gameData().bgm.cues.league ?? null);
      render(app);
      refreshRoom();

      return el('div.screen.league-screen', {}, [
        heading,
        portrait,
        caption,
        actions,
      ]);
    },

    render(context) {
      if (!room) {
        context.fillStyle = 'rgba(8, 10, 20, 0.88)';
        context.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
        return;
      }
      // The room itself, dimmed enough for the portrait and the buttons in
      // front of it to stay legible.
      inFieldSpace(context, (field) => drawBackdrop(field, room));
      context.fillStyle = 'rgba(8, 10, 20, 0.5)';
      context.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
    },
  };

  /** @param {import('../core/app.mjs').App} app */
  function render(app) {
    const round = rounds[index];
    const last = index === rounds.length - 1;

    heading.textContent = `${localized(league.name, league.region)} ${t(last ? 'league.champion' : 'league.eliteFour')}`;
    caption.textContent = localized(round.name, round.id);

    const art = portraitFor(round);
    portrait.hidden = !art;
    if (art) portrait.src = url('assets', `trainers/portraits/${art.name}.png`);
    // Somebody nobody drew is a shape, not another person's face.
    portrait.classList.toggle('silhouette', Boolean(art && !art.own));

    setChildren(actions, [
      button(t('league.next'), () => startRound(app), { className: 'primary', disabled: busy }),
      // Preparing is the bag, opened over the challenge: the run stays where
      // it is, and closing the bag comes back to this screen rather than
      // out onto the road. The bag has the shop in the box's place: nobody
      // is swapped in mid-challenge.
      button(t('league.prepare'), () => {
        app.audio.blip('select');
        app.push(inventoryScene({
          session,
          // No box: the companion that walked in is the one that fights.
          // The shop takes its place, for stocking up between rounds.
          tabs: ['pokemon', 'items', 'shop'],
          onClose: () => {
            app.pop();
            render(app);
          },
        }));
      }, { disabled: busy }),
    ]);
  }

  /** The room the round about to be fought is challenged in. */
  function refreshRoom() {
    const id = backdropForLeagueRound(index, rounds.length);
    if (id === loadedRoom) return;
    loadedRoom = id;
    loadRoom(id).then((image) => {
      if (loadedRoom === id) room = image;
    });
  }

  /** @param {import('../core/app.mjs').App} app */
  function startRound(app) {
    if (busy) return;
    busy = true;

    const round = rounds[index];
    const last = index === rounds.length - 1;

    const foes = buildParty(session, round, leagueLevel(index, rounds.length));
    app.push(
      battleScene({
        session,
        foes,
        trainer: round,
        backdrop: backdropForLeagueRound(index, rounds.length),
        music: gameData().bgm.cues[last ? 'battleChampion' : 'battleEliteFour'],
        onFinish: (result) => {
          app.pop();
          busy = false;
          // Back to the hall's own music; without this the round's battle
          // theme carried on looping over the challenge screen.
          app.audio.playMusic(gameData().bgm.cues.league ?? null);

          if (result.outcome === 'lost') {
            // A loss ends the challenge rather than the run: the companion is
            // sent back to the field on its last hit point, and to the rest
            // stop the field will now put in its way.
            session.leagueRun = null;
            const paid = lossFor(session);
            if (paid > 0) earn(session, -paid);
            session.blackOut();
            app.toast([t('battle.lost'), paid > 0 ? t('money.paid', { amount: formatMoney(paid) }) : null].filter(Boolean).join('\n'));
            onLeave();
            return;
          }

          // The League pays the best prizes there are.
          const prize = prizeFor(foes, 'league');
          if (prize > 0) {
            earn(session, prize);
            app.toast(t('money.prize', { amount: formatMoney(prize) }), 2600);
          }

          // Every round is followed by a full restore, as the games' league
          // does — and a hand the round emptied is given a berry from the
          // bag, as the bag's restock setting does after any fight.
          session.heal();
          const berry = restockBerry(session, session.active);

          if (last) {
            crown(app);
            return;
          }

          index++;
          if (session.leagueRun) session.leagueRun.round = index;
          app.toast(berry
            ? `${t('league.healed')}\n${t('items.restocked', { name: localized(gameData().items[berry]?.name, berry) })}`
            : t('league.healed'));
          render(app);
          refreshRoom();
        },
      }),
    );
  }

  /** @param {import('../core/app.mjs').App} app */
  function crown(app) {
    const reward = championPrize(session);
    session.addItem(reward);
    session.champion = true;
    session.champions.add(session.active.speciesId);
    session.leagueRegion = league.region;
    session.leagueRun = null;

    const name = nameOf(session.active);
    app.audio.playJingle(gameData().bgm.cues.victoryLeague ?? null, { intro: true });
    const prize = t('league.reward', { item: localized(gameData().items[reward]?.name, reward) });
    app.toast(`${t('league.crowned', { name })}\n${prize}\n${t('league.wentHome')}`, 5000);
    onCrowned();
  }
}

/**
 * What a title in the League is worth: a Shiny Charm the first time, and a
 * Master Ball every time after — one charm is all anybody keeps, and the
 * League is the only place it comes from.
 *
 * @param {import('../engine/session.mjs').Session} session before it is crowned
 */
export function championPrize(session) {
  const first = !session.champion && !alreadyOwned(session, 'shiny-charm') && Boolean(gameData().items['shiny-charm']);
  return first ? 'shiny-charm' : 'master-ball';
}

/**
 * The picture to put a name to.
 *
 * Hoenn's league was drawn by the game this art all comes from, and Kanto's
 * and Johto's people were drawn by two others the pipeline also reads. Nobody
 * from Sinnoh onwards was ever drawn on a Game Boy Advance, and there is no
 * honest way to invent a likeness — and a stand-in shown in full colour under
 * a real person's name reads as the wrong person (Iris was met as somebody
 * else's dragon tamer). So they are shown as a silhouette of a trainer of
 * their speciality: a figure, and no false face. The choice is fixed by the
 * person's own id, so the same champion is met by the same shape every time.
 *
 * @param {any} trainer
 * @returns {{name: string, own: boolean}|null}
 */
function portraitFor(trainer) {
  const portraits = gameData().actors?.portraits ?? {};
  if (trainer.portrait && portraits[trainer.portrait]) return { name: trainer.portrait, own: true };

  const classes = (gameData().trainerClasses ?? []).filter(
    (entry) => entry.portrait && portraits[entry.portrait] && (!trainer.type || entry.types?.includes(trainer.type)),
  );
  if (classes.length === 0) return null;

  return { name: classes[stableHash(trainer.id ?? '') % classes.length].portrait, own: false };
}

/**
 * The league this challenge faces, rolled from every line-up the game ships.
 *
 * A line-up is a set: the Elite Four a region sends out and the champion
 * waiting behind them are the people of one game, and splitting them would
 * make the ladder a collection of strangers. So one whole league is drawn, and
 * the region is remembered only to say afterwards which one was beaten.
 *
 * A league may also carry `alternates` — people who share one seat, where the
 * games themselves let a roster differ (Alola's fourth seat is Hala's or
 * Molayne's depending on the game). One of them is rolled at the door and
 * walks in with the four, so a challenge still faces four and a champion —
 * and the same challenger meets the same four all the way through, because
 * the roll is made once, here, and not again between rounds.
 *
 * @param {import('../engine/session.mjs').Session} session
 */
export function resolveLeague(session) {
  const leagues = gameData().leagues ?? [];
  if (leagues.length === 0) return generatedLeague(session);

  // A challenge already under way is picked up again, not rolled afresh — the
  // same league, the same four, and the fourth seat's same occupant.
  const run = session.leagueRun;
  const resumed = run ? leagues.find((entry) => entry.region === run.region) : null;
  const chosen = resumed ?? session.rng.pick(leagues);

  const league = { ...chosen, eliteFour: [...chosen.eliteFour] };
  let alternate = null;
  if (chosen.alternates?.length) {
    alternate = (resumed && chosen.alternates.find((entry) => entry.id === run?.alternate)) || session.rng.pick(chosen.alternates);
    league.eliteFour.push(alternate);
  }
  delete league.alternates;

  session.leagueRegion = chosen.region;
  session.leagueRun = { region: chosen.region, alternate: alternate?.id ?? null, round: resumed ? run?.round ?? 0 : 0 };
  return league;
}

/**
 * A stand-in league for a checkout with no authored rosters: four type
 * specialists and a champion with a mixed team, so the ending is reachable
 * even before the real line-ups are filled in.
 *
 * @param {import('../engine/session.mjs').Session} session
 */
function generatedLeague(session) {
  // Stellar is a move's type, not a trainer's.
  const chart = Object.entries(gameData().types).filter(([, entry]) => !entry.special).map(([slug]) => slug);
  const types = session.rng.shuffle(chart).slice(0, 4);
  return {
    region: 'unknown',
    name: { ko: t('league.enter'), en: t('league.enter') },
    eliteFour: types.map((type) => ({
      id: `elite-${type}`,
      name: gameData().types[type]?.name ?? { ko: type, en: type },
      type,
      portrait: null,
      party: [],
    })),
    champion: {
      id: 'champion',
      name: { ko: t('league.champion'), en: t('league.champion') },
      type: null,
      portrait: null,
      party: [],
    },
  };
}

/**
 * A league trainer's team: their named roster where one is on file, and
 * otherwise the strongest members of their speciality.
 *
 * A named roster is sent out as written, never evolved to the round's level:
 * it is that person's real team, and evolving it rewrote it — Glacia's Sealeo
 * came out as a second Walrein beside her ace. Only the stand-in teams are
 * evolved, since nobody chose their stages.
 *
 * @param {import('../engine/session.mjs').Session} session
 * @param {any} trainer
 * @param {number} level the round's, from `leagueLevel`
 */
export function buildParty(session, trainer, level) {
  const roster = (trainer.party ?? []).filter((id) => speciesOf(id));

  const species = roster.length
    ? capRoster(roster, LEAGUE_PARTY_CAP)
    : strongestOfType(session, trainer.type, LEAGUE_PARTY_CAP).map((id) => evolveToLevel(id, level));
  const party = species.map((id) => createPokemon(session.rng, id, level, { ivFloor: 14 }));
  // The Elite Four and the champion save the berry for the Pokémon they lead
  // with last, as every one of them does in Emerald.
  return giveTrainerItems(session.rng, party, 'champion');
}

/**
 * @param {import('../engine/session.mjs').Session} session
 * @param {string|null} type
 * @param {number} count
 * @returns {number[]}
 */
function strongestOfType(session, type, count) {
  const candidates = Object.values(gameData().species)
    .filter((entry) => !entry.isMythical && (!type || entry.types.includes(type)))
    .sort((a, b) => total(b) - total(a))
    .slice(0, 20)
    .map((entry) => entry.id);

  return session.rng.shuffle(candidates).slice(0, count);
}

const total = (species) => Object.values(species.stats).reduce((sum, value) => sum + Number(value), 0);
