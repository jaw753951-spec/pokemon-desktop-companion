/**
 * The leagues the game can draw a challenge from.
 *
 * Every test runs against the real authored rosters, so a league the data
 * stopped carrying is a failing assertion rather than a ladder of strangers.
 * The alternates rule gets the closest look: a league that carries people who
 * share one seat must still send out four and a champion, never both of the
 * people sharing it, and the choice must hold for the whole challenge.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AUTHORED = fileURLToPath(new URL('../../data/authored/', import.meta.url));

test('alola sends out four and a champion, from its two who share a seat', async () => {
  const leagues = JSON.parse(await readFile(join(AUTHORED, 'leagues.json'), 'utf8')).leagues;
  const alola = leagues.find((league) => league.region === 'alola');
  assert.ok(alola, 'the authored data carries an Alola league');

  const seat = alola.eliteFour;
  const others = alola.alternates ?? [];
  assert.ok(seat.length + others.length >= 4, 'the league names four seats in total');
  assert.equal(others.length, 2, 'Hala and Molayne are the two sharing one seat');

  // Every roll puts one of the two in, and never both — the seat is one
  // person's, and a challenge faces four Elite Four either way.
  for (let roll = 0; roll < 50; roll++) {
    const roster = [...seat, others[roll % others.length]];
    assert.equal(roster.length, 4);
    assert.ok(roster.includes(others[roll % others.length]));
    assert.equal(roster.filter((member) => others.includes(member)).length, 1);
  }
});
