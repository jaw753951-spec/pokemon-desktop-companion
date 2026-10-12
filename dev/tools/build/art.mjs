/**
 * Every Pokémon's picture: its Black and White battle sprite, the official
 * one where there is one.
 *
 * The game draws each Pokémon in one picture everywhere it shows it, and
 * that picture is the front sprite Pokémon Black and White drew — official
 * pixel art for all 649 Pokémon up to Genesect and the formes those games
 * had. Nothing official is drawn in pixels past them, so the rest — the
 * newer species, the regional forms, the newer formes — are the Smogon
 * community's sprites drawn in the same style at the same size, which
 * PokeAPI files beside the official ones under the same numbers. One folder,
 * one style, one density, every shiny and every female drawn.
 *
 * One picture comes out of each: the sprite cut to what is drawn in it
 * (`art`), for every screen — the road draws it at half a battle's size. It
 * faces left, as the sprites do; the screens that want it facing right mirror
 * it.
 *
 * There used to be a second, the sprite halved as pixel art for the road. A
 * battle sprite's detail is one pixel wide, and keeping one pixel of every
 * four broke its outline and blotted its face, however the four were read.
 *
 * Every file used is kept in `data/vendor/pokeapi/`, pinned to a commit, so a
 * picture cannot vanish from the game the day it changes upstream.
 */
