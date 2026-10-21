/**
 * Load the real generated game data into the renderer's data module, so the
 * engine tests run against the same species, moves and type chart the game
 * does rather than a hand-written fixture.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mendItems, mendSpecies, nameItemUsers, setGameData } from '../../../app/renderer/core/data.mjs';
import { signatureItems } from '../../../app/renderer/engine/forms.mjs';

const GENERATED = fileURLToPath(new URL('../../../data/generated/', import.meta.url));
const AUTHORED = fileURLToPath(new URL('../../../data/authored/', import.meta.url));

let loaded = false;

/** @returns {Promise<boolean>} false when the pipeline has not been run */
export async function useRealGameData() {
  if (loaded) return true;
  try {
    const read = async (name) => JSON.parse(await readFile(join(GENERATED, name), 'utf8'));
    const [species, moves, items, machines, natures, abilities, types, areas, sprites] = await Promise.all([
      read('species.json'),
      read('moves.json'),
      read('items.json'),
      read('machines.json'),
      read('natures.json'),
      read('abilities.json'),
      read('types.json'),
      read('areas.json'),
      read('sprites.json'),
    ]);
    // The same authored descriptions the game lays over the generated items.
    mendItems(items, JSON.parse(await readFile(join(AUTHORED, 'item-texts.json'), 'utf8')).items);
    nameItemUsers(items, species, signatureItems());
    mendItems(moves, JSON.parse(await readFile(join(AUTHORED, 'move-texts.json'), 'utf8')).moves);
    mendItems(abilities, JSON.parse(await readFile(join(AUTHORED, 'ability-texts.json'), 'utf8')).abilities);
    mendSpecies(species, JSON.parse(await readFile(join(AUTHORED, 'species-texts.json'), 'utf8')).species);
    setGameData(
      /** @type {any} */ ({
        species,
        moves,
        items,
        machines,
        natures,
        abilities,
        types,
        areas,
        sprites,
        actors: { portraits: {}, overworld: {}, props: {} },
        bgm: { cues: {}, tracks: {} },
        itemTiers: {},
        leaders: [],
        leagues: [],
      }),
    );
    loaded = true;
    return true;
  } catch {
    return false;
  }
}

/** Skip reason used when the pipeline has not been run in this checkout. */
export const NEEDS_ASSETS = 'run `npm run assets` first — the generated data is missing';
