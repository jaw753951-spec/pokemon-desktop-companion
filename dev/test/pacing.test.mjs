/**
 * The journey's pacing: when the gym leaders come, and what the League stands
 * at once all eight have been beaten.
 *
 * The badges are tied to levels so the eighth lands around 70, however fast
 * the companion levels, and the League waits in the 70s for it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { speciesOf } from '../../app/renderer/core/data.mjs';
import { createPokemon } from '../../app/renderer/engine/pokemon.mjs';
import { defaultAutoBattle, Session } from '../../app/renderer/engine/session.mjs';
import { Battle } from '../../app/renderer/engine/battle.mjs';
import { rollTrainer } from '../../app/renderer/engine/encounter.mjs';
import { BADGE_LEVELS, BADGES_FOR_LEAGUE, COMEBACK, FIRST_RUN_LEADER_STATS, LEADER_REST_AFTER_LOSS, leaderLevels, leaderOdds } from '../../app/shared/constants.mjs';
import { levelOf } from '../../app/renderer/engine/pokemon.mjs';
import { leaderParty, pickLeader, shouldSummonLeader } from '../../app/renderer/scenes/fieldevents.mjs';
import { gameData } from '../../app/renderer/core/data.mjs';
import { LEAGUE_LEVELS, leagueLevel } from '../../app/renderer/scenes/league.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

test('every badge has a level it is due by, rising, the eighth around 70', () => {
  assert.equal(BADGE_LEVELS.length, BADGES_FOR_LEAGUE);
  for (let index = 1; index < BADGE_LEVELS.length; index++) {
    assert.ok(BADGE_LEVELS[index] > BADGE_LEVELS[index - 1], `badge ${index + 1} after badge ${index}`);
  }
  const last = BADGE_LEVELS[BADGE_LEVELS.length - 1];
  assert.ok(last >= 65 && last <= 72, `the eighth badge is due at ${last}`);
});

test('a leader is all but certain once the next badge is due', () => {
  for (const [badges, due] of BADGE_LEVELS.entries()) {
    const odds = leaderOdds(badges, due);
    assert.ok(odds.chance >= 0.5, `badge ${badges + 1} at level ${due}`);
    assert.ok(odds.wins <= 3, 'a few fights at most');
    // Overdue is no less likely.
    assert.deepEqual(leaderOdds(badges, due + 15), odds);
  }
});

test('a leader can come a little early, by luck, but never a whole gym early', () => {
  for (const [badges, due] of BADGE_LEVELS.entries()) {
    if (badges === 0) continue;
    const near = leaderOdds(badges, due - 3);
    assert.ok(near.chance > 0 && near.chance < 0.2, `badge ${badges + 1} three levels short`);
    assert.equal(near.wins, Infinity, 'fights won while too low do not add up to a summons');

    const far = leaderOdds(badges, due - 10);
    assert.equal(far.chance, 0, `badge ${badges + 1} ten levels short`);
    assert.equal(far.wins, Infinity);
  }
});

test('the first leader never comes early', () => {
  const due = BADGE_LEVELS[0];
  for (let level = 1; level < due; level++) {
    assert.equal(leaderOdds(0, level).chance, 0, `level ${level}`);
    assert.equal(leaderOdds(0, level).wins, Infinity);
  }
  assert.ok(leaderOdds(0, due).chance >= 0.5);
});

test('a leader stands at the level of the badge they hold, climbing to the ace', () => {
  for (const [badges, due] of BADGE_LEVELS.entries()) {
    const levels = leaderLevels(badges, 3);
    assert.equal(levels[levels.length - 1], due + 2, `badge ${badges + 1}'s ace`);
    for (let index = 1; index < levels.length; index++) assert.ok(levels[index] > levels[index - 1]);
    assert.deepEqual(leaderLevels(badges, 1), [due + 2], 'a team of one is the ace');
  }
  // The eighth badge's leader sits just under the League, which opens at 70.
  assert.ok(leaderLevels(BADGES_FOR_LEAGUE - 1, 3).every((level) => level <= 70));
});

test('a leader\'s team is the same whoever challenges it', options, () => {
  const leader = { id: 'rock-brock', type: 'rock', party: [74, 95] };
  for (const level of [6, 12, 40]) {
    const session = new Session({ slot: 0, save: { seed: 3, party: { active: createPokemon(new Rng(1), 4, level), box: [] } } });
    assert.deepEqual(leaderParty(session, leader).map(levelOf), leaderLevels(0, 2), `against a level ${level}`);
    session.badges = ['rock', 'water', 'electric'];
    assert.deepEqual(leaderParty(session, leader).map(levelOf), leaderLevels(3, 2), `the fourth badge, against a level ${level}`);
  }
});

test('every leader whose badge is still to win is as likely as the next, wherever the road is', options, () => {
  const data = gameData();
  const saved = data.leaders;
  data.leaders = [
    { id: 'rock-a', type: 'rock' }, { id: 'rock-b', type: 'rock' },
    { id: 'psychic-a', type: 'psychic' }, { id: 'water-a', type: 'water' },
  ];
  try {
    // On a mountain path, which used to call the Rock leaders and no one else.
    const session = /** @type {any} */ ({ rng: new Rng(5), badges: ['water'], area: { tags: ['mountain', 'cave'] } });
    const counts = /** @type {Record<string, number>} */ ({});
    for (let draw = 0; draw < 3000; draw++) {
      const leader = pickLeader(session);
      counts[leader.id] = (counts[leader.id] ?? 0) + 1;
    }
    assert.equal(counts['water-a'], undefined, 'a badge already held is not offered again');
    for (const id of ['rock-a', 'rock-b', 'psychic-a']) {
      assert.ok(counts[id] > 850 && counts[id] < 1150, `${id}: ${counts[id]} of 3000`);
    }
    session.badges = ['water', 'rock', 'psychic'];
    assert.equal(pickLeader(session), null, 'and with every badge, no one');
  } finally {
    data.leaders = saved;
  }
});