import { join } from 'node:path';
import { readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { writeOut } from '../lib/http.mjs';
import { decodePng, encodePng } from '../lib/png.mjs';
import { crop, mirrorX, opaqueBounds } from '../lib/image.mjs';
import { saveVendored, vendored } from '../lib/vendor.mjs';
import { ALCREMIE_LOOKS } from '../../../app/shared/alcremie.mjs';
import { MAX_SPECIES } from '../sources.mjs';

/** Where the sprites sit in the PokeAPI sprites repository. */
const BLACK_WHITE = 'sprites/pokemon/versions/generation-v/black-white';

/** The last Pokémon Black and White drew; everything past it is the community's. */
export const LAST_OFFICIAL = 649;

/**
 * The species whose sprite looks the other way from the rest — to its right —
 * turned round here, so every screen has every Pokémon facing left: the box
 * and the Pokédex, which show the picture as it is, and the road and the
 * battles, which mirror it from left. Every sprite was looked over for these:
 * Black and White drew Victini turned to its right, and no other.
 */
export const MIRRORED = new Set([494]);

/**
 * The spriters PokeAPI credits for the Black and White style sprites past
 * Genesect, in its README's own order.
 */
const COMMUNITY_ARTISTS = [
  'leParagon', 'Blaquaza', 'TheAetherPlayer', 'G.E.Z.', 'KingOfThe-X-Roads', 'Spook', 'Cynda', 'Involuntary Twitch',
  'mjco', 'Z-nogyroP', 'PumpkinPastel', 'RadicalCharizard', 'HM100', 'N-Kin', 'Zerudez', 'MyMarshlands', 'Wobblebuns',
  'princessofmusic', 'aXl', 'fishbowlsoul90', 'HealnDeal', 'Espeon Scientist', 'AMVictory', 'Mega-Pokebattlerz',
  'Layell', 'GeoisEvil', 'Quanyails', 'RedRooster', 'Wyverii', 'Basic Vanillite', 'Larryturbo', 'TheCynicalPoet',
  'Arkeis', 'paintseagull', 'Branflakes325', 'Siiilver', 'Noscium', 'Sleet', 'Zermonious', 'Bynine', 'Corson',
  'Legitimate Username', 'TrainerSplash', 'Farriella', 'MrDollSteak', 'TeraVolt', 'Dleep', 'WPS', 'Brylark',
  'KattenK', 'Travis', 'SpheX', 'SelenaArmorclaw', 'Hematite',
];

/**
 * @param {{assetDir: string, dataDir: string, sample: boolean, log: (message: string) => void, pool: <T>(task: () => Promise<T>) => Promise<T>}} context
 */
export async function buildArt({ assetDir, dataDir, sample, log, pool }) {
  const limit = sample ? 40 : MAX_SPECIES;
  /** @type {Record<string, any>} */
  const species = JSON.parse(await readFile(join(dataDir, 'species.json'), 'utf8'));
  const entries = Object.values(species).filter((entry) => (entry.dex ?? entry.id) <= limit);

  const out = join(assetDir, 'pokemon');
  await rm(out, { recursive: true, force: true });
  /** @type {Record<string, any>} */
  const manifest = {};
  const missing = [];
  const unshiny = [];

  /**
   * Write one picture, and measure it into the manifest.
   *
   * @param {number} id
   * @param {string} key `''`, `-female` or `-form-<forme>`
   * @param {boolean} shiny
   * @param {Buffer} png
   * @param {boolean} [mirror] turned round to face left
   */
  const save = async (id, key, shiny, png, mirror = false) => {
    const entry = (manifest[id] ??= { shiny: {} });
    const into = shiny ? entry.shiny : entry;
    const tail = shiny ? '-shiny' : '';
    const cut = trimmed(decodePng(png));
    const full = mirror ? mirrorX(cut) : cut;
    await writeOut(join(out, String(id), `art${key}${tail}.png`), encodePng(full.width, full.height, full.data));
    into[`art${key}`] = { width: full.width, height: full.height };
  };

  /**
   * The first of a list of names the folder has, in both palettes.
   *
   * @param {number} id
   * @param {string} key
   * @param {string[]} names file names under the folder, best first
   * @returns {Promise<boolean>} whether the ordinary palette was found
   */
  const fetchInto = async (id, key, names) => {
    for (const name of names) {
      const plain = await vendored('pokeapi', `${BLACK_WHITE}/${name}`);
      if (!plain) continue;
      const mirror = MIRRORED.has(id);
      await save(id, key, false, plain, mirror);
      const shiny = await vendored('pokeapi', `${BLACK_WHITE}/shiny/${name}`);
      if (shiny) await save(id, key, true, shiny, mirror);
      else unshiny.push(`${id}${key}`);
      return true;
    }
    return false;
  };

  await Promise.all(
    entries.map((entry) =>
      pool(async () => {
        if (!(await fetchInto(entry.id, '', [`${entry.id}.png`]))) missing.push(entry.slug);
        // A species whose female looks different — a Pikachu with a heart
        // on its tail — is filed again under `female/`.
        if (!entry.regional) await fetchInto(entry.id, '-female', [`female/${entry.id}.png`]);
        // A forme is filed under its variety's number, or — for the ones that
        // are only a form of one variety, an Arceus's plates — under the
        // species' number and the form's name.
        const base = String(entry.slug).split('-')[0];
        for (const forme of entry.forms ?? []) {
          const suffix = forme.slug.startsWith(`${base}-`) ? forme.slug.slice(base.length + 1) : forme.slug;
          const names = [forme.art, forme.id, `${entry.dex ?? entry.id}-${suffix}`].filter(Boolean).map((name) => `${name}.png`);
          if (!(await fetchInto(entry.id, `-form-${forme.slug}`, [...new Set(names)]))) missing.push(forme.slug);
        }
        // An Alcremie is one of sixty-three: nine creams over seven sweets,
        // each filed under the species' number and its own name.
        if (entry.slug === 'alcremie') {
          for (const look of ALCREMIE_LOOKS) {
            if (!(await fetchInto(entry.id, `-form-${look}`, [`${entry.id}-${look}.png`]))) missing.push(`alcremie-${look}`);
          }
        }
      }),
    ),
  );

  // What someone drew by hand for this game goes over whatever the folder had.
  await applyAuthored({ species, save, log });

  await saveVendored(log);
  await writeOut(join(dataDir, 'sprites.json'), JSON.stringify(manifest));
  await writeOut(
    join(dataDir, 'credits.json'),
    JSON.stringify({
      sprites: {
        source: 'Pokémon Black & White',
        url: 'https://github.com/PokeAPI/sprites',
        license: '© Nintendo / Creatures Inc. / GAME FREAK inc.',
        artists: [],
      },
      custom: {
        source: 'Smogon Sprite Project',
        url: 'https://www.smogon.com/forums/threads/sword-shield-sprite-project.3647722/',
        license: 'fan art, with credit',
        artists: COMMUNITY_ARTISTS,
      },
      // The people the 3D games never drew in pixels (see NAMED_PORTRAITS).
      trainers: [
        { key: 'smogon', source: 'Smogon / Pokémon Showdown', url: 'https://github.com/smogon/sprites', license: 'fan art, with credit' },
        { key: 'pokerogue', source: 'PokéRogue', url: 'https://github.com/pagefaultgames/pokerogue-assets', license: 'CC BY-NC-SA 4.0' },
        { key: 'showdown', source: 'Pokémon Showdown', artist: 'Brumirage', url: 'https://play.pokemonshowdown.com/sprites/trainers/', license: 'fan art, with credit, unedited' },
      ],
    }),
  );

  const count = (record) => Object.keys(record).filter((key) => key.startsWith('art')).length;
  const pictures = Object.values(manifest).reduce((total, entry) => total + count(entry) + count(entry.shiny), 0);
  const official = entries.filter((entry) => !entry.regional && (entry.dex ?? entry.id) <= LAST_OFFICIAL).length;
  log(`art ${Object.keys(manifest).length} Pokémon, ${pictures} pictures (${official} species in Black and White's own sprites)`);
  if (missing.length) log(`  missing: ${missing.join(', ')}`);
  if (unshiny.length) log(`  no shiny: ${unshiny.join(', ')}`);
}

/** @param {import('../lib/image.mjs').Raster} image a picture cut to what is drawn in it */
function trimmed(image) {
  const bounds = opaqueBounds(image);
  return bounds ? crop(image, bounds.x, bounds.y, bounds.width, bounds.height) : image;
}

export const AUTHORED_SPRITES = fileURLToPath(new URL('../../../data/authored/sprites/', import.meta.url));

/**
 * Pictures drawn by hand for this game, over whatever the folder had.
 *
 * Each directory under `data/authored/sprites/` holds a `front.png` in the
 * Black and White sprites' own layout — facing left, at their size — and is
 * named for what it draws, with `-shiny` on the end for the shiny palette: a
 * species or variety by its slug (`urshifu-rapid-strike`), a forme by the
 * forme's (`cramorant-gulping`), a species' female by its slug and `-female`
 * (`jellicent-female`).
 *
 * @param {{species: Record<string, any>, save: (id: number, key: string, shiny: boolean, png: Buffer) => Promise<void>, log: (message: string) => void}} context
 * @returns {Promise<string[]>} the directories used
 */
async function applyAuthored({ species, save, log }) {
  const names = await readdir(AUTHORED_SPRITES).catch(() => []);
  const used = [];
  const unknown = [];
  for (const name of names.sort()) {
    const target = authoredTarget(name, species);
    if (!target) {
      if (!name.startsWith('.') && !/\.(md|txt)$/i.test(name)) unknown.push(name);
      continue;
    }
    const png = await readFile(join(AUTHORED_SPRITES, name, 'front.png')).catch(() => null);
    if (!png) {
      unknown.push(`${name} (no front.png)`);
      continue;
    }
    await save(target.id, target.key, target.shiny, png);
    used.push(name);
  }
  if (used.length) log(`drawn for this game: ${used.join(', ')}`);
  if (unknown.length) log(`  not used from data/authored/sprites: ${unknown.join(', ')}`);
  return used;
}

/**
 * What an authored directory's name draws.
 *
 * @param {string} name
 * @param {Record<string, any>} species
 * @returns {{id: number, key: string, shiny: boolean}|null}
 */
export function authoredTarget(name, species) {
  const shiny = name.endsWith('-shiny');
  const slug = shiny ? name.slice(0, -'-shiny'.length) : name;
  const all = Object.values(species);
  const own = all.find((entry) => entry.slug === slug);
  if (own) return { id: own.id, key: '', shiny };
  const withForme = all.find((entry) => (entry.forms ?? []).some((form) => form.slug === slug));
  if (withForme) return { id: withForme.id, key: `-form-${slug}`, shiny };
  if (slug.endsWith('-female')) {
    const base = all.find((entry) => entry.slug === slug.slice(0, -'-female'.length) && !entry.regional);
    if (base) return { id: base.id, key: '-female', shiny };
  }
  return null;
}
