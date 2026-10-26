#!/usr/bin/env node
/**
 * Play whole journeys without a screen, for checking the game's pacing.
 *
 *   npm run simulate                              30 saves, four journeys each
 *   npm run simulate -- --saves 10 --runs 2       fewer
 *   npm run simulate -- --seed 100 --json out.json  another set, and the raw numbers
 *   npm run simulate -- --no-comeback              without the help a run of losses brings
 *   npm run simulate -- --comeback 2,20,3,1.5      the help tuned: losses, events, levels, experience
 *   npm run simulate -- --keep-moves               new moves never swapped in, as before 1.0.1
 *
 * Each save starts on a starter (the three in turn) and walks the road until
 * its companion is Champion; the next journey is the strongest Pokémon in the
 * box that has not been. The road, the battles, the Pokémon Centers, the gyms
 * and the League are the game's own code — the event roll, `meetWild`,
 * `roadFind`, `restAtCenter`, the leaders, the `Battle` itself — and only what
 * a player would do by hand is decided here:
 *
 * - every species not yet caught is thrown at with the ball likeliest to work,
 *   a Master Ball only at a legendary;
 * - a TM the companion can learn is used, an evolution item it waits on too;
 * - when it has a new move, the four slots are refilled from everything it
 *   knows (see `refit`) and Optimize is pressed — without the refill, a
 *   companion fought the whole journey with the moves it set out with, and a
 *   Latias still on Charm and Stored Power at level 100 could lose the League
 *   hundreds of times;
 * - the League is walked into as soon as it opens, at full health;
 * - nothing is bought, and the pointer is never held to hurry the road.
 *
 * Time is the event clock's minute per event plus each battle played back at
 * its beats, so it is the time a player watching at normal speed would spend.
 *
 * What the battle and field screens do after a fight — the held item handed
 * back, Pickup, friendship, an evolution, the prize, the badge, the tray, the
 * top-up from the bag — is repeated in `fight` and `settle` below; a change to
 * one of those screens wants the same change here.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';

import { gameData, itemOf, mendItems, mendSpecies, moveOf, nameItemUsers, setGameData, speciesOf } from '../../app/renderer/core/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { afterBattle } from '../../app/renderer/engine/abilities.mjs';
import { optimizeMoves, planMove, profileOf } from '../../app/renderer/engine/autoplan.mjs';
import { Battle, categoryOf } from '../../app/renderer/engine/battle.mjs';
import { attemptCapture, captureChance } from '../../app/renderer/engine/capture.mjs';
import { isRare, rollTrainer } from '../../app/renderer/engine/encounter.mjs';
import { settleForme, signatureItems } from '../../app/renderer/engine/forms.mjs';
import * as items from '../../app/renderer/engine/items.mjs';
import * as pokemon from '../../app/renderer/engine/pokemon.mjs';
import { callRestStop } from '../../app/renderer/engine/rest.mjs';
import { defaultAutoBattle, leagueOpen, Session } from '../../app/renderer/engine/session.mjs';
import { alreadyOwned, earn, lossFor, prizeFor } from '../../app/renderer/engine/shop.mjs';
import { autoHeal } from '../../app/renderer/scenes/battle.mjs';
import {
  berryHarvest,
  leaderParty,
  meetWild,
  pickLeader,
  restAtCenter,
  roadFind,
  shouldSummonLeader,
} from '../../app/renderer/scenes/fieldevents.mjs';
import { buildParty, championPrize, leagueLevel, resolveLeague } from '../../app/renderer/scenes/league.mjs';
import { environmentType, weatherForArea } from '../../app/shared/area-tags.mjs';
import { COMEBACK, EVENT_INTERVAL_MS, LEADER_REST_AFTER_LOSS, STARTERS, timeOfDay } from '../../app/shared/constants.mjs';

const DATA = fileURLToPath(new URL('../../data/', import.meta.url));

/**
 * How long a battle line holds at normal speed, as the battle screen's beats
 * have it, and what a hit adds while its bar drains.
 */