test("on the first run the first three leaders keep under their gym's ceiling", options, () => {
  /** @param {any} pokemon */
  const total = (pokemon) => Object.values(speciesOf(pokemon.speciesId).stats).reduce((sum, value) => sum + Number(value), 0);
  const types = ['rock', 'water', 'dragon', 'ghost', 'steel', 'fairy', 'ice', 'bug'];
  const strongest = (/** @type {any} */ session) =>
    Math.max(...types.flatMap((type) => leaderParty(session, { id: type, type }).map(total)));

  for (let seed = 1; seed <= 20; seed++) {
    const session = new Session({ slot: 0, save: { seed, party: { active: createPokemon(new Rng(1), 4, 30), box: [] } } });
    assert.ok(session.firstRun);
    for (const [badges, ceiling] of FIRST_RUN_LEADER_STATS.entries()) {
      session.badges = types.slice(0, badges).map((type) => `held-${type}`);
      const top = strongest(session);
      assert.ok(top <= ceiling, `badge ${badges + 1} sent out ${top} against a ceiling of ${ceiling}`);
    }
  }

  // The fourth gym, and every gym once the save has a champion, is not held back.
  const later = new Session({ slot: 0, save: { seed: 1, party: { active: createPokemon(new Rng(1), 4, 30), box: [] } } });
  later.badges = ['a', 'b', 'c'];
  assert.ok(strongest(later) > FIRST_RUN_LEADER_STATS[2]);
  const crowned = new Session({ slot: 0, save: { seed: 1, party: { active: createPokemon(new Rng(1), 4, 30), box: [] } } });
  crowned.champions.add(4);
  assert.ok(!crowned.firstRun);
  assert.ok(strongest(crowned) > FIRST_RUN_LEADER_STATS[0]);
});

test('the League stands in the 70s, the champion at the top of it', () => {
  const levels = [0, 1, 2, 3, 4].map((index) => leagueLevel(index, 5));
  assert.deepEqual(levels, LEAGUE_LEVELS);
  for (const level of levels) assert.ok(level >= 70 && level <= 80, `${level}`);
  for (let index = 1; index < levels.length; index++) assert.ok(levels[index] > levels[index - 1]);
});

