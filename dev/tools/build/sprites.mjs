/**
 * Every Pokémon's cry.
 *
 * The step once packed each Pokémon's battle sprites and box icon as well;
 * those are now the `art` step's, from one folder of Black and White style
 * sprites, and this is what is left.
 *
 * The cries come down as PokeAPI has them and are kept that way in the cache;
 * what goes into `assets/cries` is each one encoded again, smaller, by
 * `encode-cries.mjs` — half the size, and none of them duller for it.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

import { fetchBuffer, writeOut } from '../lib/http.mjs';
import { CRIES, MAX_SPECIES } from '../sources.mjs';

/**
 * @param {{assetDir: string, dataDir: string, sample: boolean, log: (message: string) => void, pool: <T>(task: () => Promise<T>) => Promise<T>}} context
 */
export async function buildSprites({ assetDir, dataDir, sample, log, pool }) {
  const limit = sample ? 40 : MAX_SPECIES;
  // The regional Pokémon the dex step files under their variety ids, whose
  // cries PokeAPI files under the same ids.
  const species = JSON.parse(await readFile(join(dataDir, 'species.json'), 'utf8'));
  const regional = Object.values(species)
    .filter((entry) => entry.regional && entry.dex <= limit)
    .map((entry) => entry.id);
  const ids = [...Array.from({ length: limit }, (_, index) => index + 1), ...regional];
  const missing = [];
  let found = 0;
  // The files as they came, kept apart from what the game ships.
  const sources = join(assetDir, '..', '.cache', 'cries-source');
  await rm(sources, { recursive: true, force: true });
  await mkdir(sources, { recursive: true });
  await Promise.all(
    ids.map((id) =>
      pool(async () => {
        const cry = await fetchBuffer(`${CRIES}/pokemon/latest/${id}.ogg`, { allowMissing: true });
        if (!cry) {
          missing.push(id);
          return;
        }
        await writeOut(join(sources, `${id}.ogg`), cry);
        found++;
      }),
    ),
  );
  log(`cries ${found}/${ids.length}`);
  if (missing.length) log(`  missing: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ', …' : ''}`);

  const out = join(assetDir, 'cries');
  await rm(out, { recursive: true, force: true });
  try {
    await encodeCries(sources, out);
  } catch (error) {
    // The game plays the cries as they came just as well, only larger.
    log(`  could not re-encode the cries (${error.message}); shipping them as they came`);
    await mkdir(out, { recursive: true });
    for (const name of await readdir(sources)) await copyFile(join(sources, name), join(out, name));
  }
}

/**
 * Run `encode-cries.mjs` in Electron, which has the Opus encoder Node lacks.
 *
 * @param {string} from
 * @param {string} to
 */
function encodeCries(from, to) {
  const script = fileURLToPath(new URL('../encode-cries.mjs', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(/** @type {string} */ (/** @type {unknown} */ (electron)), [script, from, to], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`exited with ${code}`))));
  });
}