const BEAT_MS = { default: 620, intro: 1000, move: 520, damage: 680, stat: 700, status: 820, faint: 900, end: 1100, go: 1050 };
const DRAIN_MS = 600;
const ENTRY_MS = 780;
/** A throw — the arc and the shakes — and the catch screen around it. */
const THROW_MS = 1800;
const CATCH_SCREEN_MS = 3000;
const EVOLUTION_MS = 8000;

/** The events a journey is given before it is let go unfinished. */
const GUARD = 30000;

/** The progress a journey is cut into: each badge, then the League. */
const SEGMENTS = [...Array.from({ length: 8 }, (_, badges) => `badge ${badges + 1}`), 'league'];

/** Load what the game loads, the authored rosters included. */
function loadData() {
  const read = (path) => JSON.parse(readFileSync(join(DATA, path), 'utf8'));
  const generated = (name) => read(`generated/${name}.json`);
  const authored = (name) => read(`authored/${name}.json`);
  const species = generated('species');
  const moves = generated('moves');
  const itemData = generated('items');
  const abilities = generated('abilities');
  mendItems(itemData, authored('item-texts').items);
  nameItemUsers(itemData, species, signatureItems());
  mendItems(moves, authored('move-texts').moves);
  mendItems(abilities, authored('ability-texts').abilities);
  mendSpecies(species, authored('species-texts').species);
  setGameData(/** @type {any} */ ({
    species, moves, items: itemData, abilities,
    machines: generated('machines'), natures: generated('natures'), types: generated('types'), areas: generated('areas'),
    sprites: generated('sprites'), actors: generated('actors'), bgm: generated('bgm'), itemTiers: generated('item-tiers'),
    battle: generated('battle'),
    trainerClasses: authored('trainer-classes').classes ?? [],
    leaders: authored('leaders').leaders ?? [],
    leagues: authored('leagues').leagues ?? [],
    credits: {},
  }));
}

const baseStats = (/** @type {number} */ id) => Object.values(speciesOf(id).stats).reduce((sum, value) => sum + Number(value), 0);

/**
 * One battle, played out the way the battle screen plays it and finishes it.
 *
 * @param {Session} session
 * @param {any[]} foes
 * @param {{trainer?: any, league?: boolean}} setup
 * @param {Journey} journey
 * @param {string} hour
 */
function fight(session, foes, setup, journey, hour) {
  const active = session.active;
  // Fought in the stretch after a run of losses — helped, or, with the help
  // switched off, where it would have been.
  const helped = journey.window > 0;
  const startLevel = pokemon.levelOf(active);
  const startItem = active.heldItem;
  const battle = new Battle({
    rng: session.rng,
    player: active,
    foes,
    policy: session.autoBattle,
    items: {
      choose: (held) => autoHeal(session, held),
      throw: (slug, held, choice) => items.throwItem(session, slug, held, choice),
    },
    trainerBattle: Boolean(setup.trainer),
    firstRun: session.firstRun,
    experienceBonus: session.comebackExperience,
    weather: weatherForArea(session.area),
    environment: environmentType(session.area?.tags ?? []),
  });

  let ms = ENTRY_MS + BEAT_MS.intro + BEAT_MS.go;
  /** @type {any[]} */
  const defeated = [];
  while (battle.running) {
    for (const entry of battle.takeTurn()) {
      ms += BEAT_MS[entry.kind] ?? BEAT_MS.default;
      if (entry.kind === 'damage') ms += DRAIN_MS;
      if (entry.kind === 'faint' && entry.side === 'foe' && entry.data?.pokemon) defeated.push(entry.data.pokemon);
      if (entry.kind === 'canLearn' && active.moves.length < 4) pokemon.setMove(active, active.moves.length, entry.data.move);
    }
  }

  items.restoreHeldItem(active, startItem);
  for (const one of [active, ...defeated]) settleForme(one);
  afterBattle(active, pokemon.maxHp(active));
  active.toxic = false;
  if (battle.outcome === 'won' && active.ability === 'pickup' && session.rng.chance(0.1)) {
    const found = items.pickFind(session, (gameData().itemTiers?.['poke-ball'] ?? []).filter((slug) => !alreadyOwned(session, slug)));
    if (found) session.addItem(found);
  }
  const levels = pokemon.levelOf(active) - startLevel;
  if (levels > 0) pokemon.friendshipForLevels(active, levels);
  if (battle.outcome === 'lost') pokemon.gainFriendship(active, -1);
  if (battle.outcome === 'won') {
    const evolution = pokemon.offeredEvolution(active, {
      levelled: levels > 0,
      timeOfDay: hour,
      crits: battle.player.marks.crits ?? 0,
      box: session.box,
      raining: weatherForArea(session.area) === 'rain',
      areaTags: session.area?.tags ?? [],
    });
    if (evolution) {
      items.completeEvolution(session, active, evolution.to);
      ms += EVOLUTION_MS;
    }
  }
  pokemon.noteLearnedMoves(active, session.machines);
  journey.time += ms;
  journey.battles++;
  if (!setup.league) {
    const tally = journey.road[helped ? 'helped' : 'plain'];
    tally.battles++;
    if (battle.outcome === 'lost') tally.losses++;
  }
  return { outcome: battle.outcome === 'lost' ? 'lost' : battle.outcome === 'won' ? 'won' : 'fled', defeated };
}