test('the champion is the last round whatever the league counts', () => {
  const top = LEAGUE_LEVELS[LEAGUE_LEVELS.length - 1];
  assert.equal(leagueLevel(5, 6), top, 'a six-round league ends on the champion');
  assert.ok(leagueLevel(4, 6) < top, 'and its fifth round is still an Elite Four member');
  assert.equal(leagueLevel(3, 4), top, 'a four-round league too');
});

/**
 * A companion overdue for its first badge, with the wins counted long since:
 * without the rest, the very next trainer is the leader.
 */
const overdue = () => {
  const session = new Session({ slot: 0, save: { seed: 7, party: { active: createPokemon(new Rng(1), 4, BADGE_LEVELS[0] + 10), box: [] } } });
  session.trainerWins = 10;
  return session;
};

test('a leader lost to stays away for the next three trainers, then returns, across a save and reload', options, () => {
  const session = overdue();
  assert.equal(shouldSummonLeader(session), true, 'overdue, the leader comes at once');

  session.leaderRest = LEADER_REST_AFTER_LOSS;
  for (let trainer = 1; trainer <= LEADER_REST_AFTER_LOSS; trainer++) {
    assert.equal(shouldSummonLeader(session), false, `trainer ${trainer} after the loss is an ordinary one`);
  }
  assert.equal(session.leaderRest, 0);
  assert.equal(shouldSummonLeader(session), true, 'the fourth is the leader again');

  // The rest is kept in the save, and an older save has none.
  session.leaderRest = 2;
  const again = new Session({ slot: 0, save: session.toSave() });
  assert.equal(again.leaderRest, 2);
  assert.equal(new Session({ slot: 0, save: { seed: 1, party: { active: session.active, box: [] } } }).leaderRest, 0, 'an older save has none');
});

test('two losses running ease the road for a while; a win ends the run but not the help', options, () => {
  const session = new Session({ slot: 0, save: { seed: 3, party: { active: createPokemon(new Rng(1), 4, 30), box: [] } } });
  assert.equal(session.noteBattle('lost'), false, 'one loss is only one');
  assert.equal(session.comebackLevelDrop, 0);
  assert.equal(session.noteBattle('won'), false);
  assert.equal(session.lossStreak, 0, 'a win in between starts the count over');

  session.noteBattle('lost');
  assert.equal(session.noteBattle('lost'), true, 'the second in a row sets it going');
  assert.equal(session.comeback, COMEBACK.events);
  assert.equal(session.comebackLevelDrop, COMEBACK.levelDrop);
  assert.equal(session.comebackExperience, COMEBACK.experience);

  session.noteBattle('won');
  assert.equal(session.comeback, COMEBACK.events, 'a win keeps what was given');
  const again = new Session({ slot: 0, save: session.toSave() });
  assert.equal(again.comeback, COMEBACK.events, 'and it outlasts a save and reload');

  for (let event = 0; event < COMEBACK.events; event++) session.countEvent();
  assert.equal(session.comebackLevelDrop, 0, 'it runs out with the events');
  assert.equal(session.comebackExperience, 1);
});

test('while the road eases off, its trainers stand lower and a battle pays more', options, () => {
  const companion = createPokemon(new Rng(1), 4, 40);
  const area = { tags: [] };
  const classes = [{ id: 'youngster', areas: [], party: [2, 2] }];
  const usual = rollTrainer(new Rng(9), area, companion, classes).party.map(levelOf);
  const eased = rollTrainer(new Rng(9), area, companion, classes, { levelDrop: COMEBACK.levelDrop }).party.map(levelOf);
  assert.deepEqual(eased, usual.map((level) => Math.max(1, level - COMEBACK.levelDrop)));

  const paid = (bonus) => {
    const battle = new Battle({ rng: new Rng(2), player: createPokemon(new Rng(1), 4, 20), foes: [createPokemon(new Rng(3), 16, 20)], policy: defaultAutoBattle(), experienceBonus: bonus });
    battle.awardExperience(/** @type {any} */ (battle.foe), []);
    return battle.rewards[0].experience;
  };
  assert.ok(Math.abs(paid(COMEBACK.experience) - paid(1) * COMEBACK.experience) <= 1);
});
