/**
 * The second step of the auto-battle screen's one-press setup: a trial run.
 *
 * The suggestion `autoplan.mjs` makes reads the moves alone, and whether a
 * Growl earns its turn or a heal should wait for a third of health rather
 * than half depends on what the companion is up against. So the setting is
 * tried out: a fixed draw of the wild Pokémon and trainers the area the
 * companion is in would put in front of it, fought in simulation, once for
 * the suggestion and once for each alternative a move is offered — one move
 * at a time, keeping any change that does better. Every candidate fights the
 * same opponents with the same dice, so a difference in the score is the
 * setting's and not the luck's.
 *
 * The score of a battle is a win, more for the health left and for a short
 * fight, and for a loss, a little for how far the foe was worn down. It is a
 * search over a few dozen settings, not over every combination: a move's
 * choice is made with the others as they stand, and a second pass is made
 * only when the first changed something.
 */
import { environmentType, weatherForArea } from '../../shared/area-tags.mjs';
import { Rng } from '../core/rng.mjs';
import { Battle, moveCondition, secondCondition } from './battle.mjs';
import { rollTrainer, rollWildPokemon } from './encounter.mjs';
import { fullyHeal, maxHp } from './pokemon.mjs';
import { defaultAutoBattle } from './session.mjs';
import { settingsOf, suggestPolicy } from './autoplan.mjs';

/** How many opponents a setting is tried against, a third of them trainers. */
export const TRIAL_BATTLES = 48;

/** A battle that has not ended by now is called off as it stands. */
const TURN_LIMIT = 80;

/**
 * How much better, per battle, a change has to do to be kept — so a setting
 * is not changed on noise the fixed dice happen to favour.
 */
const MARGIN = 0.004;

/**
 * @typedef {Object} TuneInput
 * @property {import('./pokemon.mjs').Pokemon} pokemon the companion, left untouched
 * @property {any} area where its opponents are drawn from
 * @property {any[]} classes the trainer classes, for the trainers among them
 * @property {{conditions?: Record<string, string>, moves?: Record<string, string>, second?: Record<string, string>}} current
 *   the setting it has now, to report against
 */

/**
 * @typedef {Object} TuneResult
 * @property {string[]} order
 * @property {Record<string, string>} moves
 * @property {Record<string, string>} second
 * @property {{wins: number, battles: number}} before how the current setting did
 * @property {{wins: number, battles: number}} after how the tuned one did
 */

/**
 * @param {TuneInput} input
 * @param {{battles?: number, onProgress?: (share: number) => void, pause?: () => Promise<void>}} [options]
 *   `pause` is awaited between trials, so a screen waiting on this stays alive
 * @returns {Promise<TuneResult>}
 */
export async function tunePolicy(input, options = {}) {
  const { battles = TRIAL_BATTLES, onProgress = () => {}, pause = () => Promise.resolve() } = options;
  const opponents = drawOpponents(input, battles);

  const { plans } = suggestPolicy(input.pokemon);
  const total = 2 + plans.reduce((sum, plan) => sum + plan.alternatives.length - 1, 0) * 2;
  let done = 0;
  /** @param {{order: string[], moves: Record<string, string>, second: Record<string, string>}} setting */
  const trial = async (setting) => {
    await pause();
    const result = runTrials(input.pokemon, setting, opponents, input.area);
    onProgress(Math.min(1, ++done / total));
    return result;
  };

  // The setting as it stands, each move's conditions read the way a battle
  // reads them — its kind's, where it has none of its own.
  const order = input.pokemon.moves.map((slot) => slot.move);
  const before = await trial({
    order,
    moves: Object.fromEntries(order.map((slug) => [slug, moveCondition(input.current, slug)])),
    second: Object.fromEntries(order.map((slug) => [slug, secondCondition(input.current, slug)])),
  });

  let best = await trial(settingsOf(plans));
  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    for (const plan of plans) {
      const kept = [plan.first, plan.second];
      for (const [first, second] of plan.alternatives) {
        if (first === kept[0] && second === kept[1]) continue;
        plan.first = first;
        plan.second = second;
        const tried = await trial(settingsOf(plans));
        if (tried.score > best.score + MARGIN * opponents.length) {
          best = tried;
          kept[0] = first;
          kept[1] = second;
          changed = true;
        }
      }
      plan.first = kept[0];
      plan.second = kept[1];
    }
    if (!changed) break;
  }
  onProgress(1);

  return {
    ...settingsOf(plans),
    before: { wins: before.wins, battles: opponents.length },
    after: { wins: best.wins, battles: opponents.length },
  };
}

/**
 * The opponents every candidate setting faces: the same draw each time, from
 * a seed the companion and the area decide, so pressing the button twice in
 * the same place gives the same answer.
 *
 * @param {TuneInput} input
 * @param {number} count
 * @returns {Array<{foes: import('./pokemon.mjs').Pokemon[], trainer: boolean}>}
 */
function drawOpponents(input, count) {
  const seed = (input.pokemon.speciesId * 7919 + (input.pokemon.experience ?? 0) + hash(input.area?.id ?? '')) >>> 0;
  const rng = new Rng(seed);
  const opponents = [];
  for (let index = 0; index < count; index++) {
    const trainer = index % 3 === 2 && (input.classes?.length ?? 0) > 0;
    if (trainer) {
      opponents.push({ foes: rollTrainer(rng, input.area, input.pokemon, input.classes).party, trainer });
    } else {
      opponents.push({ foes: [rollWildPokemon(rng, input.area, input.pokemon)], trainer });
    }
  }
  return opponents;
}

/** @param {string} text */
function hash(text) {
  let value = 0;
  for (const char of String(text)) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return value;
}

/**
 * Fight every opponent with one setting.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {{order: string[], moves: Record<string, string>, second: Record<string, string>}} setting
 * @param {ReturnType<typeof drawOpponents>} opponents
 * @param {any} area whose sky and ground the battles are fought under
 */
function runTrials(pokemon, setting, opponents, area) {
  const weather = weatherForArea(area);
  const environment = environmentType(area?.tags ?? []);
  const policy = { ...defaultAutoBattle(), moves: setting.moves, second: setting.second };
  let score = 0;
  let wins = 0;
  opponents.forEach((opponent, index) => {
    // Each trial starts fresh, as the companion does after a rest.
    const companion = structuredClone(pokemon);
    fullyHeal(companion);
    const bySlug = new Map(companion.moves.map((slot) => [slot.move, slot]));
    const ordered = setting.order.map((slug) => bySlug.get(slug)).filter(Boolean);
    companion.moves = [...ordered, ...companion.moves.filter((slot) => !setting.order.includes(slot.move))];

    const foes = opponent.foes.map((foe) => structuredClone(foe));
    const battle = new Battle({
      rng: new Rng(10007 + index),
      player: companion,
      foes,
      policy,
      trainerBattle: opponent.trainer,
      weather,
      environment,
    });
    let outcome = 'ongoing';
    let turns = 0;
    while (outcome === 'ongoing' && turns < TURN_LIMIT) {
      const end = battle.takeTurn().find((entry) => entry.kind === 'end');
      turns++;
      if (end) outcome = end.data?.outcome ?? 'ended';
    }
    if (outcome === 'won') {
      wins++;
      score += 1 + 0.4 * (companion.hp / maxHp(companion)) - 0.01 * turns;
    } else if (outcome === 'lost' || outcome === 'ongoing') {
      const worn = foes.reduce((sum, foe) => sum + 1 - foe.hp / maxHp(foe), 0) / foes.length;
      score += 0.25 * worn;
    } else {
      score += 0.5;
    }
  });
  return { score, wins };
}