/**
 * What the field does once a battle on the road is over: the prize or the
 * price, the badge, the tray, the walk to a Center, the top-up from the bag.
 */
function settle(session, setup, result, segment, journey) {
  if (result.outcome === 'lost') {
    const paid = setup.trainer ? lossFor(session) : 0;
    if (paid > 0) earn(session, -paid);
    if (setup.leader) session.leaderRest = LEADER_REST_AFTER_LOSS;
    session.blackOut();
    if (session.noteBattle('lost')) segment.comebacks++;
    if (session.lossStreak >= WATCH.losses) journey.window = WATCH.events;
    segment.losses[setup.leader ? 'leader' : setup.trainer ? 'trainer' : 'wild']++;
  } else if (result.outcome === 'won') {
    session.noteBattle('won');
    if (setup.trainer) earn(session, prizeFor(setup.foes, setup.leader ? 'leader' : 'trainer'));
    if (setup.leader) {
      session.badges.push(setup.leader.type);
      session.trainerWins = 0;
    } else if (setup.trainer) {
      session.trainerWins++;
    } else {
      for (const defeated of result.defeated) session.addToTray(defeated);
    }
    if (session.active.hp <= 0) session.blackOut();
  }
  if (result.outcome !== 'lost') {
    const policy = session.itemPolicy;
    items.healAfterBattle(session, session.active, policy?.afterBattle ?? 'full', {
      status: policy?.afterBattleStatus ?? true,
      pp: policy?.afterBattlePp ?? false,
    });
  }
  items.restockBerry(session, session.active);
}

/** Throw at everything in the tray not caught yet; let the rest go. */
function catchTray(session, journey, hour) {
  while (session.tray.length) {
    const target = /** @type {any} */ (session.tray.shift());
    const slug = speciesOf(target.speciesId).slug;
    if (session.caught.has(target.speciesId)) continue;
    const rare = isRare(speciesOf(target.speciesId));
    let caught = false;
    let throws = 0;
    for (; throws < 3 && !caught; throws++) {
      const balls = session.balls().filter((ball) => ball.slug !== 'master-ball' || rare);
      if (!balls.length) break;
      const context = { throws, active: session.active, caught: session.caught, areaTags: session.area?.tags ?? [], time: hour, berry: null };
      const [best] = balls
        .map((ball) => ({ slug: ball.slug, chance: captureChance(target, ball.slug, context) }))
        .sort((a, b) => b.chance - a.chance);
      session.removeItem(best.slug);
      journey.thrown[best.slug] = (journey.thrown[best.slug] ?? 0) + 1;
      journey.time += THROW_MS;
      if (attemptCapture(session.rng, target, best.slug, context).caught) {
        caught = true;
        target.ball = best.slug;
      }
    }
    journey.time += CATCH_SCREEN_MS;
    if (caught) {
      pokemon.resetToLevel(target, pokemon.CAUGHT_LEVEL);
      pokemon.fullyHeal(target);
      session.storeInBox(target);
      journey.caught.push(slug);
    } else {
      journey.missed.push({ slug, rare, noBall: throws === 0 });
    }
  }
}

/** What a player does with the bag between events: TMs learned, evolution items used, new moves swapped in, Optimize. */
function tidy(session) {
  for (const slug of Object.keys(session.bag)) {
    const item = itemOf(slug);
    if (item?.pocket === 'machines') {
      if (!session.machines.includes(item.move) && items.learnsMachine(session.active, slug)) items.useItem(session, slug);
      continue;
    }
    const evolution = pokemon.pendingEvolution(session.active, { item: slug });
    if (evolution?.trigger === 'use-item') items.completeEvolution(session, session.active, evolution.to);
  }
  pokemon.noteLearnedMoves(session.active, session.machines);
  if (!session.active.newMoves?.length) return;
  if (!KEEP_MOVES) {
    refit(session.active, session.machines);
    // Opening the move list is looking at what is new.
    session.active.newMoves = [];
  }
  optimizeMoves(session.active, session.autoBattle);
}

/**
 * How hard a move hits for this Pokémon, roughly: its power, its own type's
 * bonus, the stat it hits with against its better one, how often it lands, and
 * half for the ones the plan keeps to finish with — a recharge, a charge, a
 * faint, half its health. Nothing for a Focus Punch, which fails whenever it is hit first.
 */
function strike(one, slug) {
  const move = moveOf(slug);
  if (!move || move.damageClass === 'status' || !move.power || slug === 'focus-punch') return 0;
  const stats = pokemon.statsOf(one);
  const hits = move.meta?.maxHits ? (move.meta.minHits + move.meta.maxHits) / 2 : 1;
  const own = speciesOf(one.speciesId).types.includes(move.type) ? 1.5 : 1;
  const stat = (move.damageClass === 'physical' ? stats.atk : stats.spa) / Math.max(stats.atk, stats.spa);
  const costly = move.rules?.selfdestruct || move.rules?.mindBlownRecoil || slug === 'chloroblast' ||
    move.flags?.includes('recharge') || move.flags?.includes('charge') ? 0.5 : 1;
  return move.power * hits * own * stat * ((move.accuracy ?? 100) / 100) * costly;
}

/**
 * The four moves a player puts in the slots when the move list has something
 * new: the hardest-hitting attacks, a second of a type already there counting
 * for less, and one heal or boost that the plan would use, if it has one.
 * Moves kept keep their PP.
 */
function refit(one, machines) {
  const known = pokemon.availableMoves(one, machines);
  const statusPlan = (slug) => {
    const trial = { ...one, moves: [...one.moves.filter((slot) => moveOf(slot.move)?.damageClass !== 'status'), { move: slug, pp: 1 }] };
    return planMove(slug, moveOf(slug), profileOf(trial));
  };
  const support = known
    .filter((slug) => moveOf(slug)?.damageClass === 'status' && statusPlan(slug).first !== 'never')
    .map((slug) => ({ slug, heal: categoryOf(moveOf(slug)) === 'heal', boost: statusPlan(slug).first === 'oncePerBattle' }))
    .filter((entry) => entry.heal || entry.boost)
    .sort((a, b) => Number(b.heal) - Number(a.heal))[0];

  const attacks = known.filter((slug) => strike(one, slug) > 0);
  /** @type {string[]} */
  const chosen = support ? [support.slug] : [];
  while (chosen.length < 4 && attacks.some((slug) => !chosen.includes(slug))) {
    const types = new Set(chosen.map((slug) => moveOf(slug).type));
    const [best] = attacks
      .filter((slug) => !chosen.includes(slug))
      .map((slug) => ({ slug, worth: strike(one, slug) * (types.has(moveOf(slug).type) ? 0.7 : 1) }))
      .sort((a, b) => b.worth - a.worth);
    chosen.push(best.slug);
  }
  // Too few attacks to fill the slots: what it already had stays.
  for (const slot of one.moves) if (chosen.length < 4 && !chosen.includes(slot.move)) chosen.push(slot.move);

  const kept = one.moves.filter((slot) => chosen.includes(slot.move));
  const added = chosen.filter((slug) => !kept.some((slot) => slot.move === slug));
  one.moves = kept;
  for (const slug of added) pokemon.setMove(one, one.moves.length, slug);
}

/**
 * @typedef {{
 *   events: number, time: number, centers: number, comebacks: number, levelFrom: number, levelTo: number,
 *   losses: {wild: number, trainer: number, leader: number, league: number},
 * }} Segment
 * @typedef {{
 *   run: number, companion: string, time: number, events: number, battles: number, centers: number,
 *   leagueTries: number, caught: string[], missed: Array<{slug: string, rare: boolean, noBall: boolean}>,
 *   rareMet: string[], thrown: Record<string, number>, segments: Record<string, Segment>, window: number,
 *   road: Record<'helped'|'plain', {battles: number, losses: number}>,
 *   unfinished?: boolean, level?: number, money?: number, bag?: Record<string, number>, owned?: Record<string, [number, number]>,
 *   box?: {count: number, over600: string[], over500: number}, dex?: number,
 * }} Journey
 */

/** One companion's journey, from where it stands to Champion. */
function journeyOf(session, run, hour) {
  /** @type {Journey} */
  const journey = {
    run, companion: speciesOf(session.active.speciesId).slug, time: 0, events: 0, battles: 0, centers: 0, leagueTries: 0,
    caught: [], missed: [], rareMet: [], thrown: {}, segments: {},
    road: { helped: { battles: 0, losses: 0 }, plain: { battles: 0, losses: 0 } }, window: 0,
  };
  const segment = () => {
    const key = SEGMENTS[Math.min(session.badges.length, 8)];
    journey.segments[key] ??= {
      events: 0, time: 0, centers: 0, comebacks: 0, levelFrom: pokemon.levelOf(session.active), levelTo: 0,
      losses: { wild: 0, trainer: 0, leader: 0, league: 0 },
    };
    return journey.segments[key];
  };

  for (let guard = 0; !session.champion && guard < GUARD; guard++) {
    const here = segment();
    const before = journey.time;
    journey.events++;
    here.events++;
    journey.time += EVENT_INTERVAL_MS;
    session.playtime += EVENT_INTERVAL_MS;

    callRestStop(session);
    const kind = session.events.roll(session.rng, items.eventModifiers(session));
    if (kind === 'berry') {
      const { berry, count } = berryHarvest(session);
      session.addItem(berry, count);
    } else if (kind === 'ball') {
      const { item, count } = roadFind(session);
      session.addItem(item, count);
    } else if (kind === 'heal') {
      restAtCenter(session);
      here.centers++;
      journey.centers++;
    } else if (kind === 'wild') {
      const wild = meetWild(session);
      if (isRare(speciesOf(wild.speciesId))) journey.rareMet.push(speciesOf(wild.speciesId).slug);
      const setup = { foes: [wild], trainer: null, leader: null };
      settle(session, setup, fight(session, setup.foes, setup, journey, hour), here, journey);
      catchTray(session, journey, hour);
    } else if (kind === 'trainer') {
      const leader = shouldSummonLeader(session) ? pickLeader(session) : null;
      /** @type {{foes: any[], trainer: any, leader: any}} */
      let setup;
      if (leader) {
        setup = { foes: leaderParty(session, leader), trainer: leader, leader };
      } else {
        const { trainerClass, party } = rollTrainer(session.rng, session.area, session.active, gameData().trainerClasses ?? [], {
          onWater: false,
          levelDrop: session.comebackLevelDrop,
        });
        setup = { foes: party, trainer: trainerClass, leader: null };
      }
      settle(session, setup, fight(session, setup.foes, setup, journey, hour), here, journey);
    }
    if (journey.window > 0) journey.window--;
    if (session.countEvent()) session.rotateArea();
    tidy(session);
    here.time += journey.time - before;
    here.levelTo = pokemon.levelOf(session.active);

    if (leagueOpen(session) && session.active.hp >= pokemon.maxHp(session.active)) {
      const hall = segment();
      const league = resolveLeague(session);
      const rounds = [...league.eliteFour, league.champion];
      journey.leagueTries++;
      for (let index = 0; index < rounds.length; index++) {
        const start = journey.time;
        const foes = buildParty(session, rounds[index], leagueLevel(index, rounds.length));
        const result = fight(session, foes, { trainer: rounds[index], league: true }, journey, hour);
        hall.time += journey.time - start;
        if (result.outcome === 'lost') {
          session.leagueRun = null;
          const paid = lossFor(session);
          if (paid > 0) earn(session, -paid);
          session.blackOut();
          hall.losses.league++;
          break;
        }
        earn(session, prizeFor(foes, 'league'));
        session.heal();
        items.restockBerry(session, session.active);
        if (index === rounds.length - 1) {
          session.addItem(championPrize(session));
          session.champion = true;
          session.champions.add(session.active.speciesId);
          session.leagueRun = null;
        }
      }
      hall.levelTo = pokemon.levelOf(session.active);
    }
  }
  return journey;
}

/** Owned and existing, pocket by pocket: a TM counts once its move is unlocked, too. */
function ownership(session) {
  /** @type {Record<string, [number, number]>} */
  const out = {};
  for (const [slug, item] of Object.entries(gameData().items)) {
    const row = (out[item.pocket] ??= [0, 0]);
    row[1]++;
    const owned = session.countOf(slug) > 0 || session.active.heldItem === slug ||
      (item.pocket === 'machines' && session.machines.includes(item.move));
    if (owned) row[0]++;
  }
  return out;
}

/**
 * A save from its first starter through so many journeys.
 *
 * @param {number} seed
 * @param {number} starter
 * @param {number} runs
 * @param {string} hour
 */
function simulateSave(seed, starter, runs, hour) {
  const first = pokemon.createPokemon(new Rng(seed), starter, 5, { ivFloor: 12, ball: 'poke-ball' });
  const autoBattle = defaultAutoBattle();
  optimizeMoves(first, autoBattle);
  const session = new Session({ slot: 0, save: {
    seed,
    party: { active: first, box: [] },
    bag: { 'poke-ball': 5, potion: 3 },
    progress: { badges: [], champion: false, trainerWins: 0, playtime: 0, areaId: gameData().areas[0]?.id ?? null, machines: [] },
    dex: { seen: [starter], caught: [starter], champions: [] },
    autoBattle,
  } });

  /** @type {Journey[]} */
  const journeys = [];
  for (let run = 1; run <= runs; run++) {
    if (run > 1) {
      const next = session.box
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry && !entry.champion)
        .sort((a, b) => baseStats(b.entry.speciesId) - baseStats(a.entry.speciesId))[0];
      if (!next) break;
      session.switchActive(next.index);
    }
    const journey = journeyOf(session, run, hour);
    journey.unfinished = !session.champion;
    const box = session.box.filter(Boolean);
    journey.level = pokemon.levelOf(session.active);
    journey.money = session.money;
    journey.bag = { ...session.bag };
    journey.owned = ownership(session);
    journey.dex = session.caught.size;
    journey.box = {
      count: box.length,
      over600: box.filter((entry) => baseStats(entry.speciesId) >= 600).map((entry) => speciesOf(entry.speciesId).slug),
      over500: box.filter((entry) => baseStats(entry.speciesId) >= 500 && baseStats(entry.speciesId) < 600).length,
    };
    journeys.push(journey);
  }
  return journeys;
}

// ---- The report.

const median = (/** @type {number[]} */ values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};
const mean = (/** @type {number[]} */ values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
const hours = (/** @type {number} */ ms) => (ms / 3_600_000).toFixed(1);

/** @param {Journey[]} journeys */
function report(label, journeys) {
  const lines = [`\n== ${label} (${journeys.length} journeys)`];
  const times = journeys.map((journey) => journey.time).sort((a, b) => a - b);
  const at = (share) => times[Math.min(times.length - 1, Math.floor(times.length * share))];
  lines.push(`clear time  ${hours(median(times))} h (10%: ${hours(at(0.1))}, 90%: ${hours(at(0.9))})  events ${median(journeys.map((j) => j.events))}  battles ${median(journeys.map((j) => j.battles))}  level ${median(journeys.map((j) => j.level ?? 0))}  League tries ${median(journeys.map((j) => j.leagueTries))}  money ${median(journeys.map((j) => j.money ?? 0))}`);
  lines.push(`stuck       ${journeys.filter((j) => j.unfinished).length} never Champion in ${GUARD} events, ${journeys.filter((j) => j.leagueTries > 50).length} over 50 League tries (most ${Math.max(0, ...journeys.map((j) => j.leagueTries))})`);

  const stock = (pick) => {
    /** @type {Record<string, number[]>} */
    const counts = {};
    for (const journey of journeys) {
      for (const [slug, count] of Object.entries(journey.bag ?? {})) if (pick(itemOf(slug))) (counts[slug] ??= []).push(count);
    }
    return Object.entries(counts)
      .map(([slug, list]) => ({ slug, middle: median([...list, ...Array(journeys.length - list.length).fill(0)]), held: list.length }))
      .sort((a, b) => b.middle - a.middle || b.held - a.held)
      .map(({ slug, middle, held }) => `${slug} ${middle} (${held}/${journeys.length})`)
      .join(', ');
  };
  lines.push(`balls left  ${stock((item) => item?.pocket === 'pokeballs')}`);
  lines.push(`healing     ${stock((item) => item?.pocket === 'medicine' && item.use?.hp !== undefined)}`);
  lines.push(`cures / PP  ${stock((item) => item?.pocket === 'medicine' && (item.use?.pp || (item.use?.status && item.use.hp === undefined)))}`);

  lines.push('segment     events  hours  losses wild/trainer/leader/league  centers  every  helped  level');
  for (const key of SEGMENTS) {
    const parts = journeys.map((journey) => journey.segments[key]).filter(Boolean);
    if (!parts.length) continue;
    const losses = (kind) => mean(parts.map((part) => part.losses[kind])).toFixed(1);
    const total = mean(parts.map((part) => Object.values(part.losses).reduce((a, b) => a + b, 0))).toFixed(1);
    const every = parts.filter((part) => part.centers).map((part) => part.time / 60_000 / part.centers);
    lines.push(`${key.padEnd(10)}  ${String(median(parts.map((part) => part.events))).padStart(6)}  ${hours(median(parts.map((part) => part.time))).padStart(5)}  ${total.padStart(4)} ${losses('wild')}/${losses('trainer')}/${losses('leader')}/${losses('league')}`.padEnd(58) +
      `  ${mean(parts.map((part) => part.centers)).toFixed(1).padStart(7)}  ${(every.length ? `${median(every).toFixed(0)}m` : '-').padStart(5)}  ${mean(parts.map((part) => part.comebacks)).toFixed(1).padStart(6)}  ${median(parts.map((part) => part.levelFrom))}→${median(parts.map((part) => part.levelTo))}`);
  }

  const road = (kind) => journeys.reduce((sum, journey) => ({ battles: sum.battles + journey.road[kind].battles, losses: sum.losses + journey.road[kind].losses }), { battles: 0, losses: 0 });
  const rate = ({ battles, losses }) => `${((100 * losses) / Math.max(1, battles)).toFixed(1)}% of ${battles}`;
  const helpedRoad = road('helped');
  const plainRoad = road('plain');
  lines.push(`road losses ${rate(plainRoad)} battles, ${rate(helpedRoad)} after a run of losses (${((100 * helpedRoad.battles) / Math.max(1, helpedRoad.battles + plainRoad.battles)).toFixed(0)}% of road battles)`);

  const pockets = Object.keys(journeys[0]?.owned ?? {});
  lines.push(`owned       ${pockets.map((pocket) => `${pocket} ${median(journeys.map((j) => j.owned?.[pocket]?.[0] ?? 0))}/${journeys[0].owned?.[pocket]?.[1]}`).join(', ')}`);

  const missed = journeys.flatMap((journey) => journey.missed);
  const rareMet = journeys.reduce((sum, journey) => sum + journey.rareMet.length, 0);
  const rareMissed = missed.filter((miss) => miss.rare).length;
  lines.push(`caught      ${median(journeys.map((j) => j.caught.length))} a journey, missed ${median(journeys.map((j) => j.missed.length))} (${missed.filter((miss) => miss.noBall).length} for want of a ball), dex ${median(journeys.map((j) => j.dex ?? 0))}`);
  lines.push(`rare        met ${(rareMet / journeys.length).toFixed(1)} a journey, ${rareMissed} of ${rareMet} got away`);
  /** @type {Record<string, number>} */
  const tally = {};
  for (const miss of missed) tally[miss.slug] = (tally[miss.slug] ?? 0) + 1;
  lines.push(`most missed ${Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([slug, count]) => `${slug} ${count}`).join(', ')}`);
  lines.push(`box         ${median(journeys.map((j) => j.box?.count ?? 0))} Pokémon, base stats 600+ ${median(journeys.map((j) => j.box?.over600.length ?? 0))}, 500–599 ${median(journeys.map((j) => j.box?.over500 ?? 0))}`);
  return lines.join('\n');
}

function option(flag, fallback) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : fallback;
}

const saves = Number(option('--saves', 30));
const runs = Number(option('--runs', 4));
const firstSeed = Number(option('--seed', 1));
const hour = timeOfDay(new Date(2000, 0, 1, Number(option('--hour', 12))));
const json = option('--json', null);
// For weighing the rule against the road without it: no run of losses is ever long enough.
const tuned = option('--comeback', null);
if (tuned) [COMEBACK.losses, COMEBACK.events, COMEBACK.levelDrop, COMEBACK.experience] = tuned.split(',').map(Number);
/** The stretch after a run of losses, watched whether or not the help is on, so the two can be compared. */
const WATCH = { losses: COMEBACK.losses, events: COMEBACK.events };
if (argv.includes('--no-comeback')) COMEBACK.losses = Infinity;
/** For setting the old player beside the new: one who never puts a new move in a slot. */
const KEEP_MOVES = argv.includes('--keep-moves');

loadData();
/** @type {Journey[]} */
const all = [];
for (let index = 0; index < saves; index++) {
  const seed = firstSeed + index;
  all.push(...simulateSave(seed, STARTERS[index % STARTERS.length], runs, hour));
  process.stdout.write(`\rsaves ${index + 1}/${saves}`);
}
process.stdout.write('\n');

console.log(report('first journey', all.filter((journey) => journey.run === 1)));
if (runs >= 2) console.log(report('second journey', all.filter((journey) => journey.run === 2)));
if (runs >= 3) console.log(report('third journey and after', all.filter((journey) => journey.run >= 3)));
if (json) writeFileSync(json, JSON.stringify(all));
